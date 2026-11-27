// Prepare controlled inputs from a user-exported trace. No network/model calls.
// Usage: node evaluation/prepare-explanation-replay.js <diagnostic.json>
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const R=require('../contextual-reasoning');
const file=process.argv[2];
if(!file)throw Error('Provide the exported diagnostic JSON path');
const ledger=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const report={version:'explanation-generation-replay-v1',status:'prepared_not_executed',model_requests:0,
  note:'Same historical user inputs, only the generation system instruction changes. Historical inputs intentionally do not incorporate the new retrieval ranking. No new answers or quality scores.',cases:[]};
for(const term of ['RAG','API','黑盒式','DB']){
  const session=ledger.sessions.find(s=>s.selection===term);
  assert.ok(session,'Missing historical session: '+term);
  const call=session.events.find(e=>e.type==='contextual_stage_completed'&&e.data.stage==='generation')?.data;
  assert.ok(call?.messages?.length,'Missing recorded model messages');
  const user=call.messages.find(m=>m.role==='user');
  assert.ok(user&&!user.content.includes('[已截断]'),'Input is missing or truncated');
  const input=JSON.parse(user.content);
  const request={selection:input.selected,documentContext:{selection:input.exact_selection,page:{title:input.title},extraction:input.coverage,conversation:input.conversation}};
  const system=R.buildMessages(request,input.evidence)[0];
  const messages=call.messages.map(m=>m.role==='system'?system:m);
  assert.equal(messages.find(m=>m.role==='user').content,user.content);
  const completion=session.events.find(e=>e.type==='contextual_completed')?.data;
  report.cases.push({term,source_session_id:session.id,historical_model:call.model,
    historical_answer:completion?.result?.meaning_here?.text,
    historical_generation:call.raw_output,historical_verification:completion?.verification,
    evidence_count:input.evidence?.length,old_system:call.messages.find(m=>m.role==='system')?.content,
    proposed_messages:messages,user_input_unchanged:true,new_answer:null});
}
const output=path.join(__dirname,'..','diagnostic-data','explanation-generation-replay-2026-10-30.json');
fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({output,cases:report.cases.map(c=>({term:c.term,evidence_count:c.evidence_count,input_unchanged:c.user_input_unchanged})),model_requests:0,status:report.status}));

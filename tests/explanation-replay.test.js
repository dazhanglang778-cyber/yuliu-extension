const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const R = require('../contextual-reasoning');
const E = require('../evaluation/explanation-replay');
const root = path.join(__dirname, '..');
// Entirely synthetic fixtures and fake HTTP responses. No real key or model calls.
function packet() {
  return {version:'explanation-generation-replay-v1', cases:E.TERMS.map(term => {
    const quote = term + ' 是本例测试标签，用于检验重放输入。';
    const request = {selection:term, documentContext:{selection:{normalized_text:term,
      anchor_block_id:'p0', start_offset:0}, page:{title:'模拟材料'},
      extraction:{coverage:'loaded_content_only'}, conversation:null}};
    const evidence = [{evidence_id:'e1', block_id:'p0', quote, source_start:0,
      source_end:quote.length, relation_to_selection:'anchor'}];
    return {term, source_session_id:'mock-'+term, historical_model:E.MODEL,
      historical_answer:'仅测试用旧答案', proposed_messages:R.buildMessages(request,evidence)};
  })};
}
const draft = {target_type:'term',statements:[{id:'c1',part:'meaning',basis:'general',text:'仅用于测试的解释。',evidence_ids:[]}]};
const review = {review_version:R.REVIEW_VERSION,checks:[{id:'c1',supported:true,selection_fit:'current',
  basis:'general',replacement:null,citations:[],reason:'模拟判断'}]};
test('历史消息对象字段顺序无意义，不误拦截相同的角色及正文',()=>{
  const p=packet();
  for(const c of p.cases)c.proposed_messages=c.proposed_messages.map(m=>({content:m.content,role:m.role}));
  assert.equal(E.prepare(p,R).length,4);
});
test('四例重建输入逐字不变，模型和生成指令固定', async () => {
  const data = packet(), rows = E.prepare(data,R), calls=[];
  const result=await E.runCase(rows[0],R,async options=>{
    calls.push(options); return {content:JSON.stringify(calls.length===1?draft:review),model:E.MODEL};
  });
  assert.equal(calls.length,2);
  assert.equal(calls[0].messages[1].content,data.cases[0].proposed_messages[1].content);
  assert.ok(calls.every(c=>c.fixedModel===E.MODEL && c.includeMetadata));
  assert.equal(result.actual_http_calls,2);
  assert.equal(result.result.meaning_here.text,draft.statements[0].text);
  assert.equal(result.quality_assessment,'not_scored');
  assert.equal(result.trace.history.length,2);
});
for(const [label,mutate] of [
  ['重复词条',p=>p.cases[1]=p.cases[0]],
  ['过期指令',p=>p.cases[0].proposed_messages[0].content+=' changed'],
  ['输入增加空格',p=>p.cases[0].proposed_messages[1].content+=' '],
  ['非固定模型',p=>p.cases[0].historical_model='another-model'],
  ['错选区',p=>{const m=p.cases[0].proposed_messages[1],i=JSON.parse(m.content);i.exact_selection.start_offset=1;m.content=JSON.stringify(i);}],
]) test('请求前拒绝不可控重放：'+label,()=>{const p=packet();mutate(p);assert.throws(()=>E.prepare(p,R));});

function worker({data=packet(),key='MOCK_SECRET_DO_NOT_EXPORT',errorStatus=null,hold=false}={}) {
  let listener, release;
  const storage={}, network=[], reads=[];
  const barrier=hold?new Promise(r=>release=r):Promise.resolve();
  const ctx={console,URL,AbortController,TextDecoder,setTimeout,clearTimeout,
    chrome:{runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,
      onMessage:{addListener(fn){listener=fn;}},onConnect:{addListener(){}}},
      storage:{local:{get:async k=>{reads.push(k);return {[k]:k==='bigmodelApiKey'?key:storage[k]};},
        set:async items=>Object.assign(storage,JSON.parse(JSON.stringify(items)))}}},
    fetch:async (url,options)=>{
      if(url.startsWith('chrome-extension:'))return {ok:true,json:async()=>data};
      const body=JSON.parse(options.body);network.push(body);await barrier;
      if(errorStatus)return {ok:false,status:errorStatus,text:async()=>key+' provider body'};
      const isReview=body.messages[0].content.includes('独立的语境主张核验器');
      return {ok:true,json:async()=>({model:body.model,choices:[{message:{content:JSON.stringify(isReview?review:draft)}}]})};
    }};
  vm.createContext(ctx);
  ctx.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx));
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),ctx);
  const send=(type='EXPLANATION_REPLAY_START',sender={id:'test',url:'chrome-extension://test/diagnostics.html'})=>
    new Promise(resolve=>listener({type},sender,resolve));
  return {send,storage,network,reads,release,report:()=>storage[storage[E.LATEST]],
    comparisonReport:()=>storage[storage.yuliuExplanationComparisonLatest],
    modelReport:()=>storage[storage.yuliuExplanationModelComparisonLatest]};
}
test('实际后台入口模拟四例顺序请求，逐例保存，可独立导出且无密钥',async()=>{
  const w=worker(),response=await w.send();
  assert.equal(response.ok,true);assert.equal(w.network.length,8);
  const report=w.report();
  assert.equal(report.status,'completed');assert.equal(report.completed_cases,4);
  assert.equal(report.recorded_http_calls,8);assert.ok(report.rows.every(r=>r.trace.history.length===2));
  assert.ok(w.network.every(n=>n.model===E.MODEL && n.temperature===0));
  assert.ok(!JSON.stringify(w.storage).includes('MOCK_SECRET'));
});
test('外部网页、其他扩展页面不能启动或停止重放',async()=>{
  const w=worker();
  for(const type of ['EXPLANATION_REPLAY_START','EXPLANATION_REPLAY_STOP'])
    for(const sender of [{id:'test',url:'https://example.test'}, {id:'other',url:'chrome-extension://test/diagnostics.html'}])
      assert.equal((await w.send(type,sender)).ok,false);
  assert.equal(w.network.length,0);assert.ok(!w.reads.includes('bigmodelApiKey'));
});
test('没有密钥或准备数据变动：零模型请求，不伪造完成报告',async()=>{
  const data=packet();data.cases.pop();
  for(const options of [{key:''},{data}]){
    const w=worker(options);assert.equal((await w.send()).ok,false);
    assert.equal(w.network.length,0);assert.equal(w.report(),undefined);
  }
});
test('本例后停止和并发启动保护，不重跑已完成的案例',async()=>{
  const w=worker({hold:true}),running=w.send();
  await new Promise(r=>setImmediate(r));
  assert.equal((await w.send()).ok,false);
  assert.equal((await w.send('EXPLANATION_REPLAY_STOP')).ok,true);
  w.release();await running;
  assert.equal(w.report().status,'stopped');assert.equal(w.report().completed_cases,1);
  assert.equal(w.network.length,2);
});
test('模型请求失败与语义失败分开，供应商错误正文不泄漏到报告',async()=>{
  const w=worker({errorStatus:429});await w.send();
  const report=w.report();
  assert.equal(report.status,'completed_with_errors');
  assert.ok(report.recorded_http_calls<=12);
  assert.ok(JSON.stringify(report).includes('MODEL_HTTP_429'));
  assert.ok(!JSON.stringify(report).includes('MOCK_SECRET'));
  assert.ok(!JSON.stringify(report).includes('provider body'));
});
test('重新运行保留旧报告，不覆盖历史结果',async()=>{
  const w=worker();await w.send();const oldId=w.storage[E.LATEST],old=JSON.stringify(w.storage[oldId]);
  await w.send();assert.notEqual(w.storage[E.LATEST],oldId);assert.equal(JSON.stringify(w.storage[oldId]),old);
});

test('同期两组生成：user逐字相同、模型预算相同、顺序可交替、自然输出不被程序改写',async()=>{
  for(const order of ['structured-first','natural-first']){
    const p=E.prepare(packet(),R)[0],calls=[],raw='这是一份自然解释。\n依据：e1（待人工判断）';
    const row=await E.runComparisonCase(p,R,async options=>{
      calls.push(options);
      const natural=options.messages[0].content===E.NATURAL_PROMPT;
      const reviewing=options.messages[0].content.includes('独立的语境主张核验器');
      return {content:natural?raw:JSON.stringify(reviewing?review:draft),model:E.MODEL};
    },order);
    assert.equal(calls.length,3);assert.equal(row.actual_http_calls,3);
    assert.equal(row.structured_http_calls,2);assert.equal(row.natural.raw_output,raw);
    assert.equal(row.natural.citation_status,'not_verified');
    assert.equal(calls[order==='natural-first'?0:2].messages[0].content,E.NATURAL_PROMPT);
    for(const call of calls){assert.equal(call.fixedModel,E.MODEL);assert.equal(call.maxTokens,2100);}
    const generations=calls.filter(c=>!c.messages[0].content.includes('独立的语境主张核验器'));
    assert.equal(generations[0].messages[1].content,generations[1].messages[1].content);
    assert.ok(!calls.some(c=>c.messages[1].content.includes('仅测试用旧答案')));
  }
  assert.doesNotMatch(E.NATURAL_PROMPT,/RAG|黑盒|API|数据库/);
});
test('自然解释调用失败无重试，不妨碍同组结构化流程，错误正文脱敏',async()=>{
  let count=0;
  const row=await E.runComparisonCase(E.prepare(packet(),R)[0],R,async options=>{
    count++;
    if(options.messages[0].content===E.NATURAL_PROMPT)throw Error('private-provider-body');
    return {content:JSON.stringify(count===2?draft:review),model:E.MODEL};
  },'natural-first');
  assert.equal(count,3);assert.equal(row.natural.error,'MODEL_REQUEST_FAILED');
  assert.equal(row.result.meaning_here.text,draft.statements[0].text);
  assert.ok(!JSON.stringify(row).includes('private-provider-body'));
});
test('新对照从真实后台入口运行12次模拟请求，独立保存旧报告、交替顺序',async()=>{
  const w=worker();await w.send();const old=JSON.stringify(w.report());
  const start=w.network.length;
  assert.equal((await w.send('EXPLANATION_COMPARE_START')).ok,true);
  const report=w.comparisonReport();
  assert.equal(report.version,'explanation-generation-comparison-v1');
  assert.equal(report.recorded_http_calls,12);assert.equal(w.network.length-start,12);
  assert.deepEqual(report.rows.map(r=>r.comparison_order),['structured-first','natural-first','structured-first','natural-first']);
  assert.equal(JSON.stringify(w.report()),old);
  assert.ok(!JSON.stringify(report).includes('MOCK_SECRET'));
});
test('新对照仍受来源和并发限制，停止时保留整例的两组结果',async()=>{
  const w=worker({hold:true});
  assert.equal((await w.send('EXPLANATION_COMPARE_START',{id:'test',url:'https://example.test'})).ok,false);
  const running=w.send('EXPLANATION_COMPARE_START');await new Promise(r=>setImmediate(r));
  assert.equal((await w.send()).ok,false);
  await w.send('EXPLANATION_REPLAY_STOP');w.release();await running;
  assert.equal(w.comparisonReport().status,'stopped');
  assert.equal(w.comparisonReport().rows.length,1);assert.equal(w.network.length,3);
});

test('两模型只有模型参数变化，B指令和user逐字相同，不添加核验或重试',async()=>{
  for(const order of ['baseline-first','candidate-first']){
    const prepared=E.prepare(packet(),R)[0],calls=[];
    const row=await E.runModelComparisonCase(prepared,async options=>{
      calls.push(options);return {content:'自然解释',model:options.fixedModel};
    },order);
    assert.equal(row.actual_http_calls,2);
    assert.equal(calls[0].messages[0].content,E.NATURAL_PROMPT);
    assert.deepEqual(calls[0].messages,calls[1].messages);
    assert.equal(calls[0].messages[1].content,prepared.item.proposed_messages[1].content);
    assert.ok(calls.every(c=>c.maxTokens===2100&&c.includeMetadata));
    assert.deepEqual(calls.map(c=>c.fixedModel),order==='baseline-first'?E.MODEL_PAIR:[...E.MODEL_PAIR].reverse());
    assert.ok(!row.trace);assert.ok(row.model_outputs.every(o=>o.citation_status==='not_verified'));
  }
  await assert.rejects(()=>E.runModelComparisonCase(E.prepare(packet(),R)[0],()=>{},'bad-order'));
});
test('两模型后台实跑模拟8次，无付费模型、无备用切换，独立保留旧报告',async()=>{
  const w=worker();await w.send();const old=JSON.stringify(w.report()),start=w.network.length;
  assert.equal((await w.send('EXPLANATION_MODEL_COMPARE_START')).ok,true);
  const r=w.modelReport(),calls=w.network.slice(start);
  assert.equal(r.recorded_http_calls,8);assert.equal(calls.length,8);
  assert.equal(r.status,'completed');assert.equal(JSON.stringify(w.report()),old);
  assert.deepEqual(r.models,E.MODEL_PAIR);
  assert.deepEqual(r.rows.map(x=>x.comparison_order),['baseline-first','candidate-first','baseline-first','candidate-first']);
  for(let i=0;i<8;i+=2){assert.deepEqual(calls[i].messages,calls[i+1].messages);}
  for(const call of calls){
    assert.equal(call.temperature,0);assert.equal(call.max_tokens,2100);assert.equal(call.stream,false);
    assert.ok(E.MODEL_PAIR.includes(call.model));
    if(call.model==='glm-4.7-flash')assert.equal(call.thinking.type,'disabled');
  }
  assert.ok(!JSON.stringify(r).includes('MOCK_SECRET'));
});
test('两模型均限流时只尝试8次，保存失败而不自动补答',async()=>{
  const w=worker({errorStatus:429});await w.send('EXPLANATION_MODEL_COMPARE_START');
  const r=w.modelReport();assert.equal(w.network.length,8);assert.equal(r.status,'completed_with_errors');
  assert.ok(r.rows.every(x=>x.model_outputs.every(o=>o.error==='MODEL_HTTP_429')));
  assert.ok(!JSON.stringify(r).includes('provider body'));
});
test('模型对照同样校验发送页、同用锁，停止后保留一例两个结果',async()=>{
  const w=worker({hold:true});
  assert.equal((await w.send('EXPLANATION_MODEL_COMPARE_START',{id:'test',url:'https://example.test'})).ok,false);
  const p=w.send('EXPLANATION_MODEL_COMPARE_START');await new Promise(r=>setImmediate(r));
  assert.equal((await w.send('EXPLANATION_COMPARE_START')).ok,false);
  await w.send('EXPLANATION_REPLAY_STOP');w.release();await p;
  assert.equal(w.modelReport().status,'stopped');assert.equal(w.network.length,2);
});

test('诊断界面仅点击开始才请求模型，读入历史结果不自动重跑',async()=>{
  class Element {
    constructor(){this.children=[];this.listeners={};this.textContent='';}
    append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}
    addEventListener(k,fn){this.listeners[k]=fn;}
  }
  const ids=Object.fromEntries(['replayRun','replayStop','replayExport','replayStatus','replayResults'].map(k=>[k,new Element()]));
  const sent=[],storage={},ctx={console,Date,JSON,URL,Blob,setTimeout,
    document:{getElementById:k=>ids[k],createElement:()=>new Element()},
    chrome:{storage:{local:{get:async k=>({[k]:storage[k]})},onChanged:{addListener(){}}},
      runtime:{sendMessage:async m=>{sent.push(m);return {ok:false,error:'模拟未配置密钥'};}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'diagnostics-replay.js'),'utf8'),ctx);
  await new Promise(r=>setImmediate(r));assert.equal(sent.length,0);
  await ids.replayRun.listeners.click();assert.equal(sent.length,1);
  assert.equal(sent[0].type,'EXPLANATION_REPLAY_START');assert.match(ids.replayStatus.textContent,/模拟未配置密钥/);
  assert.equal(ids.replayRun.disabled,false);
});

test('新模式显示自然解释与结构化初稿、只在点击时发送新入口请求',async()=>{
  class Element {
    constructor(){this.children=[];this.listeners={};this.textContent='';}
    append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}
    addEventListener(k,f){this.listeners[k]=f;}
  }
  const ids=Object.fromEntries(['replayRun','replayStop','replayExport','replayStatus','replayResults','replayMode'].map(k=>[k,new Element()]));
  ids.replayMode.value='comparison';
  const stored={yuliuExplanationComparisonLatest:'paired',paired:{status:'completed',planned:4,completed_cases:1,
    recorded_http_calls:3,rows:[{term:'RAG',historical_answer:'旧答案',actual_http_calls:3,comparison_order:'natural-first',
      natural:{raw_output:'<b>保持为原始文字而非HTML</b>',elapsed_ms:500},
      trace:{history:[{stage:'generation',parsed:{statements:[{part:'meaning',basis:'general',text:'结构化正文'}]}}],stage_elapsed_ms:{},elapsed_ms:1000},
      result:{meaning_here:{text:'最终正文'}}}]}},sent=[];
  const ctx={console,JSON,URL,Blob,setTimeout,document:{getElementById:k=>ids[k],createElement:()=>new Element()},
    chrome:{storage:{local:{get:async k=>({[k]:stored[k]})},onChanged:{addListener(){}}},
      runtime:{sendMessage:async m=>{sent.push(m);return {ok:true};}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'diagnostics-replay.js'),'utf8'),ctx);
  await new Promise(r=>setImmediate(r));
  const text=e=>[e.textContent,...e.children.map(text)].join('\n');
  assert.match(text(ids.replayResults),/B · 简洁自然解释/);
  assert.match(text(ids.replayResults),/A · 结构化初稿/);
  assert.match(text(ids.replayResults),/<b>保持为原始文字而非HTML<\/b>/);
  assert.equal(sent.length,0);
  await ids.replayRun.listeners.click();assert.equal(sent[0].type,'EXPLANATION_COMPARE_START');
  assert.equal(ids.replayMode.disabled,false);
});

test('模型模式加载已有回答不调用模型，显示两款模型及失败，按钮发送正确入口',async()=>{
  class Element {
    constructor(){this.children=[];this.listeners={};this.textContent='';}
    append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}
    addEventListener(k,f){this.listeners[k]=f;}
  }
  const ids=Object.fromEntries(['replayRun','replayStop','replayExport','replayStatus','replayResults','replayMode'].map(k=>[k,new Element()]));
  ids.replayMode.value='models';
  const stored={yuliuExplanationModelComparisonLatest:'models',models:{status:'completed_with_errors',planned:4,
    completed_cases:1,recorded_http_calls:2,rows:[{term:'DB',actual_http_calls:2,model_outputs:[
      {requested_model:E.MODEL,model:E.MODEL,raw_output:'模拟回答',elapsed_ms:100},
      {requested_model:E.MODEL_PAIR[1],error:'MODEL_TIMEOUT',elapsed_ms:15000}]}]}},sent=[];
  const ctx={console,JSON,URL,Blob,setTimeout,document:{getElementById:k=>ids[k],createElement:()=>new Element()},
    chrome:{storage:{local:{get:async k=>({[k]:stored[k]})},onChanged:{addListener(){}}},
      runtime:{sendMessage:async m=>{sent.push(m);return {ok:true};}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'diagnostics-replay.js'),'utf8'),ctx);
  await new Promise(r=>setImmediate(r));const text=e=>[e.textContent,...e.children.map(text)].join('\n');
  assert.match(text(ids.replayResults),/模拟回答/);assert.match(text(ids.replayResults),/MODEL_TIMEOUT/);
  assert.match(text(ids.replayResults),/glm-4.7-flash/);assert.equal(sent.length,0);
  await ids.replayRun.listeners.click();assert.equal(sent[0].type,'EXPLANATION_MODEL_COMPARE_START');
});

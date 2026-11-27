const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const P=require('../openai-provider'),E=require('../evaluation/general-definition-comparison');
const bg=fs.readFileSync(require.resolve('../background.js'),'utf8');
const build=vm.runInNewContext(bg.slice(bg.indexOf('function buildGeneralDefinitionMessages('),bg.indexOf('\nasync function runGroundedInitial('))+'\nbuildGeneralDefinitionMessages');
test('公开对照只接受固定案例，A/B原始输入一致，B仅替换搜索要求',async()=>{
  for(const c of E.cases){
    const a=E.inputs(c,build,false),b=E.inputs(c,build,true);
    assert.equal(a[1].content,b[1].content);assert.match(a[0].content,/本次未使用外部搜索/);
    assert.doesNotMatch(b[0].content,/本次未使用外部搜索/);assert.match(b[0].content,/本次使用外部搜索/);
    assert.doesNotMatch(a[1].content,/人工检查重点|不承诺/);
  }
  let calls=0;
  await assert.rejects(E.run({caseId:'private',order:'AB',complete:()=>calls++}));assert.equal(calls,0);
});
test('配对固定模型、保留完整答案与元数据，遵守顺序，没有隐式核验',async()=>{
  const seen=[],updates=[];let clock=100;
  const r=await E.run({caseId:'ids',order:'BA',model:'gpt-6-astra',buildMessages:build,now:()=>clock++,
    onUpdate:async x=>updates.push(JSON.parse(JSON.stringify(x))),complete:async o=>{
      seen.push(o);o.onDelta('定义');return {content:'完整定义\n\n范围。',model:o.model,usage:{input_tokens:1,output_tokens:2},search:o.webSearch?{calls:[{status:'completed'}],citations:[{url:'https://example.org'}]}:undefined};}});
  assert.equal(seen.length,2);assert.deepEqual(seen.map(x=>x.webSearch),[true,false]);
  assert.ok(seen.every(x=>x.model==='gpt-6-astra'&&x.timeoutMs===90000));
  assert.equal(r.rows[0].searchEvidence,'calls_and_citations');assert.equal(r.rows[1].searchEvidence,'not_requested');
  assert.equal(r.rows[0].content,'完整定义\n\n范围。');assert.ok(r.rows[0].firstTextMs>0);
  assert.equal(updates[0].rows.length,0);assert.equal(r.status,'completed');
});
test('B失败或没有工具结果不冒充搜索成功，A仍保留，不重试且不泄漏异常正文',async()=>{
  for(const fails of [true,false]){
    let calls=0;
    const r=await E.run({caseId:'bypass',order:'AB',model:'gpt-6-astra',buildMessages:build,complete:async o=>{
      calls++;if(o.webSearch&&fails)throw Error('sk-private');return {content:'可用答案',model:o.model};}});
    assert.equal(calls,2);assert.equal(r.rows[0].content,'可用答案');assert.doesNotMatch(JSON.stringify(r),/sk-private/);
    if(fails)assert.equal(r.rows[1].status,'error');else assert.equal(r.rows[1].searchEvidence,'no_completed_call');
  }
});
test('内置搜索显式开启、调用上限与来源元数据，恶意网址不变成可点击引用',async()=>{
  let body;
  const r=await P.complete({apiKey:'sk-TEST',model:'gpt-4.1',messages:[],webSearch:true,includeMetadata:true,
    fetchImpl:async(_u,o)=>{body=JSON.parse(o.body);return {ok:true,json:async()=>({status:'completed',output:[
      {type:'web_search_call',status:'completed',action:{type:'search',queries:['IDS definition'],sources:[{url:'https://example.org/source'},{url:'javascript:alert(1)'}]}},
      {type:'message',content:[{type:'output_text',text:'前文。'},{type:'output_text',text:'定义[1]',annotations:[
        {type:'url_citation',start_index:2,end_index:5,url:'https://example.org/source',title:'标准'},
        {type:'url_citation',url:'javascript:alert(1)'}]}]}
    ]})};}});
  assert.equal(body.tools[0].type,'web_search');assert.equal(body.tool_choice,'required');assert.equal(body.max_tool_calls,2);
  assert.deepEqual(body.include,['web_search_call.action.sources']);assert.equal(body.store,false);
  assert.equal(r.search.citations.length,1);assert.equal(r.search.citations[0].start,5);
  assert.equal(r.search.calls[0].sources.length,1);assert.equal(r.content,'前文。定义[1]');
});
function worker(){
  let listener;const saved={},requests=[];
  const ctx={console,URL,AbortController,TextDecoder,setTimeout,clearTimeout,
    chrome:{runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:f=>listener=f},onConnect:{addListener(){}}},
      storage:{local:{get:async keys=>Array.isArray(keys)?{openaiApiKey:'sk-PRIVATE',openaiModel:'gpt-6-astra'}:{[keys]:saved[keys]},set:async data=>Object.assign(saved,JSON.parse(JSON.stringify(data)))}}}};
  vm.createContext(ctx);ctx.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),ctx));
  vm.runInContext(bg,ctx);
  ctx.YuliuOpenAI.complete=async o=>{requests.push(o);return {content:'通用定义：公开回答',model:o.model,usage:{input_tokens:1,output_tokens:1}};};
  return {ctx,saved,requests,send:(message,sender)=>new Promise(resolve=>listener(message,sender,resolve))};
}
test('真实后台入口拒绝普通网页；忽略额外的内部原文、查询、密钥和模型覆盖参数',async()=>{
  const w=worker();
  const msg={type:'GENERAL_SEARCH_COMPARE',caseId:'ids',order:'AB',context:'绝密原文',query:'内部项目',model:'fake',apiKey:'sk-INJECT'};
  const denied=await w.send(msg,{id:'test',url:'https://example.org'});assert.equal(denied.ok,false);assert.equal(w.requests.length,0);
  const ok=await w.send(msg,{id:'test',url:'chrome-extension://test/general-definition-comparison.html'});
  assert.equal(ok.ok,true);assert.equal(w.requests.length,2);
  assert.ok(w.requests.every(x=>x.apiKey==='sk-PRIVATE'&&x.model==='gpt-6-astra'));
  assert.doesNotMatch(JSON.stringify(w.requests.map(x=>x.messages)),/绝密原文|内部项目|sk-INJECT/);
  assert.doesNotMatch(JSON.stringify(w.saved),/sk-PRIVATE|sk-INJECT/);
  assert.equal(w.saved.yuliuGeneralSearchComparisonV1[0].status,'completed');
});
test('后台并发保护与无效案例不产生额外调用',async()=>{
  const w=worker(),sender={id:'test',url:'chrome-extension://test/general-definition-comparison.html'};
  let release;w.ctx.YuliuOpenAI.complete=()=>new Promise(resolve=>release=()=>resolve({content:'答案'}));
  const first=w.send({type:'GENERAL_SEARCH_COMPARE',caseId:'ids',order:'AB'},sender);
  await new Promise(r=>setImmediate(r));
  const busy=await w.send({type:'GENERAL_SEARCH_COMPARE',caseId:'ids',order:'AB'},sender);assert.match(busy.error,/已有对照/);
  release();await new Promise(r=>setImmediate(r));release();assert.equal((await first).ok,true);
  const invalid=await w.send({type:'GENERAL_SEARCH_COMPARE',caseId:'unknown',order:'AB'},sender);assert.equal(invalid.ok,false);
});

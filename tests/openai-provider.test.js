const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const P = require('../openai-provider.js');
const payload = (text='成功') => ({status:'completed',model:'gpt-4.1',usage:{input_tokens:9,output_tokens:2},output:[{type:'message',content:[{type:'output_text',text}]}]});
const base = {apiKey:'sk-TEST-ONLY',model:'gpt-4.1',messages:[{role:'user',content:'你好'}]};
test('OpenAI 固定域名、禁存储、不启用工具、有输出上限和用量信息',async()=>{
  let body;
  const r = await P.complete({...base,maxTokens:9000,includeMetadata:true,fetchImpl:async(url,o)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(o.headers.Authorization,'Bearer sk-TEST-ONLY');body=JSON.parse(o.body);
    return {ok:true,json:async()=>payload()};
  }});
  assert.equal(body.store,false);assert.equal(body.max_output_tokens,4000);assert.equal(body.tools,undefined);
  assert.equal(r.content,'成功');assert.equal(r.usage.input_tokens,9);
});
test('错误正文不回传、401/429 不重试、不切换服务商',async()=>{
  for(const status of [401,403,404,429,500]) {
    let calls=0;
    await assert.rejects(P.complete({...base,fetchImpl:async()=>{calls++;return {ok:false,status,text:async()=>base.apiKey};}}),e=>!e.message.includes(base.apiKey)&&e.message.includes(String(status)));
    assert.equal(calls,1);
  }
});
test('无密钥或非法模型不发请求；未完成或拒绝结果不当作成功',async()=>{
  await assert.rejects(P.complete({...base,model:'arbitrary',fetchImpl:()=>assert.fail()}));
  await assert.rejects(P.complete({...base,apiKey:'',fetchImpl:()=>assert.fail()}));
  for(const p of [{...payload(),status:'incomplete'},{...payload(),output:[]}])
    await assert.rejects(P.complete({...base,fetchImpl:async()=>({ok:true,json:async()=>p})}));
});
test('SSE 跨数据块、中文及完成事件正常解析，不把断流当成功',async()=>{
  let deltas='';
  const raw='data: '+JSON.stringify({type:'response.output_text.delta',delta:'成功'})+'\r\n\r\n'+'data: '+JSON.stringify({type:'response.completed',response:payload()})+'\n\n';
  const bytes=new TextEncoder().encode(raw);
  const mock=()=>({ok:true,body:new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}})});
  assert.equal(await P.complete({...base,onDelta:d=>deltas+=d,fetchImpl:async()=>mock()}),'成功');
  assert.equal(deltas,'成功');
  await assert.rejects(P.complete({...base,onDelta:()=>{},fetchImpl:async()=>({ok:true,body:new ReadableStream({start(c){c.close();}})})}));
});

test('实际后台补充路径在完成事件之前转发SSE增量，不缓冲整段再假流式',async()=>{
  for(const mode of ['simplify','expand_general','expand_example']) {
    const w=worker('gpt-6-astra');let controller,body,first;
    const seen=new Promise(resolve=>first=resolve);
    w.ctx.fetch=async(_url,options)=>{
      body=JSON.parse(options.body);
      return {ok:true,body:new ReadableStream({start(c){controller=c;}})};
    };
    w.ctx.port={postMessage:m=>{w.sent.push(m);if(m.type==='DELTA')first();}};
    w.ctx.request={mode,selection:'测试',existing:'词义',generalDefinition:'定义'};
    const pending=vm.runInContext('runOpenAIRequest(port,request)',w.ctx);
    await new Promise(r=>setImmediate(r));
    controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.output_text.delta',delta:'第一段'})+'\n\n'));
    await seen;
    assert.equal(body.stream,true);assert.ok(w.sent.some(e=>e.type==='DELTA'));assert.ok(!w.sent.some(e=>e.type==='DONE'));
    controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.output_text.delta',delta:'第二段'})+'\n\n'
      +'data: '+JSON.stringify({type:'response.completed',response:payload('第一段第二段')})+'\n\n'));
    controller.close();await pending;
    assert.equal(w.sent.filter(e=>e.type==='DELTA').map(e=>e.delta).join(''),'第一段第二段');
    assert.ok(w.sent.some(e=>e.type==='DONE'));
  }
});
test('超时停止，网络异常不泄露原始异常字符串',async()=>{
  await assert.rejects(P.complete({...base,timeoutMs:5,fetchImpl:async(_u,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Object.assign(new Error(base.apiKey),{name:'AbortError'}))))}),/超过时限/);
  await assert.rejects(P.complete({...base,fetchImpl:async()=>{throw new Error(base.apiKey);}}),e=>!e.message.includes(base.apiKey));
});
function worker(model='gpt-4.1') {
  const sent=[],calls=[];let listener;
  const ctx={console,AbortController,TextDecoder,setTimeout,clearTimeout,
    chrome:{runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:f=>listener=f},onConnect:{addListener(){}}},
      storage:{local:{get:async k=> typeof k==='string'?{[k]: k==='modelProvider'?'openai':false}:{openaiApiKey:'sk-LOCAL',openaiModel:model},set:async()=>{}}}},
    fetch:async(url,o)=>{calls.push({url,body:JSON.parse(o.body)});return {ok:true,json:async()=>({...payload(),model:JSON.parse(o.body).model})};}};
  vm.createContext(ctx);
  ctx.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),ctx));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8'),ctx);
  return {ctx,calls,sent,listener};
}

test('OpenAI通用定义生产路径只调用一次，不把旧解释冒充核实义项；回传新展示策略',async()=>{
  const w=worker();let options,count=0;
  w.ctx.YuliuOpenAI.complete=async o=>{options=o;count++;o.onDelta('通用定义：在系统集成中，旁路接入是一种辅助接入方式。');
    return {content:'完成',model:'gpt-4.1',usage:{}};};
  w.ctx.port={postMessage:m=>w.sent.push(m)};
  w.ctx.request={mode:'expand_general',selection:'旁路方式',senseMeaning:'某平台的评测承诺',
    senseIdentity:{neutralIdentity:'旧身份不应传入'},
    generalContext:{localOriginal:'不替代现有平台，而以旁路方式接入。',relatedOriginal:[]}};
  await vm.runInContext('runOpenAIRequest(port,request)',w.ctx);
  assert.equal(count,1);assert.equal(w.calls.length,0);
  assert.match(options.messages[0].content,/可能有错的旧解释/);
  assert.doesNotMatch(JSON.stringify(options.messages),/旧身份不应传入|已经完成语境比对/);
  assert.equal(JSON.parse(options.messages[1].content).previousInterpretation,'某平台的评测承诺');
  assert.equal(w.sent.find(x=>x.type==='DONE').outputPolicy,'concept-general-v1');
});
test('生产语境请求绑定 OpenAI，不读取旧密钥或触发智谱搜索',async()=>{
  const w=worker();
  vm.runInContext(`ContextualReasoning.run = async (request,complete) => { await complete({messages:[{role:'user',content:'context'}],maxTokens:100}); return {result:{},trace:{}}; };`,w.ctx);
  w.ctx.port={postMessage:m=>w.sent.push(m)};
  await vm.runInContext(`runRequest(port,{mode:'initial',selection:'测试',documentContext:{}})`,w.ctx);
  assert.equal(w.calls.length,1);assert.equal(w.calls[0].url,'https://api.openai.com/v1/responses');
  assert.ok(w.sent.some(x=>x.type==='GROUNDED_RESULT'));assert.ok(w.sent.some(x=>x.type==='DONE'&&x.model==='gpt-4.1'));
});
test('双击首屏在生成尚未结束时只发 meaning，核验不流式且最终答案不复用预览',async()=>{
  const w=worker();
  const req=require('../evaluation/contextual-suite').prepare(require('../evaluation/fixtures/contextual-generalization-v1.json').cases[0]);
  const events=[];w.ctx.recordDiagnosticEvent=e=>{events.push(e);return Promise.resolve();};
  w.ctx.request={...req,mode:'initial',requestId:'preview-test'};
  w.ctx.port={postMessage:m=>w.sent.push(m)};
  const draft=JSON.stringify({target_type:'term',statements:[
    {id:'i',part:'intent',text:'不应预览意图',basis:'document',evidence_ids:['e1']},
    {id:'m',part:'meaning',text:'预览“甲”与"乙"的关系',basis:'general',evidence_ids:[]}]});
  let count=0;
  w.ctx.YuliuOpenAI.complete=async o=>{
    if (++count===1) {
      for (const ch of draft) o.onDelta(ch);
      const partial=w.sent.filter(m=>m.type==='MEANING_PREVIEW').map(m=>m.text);
      assert.ok(partial.includes('预览“甲”'));
      assert.equal(partial.at(-1),'预览“甲”与"乙"的关系');
      assert.ok(partial.every(s=>'预览“甲”与"乙"的关系'.startsWith(s)));
      assert.ok(!w.sent.some(m=>m.type==='GROUNDED_RESULT'));
      return {content:draft};
    }
    assert.equal(o.onDelta,undefined);
    return {content:'{}'}; // invalid review: draft must not become the final text
  };
  await vm.runInContext('runOpenAIRequest(port,request)',w.ctx);
  const result=w.sent.find(m=>m.type==='GROUNDED_RESULT');
  assert.ok(result);assert.doesNotMatch(result.result.meaning_here.text,/预览“甲”/);
  assert.ok(count>=2 && count<=3);
  const timings=events.filter(e=>e.eventType==='openai_usage').map(e=>e.data);
  assert.equal(timings.length,count);
  assert.ok(Number.isFinite(timings[0].firstOutputDeltaMs));
  assert.ok(timings[0].firstOutputDeltaMs<=timings[0].elapsed_ms);
  assert.ok(timings.slice(1).every(t=>t.firstOutputDeltaMs===undefined));
});
for (const model of ['gpt-6-astra','gpt-6.1-sol']) {
  test(model+' 使用Responses中等推理和独立推理预算，不沿用temperature',async()=>{
    let body;
    const result=await P.complete({...base,model,includeMetadata:true,fetchImpl:async(_u,o)=>{
      body=JSON.parse(o.body);return {ok:true,json:async()=>({...payload(),model,usage:{output_tokens:450,output_tokens_details:{reasoning_tokens:400}}})};
    }});
    assert.equal(body.model,model);assert.deepEqual(body.reasoning,{effort:'medium'});
    assert.equal(body.max_output_tokens,8192);assert.equal(body.temperature,undefined);
    assert.equal(result.parameters.reasoning_effort,'medium');assert.equal(result.usage.output_tokens_details.reasoning_tokens,400);
  });
  test(model+' 真实后台测试入口用低推理预算而不是32token，无偷偷降级',async()=>{
    const w=worker(model);
    const result=await new Promise(resolve=>w.listener({type:'OPENAI_CONNECTION_TEST'},{id:'test',url:'chrome-extension://test/popup.html'},resolve));
    assert.equal(w.calls.length,1);assert.equal(result.model,model);assert.equal(w.calls[0].body.model,model);
    assert.equal(w.calls[0].body.reasoning.effort,'low');assert.equal(w.calls[0].body.max_output_tokens,1024);
  });
}
test('新模型无权限或输出预算耗尽，不转成4.1成功或自动重试',async()=>{
  let calls=0;
  for (const response of [{ok:false,status:404},{ok:true,json:async()=>({...payload(),status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})}]) {
    await assert.rejects(P.complete({...base,model:'gpt-6-astra',fetchImpl:async()=>{calls++;return response;}}));
  }
  assert.equal(calls,2);
  assert.equal(P.DEFAULT_MODEL,'gpt-6-astra');
});
test('设置页保留旧选择、新模型集中注册、未保存不发测试请求',()=>{
  const js=fs.readFileSync(path.join(__dirname,'../popup.js'),'utf8');
  const html=fs.readFileSync(path.join(__dirname,'../popup.html'),'utf8');
  for(const model of P.MODELS) assert.ok(html.includes(`value="${model}"`));
  assert.ok(js.includes('YuliuOpenAI.MODELS.includes(saved.openaiModel) ? saved.openaiModel'));
  assert.ok(js.indexOf("saved.modelProvider !== 'openai'") < js.indexOf("sendMessage({type:'OPENAI_CONNECTION_TEST'})"));
  assert.ok(html.indexOf('src="openai-provider.js"') < html.indexOf('src="popup.js"'));
});
test('测试连接仅允许设置页触发，返回结果没有密钥',async()=>{
  const w=worker();let denied;
  w.listener({type:'OPENAI_CONNECTION_TEST'},{id:'test',url:'https://page.example'},r=>denied=r);
  assert.equal(denied.ok,false);assert.equal(w.calls.length,0);
  const result=await new Promise(resolve=>w.listener({type:'OPENAI_CONNECTION_TEST'},{id:'test',url:'chrome-extension://test/popup.html'},resolve));
  assert.equal(result.ok,true);assert.equal(w.calls.length,1);assert.equal(w.calls[0].body.max_output_tokens,32);
  assert.ok(!JSON.stringify(result).includes('sk-LOCAL'));
});

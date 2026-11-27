const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const timing = require('../diagnostic-timing');
const event = (type, at, requestId, data = {}) => ({type, at, requestId, data});
test('旧记录按匹配请求至初始答案估算，不包含关闭与阅读时间', () => {
  const s = {startedAt:0,updatedAt:1071340,events:[event('request_started',323,'r'),
    event('answer_displayed',14567,'r',{mode:'initial'}),event('session_closed',1071340,'')]};
  assert.deepEqual(timing.initialAnswer(s),{ms:14244,estimated:true});
});
test('新记录优先前端单调时钟，不受写入排队与墙钟变化影响', () => {
  assert.deepEqual(timing.initialAnswer({events:[event('answer_displayed',500,'r',{mode:'initial',responseElapsedMs:12500})]}),
    {ms:12500,estimated:false});
});
test('补充解释和不匹配请求不能混入初始答案耗时，缺失时不猜', () => {
  const events=[event('request_started',1,'other'),event('answer_displayed',50,'s',{mode:'simplify'}),
    event('answer_displayed',200,'r',{mode:'initial'})];
  assert.equal(timing.initialAnswer({events}).ms,null);
  assert.equal(timing.initialAnswer({events:[]}).ms,null);
  events.unshift(event('request_started',100,'r'));
  assert.equal(timing.initialAnswer({events}).ms,100);
});
test('同会话多次调用只使用第一个完整初始答案，不取后续重写或最后活动', () => {
  const events=[event('request_started',100,'a'),event('answer_displayed',200,'a',{mode:'initial'}),
    event('request_started',300,'b'),event('answer_displayed',900,'b',{mode:'initial'})];
  assert.equal(timing.initialAnswer({events}).ms,100);
});
test('诊断写队列排队前采集事件时间，存储时间另列', async () => {
  const source=fs.readFileSync(require.resolve('../background.js'),'utf8');
  const start=source.indexOf('function recordDiagnosticEvent(event)');
  // Function is last in background.js.
  const code=source.slice(start);
  let clock=100, saved={}, release;
  const queue=new Promise(r=>release=r);
  const ctx={Date:{now:()=>clock},console,diagnosticWriteQueue:queue,diagnosticsAreEnabled:async()=>true,
    DIAGNOSTIC_STORAGE_KEY:'ledger',DIAGNOSTIC_MAX_EVENTS:80,DIAGNOSTIC_MAX_SESSIONS:100,DIAGNOSTIC_MAX_CHARACTERS:1000000,
    sanitizeDiagnosticData:x=>x,chrome:{storage:{local:{get:async()=>saved,set:async v=>{saved=v;}}}}};
  vm.createContext(ctx);vm.runInContext(code,ctx);
  const done=ctx.recordDiagnosticEvent({sessionId:'s',eventType:'request_started',data:{}});
  clock=5000;release();await done;
  assert.equal(saved.ledger.sessions[0].events[0].at,100);
  assert.equal(saved.ledger.sessions[0].events[0].persistedAt,5000);
});

test('固定评测为空时禁用导出并解释正确入口，已有报告可导出', async () => {
  const elements=new Map();
  const el=()=>({hidden:false,disabled:false,textContent:'',title:'',value:'',dataset:{},classList:{toggle(){}},
    addEventListener(){},append(){},replaceChildren(){},querySelector:()=>el(),querySelectorAll:()=>[]});
  const document={querySelector:s=>{if(!elements.has(s))elements.set(s,el());return elements.get(s);},createElement:el};
  const ctx={document,chrome:{storage:{local:{get:async()=>({})},onChanged:{addListener(){}}}},
    YuliuDiagnosticTiming:timing,YuliuContextualAudit:{fromSession:()=>[]},Date,console};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve('../diagnostics.js'),'utf8'),ctx);
  await new Promise(r=>setImmediate(r));
  assert.equal(elements.get('#exportEvaluationJson').disabled,true);
  assert.match(elements.get('#evaluationMessage').textContent,/上方/);
  let downloaded=false;ctx.downloadText=()=>{downloaded=true;};
  vm.runInContext('exportEvaluationJson()',ctx);assert.equal(downloaded,false);
  vm.runInContext('latestEvaluation = {summary:{}, cases:[]}; exportEvaluationJson()',ctx);
  assert.equal(downloaded,true);
});

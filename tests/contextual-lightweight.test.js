const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const L=require("../contextual-lightweight.js"),Compare=require("../evaluation/lightweight-comparison.js");
const A=require("../evaluation/review-ablation.js"),R=require("../contextual-reasoning.js");
const Suite=require("../evaluation/contextual-suite.js"),dataset=require("../evaluation/fixtures/contextual-transfer-v1.json");
const root=path.join(__dirname,".."),model="glm-4-flash-250414";
const evidence=[{evidence_id:"e1",block_id:"p1",quote:"答：可以，但仍须保留接口。",source_start:10},
 {evidence_id:"e2",block_id:"p0",quote:"问：两项服务能否分开部署？",source_start:0}];
test("轻量解析保留自然正文和必要的联合引用，不经过主张核验",()=>{
 const result=L.parse(JSON.stringify({meaning:"允许分开部署，但须保留接口。[e2][e1]",intent:null,
  references:[{id:"e2",quote:evidence[1].quote},{id:"e1",quote:"可以，但仍须保留接口。"}]}),evidence);
 assert.equal(result.error,"");assert.deepEqual(result.warnings,[]);
 assert.deepEqual(result.citations.map(e=>e.block_id),["p0","p1"]);
 assert.equal(result.citations[1].source_start,12);
 assert.ok(result.citations.every(e=>e.support_check==="not_semantically_verified"));
});
test("引用编造、缺失、未知编号不会删除原本可读的释义",()=>{
 for(const refs of [[{id:"e1",quote:"不存在的原文"}],[],[{id:"e999",quote:"任意文本"}]]){
  const meaning="这表示允许分开部署。[e1][e999]";
  const r=L.parse(JSON.stringify({meaning,intent:null,references:refs}),evidence);
  assert.equal(r.meaning,meaning);assert.equal(r.text,meaning);assert.equal(r.error,"");
  assert.equal(r.citations.length,0);assert.ok(r.warnings.length>0);
 }
});
test("重复原句不猜位置，不以整段高亮兜底",()=>{
 const e=[{evidence_id:"e1",block_id:"p0",quote:"可以。说明。可以。",source_start:0}];
 const r=L.parse(JSON.stringify({meaning:"此处是肯定答复。[e1]",references:[{id:"e1",quote:"可以。"}]}),e);
 assert.deepEqual(r.warnings,["AMBIGUOUS_QUOTE:e1"]);
 assert.equal(r.citations.length,0);assert.equal(r.text,"此处是肯定答复。[e1]");
});
test("常识和未知可以无引用，程序不强迫附上原文作为证明",()=>{
 const r=L.parse('{"meaning":"目前不能确定具体身份，但可知道是会议参与者。","intent":null,"references":[]}',evidence);
 assert.equal(r.error,"");assert.equal(r.citations.length,0);assert.ok(r.warnings.includes("NO_DOCUMENT_CITATIONS"));
});
test("仅格式失败才报告不可解析；原始输出由调用记录保留，不发起修复模型",()=>{
 assert.equal(L.parse("不是JSON",evidence).error,"INVALID_LIGHTWEIGHT_JSON");
 assert.equal(L.parse('{"meaning":5}',evidence).error,"MISSING_MEANING");
 const r=L.parse('```json\n{"meaning":"可读解释","intent":false,"references":{}}\n```',evidence);
 assert.equal(r.error,"");assert.ok(r.warnings.includes("INVALID_INTENT_FORMAT"));
});
test("不因没有选中词字面复述删除释义；不把精确引用当作语义正确",()=>{
 const meaning="两项服务必须合并部署。[e1]"; // deliberately wrong semantics
 const r=L.parse(JSON.stringify({meaning,references:[{id:"e1",quote:evidence[0].quote}]}),evidence);
 assert.equal(r.text,meaning);assert.equal(r.citations.length,1);
 assert.equal(r.citations[0].support_check,"not_semantically_verified");
 assert.equal(r.mechanical_checks_only,true);
});
function mockComplete(options){
 const input=JSON.parse(options.messages[1].content);
 if(options.messages[0].content===L.CANDIDATE_PROMPT){
  const e=input.evidence[0];
  return {content:JSON.stringify({meaning:"仅用于工程测试的解释。["+e.evidence_id+"]",intent:null,
   references:[{id:e.evidence_id,quote:e.quote}]}),reported_model:model};
 }
 return {content:"仅用于工程测试的A解释。[e1]",reported_model:model};
}
test("四例A/L输入相同、A提示保持原样；只有两次调用，期望不发给模型",async()=>{
 for(const id of Compare.CASE_IDS){
  const item=dataset.cases.find(c=>c.id===id),req=Suite.prepare({...item,expected:"PRIVATE_EXPECTED_SENTINEL"});
  const r=await Compare.runCase(req,{model,order:"A-L",complete:async o=>mockComplete(o)});
  assert.equal(r.history.length,2);assert.equal(r.actual_http_calls,2);assert.equal(r.fixed_model_confirmed,true);
  assert.equal(r.history[0].messages[0].content,A.simpleMessages(req,R.evidenceFor(req))[0].content);
  assert.equal(r.history[1].messages[0].content,L.CANDIDATE_PROMPT);
  assert.equal(r.ruleset,L.CANDIDATE_VERSION);
  assert.equal(r.history[0].messages[1].content,r.history[1].messages[1].content);
  assert.doesNotMatch(JSON.stringify(r.history),/PRIVATE_EXPECTED_SENTINEL/);
  assert.ok(r.history.every(h=>h.max_tokens===2100 && h.requested_model===model));
  assert.equal(r.arms.L.status,"completed");
 }
});
test("候选格式失败仍独立运行A，不重试或切换模型；交替顺序生效",async()=>{
 const req=Suite.prepare(dataset.cases.find(c=>c.id===Compare.CASE_IDS[0]));
 const r=await Compare.runCase(req,{model,order:"L-A",complete:async o=>
  o.messages[0].content===L.CANDIDATE_PROMPT?{content:"错误格式",reported_model:model}:mockComplete(o)});
 assert.deepEqual(r.history.map(h=>h.stage),["L_lightweight","A_direct"]);
 assert.equal(r.arms.L.status,"protocol_error");assert.equal(r.arms.A.status,"completed");
 assert.equal(r.arms.L.raw,"错误格式");assert.equal(r.actual_http_calls,2);
});
test("服务失败不伪装成候选结果，不确认固定模型",async()=>{
 const req=Suite.prepare(dataset.cases.find(c=>c.id===Compare.CASE_IDS[0]));
 const r=await Compare.runCase(req,{model,order:"A-L",complete:async()=>{throw new Error("MODEL_HTTP_429");}});
 assert.equal(r.actual_http_calls,2);assert.equal(r.fixed_model_confirmed,false);
 assert.equal(r.arms.A.status,"failed");assert.equal(r.arms.L.status,"failed");
});
test("无效选区或付费/未知模型不执行调用",async()=>{
 const req=Suite.prepare(dataset.cases.find(c=>c.id===Compare.CASE_IDS[0]));
 let calls=0;const complete=async()=>{calls++;};
 await assert.rejects(Compare.runCase(req,{model:"other",order:"A-L",complete}),/INVALID_COMPARISON_OPTIONS/);
 req.documentContext.selection.start_offset=999;
 await assert.rejects(Compare.runCase(req,{model,order:"A-L",complete}),/INVALID_SELECTED_OCCURRENCE/);
 assert.equal(calls,0);
});
function boot(){
 let phase="startup",listener;const imports=[],urls=[];
 const ctx={console,URL,setTimeout,clearTimeout,AbortController,TextDecoder,
  chrome:{runtime:{id:"test",getURL:p=>"chrome-extension://test/"+p,
   onMessage:{addListener(f){listener=f;}},onConnect:{addListener(){}}},
   storage:{local:{get:async key=>({[key]:key==="bigmodelApiKey"?"mock-secret":false}),set:async()=>{}}}},
  fetch:async(url,o)=>{urls.push(url);if(url.startsWith("chrome-extension:"))return {json:async()=>dataset};
   const body=JSON.parse(o.body),res=mockComplete(body);
   return {ok:true,json:async()=>({model,choices:[{message:{content:res.content}}]})};}};
 vm.createContext(ctx);
 ctx.importScripts=(...files)=>{assert.equal(phase,"startup");for(const file of files){
  imports.push(file);vm.runInContext(fs.readFileSync(path.join(root,file),"utf8"),ctx,{filename:file});}};
 vm.runInContext(fs.readFileSync(path.join(root,"background.js"),"utf8"),ctx);phase="messages";
 const send=(m,page="contextual-lightweight-comparison.html")=>new Promise(resolve=>listener(m,
  {id:"test",url:"chrome-extension://test/"+page},resolve));
 return {ctx,imports,urls,send};
}
test("真实后台入口启动加载新模块，预检零模型请求，重建作用域仍可运行",async()=>{
 for(let n=0;n<2;n++){
  const w=boot();
  assert.ok(w.imports.includes("contextual-lightweight.js"));
  assert.ok(w.imports.includes("evaluation/lightweight-comparison.js"));
  const ready=await w.send({type:"LIGHTWEIGHT_PREFLIGHT"});
  assert.equal(ready.startup_version,"lightweight-startup-v2");
  assert.ok(w.urls.every(u=>u.startsWith("chrome-extension:")));
  const r=await w.send({type:"LIGHTWEIGHT_CASE",caseId:Compare.CASE_IDS[0],model,order:"A-L"});
  assert.equal(r.ok,true);assert.equal(r.result.actual_http_calls,2);
  assert.equal(r.result.arms.L.status,"completed");
  assert.doesNotMatch(JSON.stringify(r),/mock-secret/);
 }
});
test("专用页面/案例白名单仍生效，旧入口不能冒充新实验入口",async()=>{
 const w=boot();
 assert.equal((await w.send({type:"LIGHTWEIGHT_PREFLIGHT"},"contextual-review-ablation.html")).ok,false);
 assert.equal((await w.send({type:"LIGHTWEIGHT_CASE",caseId:"private",model,order:"A-L"})).ok,false);
 assert.equal(w.urls.length,0);
});
test("候选两轮页面运行仅16次模型调用，旧三组报告和指针保留",async()=>{
 class E{constructor(){this.children=[];this.listeners={};this.value="";}append(...x){this.children.push(...x);}
  replaceChildren(...x){this.children=[...x];}addEventListener(k,f){this.listeners[k]=f;}}
 const ids=Object.fromEntries(["model","rounds","run","stop","export","cases","summary","progress"].map(id=>[id,new E()]));
 ids.model.value=model;ids.rounds.value="2";const saved={yuliuReviewAblationLatest:"old",old:{untouched:true},
  yuliuLightweightComparisonLatest:"old-light", "old-light":{experiment_version:"lightweight-comparison-v1",untouched:true}},requests=[];
 const ctx={console,JSON,Date,URL,Blob,setTimeout,crypto:{randomUUID:()=>"light-mock"},
  document:{body:{dataset:{experiment:"lightweight"}},getElementById:id=>ids[id],createElement:()=>new E()},
  fetch:async()=>({json:async()=>dataset}),chrome:{runtime:{id:"test",getURL:p=>p,sendMessage:async m=>{
   requests.push(m);if(m.type==="LIGHTWEIGHT_PREFLIGHT")return {ok:true,startup_version:"lightweight-startup-v2"};
   return {ok:true,result:await Compare.runCase(Suite.prepare(dataset.cases.find(c=>c.id===m.caseId)),
    {model:m.model,order:m.order,complete:async o=>mockComplete(o)})};
  }},storage:{local:{get:async k=>({[k]:saved[k]}),set:async v=>Object.assign(saved,v)}}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,"contextual-review-ablation.js"),"utf8"),ctx);
 await new Promise(r=>setImmediate(r));await ids.run.listeners.click();
 const report=saved[saved.yuliuLightweightComparisonV2Latest];
 assert.equal(report.experiment_version,"lightweight-comparison-v2");
 assert.equal(report.completed_cases,8);assert.equal(report.recorded_http_calls,16);
 assert.equal(report.rows[0].order,"A-L");assert.equal(report.rows[4].order,"L-A");
 assert.equal(requests.length,9);assert.equal(saved.yuliuReviewAblationLatest,"old");assert.equal(saved.old.untouched,true);
 assert.equal(saved.yuliuLightweightComparisonLatest,"old-light");assert.equal(saved["old-light"].untouched,true);
 assert.match(ids.progress.textContent,/两组均正常返回 8\/8/);
 assert.equal(ids.cases.children.length,8);
});
test("新页面只加载已有共享展示脚本，实验标记和资源完整",()=>{
 const html=fs.readFileSync(path.join(root,"contextual-lightweight-comparison.html"),"utf8");
 assert.match(html,/data-experiment="lightweight"/);
 for(const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g))assert.ok(fs.existsSync(path.join(root,m[1])));
 assert.match(html,/16次请求/);assert.match(html,/尚未用于日常双击解释/);
});

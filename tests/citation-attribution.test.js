const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const C=require("../evaluation/citation-attribution"),L=require("../contextual-lightweight");
const R=require("../contextual-reasoning"),S=require("../evaluation/contextual-suite");
const data=require("../evaluation/fixtures/contextual-transfer-v1.json");
const root=path.join(__dirname,".."),model="glm-4-flash-250414";
const request=id=>S.prepare({...data.cases.find(c=>c.id===id),expected:"SECRET_EXPECTED"});
function response(options){
  const e=JSON.parse(options.messages[1].content).evidence;
  return {content:JSON.stringify({meaning:"仅为模拟答案。"+e.map(x=>"["+x.evidence_id+"]").join(""),
    intent:null,references:e.map(x=>({id:x.evidence_id,quote:x.quote}))}),reported_model:model};
}
test("三种条件只变排列或编号；每段文字、角色、坐标与选中位置不变",()=>{
  for(const id of C.CASE_IDS){
    const req=request(id),original=R.evidenceFor(req),snapshot=JSON.stringify(original);
    const base=JSON.parse(L.messages(req,original)[1].content);
    for(const variant of C.VARIANTS){
      const e=C.transform(original,variant),input=JSON.parse(L.messages(req,e)[1].content);
      assert.deepEqual({...input,evidence:null},{...base,evidence:null});
      for(const item of e){
        const source=original.find(x=>x.block_id===item.block_id);
        assert.deepEqual({...item,evidence_id:null},{...source,evidence_id:null});
      }
      assert.deepEqual(e.map(x=>x.block_id),variant==="reverse"?original.map(x=>x.block_id).reverse():original.map(x=>x.block_id));
      assert.deepEqual(e.map(x=>x.evidence_id),variant==="original"?["e1","e2"]:["e2","e1"]);
    }
    assert.equal(JSON.stringify(original),snapshot);
  }
});
test("L2只改变一段归因指令，保留原L全部其他段落与JSON字段；无案例特例",()=>{
  const before=L.PROMPT.split("\n"),after=C.PROMPT.split("\n");
  assert.equal(before.length,after.length);
  assert.equal(before.filter((line,i)=>line!==after[i]).length,1);
  assert.equal(before.at(-1),after.at(-1));
  assert.match(C.PROMPT,/单段足够时只引用该段/);
  assert.doesNotMatch(C.PROMPT,/林禾|窗口|归档|查询|志愿者/);
});
test("全部12组每组恰好两次固定模型调用；同组输入相同，不泄露期望，引用按真实段落映射",async()=>{
  for(const id of C.CASE_IDS)for(const variant of C.VARIANTS){
    const r=await C.runCase(request(id),{model,variant,order:"L1-L2",complete:async o=>response(o)});
    assert.equal(r.actual_http_calls,2);assert.equal(r.fixed_model_confirmed,true);
    assert.equal(r.history[0].messages[0].content,L.PROMPT);
    assert.equal(r.history[1].messages[0].content,C.PROMPT);
    assert.equal(r.history[0].messages[1].content,r.history[1].messages[1].content);
    assert.deepEqual(r.input,JSON.parse(r.history[0].messages[1].content));
    assert.doesNotMatch(JSON.stringify(r.history),/SECRET_EXPECTED|original_id|evidence_mapping/);
    assert.deepEqual(r.arms.L1.cited_blocks,r.evidence_mapping.map(e=>e.block_id));
    assert.ok(r.history.every(h=>h.max_tokens===2100&&h.requested_model===model));
    assert.ok(r.arms.L2.citations.every(e=>e.support_check==="not_semantically_verified"));
  }
});
test("无效编号或引文仅提示，不吞掉答案、不触发核验或重试",async()=>{
  const meaning="可读但引用待确认的解释。[e99]";
  const r=await C.runCase(request(C.CASE_IDS[0]),{model,variant:"renumber",order:"L2-L1",
    complete:async()=>({content:JSON.stringify({meaning,references:[]}),reported_model:model})});
  assert.deepEqual(r.history.map(x=>x.stage),["L2_attribution","L1_attribution"]);
  assert.equal(r.actual_http_calls,2);
  assert.equal(r.arms.L2.meaning,meaning);assert.equal(r.arms.L2.status,"completed");
  assert.deepEqual(r.arms.L2.warnings,["UNKNOWN_SOURCE:e99"]);
});
test("格式失败、请求失败与不同型号不冒充质量失败或同模型成功",async()=>{
  let n=0;
  const r=await C.runCase(request(C.CASE_IDS[0]),{model,variant:"original",order:"L1-L2",complete:async()=>{
    if(++n===2)throw new Error("MODEL_HTTP_429");return {content:"not json",reported_model:"other"};
  }});
  assert.equal(n,2);assert.equal(r.arms.L1.status,"protocol_error");assert.equal(r.arms.L1.raw,"not json");
  assert.equal(r.arms.L2.status,"failed");assert.equal(r.fixed_model_confirmed,false);
});
test("非法条件、模型、顺序、选区或片段数量在请求前失败",async()=>{
  let n=0;const complete=async()=>{n++;},req=request(C.CASE_IDS[0]);
  for(const extra of [{variant:"fake"},{model:"unknown"},{order:"L1-L1"}]){
    await assert.rejects(C.runCase(req,{model,variant:"original",order:"L1-L2",complete,...extra}));
  }
  assert.throws(()=>C.transform([{evidence_id:"e1"}],"original"));
  req.documentContext.selection.start_offset=999;
  await assert.rejects(C.runCase(req,{model,variant:"original",order:"L1-L2",complete}));
  assert.equal(n,0);
});
function boot(missing=false){
  let listener,started=true;const urls=[],imports=[];
  const ctx={console,URL,setTimeout,clearTimeout,AbortController,TextDecoder,
    chrome:{runtime:{id:"test",getURL:p=>"chrome-extension://test/"+p,
      onMessage:{addListener:f=>listener=f},onConnect:{addListener(){}}},
      storage:{local:{get:async k=>({[k]:k==="bigmodelApiKey"?"mock-secret":false}),set:async()=>{}}}},
    fetch:async(url,o)=>{
      urls.push(url);if(url.startsWith("chrome-extension:"))return {json:async()=>data};
      const res=response(JSON.parse(o.body));return {ok:true,json:async()=>({model,choices:[{message:{content:res.content}}]})};
    }};
  vm.createContext(ctx);
  ctx.importScripts=(...files)=>{assert.equal(started,true);for(const f of files){
    imports.push(f);if(missing&&f==="evaluation/citation-attribution.js")throw new Error("missing");
    vm.runInContext(fs.readFileSync(path.join(root,f),"utf8"),ctx,{filename:f});
  }};
  vm.runInContext(fs.readFileSync(path.join(root,"background.js"),"utf8"),ctx);started=false;
  const send=(m,page="contextual-citation-attribution.html")=>new Promise(resolve=>listener(m,
    {id:"test",url:"chrome-extension://test/"+page},resolve));
  return {send,urls,imports};
}
test("后台启动导入、零请求预检、worker重启可用，密钥不导出",async()=>{
  for(let i=0;i<2;i++){
    const w=boot(),ready=await w.send({type:"ATTRIBUTION_PREFLIGHT"});
    assert.ok(w.imports.includes("evaluation/citation-attribution.js"));
    assert.equal(ready.startup_version,"attribution-startup-v1");
    assert.ok(w.urls.every(u=>u.startsWith("chrome-extension:")));
    const r=await w.send({type:"ATTRIBUTION_CASE",caseId:C.CASE_IDS[2],variant:"renumber",model,order:"L1-L2"});
    assert.equal(r.ok,true);assert.equal(r.result.actual_http_calls,2);
    assert.equal(r.result.arms.L2.status,"completed");assert.doesNotMatch(JSON.stringify(r),/mock-secret/);
  }
});
test("后台拒绝其他页面、未知案例和未知扰动；模块缺失不阻断旧实验",async()=>{
  const w=boot();
  assert.equal((await w.send({type:"ATTRIBUTION_PREFLIGHT"},"contextual-lightweight-comparison.html")).ok,false);
  for(const extra of [{caseId:"private"},{variant:"fake"}]){
    const r=await w.send({type:"ATTRIBUTION_CASE",caseId:C.CASE_IDS[0],variant:"original",model,order:"L1-L2",...extra});
    assert.equal(r.ok,false);
  }
  assert.equal(w.urls.length,0);
  const missing=boot(true);
  assert.equal((await missing.send({type:"ATTRIBUTION_PREFLIGHT"})).ok,false);
  assert.equal(missing.urls.length,0);
  assert.equal((await missing.send({type:"LIGHTWEIGHT_PREFLIGHT"},"contextual-lightweight-comparison.html")).ok,true);
});
async function ui(mode){
  class E{constructor(){this.children=[];this.listeners={};this.value="";}append(...x){this.children.push(...x);}
    replaceChildren(...x){this.children=[...x];}addEventListener(k,f){this.listeners[k]=f;}}
  const ids=Object.fromEntries(["model","rounds","run","stop","export","cases","summary","progress"].map(id=>[id,new E()]));
  ids.model.value=model;ids.rounds.value="1";
  const saved={yuliuLightweightComparisonLatest:"old-L",yuliuReviewAblationLatest:"old-ABC"},requests=[];
  const ctx={console,JSON,Date,URL,Blob,setTimeout,crypto:{randomUUID:()=>"citation-mock"},
    document:{body:{dataset:{experiment:"attribution"}},getElementById:id=>ids[id],createElement:()=>new E()},
    fetch:async()=>({json:async()=>data}),chrome:{runtime:{id:"test",getURL:p=>p,sendMessage:async m=>{
      requests.push(m);
      if(m.type==="ATTRIBUTION_PREFLIGHT")return mode==="preflight-failure"?{ok:false,error:"模块缺失"}
        :{ok:true,startup_version:"attribution-startup-v1"};
      const result=await C.runCase(request(m.caseId),{model:m.model,variant:m.variant,order:m.order,complete:async o=>response(o)});
      if(mode==="stop")ids.stop.listeners.click();
      return {ok:true,result};
    }},storage:{local:{get:async k=>({[k]:saved[k]}),set:async v=>Object.assign(saved,v)}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,"contextual-review-ablation.js"),"utf8"),ctx);
  await new Promise(r=>setImmediate(r));await ids.run.listeners.click();
  return {saved,requests,ids,report:saved[saved.yuliuCitationAttributionLatest]};
}
test("完整界面一轮12组24请求，展示每组输入映射和实际回答，隔离旧报告",async()=>{
  const {report,saved,ids,requests}=await ui();
  assert.equal(report.planned,12);assert.equal(report.completed_cases,12);assert.equal(report.recorded_http_calls,24);
  assert.equal(requests.length,13);assert.equal(report.rows[0].order,"L1-L2");assert.equal(report.rows[1].order,"L2-L1");
  assert.deepEqual(Array.from(report.rows.slice(0,3),r=>r.variant),C.VARIANTS);
  assert.equal(saved.yuliuLightweightComparisonLatest,"old-L");assert.equal(saved.yuliuReviewAblationLatest,"old-ABC");
  assert.equal(ids.cases.children.length,12);assert.match(ids.progress.textContent,/12\/12/);
  assert.match(JSON.stringify(ids.cases.children),/本组实际输入排列/);
  assert.match(JSON.stringify(ids.cases.children),/仅为模拟答案/);
});
test("界面启动失败零调用；停止在当前双组结束后保存，不启动下一组",async()=>{
  const failure=await ui("preflight-failure");
  assert.equal(failure.report.completed_cases,0);assert.equal(failure.report.recorded_http_calls,0);
  assert.equal(failure.requests.length,1);
  const stopped=await ui("stop");
  assert.equal(stopped.report.completed_cases,1);assert.equal(stopped.report.recorded_http_calls,2);
  assert.equal(stopped.report.stopped,true);
});
test("扩展页面依赖完整且诊断后台可达，不将预览页当可执行入口",()=>{
  const html=fs.readFileSync(path.join(root,"contextual-citation-attribution.html"),"utf8");
  assert.match(html,/data-experiment="attribution"/);assert.match(html,/默认24次请求/);
  assert.match(html,/file:\/\/预览不能运行/);
  for(const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g))assert.ok(fs.existsSync(path.join(root,m[1])));
  assert.match(fs.readFileSync(path.join(root,"diagnostics.html"),"utf8"),/href="contextual-citation-attribution.html"/);
});


const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const root = path.join(__dirname,"..");
const dataset = require("../evaluation/fixtures/contextual-transfer-v1.json");

// Execute the actual worker and all dependencies; do NOT preinject modules.
// Resource map approximates the restriction, not a real Chrome execution.
function worker(installed = new Set(), broken = false) {
  let startup = true, listener; const imports = [], urls = [];
  const ctx = {console,URL,TextDecoder,AbortController,setTimeout,clearTimeout,
    chrome:{runtime:{id:"test",getURL:p=>"chrome-extension://test/"+p,
      onMessage:{addListener(fn){listener=fn;}},onConnect:{addListener(){}}},
      storage:{local:{get:async key=>({[key]:key==="bigmodelApiKey"?"mock-key":false}),set:async()=>{}}}},
    fetch:async url=>{
      urls.push(url);
      return url.startsWith("chrome-extension:")?{json:async()=>dataset}
        :{ok:true,json:async()=>({model:"glm-4-flash-250414",choices:[{message:{content:"仅用于启动测试的模拟响应"}}]})};
    }};
  vm.createContext(ctx);
  ctx.importScripts=(...files)=>{
    for(const file of files){
      imports.push({file,startup});
      if(!startup && !installed.has(file)) throw new Error("FIRST_IMPORT_AFTER_INSTALL");
      if(broken && file==="discourse-context.js")throw new Error("missing script");
      assert.ok(fs.existsSync(path.join(root,file)),file);
      vm.runInContext(fs.readFileSync(path.join(root,file),"utf8"),ctx,{filename:file});
      if(startup)installed.add(file);
    }
  };
  vm.runInContext(fs.readFileSync(path.join(root,"background.js"),"utf8"),ctx);
  startup=false;
  const send=message=>new Promise(resolve=>listener(message,
    {id:"test",url:"chrome-extension://test/contextual-review-ablation.html"},resolve));
  return {ctx,imports,urls,send,installed};
}
test("真实后台脚本在启动阶段导入实验依赖，按钮阶段不首次导入",async()=>{
  const w=worker();
  for(const file of ["discourse-context.js","document-retrieval.js","evaluation/contextual-suite.js","evaluation/review-ablation.js"])
    assert.ok(w.imports.some(i=>i.file===file && i.startup));
  const before=w.imports.length;
  const ready=await w.send({type:"REVIEW_ABLATION_PREFLIGHT"});
  assert.equal(ready.ok,true);assert.equal(ready.startup_version,"ablation-startup-v2");
  assert.equal(w.urls.filter(u=>u.includes("/chat/completions")).length,0);
  const result=await w.send({type:"REVIEW_ABLATION_CASE",caseId:"transfer-window-time",
    model:"glm-4-flash-250414",order:"A-BC"});
  assert.equal(result.ok,true);
  assert.equal(result.result.actual_http_calls,2); // Invalid mock JSON skips C, as designed.
  assert.equal(w.imports.length,before);
});
test("模拟worker终止后新建作用域，从真实入口重建依赖，不依赖上次全局状态",async()=>{
  const first=worker();await first.send({type:"REVIEW_ABLATION_PREFLIGHT"});
  const restarted=worker(first.installed);
  assert.notEqual(first.ctx,restarted.ctx);
  assert.equal((await restarted.send({type:"REVIEW_ABLATION_PREFLIGHT"})).ok,true);
  const result=await restarted.send({type:"REVIEW_ABLATION_CASE",caseId:"transfer-window-ui",
    model:"glm-4-flash-250414",order:"BC-A"});
  assert.equal(result.ok,true);
  assert.ok(restarted.imports.every(i=>i.startup));
});
test("启动依赖缺失时明确阻止实验，不请求模型，也不阻断正式后台注册",async()=>{
  const w=worker(new Set(),true);
  const ready=await w.send({type:"REVIEW_ABLATION_PREFLIGHT"});
  assert.equal(ready.ok,false);assert.match(ready.error,/实验依赖加载失败/);
  const result=await w.send({type:"REVIEW_ABLATION_CASE",caseId:"transfer-window-time",
    model:"glm-4-flash-250414",order:"A-BC"});
  assert.equal(result.ok,false);
  assert.equal(w.urls.length,0);
  assert.equal(typeof w.ctx.runGroundedInitial,"function");
});
test("启动检查无响应或失败：零案例完成、无模型请求，保留中文说明",async()=>{
  for(const response of [undefined,{ok:false,error:"实验依赖加载失败"}]){
    class E{
      constructor(){this.children=[];this.listeners={};this.value="";this.disabled=false;}
      append(...v){this.children.push(...v);}replaceChildren(...v){this.children=[...v];}
      addEventListener(k,fn){this.listeners[k]=fn;}
    }
    const ids=Object.fromEntries(["summary","cases","progress","run","stop","export","rounds","model"].map(id=>[id,new E()]));
    ids.rounds.value="2";ids.model.value="glm-4-flash-250414";
    const saved={},messages=[];
    const ctx={console,JSON,Date,URL,Blob,setTimeout,crypto:{randomUUID:()=>"mock-startup"},
      document:{getElementById:id=>ids[id],createElement:()=>new E()},
      fetch:async()=>({json:async()=>dataset}),
      chrome:{runtime:{id:"test",getURL:p=>p,sendMessage:async m=>{messages.push(m);return response;}},
        storage:{local:{get:async k=>({[k]:saved[k]}),set:async v=>Object.assign(saved,v)}}}};
    vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,"contextual-review-ablation.js"),"utf8"),ctx);
    await new Promise(r=>setImmediate(r));await ids.run.listeners.click();
    const report=saved[saved.yuliuReviewAblationLatest];
    assert.equal(report.rows.length,0);assert.equal(report.completed_cases,0);
    assert.equal(report.recorded_http_calls,0);assert.ok(report.startup_error);
    assert.equal(messages.length,1);assert.equal(messages[0].type,"REVIEW_ABLATION_PREFLIGHT");
    assert.match(ids.progress.textContent,/启动失败，完成 0\/8/);
    assert.equal(ids.run.disabled,false);assert.equal(ids.export.disabled,false);
  }
});
test("旧报告仅有启动失败行时不再显示已完成1组",async()=>{
  class E{
    constructor(){this.children=[];this.listeners={};}
    append(...v){this.children.push(...v);}replaceChildren(...v){this.children=[...v];}
    addEventListener(k,v){this.listeners[k]=v;}
  }
  const ids=Object.fromEntries(["summary","cases","progress","run","stop","export"].map(id=>[id,new E()]));
  const old={experiment_version:"review-ablation-v1",planned:8,model:"mock",rows:[
    {id:"transfer-window-time",round:1,error:"script failed",result:null}]};
  const saved={yuliuReviewAblationLatest:"old",old};
  const ctx={console,URL,Blob,setTimeout,document:{getElementById:id=>ids[id],createElement:()=>new E()},
    fetch:async()=>({json:async()=>dataset}),
    chrome:{runtime:{id:"test",getURL:p=>p},storage:{local:{get:async k=>({[k]:saved[k]})}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,"contextual-review-ablation.js"),"utf8"),ctx);
  await new Promise(r=>setImmediate(r));
  assert.match(ids.summary.children.map(e=>e.textContent).join("\n"),/三组均正常返回 0\/8 组；已尝试 1 组/);
  assert.equal(old.rows.length,1);
});

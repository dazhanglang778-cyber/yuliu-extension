const test = require("node:test");
test("页面全程模拟运行两轮八组，逐例保存并展示三组，不覆盖旧报告", async()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.value="";this.disabled=false;}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=[...nodes];}
    addEventListener(name,fn){this.listeners[name]=fn;}
  }
  const ids=Object.fromEntries(["cases","progress","summary","run","stop","export","model","rounds"].map(id=>[id,new Element(id)]));
  ids.model.value=model;ids.rounds.value="2";
  const stored={oldReport:{preserve:true}}, sent=[];
  const ctx={console,JSON,Date,Blob,URL,setTimeout,crypto:{randomUUID:()=>"mock-run-id"},
    document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)},
    fetch:async()=>({json:async()=>dataset}),
    chrome:{runtime:{id:"test",getURL:p=>p,sendMessage:async message=>{
      if(message.type === "REVIEW_ABLATION_PREFLIGHT") return {ok:true,startup_version:"ablation-startup-v2"};
      sent.push(message);
      const item=dataset.cases.find(c=>c.id===message.caseId), request=Suite.prepare(item);
      const result=await A.runCase(request,{model,order:message.order,complete:async o=>{
        const evidence=R.evidenceFor(request),e=evidence[0],input=JSON.parse(o.messages[1].content);
        return {content:input.draft?JSON.stringify({review_version:R.REVIEW_VERSION,checks:[{id:"c1",supported:true,
          selection_fit:"current",basis:"document",replacement:null,citations:[{evidence_id:e.evidence_id,quote:e.quote}],reason:"mock"}]})
          :o.messages[0].content.includes("只输出JSON")?JSON.stringify({target_type:"term",statements:[{id:"c1",part:"meaning",
            basis:"document",text:"仅用于界面测试的模拟输出",evidence_ids:[e.evidence_id]}]}):"模拟直接输出",
          reported_model:model};
      }});
      return {ok:true,result};
    }},storage:{local:{get:async key=>({[key]:stored[key]}),set:async values=>Object.assign(stored,values)}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,"../contextual-review-ablation.js"),"utf8"),ctx);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ids.run.disabled,false);
  await ids.run.listeners.click();
  assert.equal(sent.length,8);
  assert.ok(sent.every(m=>m.model===model && !m.expected && !m.documentContext));
  assert.equal(ids.cases.children.length,8);
  const report=stored[stored.yuliuReviewAblationLatest];
  assert.equal(report.rows.length,8);
  assert.equal(report.rows.reduce((n,r)=>n+r.result.actual_http_calls,0),24);
  assert.equal(report.rows[0].order,"A-BC");assert.equal(report.rows[4].order,"BC-A");
  assert.equal(stored.oldReport.preserve,true);
  assert.equal(ids.run.disabled,false);assert.equal(ids.stop.disabled,true);
  assert.match(ids.progress.textContent,/运行结束/);
});
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const R = require("../contextual-reasoning.js");
const A = require("../evaluation/review-ablation.js");
const Suite = require("../evaluation/contextual-suite.js");
const dataset = require("../evaluation/fixtures/contextual-transfer-v1.json");
const model = A.MODELS[0];
function setup() {
  const item = dataset.cases.find(c=>c.id===A.CASE_IDS[0]);
  const request = Suite.prepare({...item,expected:"SECRET_EXPECTATION_NOT_FOR_MODEL"});
  const evidence = R.evidenceFor(request);
  const e = evidence.find(e=>e.block_id==="p0");
  const draft = {target_type:"term",statements:[{id:"c1",part:"meaning",basis:"document",
    text:"这是提交入口。",evidence_ids:[e.evidence_id]}]};
  const review = {review_version:R.REVIEW_VERSION,checks:[{id:"c1",supported:true,selection_fit:"current",
    basis:"document",replacement:"这是允许提交预约申请的时间段。",citations:[{evidence_id:e.evidence_id,quote:e.quote}],reason:"原文规定提交时间"}]};
  const seen = [];
  const complete = async options => {
    seen.push(options);
    const input=JSON.parse(options.messages[1].content);
    const raw = input.draft ? review : options.messages[0].content.includes("只输出JSON") ? draft : "这里指允许提交申请的时间段。["+e.evidence_id+"]";
    return {content:typeof raw==="string"?raw:JSON.stringify(raw),reported_model:model,parameters:{requested_model:model}};
  };
  return {request,evidence,complete,seen};
}
test("三组只调用三次，B/C共享初稿且核验修改不污染B",async()=>{
  const s=setup(),r=await A.runCase(s.request,{model,complete:s.complete});
  assert.equal(r.actual_http_calls,3);
  assert.deepEqual(r.history.map(h=>h.stage),["A_direct","B_generation","C_review"]);
  assert.equal(r.arms.B.text,"这是提交入口。");
  assert.equal(r.arms.C.text,"这是允许提交预约申请的时间段。");
  assert.equal(r.arms.C.changes[0].text_changed,true);
  assert.deepEqual(JSON.parse(r.history[2].messages[1].content).draft,r.arms.B.draft);
  assert.equal(r.arms.C.elapsed_ms,r.arms.B.elapsed_ms+r.arms.C.review_elapsed_ms);
  assert.equal(r.fixed_model_confirmed,true);
  assert.equal(r.human_review_required,true);
});
test("A/B选区和证据完全一致，期望答案不进任何模型输入",async()=>{
  const s=setup(),r=await A.runCase(s.request,{model,complete:s.complete});
  assert.equal(r.history[0].messages[1].content,r.history[1].messages[1].content);
  assert.doesNotMatch(JSON.stringify(r.history),/SECRET_EXPECTATION_NOT_FOR_MODEL/);
  for(const o of s.seen){assert.equal(o.fixedModel,model);assert.equal(o.maxTokens,2100);}
});
test("交换实验顺序不改变B/C配对",async()=>{
  const s=setup(),r=await A.runCase(s.request,{model,complete:s.complete,order:"BC-A"});
  assert.deepEqual(r.history.map(h=>h.stage),["B_generation","C_review","A_direct"]);
  assert.equal(r.arms.B.text,"这是提交入口。");
});
test("结构化格式错误保留原文，不重试不偷偷换模型，跳过C",async()=>{
  const s=setup();
  const r=await A.runCase(s.request,{model,complete:async()=>({content:"不是JSON",reported_model:model})});
  assert.equal(r.actual_http_calls,2);
  assert.equal(r.arms.B.status,"protocol_error");
  assert.equal(r.arms.B.raw,"不是JSON");
  assert.equal(r.arms.C.status,"skipped");
});
test("模型错误单独记录，A失败不会伪造B或C结果",async()=>{
  const s=setup();let n=0;
  const r=await A.runCase(s.request,{model,complete:async o=>{if(++n===1)throw new Error("MODEL_HTTP_429");return s.complete(o);}});
  assert.equal(r.arms.A.status,"failed");assert.equal(r.arms.C.status,"completed");
  assert.equal(r.actual_http_calls,3);assert.equal(r.fixed_model_confirmed,false);
});
test("核验失败不回填成成功，保留B初稿和耗时",async()=>{
  const s=setup();
  const r=await A.runCase(s.request,{model,complete:async o=>{
    if(JSON.parse(o.messages[1].content).draft)throw new Error("MODEL_TIMEOUT");
    return s.complete(o);
  }});
  assert.equal(r.arms.B.status,"completed");assert.equal(r.arms.C.status,"failed");
  assert.equal(r.arms.C.text,"");assert.equal(r.history.length,3);
});
test("核验协议错误不是内容错误，完整保留核验原始输出",async()=>{
  const s=setup();
  const r=await A.runCase(s.request,{model,complete:async o=>{
    if(JSON.parse(o.messages[1].content).draft)return {content:"{}",reported_model:model};
    return s.complete(o);
  }});
  assert.equal(r.arms.C.status,"protocol_error");assert.equal(r.arms.C.raw,"{}");
  assert.match(r.arms.C.error,/INVALID_VERIFICATION_FIELDS/);
});
test("服务未报告模型或报告不同模型，不声称固定模型已证实",async()=>{
  for(const reported_model of [null,"different-model"]){
    const s=setup(),r=await A.runCase(s.request,{model,complete:async o=>({...await s.complete(o),reported_model})});
    assert.equal(r.fixed_model_confirmed,false);
  }
});
test("无效模型或选中位置不消耗真实请求",async()=>{
  const s=setup();let n=0;const complete=async()=>{n++;};
  await assert.rejects(A.runCase(s.request,{model:"paid-model",complete}),/INVALID_FIXED_MODEL/);
  s.request.documentContext.selection.start_offset=9999;
  await assert.rejects(A.runCase(s.request,{model,complete}),/INVALID_SELECTED_OCCURRENCE/);
  assert.equal(n,0);
});
function backend(fetchImpl) {
  let listener;
  const ctx={console,URL,setTimeout,clearTimeout,AbortController,TextDecoder,
    fetch:fetchImpl,YuliuContextualReasoning:R,YuliuReviewAblation:A,YuliuContextualSuite:Suite,
    chrome:{runtime:{id:"test",getURL:p=>"chrome-extension://test/"+p,
      onConnect:{addListener(){}},onMessage:{addListener(fn){listener=fn;}}},
      storage:{local:{get:async key=>({[key]:key==="bigmodelApiKey"?"mock-secret":false}),set:async()=>{}}}}};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,"../background.js"),"utf8"),ctx);
  return {ctx,get listener(){return listener;}};
}
test("固定模型失败只有一次HTTP尝试；默认生产调用仍保留备用模型",async()=>{
  let bodies=[];
  const b=backend(async(url,o)=>{bodies.push(JSON.parse(o.body));return {ok:false,status:503,text:async()=>"unavailable"};});
  await assert.rejects(b.ctx.completeModel({apiKey:"mock-secret",messages:[],fixedModel:model}));
  assert.equal(bodies.length,1);assert.equal(bodies[0].model,model);
  bodies=[];
  await assert.rejects(b.ctx.completeModel({apiKey:"mock-secret",messages:[]}));
  assert.deepEqual(bodies.map(x=>x.model),["glm-4.7-flash","glm-4-flash-250414"]);
});
test("后台拒绝网页来源和任意案例，密钥与服务错误正文不进入实验结果",async()=>{
  let calls=0;
  const b=backend(async(url)=>{
    if(url.startsWith("chrome-extension:"))return {json:async()=>dataset};
    calls++;return {ok:false,status:429,text:async()=>"PRIVATE_PROVIDER_ERROR mock-secret"};
  });
  let reply;
  b.listener({type:"REVIEW_ABLATION_CASE"},{id:"test",url:"https://untrusted.example/"},r=>{reply=r;});
  assert.equal(reply.ok,false);assert.equal(calls,0);
  await assert.rejects(b.ctx.runReviewAblationCase({caseId:"arbitrary",model,order:"A-BC"}));
  const result=await b.ctx.runReviewAblationCase({caseId:A.CASE_IDS[0],model,order:"A-BC",
    documentContext:{private:"MUST_NOT_BE_USED"},expected:"MUST_NOT_BE_USED"});
  assert.equal(result.ok,true);assert.equal(calls,2);
  assert.doesNotMatch(JSON.stringify(result),/mock-secret|PRIVATE_PROVIDER_ERROR|MUST_NOT_BE_USED/);
});
test("页面提供真实输出、人工评审、独立保存与停止，不用关键词宣判胜负",()=>{
  const root=path.join(__dirname,"..");
  const html=fs.readFileSync(path.join(root,"contextual-review-ablation.html"),"utf8");
  for(const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g))assert.ok(fs.existsSync(path.join(root,m[1])));
  const js=fs.readFileSync(path.join(root,"contextual-review-ablation.js"),"utf8");
  assert.match(js,/crypto.randomUUID/);assert.match(js,/evidence_rating/);
  assert.match(html,/不重试、不切换模型/);assert.match(html,/不由参赛模型给自己打分/);
  assert.doesNotMatch(js,/bigmodelApiKey/);
});

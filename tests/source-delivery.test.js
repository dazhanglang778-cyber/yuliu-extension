const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const L=require("../contextual-lightweight"),R=require("../contextual-reasoning");
const S=require("../evaluation/contextual-suite"),Contract=require("../grounding-contract-v2");
const data=require("../evaluation/fixtures/contextual-transfer-v1.json");
const e=[{evidence_id:"e1",block_id:"p1",quote:"有志愿者临时缺席时，请联系林禾。",source_start:0},
 {evidence_id:"e2",block_id:"p0",quote:"本次活动联络表：林禾｜志愿者协调员。",source_start:20}];
const raw=(meaning,refs)=>JSON.stringify({meaning,intent:null,references:refs});
const refs=e.map(x=>({id:x.evidence_id,quote:x.quote}));
test("遗漏正文标记时保留模型列出的两处精确原文，但不自动绑定或声称相关",()=>{
 const text="林禾是志愿者协调员，缺席时联系他。";
 const r=L.parseCandidate(raw(text,refs),e);
 assert.equal(r.text,text);assert.equal(r.citations.length,0);assert.equal(r.related_sources.length,2);
 assert.equal(r.related_sources[1].source_start,20);
 assert.ok(r.related_sources.every(s=>s.binding_check==="not_bound_to_answer"&&s.relevance_check==="not_verified"));
 assert.equal(r.corrections.length,0);
});
test("已绑定引用与未绑定原文分层，不重复展示、不把后一条塞进正文",()=>{
 const r=L.parseCandidate(raw("身份说明[e2]；这里联系他。",refs),e);
 assert.deepEqual(r.citations.map(s=>s.evidence_id),["e2"]);
 assert.deepEqual(r.related_sources.map(s=>s.evidence_id),["e1"]);
 assert.equal(r.text,"身份说明[e2]；这里联系他。");
});
test("段落编号不自动冒充引用，原来语义错误的回答也不被回放改成正确",()=>{
 const text="可以使用同一个目录，来源为[p1]";
 const r=L.parseCandidate(raw(text,refs),e);
 assert.deepEqual(r.unrecognized_markers,["p1"]);
 assert.equal(r.citations.length,0);assert.equal(r.text,text);
 assert.equal(r.related_sources.length,2);
});
test("编造、重复位置、未知编号等未绑定引文只进诊断，不作为可定位原文",()=>{
 for(const bad of [{id:"e1",quote:"不存在"}, {id:"e9",quote:e[0].quote},{id:"e1",quote:"是。"}]){
  const input=bad.quote==="是。"?[{...e[0],quote:"是。是。"}]:e;
  const r=L.parseCandidate(raw("正文",[bad]),input);
  assert.equal(r.related_sources.length,0);assert.equal(r.unresolved_references.length,1);
  assert.equal(r.text,"正文");
 }
});
test("未绑定原文按精确内容去重；无关但真实的引文不冒充语义通过",()=>{
 const r=L.parseCandidate(raw("一个界面",[refs[0],refs[0]]),e);
 assert.equal(r.related_sources.length,1);
 assert.equal(r.related_sources[0].support_check,"not_semantically_verified");
});
function fixture(){
 const req=S.prepare(data.cases.find(c=>c.id==="transfer-condition")),evidence=R.evidenceFor(req);
 const source=evidence.find(s=>s.block_id==="p1");
 const s={id:"s1",part:"meaning",basis:"document",text:"两项服务可分别部署，但仍须共用权限目录。",evidence_ids:[source.evidence_id]};
 const d={target_type:"reference",statements:[s]};
 const c={id:"s1",supported:true,selection_fit:"current",basis:"document",replacement:null,
  citations:[{evidence_id:source.evidence_id,quote:"不存在的引文"}],reason:"模拟核验，仅测程序行为"};
 return {req,evidence,source,s,d,c};
}
async function play(f,replies){
 let calls=0;const out=await R.run(f.req,async()=>{assert.ok(calls<replies.length);return JSON.stringify(replies[calls++]);});
 assert.equal(Contract.validate(out.result).ok,true);return {out,calls};
}
test("正式流程：核验认可含义但引文失败，保留待核对解释，不附假引用、不追加模型重试",async()=>{
 const f=fixture(),{out,calls}=await play(f,[f.d,{review_version:R.REVIEW_VERSION,checks:[f.c]}]);
 assert.equal(calls,2);assert.equal(out.result.meaning_here.text,"待核对："+f.s.text);
 assert.equal(out.result.page_evidence.length,0);assert.equal(out.result.claims.length,0);
 assert.match(out.result.contextual_details.citation_warning,/待核对/);
 assert.equal(out.result.contextual_details.failure_category,"citation");
 assert.equal(out.result.resolution.status,"insufficient");
 assert.equal(out.trace.error,"CITATION_LOCATION_UNVERIFIED");
});
test("局部可选字段错误不重做已有效的初稿，仅将正常部分送审",async()=>{
 const f=fixture();f.d.statements.push({id:"broken",part:"intent",basis:"general",text:"无效可选意图",evidence_ids:[]});
 f.c.citations=[{evidence_id:f.source.evidence_id,quote:f.source.quote}];
 const {out,calls}=await play(f,[f.d,{review_version:R.REVIEW_VERSION,checks:[f.c]}]);
 assert.equal(calls,2);assert.equal(out.result.meaning_here.text,f.s.text);
 assert.deepEqual(JSON.parse(out.trace.history[1].messages[1].content).required_check_ids,["s1"]);
 assert.ok(out.trace.generation.statements.some(s=>s.id==="broken")); // original trace preserved
});
test("明确不支持、其他词义、不确定用法仍不以引用警告为由放行",async()=>{
 for(const extra of [{supported:false},{selection_fit:"other"},{selection_fit:"uncertain"}]){
  const f=fixture(),{out}=await play(f,[f.d,{review_version:R.REVIEW_VERSION,checks:[{...f.c,...extra}]}]);
  assert.doesNotMatch(out.result.meaning_here.text,/两项服务可分别部署/);
  assert.equal(out.result.contextual_details.citation_warning,"");assert.equal(out.result.claims.length,0);
 }
});
test("缺协议字段不能伪装引用定位失败来显示初稿",async()=>{
 const f=fixture();delete f.c.supported;
 const v={review_version:R.REVIEW_VERSION,checks:[f.c]};
 const {out}=await play(f,[f.d,v,v]);
 assert.doesNotMatch(out.result.meaning_here.text,/两项服务可分别部署/);
 assert.equal(out.result.contextual_details.citation_warning,"");
});
test("有效含义优先展示，引用失效的附加项不混作已核验正文",()=>{
 const f=fixture(),s2={...f.s,id:"s2",text:"额外说明"};
 const c2={...f.c,id:"s2",citations:[{evidence_id:f.source.evidence_id,quote:f.source.quote}]};
 const checked=R.acceptReview({...f.d,statements:[f.s,s2]},{review_version:R.REVIEW_VERSION,checks:[f.c,c2]},f.evidence);
 const result=R.compose(f.req,f.d,checked,f.evidence);
 assert.equal(result.meaning_here.text,"额外说明");assert.equal(result.contextual_details.citation_warning,"");
});
test("重载已有候选报告只在展示层回放来源，不发模型请求、不覆写原报告",async()=>{
 class E{constructor(){this.children=[];this.listeners={};}append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}addEventListener(k,f){this.listeners[k]=f;}}
 const elements=Object.fromEntries(["model","rounds","run","stop","export","cases","summary","progress"].map(id=>[id,new E()]));
 const modelRaw=raw("林禾是志愿者协调员。",refs);
 const a={text:"林禾是志愿者协调员。",citations:[],status:"completed",elapsed_ms:100,raw:modelRaw};
 const report={experiment_version:"lightweight-comparison-v2",planned:1,rows:[{id:"transfer-person-roster",round:1,result:{
  model:"mock",order:"A-L",fixed_model_confirmed:true,arms:{A:{...a,raw:null},L:a},input:{evidence:e},history:[]}}]};
 const snapshot=JSON.stringify(report);let requests=0,writes=0;
 const ctx={console,JSON,Date,URL,Blob,setTimeout,YuliuContextualLightweight:L,
  document:{body:{dataset:{experiment:"lightweight"}},getElementById:id=>elements[id],createElement:()=>new E()},
  fetch:async()=>({json:async()=>data}),chrome:{runtime:{id:"test",getURL:p=>p,sendMessage:async()=>{requests++;}},
   storage:{local:{get:async k=>({[k]:k==="yuliuLightweightComparisonV2Latest"?"saved":report}),set:async()=>{writes++;}}}}};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,"../contextual-review-ablation.js"),"utf8"),ctx);
 await new Promise(r=>setImmediate(r));
 assert.equal(requests,0);assert.equal(writes,0);assert.equal(JSON.stringify(report),snapshot);
 assert.match(JSON.stringify(elements.cases.children),/模型列出的原文/);
 assert.match(JSON.stringify(elements.cases.children),/志愿者协调员/);
});

const test=require("node:test"),assert=require("node:assert/strict");
const L=require("../contextual-lightweight");
const evidence=[
 {evidence_id:"e1",block_id:"p0",quote:"问：两项服务能否分开部署？",source_start:10},
 {evidence_id:"e2",block_id:"p1",quote:"答：可以，但仍须使用同一个权限目录。",source_start:40}
];
const encode=(meaning,refs,intent=null)=>JSON.stringify({meaning,intent,references:refs});
test("引文正确编号错误：只改单一标记与定位，保留原始输出和纠错记录",()=>{
 const raw=encode("允许分开，但仍须使用同一个权限目录。[e1]",[{id:"e1",quote:evidence[1].quote}]);
 const r=L.parseCandidate(raw,evidence);
 assert.equal(r.meaning,"允许分开，但仍须使用同一个权限目录。[e2]");
 assert.equal(r.citations[0].source_start,40);assert.equal(r.citations[0].block_id,"p1");
 assert.equal(r.corrections[0].from,"e1");assert.equal(r.corrections[0].to,"e2");
 assert.equal(r.raw_fields.references[0].id,"e1");assert.equal(r.corrected_fields.references[0].id,"e2");
 assert.deepEqual(r.warnings,[]);assert.equal(r.citations[0].support_check,"not_semantically_verified");
 assert.equal(L.parse(raw,evidence).citations.length,0); // v1 frozen
});
test("正文与表达作用同步一次性换号，支持互换不发生串行替换污染",()=>{
 const r=L.parseCandidate(encode("对象来自提问[e2]，条件来自回答[e1]。",
  [{id:"e2",quote:evidence[0].quote},{id:"e1",quote:evidence[1].quote}],"补充条件[e1]"),evidence);
 assert.equal(r.meaning,"对象来自提问[e1]，条件来自回答[e2]。");
 assert.equal(r.intent,"补充条件[e2]");assert.equal(r.corrections.length,2);
});
test("同句跨来源或在单来源重复，不猜位置、不扩大到整段",()=>{
 for(const extra of [
  [...evidence,{...evidence[1],evidence_id:"e3",block_id:"p2"}],
  [evidence[0],{...evidence[1],quote:evidence[1].quote+evidence[1].quote}]
 ]){
  const r=L.parseCandidate(encode("回答[e1]",[{id:"e1",quote:evidence[1].quote}]),extra);
  assert.equal(r.meaning,"回答[e1]");assert.equal(r.corrections.length,0);assert.equal(r.citations.length,0);
  assert.ok(r.warnings.includes("AMBIGUOUS_REPAIR:e1"));
 }
});
test("已有编号内重复的引文保持歧义，不擅自移到另一个唯一出现来源",()=>{
 const e=[{...evidence[0],quote:"是。是。"},{...evidence[1],quote:"是。"}];
 const r=L.parseCandidate(encode("回答[e1]",[{id:"e1",quote:"是。"}]),e);
 assert.equal(r.corrections.length,0);assert.ok(r.warnings.includes("AMBIGUOUS_QUOTE:e1"));
});
test("合并编号或重复引用协议冲突时不修；不因错误吞掉解释",()=>{
 const r=L.parseCandidate(encode("两项说明[e1][e2]",
  [{id:"e1",quote:evidence[1].quote},{id:"e2",quote:evidence[1].quote}]),evidence);
 assert.equal(r.corrections.length,0);assert.ok(r.warnings.includes("REPAIR_CONFLICT:e1"));
 assert.equal(r.meaning,"两项说明[e1][e2]");assert.equal(r.citations.length,1);
 const duplicate=L.parseCandidate(encode("说明[e1]",[{id:"e1",quote:"可以"},{id:"e1",quote:"其他"}]),evidence);
 assert.equal(duplicate.corrections.length,0);
});
test("未知编号仅在唯一精确引文时可纠；改写或编造引文不做近似匹配",()=>{
 const fixed=L.parseCandidate(encode("说明[e99]",[{id:"e99",quote:evidence[1].quote}]),evidence);
 assert.equal(fixed.meaning,"说明[e2]");assert.equal(fixed.corrections.length,1);
 const r=L.parseCandidate(encode("说明[e1]",[{id:"e1",quote:"两项服务可以完全独立，无需共同目录。"}]),evidence);
 assert.equal(r.corrections.length,0);assert.equal(r.citations.length,0);assert.equal(r.meaning,"说明[e1]");
});
test("真引用却不能支持答案的记录保持待判断，程序不补造证据或自称已核验",()=>{
 const r=L.parseCandidate(encode("可以分开部署且需要共同目录[e1]",[{id:"e1",quote:evidence[0].quote}]),evidence);
 assert.equal(r.corrections.length,0);assert.equal(r.citations.length,1);
 assert.equal(r.citations[0].support_check,"not_semantically_verified");
 assert.equal(r.citations[0].block_id,"p0");
});
test("无引用常识、缺引用、错误JSON、空释义保持原有非语义拦截边界",()=>{
 assert.equal(L.parseCandidate("bad",evidence).error,"INVALID_LIGHTWEIGHT_JSON");
 assert.equal(L.parseCandidate('{"meaning":""}',evidence).error,"MISSING_MEANING");
 const r=L.parseCandidate(encode("一般解释",[]),evidence);
 assert.equal(r.error,"");assert.equal(r.meaning,"一般解释");assert.equal(r.corrections.length,0);
});
test("候选提示不再示范固定编号或固定一条引用，不写具体开发案例",()=>{
 assert.doesNotMatch(L.CANDIDATE_PROMPT,/\be1\b|林禾|志愿者|预约|归档服务/);
 assert.match(L.CANDIDATE_PROMPT,/可为空、单项或多项/);
 assert.match(L.CANDIDATE_PROMPT,/不能用提问代替答复/);
 assert.match(L.CANDIDATE_PROMPT,/单段足够只引单段/);
 assert.equal(L.CANDIDATE_PROMPT.split("\n").slice(0,4).join("\n"),L.PROMPT.split("\n").slice(0,4).join("\n"));
});

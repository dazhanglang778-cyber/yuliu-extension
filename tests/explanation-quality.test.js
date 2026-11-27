const test=require('node:test');
const assert=require('node:assert/strict');
const R=require('../contextual-reasoning');
const S=require('../evaluation/contextual-suite');
const cases=require('../evaluation/fixtures/explanation-quality-v1.json').cases;
// Protocol and input checks only: these are NOT live model quality scores.
for(const item of cases) test(item.id+': reference isolated and context preserved',()=>{
  const req=S.prepare(item), evidence=R.evidenceFor(req);
  const messages=R.buildMessages(req,evidence);
  assert.ok(R.occurrenceFor(req,evidence));
  for(const index of item.evidenceBlocks)assert.ok(evidence.some(e=>e.block_id==='p'+index));
  assert.ok(!JSON.stringify(messages).includes(item.reference));
  for(const boundary of item.checks)assert.ok(!messages[1].content.includes(boundary));
});
test('generation explains object, distinguishes application and avoids mandatory columns',()=>{
  const req=S.prepare(cases[0]), evidence=R.evidenceFor(req);
  const prompt=R.buildMessages(req,evidence)[0].content;
  assert.match(prompt,/而不是概括.*整段文章/);
  assert.match(prompt,/方案不等于该方法本身/);
  assert.match(prompt,/不把该用法写成概念唯一适用的范围/);
  assert.match(prompt,/没有额外帮助则省略/);
  assert.match(prompt,/以general标记/);
  assert.doesNotMatch(prompt,/RAG|Memory|Sunfire|阿里巴巴/);
});
test('accurate short and original-wording explanations are not mechanically rejected',()=>{
  const req=S.prepare(cases[3]), evidence=R.evidenceFor(req);
  for(const answer of ['数据库',cases[3].reference,evidence[0].quote]){
    const draft=R.normalizeDraft(JSON.stringify({target_type:'term',statements:[{id:'c1',part:'meaning',basis:'document',text:answer,evidence_ids:[evidence[0].evidence_id]}]}),evidence);
    assert.equal(draft.statements.length,1);assert.equal(draft.errors.length,0);
  }
});

// Direct LegacyReview assertions reproduce V7 only; R/Reasoning.run exercises current production.
const LegacyReview = require('../evaluation/legacy-review-v7.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../contextual-reasoning.js');
const Audit = require('../contextual-audit.js');
const Suite = require('../evaluation/contextual-suite.js');
const clone = (x) => JSON.parse(JSON.stringify(x));

// The source is the existing synthetic development case, not a private meeting.
// Bad audit reproduces the real v5 failure; corrected audits are authored controls,
// never evidence that a live model has learned the new instruction.
function fixture() {
  const item = require('../evaluation/fixtures/contextual-relations-v1.json').cases.find((c) => c.id === 'relation-team-self');
  const request = Suite.prepare(item), evidence = R.evidenceFor(request), e = evidence[0];
  const statement = (id, basis, text) => ({ id, part: 'meaning', basis, text, evidence_ids: [e.evidence_id] });
  const draft = { target_type: 'person', statements: [
    statement('c1', 'document', '发言者 1 提到交付组负责整理客户合同，今天先核对缺页'),
    statement('c2', 'inference', '从发言者 1 自称“我们交付组”看，他可能是该组成员')
  ] };
  const verdict = { review_version: R.REVIEW_VERSION, checks: draft.statements.map((s) => ({ id: s.id, selection_fit: 'current', supported: true, basis: s.basis,
    usefulness: 'useful', evidence_ids: [e.evidence_id], citations: [{ evidence_id: e.evidence_id, quote: e.quote }],
    reason: s.id === 'c1' ? '这项保留交付组整理合同的工作，不是发言者个人职责。' : '自称我们支持有限的成员推断。',
    relation_audit: {
      source: { subject: '我们交付组', scope: 'collective', qualifiers: [], subject_evidence_ids: [e.evidence_id] },
      claim: { subject: s.id === 'c1' ? '交付组' : '发言者 1', scope: s.id === 'c1' ? 'collective' : 'individual', qualifiers: [] },
      subject_link: s.id === 'c1' ? 'resolved' : 'inferred',
      preserves: { conditions: true, time: true, attribution: true }
    } })), coverage: { status: 'adequate', missing: [] } };
  return { request, evidence, draft, verdict };
}

test('保留真实错误形态：模型把工作主张核验成成员关系时，程序仍不能独立纠正语义', () => {
  const f = fixture();
  f.verdict.checks[0].relation_audit = clone(f.verdict.checks[1].relation_audit);
  f.verdict.checks[0].reason = '发言者直接提及我们交付组，推断其可能为组成员。';
  const result = LegacyReview.accept(f.draft, f.verdict, f.evidence);
  assert.equal(result.rejected[0].id, 'c1');
  assert.equal(result.rejected[0].code, 'RELATION_INFERENCE_AS_FACT');
  assert.deepEqual(result.accepted.map((c) => c.id), ['c2']);
});

test('动作层次正确对齐时，转述团队工作与有限成员推断都能显示', async () => {
  const f = fixture(), replies = [f.draft, f.verdict]; let calls = 0;
  const out = await R.run(f.request, async () => {
    assert.ok(calls < 2); return JSON.stringify(replies[calls++]);
  });
  assert.equal(calls, 2); assert.equal(out.trace.error, '');
  assert.match(out.result.meaning_here.text, /整理客户合同/);
  assert.match(out.result.meaning_here.text, /可能是该组成员/);
  assert.deepEqual(out.result.claims.map((c) => c.basis), ['document', 'inference']);
});

test('核验项重排不串用：按id绑定，不能把相邻成员关系套到工作主张', () => {
  const f = fixture(); f.verdict.checks.reverse();
  assert.deepEqual(LegacyReview.accept(f.draft, f.verdict, f.evidence).accepted.map((c) => c.id), ['c1', 'c2']);
});

test('把团队工作改成个人负责仍拒绝，不用去掉限制掩盖核验错配', () => {
  const f = fixture();
  f.draft.statements[0].text = '发言者 1 负责整理合同。';
  f.verdict.checks[0].relation_audit.claim = { subject: '发言者 1', scope: 'individual', qualifiers: [] };
  f.verdict.checks[0].relation_audit.subject_link = 'explicit';
  const result = LegacyReview.accept(f.draft, f.verdict, f.evidence);
  assert.equal(result.rejected[0].code, 'RELATION_SCOPE_NARROWED');
});

test('非人物对照：网关调用索引服务，不等于网关自己维护索引', () => {
  const f = fixture(), e = f.evidence[0], c = f.verdict.checks[0];
  e.quote = '网关调用索引服务；索引服务负责维护检索索引。';
  f.draft.target_type = 'entity'; f.draft.statements = [f.draft.statements[0]];
  f.draft.statements[0].text = '网关调用负责维护检索索引的索引服务。';
  f.verdict.checks = [c]; c.citations[0].quote = e.quote;
  c.relation_audit.source = { subject: '网关', scope: 'non_person', qualifiers: [], subject_evidence_ids: [e.evidence_id] };
  c.relation_audit.claim = { subject: '网关', scope: 'non_person', qualifiers: [] };
  c.relation_audit.subject_link = 'explicit';
  assert.equal(LegacyReview.accept(f.draft, f.verdict, f.evidence).accepted.length, 1);
  f.draft.statements[0].text = '网关自己维护索引。';
  c.supported = false; c.reason = '维护者是索引服务，不是调用它的网关。';
  assert.equal(LegacyReview.accept(f.draft, f.verdict, f.evidence).accepted.length, 0);
});

test('转述计划不变成上线事实：动作对齐不取消时间状态约束', () => {
  const f = fixture(), e = f.evidence[0], c = f.verdict.checks[0];
  e.quote = '项目周报提到，索引服务计划下月上线。';
  f.draft.target_type = 'entity'; f.draft.statements = [f.draft.statements[0]];
  f.draft.statements[0].text = '周报中的索引服务已经上线。';
  f.verdict.checks = [c]; c.citations[0].quote = e.quote;
  c.relation_audit.source = { subject: '索引服务', scope: 'non_person', qualifiers: ['planned'], subject_evidence_ids: [e.evidence_id] };
  c.relation_audit.claim = { subject: '索引服务', scope: 'non_person', qualifiers: [] };
  c.relation_audit.subject_link = 'explicit';
  assert.equal(LegacyReview.accept(f.draft, f.verdict, f.evidence).rejected[0].code, 'RELATION_QUALIFIER_CHANGED');
});

test('核验提示指定当前动作层次，使用精简审阅协议，也不携带人工期望', () => {
  const f = fixture(), messages = R.verificationMessages(f.request, f.draft, f.evidence);
  assert.match(messages[0].content, /先对齐动作再比较主体/);
  assert.match(messages[0].content, /不将相邻项的判断套用/);
  assert.match(messages[0].content, /每项reason一句短话/);
  assert.doesNotMatch(messages[0].content, /根据实际原文判断支持或不支持的原因/);
  const schema = JSON.parse(messages[0].content.split('\n').at(-1));
  assert.deepEqual(Object.keys(schema.checks[0]).sort(), ['basis','citations','id','reason','replacement','selection_fit','supported']);
  const input = JSON.parse(messages[1].content);
  assert.deepEqual(input.required_check_ids, ['c1', 'c2']);
  assert.equal(input.expected, undefined);
});

for (const reason of ['', '根据实际原文判断支持或不支持的原因']) {
  test('空泛核验理由只提醒、不自动拦截：' + (reason || '空理由'), () => {
    const f = fixture(); f.verdict.checks[0].reason = reason;
    const accepted = LegacyReview.accept(f.draft, f.verdict, f.evidence);
    assert.equal(accepted.accepted.length, 2);
    const review = Audit.review({ generation: f.draft, verification: f.verdict,
      history: [{ stage: 'verification', parsed: f.verdict }], evidence: f.evidence });
    assert.ok(review.warnings.some((w) => w.code === 'UNINFORMATIVE_REVIEW_REASON'));
  });
}

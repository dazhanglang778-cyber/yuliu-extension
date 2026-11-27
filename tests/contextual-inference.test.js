// Direct LegacyReview assertions reproduce V7 only; R/Reasoning.run exercises current production.
const LegacyReview = require('../evaluation/legacy-review-v7.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../contextual-reasoning.js');
const Suite = require('../evaluation/contextual-suite.js');
const clone = (v) => JSON.parse(JSON.stringify(v));

// Scripted controls test delivery and rejection logic, not real-model understanding.
function fixture(mentioned = false) {
  const subject = mentioned ? '那个巡检小组' : '我们巡检小组';
  const req = Suite.prepare({ id: 'inference-control', title: '工作讨论', selection: '发言者 1', anchor: 0,
    blocks: ['发言者 1 00:10 ' + subject + '检查设备。'] });
  const e = R.evidenceFor(req)[0];
  const statement = (id, basis, text) => ({ id, part: 'meaning', basis, text,
    evidence_ids: basis === 'unknown' ? [] : [e.evidence_id] });
  const draft = { target_type: 'person', statements: mentioned ? [
    statement('s1', 'document', '他在讨论巡检小组检查设备的工作。'),
    statement('s2', 'unknown', '仅凭这段发言无法确定他的所属方。')
  ] : [
    statement('s1', 'inference', '从自称看，他可能以巡检小组一方发言。'),
    statement('s2', 'document', '该组在检查设备。'),
    statement('s3', 'unknown', '他的个人职位与分工未明确。')
  ] };
  const verdict = { review_version: R.REVIEW_VERSION, checks: draft.statements.map((s) => ({ ...s, selection_fit: 'current', supported: true,
    usefulness: s.basis === 'unknown' ? 'unknown' : 'useful',
    citations: s.basis === 'unknown' ? [] : [{ evidence_id: e.evidence_id, quote: e.quote }],
    reason: '人工编写的逻辑控制，不代表模型结论',
    relation_audit: s.basis === 'unknown' ? null : {
      source: { subject, scope: 'collective', qualifiers: [], subject_evidence_ids: [e.evidence_id] },
      claim: { subject: s.basis === 'inference' ? '发言者 1' : subject,
        scope: s.basis === 'inference' ? 'individual' : 'collective', qualifiers: s.basis === 'inference' ? ['possible'] : [] },
      subject_link: s.basis === 'inference' ? 'inferred' : 'explicit',
      preserves: { conditions: true, time: true, attribution: true }
    } })), coverage: { status: 'adequate', missing: [] } };
  return { req, e, draft, verdict };
}
async function play(f, responses) {
  const received = [];
  const outcome = await R.run(f.req, async (options) => {
    received.push(clone(options));
    const next = responses[received.length - 1];
    assert.notEqual(next, undefined, 'no calls beyond bounded script');
    if (next instanceof Error) throw next;
    return { model: 'scripted-inference-control', content: JSON.stringify(next) };
  });
  return { outcome, received };
}
function check(f) { return LegacyReview.accept(f.draft, f.verdict, [f.e]); }

test('有限归属、团队事实和未知边界可一起交付，不要求完整实名身份', async () => {
  const f = fixture(), { outcome: o } = await play(f, [f.draft, f.verdict]);
  assert.equal(o.trace.model_calls, 2);
  assert.equal(o.trace.error, '');
  assert.match(o.result.meaning_here.text, /可能以巡检小组一方发言/);
  assert.match(o.result.meaning_here.text, /该组在检查设备/);
  assert.match(o.result.meaning_here.text, /职位与分工未明确/);
  // Unknown boundary is rendered, but is not a factual evidence-backed claim.
  assert.equal(o.result.claims.length, 2);
});

test('仅提到另一团队：交付讨论事项与未知边界，不制造所属关系', async () => {
  const f = fixture(true), { outcome: o } = await play(f, [f.draft, f.verdict]);
  assert.equal(o.trace.model_calls, 2);
  assert.match(o.result.meaning_here.text, /讨论巡检小组检查设备/);
  assert.match(o.result.meaning_here.text, /无法确定他的所属方/);
  assert.ok(!o.result.claims.some((s) => s.basis === 'inference'));
});

test('实测失败形态：双方标document但关系为inferred，仍拦截该项并保留团队事实', () => {
  const f = fixture();
  f.draft.statements[0].basis = f.verdict.checks[0].basis = 'document';
  const r = check(f);
  assert.equal(r.rejected[0].code, 'RELATION_INFERENCE_AS_FACT');
  assert.deepEqual(r.accepted.map((s) => s.id), ['s2', 's3']);
  assert.equal(r.repair_required, true);
});

test('核验直接修正有限归属措辞，不重新生成整份答案', async () => {
  const f = fixture(), badDraft = clone(f.draft), corrected = clone(f.verdict);
  badDraft.statements[0].basis = 'document';
  badDraft.statements[0].text = '他是巡检组负责人。';
  corrected.checks[0].replacement = f.draft.statements[0].text;
  const { outcome: o } = await play(f, [badDraft, corrected]);
  assert.equal(o.trace.model_calls, 2);
  assert.equal(o.trace.error, '');
  assert.equal(o.result.claims[0].basis, 'inference');
  assert.match(o.result.meaning_here.text, /可能以/);
  assert.doesNotMatch(o.result.meaning_here.text, /负责人/);
});

test('只改生成标签不够：核验仍将推断升级document时保持拒绝', () => {
  const f = fixture(); f.verdict.checks[0].basis = 'document';
  assert.equal(check(f).rejected[0].code, 'RELATION_INFERENCE_AS_FACT');
});

test('只改核验标签不够：草稿仍将推断写作document时保持拒绝', () => {
  const f = fixture(); f.draft.statements[0].basis = 'document';
  assert.equal(check(f).rejected[0].code, 'RELATION_INFERENCE_AS_FACT');
});

test('增加可能不能洗白负责人猜测：核验不支持时不会被标签强行放行', () => {
  const f = fixture(); f.draft.statements[0].text = '他可能是巡检组负责人。';
  f.verdict.checks[0].supported = false;
  f.verdict.checks[0].reason = '自称我们不支持负责人身份';
  assert.equal(check(f).accepted.some((s) => s.id === 's1'), false);
});

test('有推断标签却没有实际支持引用，仍然拒绝', () => {
  const f = fixture(); f.verdict.checks[0].citations = [];
  assert.equal(check(f).rejected[0].code, 'INVALID_SUPPORT_CITATION');
});

test('核验缺项后服务失败保留已审阅团队工作，不放行未核验身份', async () => {
  const f = fixture();
  f.verdict.checks = f.verdict.checks.filter((c) => c.id !== 's1');
  const { outcome: o } = await play(f, [f.draft, f.verdict, new Error('SYNTHETIC_SERVICE_FAILURE')]);
  assert.match(o.result.meaning_here.text, /该组在检查设备/);
  assert.doesNotMatch(o.result.meaning_here.text, /可能以/);
  assert.equal(o.trace.repair_error, 'SYNTHETIC_SERVICE_FAILURE');
});

test('推断链不限定人物模板：项目关系也可基于有限推断交付', () => {
  const f = fixture();
  f.draft.target_type = 'entity'; f.draft.statements = [f.draft.statements[0]];
  f.verdict.checks = [f.verdict.checks[0]];
  f.e.quote = '乙项目沿用甲项目的接口，并保留兼容层。';
  f.draft.statements[0].text = '乙项目看来与甲项目存在技术承接关系。';
  const c = f.verdict.checks[0];
  c.citations[0].quote = f.e.quote;
  c.relation_audit.source.subject = '乙项目'; c.relation_audit.source.scope = 'non_person';
  c.relation_audit.claim.subject = '乙项目'; c.relation_audit.claim.scope = 'non_person';
  assert.equal(check(f).accepted.length, 1);
});

test('核验示例随当前推断分类展示，仍提示示例不是判断结论', () => {
  const f = fixture(), messages = R.verificationMessages(f.req, f.draft, [f.e]);
  const example = JSON.parse(messages[0].content.split('\n').at(-1));
  assert.equal(example.checks[0].basis, 'inference');
  assert.equal(example.checks[0].selection_fit, 'current');
  assert.equal(example.checks[0].relation_audit, undefined);
  assert.match(messages[0].content, /不是结论/);
  assert.match(R.buildMessages(f.req, [f.e])[0].content, /不是本次事实/);
});

test('两例入口沿用原始对照数据，存储与四例隔离，资源完整', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'contextual-inference-smoke.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href|data-dataset)="([^"]+\.(?:js|css|json|html))"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
  assert.match(html, /data-subset-name="inference-smoke"/);
  assert.match(html, /data-storage="yuliuContextualInferenceSmokeV1"/);
  const ids = html.match(/data-cases="([^"]+)"/)[1].split(',');
  assert.deepEqual(ids, ['relation-team-self', 'relation-team-mentioned']);
  const ds = require('../evaluation/fixtures/contextual-relations-v1.json');
  for (const id of ids) assert.ok(ds.cases.some((c) => c.id === id));
});

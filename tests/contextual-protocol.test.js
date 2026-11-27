const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../contextual-reasoning.js');
const Suite = require('../evaluation/contextual-suite.js');
const Audit = require('../contextual-audit.js');
const clone = (v) => JSON.parse(JSON.stringify(v));

// Scripted protocol controls, not live-model semantic evaluation.
function fixture() {
  const req = Suite.prepare({ id: 'protocol-control', title: '操作说明', selection: '导出', anchor: 0,
    blocks: ['访客账户可以导出，但只能导出公开字段。'] });
  const e = R.evidenceFor(req)[0];
  const draft = { target_type: 'term', statements: [{ id: 's1', part: 'meaning', basis: 'document',
    text: '访客账户可以导出公开字段。', evidence_ids: [e.evidence_id] }] };
  const verdict = { review_version: R.REVIEW_VERSION, checks: [{
    id: 's1', supported: true, selection_fit: 'current', basis: 'document', replacement: null,
    citations: [{ evidence_id: e.evidence_id, quote: e.quote }], reason: '保留公开字段范围。'
  }] };
  return { req, e, draft, verdict };
}
async function play(f, responses) {
  const received = [];
  const outcome = await R.run(f.req, async (o) => {
    received.push(clone(o));
    const next = responses[received.length - 1];
    if (next instanceof Error) throw next;
    assert.notEqual(next, undefined, 'must not call beyond scripted budget');
    return { model: 'scripted-protocol-control', content: typeof next === 'string' ? next : JSON.stringify(next) };
  });
  return { outcome, received };
}

test('精简核验只返回当前用法、判断、修正文与引用，不再填写关系表', () => {
  const f = fixture();
  f.draft.statements.push({ ...f.draft.statements[0], id: 's3' });
  const messages = R.verificationMessages(f.req, f.draft, [f.e]);
  const example = JSON.parse(messages[0].content.split('\n').at(-1));
  assert.equal(example.review_version, R.REVIEW_VERSION);
  assert.equal(example.checks[0].relation_audit, undefined);
  assert.equal(example.checks[0].selection_fit, 'current');
  assert.equal(example.checks[0].id, 's1');
  assert.deepEqual(JSON.parse(messages[1].content).required_check_ids, ['s1', 's3']);
  assert.doesNotMatch(JSON.stringify(example), /document\|inference|individual\|collective/);
});

test('生成示例使用单个合法枚举；仍允许常识与未知', () => {
  const f = fixture(), prompt = R.buildMessages(f.req, [f.e])[0].content;
  const schema = JSON.parse(prompt.split('只输出JSON：\n')[1].split('\n')[0]);
  assert.equal(schema.target_type, 'term');
  assert.equal(schema.statements[0].basis, 'document');
  assert.match(prompt, /general解释适合领域的常见含义/);
});

for (const kind of ['wrong-version', 'missing-fit', 'outside-json', 'two-json', 'wrong-id', 'duplicate-id', 'broken-json', 'invalid-field']) {
  test(kind + '最多重做一次核验，不重写答案', async () => {
    const f = fixture(), bad = clone(f.verdict);
    let raw = bad;
    if (kind === 'wrong-version') delete bad.review_version;
    if (kind === 'missing-fit') delete bad.checks[0].selection_fit;
    if (kind === 'outside-json') raw = JSON.stringify(bad) + ', "x": {}';
    if (kind === 'two-json') raw = JSON.stringify(bad) + '\n{}';
    if (kind === 'wrong-id') bad.checks[0].id = 'c1';
    if (kind === 'duplicate-id') bad.checks.push(clone(bad.checks[0]));
    if (kind === 'broken-json') raw = 'not json';
    if (kind === 'invalid-field') bad.checks[0].supported = 'true';
    if (kind === 'fabricated-quote') bad.checks[0].citations[0].quote = '原文没有这句话';
    const { outcome: o, received } = await play(f, [f.draft, raw, f.verdict]);
    assert.equal(o.trace.model_calls, 3);
    assert.deepEqual(o.trace.history.map((h) => h.stage), ['generation', 'verification', 'verification']);
    assert.equal(o.trace.history[2].repair_kind, 'verification_protocol');
    assert.deepEqual(JSON.parse(received[1].messages[1].content).draft, JSON.parse(received[2].messages[1].content).draft);
    assert.equal(o.trace.error, '');
    assert.equal(o.result.meaning_here.text, f.draft.statements[0].text);
    assert.equal(o.result.page_evidence.length, 1);
  });
}

test('两次格式错误有界停止，失败不是原文不足，也不泄漏未核验草稿', async () => {
  const f = fixture(), bad = clone(f.verdict); bad.checks[0].id = 'obsolete';
  const { outcome: o } = await play(f, [f.draft, bad, bad]);
  assert.equal(o.trace.error, 'VERIFICATION_FORMAT_ERROR');
  assert.equal(o.trace.failure_category, 'protocol');
  assert.equal(o.result.claims.length, 0);
  assert.match(Audit.review(o.trace, o.result).claims[0].status, /不等于内容错误/);
});

test('语义否决不会触发整份重生成；记录否决而不直接放行', async () => {
  const f = fixture(); f.verdict.checks[0].supported = false;
  f.verdict.checks[0].reason = '这条草稿改变了适用条件。';
  const { outcome: o } = await play(f, [f.draft, f.verdict]);
  assert.equal(o.trace.model_calls, 2);
  assert.equal(o.trace.error, 'NO_SUPPORTED_CURRENT_MEANING');
  assert.equal(o.result.claims.length, 0);
});

test('核验服务失败时不伪称通过，也不调用第三个生成器填补', async () => {
  const f = fixture();
  const { outcome: o } = await play(f, [f.draft, new Error('SYNTHETIC_REVIEW_UNAVAILABLE')]);
  assert.equal(o.trace.model_calls, 2);
  assert.equal(o.result.claims.length, 0);
  assert.equal(o.trace.error, 'SYNTHETIC_REVIEW_UNAVAILABLE');
});

test('核验缺项后重试失败保留已审阅部分，未知项不被当作已核验', async () => {
  const f = fixture();
  f.draft.statements.push({ ...f.draft.statements[0], id: 's2', text: '这项未核验。' });
  const { outcome: o } = await play(f, [f.draft, f.verdict, new Error('SYNTHETIC_REVIEW_UNAVAILABLE')]);
  assert.equal(o.result.meaning_here.text, f.draft.statements[0].text);
  assert.equal(o.trace.repair_error, 'SYNTHETIC_REVIEW_UNAVAILABLE');
  assert.equal(o.trace.selected_attempt, 1);
});

test('格式修复之后仍须判断当前用法，不因格式合法自动放行', async () => {
  const f = fixture(), bad = clone(f.verdict); delete bad.review_version;
  f.verdict.checks[0].selection_fit = 'other';
  const { outcome: o } = await play(f, [f.draft, bad, f.verdict]);
  assert.equal(o.trace.model_calls, 3);
  assert.equal(o.result.claims.length, 0);
  assert.equal(o.trace.rejected[0].code, 'SELECTION_MEANING_MISMATCH');
});

test('生成格式失败与核验格式失败共享最多三次流程调用预算', async () => {
  const f = fixture();
  const { outcome: o } = await play(f, ['not-json', f.draft, 'not-json']);
  assert.equal(o.trace.model_calls, 3);
  assert.equal(o.result.claims.length, 0);
});

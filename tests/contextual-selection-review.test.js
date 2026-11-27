const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../contextual-reasoning.js');
const S = require('../evaluation/contextual-suite.js');
const A = require('../contextual-audit.js');
const Contract = require('../grounding-contract-v2.js');
const ds = require('../evaluation/fixtures/contextual-transfer-v1.json');
const clone = (v) => JSON.parse(JSON.stringify(v));
function fixture(id) {
  const item = ds.cases.find((c) => c.id === id);
  assert.ok(item, id);
  const req = S.prepare(item), evidence = R.evidenceFor(req);
  return { req, evidence, ref: (n) => evidence.find((e) => e.block_id === 'p' + n) };
}
function statement(id, text, e, basis = 'document') {
  return { id, text, part: 'meaning', basis, evidence_ids: e ? [e.evidence_id] : [] };
}
function review(s, sources = [], extra = {}) {
  return { id: s.id, supported: true, selection_fit: 'current', basis: s.basis, replacement: null,
    citations: sources.map((e) => ({ evidence_id: e.evidence_id, quote: e.quote })), reason: '人工预设的审阅结果，仅检验程序行为', ...extra };
}
async function run(f, statements, checks, target_type = 'term') {
  const replies = [{ target_type, statements }, { review_version: R.REVIEW_VERSION, checks }];
  let calls = 0;
  const outcome = await R.run(f.req, async () => {
    assert.ok(calls < replies.length);
    return JSON.stringify(replies[calls++]);
  });
  assert.equal(calls, 2);
  assert.equal(Contract.validate(outcome.result).ok, true);
  return outcome;
}
test('同词两处输入同时保留，但两个阶段都明确标记实际选中出现位置', () => {
  for (const [id, anchor, text] of [['transfer-window-time', 'p0', '为周一'],
    ['transfer-window-ui', 'p1', '，其中显示']]) {
    const f = fixture(id), draft = { statements: [statement('c1', '待检查', f.ref(0))] };
    const inputs = [R.buildMessages(f.req, f.evidence), R.verificationMessages(f.req, draft, f.evidence)];
    for (const m of inputs) {
      const input = JSON.parse(m[1].content);
      assert.equal(input.selected_occurrence.block_id, anchor);
      assert.equal(input.selected_occurrence.selected, '窗口');
      assert.match(input.selected_occurrence.after, new RegExp(text));
      assert.ok(input.evidence.some((e) => e.block_id === 'p0'));
      assert.ok(input.evidence.some((e) => e.block_id === 'p1'));
      assert.equal(input.expected, undefined);
    }
  }
});
test('复现真实误删：没有逐字出现“系统”不删除正确解释，另一处词义不冒充当前义项', async () => {
  const f = fixture('transfer-window-ui');
  const ui = statement('c1', '用户提交申请后弹出的确认界面，显示编号和撤回按钮。', f.ref(1));
  const time = statement('c2', '周一九点至周三十八点的预约时段。', f.ref(0));
  const good = review(ui, [f.ref(1)]);
  // Extra legacy fields deliberately contain the v7 literal-subject failure.
  good.relation_audit = { source: { subject: '系统' } };
  assert.ok(!f.ref(1).quote.includes('系统'));
  const o = await run(f, [ui, time], [good, review(time, [f.ref(0)], { selection_fit: 'other' })]);
  assert.equal(o.result.meaning_here.text, ui.text);
  assert.equal(o.trace.rejected[0].code, 'SELECTION_MEANING_MISMATCH');
  assert.equal(o.result.page_evidence[0].block_id, 'p1');
});
test('预约时间选区可在一次核验里修正为时段，不生成第二份草稿', async () => {
  const f = fixture('transfer-window-time'), s = statement('c1', '预约操作界面。', f.ref(1));
  const corrected = '这里指允许提交预约申请的时间范围：周一九点至周三十八点。';
  const o = await run(f, [s], [review(s, [f.ref(0)], { replacement: corrected })]);
  assert.equal(o.result.meaning_here.text, corrected);
  assert.equal(o.trace.generation.statements[0].text, s.text);
  assert.equal(o.trace.review_mode, 'review_and_revision');
  const diagnostic = A.review(o.trace, o.result);
  assert.equal(diagnostic.claims[0].final_text, corrected);
  assert.ok(diagnostic.claims[0].revised);
  assert.match(A.markdown([diagnostic]), /修正后/);
});
test('远处特殊约定仍可作为唯一依据，不强制给当前位置凑引用', async () => {
  const f = fixture('transfer-local-metaphor'), s = statement('c1', '撤展后剩余的归还与结算工作。', f.ref(0));
  const o = await run(f, [s], [review(s, [f.ref(0)])]);
  assert.equal(o.result.page_evidence.length, 1);
  assert.equal(o.result.page_evidence[0].block_id, 'p0');
});
test('核验可补入初稿漏掉的提问，短答的对象与条件得到联合引用', async () => {
  const f = fixture('transfer-condition');
  const s = statement('c1', '归档服务和查询服务可分别部署，但仍须使用同一个权限目录。', f.ref(1));
  const o = await run(f, [s], [review(s, [f.ref(0), f.ref(1)])], 'reference');
  assert.deepEqual(o.result.page_evidence.map((e) => e.block_id), ['p0', 'p1']);
});
test('动作方向可直接修正：被联系方不自动成为联系执行方', async () => {
  const f = fixture('transfer-person-roster'), s = statement('c1', '林禾负责在有人缺席时进行联系。', f.ref(1));
  const o = await run(f, [s], [review(s, [f.ref(0), f.ref(1)], {
    replacement: '林禾是活动的志愿者协调员；有人临时缺席时，应联系他。'
  })], 'person');
  assert.match(o.result.meaning_here.text, /应联系他/);
  assert.doesNotMatch(o.result.meaning_here.text, /负责.*联系/);
});
test('来源不足时可在审阅中降低具体程度，未知边界不是服务失败', async () => {
  const f = fixture('transfer-unknown-code'), s = statement('c1', 'QX是一个项目。', f.ref(0));
  const o = await run(f, [s], [review(s, [], { basis: 'unknown',
    replacement: 'QX是便签中的待确认标记，具体所指未说明。' })], 'entity');
  assert.equal(o.trace.error, '');
  assert.equal(o.result.contextual_details.failure, null);
  assert.match(o.result.meaning_here.text, /具体所指未说明/);
  assert.equal(o.result.page_evidence.length, 0);
});
test('来源标签改变而正文未修正，不能把断言仅靠标签洗成推断或未知', () => {
  const f = fixture('transfer-unknown-code'), s = statement('c1', 'QX是新项目。', f.ref(0));
  for (const basis of ['inference', 'unknown']) {
    const r = R.acceptReview({ target_type: 'entity', statements: [s] },
      { review_version: R.REVIEW_VERSION, checks: [review(s, basis === 'inference' ? [f.ref(0)] : [], { basis })] }, f.evidence);
    assert.equal(r.accepted.length, 0);
    assert.ok(r.format_errors.length);
  }
});
test('有依据推断与常识仍可展示；常识不伪装原文证据', async () => {
  const f = fixture('transfer-api'), s = statement('c1', 'API通常译为应用程序编程接口。', null, 'general');
  const o = await run(f, [s], [review(s)]);
  assert.equal(o.result.page_evidence.length, 0);
  assert.equal(o.result.claims[0].supports[0].source_kind, 'model_knowledge');
});
for (const [label, change] of [
  ['虚构引文', c => c.citations[0].quote = '不存在的原句'],
  ['未知来源', c => c.citations[0].evidence_id = 'nonexistent'],
  ['错误偏移', c => c.citations[0].quote_start = 9],
  ['缺失引用', c => c.citations = []],
]) test(label + '仍被硬校验发现', () => {
  const f = fixture('transfer-api'), s = statement('c1', '用于获取天气数据的接口。', f.ref(1)), c = review(s, [f.ref(1)]);
  change(c);
  const r = R.acceptReview({ target_type: 'term', statements: [s] },
    { review_version: R.REVIEW_VERSION, checks: [c] }, f.evidence);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0].code, 'INVALID_SUPPORT_CITATION');
});
test('合法引用并不足以证明当前词义：明确other即使supported=true也不展示', () => {
  const f = fixture('transfer-window-ui'), s = statement('c1', '预约时段。', f.ref(0));
  const c = review(s, [f.ref(0)], { selection_fit: 'other' });
  assert.equal(R.acceptReview({ statements: [s] }, { review_version: R.REVIEW_VERSION, checks: [c] }, f.evidence).accepted.length, 0);
});
test('重复短句必须保留精确偏移，而非首处匹配', () => {
  const e = { evidence_id: 'e', quote: '可以。可以。' };
  const s = statement('c1', '此处允许。', e), c = review(s, [e]);
  c.citations[0].quote = '可以。';
  const accept = () => R.acceptReview({ statements: [s] }, { review_version: R.REVIEW_VERSION, checks: [c] }, [e]);
  assert.equal(accept().accepted.length, 0);
  c.citations[0].quote_start = 3;
  assert.equal(accept().accepted[0].citations[0].start, 3);
});
test('审阅再次完整否决时不能恢复旧的局部通过结果', async () => {
  const f = fixture('transfer-api'), s = statement('c1', '待核对解释。', f.ref(1));
  const draft = { target_type: 'term', statements: [s, { ...s, id: 'c2' }] };
  const first = { review_version: R.REVIEW_VERSION, checks: [review(s, [f.ref(1)])] };
  const last = { review_version: R.REVIEW_VERSION, checks: draft.statements.map((c) => review(c, [], { supported: false })) };
  const replies = [draft, first, last]; let calls = 0;
  const o = await R.run(f.req, async () => JSON.stringify(replies[calls++]));
  assert.equal(calls, 3);
  assert.equal(o.result.claims.length, 0);
  assert.equal(o.trace.selected_attempt, 2);
});
test('失效的当前选区不调用模型，不能靠另一段同名词继续生成', async () => {
  const f = fixture('transfer-window-ui');
  f.req.documentContext.selection.start_offset = 999;
  let calls = 0;
  const o = await R.run(f.req, async () => { calls++; return ''; });
  assert.equal(calls, 0);
  assert.equal(o.trace.error, 'NO_VALID_EVIDENCE');
});
test('诊断分阶段计时与全部调用耗时一致，不能把模拟速度当真实模型性能', async () => {
  const f = fixture('transfer-api'), s = statement('c1', '获取天气数据的接口。', f.ref(1));
  const o = await run(f, [s], [review(s, [f.ref(1)])]);
  const total = o.trace.history.reduce((n, h) => n + h.elapsed_ms, 0);
  assert.equal(o.trace.stage_elapsed_ms.generation + o.trace.stage_elapsed_ms.verification, total);
  assert.equal(o.trace.history[1].max_output, 2100);
});
// This explicit limitation is important: schema validation is NOT an independent
// semantic oracle. Live-model paired tests must catch this kind of false approval.
test('能力边界：若审阅模型把错误义项也误判current，程序不能独立证伪语义', () => {
  const f = fixture('transfer-window-ui'), s = statement('c1', '预约时间段。', f.ref(0));
  const r = R.acceptReview({ target_type: 'term', statements: [s] },
    { review_version: R.REVIEW_VERSION, checks: [review(s, [f.ref(0)])] }, f.evidence);
  assert.equal(r.accepted.length, 1, '机械通过不能称为语义正确，需真实模型评测');
});

test('后续部分审阅已明确否决首轮答案时，不因其他字段缺失恢复被否决内容', async () => {
  const f = fixture('transfer-api'), s = statement('c1', '待核对解释。', f.ref(1));
  const draft = { target_type: 'term', statements: [s, { ...s, id: 'c2' }] };
  const replies = [draft,
    { review_version: R.REVIEW_VERSION, checks: [review(s, [f.ref(1)])] },
    { review_version: R.REVIEW_VERSION, checks: [review(s, [], { supported: false })] }];
  let calls = 0;
  const o = await R.run(f.req, async () => JSON.stringify(replies[calls++]));
  assert.equal(calls, 3);
  assert.equal(o.result.claims.length, 0);
  assert.equal(o.trace.selected_attempt, 2);
});
test('旧输入无偏移但只有唯一词时可以定位，多次出现则不能猜第一处', () => {
  const f = fixture('transfer-api');
  delete f.req.documentContext.selection.start_offset;
  const e = R.evidenceFor(f.req), occurrence = R.occurrenceFor(f.req, e);
  assert.equal(occurrence.selected, 'API');
  assert.equal(occurrence.block_id, f.req.documentContext.selection.anchor_block_id);
});
test('四例小测独立存储且资源完整，正式运行不加载历史字段拦截', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'contextual-selection-review-smoke.html'), 'utf8');
  const ids = html.match(/data-cases="([^"]+)"/)[1].split(',');
  assert.equal(ids.length, 4);
  for (const id of ids) assert.ok(ds.cases.some((c) => c.id === id));
  assert.match(html, /data-storage="yuliuSelectionReviewSmokeV8"/);
  assert.match(html, /不是独立盲测/);
  for (const match of html.matchAll(/(?:src|href|data-dataset)="([^"]+\.(?:js|css|html|json))"/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])));
  }
  for (const file of ['background.js', 'contextual-reasoning.js', 'content.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /legacy-review-v7/);
  }
});

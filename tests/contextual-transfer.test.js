const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../contextual-reasoning');
const S = require('../evaluation/contextual-suite');
const dataset = require('../evaluation/fixtures/contextual-transfer-v1.json');

// These test prompt structure, retrieval inputs, and fixtures, NOT live LLM quality.
for (const item of dataset.cases) {
  test(item.id + '：真实选区与相关段落进入输入，人工期望不泄漏', () => {
    const req = S.prepare({ ...item, expected: 'HIDDEN_EXPECTATION', reference: ['HIDDEN_REFERENCE'], kind: 'HIDDEN_KIND' });
    const evidence = R.evidenceFor(req), anchor = req.documentContext.selection;
    assert.equal(item.blocks[item.anchor].slice(anchor.start_offset, anchor.start_offset + item.selection.length), item.selection);
    assert.equal(evidence[0].block_id, 'p' + item.anchor);
    for (const index of item.evidenceBlocks) assert.ok(evidence.some((e) => e.block_id === 'p' + index), 'missing related source p' + index);
    const draft = { target_type: 'term', statements: [{ id: 'c1', part: 'meaning', basis: 'document', text: '测试主张', evidence_ids: [evidence[0].evidence_id] }] };
    const messages = JSON.stringify([R.buildMessages(req, evidence), R.verificationMessages(req, draft, evidence)]);
    assert.doesNotMatch(messages, /HIDDEN_EXPECTATION|HIDDEN_REFERENCE|HIDDEN_KIND/);
    const system = R.buildMessages(req, evidence)[0].content;
    assert.ok(!system.includes(item.expected));
    assert.equal(item.split, 'development');
  });
}

test('生成保留通用原则，审阅精简但不退回特定人物模板', () => {
  const req = S.prepare(dataset.cases[0]), evidence = R.evidenceFor(req);
  const draft = { statements: [{ id: 'c1', basis: 'document' }] };
  const generation = R.buildMessages(req, evidence)[0].content;
  const review = R.verificationMessages(req, draft, evidence)[0].content;
  assert.equal(generation.split('【通用原则】').length - 1, 1);
  assert.match(generation, /名册、表格、明确介绍/);
  assert.match(generation, /一项未知不抹掉其他已知信息/);
  assert.match(review, /整体与部分/);
  assert.match(review, /未知部分说明边界/);
  assert.match(review, /直接.*修正/);
  for (const prompt of [generation, review]) assert.doesNotMatch(prompt, /我们研究院|我们巡检小组|我是该组成员|我们交付组/);
});

test('同词异处使用同一份原文但不同锚点，而不是给模型暗示不同期望', () => {
  const a = dataset.cases.find((c) => c.id === 'transfer-window-time');
  const b = dataset.cases.find((c) => c.id === 'transfer-window-ui');
  assert.deepEqual(a.blocks, b.blocks); assert.equal(a.selection, b.selection);
  assert.equal(a.title, b.title); assert.notEqual(a.anchor, b.anchor);
  assert.notEqual(R.evidenceFor(S.prepare(a))[0].quote, R.evidenceFor(S.prepare(b))[0].quote);
});

test('跨场景入口资源完整且报告独立，保留历史会议对照入口', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'contextual-transfer-evaluation.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href|data-dataset)="([^"]+\.(?:js|css|json|html))"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
  assert.equal(dataset.cases.length, 8); assert.equal(new Set(dataset.cases.map((c) => c.id)).size, 8);
  assert.match(html, /yuliuContextualTransferV1/);
  assert.match(html, /不是独立保留集/);
  assert.match(html, /contextual-inference-smoke.html/);
});

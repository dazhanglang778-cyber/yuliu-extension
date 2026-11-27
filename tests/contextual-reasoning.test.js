// Direct LegacyReview assertions reproduce V7 only; R/Reasoning.run exercises current production.
const LegacyReview = require('../evaluation/legacy-review-v7.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Reasoning = require('../contextual-reasoning.js');
const Discourse = require('../discourse-context.js');
const Retrieval = require('../document-retrieval.js');
const Document = require('../document-context.js');
const Contract = require('../grounding-contract-v2.js');
const Suite = require('../evaluation/contextual-suite.js');
const dataset = require('../evaluation/fixtures/contextual-generalization-v1.json');
const protocolRelationFixture = require('../evaluation/protocol-relation-fixture.js');

function scriptedModel(item, prepared) {
  const evidence = Reasoning.evidenceFor(prepared);
  const statements = item.reference.map((s, i) => ({ id: `c${i + 1}`, part: s.part, basis: s.basis, text: s.text,
    evidence_ids: evidence.filter((e) => s.blocks.includes(Number(e.block_id.slice(1)))).map((e) => e.evidence_id) }));
  const draft = { target_type: item.selection.startsWith('说话人') ? 'person' : 'reference', statements };
  const judge = { review_version: Reasoning.REVIEW_VERSION, checks: statements.map((s) => ({ ...s, selection_fit: 'current', supported: true,
    relation_audit: s.evidence_ids.length ? protocolRelationFixture(evidence.find((e) => e.evidence_id === s.evidence_ids[0]).quote, s.evidence_ids[0]) : null,
    usefulness: s.basis === 'unknown' ? 'unknown' : 'useful',
    citations: ['unknown', 'general'].includes(s.basis) ? [] : s.evidence_ids.map((id) => ({ evidence_id: id, quote: evidence.find((e) => e.evidence_id === id).quote })),
    reason: '测试桩：仅验证流程，不评估模型能力' })),
    coverage: { status: statements.every((s) => s.basis === 'unknown') ? 'insufficient' : 'adequate', missing: [] }, allow_general_expansion: false };
  let calls = 0;
  return { draft, judge, call: async ({ messages }) => { calls++; return JSON.stringify(messages[0].content.includes('独立的语境主张核验器') ? judge : draft); }, calls: () => calls };
}

test('跨轮检索保留不含选中词的提问、条件和回答', () => {
  const item = dataset.cases[0], request = Suite.prepare(item);
  assert.equal(request.documentContext.conversation.indexed_turn_count, 6);
  for (const i of [1, 2, 3, 4, 5]) assert.ok(request.documentContext.evidence_candidates.some((e) => e.block_id === `p${i}`));
  assert.ok(request.documentContext.evidence_candidates.some((e) => e.time === '00:28' && e.quote.includes('适配')));
});

test('分离的说话人时间标题与后续发言合成一轮，不伪造连续引文', () => {
  const snapshot = { page: { url: 'test://split' }, selection: { raw_text: '可以', anchor_block_id: 'b3', start_offset: 0 },
    blocks: ['说话人 1 00:01', '旧接口能否换成新接口？', '王宁 00:10', '可以，但要先完成认证。'].map((text, i) => ({ block_id: `b${i}`, text, order: i })) };
  const r = Retrieval.retrieve(snapshot);
  assert.equal(snapshot.conversation.indexed_turn_count, 2);
  assert.ok(r.candidates.some((e) => e.quote.includes('旧接口')));
  for (const e of r.candidates) assert.ok(snapshot.blocks.find((b) => b.block_id === e.block_id).text.includes(e.quote));
});

test('同一大段内多轮发言按选区偏移选中正确一轮', () => {
  const text = '说话人 1 00:01 可以先看数据。 李明 00:10 稍等。 说话人 1 00:20 可以，但不能删除旧库。';
  const snapshot = { page: { url: 'test://offset' }, blocks: [{ block_id: 'b', text, order: 0 }], selection: { raw_text: '可以', anchor_block_id: 'b', start_offset: text.lastIndexOf('可以') } };
  const r = Retrieval.retrieve(snapshot);
  assert.equal(snapshot.conversation.anchor_time, '00:20');
  assert.ok(r.candidates[0].quote.includes('不能删除'));
  assert.ok(r.candidates[0].source_start > 0);
});

test('人物索引仅绑定当前文档内容，修改或换文档后不串人', () => {
  Discourse.clearCache();
  const a = Suite.prepare(dataset.cases[1]).documentContext.conversation;
  const changed = { ...dataset.cases[1], id: 'another-document', blocks: dataset.cases[1].blocks.map((t) => t.replaceAll('班级', '部门')) };
  const b = Suite.prepare(changed).documentContext.conversation;
  assert.notEqual(a.fingerprint, b.fingerprint);
  Suite.prepare(dataset.cases[5]);
  assert.ok(Discourse.cacheSize() <= 2);
});

test('普通文章中近邻指代对象不被大量远处同词挤走', () => {
  const blocks = Array.from({ length: 40 }, (_, i) => ({ block_id: `b${i}`, text: `它在其他章节有不同用法，第${i}段。`, order: i }));
  blocks[30].text = '现在单独讨论订单服务。'; blocks[31].text = '它先核验权限。';
  const r = Retrieval.retrieve({ blocks, selection: { raw_text: '它', anchor_block_id: 'b31' } });
  assert.ok(r.candidates.some((c) => c.block_id === 'b30'));
});

test('超长单块的文末不会丢失，保留源偏移可回跳', () => {
  const original = '很长的正文。'.repeat(2000) + '末尾的重要对象是新的接口服务。';
  const blocks = Document.createBlockRecords([{ text: original, tagName: 'p' }]);
  assert.ok(blocks.length > 1);
  assert.ok(blocks.at(-1).text.includes('新的接口服务'));
  for (const block of blocks) assert.equal(original.slice(block.source_start, block.source_start + block.text.length), block.text);
});

test('伪证据ID及改写引文不能进入语境核验', () => {
  const request = Suite.prepare(dataset.cases[0]);
  request.documentContext.evidence_candidates.push({ evidence_id: 'fake', block_id: 'p1', quote: '这是不存在的证据', text: '这是不存在的证据' });
  const evidence = Reasoning.evidenceFor(request);
  assert.ok(!evidence.some((e) => e.evidence_id === 'fake'));
  const draft = Reasoning.normalizeDraft({ statements: [{ id: 'c1', part: 'meaning', basis: 'document', text: '身份猜测', evidence_ids: ['fake'] }] }, evidence);
  assert.equal(draft.statements.length, 0);
});

test('核验拒绝姓名猜测时仍保留有证据的当前作用', async () => {
  const item = dataset.cases[1], request = Suite.prepare(item), model = scriptedModel(item, request);
  model.draft.statements.push({ id: 'bad', part: 'meaning', basis: 'inference', text: '说话人 2 是学校校长。', evidence_ids: model.draft.statements[0].evidence_ids });
  model.judge.checks.push({ id: 'bad', selection_fit: 'current', supported: false, basis: 'inference', evidence_ids: [], reason: '询问授权不等于校长' });
  const outcome = await Reasoning.run(request, model.call);
  assert.equal(outcome.result.resolution.status, 'clear');
  assert.match(outcome.result.meaning_here.text, /授权/);
  assert.doesNotMatch(outcome.result.meaning_here.text, /校长/);
  assert.match(outcome.result.meaning_here.text, /不能确定/);
  assert.equal(model.calls(), 2);
});

test('核验器不能把文内身份洗成常识、补造新证据或重复判定', () => {
  const request = Suite.prepare(dataset.cases[0]), evidence = Reasoning.evidenceFor(request);
  const draft = { statements: [{ id: 'c1', part: 'meaning', basis: 'document', text: '某人是负责人', evidence_ids: [evidence[0].evidence_id] }] };
  for (const checks of [
    [{ id: 'c1', supported: true, basis: 'general', evidence_ids: [] }],
    [{ id: 'c1', supported: true, basis: 'document', evidence_ids: ['unknown'] }],
    Array(2).fill({ id: 'c1', supported: true, basis: 'document', evidence_ids: [evidence[0].evidence_id] }),
  ]) assert.equal(LegacyReview.accept(draft, { checks: checks.map((c) => ({ ...c, usefulness: 'useful',
    citations: [{ evidence_id: evidence[0].evidence_id, quote: evidence[0].quote }] })),
    coverage: { status: 'adequate', missing: [] } }, evidence).accepted.length, 0);
});

test('多引文共同支持主张，引用顺序按解释所需证据而不是固定选中句', async () => {
  const request = Suite.prepare(dataset.cases[0]), model = scriptedModel(dataset.cases[0], request);
  model.draft.statements[0].evidence_ids.sort((a, b) => {
    const list = request.documentContext.evidence_candidates;
    return Number(list.find((e) => e.evidence_id === a).block_id.slice(1)) - Number(list.find((e) => e.evidence_id === b).block_id.slice(1));
  });
  model.judge.checks[0].evidence_ids = model.draft.statements[0].evidence_ids;
  model.judge.checks[0].citations.sort((a, b) => model.judge.checks[0].evidence_ids.indexOf(a.evidence_id) - model.judge.checks[0].evidence_ids.indexOf(b.evidence_id));
  const outcome = await Reasoning.run(request, model.call);
  assert.ok(outcome.result.claims[0].supports.length >= 3);
  assert.equal(outcome.result.page_evidence[0].block_id, 'p1');
  assert.equal(Contract.validate(outcome.result).ok, true);
});

test('十份跨类型合成文档可通过实际管线的协议回放（不是实模语义评测）', async () => {
  assert.equal(dataset.cases.length, 10);
  for (const item of dataset.cases) {
    const request = Suite.prepare(item), model = scriptedModel(item, request);
    const outcome = await Reasoning.run(request, model.call);
    const check = Contract.validate(outcome.result);
    assert.equal(check.ok, true, `${item.id}: ${check.errors}`);
    if (!item.allowInsufficient) assert.notEqual(outcome.result.resolution.status, 'insufficient', item.id);
    // Older model outputs have no scope hint. Missing metadata is not a reason to block.
    assert.equal(outcome.result.can_expand_general, !(/^说话人\s*\d+$/.test(item.selection) && request.documentContext.conversation?.selected_speaker));
    for (const source of outcome.result.page_evidence) assert.ok(item.blocks[Number(source.block_id.slice(1))].includes(source.quote));
  }
});

test('展开入口取决于可迁移性而不是术语分类；缺字段不触发修复，匿名编号不能创建人物词条', async () => {
  const item=dataset.cases[8];
  for(const [selection,scope,type,speaker,allowed] of [
    ['Ahrefs','transferable','entity',null,true], ['Harbor','uncertain','entity',null,true],
    ['第二套方案','local_only','term',null,false], ['说话人 5','transferable','person','说话人 5',false],
    ['新项目',undefined,'entity',null,true],['项目','unexpected','entity',null,true]
  ]) {
    const req=Suite.prepare({...item,selection,blocks:[selection+'用于对照。'] ,anchor:0});
    req.documentContext.conversation=speaker ? {selected_speaker:speaker} : null;
    const draft=Reasoning.normalizeDraft(JSON.stringify({target_type:type,expansion_scope:scope,statements:[
      {id:'c1',part:'meaning',basis:'unknown',text:'不能确认身份。',evidence_ids:[]}
    ]}),[]);
    assert.deepEqual(draft.errors,[]);
    const checked=Reasoning.acceptReview(draft,'{}',[]);
    const result=Reasoning.compose(req,draft,checked,[],'NO_SUPPORTED_CURRENT_MEANING');
    assert.equal(result.can_expand_general,allowed,selection);
    assert.equal(result.resolution.status,'insufficient');
  }
});

test('模型错误与内容不足分开；不会把请求失败说成没有语境', async () => {
  const outcome = await Reasoning.run(Suite.prepare(dataset.cases[0]), async () => { throw new Error('503'); });
  assert.match(outcome.result.meaning_here.text, /分析暂未完成/);
  assert.equal(outcome.trace.error, '503');
  assert.equal(outcome.result.page_evidence.length, 0);
});

test('核验JSON损坏不会被当成原文不足；修复次数与耗时可观察', async () => {
  const item = dataset.cases[0], request = Suite.prepare(item), model = scriptedModel(item, request);
  const failed = await Reasoning.run(request, async ({ messages }) => messages[0].content.includes('独立的语境主张核验器') ? 'not-json' : JSON.stringify(model.draft));
  assert.equal(failed.trace.error, 'VERIFICATION_FORMAT_ERROR');
  assert.equal(failed.trace.model_calls, 3);
  assert.equal(failed.trace.history[2].repair_kind, 'verification_protocol');
  assert.match(failed.result.meaning_here.text, /分析暂未完成/);
  const rejected = await Reasoning.run(request, async ({ messages }) => messages[0].content.includes('独立的语境主张核验器')
    ? JSON.stringify({ review_version: Reasoning.REVIEW_VERSION, checks: model.draft.statements.map((s) => ({ id: s.id, selection_fit: 'current', supported: false, basis: s.basis, evidence_ids: [], reason: '模拟否决' })), coverage: { status: 'adequate', missing: [] } }) : JSON.stringify(model.draft));
  assert.equal(rejected.trace.model_calls, 2);
  assert.equal(rejected.trace.attempts, 1);
});

test('远处自我介绍的前后问答也能进入当前人物检索', () => {
  const blocks = [
    '主持人 00:01 请新同事介绍一下负责的工作。',
    '说话人 2 00:08 我负责权限校验。',
    '主持人 00:14 所以本轮权限问题由你汇总。',
    ...Array.from({ length: 20 }, (_, i) => `同事甲 01:${String(i).padStart(2, '0')} 下面处理其他工作。`),
    '说话人 2 02:01 我先记录下来。',
  ];
  const r = Suite.prepare({ id: 'far-introduction', title: '合成', selection: '说话人 2', anchor: blocks.length - 1, blocks });
  assert.ok(r.documentContext.evidence_candidates.some((e) => e.block_id === 'p0'));
  assert.ok(r.documentContext.evidence_candidates.some((e) => e.block_id === 'p2'));
});

test('专项页面加载正确脚本、区分期望与实测，卡片标题不受图标宽度限制', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'contextual-evaluation.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) assert.ok(fs.existsSync(path.join(root, match[1])), match[1]);
  assert.match(html, /期望解释不是模型输出/);
  assert.match(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), /h3 > span:not\(\[data-label\]\)/);
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /importScripts\("contextual-reasoning.js"\)/);
  assert.match(fs.readFileSync(path.join(root, 'evaluation/run-batch.js'), 'utf8'), /ContextualReasoning.run/);
});

test('真实后台新分支只请求模型而不调用公开搜索或术语候选', async () => {
  const item = dataset.cases[1], request = Suite.prepare(item), model = scriptedModel(item, request), urls = [];
  const context = { YuliuContextualReasoning: Reasoning, console, URL, setTimeout, clearTimeout, AbortController, TextDecoder,
    chrome: { runtime: { onConnect: { addListener() {} } }, storage: { local: { async get() { return {}; }, async set() {} } } },
    fetch: async (url, options) => { urls.push(url); const body = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: await model.call(body) } }] }) }; } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../background.js'), 'utf8'), context);
  const messages = [];
  await context.runGroundedInitial({ postMessage: (m) => messages.push(m) }, { ...request, requestId: 'test', mode: 'initial' }, 'mock-key');
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes('/chat/completions')));
  assert.ok(messages.find((m) => m.type === 'GROUNDED_RESULT').result.meaning_here.text.includes('授权'));
});

test('专项报告保留原文、期望、实际回答、采用依据和核验记录，错误不中断整批', async () => {
  const small = { ...dataset, cases: dataset.cases.slice(0, 2) };
  let count = 0;
  const report = await Suite.run(small, { send: async (request) => {
    if (++count === 1) throw new Error('模拟一次失败');
    const model = scriptedModel(small.cases[1], request), outcome = await Reasoning.run(request, model.call);
    return { ok: true, prediction: outcome };
  } });
  assert.equal(report.completed, 2);
  assert.equal(report.rows[0].error, '模拟一次失败');
  assert.ok(report.rows[1].actual.meaning_here.text);
  assert.ok(report.rows[1].trace.verification);
  assert.ok(report.rows[1].expected);
  assert.equal(report.rows[1].checks.human_review_required, true);
});

// Direct LegacyReview assertions reproduce V7 only; R/Reasoning.run exercises current production.
const LegacyReview = require('../evaluation/legacy-review-v7.js');
const test = require("node:test");
const assert = require("node:assert/strict");
const Reasoning = require("../contextual-reasoning.js");
const Controls = require("../evaluation/contextual-quality-reproductions.js");
const Contract = require("../grounding-contract-v2.js");
const Audit = require("../contextual-audit.js");
const Suite = require("../evaluation/contextual-suite.js");
const liveDataset = require("../evaluation/fixtures/contextual-usefulness-v1.json");
const protocolRelationFixture = require("../evaluation/protocol-relation-fixture.js");
const scenario = (id) => Controls.cases.find((c) => c.id === id);

test("空泛但真实的参与描述可在一次审阅中修正，保留有限推断及未知边界", async () => {
  const { outcome } = await Controls.runCase(scenario("affiliation-with-clues"));
  assert.equal(outcome.trace.model_calls, 2);
  assert.equal(outcome.trace.selected_attempt, 1);
  assert.equal(outcome.result.resolution.status, "inferred");
  assert.match(outcome.result.meaning_here.text, /较可能代表培训中心/);
  assert.match(outcome.result.meaning_here.text, /协调讲师资源/);
  assert.match(outcome.result.meaning_here.text, /尚不能确定/);
  assert.doesNotMatch(outcome.result.meaning_here.text, /负责人|参与者之一/);
  assert.equal(Contract.validate(outcome.result).ok, true);
  assert.ok(outcome.trace.verification.checks[0].replacement);
  assert.ok(outcome.trace.verification.checks[0].citations.length);
});

test("删证据反例保留可知的讨论作用，不能继承上一例的所属方", async () => {
  const { outcome } = await Controls.runCase(scenario("affiliation-without-clues"));
  assert.equal(outcome.trace.model_calls, 2);
  assert.match(outcome.result.meaning_here.text, /课程合作/);
  assert.match(outcome.result.meaning_here.text, /不能确定其属于/);
  assert.doesNotMatch(outcome.result.meaning_here.text, /代表培训中心|负责人/);
});

test("已有类别解释但漏掉关键任务时，仍按核验建议补写文内含义", async () => {
  const { outcome } = await Controls.runCase(scenario("project-missing-detail"));
  assert.equal(outcome.trace.model_calls, 2);
  assert.match(outcome.result.meaning_here.text, /历史订单迁入新仓库/);
  assert.match(outcome.result.meaning_here.text, /样本核对/);
});

test("职责只引用支持它的原句，别人的提问不会进入该人的意图或引用", async () => {
  const row = await Controls.runCase(scenario("mentioned-person-attribution"));
  const { result, trace } = row.outcome;
  assert.equal(result.author_intent, null);
  assert.equal(result.page_evidence.length, 1);
  const e = result.page_evidence[0], source = row.source[0];
  assert.equal(e.quote, "林老师负责课程验收。");
  assert.equal(source.slice(e.source_start, e.source_end), e.quote);
  assert.equal(result.claims[0].supports[0].source_id, e.evidence_id);
  assert.ok(e.parent_evidence_id);
  assert.equal(Contract.validate(result).ok, true);
  const reviewed = Audit.review(trace, result);
  assert.equal(reviewed.claims[0].evidence[0].quote, e.quote);
  assert.match(reviewed.claims[1].reason, /没有归给/);
});

test("联合依据保留对象、短答与限制条件，各主张有各自支持片段", async () => {
  const { outcome } = await Controls.runCase(scenario("dialogue-joint-support"));
  const { result } = outcome;
  assert.equal(result.claims[0].supports.length, 2);
  assert.equal(result.claims[1].supports.length, 2);
  const refs = new Map(result.page_evidence.map((e) => [e.evidence_id, e.quote]));
  assert.ok(result.claims[0].supports.some((s) => refs.get(s.source_id).includes("采集服务和展示服务")));
  assert.ok(result.claims[1].supports.some((s) => refs.get(s.source_id).includes("需要转换数据格式")));
});

test("核验缺项后服务失败不抹掉已经审阅的解释，日志和引用仍对应首稿", async () => {
  const { outcome } = await Controls.runCase(scenario("repair-failure-keeps-partial"));
  assert.equal(outcome.trace.model_calls, 3);
  assert.equal(outcome.trace.selected_attempt, 1);
  assert.equal(outcome.trace.repair_error, "MOCK_REPAIR_SERVICE_UNAVAILABLE");
  assert.equal(outcome.result.contextual_details.failure, null);
  assert.match(outcome.result.meaning_here.text, /历史订单迁入新仓库/);
  assert.doesNotMatch(outcome.result.meaning_here.text, /暂未完成/);
  assert.equal(outcome.trace.generation.statements[0].text, outcome.result.meaning_here.text);
  assert.equal(outcome.result.page_evidence.length, 1);
});

test("真正未知只解释未知边界，不重复请求，也不把它记录为服务故障", async () => {
  const { outcome } = await Controls.runCase(scenario("genuine-unknown"));
  assert.equal(outcome.trace.model_calls, 2);
  assert.equal(outcome.result.resolution.status, "insufficient");
  assert.equal(outcome.result.contextual_details.failure, null);
  assert.ok(!outcome.trace.error);
  assert.match(outcome.result.meaning_here.text, /无法据此判断/);
});

test("适合语境的普通概念知识不被文内定义缺失卡住，也不伪造原文引用", async () => {
  const { outcome } = await Controls.runCase(scenario("ordinary-term-knowledge"));
  assert.equal(outcome.trace.model_calls, 2);
  assert.equal(outcome.result.resolution.status, "clear");
  assert.equal(outcome.result.page_evidence.length, 0);
  assert.deepEqual(outcome.result.claims[0].supports, [{ source_kind: "model_knowledge" }]);
  assert.equal(Contract.validate(outcome.result).ok, true);
});

test("审阅仍不支持空泛答案时停止无意义重生成，不把未完成解释说成原文没有信息", async () => {
  const { outcome } = await Controls.runCase(scenario("restatement-persists"));
  assert.equal(outcome.trace.model_calls, 2);
  assert.equal(outcome.result.resolution.status, "insufficient");
  assert.equal(outcome.trace.error, "NO_SUPPORTED_CURRENT_MEANING");
  assert.match(outcome.result.meaning_here.text, /不代表原文没有足够信息/);
  assert.doesNotMatch(outcome.result.meaning_here.text, /文章中提到的一个任务/);
});

function control() {
  const evidence = [{ evidence_id: "e1", block_id: "b1", quote: "甲模块和乙模块可以分开。甲模块和乙模块可以分开。",
    source_start: 20, source_offset: 1000, role: "coreference_support" },
    { evidence_id: "e2", block_id: "b2", quote: "其他讨论没有说明部署方式。", source_start: 0, role: "coreference_support" }];
  const draft = { target_type: "reference", statements: [{ id: "c1", part: "meaning", basis: "document",
    text: "甲模块与乙模块可以分开。", evidence_ids: ["e1"] }] };
  const check = { id: "c1", supported: true, usefulness: "useful", basis: "document", evidence_ids: ["e1"],
    relation_audit: protocolRelationFixture("甲模块和乙模块可以分开。", "e1"),
    citations: [{ evidence_id: "e1", quote: "甲模块和乙模块可以分开。", quote_start: 0 }] };
  const verdict = (c) => ({ checks: [c], coverage: { status: "adequate", missing: [] } });
  return { evidence, draft, check, verdict };
}

test("支持引文必须在原绑定依据中，拒绝伪造、跨来源偷换和模糊的重复短句", () => {
  const { evidence, draft, check, verdict } = control();
  for (const citations of [
    [{ evidence_id: "e1", quote: "两者完全没有依赖" }],
    [{ evidence_id: "e2", quote: evidence[1].quote }],
    [{ evidence_id: "e1", quote: "甲模块和乙模块可以分开。" }],
    [{ evidence_id: "e1", quote: "甲模块和乙模块可以分开。", quote_start: 1 }],
    [],
  ]) {
    const r = LegacyReview.accept(draft, verdict({ ...check, citations }), evidence);
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected[0].code, "INVALID_SUPPORT_CITATION");
  }
  assert.equal(LegacyReview.accept(draft, verdict(check), evidence).accepted.length, 1);
});

test("核验不能把推断升级为明示事实，或把肯定断言改标签藏进未知", () => {
  const { evidence, draft, check, verdict } = control();
  draft.statements[0].basis = "inference";
  assert.equal(LegacyReview.accept(draft, verdict(check), evidence).accepted.length, 0);
  const unknown = { ...check, basis: "unknown", usefulness: "unknown", evidence_ids: [], citations: [] };
  assert.equal(LegacyReview.accept(draft, verdict(unknown), evidence).accepted.length, 0);
});

test("缺失有用性判定不能凭supported为真直接放行；文内人物不能以常识补身份", () => {
  const { evidence, draft, check, verdict } = control();
  const missing = { ...check }; delete missing.usefulness;
  assert.equal(LegacyReview.accept(draft, verdict(missing), evidence).accepted.length, 0);
  draft.target_type = "person"; draft.statements[0].basis = "general"; draft.statements[0].evidence_ids = [];
  assert.equal(LegacyReview.accept(draft, verdict({ ...check, basis: "general", evidence_ids: [], citations: [] }), evidence).accepted.length, 0);
});

test("短而具体的指代可通过，不用字数阈值判断解释有用性", () => {
  const { evidence, draft, check, verdict } = control();
  draft.statements[0].text = "它指甲模块。";
  const checked = LegacyReview.accept(draft, verdict(check), evidence);
  assert.equal(checked.accepted.length, 1);
  assert.equal(checked.accepted[0].text, "它指甲模块。");
});

test("同一原文块的不同支持短句保持独立坐标，诊断与最终引用一致", () => {
  const { evidence, draft, check, verdict } = control();
  const sentence = check.citations[0].quote;
  check.citations[0].quote_start = sentence.length;
  const checked = LegacyReview.accept(draft, verdict(check), evidence);
  const result = Reasoning.compose({ selection: "分开", documentContext: {
    selection: { anchor_block_id: "b1", start_offset: 28 }, extraction: { coverage: "synthetic_complete" },
  } }, draft, checked, evidence);
  const e = result.page_evidence[0];
  assert.equal(e.source_start, 20 + sentence.length);
  assert.equal(e.source_end, e.source_start + sentence.length);
  assert.equal(e.source_offset, 1000);
  assert.equal(e.display_purpose, "meaning_support");
});

test("来源完整但语义不支持时，依照逐项核验删除主张，不能凭关键词重合保留", () => {
  const { evidence, draft, check, verdict } = control();
  const checked = LegacyReview.accept(draft, verdict({ ...check, supported: false, reason: "同主题讨论没有说明这两个对象的关系" }), evidence);
  assert.equal(checked.accepted.length, 0);
  assert.match(checked.rejected[0].reason, /没有说明/);
});

test("真实模型专项只发送中性标题和正文，不泄露人工答案、验收提示或预设返回", () => {
  assert.equal(liveDataset.cases.length, 7);
  for (const item of liveDataset.cases) {
    const sentinel = "DO_NOT_SEND_EXPECTED_ANSWER";
    const request = Suite.prepare({ ...item, expected: sentinel, reference: [{ text: sentinel }],
      first: { text: sentinel }, checks: { text: sentinel } });
    const input = Reasoning.buildMessages(request, Reasoning.evidenceFor(request));
    assert.ok(!JSON.stringify(input).includes(sentinel));
    assert.doesNotMatch(item.title, /应补写|所属方线索|不能继承|精确|漏掉|未知边界/);
    assert.equal(item.split, "development");
  }
});

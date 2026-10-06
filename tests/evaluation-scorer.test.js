const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Scorer = require("../evaluation/scorer.js");
const Runner = require("../evaluation/run-batch.js");

const evaluationRoot = path.resolve(__dirname, "..", "evaluation");
const dataset = JSON.parse(fs.readFileSync(path.join(evaluationRoot, "datasets", "core-context-v1.json"), "utf8"));
const harnessDocument = dataset.documents.find((item) => item.document_id === "agent-harness");
const harnessGold = harnessDocument.cases.find((item) => item.case_id === "harness-definition");
const harnessHtml = fs.readFileSync(path.join(evaluationRoot, harnessDocument.file), "utf8");
const harnessBlocks = Scorer.documentBlocksFromHtml(harnessHtml);

function goodPrediction(overrides = {}) {
  return {
    case_id: harnessGold.case_id,
    result: {
      selected_text: "Harness",
      resolved_sense: { label: "组织模型、工具与环境交互的运行框架", referent_type: "generic_concept", specificity: "category" },
      meaning_here: "在这里指组织模型、工具与环境交互的一套运行框架。",
      author_intent: null,
      certainty: "clear",
      claims: [{ claim_id: "c1", text: "Harness 是运行框架", risk: "ordinary", evidence_ids: ["e1"] }],
      evidence: [{ evidence_id: "e1", block_id: "p-4", quote: "组织这些交互环节的运行框架统称为 Harness", role: "direct_support" }],
      notice_code: "none",
      ...overrides,
    },
    _meta: { validation_attempts: 1, elapsed_ms: 1200 },
    trace: { retrieved_block_ids: ["p-4", "p-5"] },
  };
}

test("完全符合金标准的结果通过核心评测", () => {
  const scored = Scorer.evaluateCase(harnessGold, goodPrediction(), harnessBlocks, {
    retrieved_block_ids: ["p-4", "p-5"], expected_certainty: "clear",
  });
  assert.equal(scored.passed, true, scored.failures.join(", "));
  assert.equal(scored.metrics.sense_correct, 1);
  assert.equal(scored.metrics.evidence_valid, 1);
  assert.equal(scored.metrics.useful_answer, 1);
  assert.equal(scored.metrics.author_intent_appropriate, 1);
});

test("作者意图不该出现时重复这里指什么会被单独识别", () => {
  const meaning = "在这里指组织模型、工具与环境交互的一套运行框架。";
  const scored = Scorer.evaluateCase(harnessGold, goodPrediction({
    meaning_here: meaning,
    author_intent: meaning,
  }), harnessBlocks, { expected_certainty: "clear" });
  assert.equal(scored.metrics.author_intent_appropriate, 0);
  assert.equal(scored.metrics.author_intent_distinct, 0);
  assert.ok(scored.failures.includes("AUTHOR_INTENT_UNNECESSARY"));
  assert.ok(scored.failures.includes("AUTHOR_INTENT_DUPLICATES_MEANING"));
});

test("第二版主张必须得到原文证据的语义支持", () => {
  const result = {
    schema_version: "2.0",
    selected_text: "Harness",
    candidate_senses: [{
      sense_id: "s1", label: "Agent 运行框架", gloss: "组织模型、工具与环境交互的运行框架",
      referent_type: "generic_concept", chinese_name: null, english_full_name: null,
      supports: [{ source_kind: "model_knowledge", source_id: null }],
    }],
    resolution: { status: "clear", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "high", specificity: "category" },
    meaning_here: { text: "在这里指组织模型、工具与环境交互的一套运行框架。", chinese_name: null, english_full_name: null, contextual_role: null },
    author_intent: null,
    claims: [{ claim_id: "c1", claim_type: "contextual_mapping", text: "Harness 在这里指 Agent 运行框架。", supports: [{ source_kind: "page_evidence", source_id: "e1" }] }],
    page_evidence: [{ evidence_id: "e1", block_id: "p-4", quote: "组织这些交互环节的运行框架统称为 Harness", role: "direct_support" }],
    external_sources: [],
    notice_code: "none",
  };
  const supported = Scorer.evaluateCase(harnessGold, { result, _meta: { validation_attempts: 1 } }, harnessBlocks, { expected_certainty: "clear" });
  assert.equal(supported.metrics.semantic_support, 1);
  result.claims[0].supports[0].source_id = "missing";
  const unsupported = Scorer.evaluateCase(harnessGold, { result, _meta: { validation_attempts: 1 } }, harnessBlocks, { expected_certainty: "clear" });
  assert.equal(unsupported.metrics.semantic_support, 0);
  assert.ok(unsupported.failures.includes("CLAIM_SEMANTIC_SUPPORT_FAILURE"));
});

test("DeepSeek Harness错误具体化会归入可行动失败类型", () => {
  const prediction = goodPrediction({
    resolved_sense: { label: "DeepSeek Harness（DSH）", referent_type: "product", specificity: "exact_variant" },
    meaning_here: "在这里就是 DeepSeek Harness（DSH）这一产品。",
  });
  const scored = Scorer.evaluateCase(harnessGold, prediction, harnessBlocks, {
    retrieved_block_ids: ["p-4", "p-6"], expected_certainty: "clear",
  });
  assert.equal(scored.passed, false);
  assert.ok(scored.failures.includes("UNJUSTIFIED_SPECIFICITY"));
  assert.ok(scored.failures.includes("FORBIDDEN_CONTENT"));
  assert.ok(scored.failures.includes("REFERENT_TYPE_MISMATCH"));
});

test("伪引文与提示误报分别归因而不混成一个错误", () => {
  const prediction = goodPrediction({
    evidence: [{ evidence_id: "e1", block_id: "p-4", quote: "原文从未写过的句子", role: "direct_support" }],
    notice_code: "insufficient_context",
  });
  const scored = Scorer.evaluateCase(harnessGold, prediction, harnessBlocks, {
    retrieved_block_ids: ["p-4"], expected_certainty: "clear",
  });
  assert.ok(scored.failures.includes("EVIDENCE_QUOTE_MISMATCH"));
  assert.ok(scored.failures.includes("NOTICE_FALSE_POSITIVE"));
  assert.equal(scored.metrics.over_refusal, 1);
});

test("检索已有正确证据但回答未采用时归因给生成阶段", () => {
  const prediction = goodPrediction({
    evidence: [{ evidence_id: "e2", block_id: "p-5", quote: "Harness 的设计会直接影响任务能否可靠执行", role: "coreference_support" }],
  });
  const scored = Scorer.evaluateCase(harnessGold, prediction, harnessBlocks, {
    retrieved_block_ids: ["p-4", "p-5"], expected_certainty: "clear",
  });
  assert.ok(scored.failures.includes("EVIDENCE_MISS"));
  assert.ok(scored.failures.includes("GENERATION_IGNORED_RETRIEVED_EVIDENCE"));
  assert.ok(!scored.failures.includes("RETRIEVAL_MISS"));
});

test("Harness有充分语境时返回信息不足会被识别为过度拒答", () => {
  const document = dataset.documents.find((item) => item.document_id === "harness-contextual-engineering");
  const gold = document.cases.find((item) => item.case_id === "harness-context-without-definition");
  const blocks = Scorer.documentBlocksFromHtml(fs.readFileSync(path.join(evaluationRoot, document.file), "utf8"));
  const prediction = {
    result: {
      selected_text: "Harness",
      resolved_sense: { label: "当前所指无法确定", referent_type: "other", specificity: "category" },
      meaning_here: "当前原文信息不足，暂时无法可靠确定这里的具体所指。",
      author_intent: null,
      certainty: "insufficient",
      claims: [],
      evidence: [],
      notice_code: "insufficient_context",
    },
    _meta: { validation_attempts: 2 },
  };
  const scored = Scorer.evaluateCase(gold, prediction, blocks, {
    retrieved_block_ids: ["p-2", "p-3", "p-5"], expected_certainty: "inferred",
  });
  assert.equal(scored.passed, false);
  assert.ok(scored.failures.includes("MISSING_KEY_INFORMATION"));
  assert.ok(scored.failures.includes("CERTAINTY_MISMATCH"));
  assert.ok(scored.failures.includes("NOTICE_FALSE_POSITIVE"));
});

test("把FDE编成实战营运营方法会被金标准明确拦截", () => {
  const document = dataset.documents.find((item) => item.document_id === "fde-ai-camp");
  const gold = document.cases.find((item) => item.case_id === "fde-ai-context-without-expansion");
  const blocks = Scorer.documentBlocksFromHtml(fs.readFileSync(path.join(evaluationRoot, document.file), "utf8"));
  const prediction = {
    result: {
      selected_text: "FDE",
      resolved_sense: { label: "一种实战营的运营方法", referent_type: "method", specificity: "category" },
      meaning_here: "这里指一种实战营的运营方法。",
      author_intent: null,
      certainty: "clear",
      claims: [{ claim_id: "c1", text: "FDE是一种运营方法", risk: "ordinary", evidence_ids: ["e1"] }],
      evidence: [{ evidence_id: "e1", block_id: "p-2", quote: "北京两天 FDE 实战营", role: "sense_disambiguation" }],
      notice_code: "none",
    },
    _meta: { validation_attempts: 1 },
  };
  const scored = Scorer.evaluateCase(gold, prediction, blocks, {
    retrieved_block_ids: ["p-2", "p-3", "p-4"], expected_certainty: "inferred",
  });
  assert.equal(scored.passed, false);
  assert.ok(scored.failures.includes("FORBIDDEN_CONTENT"));
  assert.ok(scored.failures.includes("MISSING_KEY_INFORMATION"));
  assert.ok(scored.failures.includes("REFERENT_TYPE_MISMATCH"));
});

test("批量检索评测覆盖全部28个案例并达到当前基线", () => {
  const prepared = Runner.prepareCases(dataset, {});
  const traces = prepared.map(Runner.retrievalTrace);
  const documents = Object.fromEntries(prepared.map((entry) => [entry.document.document_id, entry.source.html]));
  const report = Scorer.evaluateRetrieval(dataset, traces, documents);
  assert.equal(report.summary.total_cases, 28);
  assert.equal(report.summary.anchor_recall, 100);
  assert.equal(report.summary.support_recall, 100);
  assert.equal(report.summary.retrieval_misses, 0);
  assert.equal(report.cases[0].review.evaluation_scope, "retrieval_only");
  assert.equal(report.cases[0].review.selection.text, "Harness");
  assert.ok(report.cases[0].review.selection.anchor_context.includes("运行框架"));
  assert.ok(report.cases[0].review.expected.meaning.includes("运行框架"));
  assert.equal(report.cases[0].review.actual, null);
  assert.ok(report.cases[0].review.retrieval.retrieved_evidence[0].quote.includes("Harness"));
  const markdown = Runner.markdownReport({
    mode: "retrieval", dataset_id: dataset.dataset_id, generated_at: "test",
    summary: report.summary, cases: report.cases.slice(0, 1),
  });
  assert.ok(markdown.includes("只验证正确原文有没有进入候选证据"));
  assert.ok(markdown.includes("人工预期"));
  assert.ok(markdown.includes("实际输出：未执行模型生成"));
  assert.ok(markdown.includes("RAG实际召回的依据"));
});

test("端到端报告保留实际回答、采用依据和执行过程", () => {
  const report = Scorer.evaluateDataset(dataset, [goodPrediction()], {
    [harnessDocument.document_id]: harnessHtml,
  });
  const item = report.cases.find((entry) => entry.case_id === harnessGold.case_id);
  assert.equal(item.review.evaluation_scope, "end_to_end");
  assert.equal(item.review.actual.meaning, "在这里指组织模型、工具与环境交互的一套运行框架。");
  assert.equal(item.review.actual.adopted_evidence[0].block_id, "p-4");
  assert.equal(item.review.execution.validation_attempts, 1);
  assert.equal(item.review.execution.elapsed_ms, 1200);
});

test("汇总报告同时给出正确率、风险率和失败频次", () => {
  const passing = Scorer.evaluateCase(harnessGold, goodPrediction(), harnessBlocks, { expected_certainty: "clear" });
  const failing = Scorer.evaluateCase(harnessGold, goodPrediction({ notice_code: "insufficient_context" }), harnessBlocks, { expected_certainty: "clear" });
  const summary = Scorer.aggregate([passing, failing]);
  assert.equal(summary.total_cases, 2);
  assert.equal(summary.notice_false_positive_rate, 50);
  assert.equal(summary.failure_counts.NOTICE_FALSE_POSITIVE, 1);
  assert.equal(summary.useful_answer_rate, 50);
  assert.equal(summary.over_refusal_rate, 50);
  assert.equal(summary.average_response_time_ms, 1200);
  assert.equal(summary.p95_response_time_ms, 1200);
  assert.equal(summary.by_difficulty.contextual.total_cases, 2);
  assert.equal(summary.release_gate.passed, false);
});

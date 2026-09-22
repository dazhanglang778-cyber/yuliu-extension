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
    _meta: { validation_attempts: 1 },
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

test("批量检索评测覆盖全部16个案例并达到当前基线", () => {
  const prepared = Runner.prepareCases(dataset, {});
  const traces = prepared.map((entry) => ({
    case_id: entry.gold.case_id,
    retrieved_block_ids: entry.retrieval.candidates.map((item) => item.block_id),
  }));
  const report = Scorer.evaluateRetrieval(dataset, traces);
  assert.equal(report.summary.total_cases, 16);
  assert.equal(report.summary.anchor_recall, 100);
  assert.equal(report.summary.support_recall, 100);
  assert.equal(report.summary.retrieval_misses, 0);
});

test("汇总报告同时给出正确率、风险率和失败频次", () => {
  const passing = Scorer.evaluateCase(harnessGold, goodPrediction(), harnessBlocks, { expected_certainty: "clear" });
  const failing = Scorer.evaluateCase(harnessGold, goodPrediction({ notice_code: "insufficient_context" }), harnessBlocks, { expected_certainty: "clear" });
  const summary = Scorer.aggregate([passing, failing]);
  assert.equal(summary.total_cases, 2);
  assert.equal(summary.notice_false_positive_rate, 50);
  assert.equal(summary.failure_counts.NOTICE_FALSE_POSITIVE, 1);
  assert.equal(summary.by_difficulty.contextual.total_cases, 2);
  assert.equal(summary.release_gate.passed, false);
});

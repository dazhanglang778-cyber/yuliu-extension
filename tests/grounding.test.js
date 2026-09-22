const test = require("node:test");
const assert = require("node:assert/strict");
const Grounding = require("../grounding.js");

function request(selection = "Harness") {
  return {
    selection,
    documentContext: {
      selection: { raw_text: selection, anchor_block_id: "p-8" },
      blocks: [
        { block_id: "p-4", text: "Harness 是组织 Agent 与环境交互、执行任务并接收反馈的一套运行框架。" },
        { block_id: "p-8", text: "随着模型能力与 Harness 设计共同发展，Agent 可以承担更复杂的任务。" },
        { block_id: "p-6", text: "产品清单还列出了 DeepSeek Harness（DSH）和 Atlas。" },
      ],
      evidence_candidates: [
        { evidence_id: "e1", block_id: "p-4", role: "direct_support", text: "Harness 是组织 Agent 与环境交互、执行任务并接收反馈的一套运行框架。" },
        { evidence_id: "e2", block_id: "p-8", role: "coreference_support", text: "随着模型能力与 Harness 设计共同发展，Agent 可以承担更复杂的任务。" },
        { evidence_id: "e3", block_id: "p-6", role: "coreference_support", text: "产品清单还列出了 DeepSeek Harness（DSH）和 Atlas。" },
      ],
    },
  };
}

function validResult(overrides = {}) {
  return {
    selected_text: "Harness",
    resolved_sense: {
      label: "支撑 Agent 执行任务并与环境交互的运行框架",
      referent_type: "generic_concept",
      specificity: "category",
    },
    meaning_here: "在这里指组织 Agent 与环境交互、执行任务并接收反馈的一套运行框架。",
    author_intent: null,
    certainty: "clear",
    claims: [{ claim_id: "c1", text: "Harness 是一套运行框架", risk: "ordinary", evidence_ids: ["e1"] }],
    evidence: [{ evidence_id: "e1", block_id: "p-4", quote: "Harness 是组织 Agent 与环境交互、执行任务并接收反馈的一套运行框架。", role: "direct_support" }],
    notice_code: "none",
    ...overrides,
  };
}

test("证据支持的 Harness 类别义项可以通过", () => {
  const checked = Grounding.validateStructured(validResult(), request());
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(checked.result.author_intent, null);
  assert.deepEqual(checked.result.evidence[0].heading_path, []);
});

test("同页出现的 DeepSeek Harness 不能冒充当前 Harness 的具体身份", () => {
  const checked = Grounding.validateStructured(validResult({
    resolved_sense: { label: "DeepSeek Harness（DSH）", referent_type: "product", specificity: "exact_variant" },
    meaning_here: "这里指 DeepSeek Harness（DSH）这一具体产品。",
    claims: [{ claim_id: "c1", text: "Harness 是 DeepSeek Harness（DSH）", risk: "high", evidence_ids: ["e3"] }],
    evidence: [{ evidence_id: "e3", block_id: "p-6", quote: "产品清单还列出了 DeepSeek Harness（DSH）和 Atlas。", role: "coreference_support" }],
  }), request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((item) => item.includes("HIGH_RISK_WITHOUT_DIRECT_EVIDENCE")));
});

test("模型改写出来的伪引文不能作为证据", () => {
  const result = validResult();
  result.evidence[0].quote = "Harness 是专门为 DeepSeek 打造的运行框架。";
  const checked = Grounding.validateStructured(result, request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("QUOTE_NOT_IN_BLOCK:e1"));
});

test("作者意图允许为空，不触发整条回答失败", () => {
  const checked = Grounding.validateStructured(validResult({ author_intent: null }), request());
  assert.equal(checked.ok, true);
});

test("有证据推断不会显示含糊警告", () => {
  const checked = Grounding.validateStructured(validResult({ certainty: "inferred", notice_code: "none" }), request());
  assert.equal(checked.ok, true);
  const invalid = Grounding.validateStructured(validResult({ certainty: "inferred", notice_code: "insufficient_context" }), request());
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.includes("INVALID_NOTICE_STATE"));
});

test("真正多义时使用明确的多义状态", () => {
  const checked = Grounding.validateStructured(validResult({ certainty: "ambiguous", notice_code: "multiple_senses" }), request());
  assert.equal(checked.ok, true);
});

test("选中词必须逐项与当前请求一致", () => {
  const checked = Grounding.validateStructured(validResult({ selected_text: "DeepSeek Harness" }), request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("SELECTED_TEXT_MISMATCH"));
});

test("两次校验失败后只返回不含具体实体的安全结果", () => {
  const fallback = Grounding.fallbackResult(request());
  assert.equal(fallback.certainty, "insufficient");
  assert.equal(fallback.notice_code, "insufficient_context");
  assert.equal(fallback.author_intent, null);
  assert.ok(!JSON.stringify(fallback).includes("DeepSeek"));
});

test("生成提示明确区分WSD、证据归因与具体程度", () => {
  const messages = Grounding.buildMessages(request());
  const prompt = JSON.stringify(messages);
  assert.ok(prompt.includes("WSD（词义消歧）"));
  assert.ok(prompt.includes("direct_support"));
  assert.ok(prompt.includes("如果只能确定类别，就停在类别"));
  assert.ok(prompt.includes("p-4"));
});

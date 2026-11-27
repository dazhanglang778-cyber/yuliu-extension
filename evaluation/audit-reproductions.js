(function attach(root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const api = factory(isNode ? require("../contextual-reasoning.js") : root.YuliuContextualReasoning,
    isNode ? require("../contextual-audit.js") : root.YuliuContextualAudit);
  if (isNode) module.exports = api;
  root.YuliuAuditReproductions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Reasoning, Audit) {
  function request() {
    const text = "说话人 1 00:02 先讨论项目背景。" + "这里是无关的背景材料。".repeat(160)
      + "说话人 1 07:20 我们研究中心负责协调课程资源。";
    const offset = text.lastIndexOf("说话人 1");
    return { selection: "说话人 1", documentContext: {
      page: { title: "人工构造的重复选词样本，不是真实会议" }, extraction: { coverage: "synthetic_complete" },
      selection: { anchor_block_id: "b1", start_offset: offset, raw_text: "说话人 1" },
      blocks: [{ block_id: "b1", text }],
      evidence_candidates: [{ evidence_id: "e1", block_id: "b1", text, quote: text.slice(offset), relation_to_selection: "anchor" }],
    } };
  }
  async function run() {
    const req = request(), evidence = Reasoning.evidenceFor(req);
    const draft = { target_type: "person", statements: [
      { id: "c1", part: "meaning", basis: "document", text: "说话人 1 是本次会议的参与者之一。", evidence_ids: ["e1"] },
      { id: "c2", part: "meaning", basis: "unknown", text: "具体身份未明确说明。", evidence_ids: [] },
    ] };
    const complete = async ({ messages }) => ({ model: "MOCK-NO-NETWORK",
      content: JSON.stringify(messages[0].content.includes("独立的语境主张核验器")
        ? { review_version: Reasoning.REVIEW_VERSION, checks: draft.statements.map((s) => ({ ...s, selection_fit: "current", supported: s.basis === "unknown", usefulness: s.basis === "unknown" ? "unknown" : "restatement",
          citations: [], reason: "预设核验：泛泛介绍未解释研究中心的资源协调工作" })),
          coverage: { status: "missing_supported_detail", missing: [{ detail: "原文可支持其参与资源协调工作", evidence_ids: ["e1"] }] } }
        : draft) });
    const outcome = await Reasoning.run(req, complete);
    return { mode: "offline-reproduction-with-mocked-model", model_requests_sent: 0,
      scope: "真实执行本地选区截取与验收代码；模型返回是预设数据，只用于复现诊断，不是模型效果评测。",
      checks: { selected_offset: req.documentContext.selection.start_offset,
        actual_quote_start: evidence[0].source_start,
        selected_occurrence_reached_model: evidence[0].quote.includes("07:20"),
        generic_answer_was_accepted: outcome.result.resolution.status === "clear",
        repair_attempts: outcome.trace.attempts },
      outcome, review: Audit.review(outcome.trace, outcome.result) };
  }
  return { request, run };
});

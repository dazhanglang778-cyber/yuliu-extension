const test = require("node:test");
const assert = require("node:assert/strict");
const ClaimVerification = require("../claim-verification.js");
const Grounding = require("../grounding.js");

function request(selection = "Harness") {
  return {
    selection,
    termKnowledge: { candidate_senses: [], external_sources: [] },
    documentContext: {
      evidence_candidates: [
        { evidence_id: "e1", block_id: "p1", role: "coreference_support", text: "随着模型能力与 Harness 设计共同发展，Agent 可以承担更复杂的任务。" },
        { evidence_id: "e2", block_id: "p2", role: "coreference_support", text: "这里只是再次提到 Harness。" },
        { evidence_id: "e3", block_id: "p3", role: "direct_support", text: "该工具在 16 个模型上完成测试。" },
      ],
      blocks: [
        { block_id: "p1", text: "随着模型能力与 Harness 设计共同发展，Agent 可以承担更复杂的任务。" },
        { block_id: "p2", text: "这里只是再次提到 Harness。" },
        { block_id: "p3", text: "该工具在 16 个模型上完成测试。" },
      ],
    },
  };
}

function baseResult() {
  return {
    schema_version: "2.0",
    selected_text: "Harness",
    candidate_senses: [{
      sense_id: "s1", label: "Agent运行框架", gloss: "组织Agent、工具和环境交互的外围工程系统",
      referent_type: "generic_concept", chinese_name: "智能体运行框架", english_full_name: null,
      supports: [{ source_kind: "model_knowledge" }],
    }],
    resolution: { status: "inferred", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "medium", specificity: "category" },
    meaning_here: { text: "Harness 在这里指支撑 Agent 运行的外围工程框架。", chinese_name: "智能体运行框架", english_full_name: null, contextual_role: null },
    author_intent: null,
    claims: [
      { claim_id: "c1", claim_type: "lexical_knowledge", text: "Harness可以指Agent运行框架", supports: [{ source_kind: "model_knowledge" }] },
      { claim_id: "c2", claim_type: "contextual_mapping", text: "本文采用Agent运行框架义项", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
    ],
    page_evidence: [{ evidence_id: "e1", block_id: "p1", quote: "随着模型能力与 Harness 设计共同发展，Agent 可以承担更复杂的任务。", role: "coreference_support" }],
    external_sources: [],
    notice_code: "none",
  };
}

test("页面没有词典定义时，领域线索仍可支持当前义项映射", () => {
  const checked = ClaimVerification.verify(baseResult(), request());
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("孤立缩写只有同词出现时不能被强行展开为具体义项", () => {
  const result = baseResult();
  result.selected_text = "FDE";
  result.candidate_senses = [{
    sense_id: "s1", label: "实战营运营方法", gloss: "组织实战营发布和报名的一套方法",
    referent_type: "method", supports: [{ source_kind: "model_knowledge" }],
  }];
  result.meaning_here.text = "FDE 在这里指一种实战营运营方法。";
  result.claims[0].text = "FDE可以指一种运营方法";
  result.claims[1].text = "本文采用实战营运营方法义项";
  result.page_evidence = [{ evidence_id: "e1", block_id: "p1", quote: "北京2天FDE实战营，免费！", role: "coreference_support" }];
  const current = request("FDE");
  current.documentContext.evidence_candidates[0].text = "北京2天FDE实战营，免费！";
  current.documentContext.blocks[0].text = "北京2天FDE实战营，免费！";
  const checked = ClaimVerification.verify(result, current);
  assert.equal(checked.ok, false);
  assert.ok(checked.invalid_claim_ids.includes("c2"));
});

test("只提到术语不能支持额外生成作者意图", () => {
  const result = baseResult();
  result.claims.push({
    claim_id: "c3", claim_type: "author_intent", text: "作者强调Harness是成功关键",
    supports: [{ source_kind: "page_evidence", source_id: "e2" }],
  });
  result.author_intent = { text: "作者想强调Harness是成功关键。", claim_ids: ["c3"] };
  result.page_evidence.push({ evidence_id: "e2", block_id: "p2", quote: "这里只是再次提到 Harness。", role: "coreference_support" });
  const checked = ClaimVerification.verify(result, request());
  assert.equal(checked.ok, false);
  assert.ok(checked.invalid_claim_ids.includes("c3"));
});

test("高风险数字必须真实出现在直接证据中", () => {
  const result = baseResult();
  result.claims.push({
    claim_id: "c4", claim_type: "high_risk_fact", text: "该工具在30个模型上完成测试",
    supports: [{ source_kind: "page_evidence", source_id: "e3" }],
  });
  result.page_evidence.push({ evidence_id: "e3", block_id: "p3", quote: "该工具在 16 个模型上完成测试。", role: "direct_support" });
  const checked = ClaimVerification.verify(result, request());
  assert.equal(checked.ok, false);
  assert.ok(checked.invalid_claim_ids.includes("c4"));
});

test("模型不能把本地RAG判定的弱证据升级为直接证据", () => {
  const result = baseResult();
  result.page_evidence[0].role = "direct_support";
  const checked = Grounding.validateStructured(result, request());
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(checked.result.page_evidence[0].role, "coreference_support");
});

test("无依据具体化只删除高风险内容并保留低风险核心解释", () => {
  const result = baseResult();
  result.candidate_senses[0] = {
    ...result.candidate_senses[0], label: "DeepSeek Harness", gloss: "用于组织Agent运行的具体产品",
    referent_type: "product", english_full_name: "DeepSeek Harness",
  };
  result.resolution.specificity = "exact_variant";
  result.meaning_here = { text: "Harness 在这里就是 DeepSeek Harness 产品。", chinese_name: null, english_full_name: "DeepSeek Harness", contextual_role: null };
  result.claims.push({
    claim_id: "c4", claim_type: "high_risk_fact", text: "Harness就是DeepSeek Harness产品",
    supports: [{ source_kind: "page_evidence", source_id: "e1" }],
  });
  const validation = Grounding.validateStructured(result, request());
  assert.equal(validation.ok, false);
  const salvaged = Grounding.salvageLowRisk(validation, request());
  assert.ok(salvaged);
  assert.equal(salvaged.result.resolution.specificity, "category");
  assert.ok(!salvaged.result.meaning_here.text.includes("DeepSeek"));
  assert.ok(salvaged.result.claims.every((claim) => claim.claim_type !== "high_risk_fact"));
});

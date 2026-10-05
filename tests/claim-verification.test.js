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

test("页面直接给出MCP全称时可支持缩写义项映射", () => {
  const current = request("MCP");
  current.documentContext.evidence_candidates[0] = {
    evidence_id: "e1", block_id: "p1", role: "direct_support",
    text: "MCP 是模型上下文协议（Model Context Protocol）的简称，是连接外部数据源和工具的开放协议。",
  };
  current.documentContext.blocks[0] = { block_id: "p1", text: current.documentContext.evidence_candidates[0].text };
  const result = baseResult();
  result.selected_text = "MCP";
  result.candidate_senses = [{
    sense_id: "s1", label: "模型上下文协议", gloss: "让大模型以标准化方式连接外部数据源和工具的开放协议",
    referent_type: "generic_concept", chinese_name: "模型上下文协议", english_full_name: "Model Context Protocol",
    supports: [{ source_kind: "model_knowledge" }],
  }];
  result.meaning_here = { text: "MCP 在这里指模型上下文协议。", chinese_name: "模型上下文协议", english_full_name: "Model Context Protocol", contextual_role: null };
  result.claims = [
    { claim_id: "c1", claim_type: "lexical_knowledge", text: "MCP 是模型上下文协议", supports: [{ source_kind: "model_knowledge" }] },
    { claim_id: "c2", claim_type: "contextual_mapping", text: "本文采用模型上下文协议义项", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
  ];
  result.page_evidence = [{ evidence_id: "e1", block_id: "p1", quote: current.documentContext.evidence_candidates[0].text, role: "direct_support" }];
  const checked = ClaimVerification.verify(result, current);
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("外部资料核验缩写身份后，页面领域线索可完成WSD", () => {
  const current = request("MCP");
  current.documentContext.evidence_candidates[0] = {
    evidence_id: "e1", block_id: "p1", role: "coreference_support",
    text: "Agent、MCP 与传统 RPC/HTTP 在交互协议和授权流程上存在差异。",
  };
  current.documentContext.blocks[0] = { block_id: "p1", text: current.documentContext.evidence_candidates[0].text };
  current.termKnowledge.external_sources = [{
    source_id: "x1", title: "Model Context Protocol", url: "https://example.org/mcp",
    publisher: "Protocol documentation", excerpt: "Model Context Protocol is an open protocol for connecting AI applications to external tools and data.",
  }];
  const result = baseResult();
  result.selected_text = "MCP";
  result.candidate_senses = [{
    sense_id: "s1", label: "模型上下文协议", gloss: "连接AI应用、外部工具和数据的开放协议",
    referent_type: "generic_concept", chinese_name: "模型上下文协议", english_full_name: "Model Context Protocol",
    supports: [{ source_kind: "external_source", source_id: "x1" }],
  }];
  result.meaning_here = { text: "MCP 在这里指模型上下文协议。", chinese_name: "模型上下文协议", english_full_name: "Model Context Protocol", contextual_role: null };
  result.claims = [
    { claim_id: "c1", claim_type: "lexical_knowledge", text: "MCP 是 Model Context Protocol，即模型上下文协议", supports: [{ source_kind: "external_source", source_id: "x1" }] },
    { claim_id: "c2", claim_type: "contextual_mapping", text: "本文采用模型上下文协议义项", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
  ];
  result.page_evidence = [{ evidence_id: "e1", block_id: "p1", quote: current.documentContext.evidence_candidates[0].text, role: "coreference_support" }];
  result.external_sources = [current.termKnowledge.external_sources[0]];
  const checked = ClaimVerification.verify(result, current);
  assert.equal(checked.ok, true, JSON.stringify(checked));
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

test("普通词在候选义项低歧义且正文明确使用时，不要求原文重复词典定义", () => {
  const current = request("故障");
  current.termKnowledge = { knowledge_confidence: "high", ambiguity: "low", candidate_senses: [], external_sources: [] };
  current.documentContext.evidence_candidates[0] = {
    evidence_id: "e1", block_id: "p1", role: "coreference_support",
    text: "智能复盘Agent的核心使命，是将每一次故障都转化为可预测、可预防的洞察。",
  };
  const result = baseResult();
  result.selected_text = "故障";
  result.candidate_senses = [{
    sense_id: "s1", label: "系统异常", gloss: "系统或服务未能按预期正常运行的状态",
    referent_type: "generic_concept", supports: [{ source_kind: "model_knowledge" }],
  }];
  result.meaning_here.text = "“故障”在这里指系统或服务出现异常、未能正常运行的情况。";
  result.claims = [
    { claim_id: "c1", claim_type: "lexical_knowledge", text: "故障是系统或服务未能正常运行的状态", supports: [{ source_kind: "model_knowledge" }] },
    { claim_id: "c2", claim_type: "contextual_mapping", text: "本文在系统异常的意义上使用故障", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
  ];
  result.page_evidence = [{ evidence_id: "e1", block_id: "p1", quote: current.documentContext.evidence_candidates[0].text, role: "coreference_support" }];
  const checked = ClaimVerification.verify(result, current);
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("高置信常见缩写可由模型候选池定身份，再由页面语境完成映射", () => {
  const current = request("API");
  current.termKnowledge = {
    term_type: "acronym", knowledge_confidence: "high", ambiguity: "low", external_sources: [],
    candidate_senses: [{ sense_id: "s1", label: "应用程序编程接口", gloss: "软件之间交互和交换数据的接口", supports: [{ source_kind: "model_knowledge" }] }],
  };
  current.documentContext.evidence_candidates[0] = {
    evidence_id: "e1", block_id: "p1", role: "coreference_support",
    text: "Task Expert 会调用外部 API 获取实时数据，并查询 RAG 知识库。",
  };
  const result = baseResult();
  result.selected_text = "API";
  result.candidate_senses = [{
    sense_id: "s1", label: "应用程序编程接口", gloss: "软件之间交互和交换数据的接口",
    referent_type: "generic_concept", english_full_name: "Application Programming Interface",
    supports: [{ source_kind: "model_knowledge" }],
  }];
  result.meaning_here = { text: "“API”在这里指供系统调用外部服务并获取数据的应用程序编程接口。", chinese_name: "应用程序编程接口", english_full_name: "Application Programming Interface", contextual_role: null };
  result.claims = [
    { claim_id: "c1", claim_type: "lexical_knowledge", text: "API 是应用程序编程接口", supports: [{ source_kind: "model_knowledge" }] },
    { claim_id: "c2", claim_type: "contextual_mapping", text: "这里的 API 用于调用外部服务并获取数据", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
  ];
  result.page_evidence = [{ evidence_id: "e1", block_id: "p1", quote: current.documentContext.evidence_candidates[0].text, role: "coreference_support" }];
  const checked = ClaimVerification.verify(result, current);
  assert.equal(checked.ok, true, JSON.stringify(checked));
});

test("冒充语境解释的泛化优雅降级会被拒绝，而压缩失败回退义项会通过", () => {
  const current = request("优雅降级");
  current.documentContext.evidence_candidates[0] = {
    evidence_id: "e1", block_id: "p1", role: "direct_support",
    text: "优雅降级：如果多次压缩尝试都失败，回退到保守的消息截断策略，保留最近的30%对话历史，确保上下文连续性。",
  };
  const result = baseResult();
  result.selected_text = "优雅降级";
  result.candidate_senses = [{
    sense_id: "s1", label: "系统降级策略", gloss: "资源不足时减少服务复杂度以维持基本功能",
    referent_type: "method", supports: [{ source_kind: "model_knowledge" }],
  }];
  result.meaning_here.text = "“优雅降级”在这里指资源不足时减少服务范围以维持基本功能。";
  result.claims = [
    { claim_id: "c1", claim_type: "lexical_knowledge", text: "优雅降级是一种系统降级策略", supports: [{ source_kind: "model_knowledge" }] },
    { claim_id: "c2", claim_type: "contextual_mapping", text: "这里通过减少服务范围维持基本功能", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
  ];
  result.page_evidence = [{ evidence_id: "e1", block_id: "p1", quote: current.documentContext.evidence_candidates[0].text, role: "direct_support" }];
  const generic = ClaimVerification.verify(result, current);
  assert.equal(generic.ok, false);
  assert.ok(generic.invalid_claim_ids.includes("c2"));

  result.candidate_senses[0].gloss = "多次对话压缩失败后回退到保守截断，并保留最近一部分历史以维持上下文连续性";
  result.meaning_here.text = "“优雅降级”在这里指多次压缩失败后改用保守截断，并保留最近30%的对话历史。";
  result.claims[1].text = "这里在多次压缩失败后回退到保守截断并保留最近对话历史";
  const contextual = ClaimVerification.verify(result, current);
  assert.equal(contextual.ok, true, JSON.stringify(contextual));
});

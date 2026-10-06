const test = require("node:test");
const assert = require("node:assert/strict");
const Grounding = require("../grounding.js");

function request(selection = "Harness") {
  return {
    selection,
    termKnowledge: {
      candidate_senses: [
        { sense_id: "s1", label: "Agent运行框架", gloss: "组织Agent、工具和环境交互的外围工程系统", referent_type: "generic_concept", supports: [{ source_kind: "model_knowledge" }] },
        { sense_id: "s2", label: "挽具", gloss: "固定或保护人和物体的带具", referent_type: "generic_concept", supports: [{ source_kind: "model_knowledge" }] },
      ],
      external_sources: [],
    },
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
    schema_version: "2.0",
    selected_text: "Harness",
    candidate_senses: [
      {
        sense_id: "s1", label: "Agent运行框架", gloss: "组织Agent、工具和环境交互的外围工程系统",
        referent_type: "generic_concept", chinese_name: "Agent运行框架", english_full_name: null,
        supports: [{ source_kind: "model_knowledge" }, { source_kind: "page_evidence", source_id: "e1" }],
      },
      {
        sense_id: "s2", label: "挽具", gloss: "固定或保护人和物体的带具",
        referent_type: "generic_concept", chinese_name: "挽具", english_full_name: null,
        supports: [{ source_kind: "model_knowledge" }],
      },
    ],
    resolution: { status: "clear", selected_sense_id: "s1", alternative_sense_ids: ["s2"], confidence: "high", specificity: "category" },
    meaning_here: { text: "Harness 在这里指组织 Agent 与环境交互、执行任务并接收反馈的一套运行框架。", chinese_name: "Agent运行框架", english_full_name: null, contextual_role: "支撑任务执行" },
    author_intent: null,
    claims: [
      { claim_id: "c1", claim_type: "lexical_knowledge", text: "Harness可以指Agent运行框架", supports: [{ source_kind: "model_knowledge" }] },
      { claim_id: "c2", claim_type: "contextual_mapping", text: "本文使用Agent运行框架义项", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
    ],
    page_evidence: [{ evidence_id: "e1", block_id: "p-4", quote: "Harness 是组织 Agent 与环境交互、执行任务并接收反馈的一套运行框架。", role: "direct_support" }],
    external_sources: [],
    notice_code: "none",
    ...overrides,
  };
}

test("第二版双通道结果可以区分模型知识与页面映射", () => {
  const checked = Grounding.validateStructured(validResult(), request());
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(checked.result.schema_version, "2.0");
  assert.equal(checked.result.author_intent, null);
  assert.deepEqual(checked.result.page_evidence[0].heading_path, []);
});

test("同页出现的DeepSeek Harness不能冒充当前Harness的具体身份", () => {
  const value = validResult({
    candidate_senses: [{
      sense_id: "s3", label: "DeepSeek Harness（DSH）", gloss: "具体产品",
      referent_type: "product", chinese_name: null, english_full_name: "DeepSeek Harness",
      supports: [{ source_kind: "page_evidence", source_id: "e3" }],
    }],
    resolution: { status: "clear", selected_sense_id: "s3", alternative_sense_ids: [], confidence: "high", specificity: "exact_variant" },
    meaning_here: { text: "Harness 在这里指 DeepSeek Harness（DSH）这一具体产品。", chinese_name: null, english_full_name: "DeepSeek Harness", contextual_role: null },
    claims: [
      { claim_id: "c1", claim_type: "contextual_mapping", text: "本文指DeepSeek Harness", supports: [{ source_kind: "page_evidence", source_id: "e3" }] },
      { claim_id: "c2", claim_type: "high_risk_fact", text: "Harness就是DeepSeek Harness产品", supports: [{ source_kind: "page_evidence", source_id: "e3" }] },
    ],
    page_evidence: [{ evidence_id: "e3", block_id: "p-6", quote: "产品清单还列出了 DeepSeek Harness（DSH）和 Atlas。", role: "coreference_support" }],
  });
  const checked = Grounding.validateStructured(value, request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.some((item) => item.includes("HIGH_RISK_WITHOUT_VERIFIED_SUPPORT")));
});

test("经过候选池传入的外部来源可以支持高风险全称", () => {
  const current = request("Harness");
  current.termKnowledge.external_sources = [{
    source_id: "x1",
    title: "Harness Engineering Glossary",
    url: "https://example.org/harness",
    publisher: "Engineering Institute",
    excerpt: "Harness can denote an agent runtime framework.",
    status: "candidate_unverified",
  }];
  const value = validResult({
    candidate_senses: [{
      sense_id: "s1", label: "Agent Harness", gloss: "Agent运行框架",
      referent_type: "product", chinese_name: "智能体运行框架", english_full_name: "Agent Harness",
      supports: [{ source_kind: "external_source", source_id: "x1" }, { source_kind: "page_evidence", source_id: "e1" }],
    }],
    resolution: { status: "clear", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "high", specificity: "exact_variant" },
    meaning_here: { text: "Harness 在这里指 Agent Harness 这一运行框架。", chinese_name: "智能体运行框架", english_full_name: "Agent Harness", contextual_role: null },
    claims: [
      { claim_id: "c1", claim_type: "contextual_mapping", text: "本文使用Agent运行框架义项", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
      { claim_id: "c2", claim_type: "high_risk_fact", text: "该名称可写作Agent Harness", supports: [{ source_kind: "external_source", source_id: "x1" }] },
    ],
    external_sources: [{ source_id: "x1", title: "会被程序替换", url: "https://wrong.example", publisher: null, excerpt: null }],
  });
  const checked = Grounding.validateStructured(value, current);
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(checked.result.external_sources[0].url, "https://example.org/harness");
});

test("模型只选择证据ID，程序用本地RAG原文覆盖模型改写的引文", () => {
  const value = validResult();
  value.page_evidence[0].quote = "Harness 是专门为 DeepSeek 打造的运行框架。";
  const checked = Grounding.validateStructured(value, request());
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(checked.result.page_evidence[0].quote, request().documentContext.evidence_candidates[0].text);
});

test("模型照抄义项占位词时恢复候选池中的真实名称", () => {
  const value = validResult();
  value.candidate_senses[0].label = "中性义项名";
  value.candidate_senses[0].gloss = "不依赖本文也成立的简释";
  const checked = Grounding.validateStructured(value, request());
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(checked.result.candidate_senses[0].label, "Agent运行框架");
  assert.equal(checked.result.candidate_senses[0].gloss, "组织Agent、工具和环境交互的外围工程系统");
});

test("模型引用本地RAG候选池之外的证据ID仍会被拒绝", () => {
  const value = validResult();
  value.claims[1].supports[0].source_id = "e404";
  const checked = Grounding.validateStructured(value, request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("UNKNOWN_PAGE_EVIDENCE:e404"));
});

test("模型多返回但未被任何主张采用的证据会被丢弃而不拖垮答案", () => {
  const value = validResult();
  value.page_evidence.push({ evidence_id: "e404", block_id: "wrong", quote: "模型自行补写的无关引文", role: "direct_support" });
  const checked = Grounding.validateStructured(value, request());
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.deepEqual(checked.result.page_evidence.map((item) => item.evidence_id), ["e1"]);
});

test("页面原文已出现的专名不会被误判为无依据具体化", () => {
  const current = request("Ask任务");
  current.termKnowledge = {
    term_type: "mixed_term", knowledge_confidence: "medium", ambiguity: "low", external_sources: [],
    candidate_senses: [{
      sense_id: "s1", label: "询问型任务", gloss: "由系统识别为询问或分析需求的一类任务",
      referent_type: "method", supports: [{ source_kind: "model_knowledge" }],
    }],
  };
  current.documentContext.blocks = [{ block_id: "p-ask", text: "Plan Agent首先解析用户意图，决定这是一个Ask任务还是一个专业Agent任务。" }];
  current.documentContext.evidence_candidates = [{ evidence_id: "e-ask", block_id: "p-ask", role: "coreference_support", text: current.documentContext.blocks[0].text }];
  const value = {
    schema_version: "2.0",
    selected_text: "Ask任务",
    candidate_senses: current.termKnowledge.candidate_senses,
    resolution: { status: "inferred", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "medium", specificity: "category" },
    meaning_here: { text: "“Ask任务”在这里指由 Plan Agent 识别出的询问或分析型任务。", chinese_name: "询问型任务", english_full_name: null, contextual_role: null },
    author_intent: null,
    claims: [
      { claim_id: "c1", claim_type: "lexical_knowledge", text: "Ask任务可指询问型任务", supports: [{ source_kind: "model_knowledge" }] },
      { claim_id: "c2", claim_type: "contextual_mapping", text: "这里由 Plan Agent 判断是否属于 Ask任务", supports: [{ source_kind: "page_evidence", source_id: "e-ask" }] },
    ],
    page_evidence: [{ evidence_id: "e-ask" }],
    external_sources: [],
    notice_code: "none",
  };
  const checked = Grounding.validateStructured(value, current);
  assert.equal(checked.ok, true, checked.errors.join(", "));
});

test("作者意图允许为空且不得复制这里指什么", () => {
  assert.equal(Grounding.validateStructured(validResult({ author_intent: null }), request()).ok, true);
  assert.equal(Grounding.validateStructured(validResult({ author_intent: { text: null } }), request()).ok, true);
  const duplicated = validResult({
    author_intent: { text: "Harness 在这里指组织 Agent 与环境交互、执行任务并接收反馈的一套运行框架。", claim_ids: ["c3"] },
    claims: [...validResult().claims, { claim_id: "c3", claim_type: "author_intent", text: "作者说明Harness的含义", supports: [{ source_kind: "page_evidence", source_id: "e1" }] }],
  });
  const checked = Grounding.validateStructured(duplicated, request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("AUTHOR_INTENT_DUPLICATES_MEANING"));
});

test("可选作者意图结构出错时只删除该板块，不重写已通过的核心解释", () => {
  const value = validResult({ author_intent: { text: "作者进一步强调这一框架很重要。", claim_ids: [] } });
  const validation = Grounding.validateStructured(value, request());
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.includes("AUTHOR_INTENT_WITHOUT_MATCHING_CLAIM"));
  const salvaged = Grounding.salvageLowRisk(validation, request());
  assert.ok(salvaged);
  assert.equal(salvaged.result.author_intent, null);
  assert.equal(salvaged.result.meaning_here.text, value.meaning_here.text);
});

test("有证据推断不显示含糊警告", () => {
  const inferred = validResult({ resolution: { status: "inferred", selected_sense_id: "s1", alternative_sense_ids: ["s2"], confidence: "medium", specificity: "category" } });
  assert.equal(Grounding.validateStructured(inferred, request()).ok, true);
  inferred.notice_code = "insufficient_context";
  const checked = Grounding.validateStructured(inferred, request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("NOTICE_FALSE_POSITIVE"));
});

test("真正多义时保留至少两个候选且不偷选", () => {
  const ambiguous = validResult({
    resolution: { status: "ambiguous", selected_sense_id: null, alternative_sense_ids: ["s1", "s2"], confidence: "low", specificity: "category" },
    meaning_here: { text: "Harness 在这里仍可能指 Agent 运行框架或其他类型的配套系统。", chinese_name: null, english_full_name: null, contextual_role: null },
    notice_code: "multiple_senses",
  });
  assert.equal(Grounding.validateStructured(ambiguous, request()).ok, true);
});

test("选中词必须逐项与当前请求一致", () => {
  const checked = Grounding.validateStructured(validResult({ selected_text: "DeepSeek Harness" }), request());
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("SELECTED_TEXT_MISMATCH"));
});

test("两次校验失败后保留候选知识但不猜当前义项", () => {
  const fallback = Grounding.fallbackResult(request());
  assert.equal(fallback.schema_version, "2.0");
  assert.equal(fallback.resolution.status, "insufficient");
  assert.equal(fallback.resolution.selected_sense_id, null);
  assert.ok(fallback.candidate_senses.length >= 2);
  assert.equal(fallback.author_intent, null);
});

test("模型生成暂时失败时，高置信单义普通术语可由候选知识安全兜底", () => {
  const current = request("API");
  current.termKnowledge = {
    term_type: "acronym", knowledge_confidence: "high", ambiguity: "low", external_sources: [],
    candidate_senses: [{
      sense_id: "s1", label: "应用程序编程接口", gloss: "供不同软件调用功能并交换数据的接口",
      referent_type: "generic_concept", chinese_name: "应用程序编程接口",
      english_full_name: "Application Programming Interface", supports: [{ source_kind: "model_knowledge" }],
    }],
  };
  current.documentContext.selection = { raw_text: "API", anchor_block_id: "p-api" };
  current.documentContext.blocks = [{ block_id: "p-api", text: "调用外部API获取实时数据。" }];
  current.documentContext.evidence_candidates = [{ evidence_id: "e-api", block_id: "p-api", role: "coreference_support", text: "调用外部API获取实时数据。" }];
  const fallback = Grounding.knowledgeFallbackResult(current);
  assert.ok(fallback);
  assert.equal(fallback.resolution.status, "inferred");
  assert.equal(fallback.meaning_here.chinese_name, "应用程序编程接口");
  assert.equal(fallback.page_evidence[0].quote, "调用外部API获取实时数据。");
});

test("只引用选区标题时，程序会补入远处的说明性原文依据", () => {
  const current = request("保鲜策略");
  current.termKnowledge = {
    term_type: "common_term", knowledge_confidence: "high", ambiguity: "low", external_sources: [],
    candidate_senses: [{
      sense_id: "s1", label: "内存保鲜策略", gloss: "管理内存信息并维持其有效性和相关性的策略",
      referent_type: "method", supports: [{ source_kind: "model_knowledge" }],
    }],
  };
  current.documentContext.selection = { raw_text: "保鲜策略", anchor_block_id: "p-anchor" };
  current.documentContext.blocks = [
    { block_id: "p-anchor", text: "3. Memory保鲜策略" },
    { block_id: "p-support", text: "因此，我们对上下文进行减噪、提要、保鲜，确保留下的信息具有高价值、长期性和强推理作用。" },
  ];
  current.documentContext.evidence_candidates = [
    { evidence_id: "e1", block_id: "p-anchor", role: "coreference_support", text: "3. Memory保鲜策略", signals: { anchor: true, variantOccurrences: 0 } },
    { evidence_id: "e2", block_id: "p-support", role: "coreference_support", text: "因此，我们对上下文进行减噪、提要、保鲜，确保留下的信息具有高价值、长期性和强推理作用。", signals: { anchor: false, variantOccurrences: 1 } },
  ];
  const value = {
    schema_version: "2.0",
    selected_text: "保鲜策略",
    candidate_senses: current.termKnowledge.candidate_senses,
    resolution: { status: "inferred", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "medium", specificity: "category" },
    meaning_here: { text: "“保鲜策略”在这里指维护Memory中关键信息有效性和相关性的策略。", chinese_name: "内存保鲜策略", english_full_name: null, contextual_role: null },
    author_intent: null,
    claims: [
      { claim_id: "c1", claim_type: "lexical_knowledge", text: "保鲜策略用于维持内存信息的有效性和相关性", supports: [{ source_kind: "model_knowledge" }] },
      { claim_id: "c2", claim_type: "contextual_mapping", text: "这里的保鲜策略用于维护上下文中的重要信息", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
    ],
    page_evidence: [{ evidence_id: "e1" }],
    external_sources: [],
    notice_code: "none",
  };
  const checked = Grounding.validateStructured(value, current);
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.deepEqual(checked.result.page_evidence.map((item) => item.evidence_id), ["e1", "e2"]);
  assert.ok(checked.result.page_evidence[1].quote.includes("减噪、提要、保鲜"));
});

test("已有第二个同词位置但不够说明含义时，仍补入真正的说明性依据", () => {
  const current = request("Memory");
  current.termKnowledge = {
    term_type: "common_term", knowledge_confidence: "high", ambiguity: "low", external_sources: [],
    candidate_senses: [{
      sense_id: "s1", label: "Agent记忆机制", gloss: "Agent用于保存和管理任务上下文的信息机制",
      referent_type: "generic_concept", supports: [{ source_kind: "model_knowledge" }],
    }],
  };
  current.documentContext.selection = { raw_text: "Memory", anchor_block_id: "p-anchor" };
  current.documentContext.blocks = [
    { block_id: "p-anchor", text: "4.2 Memory管理机制" },
    { block_id: "p-mention", text: "下面继续介绍Memory。" },
    { block_id: "p-support", text: "Memory为智能体的工作台，用于管理多轮任务中持续积累的上下文。" },
  ];
  current.documentContext.evidence_candidates = [
    { evidence_id: "e1", block_id: "p-anchor", role: "coreference_support", text: current.documentContext.blocks[0].text, signals: { anchor: true } },
    { evidence_id: "e2", block_id: "p-mention", role: "coreference_support", text: current.documentContext.blocks[1].text, signals: { exactOccurrences: 1 } },
    { evidence_id: "e3", block_id: "p-support", role: "direct_support", text: current.documentContext.blocks[2].text, signals: { definition: 2 } },
  ];
  const value = {
    schema_version: "2.0", selected_text: "Memory", candidate_senses: current.termKnowledge.candidate_senses,
    resolution: { status: "inferred", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "high", specificity: "category" },
    meaning_here: { text: "“Memory”在这里指Agent的上下文与记忆管理机制。", chinese_name: "Agent记忆机制", english_full_name: null, contextual_role: null },
    author_intent: null,
    claims: [
      { claim_id: "c1", claim_type: "lexical_knowledge", text: "Memory是Agent的上下文与记忆管理机制", supports: [{ source_kind: "model_knowledge" }] },
      { claim_id: "c2", claim_type: "contextual_mapping", text: "这里采用Agent记忆机制义项", supports: [{ source_kind: "page_evidence", source_id: "e1" }, { source_kind: "page_evidence", source_id: "e2" }] },
    ],
    page_evidence: [{ evidence_id: "e1" }, { evidence_id: "e2" }], external_sources: [], notice_code: "none",
  };
  const checked = Grounding.validateStructured(value, current);
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.ok(checked.result.page_evidence.some((item) => item.evidence_id === "e3"));
});

test("知识兜底也优先展示说明性段落，并保留当前选区用于定位", () => {
  const current = request("保鲜策略");
  current.termKnowledge = {
    term_type: "common_term", knowledge_confidence: "high", ambiguity: "low", external_sources: [],
    candidate_senses: [{
      sense_id: "s1", label: "内存保鲜策略", gloss: "管理内存信息并维持其有效性和相关性的策略",
      referent_type: "method", chinese_name: "内存保鲜策略", english_full_name: null,
      supports: [{ source_kind: "model_knowledge" }],
    }],
  };
  current.documentContext.selection = { raw_text: "保鲜策略", anchor_block_id: "p-anchor" };
  current.documentContext.blocks = [
    { block_id: "p-anchor", text: "3. Memory保鲜策略" },
    { block_id: "p-support", text: "因此，我们对上下文进行减噪、提要、保鲜，确保留下的信息具有高价值、长期性和强推理作用。" },
  ];
  current.documentContext.evidence_candidates = [
    { evidence_id: "e1", block_id: "p-anchor", role: "coreference_support", text: "3. Memory保鲜策略", signals: { anchor: true } },
    { evidence_id: "e2", block_id: "p-support", role: "coreference_support", text: "因此，我们对上下文进行减噪、提要、保鲜，确保留下的信息具有高价值、长期性和强推理作用。", signals: { variantOccurrences: 1 } },
  ];
  const fallback = Grounding.knowledgeFallbackResult(current);
  assert.ok(fallback);
  assert.deepEqual(fallback.page_evidence.map((item) => item.evidence_id), ["e1", "e2"]);
  assert.equal(fallback.page_evidence[0].display_purpose, "current_location");
  assert.equal(fallback.page_evidence[1].display_purpose, "meaning_support");
});

test("稳定语义内核与当前位置侧重会被合成为自然的两句解释", () => {
  const current = request("Memory");
  current.termKnowledge = {
    term_type: "common_term", knowledge_confidence: "high", ambiguity: "low", external_sources: [],
    candidate_senses: [{
      sense_id: "s1", label: "Agent记忆机制", gloss: "Agent用于保存和管理任务上下文的信息机制",
      referent_type: "generic_concept", supports: [{ source_kind: "model_knowledge" }],
    }],
  };
  current.documentContext.selection = { raw_text: "Memory", anchor_block_id: "p-anchor" };
  current.documentContext.blocks = [
    { block_id: "p-anchor", text: "在智能复盘Agent中，Memory为智能体的工作台。" },
    { block_id: "p-definition", text: "Agent的上下文会迅速膨胀，因此需要通过减噪、提要、保鲜管理Memory。" },
  ];
  current.documentContext.evidence_candidates = [
    { evidence_id: "e1", block_id: "p-anchor", role: "direct_support", text: current.documentContext.blocks[0].text, signals: { anchor: true, definition: 2 } },
    { evidence_id: "e2", block_id: "p-definition", role: "coreference_support", text: current.documentContext.blocks[1].text, signals: { anchor: false } },
  ];
  const value = {
    schema_version: "2.0",
    selected_text: "Memory",
    candidate_senses: current.termKnowledge.candidate_senses,
    resolution: { status: "inferred", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "high", specificity: "category" },
    meaning_here: {
      text: "备用文本",
      semantic_core: "Agent 的上下文与记忆管理机制，用来保存、组织和更新多轮任务中需要持续使用的信息",
      local_focus: "作者在此把它称为智能体的“工作台”",
      chinese_name: "Agent记忆机制", english_full_name: null, contextual_role: null,
    },
    author_intent: null,
    claims: [
      { claim_id: "c1", claim_type: "lexical_knowledge", text: "Memory是Agent的上下文与记忆管理机制", supports: [{ source_kind: "model_knowledge" }] },
      { claim_id: "c2", claim_type: "contextual_mapping", text: "此处把Memory称为智能体的工作台", supports: [{ source_kind: "page_evidence", source_id: "e1" }, { source_kind: "page_evidence", source_id: "e2" }] },
    ],
    page_evidence: [{ evidence_id: "e1" }, { evidence_id: "e2" }],
    external_sources: [], notice_code: "none",
  };
  const checked = Grounding.validateStructured(value, current);
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(checked.result.meaning_here.text, "“Memory”在这里指Agent 的上下文与记忆管理机制，用来保存、组织和更新多轮任务中需要持续使用的信息。作者在此把它称为智能体的“工作台”。");
  assert.deepEqual(checked.result.page_evidence.map((item) => item.display_purpose), ["current_location", "meaning_support"]);
});

test("页面快速通道允许模型用原文建立Memory管理这一文档内义项", () => {
  const current = request("Memory管理");
  current.termKnowledge = {
    term_type: "document_defined_term", knowledge_confidence: "high", ambiguity: "low",
    candidate_senses: [], external_sources: [], strategy: "page_definition_fast_path",
  };
  current.documentContext.selection = { raw_text: "Memory管理", anchor_block_id: "p-heading" };
  current.documentContext.blocks = [
    { block_id: "p-heading", text: "4.2.2. Memory管理：降噪→提要→保鲜" },
    { block_id: "p-process", text: "目前，智能复盘Agent的Memory管理采用三步法，在Agent运行时动态管理上下文。" },
    { block_id: "p-definition", text: "我们构建了智能Memory管理机制，通过减噪、提要、保鲜三步，实现上下文的精炼化、结构化和价值化。" },
  ];
  current.documentContext.evidence_candidates = [
    { evidence_id: "e1", block_id: "p-heading", role: "direct_support", text: current.documentContext.blocks[0].text, signals: { anchor: true, definition: 2 } },
    { evidence_id: "e2", block_id: "p-process", role: "coreference_support", text: current.documentContext.blocks[1].text, signals: { exactOccurrences: 1 } },
    { evidence_id: "e4", block_id: "p-definition", role: "direct_support", text: current.documentContext.blocks[2].text, signals: { definition: 2 } },
  ];
  const value = {
    schema_version: "2.0", selected_text: "Memory管理",
    candidate_senses: [{
      sense_id: "s1", label: "智能复盘Agent的上下文管理机制",
      gloss: "通过降噪、提要、保鲜动态管理Agent运行时的上下文信息",
      referent_type: "document_defined_term", chinese_name: null, english_full_name: null,
      supports: [
        { source_kind: "page_evidence", source_id: "e1" },
        { source_kind: "page_evidence", source_id: "e2" },
        { source_kind: "page_evidence", source_id: "e4" },
      ],
    }],
    resolution: { status: "clear", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "high", specificity: "category" },
    meaning_here: {
      text: "“Memory管理”在这里指智能复盘Agent的上下文管理机制。",
      semantic_core: "智能复盘Agent的上下文与记忆管理机制，用来持续整理任务中的关键信息",
      local_focus: "当前章节把它具体分为降噪、提要、保鲜三步",
      chinese_name: null, english_full_name: null, contextual_role: null,
    },
    author_intent: null,
    claims: [{
      claim_id: "c1", claim_type: "contextual_mapping",
      text: "Memory管理采用三步法动态管理Agent上下文",
      supports: [{ source_kind: "page_evidence", source_id: "e2" }],
    }],
    page_evidence: [{ evidence_id: "e1" }, { evidence_id: "e2" }, { evidence_id: "e4" }],
    external_sources: [], notice_code: "none",
  };
  const checked = Grounding.validateStructured(value, current);
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.match(checked.result.meaning_here.text, /上下文与记忆管理机制/);
  assert.deepEqual(checked.result.page_evidence.map((item) => item.evidence_id), ["e1", "e4", "e2"]);
  assert.equal(checked.result.page_evidence[1].display_purpose, "meaning_support");
});

test("生成提示明确拆分WSD、两种可见内容和三类来源", () => {
  const messages = Grounding.buildMessages(request());
  const prompt = JSON.stringify(messages);
  assert.ok(prompt.includes("WSD"));
  assert.ok(prompt.includes("稳定语义内核"));
  assert.ok(prompt.includes("当前位置侧重"));
  assert.ok(prompt.includes("这里指什么"));
  assert.ok(prompt.includes("作者想表达什么"));
  assert.ok(prompt.includes("model_knowledge"));
  assert.ok(prompt.includes("page_evidence"));
  assert.ok(prompt.includes("external_source"));
});

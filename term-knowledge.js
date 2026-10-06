(function attachYuliuTermKnowledge(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuTermKnowledge = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createTermKnowledge() {
  const TERM_TYPES = new Set(["common_term", "acronym", "named_entity", "mixed_term", "document_defined_term", "unknown"]);
  const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
  const AMBIGUITY_LEVELS = new Set(["low", "medium", "high"]);
  const RISK_LEVELS = new Set(["ordinary", "high"]);
  const REFERENT_TYPES = new Set([
    "generic_concept", "organization", "product", "person", "method", "metric", "document_defined_term", "other",
  ]);

  function text(value, maximum = 240) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function extractJson(raw) {
    if (raw && typeof raw === "object") return raw;
    const value = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(value); } catch (_) {}
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(value.slice(start, end + 1)); } catch (_) { return null; }
  }

  function pageHasDirectDefinition(request = {}) {
    return (request.documentContext?.evidence_candidates || []).some((item) => item?.role === "direct_support");
  }

  function contextHints(request = {}) {
    const candidates = Array.isArray(request.documentContext?.evidence_candidates)
      ? request.documentContext.evidence_candidates
      : [];
    return candidates.slice(0, 6).map((item) => ({
      role: text(item?.role, 40),
      heading_path: Array.isArray(item?.heading_path) ? item.heading_path.map((part) => text(part, 80)).filter(Boolean) : [],
      text: text(item?.text, 420),
    }));
  }

  function buildPlanningMessages(request = {}) {
    const selection = text(request.selection, 160);
    const output = {
      normalized_term: "规范名称；无法规范化则保留原词",
      term_type: "common_term|acronym|named_entity|mixed_term|document_defined_term|unknown",
      knowledge_confidence: "high|medium|low",
      ambiguity: "low|medium|high",
      fact_risk: "ordinary|high",
      candidate_senses: [{
        sense_id: "s1",
        label: "中性义项名称",
        gloss: "不依赖本文也成立的一句简释",
        referent_type: "generic_concept|organization|product|person|method|metric|document_defined_term|other",
        chinese_name: "可靠中文名；没有则空",
        english_full_name: "仅可靠缩写全称；没有则空",
        aliases: ["常见别名"],
      }],
      retrieval_recommended: false,
      retrieval_reason: "需要核对什么；无需检索则空",
      search_terms: ["只含术语或领域名的中性检索词"],
    };
    const system = `你负责建立术语的候选义项池，不负责替用户选择当前义项，也不负责概括文章。可以使用可靠的模型已有知识。页面片段只用于发现本次可能相关的领域，不能被复制进通用释义，不能据此虚构专名、缩写全称或具体产品。列出真正不同的主要义项，不要把同义改写拆成多个义项。若一个普通词在当前专业领域已有稳定的领域义项，应把它作为独立候选，不能用更宽泛的日常义或硬件义覆盖；例如Agent语境中的Memory应与硬件RAM、人的记忆分别建候选。候选gloss要写清类别、核心功能和边界，使同一义项在页面不同位置仍能复用。普通且熟悉的概念不要求联网；只有知识把握低、缩写展开不确定、新兴或非标准术语、具体专名、候选冲突、时效性事实或其他高风险事实才建议检索。只输出JSON。`;
    const user = `【原词】\n${selection}\n\n【页面标题，仅作领域线索】\n${text(request.title || request.documentContext?.page?.title, 180)}\n\n【页面候选片段，仅作领域线索】\n${JSON.stringify(contextHints(request))}\n\n【输出结构】\n${JSON.stringify(output)}\n\n至少给出一个有把握的候选义项；确实无法识别时可以返回空数组并将knowledge_confidence设为low。候选gloss必须独立于当前页面成立。search_terms不得复制文章句子、作者观点或具体案例。`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  function fallbackPlan(request = {}) {
    const selected = text(request.selection, 160);
    const acronym = /^[A-Z][A-Z0-9.-]{1,7}$/.test(selected);
    return {
      normalized_term: selected,
      term_type: acronym ? "acronym" : "unknown",
      knowledge_confidence: "low",
      ambiguity: acronym ? "high" : "medium",
      fact_risk: acronym ? "high" : "ordinary",
      candidate_senses: [],
      retrieval_recommended: true,
      retrieval_reason: "候选义项规划失败，需要用外部资料补充术语知识",
      search_terms: [selected].filter(Boolean),
    };
  }

  function normalizePlan(raw, request = {}) {
    const value = extractJson(raw);
    if (!value || typeof value !== "object") return fallbackPlan(request);
    const selected = text(request.selection, 160);
    const candidates = [];
    const seen = new Set();
    for (const [index, item] of (Array.isArray(value.candidate_senses) ? value.candidate_senses : []).slice(0, 8).entries()) {
      const label = text(item?.label, 160);
      const gloss = text(item?.gloss, 320);
      if (!label || !gloss) continue;
      const key = `${label}|${gloss}`.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        sense_id: text(item?.sense_id, 40) || `s${index + 1}`,
        label,
        gloss,
        referent_type: REFERENT_TYPES.has(item?.referent_type) ? item.referent_type : "other",
        chinese_name: text(item?.chinese_name, 100),
        english_full_name: text(item?.english_full_name, 160),
        aliases: (Array.isArray(item?.aliases) ? item.aliases : []).map((alias) => text(alias, 100)).filter(Boolean).slice(0, 5),
        supports: [{ source_kind: "model_knowledge" }],
      });
    }
    const plan = {
      normalized_term: text(value.normalized_term, 160) || selected,
      term_type: TERM_TYPES.has(value.term_type) ? value.term_type : "unknown",
      knowledge_confidence: CONFIDENCE_LEVELS.has(value.knowledge_confidence) ? value.knowledge_confidence : "low",
      ambiguity: AMBIGUITY_LEVELS.has(value.ambiguity) ? value.ambiguity : candidates.length > 1 ? "medium" : "low",
      fact_risk: RISK_LEVELS.has(value.fact_risk) ? value.fact_risk : "ordinary",
      candidate_senses: candidates,
      retrieval_recommended: value.retrieval_recommended === true,
      retrieval_reason: text(value.retrieval_reason, 240),
      search_terms: (Array.isArray(value.search_terms) ? value.search_terms : []).map((term) => text(term, 100)).filter(Boolean).slice(0, 3),
    };
    if (!plan.candidate_senses.length) {
      plan.knowledge_confidence = "low";
      plan.retrieval_recommended = true;
    }
    return plan;
  }

  function decideRetrieval(plan, request = {}) {
    if (pageHasDirectDefinition(request) && plan?.fact_risk !== "high") {
      return { required: false, path: "page_definition_fast_path", reasons: ["页面已有直接定义"] };
    }
    const reasons = [];
    if (!plan?.candidate_senses?.length) reasons.push("缺少候选义项");
    if (plan?.knowledge_confidence === "low") reasons.push("模型知识把握较低");
    if (plan?.fact_risk === "high") reasons.push("包含高风险或需核验事实");
    if (["named_entity", "unknown"].includes(plan?.term_type)) reasons.push("专名或术语身份尚未稳定");
    if (plan?.term_type === "acronym" && plan?.knowledge_confidence !== "high") reasons.push("缩写全称尚未可靠确定");
    if (plan?.ambiguity === "high" && plan?.knowledge_confidence !== "high") reasons.push("候选义项冲突较大");
    if (plan?.retrieval_recommended) reasons.push(plan.retrieval_reason || "模型建议核对外部资料");
    return {
      required: reasons.length > 0,
      path: reasons.length ? "selective_retrieval" : "parametric_fast_path",
      reasons: [...new Set(reasons)],
    };
  }

  function buildSearchQuery(term, plan = {}) {
    const selected = text(term, 160);
    const additions = (plan.search_terms || [])
      .map((item) => text(item, 80))
      .filter((item) => item && item.toLocaleLowerCase() !== selected.toLocaleLowerCase())
      .slice(0, 2);
    if (!additions.length && plan.term_type === "acronym") additions.push("acronym meaning");
    return [selected, ...additions].join(" ").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  function knowledgeBundle(plan, route, sources = [], options = {}) {
    return {
      version: "1.0",
      strategy: route.path,
      routing_reasons: route.reasons,
      normalized_term: plan.normalized_term,
      term_type: plan.term_type,
      knowledge_confidence: plan.knowledge_confidence,
      ambiguity: plan.ambiguity,
      fact_risk: plan.fact_risk,
      candidate_senses: plan.candidate_senses,
      external_sources: (Array.isArray(sources) ? sources : []).slice(0, 6).map((source, index) => ({
        source_id: `x${index + 1}`,
        title: text(source?.title, 220),
        url: text(source?.link, 600),
        publisher: text(source?.media || source?.domain, 120),
        excerpt: text(source?.cleanContent || source?.content, 700),
        quality_score: Number(source?.score || 0),
        status: "candidate_unverified",
      })).filter((source) => source.title && source.url),
      lookup_failed: options.lookupFailed === true,
    };
  }

  return {
    extractJson,
    pageHasDirectDefinition,
    contextHints,
    buildPlanningMessages,
    fallbackPlan,
    normalizePlan,
    decideRetrieval,
    buildSearchQuery,
    knowledgeBundle,
    constants: {
      TERM_TYPES: [...TERM_TYPES],
      CONFIDENCE_LEVELS: [...CONFIDENCE_LEVELS],
      AMBIGUITY_LEVELS: [...AMBIGUITY_LEVELS],
      RISK_LEVELS: [...RISK_LEVELS],
    },
  };
});

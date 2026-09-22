(function attachYuliuGrounding(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuGrounding = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createYuliuGrounding() {
  const REFERENT_TYPES = new Set([
    "generic_concept", "organization", "product", "person", "method", "metric", "document_defined_term", "other",
  ]);
  const SPECIFICITIES = new Set(["category", "named_entity", "exact_variant"]);
  const CERTAINTIES = new Set(["clear", "inferred", "ambiguous", "insufficient"]);
  const NOTICE_CODES = new Set(["none", "multiple_senses", "insufficient_context", "external_knowledge_needed"]);
  const EVIDENCE_ROLES = new Set(["direct_support", "coreference_support", "structural_support", "sense_disambiguation"]);
  const LOW_RISK_LATIN = new Set([
    "ai", "agent", "agents", "api", "rag", "rsi", "llm", "model", "models", "data", "tool", "tools", "skill", "skills",
    "harness", "benchmark", "metric", "recipe", "memory", "prompt", "reward", "hacking", "level", "system", "framework",
  ]);

  function normalize(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function normalizeIdentity(value) {
    return normalize(value).toLocaleLowerCase().replace(/[“”'‘’`]/g, "");
  }

  function extractJson(raw) {
    if (raw && typeof raw === "object") return raw;
    const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(text); } catch (_) {}
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
  }

  function visibleText(value, maximum = 700) {
    return normalize(value).replace(/[<>]/g, "").slice(0, maximum);
  }

  function candidateMaps(documentContext) {
    const candidates = Array.isArray(documentContext?.evidence_candidates) ? documentContext.evidence_candidates : [];
    const blocks = Array.isArray(documentContext?.blocks) ? documentContext.blocks : [];
    return {
      candidates,
      byEvidenceId: new Map(candidates.map((item) => [String(item.evidence_id || ""), item])),
      byBlockId: new Map(blocks.map((item) => [String(item.block_id || ""), item])),
    };
  }

  function specificMarkers(text, selectedText) {
    const selectedWords = new Set((String(selectedText || "").match(/[A-Za-z][A-Za-z0-9-]*/g) || []).map((word) => word.toLocaleLowerCase()));
    const markers = [];
    const words = String(text || "").match(/\b(?:[A-Z]{2,8}|[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][a-z]{2,})\b/g) || [];
    for (const word of words) {
      const lower = word.toLocaleLowerCase();
      if (selectedWords.has(lower) || LOW_RISK_LATIN.has(lower)) continue;
      if (!markers.includes(word)) markers.push(word);
    }
    return markers;
  }

  function isHighRiskClaim(claim, selectedText) {
    if (claim?.risk === "high") return true;
    const text = String(claim?.text || "");
    return specificMarkers(text, selectedText).length > 0
      || /\d+(?:\.\d+)?%|\b\d{3,}\b/.test(text)
      || /(?:全称|隶属于|由.{0,18}(?:开发|提出|创立)|因而|导致|证明)/.test(text);
  }

  function noticeMatches(certainty, noticeCode) {
    if (certainty === "ambiguous") return noticeCode === "multiple_senses";
    if (certainty === "insufficient") return ["insufficient_context", "external_knowledge_needed"].includes(noticeCode);
    return noticeCode === "none";
  }

  function validateStructured(raw, request = {}) {
    const value = extractJson(raw);
    const errors = [];
    if (!value || typeof value !== "object") return { ok: false, errors: ["INVALID_JSON"], result: null };
    const selectedText = visibleText(value.selected_text, 160);
    const expectedSelection = visibleText(request.selection, 160);
    if (!selectedText || normalizeIdentity(selectedText) !== normalizeIdentity(expectedSelection)) errors.push("SELECTED_TEXT_MISMATCH");

    const resolved = value.resolved_sense && typeof value.resolved_sense === "object" ? value.resolved_sense : {};
    const label = visibleText(resolved.label, 180);
    const referentType = REFERENT_TYPES.has(resolved.referent_type) ? resolved.referent_type : "";
    const specificity = SPECIFICITIES.has(resolved.specificity) ? resolved.specificity : "";
    if (!label) errors.push("MISSING_SENSE_LABEL");
    if (!referentType) errors.push("INVALID_REFERENT_TYPE");
    if (!specificity) errors.push("INVALID_SPECIFICITY");

    const meaningHere = visibleText(value.meaning_here, 520);
    const authorIntent = value.author_intent == null ? null : visibleText(value.author_intent, 420) || null;
    const certainty = CERTAINTIES.has(value.certainty) ? value.certainty : "";
    const noticeCode = NOTICE_CODES.has(value.notice_code) ? value.notice_code : "";
    if (!meaningHere) errors.push("MISSING_MEANING");
    if (!certainty) errors.push("INVALID_CERTAINTY");
    if (!noticeCode || !noticeMatches(certainty, noticeCode)) errors.push("INVALID_NOTICE_STATE");

    const { byEvidenceId, byBlockId } = candidateMaps(request.documentContext);
    const normalizedEvidence = [];
    const seenEvidence = new Set();
    for (const item of Array.isArray(value.evidence) ? value.evidence : []) {
      const evidenceId = String(item?.evidence_id || "");
      const candidate = byEvidenceId.get(evidenceId);
      if (!candidate) { errors.push(`UNKNOWN_EVIDENCE:${evidenceId || "empty"}`); continue; }
      const blockId = String(item?.block_id || candidate.block_id || "");
      if (blockId !== String(candidate.block_id || "")) errors.push(`EVIDENCE_BLOCK_MISMATCH:${evidenceId}`);
      const blockText = normalize(byBlockId.get(blockId)?.text || candidate.text || "");
      const quote = visibleText(item?.quote, 360);
      if (!quote || !blockText.includes(normalize(quote))) errors.push(`QUOTE_NOT_IN_BLOCK:${evidenceId}`);
      if (seenEvidence.has(evidenceId)) continue;
      seenEvidence.add(evidenceId);
      normalizedEvidence.push({
        evidence_id: evidenceId,
        block_id: blockId,
        quote,
        role: EVIDENCE_ROLES.has(candidate.role) ? candidate.role : "sense_disambiguation",
      });
    }

    const normalizedClaims = [];
    for (const item of Array.isArray(value.claims) ? value.claims : []) {
      const claimId = visibleText(item?.claim_id, 50);
      const text = visibleText(item?.text, 360);
      const evidenceIds = [...new Set((Array.isArray(item?.evidence_ids) ? item.evidence_ids : []).map(String))];
      if (!claimId || !text) { errors.push("INVALID_CLAIM"); continue; }
      if (!evidenceIds.length || evidenceIds.some((id) => !seenEvidence.has(id))) errors.push(`CLAIM_WITHOUT_VALID_EVIDENCE:${claimId}`);
      const highRisk = isHighRiskClaim(item, expectedSelection);
      if (highRisk) {
        const hasDirect = evidenceIds.some((id) => byEvidenceId.get(id)?.role === "direct_support");
        if (!hasDirect) errors.push(`HIGH_RISK_WITHOUT_DIRECT_EVIDENCE:${claimId}`);
      }
      normalizedClaims.push({ claim_id: claimId, text, risk: highRisk ? "high" : "ordinary", evidence_ids: evidenceIds });
    }

    if (["clear", "inferred", "ambiguous"].includes(certainty) && (!normalizedClaims.length || !normalizedEvidence.length)) {
      errors.push("ANSWER_WITHOUT_EVIDENCE");
    }

    const specificityText = `${label} ${meaningHere} ${normalizedClaims.map((item) => item.text).join(" ")}`;
    for (const marker of specificMarkers(specificityText, expectedSelection)) {
      const supported = normalizedEvidence.some((item) => {
        const candidate = byEvidenceId.get(item.evidence_id);
        const blockText = normalize(byBlockId.get(item.block_id)?.text || candidate?.text || "");
        return candidate?.role === "direct_support" && blockText.toLocaleLowerCase().includes(marker.toLocaleLowerCase());
      });
      if (!supported) errors.push(`UNSUPPORTED_SPECIFIC_MARKER:${marker}`);
    }

    if (["named_entity", "exact_variant"].includes(specificity)) {
      const hasDirect = normalizedEvidence.some((item) => byEvidenceId.get(item.evidence_id)?.role === "direct_support");
      if (!hasDirect) errors.push("SPECIFIC_IDENTITY_WITHOUT_DIRECT_EVIDENCE");
    }

    const result = {
      selected_text: expectedSelection || selectedText,
      resolved_sense: { label, referent_type: referentType || "other", specificity: specificity || "category" },
      meaning_here: meaningHere,
      author_intent: authorIntent,
      certainty: certainty || "insufficient",
      claims: normalizedClaims,
      evidence: normalizedEvidence,
      notice_code: noticeCode || "insufficient_context",
    };
    return { ok: errors.length === 0, errors: [...new Set(errors)], result };
  }

  function fallbackResult(request = {}) {
    return {
      selected_text: visibleText(request.selection, 160),
      resolved_sense: { label: "当前语境中的具体含义尚未可靠确定", referent_type: "other", specificity: "category" },
      meaning_here: "当前原文信息不足，暂时无法可靠确定这里的具体所指。",
      author_intent: null,
      certainty: "insufficient",
      claims: [],
      evidence: [],
      notice_code: "insufficient_context",
    };
  }

  function buildMessages(request = {}, repair = null) {
    const selection = visibleText(request.selection, 160);
    const context = request.documentContext || {};
    const candidates = (Array.isArray(context.evidence_candidates) ? context.evidence_candidates : []).map((item) => ({
      evidence_id: item.evidence_id,
      block_id: item.block_id,
      role: item.role,
      heading_path: item.heading_path || [],
      text: item.text,
    }));
    const contract = {
      selected_text: selection,
      resolved_sense: { label: "中性的当前义项标签", referent_type: "generic_concept|organization|product|person|method|metric|document_defined_term|other", specificity: "category|named_entity|exact_variant" },
      meaning_here: "当前语境义，不写通用百科，不凭空具体化",
      author_intent: "能由原文支持时填写，否则为null",
      certainty: "clear|inferred|ambiguous|insufficient",
      claims: [{ claim_id: "c1", text: "可核验断言", risk: "ordinary|high", evidence_ids: ["e1"] }],
      evidence: [{ evidence_id: "e1", block_id: "原候选段落ID", quote: "原文中的连续子串", role: "沿用候选证据角色" }],
      notice_code: "none|multiple_senses|insufficient_context|external_knowledge_needed",
    };
    const system = `你是网页与文档内的语境义消歧器。先做WSD（词义消歧），再做证据归因，最后才写答案。只能解释用户选中的词，不解释文章主题。任何公司、产品、人物、框架全称、具体变体、数字和因果判断都属于高风险具体化，必须有候选证据中role为direct_support的原文直接支持；同页共现、标题相似、常识或模型记忆都不够。证据quote必须逐字取自对应段落的连续原文，不得改写。作者意图不是必填项，原文不能直接支持时填null。inferred表示有充分间接证据，不需要警告；只有多义、信息不足或确需外部知识时才显示notice。只输出一个JSON对象，不要Markdown。`;
    let user = `【唯一选中词】\n${selection}\n\n【精确选区】\n${JSON.stringify(context.selection || {})}\n\n【程序召回的候选证据】\n${JSON.stringify(candidates)}\n\n【输出契约】\n${JSON.stringify(contract)}\n\n先选择与选区最匹配的义项。具体程度只能达到证据直接支持的层级；如果只能确定类别，就停在类别，不得猜具体产品或全称。claims要覆盖答案中的可核验事实。`;
    if (repair) user += `\n\n【上一次输出未通过程序校验】\n错误码：${repair.errors.join(", ")}\n上一次输出：${String(repair.raw || "").slice(0, 6000)}\n请只修复这些错误并重新输出完整JSON。`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  return { extractJson, validateStructured, fallbackResult, buildMessages, specificMarkers, isHighRiskClaim };
});

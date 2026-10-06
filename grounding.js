(function attachYuliuGrounding(root, factory) {
  let contract = root.YuliuGroundingContractV2;
  let claimVerification = root.YuliuClaimVerification;
  if (!contract && typeof module !== "undefined" && module.exports) {
    try { contract = require("./grounding-contract-v2.js"); } catch (_) {}
  }
  if (!claimVerification && typeof module !== "undefined" && module.exports) {
    try { claimVerification = require("./claim-verification.js"); } catch (_) {}
  }
  const api = factory(contract, claimVerification);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuGrounding = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createYuliuGrounding(ContractV2, ClaimVerification) {
  const REFERENT_TYPES = new Set([
    "generic_concept", "organization", "product", "person", "method", "metric", "document_defined_term", "other",
  ]);
  const SPECIFICITIES = new Set(["category", "named_entity", "exact_variant"]);
  const STATUSES = new Set(["clear", "inferred", "ambiguous", "insufficient", "unrecognized"]);
  const CONFIDENCES = new Set(["high", "medium", "low"]);
  const CLAIM_TYPES = new Set(["lexical_knowledge", "contextual_mapping", "author_intent", "high_risk_fact"]);
  const SOURCE_KINDS = new Set(["model_knowledge", "page_evidence", "external_source"]);
  const PAGE_ROLES = new Set([
    "direct_support", "coreference_support", "structural_support", "sense_disambiguation", "author_intent_support",
  ]);
  const NOTICE_CODES = new Set(["none", "multiple_senses", "insufficient_context", "term_unrecognized", "external_lookup_failed"]);
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

  function externalSourceMap(request = {}) {
    const sources = Array.isArray(request.termKnowledge?.external_sources) ? request.termKnowledge.external_sources : [];
    return new Map(sources.map((item) => [String(item.source_id || ""), item]));
  }

  function support(value) {
    if (!value || typeof value !== "object" || !SOURCE_KINDS.has(value.source_kind)) return null;
    if (value.source_kind === "model_knowledge") return { source_kind: "model_knowledge" };
    const sourceId = visibleText(value.source_id, 60);
    return sourceId ? { source_kind: value.source_kind, source_id: sourceId } : null;
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

  function normalizeCandidate(item, index) {
    if (!item || typeof item !== "object") return null;
    const label = visibleText(item.label, 180);
    const gloss = visibleText(item.gloss, 360);
    if (!label || !gloss) return null;
    return {
      sense_id: visibleText(item.sense_id, 50) || `s${index + 1}`,
      label,
      gloss,
      referent_type: REFERENT_TYPES.has(item.referent_type) ? item.referent_type : "other",
      chinese_name: item.chinese_name == null ? null : visibleText(item.chinese_name, 120) || null,
      english_full_name: item.english_full_name == null ? null : visibleText(item.english_full_name, 180) || null,
      supports: (Array.isArray(item.supports) ? item.supports : []).map(support).filter(Boolean),
    };
  }

  function referencedSourceIds(claims, sourceKind) {
    return [...new Set((Array.isArray(claims) ? claims : [])
      .flatMap((claim) => Array.isArray(claim?.supports) ? claim.supports : [])
      .filter((item) => item?.source_kind === sourceKind)
      .map((item) => visibleText(item?.source_id, 60))
      .filter(Boolean))];
  }

  function normalizePageEvidence(referencedIds, request, errors) {
    const { byEvidenceId, byBlockId } = candidateMaps(request.documentContext);
    const normalized = [];
    const seen = new Set();
    for (const rawId of Array.isArray(referencedIds) ? referencedIds : []) {
      const evidenceId = visibleText(rawId, 60);
      const candidate = byEvidenceId.get(evidenceId);
      if (!candidate) { errors.push(`UNKNOWN_PAGE_EVIDENCE:${evidenceId || "empty"}`); continue; }
      if (seen.has(evidenceId)) continue;
      seen.add(evidenceId);
      const blockId = visibleText(candidate.block_id, 100);
      // 模型只负责选择证据 ID。块 ID、引文和证据角色全部从本地 RAG
      // 候选池回填，避免“意思对了，却因模型改写引文而整段作废”。
      const quote = visibleText(candidate.quote || byBlockId.get(blockId)?.text || candidate.text, 420);
      normalized.push({
        evidence_id: evidenceId,
        block_id: blockId,
        quote,
        role: PAGE_ROLES.has(candidate.role) ? candidate.role : "sense_disambiguation",
      });
    }
    return normalized;
  }

  function normalizeExternalSources(referencedIds, request, errors) {
    const known = externalSourceMap(request);
    const normalized = [];
    const seen = new Set();
    for (const rawId of Array.isArray(referencedIds) ? referencedIds : []) {
      const sourceId = visibleText(rawId, 60);
      const source = known.get(sourceId);
      if (!source) { errors.push(`UNKNOWN_EXTERNAL_SOURCE:${sourceId || "empty"}`); continue; }
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      normalized.push({
        source_id: sourceId,
        title: visibleText(source.title, 220),
        url: visibleText(source.url, 600),
        publisher: visibleText(source.publisher, 120) || null,
        excerpt: visibleText(source.excerpt, 700) || null,
      });
    }
    return normalized;
  }

  function selectionRoots(value) {
    const selected = normalize(value);
    const roots = new Set();
    const suffixes = ["策略", "机制", "方法", "系统", "任务", "分析", "流程", "管理", "方案", "工程", "模型", "能力", "技术"];
    for (const suffix of suffixes) {
      if (!selected.endsWith(suffix)) continue;
      const root = selected.slice(0, -suffix.length).trim();
      if (/^[A-Za-z][A-Za-z0-9._/-]{1,}$/.test(root) || /[\u3400-\u9fff]{2,}/.test(root)) roots.add(root);
    }
    return [...roots];
  }

  function supportingEvidenceCandidates(request, candidate, meaningText = "", limit = 2) {
    const evidenceCandidates = Array.isArray(request.documentContext?.evidence_candidates)
      ? request.documentContext.evidence_candidates : [];
    const selected = visibleText(request.selection, 160);
    const anchorId = String(request.documentContext?.selection?.anchor_block_id || "");
    const roots = selectionRoots(selected);
    const targetText = `${candidate?.label || ""} ${candidate?.gloss || ""} ${candidate?.chinese_name || ""} ${candidate?.english_full_name || ""} ${meaningText}`;
    return evidenceCandidates
      .filter((item) => String(item?.block_id || "") !== anchorId)
      .map((item) => {
        const sourceText = visibleText(item?.text || item?.quote, 1600);
        const withoutExactSelection = normalize(sourceText).replaceAll(normalize(selected), " ");
        const semantic = ClaimVerification?.overlap
          ? ClaimVerification.overlap(withoutExactSelection, targetText, selected)
          : { count: 0, targetCount: 0 };
        const rootHits = roots.reduce((sum, root) => sum + (normalizeIdentity(sourceText).includes(normalizeIdentity(root)) ? 1 : 0), 0);
        let score = semantic.count * 4 + rootHits * 12;
        if (item.role === "direct_support") score += 8;
        if (Number(item?.signals?.variantOccurrences || 0) > 0) score += 6;
        if (Number(item?.signals?.definition || 0) > 0) score += 6;
        if (sourceText.length >= 35 && /[，。；：,:;]/.test(sourceText)) score += 3;
        if (sourceText.length < Math.max(12, selected.length + 6)) score -= 5;
        return { item, score };
      })
      .filter(({ score }) => score >= 8)
      .sort((left, right) => right.score - left.score
        || Number(right.item?.score || 0) - Number(left.item?.score || 0))
      .slice(0, Math.max(0, limit))
      .map(({ item }) => item);
  }

  function enrichContextualClaimSupports(claims, candidates, resolutionValue, meaningValue, request) {
    const anchorId = String(request.documentContext?.selection?.anchor_block_id || "");
    const byEvidenceId = candidateMaps(request.documentContext).byEvidenceId;
    const contextualClaims = claims.filter((claim) => claim.claim_type === "contextual_mapping");
    if (!contextualClaims.length) return;
    const currentPageIds = referencedSourceIds(contextualClaims, "page_evidence");
    if (!currentPageIds.length) return;
    const alreadyHasExplanatoryEvidence = currentPageIds.some((id) => String(byEvidenceId.get(id)?.block_id || "") !== anchorId);
    if (alreadyHasExplanatoryEvidence) return;
    const selected = candidates.find((item) => item.sense_id === visibleText(resolutionValue?.selected_sense_id, 50));
    if (!selected) return;
    const additions = supportingEvidenceCandidates(request, selected, meaningValue?.text, 2);
    if (!additions.length) return;
    const claim = contextualClaims[0];
    const seen = new Set((claim.supports || []).filter((item) => item.source_kind === "page_evidence").map((item) => item.source_id));
    for (const evidence of additions) {
      const evidenceId = visibleText(evidence.evidence_id, 60);
      if (!evidenceId || seen.has(evidenceId)) continue;
      claim.supports.push({ source_kind: "page_evidence", source_id: evidenceId });
      seen.add(evidenceId);
    }
  }

  function normalizeStructuredValue(value, request, errors) {
    const knownCandidates = new Map((Array.isArray(request.termKnowledge?.candidate_senses)
      ? request.termKnowledge.candidate_senses : [])
      .map((item, index) => normalizeCandidate(item, index))
      .filter(Boolean)
      .map((item) => [item.sense_id, item]));
    const candidates = (Array.isArray(value.candidate_senses) ? value.candidate_senses : [])
      .map((item, index) => {
        const normalized = normalizeCandidate(item, index);
        const known = normalized && knownCandidates.get(normalized.sense_id);
        if (!normalized || !known || !/^(?:中性)?义项名$|^待填写/i.test(normalized.label)) return normalized;
        // 模型偶尔会照抄输出结构里的占位词。候选池已有同一 sense_id 时，
        // 直接恢复规划阶段的真实义项，不让占位文本进入校验和界面。
        return known;
      })
      .filter(Boolean)
      .slice(0, 8);
    const resolutionValue = value.resolution && typeof value.resolution === "object" ? value.resolution : {};
    const meaningValue = value.meaning_here && typeof value.meaning_here === "object" ? value.meaning_here : {};
    const authorValue = value.author_intent && typeof value.author_intent === "object" ? value.author_intent : null;
    const claims = (Array.isArray(value.claims) ? value.claims : []).slice(0, 12).map((item, index) => ({
      claim_id: visibleText(item?.claim_id, 50) || `c${index + 1}`,
      claim_type: CLAIM_TYPES.has(item?.claim_type) ? item.claim_type : "lexical_knowledge",
      text: visibleText(item?.text, 420),
      supports: (Array.isArray(item?.supports) ? item.supports : []).map(support).filter(Boolean),
    }));
    enrichContextualClaimSupports(claims, candidates, resolutionValue, meaningValue, request);
    const pageEvidence = normalizePageEvidence(referencedSourceIds(claims, "page_evidence"), request, errors);
    const externalSources = normalizeExternalSources(referencedSourceIds(claims, "external_source"), request, errors);
    const authorText = visibleText(authorValue?.text, 420);
    return {
      schema_version: "2.0",
      selected_text: visibleText(value.selected_text, 160),
      candidate_senses: candidates,
      resolution: {
        status: STATUSES.has(resolutionValue.status) ? resolutionValue.status : "insufficient",
        selected_sense_id: resolutionValue.selected_sense_id == null ? null : visibleText(resolutionValue.selected_sense_id, 50) || null,
        alternative_sense_ids: (Array.isArray(resolutionValue.alternative_sense_ids) ? resolutionValue.alternative_sense_ids : []).map((id) => visibleText(id, 50)).filter(Boolean),
        confidence: CONFIDENCES.has(resolutionValue.confidence) ? resolutionValue.confidence : "low",
        specificity: SPECIFICITIES.has(resolutionValue.specificity) ? resolutionValue.specificity : "category",
      },
      meaning_here: {
        text: visibleText(meaningValue.text, 520),
        chinese_name: meaningValue.chinese_name == null ? null : visibleText(meaningValue.chinese_name, 120) || null,
        english_full_name: meaningValue.english_full_name == null ? null : visibleText(meaningValue.english_full_name, 180) || null,
        contextual_role: meaningValue.contextual_role == null ? null : visibleText(meaningValue.contextual_role, 260) || null,
      },
      author_intent: authorText ? {
        text: authorText,
        claim_ids: (Array.isArray(authorValue.claim_ids) ? authorValue.claim_ids : []).map((id) => visibleText(id, 50)).filter(Boolean),
      } : null,
      claims,
      page_evidence: pageEvidence,
      external_sources: externalSources,
      notice_code: NOTICE_CODES.has(value.notice_code) ? value.notice_code : "insufficient_context",
    };
  }

  function validateStructured(raw, request = {}) {
    const value = extractJson(raw);
    const errors = [];
    if (!value || typeof value !== "object") return { ok: false, errors: ["INVALID_JSON"], result: null };
    const result = normalizeStructuredValue(value, request, errors);
    const expectedSelection = visibleText(request.selection, 160);
    if (!result.selected_text || normalizeIdentity(result.selected_text) !== normalizeIdentity(expectedSelection)) errors.push("SELECTED_TEXT_MISMATCH");
    if (!result.meaning_here.text || !normalizeIdentity(result.meaning_here.text).includes(normalizeIdentity(expectedSelection))) {
      errors.push("MEANING_MUST_NAME_SELECTION");
    }
    if (["clear", "inferred"].includes(result.resolution.status)
      && !result.claims.some((claim) => claim.claim_type === "contextual_mapping")) {
      errors.push("RESOLVED_WITHOUT_CONTEXTUAL_MAPPING");
    }
    if (result.author_intent && normalizeIdentity(result.author_intent.text) === normalizeIdentity(result.meaning_here.text)) {
      errors.push("AUTHOR_INTENT_DUPLICATES_MEANING");
    }

    const pageRoles = new Map(result.page_evidence.map((item) => [item.evidence_id, item.role]));
    for (const claim of result.claims.filter((item) => item.claim_type === "high_risk_fact")) {
      const hasExternal = claim.supports.some((item) => item.source_kind === "external_source");
      const hasDirectPage = claim.supports.some((item) => item.source_kind === "page_evidence" && pageRoles.get(item.source_id) === "direct_support");
      if (!hasExternal && !hasDirectPage) errors.push(`HIGH_RISK_WITHOUT_VERIFIED_SUPPORT:${claim.claim_id}`);
    }
    const selectedSense = result.candidate_senses.find((item) => item.sense_id === result.resolution.selected_sense_id);
    const canonicalSourceText = normalize([
      ...result.page_evidence.map((item) => item.quote),
      ...result.external_sources.map((item) => `${item.title || ""} ${item.publisher || ""} ${item.excerpt || ""}`),
    ].join(" "));
    const trustedKnowledgeText = ["high", "medium"].includes(request.termKnowledge?.knowledge_confidence)
      ? normalize((request.termKnowledge?.candidate_senses || [])
        .map((item) => `${item.label || ""} ${item.gloss || ""} ${item.chinese_name || ""} ${item.english_full_name || ""}`)
        .join(" "))
      : "";
    const trustedText = `${canonicalSourceText} ${trustedKnowledgeText}`;
    const highRiskText = `${result.meaning_here.text} ${result.claims.map((item) => item.text).join(" ")}`;
    const unsupportedMarkers = specificMarkers(highRiskText, expectedSelection)
      .filter((marker) => !trustedText.includes(normalize(marker)));
    const unsupportedNumbers = (highRiskText.match(/\d+(?:\.\d+)?%|\b\d{3,}\b/g) || [])
      .filter((number) => !trustedText.includes(normalize(number)));
    const identityNeedsVerification = result.resolution.specificity === "named_entity"
      || (result.resolution.specificity === "exact_variant"
        && ["organization", "product", "person"].includes(selectedSense?.referent_type))
      || unsupportedMarkers.length > 0;
    if (identityNeedsVerification) {
      const hasVerifiedIdentity = result.claims.some((claim) => claim.claim_type === "high_risk_fact"
        && claim.supports.some((item) => item.source_kind === "external_source"
          || item.source_kind === "page_evidence" && pageRoles.get(item.source_id) === "direct_support"));
      if (!hasVerifiedIdentity) errors.push("SPECIFIC_IDENTITY_WITHOUT_VERIFIED_SUPPORT");
    }

    const hasSpecificMarkers = unsupportedMarkers.length > 0 || unsupportedNumbers.length > 0;
    if (hasSpecificMarkers && !result.claims.some((claim) => claim.claim_type === "high_risk_fact")) {
      errors.push("UNDECLARED_HIGH_RISK_FACT");
    }

    if (ClaimVerification?.verify) {
      const verification = ClaimVerification.verify(result, request);
      if (!verification.ok) errors.push(...verification.errors);
      result.__claim_verification = verification;
    } else {
      errors.push("CLAIM_VERIFIER_UNAVAILABLE");
    }

    if (ContractV2?.validate) {
      const checked = ContractV2.validate(result);
      if (!checked.ok) errors.push(...checked.errors);
    } else {
      errors.push("V2_CONTRACT_UNAVAILABLE");
    }
    const verification = result.__claim_verification || null;
    delete result.__claim_verification;
    if (errors.length) return { ok: false, errors: [...new Set(errors)], result, verification };

    const { byEvidenceId } = candidateMaps(request.documentContext);
    result.page_evidence = result.page_evidence.map((item) => {
      const candidate = byEvidenceId.get(item.evidence_id) || {};
      return {
        ...item,
        heading_path: Array.isArray(candidate.heading_path) ? candidate.heading_path.map((part) => visibleText(part, 120)).filter(Boolean) : [],
        relation_to_selection: visibleText(candidate.relation_to_selection, 60),
      };
    });
    return { ok: true, errors: [], result, verification };
  }

  function genericReferentText(candidate) {
    const labels = {
      organization: "某个具体组织",
      product: "某个具体产品或系统实现",
      person: "某位具体人物",
      method: "一类方法",
      metric: "一类指标或评测标准",
      document_defined_term: "本文定义的一类概念",
      generic_concept: "该一般概念",
      other: "该类对象",
    };
    return labels[candidate?.referent_type] || labels.other;
  }

  function salvageLowRisk(validation, request = {}) {
    if (!validation?.result || !validation.verification) return null;
    const result = JSON.parse(JSON.stringify(validation.result));
    const invalidIds = new Set(validation.verification.invalid_claim_ids || []);
    const invalidClaims = result.claims.filter((claim) => invalidIds.has(claim.claim_id));
    if (invalidClaims.some((claim) => claim.claim_type === "contextual_mapping" || claim.claim_type === "lexical_knowledge")) return null;

    const recoverable = validation.errors.every((error) => (
      error.startsWith("CLAIM_NOT_SEMANTICALLY_SUPPORTED:")
      || error.startsWith("HIGH_RISK_WITHOUT_VERIFIED_SUPPORT:")
      || error === "SPECIFIC_IDENTITY_WITHOUT_VERIFIED_SUPPORT"
      || error === "UNDECLARED_HIGH_RISK_FACT"
      || error === "INVALID_AUTHOR_INTENT"
      || error === "AUTHOR_INTENT_WITHOUT_MATCHING_CLAIM"
      || error === "AUTHOR_INTENT_DUPLICATES_MEANING"
    ));
    if (!recoverable) return null;

    const removeAuthorIntent = invalidClaims.some((claim) => claim.claim_type === "author_intent")
      || validation.errors.some((error) => error === "INVALID_AUTHOR_INTENT"
        || error === "AUTHOR_INTENT_WITHOUT_MATCHING_CLAIM"
        || error === "AUTHOR_INTENT_DUPLICATES_MEANING");
    const removeHighRisk = invalidClaims.some((claim) => claim.claim_type === "high_risk_fact")
      || validation.errors.some((error) => error.includes("HIGH_RISK") || error.includes("SPECIFIC_IDENTITY"));
    result.claims = result.claims.filter((claim) => !invalidIds.has(claim.claim_id)
      && !(removeHighRisk && claim.claim_type === "high_risk_fact"));
    if (removeAuthorIntent) result.author_intent = null;

    if (removeHighRisk || validation.errors.includes("UNDECLARED_HIGH_RISK_FACT")) {
      const selected = result.candidate_senses.find((item) => item.sense_id === result.resolution.selected_sense_id);
      if (!selected) return null;
      const generic = selected.referent_type === "generic_concept" && selected.gloss
        ? selected.gloss
        : genericReferentText(selected);
      result.resolution.specificity = "category";
      result.meaning_here = {
        text: `“${result.selected_text}”在这里指${generic}。`,
        chinese_name: selected.referent_type === "generic_concept" ? selected.chinese_name || null : null,
        english_full_name: null,
        contextual_role: null,
      };
    }

    const retainedClaimIds = new Set(result.claims.map((claim) => claim.claim_id));
    if (result.author_intent && result.author_intent.claim_ids.some((id) => !retainedClaimIds.has(id))) result.author_intent = null;
    const rechecked = validateStructured(result, request);
    return rechecked.ok ? { result: rechecked.result, removed_claim_ids: [...invalidIds] } : null;
  }

  function fallbackResult(request = {}) {
    const selected = visibleText(request.selection, 160);
    const candidates = (Array.isArray(request.termKnowledge?.candidate_senses) ? request.termKnowledge.candidate_senses : [])
      .map(normalizeCandidate)
      .filter(Boolean)
      .slice(0, 8);
    const hasPageContext = Array.isArray(request.documentContext?.evidence_candidates)
      && request.documentContext.evidence_candidates.length > 0;
    const unrecognized = !candidates.length && !hasPageContext;
    const lookupFailed = request.termKnowledge?.lookup_failed === true;
    const status = unrecognized ? "unrecognized" : "insufficient";
    return {
      schema_version: "2.0",
      selected_text: selected,
      candidate_senses: candidates,
      resolution: {
        status,
        selected_sense_id: null,
        alternative_sense_ids: candidates.map((item) => item.sense_id),
        confidence: "low",
        specificity: "category",
      },
      meaning_here: {
        text: unrecognized
          ? `${selected} 暂时无法被可靠识别，可能是生僻术语、拼写变体或乱码。`
          : `${selected} 可能有不同含义，但当前信息还不足以可靠确定这里具体采用哪一种。`,
        chinese_name: null,
        english_full_name: null,
        contextual_role: null,
      },
      author_intent: null,
      claims: [],
      page_evidence: [],
      external_sources: [],
      notice_code: unrecognized ? "term_unrecognized" : lookupFailed ? "external_lookup_failed" : "insufficient_context",
    };
  }

  function knowledgeFallbackResult(request = {}) {
    const selected = visibleText(request.selection, 160);
    const candidates = (Array.isArray(request.termKnowledge?.candidate_senses) ? request.termKnowledge.candidate_senses : [])
      .map(normalizeCandidate)
      .filter(Boolean)
      .slice(0, 8);
    const confidence = request.termKnowledge?.knowledge_confidence;
    const ambiguity = request.termKnowledge?.ambiguity;
    const safeTypes = new Set(["generic_concept", "method", "metric", "document_defined_term", "other"]);
    if (!candidates.length || !["high", "medium"].includes(confidence) || ambiguity === "high") return null;
    const candidate = candidates.length === 1 ? candidates[0] : null;
    if (!candidate || !safeTypes.has(candidate.referent_type)) return null;
    const evidenceCandidates = Array.isArray(request.documentContext?.evidence_candidates)
      ? request.documentContext.evidence_candidates : [];
    const selectedIdentity = normalizeIdentity(selected);
    const anchorEvidence = evidenceCandidates.find((item) => String(item.block_id || "") === String(request.documentContext?.selection?.anchor_block_id || ""))
      || evidenceCandidates.find((item) => normalizeIdentity(item.text).includes(selectedIdentity))
      || evidenceCandidates[0];
    if (!anchorEvidence?.evidence_id) return null;
    const explanatoryEvidence = supportingEvidenceCandidates(request, candidate, candidate.gloss, 2);
    const adoptedEvidence = [...explanatoryEvidence, anchorEvidence]
      .filter((item, index, all) => item?.evidence_id
        && all.findIndex((other) => String(other?.evidence_id) === String(item.evidence_id)) === index)
      .slice(0, 3);
    const evidenceSupports = adoptedEvidence.map((item) => ({
      source_kind: "page_evidence",
      source_id: String(item.evidence_id),
    }));
    const gloss = candidate.gloss.replace(/^[“\"']?[^：:]{0,30}[”\"']?\s*(?:是指|指的是|指|意为|意味着)\s*/i, "").replace(/[。；;]+$/, "");
    const raw = {
      schema_version: "2.0",
      selected_text: selected,
      candidate_senses: candidates,
      resolution: {
        status: "inferred",
        selected_sense_id: candidate.sense_id,
        alternative_sense_ids: [],
        confidence: confidence === "high" ? "medium" : "low",
        specificity: "category",
      },
      meaning_here: {
        text: `“${selected}”在这里指${gloss || candidate.label}。`,
        chinese_name: candidate.chinese_name,
        english_full_name: candidate.english_full_name,
        contextual_role: null,
      },
      author_intent: null,
      claims: [
        {
          claim_id: "c1",
          claim_type: "lexical_knowledge",
          text: `${candidate.label}：${candidate.gloss}`,
          supports: [{ source_kind: "model_knowledge" }],
        },
        {
          claim_id: "c2",
          claim_type: "contextual_mapping",
          text: `当前页面中的“${selected}”对应“${candidate.label}”这一义项。`,
          supports: evidenceSupports,
        },
      ],
      page_evidence: adoptedEvidence.map((item) => ({ evidence_id: String(item.evidence_id) })),
      external_sources: [],
      notice_code: "none",
    };
    const checked = validateStructured(raw, request);
    return checked.ok ? checked.result : null;
  }

  function buildMessages(request = {}, repair = null) {
    const selection = visibleText(request.selection, 160);
    const context = request.documentContext || {};
    const pageCandidates = (Array.isArray(context.evidence_candidates) ? context.evidence_candidates : []).map((item) => ({
      evidence_id: item.evidence_id,
      block_id: item.block_id,
      role: item.role,
      heading_path: item.heading_path || [],
      relation_to_selection: item.relation_to_selection || "",
      text: item.text,
    }));
    const termKnowledge = request.termKnowledge && typeof request.termKnowledge === "object"
      ? request.termKnowledge
      : { candidate_senses: [], external_sources: [] };
    const outputContract = {
      schema_version: "2.0",
      selected_text: selection,
      candidate_senses: [{
        sense_id: "s1", label: "中性义项名", gloss: "不依赖本文也成立的简释",
        referent_type: "generic_concept|organization|product|person|method|metric|document_defined_term|other",
        chinese_name: null, english_full_name: null,
        supports: [{ source_kind: "model_knowledge|page_evidence|external_source", source_id: "页面或外部来源才填写" }],
      }],
      resolution: {
        status: "clear|inferred|ambiguous|insufficient|unrecognized",
        selected_sense_id: "s1或null", alternative_sense_ids: [], confidence: "high|medium|low",
        specificity: "category|named_entity|exact_variant",
      },
      meaning_here: { text: `“${selection}”在这里指……`, chinese_name: null, english_full_name: null, contextual_role: null },
      author_intent: { text: "仅在具有独立论证作用且原文支持时填写，否则整个字段为null", claim_ids: ["c3"] },
      claims: [{ claim_id: "c1", claim_type: "lexical_knowledge|contextual_mapping|author_intent|high_risk_fact", text: "单项主张", supports: [{ source_kind: "model_knowledge|page_evidence|external_source", source_id: "按来源填写" }] }],
      page_evidence: [{ evidence_id: "只填写输入中的证据ID；块ID、引文和角色由程序回填" }],
      external_sources: [{ source_id: "只能使用输入ID", title: "输入标题", url: "输入网址", publisher: null, excerpt: null }],
      notice_code: "none|multiple_senses|insufficient_context|term_unrecognized|external_lookup_failed",
    };
    const system = `你是网页与文档内的语境义消歧器。目标是让用户快速理解选中词在当前位置的含义，而不是做封闭式文档问答。按顺序执行：一、结合模型知识和术语候选池建立真实存在的主要义项；二、执行WSD（词义消歧），只用当前选区与页面候选证据选择本次义项；三、生成简洁的“这里指什么”；四、只有作者确实借该词完成强调、对比、区分、提醒或推进论证，而且这一作用与词义解释不同，才生成“作者想表达什么”（author_intent），否则填null。术语候选知识不得冒充当前页面证据：模型知识可以支持低风险的一般概念释义；页面证据负责支持当前义项映射和作者意图；具体实体、版本、数字和时效事实必须由页面直接证据或已提供的外部来源支持。高置信候选池可以支持常见缩写全称，但不得自行补出未经候选池确认的唯一身份。每条claim只写一个可独立核验的事实；supports必须真正支持这条claim，不能因为引文出现了选中词就绑定。当前选区只证明“词出现在这里”：若候选池中还有解释其含义、作用、流程或上下位关系的非锚点段落，contextual_mapping必须同时采用至少一条这种说明性证据，不能只引用选中词所在短句或标题。输入中的页面role是程序判定的，不得把sense_disambiguation或coreference_support自行升级为direct_support。外部来源标记为candidate_unverified时，必须先判断其与候选义项语义一致，并确认它能支持绑定的具体主张后才能采用。页面仅出现同词可用于sense_disambiguation，但不能冒充词典定义。page_evidence只需返回所采用的evidence_id，块ID、原文引文和角色由程序从本地RAG候选池回填；不要自行改写引文。正常推断使用inferred且notice_code为none，不得误报信息不足。只输出一个JSON对象，不要Markdown。`;
    let user = `【唯一选中词】\n${selection}\n\n【精确选区】\n${JSON.stringify(context.selection || {})}\n\n【页面候选证据】\n${JSON.stringify(pageCandidates)}\n\n【术语候选知识与待核验外部资料】\n${JSON.stringify(termKnowledge)}\n\n【必须遵守的输出结构】\n${JSON.stringify(outputContract)}\n\nmeaning_here第一句必须点名“${selection}”，直接说明当前语境义。candidate_senses应优先沿用候选池的sense_id、真实名称和释义，并合并重复义项；严禁把“中性义项名”等结构示例原样当成答案。页面直接定义的文内特殊术语可以新增document_defined_term候选。clear或inferred必须提供contextual_mapping主张并绑定页面证据。作者意图不得重复meaning_here。`;
    if (repair) user += `\n\n【上一次输出未通过程序校验】\n错误码：${repair.errors.join(", ")}\n上一次输出：${String(repair.raw || "").slice(0, 8000)}\n请只修复这些错误，并重新输出完整JSON。`;
    return [{ role: "system", content: system }, { role: "user", content: user }];
  }

  return { extractJson, validateStructured, salvageLowRisk, knowledgeFallbackResult, fallbackResult, buildMessages, specificMarkers };
});

(function attachYuliuClaimVerification(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuClaimVerification = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createClaimVerification() {
  const GENERIC_LATIN = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "is", "are", "as", "this", "that",
    "ai", "model", "models", "system", "systems", "data", "tool", "tools", "framework",
  ]);
  const GENERIC_CHINESE = new Set([
    "这里", "本文", "文中", "作者", "当前", "一种", "这个", "这种", "用于", "可以", "通过", "相关", "具体", "义项",
    "系统", "模型", "方法", "概念", "能力", "进行", "实现", "使用", "表示", "说明", "指向", "通常",
  ]);
  const ARGUMENT_MARKERS = /(?:因此|所以|意味着|说明|表明|强调|提醒|关键|真正|并非|而是|但|然而|相比|区别|目的|为了|希望|需要|必须|不等于|取决于|原因)/i;
  const CAUSAL_MARKERS = /(?:导致|造成|引发|因此|所以|从而|目的|为了|because|cause|therefore|so that|in order to)/i;

  function normalize(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  function latinTokens(value, selectedText = "") {
    const selected = new Set((String(selectedText).match(/[A-Za-z][A-Za-z0-9_.-]*/g) || []).map((item) => item.toLocaleLowerCase()));
    return (String(value).match(/[A-Za-z][A-Za-z0-9_.-]*/g) || [])
      .map((item) => item.toLocaleLowerCase())
      .filter((item) => item.length > 1 && !selected.has(item) && !GENERIC_LATIN.has(item));
  }

  function chineseTokens(value) {
    const sequences = String(value).match(/[\u3400-\u9fff]{2,}/g) || [];
    const tokens = [];
    for (const sequence of sequences) {
      if (!GENERIC_CHINESE.has(sequence)) tokens.push(sequence);
      for (let index = 0; index < sequence.length - 1; index += 1) {
        const pair = sequence.slice(index, index + 2);
        if (!GENERIC_CHINESE.has(pair)) tokens.push(pair);
      }
    }
    return tokens;
  }

  function semanticTokens(value, selectedText = "") {
    return [...new Set([...latinTokens(value, selectedText), ...chineseTokens(value)])];
  }

  function overlap(source, target, selectedText = "") {
    const sourceSet = new Set(semanticTokens(source, selectedText));
    const targetSet = new Set(semanticTokens(target, selectedText));
    const shared = [...targetSet].filter((token) => sourceSet.has(token));
    return { shared, count: shared.length, targetCount: targetSet.size };
  }

  function specificAtoms(value, selectedText = "") {
    const selected = new Set((String(selectedText).match(/[A-Za-z][A-Za-z0-9_.-]*/g) || []).map((item) => item.toLocaleLowerCase()));
    const atoms = [];
    const words = String(value).match(/\b(?:[A-Z]{2,10}|[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+|[A-Z][a-z]{2,})\b/g) || [];
    const numbers = String(value).match(/\b\d+(?:\.\d+)?%?\b/g) || [];
    for (const atom of [...words, ...numbers]) {
      if (selected.has(atom.toLocaleLowerCase())) continue;
      if (!atoms.includes(atom)) atoms.push(atom);
    }
    return atoms;
  }

  function atomsSupported(atoms, sourceText) {
    if (!atoms.length) return true;
    const source = normalize(sourceText);
    return atoms.every((atom) => source.includes(normalize(atom)));
  }

  function pageSourceText(item, request) {
    const candidates = Array.isArray(request?.documentContext?.evidence_candidates)
      ? request.documentContext.evidence_candidates : [];
    const source = candidates.find((candidate) => String(candidate.evidence_id || "") === String(item.evidence_id || ""));
    return [item.quote, ...(source?.heading_path || []), source?.text || ""].filter(Boolean).join(" ");
  }

  function candidateText(result) {
    const selectedId = result?.resolution?.selected_sense_id;
    const candidate = (result?.candidate_senses || []).find((item) => item.sense_id === selectedId);
    return candidate ? `${candidate.label} ${candidate.gloss} ${candidate.chinese_name || ""} ${candidate.english_full_name || ""}` : "";
  }

  function sourceMaps(result, request) {
    const page = new Map((result.page_evidence || []).map((item) => [item.evidence_id, {
      ...item,
      semantic_text: pageSourceText(item, request),
    }]));
    const external = new Map((result.external_sources || []).map((item) => [item.source_id, item]));
    return { page, external };
  }

  function selectedSense(result) {
    return (result?.candidate_senses || []).find((item) => item.sense_id === result?.resolution?.selected_sense_id);
  }

  function explicitIdentityMatch(sourceText, candidate) {
    const source = normalize(sourceText);
    return [candidate?.label, candidate?.chinese_name, candidate?.english_full_name]
      .map(normalize)
      .filter((item) => item.length >= 2)
      .some((item) => source.includes(item));
  }

  function acronymIdentityVerified(result, maps) {
    return (result?.claims || [])
      .filter((claim) => claim.claim_type === "lexical_knowledge")
      .some((claim) => (claim.supports || []).some((support) => (
        support.source_kind === "external_source"
        && externalSupport(claim, maps.external.get(support.source_id), result)
      )));
  }

  function sourceMentionsSelection(source, result) {
    return normalize(source?.semantic_text || source?.quote || "")
      .includes(normalize(result?.selected_text || ""));
  }

  function selectedSenseIsLowRisk(result) {
    return ["generic_concept", "method", "metric", "document_defined_term", "other"]
      .includes(selectedSense(result)?.referent_type);
  }

  function candidateHasModelKnowledge(result) {
    return (selectedSense(result)?.supports || []).some((item) => item.source_kind === "model_knowledge");
  }

  function contextualSupport(claim, source, result, maps, request) {
    if (!source) return false;
    const sense = candidateText(result);
    if (!sense) {
      // 真正多义时尚无 selected_sense_id；这时只能让页面直接定义去支持
      // 主张本身，不能用普通同词出现偷选某个义项。
      return source.role === "direct_support"
        && overlap(source.semantic_text, claim?.text || "", result.selected_text).count > 0;
    }
    const senseOverlap = overlap(source.semantic_text, sense, result.selected_text);
    const claimOverlap = overlap(source.semantic_text, claim?.text || "", result.selected_text);
    const shared = senseOverlap.count;
    const selected = selectedSense(result);
    const identityMatched = explicitIdentityMatch(source.semantic_text, selected);
    if (source.role === "direct_support") {
      // 页面声称在“直接定义”时，不能再用一个碰巧重合的词放行。
      // 至少需要两个有效语义片段并达到基本覆盖，或完整身份与正文语义同时对齐。
      const coverage = shared / Math.max(1, senseOverlap.targetCount);
      return (shared >= 2 && coverage >= 0.12)
        || (identityMatched && (shared > 0 || claimOverlap.count >= 2));
    }
    const acronym = /^[A-Z][A-Z0-9-]{1,9}$/.test(String(result.selected_text || "").trim());
    if (!acronym) {
      if (shared > 0 || claimOverlap.count > 0) return true;
      // 对普通低风险词，若候选池只给出一个低歧义义项，页面中的同词出现
      // 足以完成“当前语境映射”；不再要求正文重新写一遍词典定义。
      const candidates = result?.candidate_senses || [];
      const lowAmbiguity = candidates.length === 1 || request?.termKnowledge?.ambiguity === "low";
      return sourceMentionsSelection(source, result) && lowAmbiguity
        && selectedSenseIsLowRisk(result) && candidateHasModelKnowledge(result);
    }
    const trustedAcronym = ["high", "medium"].includes(request?.termKnowledge?.knowledge_confidence)
      && request?.termKnowledge?.term_type === "acronym"
      && candidateHasModelKnowledge(result);
    // 缩写可由外部资料核验，也可由高置信术语候选池确认；页面证据仍须
    // 证明当前出现位置与该义项在语义上对齐。
    return (acronymIdentityVerified(result, maps) || trustedAcronym)
      && sourceMentionsSelection(source, result)
      && (shared > 0 || claimOverlap.count > 0 || identityMatched);
  }

  function authorIntentSupport(claim, source, result) {
    if (!source) return false;
    if (source.role === "author_intent_support") return true;
    const sourceText = source.semantic_text || source.quote || "";
    const related = overlap(sourceText, claim.text, result.selected_text).count > 0;
    return related && (ARGUMENT_MARKERS.test(sourceText) || ARGUMENT_MARKERS.test(claim.text));
  }

  function highRiskPageSupport(claim, source, result) {
    if (!source || source.role !== "direct_support") return false;
    const sourceText = source.semantic_text || source.quote || "";
    const atoms = specificAtoms(claim.text, result.selected_text);
    if (!atomsSupported(atoms, sourceText)) return false;
    if (CAUSAL_MARKERS.test(claim.text) && !CAUSAL_MARKERS.test(sourceText)) return false;
    return atoms.length > 0 || overlap(sourceText, claim.text, result.selected_text).count > 0;
  }

  function externalSupport(claim, source, result) {
    if (!source) return false;
    const sourceText = `${source.title || ""} ${source.publisher || ""} ${source.excerpt || ""}`;
    const atoms = specificAtoms(claim.text, result.selected_text);
    if (!atomsSupported(atoms, sourceText)) return false;
    if (CAUSAL_MARKERS.test(claim.text) && !CAUSAL_MARKERS.test(sourceText)) return false;
    return atoms.length > 0 || overlap(sourceText, claim.text, result.selected_text).count > 0;
  }

  function lexicalSupport(claim, sourceRef, maps, result) {
    if (sourceRef.source_kind === "model_knowledge") return true;
    if (sourceRef.source_kind === "external_source") return externalSupport(claim, maps.external.get(sourceRef.source_id), result);
    const source = maps.page.get(sourceRef.source_id);
    return source?.role === "direct_support" && overlap(source.semantic_text, claim.text, result.selected_text).count > 0;
  }

  function verifyClaim(claim, maps, result, request) {
    const supports = Array.isArray(claim.supports) ? claim.supports : [];
    if (claim.claim_type === "lexical_knowledge") {
      return supports.some((item) => lexicalSupport(claim, item, maps, result));
    }
    if (claim.claim_type === "contextual_mapping") {
      return supports.some((item) => item.source_kind === "page_evidence"
        && contextualSupport(claim, maps.page.get(item.source_id), result, maps, request));
    }
    if (claim.claim_type === "author_intent") {
      return supports.some((item) => item.source_kind === "page_evidence"
        && authorIntentSupport(claim, maps.page.get(item.source_id), result));
    }
    if (claim.claim_type === "high_risk_fact") {
      return supports.some((item) => item.source_kind === "page_evidence"
        ? highRiskPageSupport(claim, maps.page.get(item.source_id), result)
        : item.source_kind === "external_source" && externalSupport(claim, maps.external.get(item.source_id), result));
    }
    return false;
  }

  function verify(result, request = {}) {
    const maps = sourceMaps(result, request);
    const details = [];
    const errors = [];
    const invalidClaimIds = [];
    for (const claim of result.claims || []) {
      const supported = verifyClaim(claim, maps, result, request);
      details.push({ claim_id: claim.claim_id, claim_type: claim.claim_type, supported });
      if (!supported) {
        invalidClaimIds.push(claim.claim_id);
        errors.push(`CLAIM_NOT_SEMANTICALLY_SUPPORTED:${claim.claim_id}`);
      }
    }
    return { ok: errors.length === 0, errors, invalid_claim_ids: invalidClaimIds, details };
  }

  return { verify, semanticTokens, overlap, specificAtoms };
});

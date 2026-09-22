(function attachYuliuGroundingContractV2(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuGroundingContractV2 = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createGroundingContractV2() {
  const RESOLUTION_STATUSES = new Set(["clear", "inferred", "ambiguous", "insufficient", "unrecognized"]);
  const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
  const REFERENT_TYPES = new Set([
    "generic_concept", "organization", "product", "person", "method", "metric", "document_defined_term", "other",
  ]);
  const SPECIFICITIES = new Set(["category", "named_entity", "exact_variant"]);
  const CLAIM_TYPES = new Set(["lexical_knowledge", "contextual_mapping", "author_intent", "high_risk_fact"]);
  const SOURCE_KINDS = new Set(["model_knowledge", "page_evidence", "external_source"]);
  const PAGE_EVIDENCE_ROLES = new Set([
    "direct_support", "coreference_support", "structural_support", "sense_disambiguation", "author_intent_support",
  ]);
  const NOTICE_CODES = new Set(["none", "multiple_senses", "insufficient_context", "term_unrecognized", "external_lookup_failed"]);

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function pushUnique(errors, code) {
    if (!errors.includes(code)) errors.push(code);
  }

  function supportRefValid(support, pageIds, externalIds) {
    if (!isObject(support) || !SOURCE_KINDS.has(support.source_kind)) return false;
    if (support.source_kind === "model_knowledge") return !support.source_id;
    if (!text(support.source_id)) return false;
    if (support.source_kind === "page_evidence") return pageIds.has(support.source_id);
    return externalIds.has(support.source_id);
  }

  function validate(value) {
    const errors = [];
    if (!isObject(value)) return { ok: false, errors: ["INVALID_ROOT"] };
    if (value.schema_version !== "2.0") pushUnique(errors, "INVALID_SCHEMA_VERSION");
    if (!text(value.selected_text)) pushUnique(errors, "MISSING_SELECTED_TEXT");

    const pageEvidence = Array.isArray(value.page_evidence) ? value.page_evidence : [];
    const pageIds = new Set();
    for (const item of pageEvidence) {
      const id = text(item?.evidence_id);
      if (!id || pageIds.has(id)) pushUnique(errors, "INVALID_PAGE_EVIDENCE_ID");
      else pageIds.add(id);
      if (!text(item?.block_id) || !text(item?.quote)) pushUnique(errors, "INVALID_PAGE_EVIDENCE");
      if (!PAGE_EVIDENCE_ROLES.has(item?.role)) pushUnique(errors, "INVALID_PAGE_EVIDENCE_ROLE");
    }

    const externalSources = Array.isArray(value.external_sources) ? value.external_sources : [];
    const externalIds = new Set();
    for (const item of externalSources) {
      const id = text(item?.source_id);
      if (!id || externalIds.has(id)) pushUnique(errors, "INVALID_EXTERNAL_SOURCE_ID");
      else externalIds.add(id);
      if (!text(item?.title) || !text(item?.url)) pushUnique(errors, "INVALID_EXTERNAL_SOURCE");
    }

    const candidates = Array.isArray(value.candidate_senses) ? value.candidate_senses : [];
    const candidateIds = new Set();
    for (const candidate of candidates) {
      const id = text(candidate?.sense_id);
      if (!id || candidateIds.has(id)) pushUnique(errors, "INVALID_CANDIDATE_ID");
      else candidateIds.add(id);
      if (!text(candidate?.label) || !text(candidate?.gloss)) pushUnique(errors, "INVALID_CANDIDATE_TEXT");
      if (!REFERENT_TYPES.has(candidate?.referent_type)) pushUnique(errors, "INVALID_CANDIDATE_REFERENT");
      const supports = Array.isArray(candidate?.supports) ? candidate.supports : [];
      if (!supports.length || supports.some((support) => !supportRefValid(support, pageIds, externalIds))) {
        pushUnique(errors, "INVALID_CANDIDATE_SUPPORT");
      }
    }

    const resolution = isObject(value.resolution) ? value.resolution : {};
    const status = resolution.status;
    if (!RESOLUTION_STATUSES.has(status)) pushUnique(errors, "INVALID_RESOLUTION_STATUS");
    if (!CONFIDENCE_LEVELS.has(resolution.confidence)) pushUnique(errors, "INVALID_CONFIDENCE");
    if (!SPECIFICITIES.has(resolution.specificity)) pushUnique(errors, "INVALID_SPECIFICITY");
    const selectedSenseId = resolution.selected_sense_id == null ? null : text(resolution.selected_sense_id);
    const alternatives = Array.isArray(resolution.alternative_sense_ids) ? resolution.alternative_sense_ids.map(text).filter(Boolean) : [];
    if (["clear", "inferred"].includes(status)) {
      if (!selectedSenseId || !candidateIds.has(selectedSenseId)) pushUnique(errors, "RESOLVED_WITHOUT_SELECTED_SENSE");
    } else if (selectedSenseId) {
      pushUnique(errors, "UNRESOLVED_WITH_SELECTED_SENSE");
    }
    if (alternatives.some((id) => !candidateIds.has(id))) pushUnique(errors, "UNKNOWN_ALTERNATIVE_SENSE");
    if (status === "ambiguous" && alternatives.length < 2) pushUnique(errors, "AMBIGUOUS_WITHOUT_ALTERNATIVES");

    const meaningHere = isObject(value.meaning_here) ? value.meaning_here : {};
    if (!text(meaningHere.text)) pushUnique(errors, "MISSING_MEANING_HERE");

    const claims = Array.isArray(value.claims) ? value.claims : [];
    const claimIds = new Set();
    const claimTypes = new Map();
    for (const claim of claims) {
      const id = text(claim?.claim_id);
      if (!id || claimIds.has(id)) pushUnique(errors, "INVALID_CLAIM_ID");
      else claimIds.add(id);
      if (!CLAIM_TYPES.has(claim?.claim_type)) pushUnique(errors, "INVALID_CLAIM_TYPE");
      else claimTypes.set(id, claim.claim_type);
      if (!text(claim?.text)) pushUnique(errors, "INVALID_CLAIM_TEXT");
      const supports = Array.isArray(claim?.supports) ? claim.supports : [];
      if (!supports.length || supports.some((support) => !supportRefValid(support, pageIds, externalIds))) {
        pushUnique(errors, `INVALID_CLAIM_SUPPORT:${id || "empty"}`);
        continue;
      }
      const kinds = new Set(supports.map((support) => support.source_kind));
      if (["contextual_mapping", "author_intent"].includes(claim.claim_type) && !kinds.has("page_evidence")) {
        pushUnique(errors, `PAGE_SUPPORT_REQUIRED:${id}`);
      }
      if (claim.claim_type === "high_risk_fact" && !kinds.has("page_evidence") && !kinds.has("external_source")) {
        pushUnique(errors, `VERIFIED_SUPPORT_REQUIRED:${id}`);
      }
    }

    if (["clear", "inferred", "ambiguous"].includes(status) && !claims.length) pushUnique(errors, "ANSWER_WITHOUT_CLAIMS");

    if (value.author_intent != null) {
      const authorIntent = isObject(value.author_intent) ? value.author_intent : {};
      if (!text(authorIntent.text)) pushUnique(errors, "INVALID_AUTHOR_INTENT");
      const authorClaimIds = Array.isArray(authorIntent.claim_ids) ? authorIntent.claim_ids.map(text).filter(Boolean) : [];
      if (!authorClaimIds.length || authorClaimIds.some((id) => claimTypes.get(id) !== "author_intent")) {
        pushUnique(errors, "AUTHOR_INTENT_WITHOUT_MATCHING_CLAIM");
      }
    }

    const notice = value.notice_code;
    if (!NOTICE_CODES.has(notice)) pushUnique(errors, "INVALID_NOTICE_CODE");
    if (["clear", "inferred"].includes(status) && notice !== "none") pushUnique(errors, "NOTICE_FALSE_POSITIVE");
    if (status === "ambiguous" && notice !== "multiple_senses") pushUnique(errors, "AMBIGUOUS_NOTICE_MISMATCH");
    if (status === "insufficient" && !["insufficient_context", "external_lookup_failed"].includes(notice)) {
      pushUnique(errors, "INSUFFICIENT_NOTICE_MISMATCH");
    }
    if (status === "unrecognized" && notice !== "term_unrecognized") pushUnique(errors, "UNRECOGNIZED_NOTICE_MISMATCH");

    return { ok: errors.length === 0, errors };
  }

  return {
    validate,
    constants: {
      RESOLUTION_STATUSES: [...RESOLUTION_STATUSES],
      CLAIM_TYPES: [...CLAIM_TYPES],
      SOURCE_KINDS: [...SOURCE_KINDS],
      PAGE_EVIDENCE_ROLES: [...PAGE_EVIDENCE_ROLES],
      NOTICE_CODES: [...NOTICE_CODES],
    },
  };
});

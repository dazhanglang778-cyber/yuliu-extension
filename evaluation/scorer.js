(function attachYuliuEvaluation(root, factory) {
  const verifier = root.YuliuClaimVerification
    || (typeof module !== "undefined" && module.exports ? require("../claim-verification.js") : null);
  const api = factory(verifier);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuEvaluation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createYuliuEvaluation(ClaimVerification) {
  const SPECIFICITY_RANK = { category: 0, named_entity: 1, exact_variant: 2 };

  function normalize(value) {
    return String(value ?? "").toLocaleLowerCase().replace(/\s+/g, "").replace(/[“”'‘’`，。；：、,.!?！？()（）\[\]【】]/g, "");
  }

  function includesTerm(text, term) {
    const haystack = normalize(text);
    const needle = normalize(term);
    return !!needle && haystack.includes(needle);
  }

  function characterBigrams(value) {
    const text = normalize(value);
    if (text.length < 2) return text ? [text] : [];
    const grams = [];
    for (let index = 0; index < text.length - 1; index += 1) grams.push(text.slice(index, index + 2));
    return [...new Set(grams)];
  }

  function textSimilarity(left, right) {
    const leftSet = new Set(characterBigrams(left));
    const rightSet = new Set(characterBigrams(right));
    if (!leftSet.size || !rightSet.size) return 0;
    const shared = [...leftSet].filter((item) => rightSet.has(item)).length;
    return shared / (leftSet.size + rightSet.size - shared);
  }

  function semanticVerification(rawResult, blockMap) {
    if (!rawResult || rawResult.schema_version !== "2.0" || !ClaimVerification?.verify) return null;
    const evidenceCandidates = (rawResult.page_evidence || []).map((item) => ({
      evidence_id: item.evidence_id,
      block_id: item.block_id,
      role: item.role,
      quote: item.quote,
      text: blockMap.get(item.block_id) || item.quote || "",
      heading_path: [],
    }));
    return ClaimVerification.verify(rawResult, { documentContext: { evidence_candidates: evidenceCandidates } });
  }

  function caseIndex(dataset) {
    const map = new Map();
    for (const document of dataset?.documents || []) {
      for (const item of document.cases || []) map.set(item.case_id, { document, item });
    }
    return map;
  }

  function documentBlocksFromHtml(html) {
    const blocks = new Map();
    const pattern = /<(h[1-6]|p|li|blockquote|pre|td|th|figcaption)\b[^>]*data-block-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = pattern.exec(String(html || "")))) {
      const text = match[3]
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();
      blocks.set(match[2], text);
    }
    return blocks;
  }

  function noticeExpected(certainty) {
    if (certainty === "ambiguous") return "multiple_senses";
    if (certainty === "insufficient") return "insufficient_context";
    return "none";
  }

  function resultView(value) {
    if (!value || value.schema_version !== "2.0") return value;
    const senses = Array.isArray(value.candidate_senses) ? value.candidate_senses : [];
    const selected = senses.find((item) => item?.sense_id === value.resolution?.selected_sense_id) || null;
    return {
      ...value,
      resolved_sense: selected ? {
        label: selected.label,
        referent_type: selected.referent_type,
        specificity: value.resolution?.specificity,
      } : { label: "当前所指尚未唯一确定", referent_type: "other", specificity: value.resolution?.specificity || "category" },
      meaning_here: value.meaning_here?.text || "",
      author_intent: value.author_intent?.text || null,
      certainty: value.resolution?.status || "",
      evidence: Array.isArray(value.page_evidence) ? value.page_evidence : [],
    };
  }

  function evaluateCase(gold, prediction, blockMap = new Map(), trace = {}) {
    const rawResult = prediction && Object.prototype.hasOwnProperty.call(prediction, "result")
      ? prediction.result
      : prediction || null;
    const result = resultView(rawResult);
    const failures = [];
    const checks = {};
    checks.output_schema = !!result
      && typeof result.meaning_here === "string"
      && !!result.resolved_sense
      && Array.isArray(result.claims)
      && Array.isArray(result.evidence);
    if (!checks.output_schema) failures.push("OUTPUT_SCHEMA_FAILURE");
    if (!result) {
      const noOutputFailures = ["NO_OUTPUT"];
      if (prediction?._meta?.pipeline_error) noOutputFailures.push("PIPELINE_REQUEST_FAILED");
      return { case_id: gold.case_id, passed: false, checks, failures: noOutputFailures, metrics: emptyCaseMetrics(), trace };
    }
    checks.pipeline_completed = !prediction?._meta?.generation_error;
    if (!checks.pipeline_completed) failures.push("MODEL_GENERATION_FAILED");

    checks.selection_match = normalize(result.selected_text) === normalize(gold.selection.exact);
    if (!checks.selection_match) failures.push("SELECTION_MISMATCH");
    const answerText = `${result.resolved_sense?.label || ""} ${result.meaning_here || ""}`;
    const missingGroups = (gold.expected.must_include_groups || []).filter((group) => !group.some((term) => includesTerm(answerText, term)));
    checks.required_information = missingGroups.length === 0;
    if (!checks.required_information) failures.push("MISSING_KEY_INFORMATION");
    const forbiddenHits = (gold.expected.must_not_include || []).filter((term) => includesTerm(answerText, term));
    checks.forbidden_information = forbiddenHits.length === 0;
    if (!checks.forbidden_information) failures.push("FORBIDDEN_CONTENT");
    checks.referent_type = result.resolved_sense?.referent_type === gold.expected.referent_type;
    if (!checks.referent_type) failures.push("REFERENT_TYPE_MISMATCH");
    const actualSpecificity = SPECIFICITY_RANK[result.resolved_sense?.specificity];
    const maximumSpecificity = SPECIFICITY_RANK[gold.expected.maximum_specificity];
    checks.specificity_safe = Number.isInteger(actualSpecificity) && actualSpecificity <= maximumSpecificity;
    if (!checks.specificity_safe) failures.push("UNJUSTIFIED_SPECIFICITY");
    checks.certainty = result.certainty === gold.expected.certainty;
    if (!checks.certainty) failures.push("CERTAINTY_MISMATCH");

    const expectedNotice = noticeExpected(gold.expected.certainty);
    checks.notice = result.notice_code === expectedNotice
      || (gold.expected.certainty === "insufficient" && result.notice_code === "external_knowledge_needed");
    if (!checks.notice) {
      failures.push(["clear", "inferred"].includes(gold.expected.certainty) && result.notice_code !== "none"
        ? "NOTICE_FALSE_POSITIVE"
        : "NOTICE_STATE_MISMATCH");
    }

    const predictedEvidence = Array.isArray(result.evidence) ? result.evidence : [];
    let validEvidenceCount = 0;
    for (const evidence of predictedEvidence) {
      const block = blockMap.get(evidence.block_id);
      if (!block) {
        failures.push("EVIDENCE_BLOCK_NOT_FOUND");
        continue;
      }
      if (!String(block).replace(/\s+/g, " ").includes(String(evidence.quote || "").replace(/\s+/g, " ").trim())) {
        failures.push("EVIDENCE_QUOTE_MISMATCH");
        continue;
      }
      validEvidenceCount += 1;
    }
    checks.evidence_valid = predictedEvidence.length > 0 && validEvidenceCount === predictedEvidence.length;
    if (!checks.evidence_valid) failures.push("EVIDENCE_INVALID");
    const predictedBlockIds = new Set(predictedEvidence.map((item) => item.block_id));
    const expectedEvidence = gold.evidence || [];
    const expectedDirect = expectedEvidence.filter((item) => item.role === "direct_support");
    const supportTargets = expectedDirect.length ? expectedDirect : expectedEvidence;
    checks.evidence_support = supportTargets.some((item) => predictedBlockIds.has(item.block_id));
    if (!checks.evidence_support) failures.push("EVIDENCE_MISS");
    const goldEvidenceHits = expectedEvidence.filter((item) => predictedBlockIds.has(item.block_id)).length;
    const goldEvidenceRecall = expectedEvidence.length ? goldEvidenceHits / expectedEvidence.length : 1;

    const retrievedIds = new Set(trace.retrieved_block_ids || []);
    const retrievalTargets = supportTargets.map((item) => item.block_id);
    checks.retrieval_support = !retrievalTargets.length || retrievalTargets.some((id) => retrievedIds.has(id));
    if (Array.isArray(trace.retrieved_block_ids) && !checks.retrieval_support) failures.push("RETRIEVAL_MISS");
    if (checks.retrieval_support && !checks.evidence_support) failures.push("GENERATION_IGNORED_RETRIEVED_EVIDENCE");

    const senseCorrect = checks.required_information
      && checks.forbidden_information
      && checks.referent_type
      && checks.specificity_safe;
    if (!senseCorrect && !failures.includes("MISSING_KEY_INFORMATION")) failures.push("SENSE_MISMATCH");
    const expectedAuthorIntent = gold.expected.author_intent_required === true;
    const authorIntentText = String(result.author_intent || "").trim();
    const authorIntentPresent = authorIntentText.length > 0;
    checks.author_intent_appropriate = expectedAuthorIntent ? authorIntentPresent : !authorIntentPresent;
    if (!checks.author_intent_appropriate) failures.push(expectedAuthorIntent ? "AUTHOR_INTENT_MISSING" : "AUTHOR_INTENT_UNNECESSARY");
    const authorIntentSimilarity = authorIntentPresent ? textSimilarity(result.meaning_here, authorIntentText) : null;
    checks.author_intent_distinct = authorIntentPresent ? authorIntentSimilarity < 0.72 : true;
    if (!checks.author_intent_distinct) failures.push("AUTHOR_INTENT_DUPLICATES_MEANING");

    const semantic = semanticVerification(rawResult, blockMap);
    checks.semantic_support = semantic == null ? null : semantic.ok;
    if (checks.semantic_support === false) failures.push("CLAIM_SEMANTIC_SUPPORT_FAILURE");

    const refusalStatuses = new Set(["ambiguous", "insufficient", "unrecognized"]);
    const overRefusal = ["clear", "inferred"].includes(gold.expected.certainty)
      && (refusalStatuses.has(result.certainty) || ["insufficient_context", "external_knowledge_needed", "multiple_senses"].includes(result.notice_code));
    const usefulAnswer = checks.selection_match
      && senseCorrect
      && checks.certainty
      && checks.notice
      && String(result.meaning_here || "").trim().length >= 6;
    const elapsedValue = prediction?._meta?.elapsed_ms;
    const responseTime = elapsedValue == null ? Number.NaN : Number(elapsedValue);
    const passed = checks.output_schema
      && checks.selection_match
      && senseCorrect
      && checks.certainty
      && checks.notice
      && checks.evidence_valid
      && checks.evidence_support
      && checks.pipeline_completed
      && checks.author_intent_appropriate
      && checks.author_intent_distinct
      && checks.semantic_support !== false;
    return {
      case_id: gold.case_id,
      category: gold.category,
      difficulty: gold.difficulty,
      passed,
      checks,
      failures: [...new Set(failures)],
      details: {
        missing_groups: missingGroups,
        forbidden_hits: forbiddenHits,
        author_intent_similarity: authorIntentSimilarity,
        semantic_verification: semantic,
      },
      metrics: {
        format_valid: checks.output_schema ? 1 : 0,
        selection_correct: checks.selection_match ? 1 : 0,
        sense_correct: senseCorrect ? 1 : 0,
        certainty_correct: checks.certainty ? 1 : 0,
        evidence_valid: checks.evidence_valid ? 1 : 0,
        evidence_support: checks.evidence_support ? 1 : 0,
        gold_evidence_recall: goldEvidenceRecall,
        unsupported_specificity: checks.specificity_safe ? 0 : 1,
        notice_false_positive: failures.includes("NOTICE_FALSE_POSITIVE") ? 1 : 0,
        first_pass_success: prediction?._meta?.validation_attempts === 1 ? 1 : 0,
        useful_answer: usefulAnswer ? 1 : 0,
        over_refusal: overRefusal ? 1 : 0,
        semantic_support: checks.semantic_support == null ? null : (checks.semantic_support ? 1 : 0),
        author_intent_appropriate: checks.author_intent_appropriate ? 1 : 0,
        author_intent_distinct: authorIntentPresent ? (checks.author_intent_distinct ? 1 : 0) : null,
        response_time_ms: Number.isFinite(responseTime) && responseTime >= 0 ? responseTime : null,
      },
      trace,
    };
  }

  function emptyCaseMetrics() {
    return {
      format_valid: 0, selection_correct: 0, sense_correct: 0, certainty_correct: 0,
      evidence_valid: 0, evidence_support: 0, gold_evidence_recall: 0,
      unsupported_specificity: 0, notice_false_positive: 0, first_pass_success: 0,
      useful_answer: 0, over_refusal: 0, semantic_support: null,
      author_intent_appropriate: 0, author_intent_distinct: null, response_time_ms: null,
    };
  }

  function average(cases, field, filter = () => true) {
    const eligible = cases.filter((item) => filter(item) && Number.isFinite(item.metrics[field]));
    if (!eligible.length) return null;
    return eligible.reduce((sum, item) => sum + Number(item.metrics[field]), 0) / eligible.length;
  }

  function percentile(cases, field, fraction) {
    const values = cases.map((item) => item.metrics[field]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) return null;
    const index = Math.max(0, Math.ceil(values.length * fraction) - 1);
    return Math.round(values[index]);
  }

  function roundRate(value) {
    return value == null ? null : Number((value * 100).toFixed(1));
  }

  function aggregate(caseResults) {
    const cases = caseResults || [];
    const failureCounts = {};
    for (const item of cases) {
      for (const failure of item.failures || []) failureCounts[failure] = (failureCounts[failure] || 0) + 1;
    }
    const summary = {
      total_cases: cases.length,
      passed_cases: cases.filter((item) => item.passed).length,
      core_pass_rate: roundRate(cases.length ? cases.filter((item) => item.passed).length / cases.length : null),
      format_validity: roundRate(average(cases, "format_valid")),
      selection_accuracy: roundRate(average(cases, "selection_correct")),
      sense_accuracy: roundRate(average(cases, "sense_correct")),
      certainty_accuracy: roundRate(average(cases, "certainty_correct")),
      evidence_validity: roundRate(average(cases, "evidence_valid")),
      evidence_support_rate: roundRate(average(cases, "evidence_support")),
      gold_evidence_recall: roundRate(average(cases, "gold_evidence_recall")),
      unsupported_specificity_rate: roundRate(average(cases, "unsupported_specificity")),
      notice_false_positive_rate: roundRate(average(cases, "notice_false_positive", (item) => ["clear", "inferred"].includes(item.trace?.expected_certainty))),
      first_pass_success_rate: roundRate(average(cases, "first_pass_success")),
      useful_answer_rate: roundRate(average(cases, "useful_answer")),
      over_refusal_rate: roundRate(average(cases, "over_refusal", (item) => ["clear", "inferred"].includes(item.trace?.expected_certainty))),
      semantic_support_rate: roundRate(average(cases, "semantic_support")),
      author_intent_appropriateness: roundRate(average(cases, "author_intent_appropriate")),
      author_intent_distinction: roundRate(average(cases, "author_intent_distinct")),
      average_response_time_ms: average(cases, "response_time_ms") == null ? null : Math.round(average(cases, "response_time_ms")),
      p95_response_time_ms: percentile(cases, "response_time_ms", 0.95),
      failure_counts: failureCounts,
    };
    summary.by_difficulty = sliceSummaries(cases, (item) => item.difficulty || "unknown");
    summary.by_category = sliceSummaries(cases, (item) => item.category || "unknown");
    summary.release_gate = buildReleaseGate(summary);
    return summary;
  }

  function sliceSummaries(cases, keyFor) {
    const groups = new Map();
    for (const item of cases) {
      const key = keyFor(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return Object.fromEntries([...groups].map(([key, items]) => [key, {
      total_cases: items.length,
      core_pass_rate: roundRate(items.filter((item) => item.passed).length / items.length),
      sense_accuracy: roundRate(average(items, "sense_correct")),
      evidence_validity: roundRate(average(items, "evidence_valid")),
      unsupported_specificity_rate: roundRate(average(items, "unsupported_specificity")),
      useful_answer_rate: roundRate(average(items, "useful_answer")),
      over_refusal_rate: roundRate(average(items, "over_refusal", (item) => ["clear", "inferred"].includes(item.trace?.expected_certainty))),
    }]));
  }

  function buildReleaseGate(summary) {
    const checks = {
      core_pass_rate: { target: 95, actual: summary.core_pass_rate },
      format_validity: { target: 99, actual: summary.format_validity },
      sense_accuracy: { target: 95, actual: summary.sense_accuracy },
      unsupported_specificity_rate: { target: 1, actual: summary.unsupported_specificity_rate, maximum: true },
      first_pass_success_rate: { target: 95, actual: summary.first_pass_success_rate },
      useful_answer_rate: { target: 90, actual: summary.useful_answer_rate },
      over_refusal_rate: { target: 5, actual: summary.over_refusal_rate, maximum: true },
      semantic_support_rate: { target: 95, actual: summary.semantic_support_rate },
      author_intent_appropriateness: { target: 95, actual: summary.author_intent_appropriateness },
      author_intent_distinction: { target: 90, actual: summary.author_intent_distinction },
      p95_response_time_ms: { target: 15000, actual: summary.p95_response_time_ms, maximum: true },
    };
    for (const item of Object.values(checks)) {
      item.evaluated = item.actual != null;
      item.passed = !item.evaluated || (item.maximum ? item.actual <= item.target : item.actual >= item.target);
    }
    return { passed: Object.values(checks).every((item) => item.passed), checks };
  }

  function normalizedEvidenceReview(item, index = 0) {
    return {
      rank: Number(item?.rank) || index + 1,
      evidence_id: item?.evidence_id || null,
      block_id: item?.block_id || null,
      role: item?.role || null,
      quote: String(item?.quote || item?.text || "").trim(),
      heading_path: Array.isArray(item?.heading_path) ? item.heading_path : [],
      reasons: Array.isArray(item?.reasons) ? item.reasons : [],
    };
  }

  function buildCaseReview(document, gold, prediction, blockMap, trace, scored) {
    const rawResult = prediction && Object.prototype.hasOwnProperty.call(prediction, "result")
      ? prediction.result
      : prediction || null;
    const result = resultView(rawResult);
    const retrieved = Array.isArray(trace?.retrieved_evidence)
      ? trace.retrieved_evidence.map(normalizedEvidenceReview)
      : (trace?.retrieved_block_ids || []).map((blockId, index) => normalizedEvidenceReview({
        rank: index + 1,
        block_id: blockId,
        quote: blockMap.get(blockId) || "",
      }, index));
    const adopted = Array.isArray(result?.evidence)
      ? result.evidence.map(normalizedEvidenceReview)
      : [];
    return {
      evaluation_scope: result ? "end_to_end" : "retrieval_only",
      scope_note: result
        ? "本案例已经执行模型生成、证据校验和最终评分。"
        : "本案例只验证RAG证据召回，没有生成实际释义，不能据此判断最终回答是否正确。",
      document: {
        document_id: document?.document_id || trace?.document_id || null,
        title: document?.title || "",
      },
      selection: {
        text: gold.selection.exact,
        anchor_block_id: gold.selection.anchor_block_id,
        anchor_context: String(blockMap.get(gold.selection.anchor_block_id) || trace?.anchor_text || "").trim(),
      },
      expected: {
        meaning: gold.expected.reference_answer || gold.expected.sense || "",
        sense: gold.expected.sense || "",
        certainty: gold.expected.certainty,
        author_intent_required: gold.expected.author_intent_required === true,
        evidence: (gold.evidence || []).map(normalizedEvidenceReview),
        must_include_groups: gold.expected.must_include_groups || [],
        must_not_include: gold.expected.must_not_include || [],
      },
      actual: result ? {
        meaning: String(result.meaning_here || "").trim(),
        author_intent: String(result.author_intent || "").trim(),
        certainty: result.certainty || "",
        resolved_sense: result.resolved_sense || null,
        notice_code: result.notice_code || "none",
        adopted_evidence: adopted,
      } : null,
      retrieval: {
        retrieved_evidence: retrieved,
        expected_support_recalled: scored?.checks
          ? scored.checks.retrieval_support !== false
          : scored?.support_recalled !== false,
      },
      execution: {
        validation_attempts: prediction?._meta?.validation_attempts ?? null,
        locally_degraded: prediction?._meta?.locally_degraded === true,
        removed_claim_ids: prediction?._meta?.removed_claim_ids || [],
        validation_errors: prediction?._meta?.validation_errors || [],
        elapsed_ms: prediction?._meta?.elapsed_ms ?? null,
        pipeline_error: prediction?._meta?.pipeline_error || prediction?._meta?.error || "",
      },
    };
  }

  function evaluateDataset(dataset, predictions, documents = {}) {
    const predictionsById = new Map((predictions || []).map((item) => [item.case_id, item]));
    const cases = [];
    for (const document of dataset?.documents || []) {
      const blocks = documents[document.document_id] instanceof Map
        ? documents[document.document_id]
        : documentBlocksFromHtml(documents[document.document_id] || "");
      for (const gold of document.cases || []) {
        const prediction = predictionsById.get(gold.case_id) || null;
        const trace = {
          ...(prediction?.trace || {}),
          expected_certainty: gold.expected.certainty,
          expected_author_intent_required: gold.expected.author_intent_required === true,
          document_id: document.document_id,
        };
        const scored = evaluateCase(gold, prediction, blocks, trace);
        scored.review = buildCaseReview(document, gold, prediction, blocks, trace, scored);
        cases.push(scored);
      }
    }
    return { summary: aggregate(cases), cases };
  }

  function evaluateRetrieval(dataset, traces, documents = {}) {
    const byId = new Map((traces || []).map((item) => [item.case_id, item]));
    const cases = [];
    for (const document of dataset?.documents || []) {
      const blocks = documents[document.document_id] instanceof Map
        ? documents[document.document_id]
        : documentBlocksFromHtml(documents[document.document_id] || "");
      for (const gold of document.cases || []) {
        const trace = byId.get(gold.case_id) || { retrieved_block_ids: [] };
        const retrieved = new Set(trace.retrieved_block_ids || []);
        const direct = gold.evidence.filter((item) => item.role === "direct_support");
        const targets = direct.length ? direct : gold.evidence;
        const goldHits = gold.evidence.filter((item) => retrieved.has(item.block_id)).length;
        const supportHit = targets.some((item) => retrieved.has(item.block_id));
        const scored = {
          case_id: gold.case_id,
          document_id: document.document_id,
          category: gold.category,
          difficulty: gold.difficulty,
          passed: supportHit,
          anchor_recalled: retrieved.has(gold.selection.anchor_block_id),
          support_recalled: supportHit,
          gold_evidence_recall: gold.evidence.length ? goldHits / gold.evidence.length : 1,
          failures: supportHit ? [] : ["RETRIEVAL_MISS"],
          retrieved_block_ids: [...retrieved],
        };
        scored.review = buildCaseReview(document, gold, null, blocks, trace, scored);
        cases.push(scored);
      }
    }
    return {
      summary: {
        total_cases: cases.length,
        anchor_recall: roundRate(cases.length ? cases.filter((item) => item.anchor_recalled).length / cases.length : null),
        support_recall: roundRate(cases.length ? cases.filter((item) => item.support_recalled).length / cases.length : null),
        gold_evidence_recall: roundRate(cases.length ? cases.reduce((sum, item) => sum + item.gold_evidence_recall, 0) / cases.length : null),
        retrieval_misses: cases.filter((item) => !item.support_recalled).length,
      },
      cases,
    };
  }

  return { normalize, documentBlocksFromHtml, evaluateCase, aggregate, evaluateDataset, evaluateRetrieval, caseIndex, buildReleaseGate, buildCaseReview };
});

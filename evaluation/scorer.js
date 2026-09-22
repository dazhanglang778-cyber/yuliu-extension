(function attachYuliuEvaluation(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuEvaluation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createYuliuEvaluation() {
  const SPECIFICITY_RANK = { category: 0, named_entity: 1, exact_variant: 2 };

  function normalize(value) {
    return String(value ?? "").toLocaleLowerCase().replace(/\s+/g, "").replace(/[“”'‘’`，。；：、,.!?！？()（）\[\]【】]/g, "");
  }

  function includesTerm(text, term) {
    const haystack = normalize(text);
    const needle = normalize(term);
    return !!needle && haystack.includes(needle);
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

  function evaluateCase(gold, prediction, blockMap = new Map(), trace = {}) {
    const result = prediction?.result || prediction || null;
    const failures = [];
    const checks = {};
    checks.output_schema = !!result
      && typeof result.meaning_here === "string"
      && !!result.resolved_sense
      && Array.isArray(result.claims)
      && Array.isArray(result.evidence);
    if (!checks.output_schema) failures.push("OUTPUT_SCHEMA_FAILURE");
    if (!result) {
      return { case_id: gold.case_id, passed: false, checks, failures: ["NO_OUTPUT"], metrics: emptyCaseMetrics(), trace };
    }

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
    const passed = checks.output_schema
      && checks.selection_match
      && senseCorrect
      && checks.certainty
      && checks.notice
      && checks.evidence_valid
      && checks.evidence_support;
    return {
      case_id: gold.case_id,
      category: gold.category,
      difficulty: gold.difficulty,
      passed,
      checks,
      failures: [...new Set(failures)],
      details: { missing_groups: missingGroups, forbidden_hits: forbiddenHits },
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
      },
      trace,
    };
  }

  function emptyCaseMetrics() {
    return {
      format_valid: 0, selection_correct: 0, sense_correct: 0, certainty_correct: 0,
      evidence_valid: 0, evidence_support: 0, gold_evidence_recall: 0,
      unsupported_specificity: 0, notice_false_positive: 0, first_pass_success: 0,
    };
  }

  function average(cases, field, filter = () => true) {
    const eligible = cases.filter(filter);
    if (!eligible.length) return null;
    return eligible.reduce((sum, item) => sum + Number(item.metrics[field] || 0), 0) / eligible.length;
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
    }]));
  }

  function buildReleaseGate(summary) {
    const checks = {
      core_pass_rate: { target: 95, actual: summary.core_pass_rate },
      format_validity: { target: 99, actual: summary.format_validity },
      sense_accuracy: { target: 95, actual: summary.sense_accuracy },
      unsupported_specificity_rate: { target: 1, actual: summary.unsupported_specificity_rate, maximum: true },
      first_pass_success_rate: { target: 95, actual: summary.first_pass_success_rate },
    };
    for (const item of Object.values(checks)) {
      item.passed = item.actual != null && (item.maximum ? item.actual <= item.target : item.actual >= item.target);
    }
    return { passed: Object.values(checks).every((item) => item.passed), checks };
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
          document_id: document.document_id,
        };
        cases.push(evaluateCase(gold, prediction, blocks, trace));
      }
    }
    return { summary: aggregate(cases), cases };
  }

  function evaluateRetrieval(dataset, traces) {
    const byId = new Map((traces || []).map((item) => [item.case_id, item]));
    const cases = [];
    for (const document of dataset?.documents || []) {
      for (const gold of document.cases || []) {
        const trace = byId.get(gold.case_id) || { retrieved_block_ids: [] };
        const retrieved = new Set(trace.retrieved_block_ids || []);
        const direct = gold.evidence.filter((item) => item.role === "direct_support");
        const targets = direct.length ? direct : gold.evidence;
        const goldHits = gold.evidence.filter((item) => retrieved.has(item.block_id)).length;
        const supportHit = targets.some((item) => retrieved.has(item.block_id));
        cases.push({
          case_id: gold.case_id,
          document_id: document.document_id,
          anchor_recalled: retrieved.has(gold.selection.anchor_block_id),
          support_recalled: supportHit,
          gold_evidence_recall: gold.evidence.length ? goldHits / gold.evidence.length : 1,
          failures: supportHit ? [] : ["RETRIEVAL_MISS"],
          retrieved_block_ids: [...retrieved],
        });
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

  return { normalize, documentBlocksFromHtml, evaluateCase, aggregate, evaluateDataset, evaluateRetrieval, caseIndex, buildReleaseGate };
});

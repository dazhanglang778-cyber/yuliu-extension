(function attach(root, factory) {
  const node = typeof module !== "undefined" && module.exports;
  const api = factory(node ? require("../document-retrieval.js") : root.YuliuDocumentRetrieval);
  if (node) module.exports = api;
  root.YuliuContextualSuite = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Retrieval) {
  function prepare(item) {
    const blocks = item.blocks.map((text, i) => ({ block_id: `p${i}`, text, order: i, type: "paragraph", heading_path: [item.title] }));
    const anchor = blocks[item.anchor];
    const snapshot = { snapshot_version: "contextual-eval-v1", page: { title: item.title, url: `evaluation://${item.id}` }, blocks,
      selection: { raw_text: item.selection, normalized_text: item.selection, anchor_block_id: anchor.block_id,
        start_offset: anchor.text.indexOf(item.selection), occurrence_index: 0 }, extraction: { coverage: "fixture_complete", block_count: blocks.length, truncated: false } };
    const retrieval = Retrieval.retrieve(snapshot);
    snapshot.evidence_candidates = retrieval.candidates;
    snapshot.retrieval = retrieval.summary;
    return { selection: item.selection, documentContext: Retrieval.compactSnapshot(snapshot), retrieval };
  }
  function assess(item, prediction) {
    const result = prediction?.result;
    const answer = `${result?.meaning_here?.text || ""}\n${result?.author_intent?.text || ""}`;
    const adopted = new Set((result?.page_evidence || []).map((e) => e.block_id));
    const failures = [];
    for (const group of item.required || []) if (!group.some((s) => answer.includes(s))) failures.push(`未覆盖：${group.join("／")}`);
    for (const word of item.forbidden || []) if (answer.includes(word)) failures.push(`需人工检查的禁用主张：${word}`);
    if (!item.allowInsufficient && result?.resolution?.status === "insufficient") failures.push("可回答案例被拒答");
    if (!result) failures.push("未收到实际回答");
    const evidenceMissing = (item.evidenceBlocks || []).filter((i) => !adopted.has(`p${i}`));
    return { automatic_checks_passed: !failures.length, failures, evidenceMissing,
      human_review_required: true, scope: "关键词和来源覆盖检查不是语义正确性认证" };
  }
  async function run(dataset, options) {
    const rows = [];
    for (const item of dataset.cases) {
      if (options.cancelled?.()) break;
      const request = prepare(item);
      options.progress?.({ item, completed: rows.length, total: dataset.cases.length });
      let prediction, error = "";
      try {
        const response = await options.send({ type: "EVALUATION_CASE", caseId: item.id,
          selection: item.selection, documentContext: request.documentContext });
        if (!response?.ok) throw new Error(response?.error || "评测请求失败");
        prediction = response.prediction;
      } catch (failure) { error = failure.message; }
      const row = { id: item.id, split: item.split, kind: item.kind, source: item.blocks, selected: item.selection,
        anchor: item.anchor, expected: item.expected, reference: item.reference,
        actual: prediction?.result || null, trace: prediction?.trace || null, meta: prediction?._meta || null,
        retrieval: request.retrieval, checks: assess(item, prediction), error };
      rows.push(row);
      options.row?.(row);
    }
    return { dataset_id: dataset.dataset_id, source: dataset.source, mode: "live-model",
      generated_at: new Date().toISOString(), completed: rows.length, planned: dataset.cases.length, rows };
  }
  return { prepare, assess, run };
});

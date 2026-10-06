(function attachYuliuBrowserEvaluation(root, factory) {
  const api = factory(root.YuliuDocumentRetrieval, root.YuliuEvaluation);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuBrowserEvaluation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBrowserEvaluation(Retrieval, Scorer) {
  function normalizeHtml(value) {
    return String(value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  }

  function blocksFromHtml(html) {
    const blocks = [];
    const headings = [];
    const pattern = /<(h[1-6]|p|li|blockquote|pre|td|th|figcaption)\b[^>]*data-block-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = pattern.exec(String(html || "")))) {
      const tag = match[1].toLocaleLowerCase();
      const text = normalizeHtml(match[3]);
      const headingMatch = tag.match(/^h([1-6])$/);
      if (headingMatch) {
        const level = Number(headingMatch[1]);
        headings.length = level - 1;
        headings[level - 1] = text;
      }
      blocks.push({
        block_id: match[2], type: headingMatch ? "heading" : "paragraph",
        heading_path: headings.filter(Boolean), text, order: blocks.length,
      });
    }
    return blocks;
  }

  function prepareCase(document, gold, html) {
    const blocks = blocksFromHtml(html);
    const snapshot = {
      snapshot_version: "evaluation-browser-v1",
      selection: {
        raw_text: gold.selection.exact,
        normalized_text: gold.selection.exact,
        anchor_block_id: gold.selection.anchor_block_id,
        occurrence_index: gold.selection.occurrence_index,
      },
      page: { title: document.title, url: `evaluation://${document.document_id}` },
      blocks,
    };
    const retrieval = Retrieval.retrieve(snapshot);
    snapshot.evidence_candidates = retrieval.candidates;
    snapshot.retrieval = retrieval.summary;
    return { document, gold, html, snapshot, retrieval };
  }

  function retrievalTrace(entry) {
    const anchor = entry.snapshot.blocks.find((item) => item.block_id === entry.gold.selection.anchor_block_id);
    return {
      retrieved_block_ids: entry.retrieval.candidates.map((item) => item.block_id),
      anchor_text: anchor?.text || "",
      retrieved_evidence: entry.retrieval.candidates.map((item, index) => ({
        rank: index + 1,
        evidence_id: item.evidence_id,
        block_id: item.block_id,
        role: item.role,
        quote: item.quote || item.text || "",
        heading_path: item.heading_path || [],
        reasons: item.reasons || [],
      })),
    };
  }

  async function loadSuite(runtime, loadText = async (url) => (await fetch(url)).text()) {
    const datasetUrl = runtime.getURL("evaluation/datasets/core-context-v1.json");
    const dataset = JSON.parse(await loadText(datasetUrl));
    const prepared = [];
    const documents = {};
    for (const document of dataset.documents) {
      const html = await loadText(runtime.getURL(`evaluation/${document.file}`));
      documents[document.document_id] = html;
      for (const gold of document.cases) prepared.push(prepareCase(document, gold, html));
    }
    return { dataset, prepared, documents };
  }

  async function run(options = {}) {
    const runtime = options.runtime || globalThis.chrome?.runtime;
    if (!runtime?.sendMessage || !runtime?.getURL) throw new Error("只能在语流开发诊断后台运行实时评测。");
    const suite = await loadSuite(runtime, options.loadText);
    const predictions = [];
    for (let index = 0; index < suite.prepared.length; index += 1) {
      if (options.isCancelled?.()) break;
      const entry = suite.prepared[index];
      if (index > 0) await wait(Number.isFinite(options.caseDelayMs) ? options.caseDelayMs : 1800);
      options.onProgress?.({ index, total: suite.prepared.length, caseId: entry.gold.case_id, state: "running" });
      const compactContext = Retrieval.compactSnapshot(entry.snapshot, `evaluation-${entry.gold.case_id}`) || entry.snapshot;
      let prediction;
      try {
        const response = await runtime.sendMessage({
          type: "EVALUATION_CASE",
          caseId: entry.gold.case_id,
          selection: entry.gold.selection.exact,
          documentContext: compactContext,
        });
        if (!response?.ok) throw new Error(response?.error || "实时评测请求失败。");
        prediction = response.prediction;
      } catch (error) {
        prediction = {
          case_id: entry.gold.case_id,
          result: null,
          _meta: {
            validation_attempts: 0,
            valid: false,
            pipeline_error: error?.message || String(error),
          },
          trace: {},
        };
      }
      prediction.trace = {
        ...(prediction.trace || {}),
        ...retrievalTrace(entry),
        expected_certainty: entry.gold.expected.certainty,
      };
      predictions.push(prediction);
      options.onProgress?.({ index: index + 1, total: suite.prepared.length, caseId: entry.gold.case_id, state: "completed" });
    }
    const completedIds = new Set(predictions.map((item) => item.case_id));
    const evaluatedDataset = {
      ...suite.dataset,
      documents: suite.dataset.documents
        .map((document) => ({ ...document, cases: document.cases.filter((item) => completedIds.has(item.case_id)) }))
        .filter((document) => document.cases.length),
    };
    const report = Scorer.evaluateDataset(evaluatedDataset, predictions, suite.documents);
    return {
      mode: "live-browser",
      dataset_id: suite.dataset.dataset_id,
      generated_at: new Date().toISOString(),
      completed_cases: predictions.length,
      planned_cases: suite.prepared.length,
      cancelled: predictions.length < suite.prepared.length,
      predictions,
      ...report,
    };
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
  }

  return { blocksFromHtml, prepareCase, retrievalTrace, loadSuite, run, wait };
});

#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const Retrieval = require("../document-retrieval.js");
const Grounding = require("../grounding.js");
const Scorer = require("./scorer.js");

const root = path.resolve(__dirname);
const datasetPath = path.join(root, "datasets", "core-context-v1.json");
const API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

function parseArgs(argv) {
  const args = { mode: "retrieval", output: path.join(root, "results", "latest") };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--live") args.mode = "live";
    else if (token === "--retrieval-only") args.mode = "retrieval";
    else if (token === "--predictions") { args.mode = "predictions"; args.predictions = argv[++index]; }
    else if (token === "--output") args.output = path.resolve(argv[++index]);
    else if (token === "--case") args.caseId = argv[++index];
    else if (token === "--limit") args.limit = Math.max(1, Number(argv[++index]) || 1);
    else if (token === "--model") args.model = argv[++index];
  }
  return args;
}

function normalizeHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function blocksFromDocument(document) {
  const html = fs.readFileSync(path.join(root, document.file), "utf8");
  const blocks = [];
  const headings = [];
  const pattern = /<(h[1-6]|p|li|blockquote|pre|td|th|figcaption)\b[^>]*data-block-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
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
  return { html, blocks };
}

function snapshotFor(document, gold, blocks) {
  return {
    snapshot_version: "evaluation-v1",
    selection: {
      raw_text: gold.selection.exact,
      normalized_text: gold.selection.exact,
      anchor_block_id: gold.selection.anchor_block_id,
      occurrence_index: gold.selection.occurrence_index,
    },
    page: { title: document.title, url: `evaluation://${document.document_id}` },
    blocks,
  };
}

function prepareCases(dataset, args) {
  const prepared = [];
  for (const document of dataset.documents) {
    const source = blocksFromDocument(document);
    for (const gold of document.cases) {
      if (args.caseId && gold.case_id !== args.caseId) continue;
      const snapshot = snapshotFor(document, gold, source.blocks);
      const retrieval = Retrieval.retrieve(snapshot);
      snapshot.evidence_candidates = retrieval.candidates;
      snapshot.retrieval = retrieval.summary;
      prepared.push({ document, gold, source, snapshot, retrieval });
      if (args.limit && prepared.length >= args.limit) return prepared;
    }
  }
  return prepared;
}

async function callModel(apiKey, messages, model = "glm-4.7-flash") {
  const body = { model, messages, temperature: 0, max_tokens: 900, stream: false };
  if (model === "glm-4.7-flash") body.thinking = { type: "disabled" };
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status}`);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型没有返回内容");
  return content;
}

async function runLive(prepared, args) {
  const apiKey = process.env.BIGMODEL_API_KEY || "";
  if (!apiKey.trim()) throw new Error("实时评测需要先在环境变量 BIGMODEL_API_KEY 中提供密钥；密钥不会写入报告。");
  const predictions = [];
  for (const entry of prepared) {
    const startedAt = Date.now();
    const request = { selection: entry.gold.selection.exact, documentContext: entry.snapshot };
    let raw = "";
    let validation = null;
    let attempts = 0;
    let error = "";
    try {
      for (attempts = 1; attempts <= 2; attempts += 1) {
        const messages = Grounding.buildMessages(request, attempts === 2 ? { errors: validation.errors, raw } : null);
        raw = await callModel(apiKey, messages, args.model);
        validation = Grounding.validateStructured(raw, request);
        if (validation.ok) break;
      }
    } catch (caught) {
      error = caught?.message || String(caught);
    }
    const salvaged = validation?.ok ? null : Grounding.salvageLowRisk?.(validation, request);
    const result = validation?.ok ? validation.result : salvaged?.result || Grounding.fallbackResult(request);
    predictions.push({
      case_id: entry.gold.case_id,
      result,
      _meta: {
        validation_attempts: Math.min(attempts, 2),
        valid: validation?.ok === true || !!salvaged,
        locally_degraded: !!salvaged,
        removed_claim_ids: salvaged?.removed_claim_ids || [],
        validation_errors: validation?.errors || [],
        elapsed_ms: Date.now() - startedAt,
        error,
      },
      trace: {
        retrieved_block_ids: entry.retrieval.candidates.map((item) => item.block_id),
        expected_certainty: entry.gold.expected.certainty,
      },
    });
    process.stdout.write(`${entry.gold.case_id}: ${validation?.ok ? "已通过结构校验" : "已安全降级"}\n`);
  }
  return predictions;
}

function markdownReport(payload) {
  const s = payload.summary;
  const lines = [
    `# 语流批量评测报告`, "", `- 模式：${payload.mode}`, `- 数据集：${payload.dataset_id}`, `- 生成时间：${payload.generated_at}`, "",
  ];
  if (payload.mode === "retrieval") {
    lines.push("## 检索阶段", "", `- 当前选区召回率：${s.anchor_recall}%`, `- 关键支持证据召回率：${s.support_recall}%`, `- 全部金标准证据召回率：${s.gold_evidence_recall}%`, `- 检索遗漏：${s.retrieval_misses} 条`);
  } else {
    lines.push(
      "## 核心指标", "",
      `- 核心通过率：${s.core_pass_rate}%`,
      `- 有用回答率：${s.useful_answer_rate}%`,
      `- 过度拒答率：${s.over_refusal_rate}%`,
      `- 义项正确率：${s.sense_accuracy}%`,
      `- 证据有效率：${s.evidence_validity}%`,
      `- 主张语义支持率：${s.semantic_support_rate == null ? "未评估" : `${s.semantic_support_rate}%`}`,
      `- 作者意图适配率：${s.author_intent_appropriateness}%`,
      `- 作者意图区分度：${s.author_intent_distinction == null ? "未评估" : `${s.author_intent_distinction}%`}`,
      `- 无依据具体化率：${s.unsupported_specificity_rate}%`,
      `- 提示误报率：${s.notice_false_positive_rate}%`,
      `- 首次成功率：${s.first_pass_success_rate}%`,
      `- 平均响应时间：${s.average_response_time_ms == null ? "未评估" : `${s.average_response_time_ms} ms`}`,
      `- P95 响应时间：${s.p95_response_time_ms == null ? "未评估" : `${s.p95_response_time_ms} ms`}`,
    );
    lines.push("", "## 失败分类", "");
    const failures = Object.entries(s.failure_counts || {}).sort((a, b) => b[1] - a[1]);
    lines.push(...(failures.length ? failures.map(([name, count]) => `- ${name}：${count}`) : ["- 无"]));
  }
  lines.push("", "## 逐案例", "");
  for (const item of payload.cases) lines.push(`- ${item.case_id}：${item.passed === false || item.failures?.length ? `失败（${(item.failures || []).join("、")}）` : "通过"}`);
  return `${lines.join("\n")}\n`;
}

function writeReport(basePath, payload) {
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  fs.writeFileSync(`${basePath}.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.writeFileSync(`${basePath}.md`, markdownReport(payload), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const prepared = prepareCases(dataset, args);
  let payload;
  if (args.mode === "retrieval") {
    const traces = prepared.map((entry) => ({ case_id: entry.gold.case_id, retrieved_block_ids: entry.retrieval.candidates.map((item) => item.block_id) }));
    const filteredDataset = filterDataset(dataset, new Set(prepared.map((item) => item.gold.case_id)));
    const report = Scorer.evaluateRetrieval(filteredDataset, traces);
    payload = { mode: "retrieval", dataset_id: dataset.dataset_id, generated_at: new Date().toISOString(), ...report };
  } else {
    const predictions = args.mode === "live"
      ? await runLive(prepared, args)
      : normalizePredictions(JSON.parse(fs.readFileSync(path.resolve(args.predictions), "utf8")));
    const ids = new Set(predictions.map((item) => item.case_id));
    const filteredDataset = filterDataset(dataset, ids);
    const documents = Object.fromEntries(prepared.filter((item) => ids.has(item.gold.case_id)).map((item) => [item.document.document_id, item.source.html]));
    const report = Scorer.evaluateDataset(filteredDataset, predictions, documents);
    payload = {
      mode: args.mode,
      dataset_id: dataset.dataset_id,
      generated_at: new Date().toISOString(),
      model: args.mode === "live" ? (args.model || "glm-4.7-flash") : null,
      generation_settings: args.mode === "live" ? { temperature: 0, maximum_repairs: 1 } : null,
      predictions,
      ...report,
    };
  }
  writeReport(args.output, payload);
  process.stdout.write(`${markdownReport(payload)}\n报告已保存：${args.output}.json / ${args.output}.md\n`);
}

function normalizePredictions(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.predictions) ? value.predictions : [];
}

function filterDataset(dataset, ids) {
  return {
    ...dataset,
    documents: dataset.documents.map((document) => ({ ...document, cases: document.cases.filter((item) => ids.has(item.case_id)) })).filter((document) => document.cases.length),
  };
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { parseArgs, blocksFromDocument, snapshotFor, prepareCases, markdownReport, filterDataset };

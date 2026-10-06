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

function retrievalTrace(entry) {
  const anchor = entry.source.blocks.find((item) => item.block_id === entry.gold.selection.anchor_block_id);
  return {
    case_id: entry.gold.case_id,
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
        ...retrievalTrace(entry),
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
    lines.push(
      "> **范围说明：这是一份RAG检索报告。它只验证正确原文有没有进入候选证据，不包含模型实际回答，不能据此判断最终释义是否正确。**",
      "",
      "## 检索阶段", "", `- 当前选区召回率：${s.anchor_recall}%`, `- 关键支持证据召回率：${s.support_recall}%`, `- 全部金标准证据召回率：${s.gold_evidence_recall}%`, `- 检索遗漏：${s.retrieval_misses} 条`,
    );
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
  for (const [index, item] of (payload.cases || []).entries()) {
    const review = item.review || {};
    const failed = item.passed === false || item.failures?.length;
    lines.push(
      `### ${index + 1}. ${review.selection?.text || item.case_id} · ${failed ? "失败" : "通过"}`,
      "",
      `- 案例编号：${item.case_id}`,
      `- 文档：${review.document?.title || review.document?.document_id || item.document_id || "—"}`,
      `- 评测范围：${review.evaluation_scope === "retrieval_only" ? "仅RAG检索，不含实际回答" : "端到端生成与评分"}`,
      `- 当前选中位置：${markdownInline(review.selection?.anchor_context || "—")}`,
      `- 人工预期：${markdownInline(review.expected?.meaning || "—")}`,
      `- 实际输出：${review.actual ? markdownInline(review.actual.meaning || "（空）") : "未执行模型生成，不能评价回答质量"}`,
    );
    if (review.actual?.author_intent) lines.push(`- 作者意图：${markdownInline(review.actual.author_intent)}`);
    if (review.actual) {
      lines.push(
        `- 确定性：预期 ${review.expected?.certainty || "—"}；实际 ${review.actual.certainty || "—"}`,
        `- 执行：${executionSummary(review.execution)}`,
      );
    }
    lines.push("", "**人工标注的关键依据**", "");
    lines.push(...evidenceLines(review.expected?.evidence, "未提供人工依据"));
    lines.push("", "**RAG实际召回的依据（按排名）**", "");
    lines.push(...evidenceLines(review.retrieval?.retrieved_evidence, "没有召回依据"));
    if (review.actual) {
      lines.push("", "**最终回答实际采用的依据**", "");
      lines.push(...evidenceLines(review.actual.adopted_evidence, "最终回答没有采用原文依据"));
      lines.push("", "**分项检查**", "");
      lines.push(...checkLines(item.checks));
    }
    lines.push("", `- 失败原因：${item.failures?.length ? item.failures.join("、") : "无"}`, "");
  }
  return `${lines.join("\n")}\n`;
}

function markdownInline(value) {
  return String(value || "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function evidenceLines(items, emptyText) {
  if (!Array.isArray(items) || !items.length) return [`- ${emptyText}`];
  return items.map((item, index) => {
    const rank = item.rank || index + 1;
    const reason = item.reasons?.length ? `；入选原因：${item.reasons.join("、")}` : "";
    return `- ${rank}. [${item.block_id || "未知段落"}] ${markdownInline(item.quote || "（没有可见引文）")}${reason}`;
  });
}

function checkLines(checks) {
  const labels = {
    output_schema: "输出结构", selection_match: "解释对象", required_information: "关键语义",
    forbidden_information: "错误义项排除", referent_type: "对象类型", specificity_safe: "具体程度",
    certainty: "确定性", notice: "提示状态", evidence_valid: "引文真实性",
    evidence_support: "关键依据采用", retrieval_support: "RAG关键依据召回",
    pipeline_completed: "生成链路", author_intent_appropriate: "作者意图适配",
    author_intent_distinct: "作者意图区分", semantic_support: "主张语义支持",
  };
  const entries = Object.entries(checks || {});
  if (!entries.length) return ["- 没有分项评分"];
  return entries.map(([key, value]) => `- ${value === true ? "通过" : value === false ? "失败" : "未评估"}：${labels[key] || key}`);
}

function executionSummary(execution) {
  if (!execution) return "没有执行信息";
  const parts = [];
  if (execution.validation_attempts != null) parts.push(`${execution.validation_attempts} 次校验`);
  if (execution.locally_degraded) parts.push("发生局部降级");
  if (execution.elapsed_ms != null) parts.push(`耗时 ${execution.elapsed_ms} ms`);
  if (execution.validation_errors?.length) parts.push(`校验错误：${execution.validation_errors.join("、")}`);
  if (execution.pipeline_error) parts.push(`管线错误：${execution.pipeline_error}`);
  return parts.join("；") || "没有执行信息";
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
    const traces = prepared.map(retrievalTrace);
    const filteredDataset = filterDataset(dataset, new Set(prepared.map((item) => item.gold.case_id)));
    const documents = Object.fromEntries(prepared.map((item) => [item.document.document_id, item.source.html]));
    const report = Scorer.evaluateRetrieval(filteredDataset, traces, documents);
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

module.exports = { parseArgs, blocksFromDocument, snapshotFor, prepareCases, retrievalTrace, markdownReport, filterDataset };

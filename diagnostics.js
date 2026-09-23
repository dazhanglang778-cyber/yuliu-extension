const STORAGE_KEY = "yuliuDiagnosticsV1";
const ENABLED_KEY = "diagnosticsEnabled";
const EVALUATION_KEY = "yuliuEvaluationLatestV1";
const enabled = document.querySelector("#enabled");
const sessionsElement = document.querySelector("#sessions");
const empty = document.querySelector("#empty");
const search = document.querySelector("#search");
let ledger = { schemaVersion: 1, sessions: [] };
let latestEvaluation = null;
let evaluationRunning = false;
let evaluationCancelled = false;

const eventLabels = {
  session_started: "开始解释",
  request_started: "发起请求",
  search_started: "开始检索资料",
  search_completed: "资料检索完成",
  search_failed: "资料检索失败",
  ambiguity_triage: "判断是否需要辨义",
  sense_resolved: "候选义项已选择",
  evidence_cache_hit: "复用已核验资料",
  evidence_ready: "专业资料准备完成",
  model_attempt_started: "开始调用模型",
  model_attempt_failed: "本次模型调用失败",
  model_completed: "模型原始输出",
  validation_failed: "规则检查未通过",
  module_validated: "模块检查通过",
  answer_displayed: "最终内容已显示",
  request_error: "后台请求失败",
  ui_error: "前端显示错误",
  module_error: "模块生成失败",
  api_key_missing: "缺少 API Key",
  session_closed: "卡片已关闭",
  grounding_validated: "语境证据校验通过",
  grounding_validation_failed: "语境证据校验未通过",
  grounding_safe_fallback: "语境解释安全降级",
  evidence_navigated: "跳转至原文依据",
  candidate_senses_ready: "候选义项已建立",
  candidate_senses_failed: "候选义项规划失败并降级",
  knowledge_route_decided: "已决定是否外部检索",
  term_lookup_failed: "术语资料检索失败",
  term_knowledge_ready: "术语知识准备完成",
  term_knowledge_failed_open: "术语知识异常但继续回答",
};

boot();

async function boot() {
  const saved = await chrome.storage.local.get([STORAGE_KEY, ENABLED_KEY, EVALUATION_KEY]);
  enabled.checked = saved[ENABLED_KEY] === true;
  ledger = saved[STORAGE_KEY] || ledger;
  latestEvaluation = saved[EVALUATION_KEY] || null;
  render();
  renderEvaluation(latestEvaluation);
}

enabled.addEventListener("change", () => chrome.storage.local.set({ [ENABLED_KEY]: enabled.checked }));
search.addEventListener("input", render);
document.querySelector("#export").addEventListener("click", exportDiagnostics);
document.querySelector("#clear").addEventListener("click", clearDiagnostics);
document.querySelector("#runEvaluation").addEventListener("click", runEvaluation);
document.querySelector("#exportEvaluation").addEventListener("click", exportEvaluation);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEY]) {
    ledger = changes[STORAGE_KEY].newValue || { schemaVersion: 1, sessions: [] };
    render();
  }
  if (changes[ENABLED_KEY]) enabled.checked = changes[ENABLED_KEY].newValue === true;
  if (changes[EVALUATION_KEY]) {
    latestEvaluation = changes[EVALUATION_KEY].newValue || null;
    renderEvaluation(latestEvaluation);
  }
});

async function runEvaluation() {
  if (evaluationRunning) {
    evaluationCancelled = true;
    setEvaluationMessage("将在当前案例完成后停止评测……");
    return;
  }
  evaluationRunning = true;
  evaluationCancelled = false;
  const runButton = document.querySelector("#runEvaluation");
  const progress = document.querySelector("#evaluationProgress");
  const progressBar = progress.querySelector("progress");
  const progressText = progress.querySelector("span");
  runButton.textContent = "停止评测";
  progress.hidden = false;
  progressBar.value = 0;
  document.querySelector("#evaluationSummary").hidden = true;
  document.querySelector("#evaluationFailures").hidden = true;
  document.querySelector("#exportEvaluation").disabled = true;
  setEvaluationMessage("正在载入固定测试集……");
  try {
    const report = await YuliuBrowserEvaluation.run({
      runtime: chrome.runtime,
      isCancelled: () => evaluationCancelled,
      onProgress(update) {
        progressBar.max = update.total;
        progressBar.value = update.index;
        progressText.textContent = update.state === "running"
          ? `正在评测 ${update.index + 1}/${update.total}：${update.caseId}`
          : `已完成 ${update.index}/${update.total}：${update.caseId}`;
      },
    });
    latestEvaluation = report;
    await chrome.storage.local.set({ [EVALUATION_KEY]: report });
    renderEvaluation(report);
  } catch (error) {
    setEvaluationMessage(error?.message || "实时评测没有完成。", true);
  } finally {
    evaluationRunning = false;
    runButton.textContent = "重新运行完整评测";
    if (!latestEvaluation) document.querySelector("#exportEvaluation").disabled = true;
  }
}

function renderEvaluation(report) {
  if (!report) return;
  const summary = report.summary || {};
  const summaryElement = document.querySelector("#evaluationSummary");
  const failuresElement = document.querySelector("#evaluationFailures");
  const cards = [
    ["核心通过率", formatRate(summary.core_pass_rate)],
    ["有用回答率", formatRate(summary.useful_answer_rate)],
    ["过度拒答率", formatRate(summary.over_refusal_rate)],
    ["义项正确率", formatRate(summary.sense_accuracy)],
    ["证据有效率", formatRate(summary.evidence_validity)],
    ["语义支持率", formatRate(summary.semantic_support_rate)],
    ["作者意图适配", formatRate(summary.author_intent_appropriateness)],
    ["作者意图区分", formatRate(summary.author_intent_distinction)],
    ["平均响应", formatDuration(summary.average_response_time_ms)],
    ["P95 响应", formatDuration(summary.p95_response_time_ms)],
    ["错误具体化率", formatRate(summary.unsupported_specificity_rate)],
    ["发布门槛", summary.release_gate?.passed ? "通过" : "未通过"],
  ];
  summaryElement.replaceChildren(...cards.map(([label, value], index) => {
    const card = document.createElement("article");
    if (index === cards.length - 1) card.className = summary.release_gate?.passed ? "gate-pass" : "gate-fail";
    const labelElement = document.createElement("span");
    labelElement.textContent = label;
    const valueElement = document.createElement("strong");
    valueElement.textContent = value;
    card.append(labelElement, valueElement);
    return card;
  }));
  summaryElement.hidden = false;
  const failures = Object.entries(summary.failure_counts || {}).sort((left, right) => right[1] - left[1]);
  failuresElement.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = failures.length ? "失败分类" : "失败分类：无";
  failuresElement.append(title);
  if (failures.length) {
    const list = document.createElement("ul");
    for (const [code, count] of failures) {
      const item = document.createElement("li");
      item.textContent = `${failureLabel(code)}：${count} 条`;
      list.append(item);
    }
    failuresElement.append(list);
  }
  failuresElement.hidden = false;
  document.querySelector("#exportEvaluation").disabled = false;
  const completed = Number(report.completed_cases ?? summary.total_cases ?? 0);
  const planned = Number(report.planned_cases ?? summary.total_cases ?? 0);
  setEvaluationMessage(report.cancelled
    ? `评测已停止，已完成 ${completed}/${planned} 个案例；当前结果仅代表已完成部分。`
    : `评测完成：${completed}/${planned} 个案例。${summary.release_gate?.passed ? "已达到当前核心发布门槛。" : "尚未达到发布门槛，请按失败分类修复。"}`);
  const progress = document.querySelector("#evaluationProgress");
  progress.hidden = false;
  progress.querySelector("progress").max = Math.max(1, planned);
  progress.querySelector("progress").value = completed;
  progress.querySelector("span").textContent = report.cancelled ? "评测已停止" : "评测已完成";
}

function setEvaluationMessage(text, error = false) {
  const element = document.querySelector("#evaluationMessage");
  element.textContent = text;
  element.classList.toggle("error", error);
}

function formatRate(value) {
  return value == null ? "—" : `${value}%`;
}

function failureLabel(code) {
  const labels = {
    NO_OUTPUT: "没有生成结果",
    OUTPUT_SCHEMA_FAILURE: "结构化输出不合法",
    SELECTION_MISMATCH: "解释对象错位",
    RETRIEVAL_MISS: "RAG未召回正确证据",
    MISSING_KEY_INFORMATION: "缺少关键语义",
    REFERENT_TYPE_MISMATCH: "对象类型判断错误",
    UNJUSTIFIED_SPECIFICITY: "无依据具体化",
    FORBIDDEN_CONTENT: "混入错误义项",
    EVIDENCE_BLOCK_NOT_FOUND: "证据段落不存在",
    EVIDENCE_QUOTE_MISMATCH: "引文不属于原文",
    EVIDENCE_MISS: "未采用关键证据",
    GENERATION_IGNORED_RETRIEVED_EVIDENCE: "已召回但生成阶段忽略证据",
    CERTAINTY_MISMATCH: "确定性判断错误",
    NOTICE_FALSE_POSITIVE: "提示误报",
    NOTICE_STATE_MISMATCH: "提示状态错误",
    CLAIM_SEMANTIC_SUPPORT_FAILURE: "主张没有得到证据的语义支持",
    AUTHOR_INTENT_MISSING: "应该说明作者意图但缺失",
    AUTHOR_INTENT_UNNECESSARY: "不需要时生成了作者意图",
    AUTHOR_INTENT_DUPLICATES_MEANING: "作者意图重复这里指什么",
    PIPELINE_REQUEST_FAILED: "单个评测请求失败，已隔离并继续",
    MODEL_GENERATION_FAILED: "模型请求失败，已用安全结果继续",
  };
  return `${labels[code] || code}（${code}）`;
}

function exportEvaluation() {
  if (!latestEvaluation) return;
  const blob = new Blob([JSON.stringify(latestEvaluation, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `语流-核心语义评测-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function render() {
  const all = Array.isArray(ledger.sessions) ? ledger.sessions : [];
  const query = search.value.trim().toLocaleLowerCase();
  const visible = query
    ? all.filter((session) => JSON.stringify(session).toLocaleLowerCase().includes(query))
    : all;
  document.querySelector("#total").textContent = String(all.length);
  document.querySelector("#failed").textContent = String(all.filter((item) => item.hasIssue === true).length);
  const durations = all.map(sessionDuration).filter((value) => value > 0);
  document.querySelector("#average").textContent = durations.length ? formatDuration(Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)) : "—";
  document.querySelector("#latest").textContent = all[0] ? formatRelative(all[0].updatedAt) : "—";
  empty.hidden = all.length > 0;
  sessionsElement.replaceChildren(...visible.map(renderSession));
}

function renderSession(session) {
  const details = document.createElement("details");
  details.className = "session";
  const summary = document.createElement("summary");
  const term = span("term", session.selection || "未记录选中词");
  const meta = span("meta", session.pageTitle || "未记录页面标题");
  const badge = span(`badge${session.hasIssue ? " error" : ""}`, session.outcome || "运行中");
  const timing = span("time", formatDuration(sessionDuration(session)));
  summary.append(term, meta, badge, timing);
  const body = document.createElement("div");
  body.className = "details";
  if (session.localContext) body.append(span("context", session.localContext));
  const timeline = document.createElement("div");
  timeline.className = "timeline";
  for (const event of session.events || []) timeline.append(renderEvent(event));
  body.append(timeline);
  details.append(summary, body);
  return details;
}

function renderEvent(event) {
  const row = document.createElement("article");
  row.className = "event";
  row.append(span("event-time", new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })), span("event-name", eventLabels[event.type] || event.type));
  const pre = document.createElement("pre");
  pre.textContent = humanJson(event.data || {});
  row.append(pre);
  return row;
}

function humanJson(data) {
  return JSON.stringify(data, null, 2)
    .replace(/"rawOutput":/g, '"模型原文":')
    .replace(/"finalOutput":/g, '"最终显示":')
    .replace(/"query":/g, '"检索词":')
    .replace(/"elapsedMs":/g, '"耗时毫秒":');
}

function span(className, text) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

function sessionDuration(session) {
  return Math.max(0, Number(session.updatedAt || 0) - Number(session.startedAt || 0));
}

function formatDuration(ms) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;
}

function formatRelative(timestamp) {
  const delta = Date.now() - Number(timestamp || 0);
  if (delta < 60000) return "刚刚";
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function exportDiagnostics() {
  const blob = new Blob([JSON.stringify(ledger, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `语流-诊断记录-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function clearDiagnostics() {
  if (!confirm("确定清空全部本地诊断记录吗？此操作无法撤销。")) return;
  ledger = { schemaVersion: 1, sessions: [], updatedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY]: ledger });
  render();
}

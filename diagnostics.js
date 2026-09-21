const STORAGE_KEY = "yuliuDiagnosticsV1";
const ENABLED_KEY = "diagnosticsEnabled";
const enabled = document.querySelector("#enabled");
const sessionsElement = document.querySelector("#sessions");
const empty = document.querySelector("#empty");
const search = document.querySelector("#search");
let ledger = { schemaVersion: 1, sessions: [] };

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
};

boot();

async function boot() {
  const saved = await chrome.storage.local.get([STORAGE_KEY, ENABLED_KEY]);
  enabled.checked = saved[ENABLED_KEY] === true;
  ledger = saved[STORAGE_KEY] || ledger;
  render();
}

enabled.addEventListener("change", () => chrome.storage.local.set({ [ENABLED_KEY]: enabled.checked }));
search.addEventListener("input", render);
document.querySelector("#export").addEventListener("click", exportDiagnostics);
document.querySelector("#clear").addEventListener("click", clearDiagnostics);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEY]) {
    ledger = changes[STORAGE_KEY].newValue || { schemaVersion: 1, sessions: [] };
    render();
  }
  if (changes[ENABLED_KEY]) enabled.checked = changes[ENABLED_KEY].newValue === true;
});

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

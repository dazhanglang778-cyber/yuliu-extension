const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const state = { diagnosticsEnabled: true };
const storage = {
  async get(keys) {
    if (typeof keys === "string") return { [keys]: state[keys] };
    const result = {};
    for (const key of keys || []) result[key] = state[key];
    return result;
  },
  async set(values) { Object.assign(state, values); },
};
const context = {
  chrome: {
    runtime: {
      onConnect: { addListener() {} },
      onMessage: { addListener() {} },
    },
    storage: { local: storage },
  },
  console,
  URL,
  fetch() { throw new Error("测试不应发起网络请求"); },
  setTimeout,
  clearTimeout,
  TextDecoder,
  AbortController,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve("../background.js"), "utf8"), context);

(async () => {
  const cleaned = context.sanitizeDiagnosticData({
    apiKey: "secret-key",
    Authorization: "Bearer secret",
    safe: "保留",
    nested: { token: "secret-token", answer: "正常回答" },
  });
  assert.equal(cleaned.safe, "保留");
  assert.equal(cleaned.apiKey, undefined);
  assert.equal(cleaned.Authorization, undefined);
  assert.equal(cleaned.nested.token, undefined);
  assert.equal(cleaned.nested.answer, "正常回答");
  assert.equal(context.sanitizeDiagnosticData("Authorization: Bearer abc.def-secret", "response"), "Authorization: Bearer [已隐藏]");

  await context.recordDiagnosticEvent({
    sessionId: "session-1",
    requestId: "request-1",
    eventType: "request_started",
    selection: "Reward Hacking",
    pageTitle: "测试文章",
    localContext: "只保存选词所在局部段落",
    data: { mode: "expand_general", apiKey: "must-not-be-saved" },
  });
  await context.recordDiagnosticEvent({
    sessionId: "session-1",
    requestId: "request-1",
    eventType: "answer_displayed",
    data: { finalOutput: "最终显示内容" },
  });

  const ledger = state.yuliuDiagnosticsV1;
  assert.equal(ledger.sessions.length, 1);
  assert.equal(ledger.sessions[0].selection, "Reward Hacking");
  assert.equal(ledger.sessions[0].outcome, "已完成");
  assert.ok(!JSON.stringify(ledger).includes("must-not-be-saved"));

  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const popup = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "diagnostics.html"), "utf8");
  const dashboardScript = fs.readFileSync(path.join(__dirname, "..", "diagnostics.js"), "utf8");
  assert.ok(content.includes("diagnosticSessionId: activeDiagnosticSessionId"));
  assert.ok(content.includes('sendDiagnosticEvent("validation_failed"'));
  assert.ok(popup.includes("开发诊断模式"));
  assert.ok(dashboard.includes("候选义项"));
  assert.ok(dashboard.includes("不会记录 API Key"));
  assert.ok(dashboard.includes('id="evaluationCases"'));
  assert.ok(dashboard.includes("导出可读报告"));
  assert.ok(dashboardScript.includes("人工预期"));
  assert.ok(dashboardScript.includes("实际输出"));
  assert.ok(dashboardScript.includes("RAG实际召回的依据"));
  assert.ok(dashboardScript.includes("最终回答实际采用的依据"));
  console.log("PASS 诊断记录会话化保存并排除密钥");
  console.log("PASS 前端、后台、设置页和诊断页链路完整");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

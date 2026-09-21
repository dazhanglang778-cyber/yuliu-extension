const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const calls = [];
const messages = [];
const definition = "Reward Hacking（奖励黑客）指优化系统利用奖励规则漏洞取得高分，却没有实现设计者真正目标的现象。\n它常在可测指标与真实目标不一致时出现。";
const context = {
  chrome: {
    runtime: { onConnect: { addListener() {} } },
    storage: { local: { async get() { return { bigmodelApiKey: "test-key" }; } } },
  },
  console, URL, setTimeout, clearTimeout, TextDecoder, AbortController,
  fetch: async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ url, body });
    if (String(url).includes("web_search")) return {
      ok: true,
      async json() { return { search_result: [
        { title: "Reward Hacking 技术笔记", link: "https://blog.csdn.net/example/reward-hacking", content: "Reward Hacking describes agents exploiting a reward rule. This technical note summarizes the phenomenon and its limitations." },
        { title: "Reward Hacking research", link: "https://openai.com/research/reward-hacking", media: "OpenAI", content: "Reward hacking occurs when agents obtain reward while failing to satisfy the designer's intended objective." },
      ] }; },
    };
    if (!body.stream) return {
      ok: true,
      async json() { return { choices: [{ message: { content: JSON.stringify({
        neutralIdentity: "奖励黑客现象", chineseName: "奖励黑客", conceptType: "普通术语",
        needsSearch: true, searchReason: "核对技术定义", definition,
      }) } }] }; },
    };
    const chunk = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: `通用定义：${definition}` } }] })}\n\ndata: [DONE]\n\n`);
    let read = false;
    return { ok: true, body: { getReader() { return {
      async read() { if (read) return { done: true }; read = true; return { done: false, value: chunk }; },
      async cancel() {},
    }; } } };
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve("../background.js"), "utf8"), context);

(async () => {
  await context.runRequest({ postMessage(message) { messages.push(message); } }, {
    requestId: "optional-search", mode: "expand_general", selection: "Reward Hacking",
    senseMeaning: "在RSI中通过利用评分漏洞取得高分", context: "全文绝不能进入通用定义",
  });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes("chat/completions"));
  assert.ok(calls[1].url.includes("web_search"));
  assert.equal(calls[1].body.search_query, "Reward Hacking 奖励黑客");
  assert.ok(!JSON.stringify(calls[2].body.messages).includes("全文绝不能"));
  assert.ok(messages.some((item) => item.type === "SOURCES" && item.sources[0].link.includes("openai.com")));
  assert.ok(messages.some((item) => item.type === "DONE"));
  console.log("PASS 模型要求检索时再搜索；权威资料优先，专业社区保留为参考");
  console.log("PASS 有资料时模型综合生成，文章正文仍不进入通用定义");
})().catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const calls = [];
const messages = [];
const draft = "Reward Hacking（奖励黑客）是优化系统利用奖励规则的漏洞获取高分，却未实现原本目标的现象。\n它反映了可测指标与真实目标之间的偏差。";
const context = {
  chrome: {
    runtime: { onConnect: { addListener() {} } },
    storage: { local: { async get() { return { bigmodelApiKey: "test-key" }; } } },
  },
  console,
  URL,
  setTimeout,
  clearTimeout,
  TextDecoder,
  AbortController,
  fetch: async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body || "{}") });
    if (!String(url).includes("chat/completions")) throw new Error("成熟概念无需强制搜索");
    return {
      ok: true,
      async json() { return { choices: [{ message: { content: JSON.stringify({
        neutralIdentity: "优化中的奖励黑客现象",
        chineseName: "奖励黑客",
        conceptType: "普通术语",
        needsSearch: false,
        definition: draft,
      }) } }] }; },
    };
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve("../background.js"), "utf8"), context);

(async () => {
  await context.runRequest({ postMessage(message) { messages.push(message); } }, {
    requestId: "model-first",
    mode: "expand_general",
    selection: "Reward Hacking",
    senseMeaning: "在RSI文章中利用评价漏洞获得高分",
    context: "这段正文绝不能进入通用定义",
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chat/completions"));
  assert.ok(!calls[0].body.messages.some((item) => item.content.includes("这段正文")));
  assert.ok(messages.some((item) => item.type === "DELTA" && item.delta.includes("奖励黑客")));
  assert.ok(messages.some((item) => item.type === "DONE"));
  console.log("PASS 成熟概念由模型直接生成，不以检索通过作为回答资格");
  console.log("PASS 完整文章正文不进入通用定义请求");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

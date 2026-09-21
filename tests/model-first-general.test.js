const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const calls = [];
const messages = [];
const plan = {
  neutralIdentity: "训练配方",
  chineseName: "训练配方",
  englishFullName: "",
  conceptType: "普通术语",
  needsSearch: true,
  searchReason: "术语用法尚未统一",
  definition: "训练Recipe（训练配方）是训练模型时组合数据、算法设置和步骤的方案。\n它规定各环节如何协同，具体内容因任务而异。",
};
const context = {
  chrome: {
    runtime: { onConnect: { addListener() {} } },
    storage: { local: { async get() { return { bigmodelApiKey: "test-key" }; } } },
  },
  console, URL, setTimeout, clearTimeout, TextDecoder, AbortController,
  fetch: async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body || "{}") });
    if (String(url).includes("web_search")) throw new Error("模拟搜索服务暂时不可用");
    return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(plan) } }] }; } };
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve("../background.js"), "utf8"), context);

(async () => {
  await context.runRequest({ postMessage(message) { messages.push(message); } }, {
    requestId: "mixed-term",
    mode: "expand_general",
    selection: "训练Recipe",
    senseMeaning: "本文提到的数据优化与部署中的训练Recipe",
    context: "全文正文不会发给通用定义",
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.search_query.includes("训练Recipe"));
  assert.ok(!calls[1].body.search_query.includes("本文"));
  assert.ok(messages.some((item) => item.type === "DELTA" && item.delta.includes("训练配方")));
  assert.ok(messages.some((item) => item.type === "DONE"));
  assert.ok(!messages.some((item) => item.type === "ERROR"));
  console.log("PASS 新兴混合术语先给中文译名，搜索失败不抹掉模型已形成的通用定义");

  assert.equal(context.sourceMatchesIdentity({ title: "Human skills", content: "People learn skills in school." }, "Skills", { neutralIdentity: "AI智能体技能模块" }), false);
  assert.equal(context.sourceMatchesIdentity({ title: "Agent Skills", content: "AI agents load modular skills." }, "Skills", { neutralIdentity: "AI智能体技能模块" }), true);
  assert.equal(context.sourceMatchesIdentity({ title: "Survey benchmark", content: "A permanent survey mark." }, "Benchmark", { neutralIdentity: "模型评测基准" }), false);
  console.log("PASS 多义词的检索资料必须与选定义项相关，网页专业不等于义项相关");
})().catch((error) => { console.error(error); process.exitCode = 1; });

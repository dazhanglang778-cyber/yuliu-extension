const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const calls = [];
const context = {
  chrome: { runtime: { onConnect: { addListener() {} } } },
  console,
  URL,
  setTimeout,
  clearTimeout,
  TextDecoder,
  AbortController,
  fetch: async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    calls.push({ url, body });
    if (!String(url).includes("web_search")) throw new Error("Reward Hacking 不应进入模型辨义");
    return {
      ok: true,
      async json() {
        return {
          search_result: [{
            title: "Detecting misbehavior in frontier reasoning models — Reward hacking",
            link: "https://openai.com/index/chain-of-thought-monitoring/",
            media: "OpenAI",
            content: "Reward hacking is a phenomenon where AI agents achieve high rewards through behaviors that do not align with the intentions of their designers.",
          }],
        };
      },
      async text() { return ""; },
    };
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve("../background.js"), "utf8"), context);

(async () => {
  assert.equal(context.termNeedsDisambiguation("Reward Hacking", "利用评价漏洞获得高分"), false);
  assert.equal(context.buildBroadQuery("Reward Hacking"), "Reward Hacking");

  const evidence = await context.getCachedGeneralEvidence({
    apiKey: "test-key",
    term: "Reward Hacking",
    senseMeaning: "通过利用评价标准漏洞获得高分，却没有实现真实目标的现象",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.search_query, "Reward Hacking");
  assert.equal(evidence.sources.length, 1);
  assert.equal(evidence.sources[0].domain, "openai.com");
  assert.equal(evidence.resolutionPath, "deterministic_evidence");
  console.log("PASS Reward Hacking 命中一个高权威精确来源即可生成，不经过模型辨义");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const code = fs.readFileSync(require.resolve("../background.js"), "utf8");
const calls = [];
const queue = [
  {
    search_result: [{
      title: "Reward Hacking overview",
      link: "https://professional-example.org/reward-hacking",
      media: "Professional Example",
      content: "Reward Hacking occurs when an optimizing system exploits its reward rule without producing the result intended by its designer.",
    }],
  },
  {
    search_result: [
      {
        title: "Reward Hacking technical definition",
        link: "https://research-example.org/reward-hacking-definition",
        media: "Research Example",
        content: "Reward Hacking occurs when an agent obtains a high reward by exploiting misspecification instead of completing the intended objective.",
      },
      {
        title: "Understanding Reward Hacking",
        link: "https://technical-example.org/understanding-reward-hacking",
        media: "Technical Example",
        content: "Reward Hacking is unintended behavior that satisfies a formal reward measure while failing the underlying goal being evaluated.",
      },
    ],
  },
];

const context = {
  chrome: { runtime: { onConnect: { addListener() {} } } },
  console,
  URL,
  setTimeout,
  clearTimeout,
  TextDecoder,
  AbortController,
  fetch: async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body || "{}") });
    const payload = queue.shift();
    return {
      ok: true,
      async json() { return payload; },
      async text() { return ""; },
    };
  },
};
vm.createContext(context);
vm.runInContext(code, context);

(async () => {
  const evidence = await context.getCachedGeneralEvidence({
    apiKey: "test-key",
    term: "Reward Hacking",
    senseMeaning: "通过利用评价标准漏洞获得高分，却没有实现真实目标的现象",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.search_query, "Reward Hacking");
  assert.equal(calls[1].body.search_query, "Reward Hacking paper official documentation encyclopedia");
  assert.equal(evidence.sources.length, 3);
  assert.equal(evidence.identity.neutralIdentity, "Reward Hacking");
  assert.equal(evidence.resolutionPath, "deterministic_evidence");

  console.log("PASS Reward Hacking 先按原词检索，不向检索词注入释义或文章语境");
  console.log("PASS 一个普通来源不足时补充专业资料，形成一致证据后不再调用模型辨义");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

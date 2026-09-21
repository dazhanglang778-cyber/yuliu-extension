const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const code = fs.readFileSync(require.resolve("../background.js"), "utf8");
const context = {
  chrome: { runtime: { onConnect: { addListener() {} } } },
  console,
  URL,
  setTimeout,
  clearTimeout,
  TextDecoder,
  AbortController,
  fetch: async () => { throw new Error("本测试不调用网络"); },
};
vm.createContext(context);
vm.runInContext(code, context);

const scholarly = [
  "arxiv.org",
  "openreview.net",
  "proceedings.mlr.press",
  "ieee.org",
  "acm.org",
  "huggingface.co",
  "iclr.cc",
];
for (const domain of scholarly) {
  assert.ok(context.sourceScore(domain, "Rejection Sampling research", "Research", "x".repeat(120), "https:") >= 1, `${domain} 被错误过滤`);
}

const unknownProfessional = context.normalizeSource({
  title: "A professional explanation of rejection sampling",
  link: "https://example-research-lab.org/rejection-sampling",
  media: "Example Research Lab",
  content: "This technical reference explains the definition, assumptions, mechanism, and limitations of rejection sampling in statistical computation.",
});
assert.ok(unknownProfessional && unknownProfessional.score >= 1);

const communitySource = context.normalizeSource({
  title: "网友回答",
  link: "https://www.zhihu.com/question/1",
  content: "个人观点".repeat(50),
});
assert.ok(communitySource);
assert.ok(communitySource.score < unknownProfessional.score);

console.log("PASS 论文与专业技术网站不会因未在旧白名单中被过滤");
console.log("PASS 未收录但有实质专业内容的网站可进入后续义项核验");
console.log("PASS UGC 可作为低优先级线索，但不会被当作权威来源");

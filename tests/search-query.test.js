const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const code = fs.readFileSync(require.resolve("../background.js"), "utf8");
const context = {
  chrome: { runtime: { onConnect: { addListener() {} } } },
  console,
  URL,
  fetch() { throw new Error("测试不应发起网络请求"); },
  setTimeout,
  clearTimeout,
  TextDecoder,
  AbortController,
};
vm.createContext(context);
vm.runInContext(code, context);

const blackwell = context.buildSenseAwareQuery(
  "Blackwell",
  "“Blackwell”在这里指NVIDIA英伟达设计的AI芯片架构，是数据飞轮机制的重要硬件支持。"
);
assert.ok(blackwell.includes("Blackwell"));
assert.ok(/NVIDIA|英伟达/.test(blackwell));
assert.ok(/芯片|架构/.test(blackwell));
assert.ok(!blackwell.includes("作者想表达"));
assert.ok(blackwell.length <= 70);

const apple = context.buildSenseAwareQuery(
  "Apple",
  "“Apple”在这里指苹果公司，而不是水果。作者想表达的是其产品生态优势。"
);
assert.ok(apple.includes("苹果公司"));
assert.ok(!apple.includes("水果"));
assert.ok(!apple.includes("作者想表达"));

console.log("PASS Blackwell 搜索被限定为 NVIDIA 芯片义项");
console.log("PASS Apple 搜索能携带公司义项并移除作者意图");
console.log("\n2/2 sense-aware search query tests passed.");

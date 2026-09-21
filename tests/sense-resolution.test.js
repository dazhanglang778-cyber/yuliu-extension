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

const resolved = context.parseResolution(JSON.stringify({
  candidateSenses: [{
    label: "用于间接衡量真实目标的替代性指标",
    referentType: "评估指标",
    sourceIndexes: [1, 2, 99],
  }],
  chosenSenseIndex: 1,
  match: true,
  neutralIdentity: "在本文RSI语境中用于间接衡量真实目标的替代性指标。作者借此强调风险。",
  chineseName: "代理指标",
  englishFullName: "",
  conceptType: "普通术语",
  sourceIndexes: [1, 2, 2, 99],
  searchTerms: ["proxy metric", "代理指标"],
}), "Proxy Metric");

assert.equal(resolved.match, true);
assert.ok(!resolved.neutralIdentity.includes("本文"));
assert.ok(!resolved.neutralIdentity.includes("作者"));
assert.equal(resolved.chineseName, "代理指标");
assert.deepEqual(Array.from(resolved.sourceIndexes), [1, 2, 99]);
assert.equal(resolved.candidateSenses.length, 1);
assert.equal(resolved.chosenSenseIndex, 1);

const sources = [{ title: "一" }, { title: "二" }];
const selected = context.selectMatchedSources(sources, resolved.sourceIndexes);
assert.deepEqual(JSON.parse(JSON.stringify(selected)), sources);

const bypassedPool = context.parseResolution(JSON.stringify({
  match: true,
  neutralIdentity: "模型声称这是正确义项",
  sourceIndexes: [1],
  searchTerms: ["neutral retry term"],
}), "Benchmark");
assert.equal(bypassedPool.match, false);
assert.deepEqual(Array.from(bypassedPool.sourceIndexes), []);

console.log("PASS 义项比对结果会去除本文与作者表达");
console.log("PASS 只保留义项匹配且真实存在的来源编号");
console.log("PASS 只有候选义项池中被选义项的资料才能进入通用定义");
console.log("PASS 模型不能绕过候选义项池直接宣称资料匹配");

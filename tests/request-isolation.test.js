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

const canary = "紫色河马编号7429负责月球咖啡机";
const sources = [{
  title: "ICLR RSI Workshop",
  media: "ICLR",
  domain: "iclr.cc",
  link: "https://iclr.cc/example",
  content: "Speculative vision is used here as a forward-looking framing for research directions.",
}];
const base = {
  selection: "speculative vision",
  senseMeaning: `在RSI文章中是一种对未来技术方向的推测性设想 ${canary}`,
  senseIdentity: {
    neutralIdentity: "对未来可能状态或发展方向作出的推测性设想",
    chineseName: "推测性愿景",
    englishFullName: "",
    conceptType: "普通术语",
  },
  context: canary,
  title: `页面标题 ${canary}`,
  localContext: `局部段落 ${canary}`,
};

const general = context.buildMessages({ ...base, mode: "expand_general" }, sources);
const generalText = JSON.stringify(general);
assert.ok(generalText.includes("外部专业资料"));
assert.ok(generalText.includes("speculative vision（通常译为“推测性愿景”）"));
assert.ok(generalText.includes("三至四个短段"));
assert.ok(generalText.includes("不得超过300"));
assert.ok(generalText.includes("禁止举例"));
assert.ok(!generalText.includes(canary));
assert.ok(!generalText.includes("RSI文章"));
assert.ok(!generalText.includes(`页面标题 ${canary}`));

const example = context.buildMessages({
  ...base,
  mode: "expand_example",
  generalDefinition: "speculative vision（可译为“推测性愿景”）是一种面向未来的设想。",
}, []);
const exampleText = JSON.stringify(example);
assert.ok(!exampleText.includes(canary));
assert.ok(exampleText.includes("已核验通用定义"));

const simplify = context.buildMessages({
  ...base,
  mode: "simplify",
  existing: "Rejection Sampling是一种根据指标调整训练数据分布的方法。",
  selection: "Rejection Sampling",
  strictSimple: true,
}, []);
const simplifyText = JSON.stringify(simplify);
assert.ok(simplifyText.includes("一听就懂的大白话"));
assert.ok(simplifyText.includes("说白了就是"));
assert.ok(simplifyText.includes("上一次回答仍然偏专业"));
assert.ok(!simplifyText.includes(canary));

console.log("PASS 通用定义请求物理隔离正文、标题和局部语境");
console.log("PASS 举例模块不接收当前文章语境");
console.log("PASS 英文中文释义规则进入保留的拓展模块");
console.log("PASS 简明版使用独立的大白话规则而非专业词条句式");

assert.equal(context.buildBroadQuery("Proxy Metric"), "Proxy Metric");
assert.equal(context.buildBroadQuery("代理指标"), "代理指标");
assert.equal(context.termNeedsDisambiguation("Reward Hacking", "利用奖励漏洞获得高分"), false);
assert.equal(context.termNeedsDisambiguation("Apple", "这里指苹果公司"), true);
assert.equal(context.termNeedsDisambiguation("RSI", "递归式自我改进"), true);
assert.equal(context.termNeedsDisambiguation("经验回流", "把经验反馈给系统"), false);
assert.equal(context.buildBroadRecoveryQuery("Proxy Metric"), "Proxy Metric paper official documentation encyclopedia");
assert.ok(context.englishOpeningRule("Proxy Metric").includes("原词后给中文翻译"));
assert.ok(context.englishOpeningRule("RSI").includes("英文全称"));
assert.ok(context.englishOpeningRule("Blackwell").includes("专有名称"));
assert.ok(context.englishOpeningRule("Skills").includes("中文双引号"));
assert.ok(context.englishOpeningRule("RAG", "缩写", "检索增强生成", "Retrieval-Augmented Generation")
  .includes("RAG（英文全称 Retrieval-Augmented Generation，中文通常译为“检索增强生成”）"));
assert.ok(context.englishOpeningRule("Reward Hacking", "普通术语", "奖励劫持", "")
  .includes("Reward Hacking（通常译为“奖励劫持”）"));
const cleanedEvidence = context.sanitizeEvidenceText("本文提出一种方法。例如，自动驾驶系统会回收数据。Reward hacking occurs when a system exploits its reward specification.");
assert.ok(!cleanedEvidence.includes("本文"));
assert.ok(!cleanedEvidence.includes("例如"));
assert.ok(cleanedEvidence.includes("Reward hacking"));
const dirtySourceMessages = context.buildMessages({ ...base, mode: "expand_general" }, [{
  title: "本文介绍：speculative vision",
  cleanTitle: context.sanitizeEvidenceTitle("本文介绍：speculative vision"),
  media: "ICLR",
  domain: "iclr.cc",
  link: "https://iclr.cc/example",
  content: "在本文中，作者介绍该表达。例如，它被用于一个项目。Speculative vision describes a forward-looking framing.",
  cleanContent: context.sanitizeEvidenceText("在本文中，作者介绍该表达。例如，它被用于一个项目。Speculative vision describes a forward-looking framing."),
}]);
const dirtySourcePayload = dirtySourceMessages[1].content;
assert.ok(!dirtySourcePayload.includes("本文"));
assert.ok(!dirtySourcePayload.includes("例如"));
assert.ok(dirtySourcePayload.includes("speculative vision"));
const fastSources = [
  { title: "Reward hacking in reinforcement learning", content: "Reward Hacking occurs when an agent exploits its reward specification.", score: 8 },
  { title: "Understanding Reward Hacking", content: "Reward Hacking describes behavior that scores well without satisfying the intended objective.", score: 8 },
];
assert.deepEqual(Array.from(context.fastPathSourceIndexes("Reward Hacking", fastSources, "在RSI框架中讨论该风险")), [1, 2]);
assert.deepEqual(Array.from(context.fastPathSourceIndexes("speculative vision", [{
  title: "From speculative vision to concrete systems problems",
  content: "Speculative vision describes a forward-looking framing used to identify possible research directions.",
  score: 8,
}], "面向未来的推测性愿景")), [1]);
assert.deepEqual(Array.from(context.fastPathSourceIndexes("Reward Hacking", [
  { title: "Reward Hacking definition", content: "Reward Hacking occurs when an agent exploits a reward rule without achieving the intended objective.", score: 1 },
  { title: "Understanding Reward Hacking", content: "Reward Hacking describes high reward obtained through unintended behavior rather than the desired capability.", score: 1 },
], "一种利用评价漏洞获得高分的现象")), [1, 2]);
assert.equal(context.fastPathSourceIndexes("Apple", fastSources, "这里指苹果公司而不是水果").length, 0);
assert.equal(context.buildStructuredFallbackQuery("Reward Hacking"), "Reward Hacking technical glossary academic definition");
const humanSkillSources = [{
  title: "What are skills?",
  content: "Skills are abilities people gain through education, training and workplace practice.",
  score: 8,
}];
const protectedSkills = context.applyReferentSafeguard(
  "Skills",
  "这里指AI Agent可以调用或装载的技能模块",
  humanSkillSources,
  { match: true, neutralIdentity: "human abilities", sourceIndexes: [1], searchTerms: [] },
);
assert.equal(protectedSkills.match, false);
assert.equal(protectedSkills.sourceIndexes.length, 0);
assert.ok(protectedSkills.searchTerms.includes("AI agent skills"));
const ordinaryHumanSkills = context.applyReferentSafeguard(
  "Skills",
  "这里指个人通过训练掌握的技能",
  humanSkillSources,
  { match: true, neutralIdentity: "human abilities", sourceIndexes: [1], searchTerms: [] },
);
assert.equal(ordinaryHumanSkills.match, true);
const surveyBenchmarkSources = [{
  title: "Benchmark survey marker",
  content: "A benchmark is a permanent survey mark of precisely known elevation and position used as a reference point.",
  score: 8,
}];
const protectedBenchmark = context.applyReferentSafeguard(
  "Benchmark",
  "用于评估模型性能和比较算法结果的基准测试",
  surveyBenchmarkSources,
  { match: true, neutralIdentity: "survey marker", sourceIndexes: [1], searchTerms: [] },
);
assert.equal(protectedBenchmark.match, false);
assert.equal(protectedBenchmark.sourceIndexes.length, 0);
assert.ok(protectedBenchmark.searchTerms.includes("benchmark evaluation"));
assert.equal(context.buildCanonicalIdentity("Reward Hacking", { chineseName: "奖励黑客", englishFullName: "" }), "Reward Hacking（奖励黑客）");
console.log("PASS 第一轮检索只使用原词，不携带语境锚点");
console.log("PASS 英文词组、缩写和专有名称使用不同开头规则");
console.log("PASS 明确技术词走快速通道，多义词才进入辨义");
console.log("PASS 通用定义只接收原词与规范名称，不接收比对器解释句");
console.log("PASS 搜索摘要进入通用定义前会去除文章口吻和案例句");
console.log("PASS Skills 的人类能力义项不会冒充 AI/Agent 技能模块义项");
console.log("PASS Benchmark 的测量地标义项不会冒充评测基准义项");

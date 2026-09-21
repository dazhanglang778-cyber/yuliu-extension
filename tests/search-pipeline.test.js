const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const code = fs.readFileSync(require.resolve("../background.js"), "utf8");
const calls = [];
const queue = [
  // 第一轮：只按原词搜索。
  {
    search_result: [{
      title: "Proxy metric definition",
      link: "https://www.nist.gov/proxy-metric",
      media: "NIST",
      content: "A proxy metric is an observable measure used as an indirect stand-in for a target that is difficult to measure directly.",
    }],
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
  const sense = "在RSI系统中用来判断自我改进是否有效的指标";
  const evidence = await context.getCachedGeneralEvidence({
    apiKey: "test-key",
    term: "Proxy Metric",
    senseMeaning: sense,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.search_query, "Proxy Metric");
  assert.ok(!calls[0].body.search_query.includes("RSI"));
  assert.equal(evidence.identity.neutralIdentity, "Proxy Metric");
  assert.ok(!evidence.identity.neutralIdentity.includes("RSI"));
  assert.equal(evidence.sources.length, 1);

  console.log("PASS 第一轮外部搜索只使用原词");
  console.log("PASS 高权威精确命中的明确术语跳过多余义项模型");
  console.log("PASS 快速通道不把语境写进中性身份");

  queue.push(
    {
      search_result: [{
        title: "Apple fruit definition",
        link: "https://www.nist.gov/apple-fruit",
        media: "NIST",
        content: "An apple is an edible fruit produced by an apple tree and cultivated in many varieties around the world.",
      }],
    },
    {
      choices: [{ message: { content: JSON.stringify({
        candidateSenses: [{ label: "苹果树结出的可食用果实", referentType: "水果", sourceIndexes: [1] }],
        chosenSenseIndex: 0,
        match: false,
        neutralIdentity: "以Apple为品牌名称的科技公司",
        chineseName: "苹果公司",
        englishFullName: "Apple Inc.",
        conceptType: "公司",
        sourceIndexes: [],
        searchTerms: ["Apple Inc.", "苹果公司"],
      }) } }],
    },
    {
      search_result: [{
        title: "Apple Developer platform",
        link: "https://developer.apple.com/company",
        media: "Apple Developer",
        content: "Apple Inc. designs, manufactures and markets smartphones, personal computers, tablets, wearables and related services.",
      }],
    },
    {
      choices: [{ message: { content: JSON.stringify({
        candidateSenses: [{ label: "设计消费电子产品、软件与数字服务的科技公司", referentType: "公司", sourceIndexes: [2] }],
        chosenSenseIndex: 1,
        match: true,
        neutralIdentity: "设计消费电子产品、软件与数字服务的科技公司",
        chineseName: "苹果公司",
        englishFullName: "Apple Inc.",
        conceptType: "公司",
        sourceIndexes: [2],
        searchTerms: ["Apple Inc."],
      }) } }],
    },
  );

  const secondEvidence = await context.getCachedGeneralEvidence({
    apiKey: "test-key",
    term: "Apple",
    senseMeaning: "这里指苹果公司而不是水果",
  });
  assert.equal(calls.length, 5);
  assert.equal(calls[1].body.search_query, "Apple");
  assert.ok(!calls[1].body.search_query.includes("苹果公司"));
  assert.ok(JSON.stringify(calls[2].body.messages).includes("candidateSenses"));
  assert.ok(calls[3].body.search_query.includes("苹果公司"));
  assert.equal(secondEvidence.identity.chineseName, "苹果公司");
  assert.equal(secondEvidence.sources[0].domain, "developer.apple.com");

  console.log("PASS 直接搜索义项不匹配时才启动第二轮限定搜索");
  console.log("PASS 第二轮只使用中性名称和检索词，不携带文章正文");

  queue.push(
    {
      search_result: [{
        title: "What are skills?",
        link: "https://www.careers.gov.example/skills",
        media: "Careers Institute",
        content: "Skills are abilities people gain through education, training and workplace practice in a chosen occupation.",
      }],
    },
    {
      // 模拟免费模型的错误宽松判断；确定性闸门必须覆盖它。
      choices: [{ message: { content: JSON.stringify({
        candidateSenses: [{ label: "个人通过学习和培训获得的能力", referentType: "人的能力", sourceIndexes: [1] }],
        chosenSenseIndex: 1,
        match: true,
        neutralIdentity: "个人通过学习和培训获得的能力",
        chineseName: "技能",
        englishFullName: "",
        conceptType: "普通术语",
        sourceIndexes: [1],
        searchTerms: [],
      }) } }],
    },
    {
      search_result: [{
        title: "Agent Skills documentation",
        link: "https://docs.anthropic.com/agents/skills",
        media: "Anthropic Docs",
        content: "Agent skills are modular packages of instructions and resources that an AI agent can load to perform specialized tasks.",
      }],
    },
    {
      choices: [{ message: { content: JSON.stringify({
        candidateSenses: [{ label: "AI智能体可装载和调用的模块化能力包", referentType: "AI系统功能模块", sourceIndexes: [2] }],
        chosenSenseIndex: 1,
        match: true,
        neutralIdentity: "AI智能体可装载和调用的模块化能力包",
        chineseName: "智能体技能",
        englishFullName: "",
        conceptType: "AI系统功能模块",
        sourceIndexes: [2],
        searchTerms: ["AI agent skills"],
      }) } }],
    },
  );

  const skillsEvidence = await context.getCachedGeneralEvidence({
    apiKey: "test-key",
    term: "Skills",
    senseMeaning: "这里指AI Agent可以调用或装载的技能模块",
  });
  assert.equal(calls.length, 9);
  assert.equal(calls[5].body.search_query, "Skills");
  assert.ok(calls[7].body.search_query.includes("AI agent skills"));
  assert.ok(!calls[7].body.search_query.includes("这里指"));
  assert.equal(skillsEvidence.identity.chineseName, "智能体技能");
  assert.equal(skillsEvidence.sources[0].domain, "docs.anthropic.com");

  console.log("PASS Skills 的人类技能资料会被拒绝并改查 AI/Agent 技能模块");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

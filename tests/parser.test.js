const assert = require("node:assert/strict");
const parser = require("../parser.js");

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test("标准四字段能正确拆分", () => {
  const result = parser.parseInitial("这里指什么：“轻量”在这里指操作负担小。\n作者想表达什么：作者提醒设计要克制。\n判断：clear\n提示：");
  assert.equal(result.meaning, "“轻量”在这里指操作负担小。");
  assert.equal(result.intent, "作者提醒设计要克制。");
  assert.equal(result.certainty, "clear");
});

test("合并输出时作者意图不会泄漏进第一栏", () => {
  const result = parser.parseInitial("这里指什么：“Hopper”在这里指NVIDIA芯片。作者想表达的是通过芯片与数据飞轮的关系强调产品迭代。判断： clear。");
  assert.equal(result.meaning, "“Hopper”在这里指NVIDIA芯片。");
  assert.equal(result.intent, "通过芯片与数据飞轮的关系强调产品迭代。");
  assert.equal(result.certainty, "clear");
  assert.ok(!result.meaning.includes("判断"));
});

test("真实 Hopper 失败样本能被彻底分栏", () => {
  const raw = "这里指什么：“Hopper”在这里指NVIDIA英伟达提出的概念，是数据飞轮循环中用于改进模型的关键技术芯片，是AI产品迭代的重要支撑。作者想表达的是通过强调Hopper芯片的设计与数据飞轮机制的关系，突出数据飞轮对于AI产品发展的重要性。判断：clear\n作者想表达什么：通过强调Hopper芯片与数据飞轮的关系，突出数据飞轮的重要性。";
  const result = parser.parseInitial(raw);
  assert.ok(result.meaning.startsWith("“Hopper”在这里指"));
  assert.ok(!result.meaning.includes("作者想表达"));
  assert.ok(!result.meaning.includes("判断"));
  assert.ok(result.intent.includes("通过强调Hopper芯片"));
  assert.equal(result.certainty, "clear");
});

test("内部判断字段永远不进入可见正文", () => {
  const result = parser.parseInitial("这里指什么：“看板”指集中展示数据的页面。判断：clear。\n作者想表达什么：作者建议团队关注关键结果。");
  assert.ok(!result.meaning.includes("判断"));
  assert.ok(!result.intent.includes("判断"));
  assert.equal(result.certainty, "clear");
});

test("clear 后带中文标点仍能识别", () => {
  assert.equal(parser.normalizeCertainty(" clear。"), "clear");
});

test("展开讲讲两个模块能正确拆分", () => {
  const result = parser.parseExpanded("通用定义：种子用户是产品早期的首批深度使用者。\n举个例子：邀请十名目标用户试用。 ");
  assert.equal(result.general, "种子用户是产品早期的首批深度使用者。");
  assert.equal(result.example, "邀请十名目标用户试用。");
});

test("通用定义混入作者或本文语境时会被拦截", () => {
  assert.equal(parser.generalHasContextLeak("作者在本文中强调种子用户很重要。", "种子用户"), true);
  assert.equal(parser.generalHasContextLeak("种子用户是产品早期主动试用并反馈的人群。", "种子用户"), false);
});

test("通用定义必须从用户原词开始并拦截中译中", () => {
  assert.equal(parser.generalStartsWithSelection("Reward Hacking（通常译为“奖励黑客”）是指利用奖励漏洞。", "Reward Hacking"), true);
  assert.equal(parser.generalStartsWithSelection("奖励黑客通常译为“奖励黑客”，是指利用奖励漏洞。", "Reward Hacking"), false);
  assert.equal(parser.hasCircularTranslation("奖励黑客通常译为“奖励黑客”，是指利用奖励漏洞。"), true);
});

test("密集通用定义会被整理为逐点换行", () => {
  const formatted = parser.formatGeneralParagraphs("Reward Hacking（奖励黑客）是系统钻奖励规则空子的现象。它常见于强化学习。防范方法包括改进评价标准。");
  assert.equal(formatted.split("\n").length, 3);
  const existing = parser.formatGeneralParagraphs("第一点有核心定义。这里补充一句边界。\n\n第二点说明工作机制。这里也有一句补充。");
  assert.equal(existing.includes("\n\n"), false);
  assert.equal(existing.split("\n").length, 2);
});

test("通用定义禁止案例并限制为微型词条", () => {
  assert.equal(parser.generalHasExample("经验回流是把经验重新用于后续改进。例如，自动驾驶系统会回收路测数据。"), true);
  assert.equal(parser.generalHasExample("经验回流是把实践中获得的信息重新用于后续调整。它强调反馈能够继续参与改进。"), false);
  assert.equal(parser.generalWithinLimit("经验回流是把实践中获得的信息重新用于后续调整。"), false);
  assert.equal(parser.generalWithinLimit("经验回流".repeat(15)), true);
  assert.equal(parser.generalWithinLimit("经验回流".repeat(70)), true);
  assert.equal(parser.generalWithinLimit("经验回流".repeat(80)), false);
  assert.equal(parser.generalHasValidPointCount("第一点。\n\n第二点。"), true);
  assert.equal(parser.generalHasValidPointCount("只有一点。"), false);
  assert.equal(parser.generalHasValidPointCount("一。\n\n二。\n\n三。\n\n四。\n\n五。\n\n六。"), false);
  assert.equal(parser.generalHasRepeatedPoints("经验回流会把反馈重新送入系统。\n\n经验回流会把反馈重新送入系统，用于后续改进。"), true);
  assert.equal(parser.generalHasRepeatedPoints("经验回流会把反馈重新送入系统。\n\n它的价值是让后续决策利用已经发生的结果。"), false);
  assert.equal(parser.generalHasCaseLeak("经验回流是把经验重新用于改进。\n\nOak框架作为一个持续学习项目被采用。", "经验回流"), true);
  assert.equal(parser.generalHasCaseLeak("经验回流是把经验重新用于改进。\n\n此外，TTRL提供了测试阶段持续学习的方法。", "经验回流"), true);
  assert.equal(parser.generalHasCaseLeak("Reward Hacking是偏离真实目标追逐分数的现象。\n\n它常见于强化学习和自动化评估系统。", "Reward Hacking"), false);
  assert.equal(parser.generalHasCaseLeak("RAG是把外部资料补充给生成模型的技术。\n\nLLM使用检索到的信息生成更有依据的回答。", "RAG"), false);
  assert.equal(parser.generalHasCaseLeak("Blackwell是NVIDIA推出的AI计算平台。\n\n它面向训练和推理等高性能计算任务。", "Blackwell", { conceptType: "产品" }), false);
});

test("英文中文释义使用固定双引号格式", () => {
  assert.equal(parser.hasInvalidEnglishGloss("Skills，中文叫‘技能’，就是系统学习的方法。"), true);
  assert.equal(parser.hasInvalidEnglishGloss("Skills（中文意为“技能”）是通过学习形成的能力。"), false);
  assert.equal(parser.hasInvalidEnglishGloss("Skills（中文意为技能）是通过学习形成的能力。"), true);
  assert.equal(parser.hasInvalidEnglishGloss('Skills（中文意为"技能"）是通过学习形成的能力。'), true);
  assert.equal(parser.englishIdentityMatches("RAG（英文全称 Retrieval-Augmented Generation，中文通常译为“检索增强生成”）是一种技术。", "RAG", {
    englishFullName: "Retrieval-Augmented Generation",
    chineseName: "检索增强生成",
    conceptType: "缩写",
  }), true);
  assert.equal(parser.englishIdentityMatches("RAG（中文通常译为“检索增强生成”）是一种技术。", "RAG", {
    englishFullName: "Retrieval-Augmented Generation",
    chineseName: "检索增强生成",
    conceptType: "缩写",
  }), false);
});

test("一句话简明版能去掉字段名", () => {
  assert.equal(parser.parseSimple("一句话解释：看板就是把最值得盯的数字集中放在一起。"), "看板就是把最值得盯的数字集中放在一起。");
});

test("字段边缘的正反书名括号不会显示", () => {
  const result = parser.parseInitial("这里指什么：】Rejection Sampling在这里指一种筛选数据的方法。【\n作者想表达什么：】作者强调要根据结果调整数据。【\n判断：clear");
  assert.equal(result.meaning, "Rejection Sampling在这里指一种筛选数据的方法。");
  assert.equal(result.intent, "作者强调要根据结果调整数据。");
});

test("一句话解释必须是真正的大白话", () => {
  assert.equal(parser.isPlainSimple("拒绝采样就是先剔掉不合要求的数据，只留下适合训练模型的那批。"), true);
  assert.equal(parser.isPlainSimple("Rejection Sampling通常译为拒绝采样，指模型根据预设指标主动调整数据类型，以优化学习效果。"), false);
});

test("提示字段中的无和内部空值不会显示", () => {
  for (const value of ["无", "暂无", "none", "null", "N/A", "clear"]) {
    const result = parser.parseInitial(`这里指什么：测试词在这里指一个概念。\n作者想表达什么：作者在说明它。\n判断：clear\n提示：${value}`);
    assert.equal(result.note, "", `未过滤内部空值：${value}`);
  }
});

test("第二版结构能分别读取这里指什么、作者意图和页面依据", () => {
  const result = parser.parseInitial(JSON.stringify({
    schema_version: "2.0",
    selected_text: "Harness",
    candidate_senses: [{ sense_id: "s1", label: "Agent运行框架", referent_type: "generic_concept" }],
    resolution: { status: "inferred", selected_sense_id: "s1", specificity: "category" },
    meaning_here: { text: "Harness 在这里指支撑Agent运行的外围工程系统。" },
    author_intent: { text: "作者强调外围系统也会限制Agent能力。", claim_ids: ["c2"] },
    claims: [],
    page_evidence: [{ evidence_id: "e1", block_id: "p1", quote: "Harness设计", role: "sense_disambiguation" }],
    external_sources: [],
    notice_code: "none",
  }));
  assert.equal(result.structured, true);
  assert.equal(result.schemaVersion, "2.0");
  assert.equal(result.meaning, "Harness 在这里指支撑Agent运行的外围工程系统。");
  assert.equal(result.intent, "作者强调外围系统也会限制Agent能力。");
  assert.equal(result.certainty, "inferred");
  assert.equal(result.evidence[0].block_id, "p1");
});

let passed = 0;
for (const item of cases) {
  try {
    item.fn();
    passed += 1;
    console.log(`PASS ${item.name}`);
  } catch (error) {
    console.error(`FAIL ${item.name}`);
    throw error;
  }
}
console.log(`\n${passed}/${cases.length} parser regression tests passed.`);

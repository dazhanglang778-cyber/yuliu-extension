const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const TermKnowledge = require("../term-knowledge.js");
const Grounding = require("../grounding.js");

function request(selection = "Harness", role = "sense_disambiguation") {
  return {
    selection,
    title: "AI Agent 工程",
    documentContext: {
      page: { title: "AI Agent 工程" },
      selection: { raw_text: selection, anchor_block_id: "p2" },
      evidence_candidates: [{
        evidence_id: "e1",
        block_id: "p2",
        role,
        heading_path: ["基础设施"],
        text: `模型能力与 ${selection} 设计共同影响 Agent 完成任务的效果。`,
      }],
    },
  };
}

function plan(overrides = {}) {
  return {
    normalized_term: "Reward Hacking",
    term_type: "common_term",
    knowledge_confidence: "high",
    ambiguity: "low",
    fact_risk: "ordinary",
    candidate_senses: [{
      sense_id: "s1",
      label: "奖励黑客现象",
      gloss: "优化系统钻奖励规则空子获得高分，却没有实现设计者真正目标的现象。",
      referent_type: "generic_concept",
      chinese_name: "奖励黑客",
      english_full_name: "",
      aliases: [],
    }],
    retrieval_recommended: false,
    retrieval_reason: "",
    search_terms: [],
    ...overrides,
  };
}

test("页面已有直接定义时进入零额外检索的快速通道", () => {
  const current = request("Harness", "direct_support");
  assert.equal(TermKnowledge.pageHasDirectDefinition(current), true);
  const route = TermKnowledge.decideRetrieval(plan({ fact_risk: "ordinary" }), current);
  assert.equal(route.required, false);
  assert.equal(route.path, "page_definition_fast_path");
});

test("模型知识足够稳定的普通概念不强制搜索", () => {
  const normalized = TermKnowledge.normalizePlan(plan(), request("Reward Hacking"));
  const route = TermKnowledge.decideRetrieval(normalized, request("Reward Hacking"));
  assert.equal(route.required, false);
  assert.equal(route.path, "parametric_fast_path");
  assert.equal(normalized.candidate_senses[0].supports[0].source_kind, "model_knowledge");
});

test("多个熟悉义项不等于必须搜索，交给页面语境做WSD", () => {
  const harness = TermKnowledge.normalizePlan(plan({
    normalized_term: "Harness",
    ambiguity: "high",
    candidate_senses: [
      { sense_id: "s1", label: "安全带或挽具", gloss: "固定或保护人和物体的带具。", referent_type: "generic_concept" },
      { sense_id: "s2", label: "软件测试或运行框架", gloss: "组织被测系统、工具和环境交互的框架。", referent_type: "generic_concept" },
    ],
  }), request("Harness"));
  const route = TermKnowledge.decideRetrieval(harness, request("Harness"));
  assert.equal(route.required, false);
  assert.equal(route.path, "parametric_fast_path");
});

test("FDE这类低把握缩写触发选择性检索", () => {
  const fde = TermKnowledge.normalizePlan(plan({
    normalized_term: "FDE",
    term_type: "acronym",
    knowledge_confidence: "low",
    ambiguity: "high",
    fact_risk: "high",
    candidate_senses: [],
    retrieval_recommended: true,
    retrieval_reason: "缩写可能有多个展开",
    search_terms: ["AI engineering role"],
  }), request("FDE"));
  const route = TermKnowledge.decideRetrieval(fde, request("FDE"));
  assert.equal(route.required, true);
  assert.equal(route.path, "selective_retrieval");
  assert.ok(route.reasons.some((item) => item.includes("缩写")));
});

test("检索词只包含原词和中性术语，不复制文章语句", () => {
  const query = TermKnowledge.buildSearchQuery("FDE", {
    term_type: "acronym",
    search_terms: ["AI engineering role", "field deployment engineer"],
  });
  assert.equal(query, "FDE AI engineering role field deployment engineer");
  assert.ok(!query.includes("模型能力"));
  assert.ok(!query.includes("作者"));
});

test("外部搜索结果进入候选资料池而不会自动成为已核验证据", () => {
  const normalized = TermKnowledge.normalizePlan(plan(), request("Reward Hacking"));
  const route = TermKnowledge.decideRetrieval(normalized, request("Reward Hacking"));
  const bundle = TermKnowledge.knowledgeBundle(normalized, route, [{
    title: "Reward Hacking",
    link: "https://example.org/reward-hacking",
    media: "Research Lab",
    cleanContent: "A technical definition.",
    score: 8,
  }]);
  assert.equal(bundle.external_sources[0].status, "candidate_unverified");
  assert.equal(bundle.external_sources[0].quality_score, 8);
});

test("WSD提示明确区分术语候选知识与页面证据", () => {
  const current = request("Harness");
  current.termKnowledge = TermKnowledge.knowledgeBundle(
    TermKnowledge.normalizePlan(plan({ normalized_term: "Harness" }), current),
    { required: false, path: "parametric_fast_path", reasons: [] },
  );
  const prompt = JSON.stringify(Grounding.buildMessages(current));
  assert.ok(prompt.includes("术语候选知识"));
  assert.ok(prompt.includes("不得冒充当前页面证据"));
  assert.ok(prompt.includes("candidate_unverified"));
  assert.ok(prompt.includes("必须先判断其与候选义项语义一致"));
});

test("后台真实链路已加载候选义项路由器并保留失败开放降级", () => {
  const background = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");
  assert.ok(background.includes('importScripts("grounding-contract-v2.js", "claim-verification.js", "grounding.js", "term-knowledge.js")'));
  assert.ok(background.includes("prepareTermKnowledge"));
  assert.ok(background.includes("term_knowledge_failed_open"));
});

function backgroundContext(responsePlan, searchResults = []) {
  const calls = [];
  const context = {
    YuliuTermKnowledge: TermKnowledge,
    chrome: {
      runtime: { onConnect: { addListener() {} } },
      storage: { local: { async get() { return {}; }, async set() {} } },
    },
    console,
    URL,
    setTimeout,
    clearTimeout,
    AbortController,
    TextDecoder,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      if (String(url).includes("web_search")) {
        return { ok: true, async json() { return { search_result: searchResults }; } };
      }
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(responsePlan) } }] }; } };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8"), context);
  return { context, calls };
}

test("真实后台中普通概念只规划候选义项而不调用搜索", async () => {
  const { context, calls } = backgroundContext(plan());
  const bundle = await context.prepareTermKnowledge({ apiKey: "test", request: request("Reward Hacking") });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("chat/completions"));
  assert.equal(bundle.strategy, "parametric_fast_path");
  assert.equal(bundle.external_sources.length, 0);
});

test("真实后台中低把握缩写才会追加一次外部搜索", async () => {
  const fdePlan = plan({
    normalized_term: "FDE",
    term_type: "acronym",
    knowledge_confidence: "low",
    ambiguity: "high",
    fact_risk: "high",
    candidate_senses: [],
    retrieval_recommended: true,
    retrieval_reason: "缩写展开不确定",
    search_terms: ["AI engineering role"],
  });
  const { context, calls } = backgroundContext(fdePlan, [{
    title: "FDE engineering role",
    link: "https://example.org/fde-role",
    media: "Engineering Institute",
    content: "FDE is used for several engineering roles and must be resolved by domain context.",
  }]);
  const bundle = await context.prepareTermKnowledge({ apiKey: "test", request: request("FDE") });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("web_search"));
  assert.equal(calls[1].body.search_query, "FDE AI engineering role");
  assert.equal(bundle.strategy, "selective_retrieval");
  assert.equal(bundle.external_sources[0].status, "candidate_unverified");
});

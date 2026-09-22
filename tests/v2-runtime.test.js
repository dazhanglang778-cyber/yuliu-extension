const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Grounding = require("../grounding.js");
const TermKnowledge = require("../term-knowledge.js");

test("真实后台把第二版WSD结果校验后交给现有卡片", async () => {
  const rawResult = {
    schema_version: "2.0",
    selected_text: "Harness",
    candidate_senses: [{
      sense_id: "s1",
      label: "Agent运行框架",
      gloss: "组织Agent、工具和环境交互的外围工程系统",
      referent_type: "generic_concept",
      chinese_name: "Agent运行框架",
      english_full_name: null,
      supports: [{ source_kind: "model_knowledge" }, { source_kind: "page_evidence", source_id: "e1" }],
    }],
    resolution: { status: "clear", selected_sense_id: "s1", alternative_sense_ids: [], confidence: "high", specificity: "category" },
    meaning_here: { text: "Harness 在这里指组织Agent、工具和环境交互的一套运行框架。", chinese_name: "Agent运行框架", english_full_name: null, contextual_role: null },
    author_intent: null,
    claims: [
      { claim_id: "c1", claim_type: "lexical_knowledge", text: "Harness可以指Agent运行框架", supports: [{ source_kind: "model_knowledge" }] },
      { claim_id: "c2", claim_type: "contextual_mapping", text: "本文使用Agent运行框架义项", supports: [{ source_kind: "page_evidence", source_id: "e1" }] },
    ],
    page_evidence: [{ evidence_id: "e1", block_id: "p1", quote: "Harness 是组织 Agent 与环境交互的一套运行框架。", role: "direct_support" }],
    external_sources: [],
    notice_code: "none",
  };
  const calls = [];
  const context = {
    YuliuGrounding: Grounding,
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
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(rawResult) } }] }; } };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8"), context);
  const request = {
    requestId: "v2-runtime",
    selection: "Harness",
    mode: "initial",
    documentContext: {
      selection: { raw_text: "Harness", anchor_block_id: "p1" },
      blocks: [{ block_id: "p1", text: "Harness 是组织 Agent 与环境交互的一套运行框架。" }],
      evidence_candidates: [{ evidence_id: "e1", block_id: "p1", role: "direct_support", text: "Harness 是组织 Agent 与环境交互的一套运行框架。" }],
    },
  };
  const messages = [];
  await context.runGroundedInitial({ postMessage(message) { messages.push(message); } }, request, "test-key");
  assert.equal(calls.length, 1, "页面已有直接定义时不应增加候选规划或搜索调用");
  const delivered = messages.find((item) => item.type === "GROUNDED_RESULT");
  assert.equal(delivered.result.schema_version, "2.0");
  assert.equal(delivered.result.meaning_here.text, rawResult.meaning_here.text);
  assert.ok(messages.some((item) => item.type === "DONE"));
});

test("后台校验和安全降级使用已经补充术语知识的请求", () => {
  const background = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");
  assert.ok(background.includes("Grounding.validateStructured(raw, preparedRequest)"));
  assert.ok(background.includes("Grounding.fallbackResult(preparedRequest)"));
});

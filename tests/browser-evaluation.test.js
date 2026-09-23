const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

globalThis.YuliuDocumentRetrieval = require("../document-retrieval.js");
globalThis.YuliuEvaluation = require("../evaluation/scorer.js");
const BrowserRunner = require("../evaluation/browser-runner.js");

const evaluationRoot = path.resolve(__dirname, "..", "evaluation");
const fullDataset = JSON.parse(fs.readFileSync(path.join(evaluationRoot, "datasets", "core-context-v1.json"), "utf8"));
const sourceDocument = fullDataset.documents.find((item) => item.document_id === "agent-harness");
const sourceCase = sourceDocument.cases.find((item) => item.case_id === "harness-definition");
const dataset = { ...fullDataset, documents: [{ ...sourceDocument, cases: [sourceCase] }] };
const html = fs.readFileSync(path.join(evaluationRoot, sourceDocument.file), "utf8");

test("浏览器评测器使用与正式产品相同的本地RAG召回", () => {
  const prepared = BrowserRunner.prepareCase(sourceDocument, sourceCase, html);
  assert.equal(prepared.retrieval.candidates[0].block_id, "p-4");
  assert.ok(prepared.retrieval.candidates.some((item) => item.role === "direct_support"));
});

test("开发后台能完成一条端到端语义评测且不读取API Key", async () => {
  const seenMessages = [];
  const runtime = {
    getURL(resource) { return `mock://${resource}`; },
    async sendMessage(message) {
      seenMessages.push(message);
      return {
        ok: true,
        prediction: {
          case_id: message.caseId,
          result: {
            selected_text: "Harness",
            resolved_sense: { label: "组织模型、工具与环境交互的运行框架", referent_type: "generic_concept", specificity: "category" },
            meaning_here: "在这里指组织模型、工具与环境交互的一套运行框架。",
            author_intent: null,
            certainty: "clear",
            claims: [{ claim_id: "c1", text: "Harness 是运行框架", risk: "ordinary", evidence_ids: ["e1"] }],
            evidence: [{ evidence_id: "e1", block_id: "p-4", quote: "组织这些交互环节的运行框架统称为 Harness", role: "direct_support" }],
            notice_code: "none",
          },
          _meta: { validation_attempts: 1, valid: true },
          trace: {},
        },
      };
    },
  };
  const loadText = async (url) => url.endsWith("core-context-v1.json") ? JSON.stringify(dataset) : html;
  const report = await BrowserRunner.run({ runtime, loadText });
  assert.equal(report.summary.core_pass_rate, 100);
  assert.equal(report.summary.release_gate.passed, true);
  assert.equal(seenMessages.length, 1);
  assert.equal(seenMessages[0].type, "EVALUATION_CASE");
  assert.equal("apiKey" in seenMessages[0], false);
  assert.ok(seenMessages[0].documentContext.blocks.length <= seenMessages[0].documentContext.evidence_candidates.length);
});

test("单个案例请求失败不会中止后续整批评测", async () => {
  const twoCaseDataset = { ...fullDataset, documents: [{ ...sourceDocument, cases: sourceDocument.cases }] };
  let calls = 0;
  const runtime = {
    getURL(resource) { return `mock://${resource}`; },
    async sendMessage() {
      calls += 1;
      return { ok: false, error: `模拟第${calls}例失败` };
    },
  };
  const loadText = async (url) => url.endsWith("core-context-v1.json") ? JSON.stringify(twoCaseDataset) : html;
  const report = await BrowserRunner.run({ runtime, loadText, caseDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(report.completed_cases, 2);
  assert.equal(report.cancelled, false);
  assert.ok(report.cases.every((item) => item.failures.includes("PIPELINE_REQUEST_FAILED")));
});

test("诊断后台包含实时评测入口和所需本地脚本", () => {
  const htmlCode = fs.readFileSync(path.resolve(__dirname, "..", "diagnostics.html"), "utf8");
  const background = fs.readFileSync(path.resolve(__dirname, "..", "background.js"), "utf8");
  assert.ok(htmlCode.includes('id="runEvaluation"'));
  assert.ok(htmlCode.includes('claim-verification.js'));
  assert.ok(htmlCode.includes('evaluation/browser-runner.js'));
  assert.ok(background.includes('message?.type === "EVALUATION_CASE"'));
  assert.ok(background.includes('chrome.storage.local.get("bigmodelApiKey")'));
});

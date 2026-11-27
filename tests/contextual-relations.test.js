// Direct LegacyReview assertions reproduce V7 only; R/Reasoning.run exercises current production.
const LegacyReview = require('../evaluation/legacy-review-v7.js');
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../contextual-reasoning.js");
const Suite = require("../evaluation/contextual-suite.js");
const Audit = require("../contextual-audit.js");
const clone = (v) => JSON.parse(JSON.stringify(v));

test("十二例迁移材料只发送原文和中性标题，不把人工期望或对照分类提示给模型", () => {
  const dataset = require("../evaluation/fixtures/contextual-relations-v1.json");
  assert.equal(dataset.cases.length, 12);
  assert.equal(new Set(dataset.cases.map((c) => c.pair_id)).size, 6);
  for (const item of dataset.cases) {
    const sentinel = "DO_NOT_SEND_RELATION_EXPECTATION";
    const req = Suite.prepare({ ...item, expected: sentinel, kind: sentinel, pair_id: sentinel, reference: sentinel });
    const evidence = R.evidenceFor(req);
    assert.ok(evidence.some((e) => e.relation_to_selection === "anchor"), item.id);
    assert.ok(!JSON.stringify(R.buildMessages(req, evidence)).includes(sentinel));
    assert.equal(item.split, "development");
  }
});

test("新专项页面资源完整，实际结果展示规则版本和模型，导出按数据集区分", () => {
  const fs = require("node:fs"), path = require("node:path");
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "contextual-relation-evaluation.html"), "utf8");
  for (const m of html.matchAll(/(?:src|href|data-dataset)="([^"]+\.(?:js|css|json))"/g)) assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
  const ui = fs.readFileSync(path.join(root, "contextual-evaluation.js"), "utf8");
  assert.match(ui, /ruleset_version/);
  assert.match(ui, /dataset.dataset_id \+ '-实测.json'/);
});

test("实际评测后台传回提供方模型名和白名单请求参数，报告不含密钥", async () => {
  const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
  const item = { id: "metadata", title: "服务说明", selection: "服务", anchor: 0, blocks: ["服务负责生成摘要。"] };
  const req = Suite.prepare(item), calls = [];
  const context = { YuliuContextualReasoning: R, YuliuGrounding: {}, console, URL, setTimeout, clearTimeout, AbortController, TextDecoder,
    chrome: { runtime: { onConnect: { addListener() {} } }, storage: { local: {
      async get() { return { bigmodelApiKey: "LOCAL_TEST_KEY_SENTINEL", diagnosticsEnabled: false }; }, async set() {},
    } } },
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      const data = JSON.parse(body.messages[1].content), e = data.evidence[0];
      const s = { id: "c1", part: "meaning", basis: "document", text: "服务负责生成摘要。", evidence_ids: [e.evidence_id] };
      const content = body.messages[0].content.includes("独立的语境主张核验器")
        ? { review_version: R.REVIEW_VERSION, checks: [{ ...s, selection_fit: "current", supported: true, usefulness: "useful", citations: [{ evidence_id: e.evidence_id, quote: e.quote }],
            relation_audit: audit(frame("服务"), frame("服务"), { source: { ...frame("服务"), subject_evidence_ids: [e.evidence_id] } }) }],
            coverage: { status: "adequate", missing: [] } }
        : { target_type: "term", statements: [s] };
      return { ok: true, json: async () => ({ model: "synthetic-provider-v1", choices: [{ message: { content: JSON.stringify(content) } }] }) };
    } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const report = await context.runEvaluationCase({ ...req, caseId: item.id });
  assert.equal(report.ok, true); assert.equal(calls.length, 2);
  assert.equal(report.prediction.result.meaning_here.text, "服务负责生成摘要。");
  for (const h of report.prediction.trace.history) {
    assert.equal(h.model, "synthetic-provider-v1");
    assert.equal(h.parameters.temperature, 0);
    assert.equal(h.parameters.stream, false);
    assert.equal(h.parameters.requested_model, calls[0].model);
  }
  assert.equal(report.prediction.trace.ruleset_version, R.RULESET);
  assert.ok(!JSON.stringify(report).includes("LOCAL_TEST_KEY_SENTINEL"));
});

// These are authored source/claim parses, not a model acting as its own oracle.
function frame(subject, scope = "non_person", qualifiers = []) { return { subject, scope, qualifiers }; }
function audit(source, claim = clone(source), overrides = {}) {
  return { source: { ...source, subject_evidence_ids: ["e1"] }, claim,
    subject_link: "explicit", preserves: { conditions: true, time: true, attribution: true }, ...overrides };
}
function setup(quote = "离线模式计划在下个版本上线。") {
  const evidence = [{ evidence_id: "e1", block_id: "p0", quote, source_start: 0, source_end: quote.length }];
  const draft = { target_type: "term", errors: [], statements: [{ id: "c1", part: "meaning", basis: "document",
    text: "离线模式已经上线。", evidence_ids: ["e1"] }] };
  const check = { id: "c1", supported: true, basis: "document", usefulness: "useful", evidence_ids: ["e1"],
    citations: [{ evidence_id: "e1", quote }], reason: "测试刻意让supported=true与关系字段冲突",
    relation_audit: audit(frame("离线模式", "non_person", ["planned"]), frame("离线模式")) };
  const verdict = { checks: [check], coverage: { status: "adequate", missing: [] } };
  return { evidence, draft, check, verdict, accept: () => LegacyReview.accept(draft, verdict, evidence) };
}

test("发言者不等于需求主体：supported=true也不能覆盖unsupported主体关系", () => {
  const c = setup("发言者 1：交付团队需要整理合同。");
  c.draft.target_type = "person"; c.draft.statements[0].text = "发言者 1 负责整理合同。";
  c.check.relation_audit = audit(frame("交付团队", "collective", ["required"]), frame("发言者 1", "individual"),
    { subject_link: "unsupported" });
  assert.equal(c.accept().rejected[0].code, "RELATION_SUBJECT_UNSUPPORTED");
  assert.equal(c.accept().accepted.length, 0);
});

test("群体工作不能直接缩成个人职责；保留团队范围的解释仍可用", () => {
  const c = setup("发言者 1：我们团队整理合同。");
  c.check.relation_audit = audit(frame("我们团队", "collective"), frame("发言者 1", "individual"));
  assert.equal(c.accept().rejected[0].code, "RELATION_SCOPE_NARROWED");
  c.draft.statements[0].text = "其所在团队整理合同。";
  c.check.relation_audit.claim = frame("其所在团队", "collective");
  c.check.relation_audit.subject_link = "resolved";
  assert.equal(c.accept().accepted.length, 1);
});

test("有依据的有限代表推断允许保留，但不能伪装成原文明示", () => {
  const c = setup("发言者 1：我们团队为社区提供课程支持。");
  c.check.relation_audit = audit(frame("我们团队", "collective"), frame("发言者 1", "individual", ["possible"]),
    { subject_link: "inferred" });
  c.draft.statements[0].text = "该发言者可能代表提供课程支持的团队。";
  assert.equal(c.accept().rejected[0].code, "RELATION_INFERENCE_AS_FACT");
  c.draft.statements[0].basis = c.check.basis = "inference";
  assert.equal(c.accept().accepted.length, 1);
});

for (const [qualifier, quote, label] of [
  ["planned", "离线模式计划在下个版本上线。", "计划不能变成已实现"],
  ["required", "迁移流程需要得到审批。", "需求不能变成已执行"],
  ["possible", "缓存变化可能增加延迟。", "可能不能变成必然"],
  ["conditional", "若关闭缓存，系统会重新请求数据。", "有条件不能变成无条件"],
  ["negated", "当前账户不允许导出数据。", "否定不能消失"],
  ["reported", "甲转述乙认为旧方案不合适。", "转述不能变成已证实判断"],
]) test(label + "，状态保留时可通过", () => {
  const c = setup(quote), subject = quote.includes("离线") ? "离线模式"
    : quote.includes("迁移") ? "迁移流程" : quote.includes("缓存变化") ? "缓存变化"
      : quote.includes("系统") ? "系统" : quote.includes("账户") ? "当前账户" : "乙";
  c.check.relation_audit = audit(frame(subject, "non_person", [qualifier]), frame(subject));
  assert.equal(c.accept().rejected[0].code, "RELATION_QUALIFIER_CHANGED");
  c.check.relation_audit.claim.qualifiers = [qualifier];
  assert.equal(c.accept().accepted.length, 1);
});

test("也不能给明确事实凭空添加否定或计划", () => {
  const c = setup("离线模式已上线。");
  for (const q of ["negated", "planned", "conditional"]) {
    c.check.relation_audit = audit(frame("离线模式"), frame("离线模式", "non_person", [q]));
    assert.equal(c.accept().rejected[0].code, "RELATION_QUALIFIER_CHANGED");
  }
});

for (const key of ["conditions", "time", "attribution"]) test("不能只保留词面限定，却改变 " + key + " 的适用对象", () => {
  const c = setup("更换采集服务需要转换格式。");
  c.check.relation_audit = audit(frame("采集服务"));
  c.check.relation_audit.preserves[key] = false;
  assert.equal(c.accept().rejected[0].code, "RELATION_" + key.toUpperCase() + "_CHANGED");
});

test("短答主体来自提问：候选中有提问但最终没引用仍会被发现", () => {
  const c = setup("乙：可以分开。");
  c.evidence.push({ evidence_id: "e2", block_id: "p1", quote: "甲：采集服务和展示服务必须一起部署吗？" });
  c.draft.statements[0].text = "采集服务和展示服务可分别部署。";
  c.draft.statements[0].evidence_ids.push("e2");
  c.check.relation_audit = audit(frame("采集服务和展示服务"));
  assert.equal(c.accept().rejected[0].code, "RELATION_SUBJECT_CITATION");
  c.check.evidence_ids.push("e2"); c.check.citations.push({ evidence_id: "e2", quote: c.evidence[1].quote });
  c.check.relation_audit.source.subject_evidence_ids = ["e2"];
  c.check.relation_audit.subject_link = "resolved";
  assert.equal(c.accept().accepted.length, 1);
});

test("主体证据必须在实际引用里，不能借未引用的候选或未知编号", () => {
  const c = setup();
  c.check.relation_audit = audit(frame("离线模式"));
  c.check.relation_audit.source.subject_evidence_ids = ["missing"];
  assert.equal(c.accept().rejected[0].code, "RELATION_SUBJECT_CITATION");
});

test("缺失或损坏关系审计不得当作已核验；普通常识与真正未知无需凑关系表", () => {
  const c = setup();
  for (const relation of [null, {}, { source: frame("离线模式") }]) {
    c.check.relation_audit = relation;
    assert.equal(c.accept().rejected[0].code, "RELATION_AUDIT_MISSING");
  }
  for (const basis of ["general", "unknown"]) {
    c.draft.statements[0].basis = c.check.basis = basis;
    c.check.usefulness = basis === "unknown" ? "unknown" : "useful";
    c.draft.statements[0].evidence_ids = []; c.check.evidence_ids = []; c.check.citations = [];
    assert.equal(c.accept().accepted.length, 1);
  }
});

function mixedDraftRun({ repairFailure = false } = {}) {
  const item = { id: "mixed", title: "产品记录", selection: "离线模式", anchor: 0,
    blocks: ["离线模式用于无网络阅读，计划下一版上线。"] };
  const request = Suite.prepare(item);
  let reviews = 0;
  const complete = async ({ messages }) => {
    const data = JSON.parse(messages[1].content), e = data.evidence[0];
    if (!messages[0].content.includes("独立的语境主张核验器")) {
      return { model: "scripted-relation-model", content: JSON.stringify({ target_type: "term", statements: [
        { id: "c1", part: "meaning", basis: "document", text: "离线模式用于无网络阅读。", evidence_ids: [e.evidence_id] },
        { id: "c2", part: "meaning", basis: "document", text: "离线模式已上线。", evidence_ids: [e.evidence_id] },
      ] }) };
    }
    if (++reviews > 1 && repairFailure) throw new Error("SYNTHETIC_SERVICE_FAILURE");
    return { model: "scripted-relation-model", content: JSON.stringify({ review_version: R.REVIEW_VERSION,
      checks: data.draft.statements.filter((s) => !repairFailure || s.id !== "c2").map((s) => ({
        id: s.id, supported: true, selection_fit: "current", basis: "document",
        replacement: s.id === "c2" ? "离线模式计划下一版上线。" : null,
        citations: [{ evidence_id: e.evidence_id, quote: e.quote }],
        reason: s.id === "c2" ? "原文是计划，不能写成已经上线。" : "保留用途说明。"
      })) }) };
  };
  return R.run(request, complete);
}

test("核验直接修正计划与事实，保留真实初稿和修正记录", async () => {
  const outcome = await mixedDraftRun();
  assert.equal(outcome.trace.model_calls, 2);
  assert.equal(outcome.trace.ruleset_version, R.RULESET);
  assert.equal(outcome.trace.selected_attempt, 1);
  assert.match(outcome.result.meaning_here.text, /计划下一版/);
  assert.doesNotMatch(outcome.result.meaning_here.text, /已上线/);
  assert.ok(outcome.trace.history.every((h) => h.model === "scripted-relation-model"));
  assert.match(outcome.trace.generation.statements[1].text, /已上线/);
  const reviewed = Audit.review(outcome.trace, outcome.result);
  assert.match(reviewed.claims[1].final_text, /计划下一版/);
  assert.ok(reviewed.claims[1].revised);
});

test("部分核验缺项后服务失败，已审阅用途保留但未核验上线断言不放行", async () => {
  const outcome = await mixedDraftRun({ repairFailure: true });
  assert.equal(outcome.trace.model_calls, 3);
  assert.equal(outcome.trace.selected_attempt, 1);
  assert.match(outcome.result.meaning_here.text, /用于无网络阅读/);
  assert.doesNotMatch(outcome.result.meaning_here.text, /已上线/);
  assert.equal(outcome.trace.repair_error, "SYNTHETIC_SERVICE_FAILURE");
});

test("真实核验器连续返回过时协议时有界停止，不伪称当前用法已核对", async () => {
  const item = { id: "old-format", title: "服务说明", selection: "服务", anchor: 0, blocks: ["服务负责生成摘要。"] };
  const request = Suite.prepare(item);
  const outcome = await R.run(request, async ({ messages }) => {
    const e = JSON.parse(messages[1].content).evidence[0];
    const statement = { id: "c1", part: "meaning", basis: "document", text: "服务负责生成摘要。", evidence_ids: [e.evidence_id] };
    return JSON.stringify(messages[0].content.includes("独立的语境主张核验器")
      ? { checks: [{ ...statement, supported: true, usefulness: "useful", citations: [{ evidence_id: e.evidence_id, quote: e.quote }] }],
          coverage: { status: "adequate", missing: [] } }
      : { target_type: "term", statements: [statement] });
  });
  assert.equal(outcome.trace.model_calls, 3);
  assert.equal(outcome.trace.error, "VERIFICATION_FORMAT_ERROR");
  assert.equal(outcome.trace.failure_category, "protocol");
  assert.equal(outcome.result.claims.length, 0);
  assert.match(outcome.result.meaning_here.text, /不代表原文没有足够信息/);
});

test("关系字段限制格式、枚举和长度，不能用任意字符串绕过检查", () => {
  for (const alter of [
    (a) => a.source.qualifiers = ["completed"],
    (a) => a.source.scope = "anything",
    (a) => a.source.subject = "x".repeat(161),
    (a) => a.preserves.time = "true",
    (a) => a.source.qualifiers = ["planned", "planned"],
  ]) { const c = setup(); alter(c.check.relation_audit); assert.equal(c.accept().rejected[0].code, "RELATION_AUDIT_MISSING"); }
});

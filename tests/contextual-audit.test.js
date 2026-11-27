const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Audit = require("../contextual-audit.js");
const Reasoning = require("../contextual-reasoning.js");
const Reproductions = require("../evaluation/audit-reproductions.js");

test("离线回归覆盖实际选区，明确不是实模评测", async () => {
  const r = await Reproductions.run();
  assert.equal(r.model_requests_sent, 0);
  assert.equal(r.checks.selected_occurrence_reached_model, true);
  assert.ok(!r.review.warnings.some((w) => w.code === "ANCHOR_NOT_COVERED"));
  assert.ok(r.review.input.anchor.excerpt.includes("07:20"));
  assert.ok(r.review.input.evidence[0].quote.includes("07:20"));
  assert.ok(!r.review.input.evidence[0].quote.includes("00:02"));
});
test("历史错位输入仍能被诊断识别，不能因修好当前截取而失去报警", async () => {
  const { outcome } = await Reproductions.run();
  const trace = JSON.parse(JSON.stringify(outcome.trace));
  trace.input.evidence = [{ evidence_id: "e1", block_id: "b1", source_start: 0,
    quote: Reproductions.request().documentContext.blocks[0].text.slice(0, 1500) }];
  const review = Audit.review(trace, outcome.result);
  assert.ok(review.warnings.some((w) => w.code === "ANCHOR_NOT_COVERED"));
});
test("空泛答案被拒绝后，报告仍展示原始草稿和信息量不足的原因", async () => {
  const r = await Reproductions.run();
  assert.equal(r.checks.generic_answer_was_accepted, false);
  assert.doesNotMatch(r.review.actual, /参与者之一/);
  assert.match(r.review.generation.statements[0].text, /参与者之一/);
  assert.ok(r.review.warnings.some((w) => w.code === "LOW_INFORMATION_REVIEW"));
  assert.equal(r.review.human_review_required, true);
});
test("每次模型调用的输入为独立快照，核验修正不抹掉首稿", async () => {
  const req = Reproductions.request(); let n = 0;
  const outcome = await Reasoning.run(req, async () => {
    n++;
    if (n === 1) return JSON.stringify({ target_type: "person", statements: [
      { id: "c1", part: "meaning", basis: "document", text: "第一稿", evidence_ids: ["e1"] }
    ] });
    return JSON.stringify({ review_version: Reasoning.REVIEW_VERSION, checks: [{
      id: "c1", supported: true, selection_fit: "current", basis: "document", replacement: "修正稿",
      citations: [{ evidence_id: "e1", quote: "我们研究中心负责协调课程资源。" }]
    }] });
  });
  assert.equal(outcome.trace.history.length, 2);
  assert.match(outcome.trace.history[0].raw_output, /第一稿/);
  assert.match(outcome.trace.history[1].raw_output, /修正稿/);
  assert.equal(outcome.result.meaning_here.text, "修正稿");
  assert.equal(outcome.trace.history[0].messages.length, 2);
  assert.ok(outcome.trace.history.every((c) => c.elapsed_ms >= 0));
});

test("错误保留在对应阶段，不伪装成证据不足", async () => {
  const r = await Reasoning.run(Reproductions.request(), async () => { throw new Error("模拟服务失败"); });
  assert.equal(r.trace.history[0].status, "failed");
  assert.equal(r.trace.history[0].stage, "generation");
  assert.equal(r.trace.history[0].error, "模拟服务失败");
});
test("主张能对照核验理由和具体引文，而不是仅列来源数量", () => {
  const trace = { input: { evidence: [{ evidence_id: "e1", quote: "林老师负责教务。", block_id: "b1" }] },
    generation: { statements: [{ id: "c1", text: "林老师负责教务。", evidence_ids: ["e1"] },
      { id: "c2", text: "林老师参与了接口讨论。", evidence_ids: ["e1"] }] },
    verification: { checks: [{ id: "c1", supported: true, basis: "document", evidence_ids: ["e1"] },
      { id: "c2", supported: false, reason: "只说明职责，未说明参与讨论" }] },
    rejected: [{ id: "c2", reason: "只说明职责，未说明参与讨论" }] };
  const r = Audit.review(trace, { meaning_here: { text: "林老师负责教务。" }, claims: [
    { claim_id: "c1", supports: [{ source_id: "e1" }] },
  ] });
  assert.equal(r.claims[0].evidence[0].quote, "林老师负责教务。");
  assert.equal(r.claims[1].status, "核验未通过");
  assert.match(r.claims[1].reason, /未说明/);
});
test("分组按请求隔离，简化回答不能冒充初始回答，前端正文有独立记录", async () => {
  const { outcome } = await Reproductions.run();
  const rows = Audit.fromSession({ id: "s", selection: "说话人 1", events: [
    { requestId: "a", type: "contextual_completed", data: { ...outcome.trace, result: outcome.result } },
    { requestId: "b", type: "answer_displayed", data: { mode: "simplify", finalOutput: "简化版" } },
    { requestId: "a", type: "answer_displayed", data: { rendered: { meaning: "前端错误地显示了其他内容" } } },
  ] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request_id, "a");
  assert.equal(rows[0].visible, "前端错误地显示了其他内容");
  assert.ok(rows[0].warnings.some((w) => w.code === "DISPLAY_DIFF"));
});
test("旧日志或截断日志不被当成完整的模型输入", () => {
  assert.ok(Audit.review({}).warnings.some((w) => w.code === "LEGACY_TRACE"));
  assert.ok(Audit.review({ input: { title: "[已截断]" } }).warnings.some((w) => w.code === "PARTIAL_TRACE"));
});
test("人工原文保留选中位置，不静默截断过长输入", async () => {
  const r = await Reproductions.run();
  const refs = Audit.manualEvidence(r.review.input, "同一人自述研究中心的职责。\n\n另一处补充资源协调。");
  assert.equal(refs.length, 3);
  assert.ok(refs[0].quote.includes("07:20"));
  assert.throws(() => Audit.manualEvidence(r.review.input, "字".repeat(1501)), /不会静默截断/);
  assert.throws(() => Audit.manualEvidence(r.review.input, ""), /原文/);
});
test("对照协议回放固定相同输入约定，使用模拟返回，不联网", async () => {
  const r = await Reproductions.run();
  const calls = [];
  const result = await Audit.compare({ input: r.review.input, manual: "研究中心负责资源协调。",
    model: "mock-model", executionMode: "mocked-protocol", reasoner: Reasoning, complete: async ({ messages }) => {
      calls.push(messages);
      const data = JSON.parse(messages[1].content), id = data.evidence[0].evidence_id;
      return { model: "mock-model", content: JSON.stringify(messages[0].content.includes("独立的语境主张核验器")
        ? { review_version: Reasoning.REVIEW_VERSION, checks: [{ id: "c1", selection_fit: "current", supported: true, basis: "document", usefulness: "useful", evidence_ids: [id],
          relation_audit: require("../evaluation/protocol-relation-fixture.js")(data.evidence[0].quote, id),
          citations: [{ evidence_id: id, quote: data.evidence[0].quote }] }], coverage: { status: "adequate", missing: [] } }
        : { target_type: "person", statements: [{ id: "c1", part: "meaning", basis: "document", text: "模拟答案", evidence_ids: [id] }] }) };
    } });
  assert.equal(calls.length, 4);
  assert.equal(result.arms.length, 2);
  assert.equal(result.same_model_confirmed, true);
  assert.equal(result.mode, "mocked-protocol");
  assert.equal(calls[0][0].content, calls[2][0].content);
  assert.equal(JSON.parse(calls[0][1].content).selected, JSON.parse(calls[2][1].content).selected);
  assert.notDeepEqual(result.arms[0].trace.evidence, result.arms[1].trace.evidence);
});
test("本地对照页没有网络或模型消息入口；所有脚本均存在", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "contextual-comparison.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "contextual-comparison.js"), "utf8");
  assert.match(html, /不会调用模型/);
  assert.doesNotMatch(js, /fetch\s*\(|sendMessage\s*\(|bigmodelApiKey/);
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) assert.ok(fs.existsSync(path.join(root, m[1])));
  assert.doesNotMatch(fs.readFileSync(path.join(root, "background.js"), "utf8"), /CONTEXTUAL_COMPARE/);
});
test("可读报告包含实际答案、引用和重试，不只有通过标志", async () => {
  const r = await Reproductions.run();
  const markdown = Audit.markdown([r.review]);
  assert.match(markdown, /07:20/);
  assert.match(markdown, /参与者之一/); assert.match(markdown, /LOW_INFORMATION_REVIEW/);
  assert.doesNotMatch(markdown, /ANCHOR_NOT_COVERED/);
  assert.match(markdown, /MOCK-NO-NETWORK/);
});
test("诊断脱敏保留长模型输入，并按容量清理最旧会话", async () => {
  const state = { diagnosticsEnabled: true };
  const context = { console, URL, setTimeout, clearTimeout, AbortController, TextDecoder,
    chrome: { runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
      storage: { local: { async get(key) { return { [key]: state[key] }; }, async set(value) { Object.assign(state, value); } } } } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../background.js"), "utf8"), context);
  const cleaned = context.sanitizeDiagnosticData({ history: [{ messages: [{ content: "字".repeat(18000) + " Bearer test-secret" }] }], apiKey: "hidden" });
  assert.ok(cleaned.history[0].messages[0].content.length > 18000);
  assert.ok(!JSON.stringify(cleaned).includes("test-secret"));
  assert.ok(!JSON.stringify(cleaned).includes('"apiKey"'));
  for (let i = 0; i < 40; i++) await context.recordDiagnosticEvent({ sessionId: "s" + i, eventType: "contextual_stage_completed", data: { messages: [{ content: "字".repeat(30000) }] } });
  assert.ok(state.yuliuDiagnosticsV1.evictedSessions > 0);
  assert.ok(JSON.stringify(state.yuliuDiagnosticsV1).length < 1000000);
});

test("高亮整块回退归入对应请求，显示范围与引用范围分开记录", async () => {
  const { outcome } = await Reproductions.run();
  const rows = Audit.fromSession({ id: "s", events: [
    { requestId: "a", type: "contextual_completed", data: { ...outcome.trace, result: outcome.result } },
    { requestId: "a", type: "evidence_navigated", data: { match: "element_fallback", quote_length: 1500, element_length: 6000 } },
  ] });
  assert.ok(rows[0].warnings.some((w) => w.code === "HIGHLIGHT_FALLBACK"));
  assert.equal(rows[0].navigation[0].element_length, 6000);
});
test("可读视图真实渲染四层内容，原文中的标签保持纯文本", async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.textContent = ""; }
    append(...children) { this.children.push(...children); }
  }
  const context = { document: { createElement: (tag) => new Element(tag) } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../contextual-audit-view.js"), "utf8"), context);
  const { review } = await Reproductions.run();
  review.actual = "<script>notExecutable()</script>原文作为纯文本";
  const tree = context.YuliuContextualAuditView.render(review);
  const flatten = (n) => [n.textContent, ...n.children.map(flatten)].join("\n");
  const text = flatten(tree);
  assert.match(text, /用户选中的这一次/);
  assert.match(text, /初稿、核验与引用对应/);
  assert.match(text, /后台最终回答/);
  assert.match(text, /前端实际可见正文/);
  assert.match(text, /<script>notExecutable\(\)<\/script>/);
  assert.equal(tree.innerHTML, undefined);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Redaction = require("../contextual-redaction.js");
const root = path.resolve(__dirname, "..");
// Entirely synthetic examples; no real meeting text or contacts are stored here.
function fixture(text = "张明 02:37:22 因为明川研究院这边我们确实要整合资源。我们不属于星河科技，对方学校负责课程。") {
  const input = { selected: "张明", title: "明川研究院与星河科技的讨论", coverage: { coverage: "loaded_content_only" },
    anchor: { excerpt: text, block_id: "private-doc-block", selected_start: 18, excerpt_start: 0 },
    exact_selection: { anchor_block_id: "private-doc-block", start_offset: 18 },
    conversation: { selected_speaker: "张明", anchor_time: "02:37:22", fingerprint: "private-fingerprint" },
    evidence: [{ evidence_id: "original-id", block_id: "private-doc-block", quote: text,
      speaker: "张明", time: "02:37:22", relation_to_selection: "anchor", source_start: 18, url: "https://private.example/doc" }],
    url: "https://private.example/doc", history: [{ messages: [{ content: "RAW-PROMPT-SECRET" }] }],
    candidates: [{ quote: "RAW-CANDIDATE-SECRET" }] };
  return { input_a: input, input_b: { ...input, evidence: [{ ...input.evidence[0], quote: "张老师补充，明川院不是星河科技，我们是研究院这边。" }] },
    original_review: { answer: "RAW-ANSWER-SECRET" } };
}
const rules = "人物：张明 | 张老师\n研究院：明川研究院 | 明川院\n公司：星河科技";

test("两组输入与各处字段使用一致代称，保留角色、否定和相对发言时间", () => {
  const before = fixture(), snapshot = JSON.stringify(before);
  const r = Redaction.prepare(before, rules), { input_a: a, input_b: b } = r.payload;
  assert.equal(a.selected, b.selected);
  assert.equal(a.selected, a.conversation.selected_speaker);
  assert.ok(a.evidence[0].quote.includes(a.selected));
  assert.ok(b.evidence[0].quote.startsWith(a.selected));
  assert.match(a.evidence[0].quote, /我们不属于〔脱敏公司1〕，对方学校负责课程/);
  assert.match(b.evidence[0].quote, /〔脱敏研究院1〕不是〔脱敏公司1〕，我们是研究院这边/);
  assert.equal(a.evidence[0].time, "02:37:22");
  assert.equal(JSON.stringify(before), snapshot);
  assert.doesNotMatch(JSON.stringify(r.payload), /张明|张老师|明川|星河/);
});
test("只导出白名单语义字段，不夹带原日志、网址、内部编号、位置或映射", () => {
  const r = Redaction.prepare(fixture(), rules), json = JSON.stringify(r.payload);
  assert.doesNotMatch(json, /private-doc|private-fingerprint|private\.example|RAW-|original_review|raw_output|messages|original-id|source_start|start_offset|originals/);
  assert.equal(r.payload.privacy.position_mode, "semantic_only");
  assert.equal(r.payload.external_transmission_allowed, false);
  assert.equal(r.payload.model_runs, 0);
  assert.ok(r.mapping.some((m) => m.originals.includes("张明")));
});
test("常见联系方式、链接、IP、证件和凭据自动遮盖", () => {
  const text = "邮箱: demo.person@example.test 手机 +86 138-0012-3456 电话 010-87654321 证件 110101199001010018；网址 https://private.example/a?token=secret，IP 192.168.1.8:8080；Bearer SAMPLE-CREDENTIAL；api_key=OTHER-CREDENTIAL。";
  const r = Redaction.prepare(fixture(text), rules), json = JSON.stringify(r.payload);
  assert.doesNotMatch(json, /demo\.person|138-0012|010-8765|110101199001|private\.example|192\.168|SAMPLE-CREDENTIAL|OTHER-CREDENTIAL/);
  for (const kind of ["邮箱", "手机号", "电话", "证件号", "链接", "IP地址", "凭据"]) assert.ok(r.mapping.some((m) => m.kind === kind), kind);
});
test("同一邮箱在两组中一致，联系方式覆盖内部姓名；保留时刻和普通数字", () => {
  const value = fixture("Ann 07:20 email Ann@example.test，预算 300，编号 2，时间 02:37:22");
  value.input_b.evidence[0].quote = "联系 ann@example.test，Planning 不应因 Ann 而改写。";
  const r = Redaction.prepare(value, "人物：Ann"), a = r.payload.input_a.evidence[0].quote, b = r.payload.input_b.evidence[0].quote;
  const email = r.mapping.find((m) => m.kind === "邮箱").replacement;
  assert.ok(a.includes(email)); assert.ok(b.includes(email));
  assert.match(b, /Planning/); assert.match(a, /07:20.*预算 300.*02:37:22/);
  assert.doesNotMatch(a + b, /example\.test/);
});
test("长别称优先、特殊字符按字面匹配，替换结果不被再次替换", () => {
  const r = Redaction.prepare(fixture("张明老师请 A+B 项目协助，AAB 不变，〔脱敏人物1〕是已有文本。"), "人物：张明老师 | 张明\n项目：A+B");
  assert.match(r.payload.input_a.evidence[0].quote, /〔脱敏人物2〕请 〔脱敏项目1〕 项目协助，AAB 不变/);
  assert.match(r.payload.input_a.evidence[0].quote, /〔脱敏人物1〕是已有文本/);
});
test("只替换文本，不破坏生成编号和读取范围枚举", () => {
  const value = fixture("loaded_content_only 与 a-e1 是本次要遮盖的原词。");
  const r = Redaction.prepare(value, "项目：loaded_content_only\n项目：a-e1");
  assert.equal(r.payload.input_a.coverage.coverage, "loaded_content_only");
  assert.equal(r.payload.input_a.evidence[0].evidence_id, "a-e1");
  assert.doesNotMatch(r.payload.input_a.evidence[0].quote, /loaded_content_only|a-e1/);
});
test("规则格式、重复别称、输入大小异常明确报错，不偷偷导出原文", () => {
  assert.throws(() => Redaction.prepare(fixture(), "张明"), /格式/);
  assert.throws(() => Redaction.parseRules("人物：张明\n人物：张明"), /重复/);
  assert.throws(() => Redaction.parseRules("人物：张"), /2—2000/);
  assert.throws(() => Redaction.prepare({}), /完整/);
  assert.throws(() => Redaction.prepare(fixture("字".repeat(61000))), /过大/);
  assert.ok(Redaction.prepare(fixture(), "人物：没有出现").warnings.some((s) => s.includes("没有独立命中")));
});
test("未知人名不虚称自动识别完成，始终要求核对遗漏与语义影响", () => {
  const r = Redaction.prepare(fixture("王小山参与秘密合作。"));
  assert.match(r.payload.input_a.evidence[0].quote, /王小山/);
  assert.ok(r.warnings.some((s) => s.includes("不能保证完全匿名")));
  assert.ok(r.warnings.some((s) => s.includes("角色、否定、条件")));
  assert.equal(r.payload.privacy.human_reviewed_for_local_export, false);
});
test("发言者候选只读明确标签，不把提及的人或匿名编号认作真实姓名", () => {
  const value = fixture("说话人 5 07:20 张老师谈到研究院。\n李小禾 07:21 我补充。");
  value.input_a.evidence[0].speaker = "说话人 5";
  value.input_a.conversation.selected_speaker = "说话人 5";
  value.input_b = value.input_a;
  const suggested = Redaction.suggestSpeakers(value);
  assert.equal(suggested, "人物：李小禾");
});
test("预览后确认才能导出；改动、失败或取消确认都使旧确认失效", () => {
  const session = Redaction.createSession();
  assert.equal(session.review(true), false);
  assert.throws(() => session.exportData(), /核对/);
  const preview = session.prepare(fixture(), rules);
  assert.throws(() => session.exportData(), /核对/);
  preview.payload.input_a.selected = "不要影响内部副本";
  session.review(true);
  const exported = session.exportData();
  assert.match(exported.input_a.selected, /脱敏人物/);
  assert.equal(exported.privacy.human_reviewed_for_local_export, true);
  assert.equal(exported.external_transmission_allowed, false);
  session.review(false); assert.throws(() => session.exportData(), /核对/);
  session.review(true); session.invalidate(); assert.throws(() => session.exportData(), /核对/);
  session.prepare(fixture(), rules); session.review(true);
  assert.throws(() => session.prepare(fixture(), "格式错误"), /格式/);
  assert.throws(() => session.exportData(), /核对/);
});
test("脱敏模块没有网络调用或本地持久化，原日志脱敏不是本次功能", () => {
  const code = fs.readFileSync(path.join(root, "contextual-redaction.js"), "utf8");
  assert.doesNotMatch(code, /fetch\s*\(|sendMessage\s*\(|XMLHttpRequest|WebSocket|localStorage|storage\.local|writeFile/);
  const html = fs.readFileSync(path.join(root, "contextual-comparison.html"), "utf8");
  assert.match(html, /原始文档和本机诊断记录保持不变/);
  assert.match(html, /此勾选不授权发送/);
});

test("实际页面事件：清单修改撤销确认；导出只用脱敏副本，失败不沿用旧预览", async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.value = ""; this.textContent = ""; this.checked = false; this.disabled = false; this.listeners = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(event, cb) { this.listeners[event] = cb; }
    fire(event) { return this.listeners[event]?.({ target: this }); }
    click() { return this.fire("click"); }
  }
  const html = fs.readFileSync(path.join(root, "contextual-comparison.html"), "utf8");
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element("div")]));
  const original = fixture(), downloads = [];
  const session = { id: "s", selection: "张明", events: [{ requestId: "r", type: "contextual_input", data: original.input_a }] };
  const context = { document: { getElementById: (id) => nodes.get(id), createElement: (tag) => new Element(tag) },
    location: { search: "" }, URLSearchParams, structuredClone, Blob, setTimeout: (fn) => fn(),
    URL: { createObjectURL: (blob) => { downloads.push(blob); return "blob:local-only"; }, revokeObjectURL() {} },
    chrome: { storage: { local: { get: async () => ({ yuliuDiagnosticsV1: { sessions: [session] } }) } } } };
  vm.createContext(context);
  for (const file of ["contextual-audit.js", "contextual-audit-view.js", "contextual-redaction.js", "contextual-comparison.js"]) vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  await new Promise(setImmediate);
  const node = (id) => nodes.get(id);
  node("manual").value = original.input_b.evidence[0].quote;
  node("prepare").click();
  node("entities").value = rules; node("entities").fire("input"); node("preview").click();
  assert.equal(node("export").disabled, true);
  assert.match(node("redacted").textContent, /脱敏人物/);
  assert.doesNotMatch(node("redacted").textContent, /张明|星河|private-doc|RAW-/);
  node("reviewed").checked = true; node("reviewed").fire("change");
  assert.equal(node("export").disabled, false);
  node("export").click();
  const output = JSON.parse(await downloads[0].text());
  assert.equal(output.mode, "local-redacted-preparation-only");
  assert.equal(output.external_transmission_allowed, false);
  node("entities").fire("input");
  assert.equal(node("export").disabled, true); assert.equal(node("reviewed").checked, false);
  node("export").click(); assert.equal(downloads.length, 1);
  node("entities").value = "错误规则"; node("preview").click();
  assert.equal(node("redacted").textContent, ""); assert.equal(node("reviewed").disabled, true);
  node("entities").value = rules; node("preview").click();
  node("reviewed").checked = true; node("reviewed").fire("change");
  node("manual").fire("input");
  assert.equal(node("export").disabled, true); assert.equal(node("preview").disabled, true);
  node("export").click(); assert.equal(downloads.length, 1);
});

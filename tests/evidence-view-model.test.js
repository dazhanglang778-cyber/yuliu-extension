const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const EvidenceViewModel = require("../evidence-view-model.js");

test("依据视图模块会在卡片脚本之前加载", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("evidence-view-model.js") >= 0);
  assert.ok(scripts.indexOf("evidence-view-model.js") < scripts.indexOf("content.js"));
});

test("依据视图明确分开原文依据与术语资料", () => {
  const model = EvidenceViewModel.build([
    { evidence_id: "e1", block_id: "p1", quote: "Harness 是组织 Agent 与环境交互的运行框架。" },
  ], [{
    source_id: "x1",
    title: "Agent Harness Engineering",
    url: "https://docs.example.org/research/agent-harness?utm_source=a-very-long-query-value",
    publisher: "Example Research",
    excerpt: "A harness coordinates tools, environments and feedback.",
  }]);
  assert.equal(model.total, 2);
  assert.equal(model.summary, "依据 · 原文1处 / 术语资料1条");
  assert.equal(model.page.length, 1);
  assert.equal(model.terminology[0].host, "docs.example.org");
});

test("术语资料去重并拒绝非网页协议", () => {
  const model = EvidenceViewModel.build([], [
    { source_id: "x1", title: "安全来源", url: "https://example.org/a" },
    { source_id: "x1", title: "重复来源", url: "https://example.org/b" },
    { source_id: "x2", title: "危险来源", url: "javascript:alert(1)" },
    { source_id: "x3", title: "缺少地址", url: "" },
  ]);
  assert.equal(model.terminology.length, 1);
  assert.equal(model.terminology[0].title, "安全来源");
  assert.equal(EvidenceViewModel.safeHttpUrl("file:///tmp/a"), "");
});

test("只有一种依据时摘要不制造空分组", () => {
  const pageOnly = EvidenceViewModel.build([{ evidence_id: "e1", block_id: "p1", quote: "原文" }], []);
  const sourceOnly = EvidenceViewModel.build([], [{ source_id: "x1", title: "词条", url: "https://example.org" }]);
  assert.equal(pageOnly.summary, "依据 · 原文1处");
  assert.equal(sourceOnly.summary, "依据 · 术语资料1条");
});

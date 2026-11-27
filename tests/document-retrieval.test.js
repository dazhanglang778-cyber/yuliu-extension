const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Retrieval = require("../document-retrieval.js");

const root = path.resolve(__dirname, "..", "evaluation");
const dataset = JSON.parse(fs.readFileSync(path.join(root, "datasets", "core-context-v1.json"), "utf8"));

function normalize(value) {
  return String(value || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function blocksFromDocument(document) {
  const html = fs.readFileSync(path.join(root, document.file), "utf8");
  const blocks = [];
  const headings = [];
  const pattern = /<(h[1-6]|p|li|blockquote|pre|td|th|figcaption)\b[^>]*data-block-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const tag = match[1].toLocaleLowerCase();
    const text = normalize(match[3]);
    const headingMatch = tag.match(/^h([1-6])$/);
    if (headingMatch) {
      const level = Number(headingMatch[1]);
      headings.length = level - 1;
      headings[level - 1] = text;
    }
    blocks.push({
      block_id: match[2],
      type: headingMatch ? "heading" : "paragraph",
      heading_path: headings.filter(Boolean),
      text,
      order: blocks.length,
    });
  }
  return blocks;
}

function snapshotFor(document, item) {
  return {
    snapshot_version: "test",
    selection: {
      raw_text: item.selection.exact,
      normalized_text: item.selection.exact,
      anchor_block_id: item.selection.anchor_block_id,
    },
    page: { title: document.title, url: `test://${document.document_id}` },
    blocks: blocksFromDocument(document),
  };
}

test("全文同词扫描区分英文单词边界并统计所有出现", () => {
  assert.equal(Retrieval.countTermOccurrences("Harness and another Harness.", "Harness"), 2);
  assert.equal(Retrieval.countTermOccurrences("harnessing is different", "Harness"), 0);
  assert.equal(Retrieval.countTermOccurrences("回声预算会缩短，回声预算不是资金", "回声预算"), 2);
});

test("中英文正向和反向定义句都能被识别", () => {
  assert.ok(Retrieval.definitionSignal("本文把旧反馈可使用的轮数称为回声预算。", "回声预算") > 0);
  assert.ok(Retrieval.definitionSignal("Apple 在这里指美国科技公司苹果公司。", "Apple") > 0);
  assert.ok(Retrieval.definitionSignal("Benchmark refers to a fixed evaluation suite.", "Benchmark") > 0);
  assert.ok(Retrieval.definitionSignal("MCP 是模型上下文协议（Model Context Protocol）的简称。", "MCP") > 0);
  assert.ok(Retrieval.definitionSignal("MaaS（Model As A Service，模型即服务）是将模型能力以服务形式提供的技术模式。", "MaaS") > 0);
  assert.ok(Retrieval.definitionSignal("RAG 即检索增强生成。", "RAG") > 0);
  assert.ok(Retrieval.definitionSignal("优雅降级：如果多次压缩尝试都失败，回退到保守的消息阶段策略。", "优雅降级") > 0);
  assert.ok(Retrieval.definitionSignal("Memory为智能体的工作台。", "Memory") > 0);
  assert.equal(Retrieval.definitionSignal("Harness 和 Atlas 都出现在项目清单中。", "Harness"), 0);
});

test("远处的缩写定义会被召回并标记为直接支持", () => {
  const snapshot = {
    selection: { raw_text: "MCP", normalized_text: "MCP", anchor_block_id: "p-auth" },
    blocks: [
      { block_id: "p-definition", type: "paragraph", heading_path: ["AI应用研发基础设施", "MCP"], text: "MCP 是模型上下文协议（Model Context Protocol）的简称，是连接外部数据源和工具的开放协议。", order: 0 },
      { block_id: "p-filler", type: "paragraph", heading_path: ["AI应用安全"], text: "这里讨论身份认证、授权和鉴权。", order: 1 },
      { block_id: "p-auth", type: "paragraph", heading_path: ["AI应用安全", "身份与授权"], text: "AI 场景下的认证和授权根据交互方的不同（如 Agent、MCP 等），与传统 RPC/HTTP 存在差异。", order: 2 },
    ],
  };
  const result = Retrieval.retrieve(snapshot);
  const definition = result.candidates.find((item) => item.block_id === "p-definition");
  assert.ok(definition);
  assert.equal(definition.role, "direct_support");
  assert.ok(definition.reasons.includes("定义句"));
});

test("复合选词会召回只出现核心词干的远处说明段落", () => {
  const snapshot = {
    selection: { raw_text: "保鲜策略", normalized_text: "保鲜策略", anchor_block_id: "p-anchor" },
    blocks: [
      { block_id: "p-anchor", type: "heading", heading_path: ["Memory保鲜策略"], text: "3. Memory保鲜策略", order: 0 },
      { block_id: "p-noise", type: "paragraph", heading_path: ["Memory保鲜策略"], text: "这里还有若干普通实现细节。", order: 1 },
      { block_id: "p-support", type: "paragraph", heading_path: ["Memory管理"], text: "因此，我们对上下文进行减噪、提要、保鲜，确保留下的信息具有高价值、长期性和强推理作用。", order: 18 },
    ],
  };
  const result = Retrieval.retrieve(snapshot);
  const support = result.candidates.find((item) => item.block_id === "p-support");
  assert.ok(support);
  assert.ok(support.reasons.some((reason) => reason.startsWith("词干出现")));
  assert.equal(support.role, "coreference_support");
});

test("当前选区永远进入候选证据且排名第一", () => {
  for (const document of dataset.documents) {
    for (const item of document.cases) {
      const result = Retrieval.retrieve(snapshotFor(document, item));
      assert.equal(result.candidates[0].block_id, item.selection.anchor_block_id, `${item.case_id} 未把锚点排在第一位`);
      assert.ok(result.promptContext.includes(item.selection.anchor_block_id));
    }
  }
});

test("当前28个案例的人工金标准证据全部被召回", () => {
  let checked = 0;
  for (const document of dataset.documents) {
    for (const item of document.cases) {
      const result = Retrieval.retrieve(snapshotFor(document, item));
      const recalled = new Set(result.candidates.map((candidate) => candidate.block_id));
      for (const evidence of item.evidence) {
        assert.ok(recalled.has(evidence.block_id), `${item.case_id} 未召回金标准证据 ${evidence.block_id}`);
      }
      checked += 1;
    }
  }
  assert.equal(checked, 28);
});

test("Harness定义段落排在无关具体产品名单之前", () => {
  const document = dataset.documents.find((item) => item.document_id === "agent-harness");
  const item = document.cases.find((entry) => entry.case_id === "harness-later-use");
  const result = Retrieval.retrieve(snapshotFor(document, item));
  const rank = new Map(result.candidates.map((candidate, index) => [candidate.block_id, index]));
  assert.ok(rank.get("p-4") < rank.get("p-6"));
  assert.ok(result.candidates.find((candidate) => candidate.block_id === "p-4").reasons.includes("定义句"));
  assert.ok(!result.candidates.find((candidate) => candidate.block_id === "p-6").reasons.includes("定义句"));
});

test("发给后台的紧凑快照只保留召回块而非整篇正文", () => {
  const document = dataset.documents.find((item) => item.document_id === "echo-budget");
  const item = document.cases.find((entry) => entry.case_id === "echo-budget-long-distance");
  const snapshot = snapshotFor(document, item);
  const result = Retrieval.retrieve(snapshot, { limit: 4 });
  snapshot.evidence_candidates = result.candidates;
  snapshot.retrieval = result.summary;
  const compact = Retrieval.compactSnapshot(snapshot, "req-1");
  assert.equal(compact.request_id, "req-1");
  assert.equal(compact.blocks.length, result.candidates.length);
  assert.ok(compact.blocks.length < snapshot.blocks.length);
  assert.equal(compact.retrieval.strategy, "heading_body_v2");
});

test("扩展按文档上下文、检索层、界面脚本的顺序加载", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf("document-context.js") < scripts.indexOf("document-retrieval.js"));
  assert.ok(scripts.indexOf("document-retrieval.js") < scripts.indexOf("content.js"));
});

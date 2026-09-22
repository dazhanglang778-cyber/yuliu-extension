const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const DocumentContext = require("../document-context.js");

test("扩展会在界面脚本之前加载文档上下文层", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.includes("document-context.js"));
  assert.ok(scripts.indexOf("document-context.js") < scripts.indexOf("content.js"));
});

function itemsFromFixture(filePath) {
  const html = fs.readFileSync(filePath, "utf8");
  const items = [];
  const pattern = /<(h[1-6]|p|li|blockquote|pre|td|th|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    items.push({
      sourceIndex: items.length,
      tagName: match[1],
      text: match[2].replace(/<[^>]+>/g, ""),
    });
  }
  return items;
}

test("相同内容和标题路径会产生稳定段落编号", () => {
  const items = [
    { tagName: "h1", text: "第一章" },
    { tagName: "p", text: "正文内容" },
    { tagName: "h2", text: "第二节" },
    { tagName: "p", text: "更多内容" },
  ];
  const first = DocumentContext.createBlockRecords(items);
  const second = DocumentContext.createBlockRecords(items);
  assert.deepEqual(first, second);
  assert.equal(first[1].heading_path.join(" > "), "第一章");
  assert.equal(first[3].heading_path.join(" > "), "第一章 > 第二节");
  assert.equal(new Set(first.map((block) => block.block_id)).size, first.length);
});

test("重复正文块仍会获得不同但可重复的编号", () => {
  const blocks = DocumentContext.createBlockRecords([
    { tagName: "h1", text: "标题" },
    { tagName: "p", text: "相同段落" },
    { tagName: "p", text: "相同段落" },
  ]);
  assert.notEqual(blocks[1].block_id, blocks[2].block_id);
  assert.match(blocks[2].block_id, /-2$/);
});

test("根据Range近似位置定位同一段中的正确一次同名词", () => {
  const text = "Apple 在果园里是水果。稍后 Apple 出现在公司新闻中。";
  const first = DocumentContext.createTextQuote(text, "Apple", 0);
  const second = DocumentContext.createTextQuote(text, "Apple", 20);
  assert.equal(first.occurrence_index, 0);
  assert.equal(second.occurrence_index, 1);
  assert.ok(first.suffix.includes("果园"));
  assert.ok(second.prefix.includes("稍后"));
});

test("原文引文定位索引会折叠空白并保留字符位置", () => {
  const indexed = DocumentContext.buildNormalizedTextIndex(["Harness  是", "组织\nAgent 交互的", "运行框架。"]);
  assert.equal(indexed.text, "Harness 是组织 Agent 交互的运行框架。");
  const start = indexed.text.indexOf("组织 Agent");
  assert.deepEqual(indexed.positions[start], { chunkIndex: 1, offset: 0 });
  assert.equal(indexed.positions[start + "组织 Agent".length - 1].chunkIndex, 1);
});

test("旧接口过渡文本以选区所在块为锚点且不在段落中间截断", () => {
  const blocks = DocumentContext.createBlockRecords([
    { tagName: "p", text: "前文定义" },
    { tagName: "p", text: "当前选中词所在段落" },
    { tagName: "p", text: "后文说明" },
  ]);
  const text = DocumentContext.buildLegacyContext(blocks, blocks[1].block_id, 200);
  assert.equal(text, "前文定义\n当前选中词所在段落\n后文说明");
});

test("超长内容不会按开头硬截断并丢失文末选区", () => {
  const items = Array.from({ length: 1200 }, (_, index) => ({
    tagName: "p",
    text: index === 1199 ? "文末仍然包含用户选中的特殊术语" : `第 ${index + 1} 个正文段落 ${"内容".repeat(80)}`,
  }));
  const blocks = DocumentContext.createBlockRecords(items);
  assert.equal(blocks.length, 1200);
  assert.ok(blocks.at(-1).text.includes("特殊术语"));
});

test("首批完整页面均可生成稳定且带标题路径的正文块", () => {
  const documentsDir = path.resolve(__dirname, "..", "evaluation", "documents");
  const files = fs.readdirSync(documentsDir).filter((name) => name.endsWith(".html"));
  assert.equal(files.length, 8);
  for (const file of files) {
    const items = itemsFromFixture(path.join(documentsDir, file));
    const blocks = DocumentContext.createBlockRecords(items);
    assert.ok(blocks.length >= 5, `${file} 没有提取出足够正文块`);
    assert.equal(new Set(blocks.map((block) => block.block_id)).size, blocks.length, `${file} 段落编号不唯一`);
    assert.ok(blocks.some((block) => block.type === "heading"), `${file} 缺少标题结构`);
    assert.deepEqual(blocks, DocumentContext.createBlockRecords(items), `${file} 段落编号不稳定`);
  }
});

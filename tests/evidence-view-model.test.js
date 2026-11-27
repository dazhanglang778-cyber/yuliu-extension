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
  assert.equal(model.summary, "依据 · 原文1个片段 / 术语资料1条");
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
  assert.equal(pageOnly.summary, "依据 · 原文1个片段");
  assert.equal(sourceOnly.summary, "依据 · 术语资料1条");
});

test("重叠引文按位置合并，保留原始引用和主张映射，不修改输入", () => {
  const source = "甲乙丙丁戊己庚辛壬癸";
  const e = (id, start, end, offset = 0) => ({evidence_id:id, block_id:'p', source_start:start,
    source_offset:offset, quote:source.slice(start + offset, end + offset), claim_ids:[id]});
  const input = [e('a', 0, 5), e('b', 4, 10), e('c', 2, 4)];
  const before = JSON.stringify(input);
  const page = EvidenceViewModel.build(input, []).page;
  assert.equal(page.length, 1); assert.equal(page[0].quote, source);
  assert.equal(page[0].source_start, 0); assert.equal(page[0].source_end, 10);
  assert.equal(page[0].members.length, 3); assert.equal(JSON.stringify(input), before);
  assert.deepEqual(page[0].members.flatMap(m=>m.claim_ids).sort(), ['a','b','c']);
});

test("不同偏移的同一原文重叠可合并，冲突文字、不同块和同词不同位置不可合并", () => {
  const a = {block_id:'p',quote:'甲乙丙丁',source_offset:100,source_start:2};
  const b = {block_id:'p',quote:'丙丁戊',source_offset:102,source_start:2};
  assert.equal(EvidenceViewModel.build([a,b],[]).page[0].quote,'甲乙丙丁戊');
  for (const other of [{...b,quote:'错丁戊'}, {...b,block_id:'other'}, {...a,source_start:30}])
    assert.equal(EvidenceViewModel.build([a,other],[]).page.length,2);
});

test("桥接引文、逆序输入也只合并连续重叠区间", () => {
  const input = [{source_start:4,quote:'戊己庚'}, {source_start:0,quote:'甲乙丙'}, {source_start:2,quote:'丙丁戊'}]
    .map((e,i)=>({...e,block_id:'p',evidence_id:String(i)}));
  const result=EvidenceViewModel.build(input,[]);
  assert.equal(result.page.length,1);assert.equal(result.page[0].quote,'甲乙丙丁戊己庚');
});

test("相邻同小节片段归组；同标题远处、不同章节、不同发言仍分开", () => {
  const blocks=Array.from({length:9},(_,i)=>({block_id:'b'+i}));
  const e=(i,extra={})=>({block_id:'b'+i,quote:'片段'+i,heading_path:['4.3'],...extra});
  const model=EvidenceViewModel.build([e(2),e(1),e(8),e(3,{heading_path:['4.4']}),e(4,{speaker:'甲'})],[],blocks);
  assert.equal(model.pageGroups.length,4);
  assert.deepEqual(model.pageGroups[0].items.map(e=>e.block_id),['b1','b2']);
  assert.equal(model.page.length,5);
});

test("无位置元数据时不凭相同标题乱合组；完整引文不按长度截断", () => {
  const quote='证据'.repeat(500);
  const result=EvidenceViewModel.build([{block_id:'a',quote,heading_path:['章']},{block_id:'b',quote,heading_path:['章']}],[]);
  assert.equal(result.pageGroups.length,2);assert.equal(result.page[0].quote,quote);
  const sameBlock=[{block_id:'p',evidence_id:'a',quote:'是的。'},{block_id:'p',evidence_id:'b',quote:'是的。'}];
  assert.equal(EvidenceViewModel.build(sameBlock,[]).page.length,2);
});

test("阅读窗口扩大上下文但不改高亮引文，错误坐标不猜测", () => {
  const source='开头。这里是具体证据。后面说明。';
  const evidence={block_id:'b',source_start:3,quote:'这里是具体证据。'};
  const blocks=[{block_id:'b',text:source}];
  assert.equal(EvidenceViewModel.readingContext(evidence,blocks),source);
  assert.equal(evidence.quote,'这里是具体证据。');
  assert.equal(EvidenceViewModel.readingContext({...evidence,source_start:0},blocks),'');
  const long='前'.repeat(1000)+evidence.quote+'后'.repeat(1000);
  const context=EvidenceViewModel.readingContext({...evidence,source_start:1000},[{block_id:'b',text:long}]);
  assert.ok(context.includes(evidence.quote));assert.ok(context.length<=210);
});

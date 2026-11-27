const test = require("node:test");
const assert = require("node:assert/strict");
const Reasoning = require("../contextual-reasoning.js");
const Retrieval = require("../document-retrieval.js");
const Document = require("../document-context.js");

function requestFor(source, selected, at, candidates = null, sourceOffset = 0) {
  const snapshot = { page: { title: "合成定位测试", url: "test://selection" },
    blocks: [{ block_id: "b", text: source, order: 0, source_start: sourceOffset }],
    selection: { raw_text: selected, normalized_text: selected, anchor_block_id: "b", start_offset: at },
    extraction: { coverage: "synthetic_complete" } };
  snapshot.evidence_candidates = candidates || Retrieval.retrieve(snapshot).candidates;
  return { selection: selected, documentContext: snapshot };
}
function assertExact(request, evidence) {
  for (const e of evidence) {
    const block = request.documentContext.blocks.find((b) => b.block_id === e.block_id);
    assert.equal(block.text.slice(e.source_start, e.source_start + e.quote.length), e.quote);
    assert.equal(e.source_end, e.source_start + e.quote.length);
    assert.ok(e.quote.length <= 1500);
    assert.equal(e.source_offset, block.source_start || 0);
  }
  assert.ok(evidence.reduce((n, e) => n + e.quote.length, 0) <= 17000);
}

test("整条本地检索链保留长段落后一次含义，不被开头同词覆盖", () => {
  const source = "前文通道指消息队列。" + "无关的排版背景。".repeat(280) + "此处通道指学校与研究院的沟通渠道。";
  const at = source.lastIndexOf("通道"), req = requestFor(source, "通道", at);
  assert.match(req.documentContext.evidence_candidates[0].quote, /沟通渠道/);
  const evidence = Reasoning.evidenceFor(req);
  assert.match(evidence[0].quote, /沟通渠道/);
  assert.ok(evidence[0].source_start <= at && evidence[0].source_end >= at + 2);
  assert.equal(evidence[0].relation_to_selection, "anchor");
  assertExact(req, evidence);
  const longSelection = "长选词".repeat(100);
  assert.equal(Retrieval.bestQuote("前缀" + longSelection + "后缀", longSelection, 260, 2), longSelection);
});
test("超过旧6500字符预截断上限的位置仍可准确进入输入", () => {
  const source = "开头 Memory 指硬件存储。" + "背景。".repeat(2200) + "最后 Memory 指智能体的任务记忆机制。";
  const req = requestFor(source, "Memory", source.lastIndexOf("Memory"));
  const evidence = Reasoning.evidenceFor(req);
  assert.match(evidence[0].quote, /任务记忆机制/);
  assertExact(req, evidence);
});
test("已有非零片段偏移仅换算一次，不从整个块的同词首次出现重定位", () => {
  const prefix = "早先说可以。".repeat(80), part = "问题很长。".repeat(80) + "这里可以，但必须保留权限校验。";
  const source = prefix + part;
  const req = requestFor(source, "可以", source.lastIndexOf("可以"), [
    { evidence_id: "e1", block_id: "b", text: part, quote: part, source_start: prefix.length, source_end: source.length, relation_to_selection: "anchor" },
  ], 9200);
  const evidence = Reasoning.evidenceFor(req);
  assert.match(evidence[0].quote, /权限校验/);
  assert.ok(evidence[0].source_start >= prefix.length);
  assertExact(req, evidence);
});
test("同块多轮中的其他短答保留自己的位置与说话人，不都冒充当前位置", () => {
  const source = "说话人 1 00:01 可以先看资料。 发言者甲 00:10 可以。 说话人 1 00:20 可以，但不能删除旧库。";
  const req = requestFor(source, "可以", source.lastIndexOf("可以"));
  const evidence = Reasoning.evidenceFor(req);
  assert.equal(evidence.filter((e) => e.relation_to_selection === "anchor").length, 1);
  assert.equal(evidence[0].time, "00:20");
  assert.match(evidence[0].quote, /不能删除旧库/);
  assert.equal(evidence.find((e) => e.time === "00:10").speaker, "发言者甲");
  assertExact(req, evidence);
});
test("连续相同短答有明确源位置时不能跳回较早的同一句", () => {
  const source = "前一个问题。可以。另一个问题。可以。";
  const at = source.lastIndexOf("可以");
  const req = requestFor(source, "可以", at, [
    { evidence_id: "e1", block_id: "b", text: "可以。", source_start: at, source_end: at + 3 },
  ]);
  const evidence = Reasoning.evidenceFor(req);
  assert.equal(evidence[0].source_start, at);
  assertExact(req, evidence);
});
test("不再二次折叠原文空白，非零坐标和引文始终一一对应", () => {
  const source = "\n 前段  可以。\n\n  本段\t可以，但保留两处  空格。  ";
  const req = requestFor(source, "可以", source.lastIndexOf("可以"));
  const evidence = Reasoning.evidenceFor(req);
  assert.ok(evidence.length);
  assert.match(evidence[0].quote, /两处  空格/);
  assertExact(req, evidence);
});
test("候选中声称的源位置与原文不符时不伪造坐标", () => {
  const source = "通道在这里指沟通渠道。";
  const req = requestFor(source, "通道", 0, [
    { evidence_id: "bad-start", block_id: "b", text: source, source_start: 2 },
    { evidence_id: "bad-end", block_id: "b", text: source, source_start: 0, source_end: 2 },
    { evidence_id: "real", block_id: "b", text: source, source_start: 0, source_end: source.length },
  ]);
  assert.deepEqual(Reasoning.evidenceFor(req).map((e) => e.evidence_id), ["real"]);
});
test("失效的选区坐标不能悄悄被第一次同词替代", () => {
  const req = requestFor("第一处通道。第二处通道。", "通道", 999);
  assert.equal(Reasoning.evidenceFor(req).length, 0);
});
test("旧请求缺坐标时仅接受唯一匹配或明确出现序号，不猜多义位置", () => {
  const source = "第一次通道。第二次通道。", req = requestFor(source, "通道", undefined);
  assert.equal(Reasoning.evidenceFor(req).length, 0);
  req.documentContext.selection.occurrence_index = 1;
  const e = Reasoning.evidenceFor(req);
  assert.equal(e[0].relation_to_selection, "anchor");
  assertExact(req, e);
  const unique = requestFor("这里的通道就是沟通渠道。", "通道", undefined);
  assert.equal(Reasoning.evidenceFor(unique)[0].relation_to_selection, "anchor");
});
test("远处定义位于长块末尾时不会先截掉后再找定义", () => {
  const req = requestFor("当前调用 API。", "API", 5);
  const far = "历史背景。".repeat(1500) + "API 是应用程序编程接口。";
  req.documentContext.blocks.push({ block_id: "far", text: far });
  req.documentContext.evidence_candidates.push({ evidence_id: "far-e", block_id: "far", text: far, quote: "API 是应用程序编程接口。" });
  const evidence = Reasoning.evidenceFor(req);
  assert.ok(evidence.some((e) => e.block_id === "far" && e.quote.includes("应用程序编程接口")));
  assertExact(req, evidence);
});
test("总预算紧张且候选乱序时仍为实际选区保留输入位置", () => {
  const req = requestFor("此处通道指项目协作渠道。", "通道", 2);
  const anchor = req.documentContext.evidence_candidates[0];
  req.documentContext.evidence_candidates = [];
  for (let i = 0; i < 15; i++) {
    const b = { block_id: "far" + i, text: "无关描述。".repeat(300) };
    req.documentContext.blocks.push(b);
    req.documentContext.evidence_candidates.push({ evidence_id: "far" + i, block_id: b.block_id, text: b.text });
  }
  req.documentContext.evidence_candidates.push(anchor);
  const evidence = Reasoning.evidenceFor(req);
  assert.equal(evidence[0].block_id, "b");
  assert.equal(evidence[0].relation_to_selection, "anchor");
  assertExact(req, evidence);
});
test("前端分块的源偏移与生成截取偏移可相加还原原始位置", () => {
  const source = "填充。".repeat(2100) + "后部说明通道是项目沟通渠道。";
  const blocks = Document.createBlockRecords([{ text: source, tagName: "p" }]);
  const block = blocks.at(-1), at = block.text.lastIndexOf("通道");
  const req = requestFor(block.text, "通道", at, null, block.source_start);
  const evidence = Reasoning.evidenceFor(req);
  assertExact(req, evidence);
  assert.equal(source.slice(evidence[0].source_offset + evidence[0].source_start, evidence[0].source_offset + evidence[0].source_end), evidence[0].quote);
});
test("不同长度、不同选中位置下，核心窗口必须覆盖该次词而非其他同词", () => {
  for (const size of [0, 260, 1490, 3000, 6600]) for (const position of [0, 1, 2]) {
    const gap = "字".repeat(size), source = "对象甲 通道。" + gap + "对象乙 通道。" + gap + "对象丙 通道。";
    const starts = [...source.matchAll(/通道/g)].map((m) => m.index), at = starts[position];
    const req = requestFor(source, "通道", at), evidence = Reasoning.evidenceFor(req);
    assert.ok(evidence.some((e) => e.source_start <= at && e.source_end >= at + 2), `${size}:${position}`);
    assertExact(req, evidence);
  }
});

test("生成和核验两次调用收到同一正确选区，最终依据保留确切坐标（本地预设返回）", async () => {
  const source = "前文通道是消息队列。" + "无关背景。".repeat(600) + "此处通道是项目沟通渠道。";
  const req = requestFor(source, "通道", source.lastIndexOf("通道"));
  const received = [];
  const outcome = await Reasoning.run(req, async ({ messages }) => {
    const data = JSON.parse(messages[1].content), e = data.evidence[0];
    received.push(data.evidence);
    assert.match(e.quote, /项目沟通渠道/);
    assert.doesNotMatch(e.quote, /消息队列/);
    assertExact(req, data.evidence);
    return JSON.stringify(messages[0].content.includes("独立的语境主张核验器")
      ? { review_version: Reasoning.REVIEW_VERSION, checks: [{ id: "c1", selection_fit: "current", supported: true, basis: "document", usefulness: "useful", evidence_ids: [e.evidence_id],
        relation_audit: require("../evaluation/protocol-relation-fixture.js")(e.quote, e.evidence_id),
        citations: [{ evidence_id: e.evidence_id, quote: e.quote }] }], coverage: { status: "adequate", missing: [] } }
      : { target_type: "term", statements: [{ id: "c1", part: "meaning", basis: "document",
        text: "此处通道是项目沟通渠道。", evidence_ids: [e.evidence_id] }] });
  });
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], received[1]);
  assert.deepEqual(outcome.trace.input.evidence, received[0]);
  assert.match(outcome.result.meaning_here.text, /项目沟通渠道/);
  assertExact(req, outcome.result.page_evidence);
});

test("无效定位不调用模型，也不把输入错误谎报为原文没有信息", async () => {
  const req = requestFor("明确内容：通道是项目沟通渠道。", "通道", 999);
  let calls = 0;
  const outcome = await Reasoning.run(req, async () => { calls++; throw new Error("不应调用"); });
  assert.equal(calls, 0);
  assert.match(outcome.result.meaning_here.text, /不代表原文没有足够信息/);
  assert.equal(outcome.result.contextual_details.failure, "NO_VALID_EVIDENCE");
});

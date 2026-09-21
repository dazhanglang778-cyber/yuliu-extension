const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const evaluationRoot = path.resolve(__dirname, "..", "evaluation");
const datasetPath = path.join(evaluationRoot, "datasets", "core-context-v1.json");
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));

function normalizeText(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function blocksFromHtml(html) {
  const blocks = new Map();
  const pattern = /<(h[1-6]|p|li|blockquote|pre|td|figcaption)\b[^>]*data-block-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    assert.ok(!blocks.has(match[2]), `正文块编号重复：${match[2]}`);
    blocks.set(match[2], normalizeText(match[3]));
  }
  return blocks;
}

function occurrenceCount(text, exact) {
  if (!exact) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(exact, from);
    if (index < 0) break;
    count += 1;
    from = index + exact.length;
  }
  return count;
}

test("首批测试集包含8份完整内容和16个精确选区", () => {
  assert.equal(dataset.dataset_id, "yuliu-core-context-v1");
  assert.equal(dataset.documents.length, 8);
  assert.equal(dataset.documents.reduce((total, document) => total + document.cases.length, 0), 16);
});

test("文档、案例、正文块和选中位置均唯一且真实存在", () => {
  const documentIds = new Set();
  const caseIds = new Set();

  for (const document of dataset.documents) {
    assert.match(document.document_id, /^[a-z0-9-]+$/);
    assert.ok(!documentIds.has(document.document_id), `文档编号重复：${document.document_id}`);
    documentIds.add(document.document_id);

    const filePath = path.join(evaluationRoot, document.file);
    assert.ok(fs.existsSync(filePath), `缺少完整内容文件：${document.file}`);
    const blocks = blocksFromHtml(fs.readFileSync(filePath, "utf8"));
    assert.ok(blocks.size >= 5, `${document.document_id} 正文块过少，不能视为完整内容样本`);

    for (const item of document.cases) {
      assert.ok(!caseIds.has(item.case_id), `案例编号重复：${item.case_id}`);
      caseIds.add(item.case_id);
      const anchor = blocks.get(item.selection.anchor_block_id);
      assert.ok(anchor, `${item.case_id} 的选区正文块不存在`);
      const count = occurrenceCount(anchor, item.selection.exact);
      assert.ok(count > item.selection.occurrence_index, `${item.case_id} 的第 ${item.selection.occurrence_index + 1} 个选词不存在`);
    }
  }
});

test("每条证据引文都是对应正文块中的连续原文", () => {
  for (const document of dataset.documents) {
    const html = fs.readFileSync(path.join(evaluationRoot, document.file), "utf8");
    const blocks = blocksFromHtml(html);
    for (const item of document.cases) {
      assert.ok(item.evidence.length > 0, `${item.case_id} 缺少证据`);
      for (const evidence of item.evidence) {
        const block = blocks.get(evidence.block_id);
        assert.ok(block, `${item.case_id} 引用了不存在的正文块 ${evidence.block_id}`);
        assert.ok(block.includes(normalizeText(evidence.quote)), `${item.case_id} 的引文不是 ${evidence.block_id} 的连续原文：${evidence.quote}`);
      }
    }
  }
});

test("每条案例都包含可执行的语义金标准", () => {
  const validReferents = new Set(["generic_concept", "organization", "product", "person", "method", "metric", "document_defined_term", "other"]);
  const validSpecificity = new Set(["category", "named_entity", "exact_variant"]);
  const validCertainty = new Set(["clear", "inferred", "ambiguous", "insufficient"]);
  const validRoles = new Set(["direct_support", "coreference_support", "structural_support", "sense_disambiguation"]);

  for (const document of dataset.documents) {
    for (const item of document.cases) {
      const expected = item.expected;
      assert.ok(expected.sense.length >= 4, `${item.case_id} 缺少正确义项`);
      assert.ok(validReferents.has(expected.referent_type), `${item.case_id} 指称类型非法`);
      assert.ok(validSpecificity.has(expected.maximum_specificity), `${item.case_id} 具体程度非法`);
      assert.ok(validCertainty.has(expected.certainty), `${item.case_id} 确定性非法`);
      assert.equal(typeof expected.allow_inference, "boolean", `${item.case_id} 未说明是否允许推断`);
      assert.ok(expected.must_include_groups.length > 0, `${item.case_id} 缺少必须信息`);
      assert.ok(expected.must_include_groups.every((group) => group.length > 0), `${item.case_id} 的必须信息组为空`);
      assert.ok(Array.isArray(expected.must_not_include), `${item.case_id} 缺少禁止信息数组`);
      assert.ok(expected.reference_answer.length >= 8, `${item.case_id} 缺少参考解释`);
      assert.ok(item.evidence.every((evidence) => validRoles.has(evidence.role)), `${item.case_id} 存在非法证据角色`);
    }
  }
});

test("首批测试集确实包含核心风险类型", () => {
  const categories = new Set(dataset.documents.flatMap((document) => document.cases.map((item) => item.category)));
  for (const required of [
    "unjustified_specificity",
    "common_word_entity_disambiguation",
    "cross_domain_polysemy",
    "long_distance_definition",
    "mixed_language_technical_term",
    "genuine_ambiguity",
  ]) {
    assert.ok(categories.has(required), `未覆盖核心风险类型：${required}`);
  }
});

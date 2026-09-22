const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Contract = require("../grounding-contract-v2.js");

const root = path.resolve(__dirname, "..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "evaluation", "schema", "grounding-v2.schema.json"), "utf8"));
const examples = JSON.parse(fs.readFileSync(path.join(root, "evaluation", "fixtures", "grounding-v2-examples.json"), "utf8"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("第二版机器契约固定候选义项、来源、主张和确定性字段", () => {
  assert.equal(schema.properties.schema_version.const, "2.0");
  assert.deepEqual(new Set(schema.required), new Set([
    "schema_version", "selected_text", "candidate_senses", "resolution", "meaning_here",
    "author_intent", "claims", "page_evidence", "external_sources", "notice_code",
  ]));
  assert.deepEqual(new Set(Contract.constants.CLAIM_TYPES), new Set([
    "lexical_knowledge", "contextual_mapping", "author_intent", "high_risk_fact",
  ]));
  assert.deepEqual(new Set(Contract.constants.SOURCE_KINDS), new Set([
    "model_knowledge", "page_evidence", "external_source",
  ]));
});

test("Harness推断义项可以同时使用模型知识和页面辨义线索", () => {
  const checked = Contract.validate(examples.harness_inferred);
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(examples.harness_inferred.resolution.status, "inferred");
  assert.equal(examples.harness_inferred.notice_code, "none");
  assert.ok(examples.harness_inferred.claims.some((claim) => claim.claim_type === "lexical_knowledge"));
  assert.ok(examples.harness_inferred.claims.some((claim) => claim.claim_type === "contextual_mapping"));
  assert.ok(examples.harness_inferred.claims.some((claim) => claim.claim_type === "author_intent"));
});

test("FDE无法唯一辨义时仍可给出候选知识和有限说明", () => {
  const checked = Contract.validate(examples.fde_insufficient);
  assert.equal(checked.ok, true, checked.errors.join(", "));
  assert.equal(examples.fde_insufficient.resolution.selected_sense_id, null);
  assert.equal(examples.fde_insufficient.resolution.alternative_sense_ids.length, 2);
  assert.match(examples.fde_insufficient.meaning_here.text, /多种含义/);
});

test("当前语境映射不能只靠模型知识冒充页面判断", () => {
  const value = clone(examples.harness_inferred);
  const claim = value.claims.find((item) => item.claim_type === "contextual_mapping");
  claim.supports = [{ source_kind: "model_knowledge" }];
  const checked = Contract.validate(value);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes(`PAGE_SUPPORT_REQUIRED:${claim.claim_id}`));
});

test("高风险事实不能只靠未经核验的模型记忆", () => {
  const value = clone(examples.harness_inferred);
  value.claims.push({
    claim_id: "c4",
    claim_type: "high_risk_fact",
    text: "Harness 的唯一正式全称是某个具体名称",
    supports: [{ source_kind: "model_knowledge" }],
  });
  const checked = Contract.validate(value);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("VERIFIED_SUPPORT_REQUIRED:c4"));
});

test("正常推断不显示缺少语境警告", () => {
  const value = clone(examples.harness_inferred);
  value.notice_code = "insufficient_context";
  const checked = Contract.validate(value);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("NOTICE_FALSE_POSITIVE"));
});

test("歧义状态不能偷偷选择一个唯一义项", () => {
  const value = clone(examples.fde_insufficient);
  value.resolution.status = "ambiguous";
  value.resolution.selected_sense_id = "s1";
  value.notice_code = "multiple_senses";
  const checked = Contract.validate(value);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.includes("UNRESOLVED_WITH_SELECTED_SENSE"));
});

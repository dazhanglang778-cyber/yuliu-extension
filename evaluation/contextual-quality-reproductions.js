// Synthetic protocol controls. All model returns below are authored fixtures;
// run() executes the production pipeline locally and makes zero network requests.
const DefaultReasoning = require("../contextual-reasoning.js");
const Suite = require("./contextual-suite.js");
const protocolRelationFixture = require("./protocol-relation-fixture.js");

function statement(id, content, basis, blocks = [], extra = {}) {
  return { id, part: "meaning", basis, text: content, blocks, ...extra };
}
function bind(spec, evidence) {
  return { target_type: spec.type || "person", statements: spec.statements.map(({ blocks, spans, ...s }) => ({
    ...s, evidence_ids: (blocks || []).flatMap((block) => evidence.filter((e) => Number(e.block_id.slice(1)) === block).map((e) => e.evidence_id)),
  })) };
}
function judge(spec, draft, evidence, coverage = { status: "adequate", missing: [] }) {
  return { review_version: DefaultReasoning.REVIEW_VERSION, checks: draft.statements.map((s, i) => {
    const source = spec.statements[i], control = spec.checks?.[s.id] || {};
    const firstEvidence = evidence.find((e) => e.evidence_id === s.evidence_ids[0]);
    const firstSpan = firstEvidence && (source.spans?.[Number(firstEvidence.block_id.slice(1))]?.[0] || firstEvidence.quote);
    return { id: s.id, selection_fit: "current", supported: control.supported !== false && control.usefulness !== "restatement", basis: s.basis,
      relation_audit: firstEvidence ? protocolRelationFixture(firstSpan, firstEvidence.evidence_id) : null,
      usefulness: control.usefulness || (s.basis === "unknown" ? "unknown" : "useful"),
      evidence_ids: control.supported === false ? [] : s.evidence_ids,
      citations: control.supported === false || ["general", "unknown"].includes(s.basis) ? [] : s.evidence_ids.flatMap((id) => {
        const e = evidence.find((x) => x.evidence_id === id), block = Number(e.block_id.slice(1));
        return (source.spans?.[block] || [e.quote]).map((quote) => ({ evidence_id: id, quote }));
      }),
      reason: control.reason || "预设测试核验，只验证程序如何处理该判定",
    };
  }), coverage, allow_general_expansion: false };
}
const cases = [
  {
    id: "affiliation-with-clues", title: "所属方线索明确时，空泛回答应补写",
    selection: "说话人 7", anchor: 1,
    blocks: ["说话人 7 00:10 培训中心这边我们协调讲师资源，为社区课程提供支持。",
      "说话人 7 00:20 我们提供课程工具，也安排讲师答疑。"],
    first: { statements: [statement("c1", "说话人 7 是本次会议的参与者之一。", "document", [1])],
      checks: { c1: { usefulness: "restatement", reason: "仅说明参与，没有说明已有线索支持的所属方和工作" } } },
    missing: { detail: "结合自我归属与提供课程支持的线索，说明有限所属方推断及参与工作", blocks: [0, 1] },
    repaired: { statements: [
      statement("c1", "说话人 7 较可能代表培训中心参与课程合作。", "inference", [0, 1]),
      statement("c2", "其参与协调讲师资源、提供课程工具和安排答疑。", "document", [0, 1]),
      statement("c3", "这些片段尚不能确定其姓名和正式职务。", "unknown"),
    ] },
    expected: "给出有限所属方推断和具体工作；保持姓名、正式职务未知。",
  },
  {
    id: "affiliation-without-clues", title: "删去自我归属后，不沿用上一例的所属方",
    selection: "说话人 7", anchor: 1,
    blocks: ["说话人 7 00:10 培训中心需要协调讲师资源，为社区课程提供支持。",
      "说话人 7 00:20 方案中还包括课程工具和讲师答疑。"],
    first: { statements: [
      statement("c1", "这位发言者在讨论课程合作需要的讲师资源、工具和答疑安排。", "document", [0, 1]),
      statement("c2", "仅凭这段讨论不能确定其属于培训中心还是其他合作方。", "unknown"),
    ] },
    expected: "说明讨论作用，不能把提及培训中心认作自我归属。",
  },
  {
    id: "mentioned-person-attribution", title: "职责引用精确，别人的提问不归给被提及者",
    selection: "林老师", anchor: 0,
    blocks: ["说话人 1 00:10 自动化工具能否减少录入工作？我们先看方案。林老师负责课程验收。周老师负责接口联调。"],
    first: { statements: [
      statement("c1", "林老师在这份记录中负责课程验收。", "document", [0], { spans: { 0: ["林老师负责课程验收。"] } }),
      statement("c2", "林老师想通过自动化减少录入工作。", "inference", [0], { part: "intent" }),
    ], checks: { c2: { supported: false, reason: "自动化提问属于说话人 1，原文没有归给林老师" } } },
    expected: "保留课程验收职责，删除归错人的意图；只引用职责原句。",
  },
  {
    id: "project-missing-detail", title: "已有类别解释，但遗漏文内具体任务",
    selection: "北辰", anchor: 1,
    blocks: ["本文件把历史订单迁入新仓库的工作称为北辰。",
      "北辰本周只做样本核对，确认后再安排全量迁移。"],
    first: { type: "entity", statements: [statement("c1", "北辰是本文使用的内部工作代号。", "document", [0])] },
    missing: { detail: "解释代号对应的订单迁移，以及当前样本核对阶段", blocks: [0, 1] },
    repaired: { type: "entity", statements: [
      statement("c1", "北辰指将历史订单迁入新仓库的工作。", "document", [0]),
      statement("c2", "此处侧重本周的样本核对；确认后才进行全量迁移。", "document", [1]),
    ] },
    expected: "有用但不完整的首稿也能补齐关键任务，不只修完全拒答。",
  },
  {
    id: "dialogue-joint-support", title: "短答的对象和条件由多段共同支持",
    selection: "分开", anchor: 1,
    blocks: ["说话人 1 00:10 采集服务和展示服务必须一起部署吗？",
      "说话人 2 00:20 可以分开。",
      "说话人 1 00:25 换成另一套采集服务也可以吗？",
      "说话人 2 00:30 可以，但需要转换数据格式。"],
    first: { type: "reference", statements: [
      statement("c1", "这里指采集服务和展示服务可以分别部署。", "document", [0, 1]),
      statement("c2", "更换采集服务时仍需要转换数据格式。", "document", [2, 3]),
    ] },
    expected: "保留提问、回答和必要条件，不能只引用“可以分开”。",
  },
  {
    id: "repair-failure-keeps-partial", title: "补写服务失败时，可靠的首稿仍可使用",
    selection: "北辰", anchor: 1,
    blocks: ["北辰指历史订单迁入新仓库的工作。", "北辰本周只做样本核对，确认后再安排全量迁移。"],
    first: { type: "entity", statements: [statement("c1", "北辰指历史订单迁入新仓库的工作。", "document", [0])] },
    missing: { detail: "补充当前位置样本核对及后续迁移条件", blocks: [1] },
    repairFailure: "MOCK_REPAIR_SERVICE_UNAVAILABLE",
    expected: "保留迁移工作解释及其依据；在诊断中记录补写失败。",
  },
  {
    id: "genuine-unknown", title: "确实缺少身份线索时，停止追加猜测",
    selection: "说话人 9", anchor: 0,
    blocks: ["说话人 9 00:10 嗯，好。"],
    first: { statements: [statement("c1", "这段转写只记录了一句简短回应，无法据此判断其姓名、所属方或职责。", "unknown")] },
    insufficient: true,
    expected: "说明具体未知边界，不编造身份，也不再进行一次无意义补写。",
  },
  {
    id: "ordinary-term-knowledge", title: "普通概念不要求原文另写一遍定义",
    selection: "API", anchor: 0,
    blocks: ["服务通过外部 API 获取最新天气数据。"],
    first: { type: "term", statements: [
      statement("c1", "API 通常译为“应用程序编程接口”，可以让不同软件交换数据或调用功能。", "general"),
    ] },
    expected: "允许适合语境的常识解释；没有把原文当作术语定义引用。",
  },
  {
    id: "restatement-persists", title: "两稿都空泛时，不能宣称已经解释清楚",
    selection: "星桥", anchor: 1,
    blocks: ["星桥是把巡检结果汇总到报表的内部任务。", "本周继续执行星桥。"],
    first: { type: "entity", statements: [statement("c1", "星桥是文章中提到的一个任务。", "document", [1])],
      checks: { c1: { usefulness: "restatement", reason: "只复述任务标签，没有解释其内容" } } },
    missing: { detail: "说明巡检结果汇总到报表的任务", blocks: [0] },
    expected: "最多补写一次，仍失败则记录解释未完成，不把空泛回答标成clear。",
  },
];
async function runCase(item, Reasoning = DefaultReasoning) {
  const request = Suite.prepare(item), evidence = Reasoning.evidenceFor(request);
  let reviewCount = 0;
  const initial = bind(item.first, evidence);
  if (item.repairFailure) initial.statements.push({ ...initial.statements[0], id: "pending", text: "待补充的当前阶段。" });
  const model = async ({ messages }) => {
    if (!messages[0].content.includes("独立的语境主张核验器")) return JSON.stringify(initial);
    reviewCount++;
    if (item.repairFailure && reviewCount > 1) throw new Error(item.repairFailure);
    const checkedDraft = { ...initial, statements: initial.statements.filter((s) => s.id !== "pending") };
    const checked = judge(item.first, checkedDraft, evidence);
    if (item.repaired) {
      // One authored replacement can contain several sentences, without adding
      // unrequested statement IDs. This is a controller fixture, not model proof.
      const revised = bind(item.repaired, evidence), refs = [...new Set(revised.statements.flatMap((s) => s.evidence_ids))];
      checked.checks[0] = { id: initial.statements[0].id, selection_fit: "current", supported: true,
        basis: revised.statements.some((s) => s.basis === "inference") ? "inference" : "document",
        replacement: revised.statements.map((s) => s.text).join(""),
        citations: refs.map((id) => ({ evidence_id: id, quote: evidence.find((e) => e.evidence_id === id).quote })),
        reason: "人工预设的审阅修正：补充有依据的内容及未知边界" };
    }
    return JSON.stringify(checked);
  };
  const outcome = await Reasoning.run(request, model);
  return { id: item.id, title: item.title, selection: item.selection, source: item.blocks, expected: item.expected,
    mode: "scripted-model-local-pipeline", external_model_calls: 0, outcome };
}
async function run(Reasoning = DefaultReasoning) {
  const rows = [];
  for (const item of cases) rows.push(await runCase(item, Reasoning));
  return { mode: "scripted-model-local-pipeline", external_model_calls: 0,
    note: "原文与模型返回均为人工合成控制；实际执行正式程序。只证明工程行为，不是模型语义通过率。", rows };
}
module.exports = { cases, runCase, run };

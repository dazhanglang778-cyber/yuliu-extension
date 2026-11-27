(function attach(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuContextualAudit = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const list = (v) => Array.isArray(v) ? v : [];
  const compact = (v) => String(v || "").replace(/\s+/g, " ").trim();
  const parse = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch (_) { return null; } };
  const answer = (v) => [v?.meaning_here?.text || v?.meaning, v?.author_intent?.text || v?.intent].filter(Boolean).join("\n");
  function review(trace = {}, result = null, displayed = null) {
    const input = trace.input || {};
    const evidence = list(input.evidence || trace.evidence);
    const history = list(trace.history);
    const generation = trace.generation || history.filter((s) => s.stage === "generation" && s.parsed).at(-1)?.parsed || {};
    const verification = trace.verification || history.filter((s) => s.stage === "verification" && s.parsed).at(-1)?.parsed || {};
    const actual = answer(result), visible = answer(displayed);
    const sources = new Map([...evidence, ...list(result?.page_evidence)].map((e) => [e.evidence_id, e]));
    const claims = list(generation.statements).map((s) => {
      const check = list(verification.checks).find((c) => c.id === s.id);
      const rejected = list(trace.rejected).find((c) => c.id === s.id);
      const finalClaim = list(result?.claims).find((c) => c.claim_id === s.id);
      const kept = !!finalClaim || (!!s.text && compact(actual).includes(compact(s.text)));
      const protocolError = /FORMAT|JSON|VERIFICATION_ID|VERIFICATION_FIELDS|AUDIT_MISSING|USEFULNESS_REVIEW/.test(rejected?.code || "");
      const refs = finalClaim ? list(finalClaim.supports).map((r) => r.source_id).filter(Boolean)
        : check?.citations ? list(check.citations).map((c) => c.evidence_id) : list(check?.evidence_ids || s.evidence_ids);
      return { id: s.id, text: s.text, final_text: finalClaim?.text || (kept ? check?.replacement || s.text : null),
        revised: !!check?.replacement && kept, selection_fit: check?.selection_fit || null, part: s.part, basis: check?.basis || s.basis,
        status: protocolError ? "核验协议未完成（不等于内容错误）" : rejected || check?.supported === false ? "核验未通过" : kept ? "保留在最终回答" : result ? "未显示，需核对原因" : "尚无最终结果",
        reason: rejected?.reason || check?.reason || "", relation_audit: rejected?.relation_audit || finalClaim?.relation_audit || check?.relation_audit || null,
        evidence: refs.map((id) => sources.get(id) || { evidence_id: id, quote: "没有找到该依据的记录" }) };
    });
    const warnings = [];
    if (history.some((h) => list(h.parsed?.checks).some((c) => c.supported === true
      && (!compact(c.reason) || compact(c.reason) === "根据实际原文判断支持或不支持的原因")))) {
      warnings.push({ code: "UNINFORMATIVE_REVIEW_REASON", text: "核验理由为空或照抄示例占位句，不能据此确认实际检查了当前主张。此项仅提醒人工复核，不自动删除答案。" });
    }
    if (!trace.input) warnings.push({ code: "LEGACY_TRACE", text: "旧记录没有完整的输入快照，不能据此断言模型读到了哪些内容。" });
    const anchor = input.anchor;
    if (anchor && Number.isInteger(anchor.selected_start)) {
      const covered = evidence.some((e) => e.block_id === anchor.block_id && Number.isInteger(e.source_start)
        && e.source_start <= anchor.selected_start && e.source_start + String(e.quote || "").length >= anchor.selected_end);
      if (!covered) warnings.push({ code: "ANCHOR_NOT_COVERED", text: "模型实际收到的依据没有覆盖选中的这一次位置。检查定位与截取，不要直接归因于模型。" });
    }
    if (evidence.some((e) => String(e.quote || "").length > 400)) warnings.push({ code: "BROAD_EVIDENCE", text: "存在超过 400 字符的依据片段。它可能适合模型阅读，但不一定适合直接作为点击高亮范围。" });
    if (list(trace.rejected).some((c) => c.code === "LOW_INFORMATION")
      || history.some((h) => list(h.parsed?.checks).some((c) => c.usefulness === "restatement"))) {
      warnings.push({ code: "LOW_INFORMATION_REVIEW", text: "本次核验发现了仅复述标签的主张。请对照被删除内容、补写结果与原文，确认是否保留了有用解释。" });
    } else if (/参与者之一|发言的人员之一/.test(actual) && actual.length < 220) warnings.push({ code: "LOW_INFORMATION_REVIEW", text: "回答含宽泛的人物介绍，请人工核对是否遗漏原文可支持的归属或作用；此规则不自动判定答案错误。" });
    if (visible && actual && compact(visible) !== compact(actual)) warnings.push({ code: "DISPLAY_DIFF", text: "后台最终正文与前端记录的显示正文不同，请检查解析或展示。" });
    if (trace.review_mode === "review_and_revision") warnings.push({ code: "REVIEW_AND_REVISION", text: "本版由第二次模型调用审阅并修正文稿；修正文未再经过第三个模型独立复核。位置、引用检查通过不等于语义正确，仍需人工评测。" });
    if (trace.error) warnings.push({ code: "PIPELINE_ERROR", text: (trace.failure_category === "protocol"
      ? "核验格式或编号未完成，不代表原文不足或解释已被证伪：" : "链路错误：") + trace.error });
    if (JSON.stringify(trace).includes("[已截断]") || JSON.stringify(trace).includes("[内容过深")) warnings.push({ code: "PARTIAL_TRACE", text: "记录存在截断，不能进行精确重放。" });
    return { schema_version: 1, input, history, generation, verification, claims, actual, visible,
      answer_review: trace.answer_review || verification.coverage || null, selected_attempt: trace.selected_attempt || null, repair_error: trace.repair_error || null,
      final_result: result, warnings, elapsed_ms: trace.elapsed_ms ?? null,
      model_calls: trace.model_calls ?? history.length, stage_elapsed_ms: trace.stage_elapsed_ms || null, human_review_required: true,
      note: "这里只展示执行证据与机械检查，不自动证明语义正确，也不把核验模型的判断当作真值。" };
  }
  function fromSession(session) {
    const groups = new Map();
    for (const event of list(session.events)) {
      if (!event.requestId) continue;
      if (!groups.has(event.requestId)) groups.set(event.requestId, []);
      groups.get(event.requestId).push(event);
    }
    return [...groups].flatMap(([request_id, events]) => {
      const last = (type) => events.filter((e) => e.type === type).at(-1)?.data;
      const completed = last("contextual_completed");
      if (!completed && !last("contextual_input") && !last("contextual_draft")) return [];
      const trace = { ...(completed || {}) };
      trace.input ||= last("contextual_input");
      trace.history ||= events.filter((e) => e.type === "contextual_stage_completed").map((e) => e.data);
      trace.generation ||= parse(last("contextual_draft")?.rawOutput);
      trace.verification ||= parse(last("contextual_verified")?.rawOutput);
      trace.evidence ||= last("contextual_draft")?.evidence || [];
      const displayed = last("answer_displayed")?.rendered || last("answer_displayed")?.finalOutput || null;
      const result = completed?.result || displayed?.structuredResult || null;
      const r = review(trace, result, displayed);
      const navigation = events.filter((e) => e.type === "evidence_navigated").map((e) => e.data);
      if (navigation.some((n) => n.match === "element_fallback")) r.warnings.push({
        code: "HIGHLIGHT_FALLBACK", text: "点击依据时实际使用了整块元素高亮，而非精确句子；请核对定位失败原因。" });
      return [{ request_id, session_id: session.id, title: session.pageTitle, selected: session.selection, ...r, navigation }];
    });
  }
  function manualEvidence(input, raw) {
    const text = String(raw || "").trim();
    if (!text) throw new Error("请粘贴你认为相关的原文，不要粘贴期望答案。");
    const parts = text.split(/\n\s*\n/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    const anchor = input.anchor;
    const evidence = anchor?.excerpt ? [{ evidence_id: "manual-anchor", block_id: anchor.block_id,
      quote: anchor.excerpt, source_start: anchor.excerpt_start, source_offset: anchor.source_start,
      relation_to_selection: "anchor", role: "coreference_support" }] : [];
    if (parts.length + evidence.length > 20) throw new Error("对照最多 20 个片段（含当前位置）；请合并或减少原文段落。");
    if (parts.some((p) => p.length > 1500)) throw new Error("单个原文片段超过 1500 字符，请用空行分段；不会静默截断。");
    evidence.push(...parts.map((quote, i) => ({ evidence_id: "manual-" + (i + 1), block_id: "manual-block-" + (i + 1),
      quote, source_start: 0, role: "coreference_support", relation_to_selection: "manual_reference" })));
    validateEvidence(evidence);
    return evidence;
  }
  function validateEvidence(evidence) {
    if (!Array.isArray(evidence) || !evidence.length || evidence.length > 20) throw new Error("缺少完整的模型输入依据，不能重放。");
    const ids = new Set();
    for (const e of evidence) {
      if (!e || typeof e.evidence_id !== "string" || typeof e.block_id !== "string" || typeof e.quote !== "string"
        || !e.quote.trim() || e.quote.length > 1500 || ids.has(e.evidence_id)) throw new Error("依据格式不完整或超出限制，不能精确重放。");
      ids.add(e.evidence_id);
    }
    if (evidence.reduce((n, e) => n + e.quote.length, 0) > 17000) throw new Error("依据总量超过 17000 字符；请减少相关原文，不会静默截断。");
  }
  async function compare({ input, manual, model, reasoner, complete, progress = () => {}, executionMode = "unclassified" }) {
    if (!input || typeof input.selected !== "string" || !input.selected.trim() || input.selected.length > 160) throw new Error("记录缺少有效选区。");
    if (JSON.stringify(input).length > 120000 || /\[已截断\]|\[内容过深/.test(JSON.stringify(input))) throw new Error("输入记录不完整或过大，不能精确重放。");
    validateEvidence(input.evidence);
    const curated = manualEvidence(input, manual);
    const request = { selection: input.selected, documentContext: {
      page: { title: input.title }, selection: input.exact_selection,
      extraction: input.coverage, conversation: input.conversation,
    } };
    const arms = [];
    for (const [name, evidence] of [["plugin-context", input.evidence], ["manual-context", curated]]) {
      progress({ arm: name });
      const outcome = await reasoner.runPrepared(request, evidence, complete);
      outcome.trace.input = { ...input, evidence, candidates: name === "plugin-context" ? input.candidates : [] };
      arms.push({ name, ...outcome, review: review(outcome.trace, outcome.result) });
    }
    const models = arms.flatMap((a) => a.trace.history.map((c) => c.model).filter((m) => m && m !== "unreported"));
    return { schema_version: 1, mode: executionMode, generated_at: new Date().toISOString(),
      fixed_model: model, same_model_confirmed: models.length > 0 && arms.every((a) => !a.trace.error)
        && arms.every((a) => a.trace.history.every((c) => c.model === model && c.status === "completed")),
      original_input: input, arms, human_review_required: true,
      scope: "两组使用同一版本提示词、同一指定模型和同一核验流程，只更换相关原文。人工整理原文不等于已验证完整，更不是标准答案；重跑结果不等于历史那一次输出。" };
  }
  function markdown(reports, title = "语流 · 分层诊断报告") {
    const lines = ["# " + title, "", "这是执行记录与机械检查，不是语义正确性认证。", ""];
    for (const r of reports) {
      lines.push("## " + (r.selected || r.input?.selected || "选区"), "", "### 1. 选中的位置与实际输入", "",
        r.input?.anchor?.excerpt || "旧记录没有选区快照。", "",
        "读取范围：" + JSON.stringify(r.input?.coverage || {}), "",
        ...list(r.input?.evidence).map((e) => "- [" + e.evidence_id + "] " + (e.time || "") + " " + e.quote), "",
        "### 2. 模型初稿、核验与引用对应", "");
      for (const c of r.claims || []) lines.push("- 初稿：" + c.text + " — " + c.status + (c.reason ? "；" + c.reason : ""),
        ...(c.revised ? ["  - 修正后：" + c.final_text] : []),
        ...c.evidence.map((e) => "  - [" + e.evidence_id + "] " + e.quote));
      lines.push("", "### 3. 后台最终回答", "", r.actual || "未记录", "", "### 4. 前端显示记录", "", r.visible || "未记录（对照测试不经过网页卡片）", "",
        "### 机械检查与待核对项", "", ...(r.warnings?.length ? r.warnings.map((w) => "- " + w.code + "：" + w.text) : ["- 没有触发机械检查；仍需人工审阅。"]),
        "", "### 所有调用（含重试）", "");
      for (const h of r.history || []) lines.push("- " + h.stage + " · 第 " + h.attempt + " 次 · " + h.model + " · " + h.elapsed_ms + " ms",
        "", "原始输出：", "", h.raw_output || h.error || "未记录", "");
    }
    return lines.join("\n") + "\n";
  }
  return { review, fromSession, manualEvidence, validateEvidence, compare, markdown };
});

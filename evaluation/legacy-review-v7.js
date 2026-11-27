// Frozen V7 field-gating implementation, for historical diagnostic regression only.
// NEVER imported by the extension runtime. Passing these controls does not validate V8.
// Kept so the real subject-string false-rejection can be reproduced side by side.
const text = (v, max = 1200) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
const bases = new Set(["document", "inference", "general", "unknown", "conflicting"]);
function parse(raw) {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch (_) { return null; }
}
  function auditRelation(check, statement, citations) {
    const audit = check.relation_audit;
    const fail = (code, reason) => ({ code, reason });
    const scopes = new Set(["individual", "collective", "non_person", "unspecified"]);
    const qualifiers = new Set(["planned", "required", "possible", "conditional", "negated", "reported"]);
    const frameValid = (frame) => frame && typeof frame.subject === "string" && frame.subject.trim()
      && frame.subject.length <= 160 && scopes.has(frame.scope) && Array.isArray(frame.qualifiers)
      && frame.qualifiers.length <= 6 && frame.qualifiers.every((q) => qualifiers.has(q))
      && new Set(frame.qualifiers).size === frame.qualifiers.length;
    if (!audit || !frameValid(audit.source) || !frameValid(audit.claim)
      || !["explicit", "resolved", "inferred", "unsupported"].includes(audit.subject_link)
      || !["conditions", "time", "attribution"].every((k) => typeof audit.preserves?.[k] === "boolean")) {
      return fail("RELATION_AUDIT_MISSING", "缺少完整的主体、范围和事实状态核对，不能仅凭supported放行");
    }
    if (audit.subject_link === "unsupported") return fail("RELATION_SUBJECT_UNSUPPORTED", "原文主体与答案主体没有得到支持的对应关系");
    if (audit.subject_link === "inferred" && (statement.basis !== "inference" || check.basis !== "inference")) {
      return fail("RELATION_INFERENCE_AS_FACT", "主体关系来自推断，答案与核验须共同标为inference并以有限措辞表达；不能只改标签保留无依据身份或个人职责");
    }
    const ids = audit.source.subject_evidence_ids;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
      || !ids.every((id) => citations.some((c) => c.evidence_id === id))
      || !ids.some((id) => citations.some((c) => c.evidence_id === id && c.quote.includes(audit.source.subject.trim())))) {
      return fail("RELATION_SUBJECT_CITATION", "最终引用没有包含证明原文主体的片段；短答需要联合提问或前文");
    }
    if (audit.source.scope === "collective" && audit.claim.scope === "individual"
      && !(statement.basis === "inference" && audit.subject_link === "inferred")) {
      return fail("RELATION_SCOPE_NARROWED", "群体行为被缩成个人职责，需保留团队范围或有依据的有限参与推断");
    }
    const src = new Set(audit.source.qualifiers), dst = new Set(audit.claim.qualifiers);
    if ([...src].some((q) => !dst.has(q))
      || [...dst].some((q) => !src.has(q) && !(q === "possible" && statement.basis === "inference"))) {
      return fail("RELATION_QUALIFIER_CHANGED", "答案改变了计划、需求、可能性、条件、否定或转述状态");
    }
    for (const key of ["conditions", "time", "attribution"]) if (!audit.preserves[key]) {
      return fail("RELATION_" + key.toUpperCase() + "_CHANGED", "答案未保留原文的" + { conditions: "条件适用范围", time: "时间范围", attribution: "观点/转述归属" }[key]);
    }
    return null;
  }
  function checkedCitations(check, refs, known) {
    const citations = [], seen = new Set();
    for (const c of Array.isArray(check.citations) ? check.citations : []) {
      const source = known.get(c?.evidence_id), quote = typeof c?.quote === "string" ? c.quote.trim() : "";
      if (!refs.includes(c?.evidence_id) || !source || !quote || quote.length > 600) return null;
      let start = c.quote_start;
      if (start == null) {
        start = source.quote.indexOf(quote);
        if (start !== source.quote.lastIndexOf(quote)) return null;
      }
      if (!Number.isInteger(start) || start < 0 || source.quote.slice(start, start + quote.length) !== quote) return null;
      const key = JSON.stringify([c.evidence_id, start, quote.length]);
      if (!seen.has(key)) citations.push({ evidence_id: c.evidence_id, quote, start, end: start + quote.length });
      seen.add(key);
    }
    return refs.length && refs.every((id) => citations.some((c) => c.evidence_id === id))
      ? citations.sort((a, b) => refs.indexOf(a.evidence_id) - refs.indexOf(b.evidence_id) || a.start - b.start) : null;
  }
  function accept(draft, raw, evidence) {
    const verdict = parse(raw), checks = Array.isArray(verdict?.checks) ? verdict.checks : [];
    const known = new Map(evidence.map((e) => [e.evidence_id, e]));
    const accepted = [], rejected = [], formatErrors = [];
    if (checks.some((c) => !draft.statements.some((s) => s.id === c?.id))) formatErrors.push("VERIFICATION_ID_MISMATCH");
    const coverage = { status: verdict?.coverage?.status, missing: [] };
    if (!["adequate", "missing_supported_detail", "insufficient"].includes(coverage.status)) formatErrors.push("MISSING_COVERAGE_REVIEW");
    for (const m of Array.isArray(verdict?.coverage?.missing) ? verdict.coverage.missing.slice(0, 4) : []) {
      const detail = text(m?.detail, 200), refs = [...new Set(Array.isArray(m?.evidence_ids) ? m.evidence_ids : [])];
      if (detail && refs.length && refs.every((id) => known.has(id))) coverage.missing.push({ detail, evidence_ids: refs });
      else formatErrors.push("INVALID_MISSING_DETAIL");
    }
    if (coverage.status === "missing_supported_detail" && !coverage.missing.length) formatErrors.push("MISSING_DETAIL_WITHOUT_EVIDENCE");
    for (const s of draft.statements) {
      const matches = checks.filter((c) => c.id === s.id), check = matches.length === 1 ? matches[0] : null;
      const refs = [...new Set(Array.isArray(check?.evidence_ids) ? check.evidence_ids : [])];
      let valid = check?.supported === true && bases.has(check.basis)
        && refs.every((id) => known.has(id) && s.evidence_ids.includes(id));
      let code = "UNSUPPORTED_CLAIM", reason = text(check?.reason || "未完成独立证据核验", 240);
      if (!check) {
        code = "VERIFICATION_ID_MISMATCH"; reason = "当前主张没有唯一对应的核验编号，不代表原文不支持";
        formatErrors.push(code);
      } else if (typeof check.supported !== "boolean" || !bases.has(check.basis) || !Array.isArray(check.evidence_ids)) {
        valid = false; code = "INVALID_VERIFICATION_FIELDS"; reason = "核验字段类型或来源分类不符合协议";
        formatErrors.push(code);
      }
      if (check?.basis === "general" && s.basis !== "general") valid = false;
      if (check?.basis === "general" && draft.target_type !== "term") valid = false;
      if (check?.basis === "document" && s.basis === "inference") {
        valid = false; code = "RELATION_INFERENCE_AS_FACT";
        reason = "答案已声明推断，核验不得将其升级为明确事实；重新核对线索与有限措辞，并保持双方basis一致";
      }
      if (check?.basis === "unknown" && s.basis !== "unknown") valid = false;
      if (s.basis === "unknown" && check?.basis !== "unknown") valid = false;
      if (s.part === "intent" && ["general", "unknown"].includes(check?.basis)) valid = false;
      if (!["general", "unknown"].includes(check?.basis) && !refs.length) valid = false;
      if (check?.basis === "conflicting" && refs.length < 2) valid = false;
      if (check?.supported === true && !["useful", "restatement", "unknown"].includes(check.usefulness)) {
        valid = false; code = "MISSING_USEFULNESS_REVIEW"; reason = "尚未判断这项解释是否增加有用信息";
        formatErrors.push(code);
      } else if (check?.usefulness === "restatement") {
        valid = false; code = "LOW_INFORMATION";
      } else if (check?.supported === true && (check.basis === "unknown") !== (check.usefulness === "unknown")) {
        valid = false; code = "INVALID_USEFULNESS_REVIEW";
      }
      let citations = [];
      if (valid && !["general", "unknown"].includes(check.basis)) {
        citations = checkedCitations(check, refs, known);
        if (!citations) { valid = false; code = "INVALID_SUPPORT_CITATION"; reason = "支持引文缺失、范围不明确或未对应原文，请重新绑定具体原句"; }
        if (valid) {
          const problem = auditRelation(check, s, citations);
          if (problem) {
            valid = false; code = problem.code; reason = problem.reason;
            if (code === "RELATION_AUDIT_MISSING") formatErrors.push(code);
          }
        }
      }
      if (valid) accepted.push({ ...s, basis: check.basis, evidence_ids: ["general", "unknown"].includes(check.basis) ? [] : refs,
        citations, usefulness: check.usefulness, verification_reason: reason, relation_audit: check.relation_audit || null });
      else rejected.push({ id: s.id, code, reason, relation_audit: check?.relation_audit || null });
    }
    return { accepted, rejected, coverage, format_errors: [...new Set(formatErrors)],
      repair_required: rejected.some((s) => s.code.startsWith("RELATION_") && s.code !== "RELATION_AUDIT_MISSING"),
      allow_general: verdict?.allow_general_expansion === true && draft.target_type === "term" };
  }

module.exports = { accept, auditRelation };

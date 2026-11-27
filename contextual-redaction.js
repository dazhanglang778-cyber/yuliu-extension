(function attach(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuContextualRedaction = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const kinds = new Set(["人物", "机构", "公司", "学校", "研究院", "学院", "项目", "地点", "敏感片段"]);
  const str = (value) => typeof value === "string" ? value : "";
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Explicit groups only: never infer identities, affiliations or aliases for the user.
  function parseRules(raw = "") {
    if (str(raw).length > 20000) throw new Error("替换清单过长，请减少本次对照内容。");
    const seen = new Set();
    const lines = str(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 200) throw new Error("每次最多 200 组替换规则。");
    return lines.map((line, index) => {
      const match = line.match(/^([^:：]+)[:：](.+)$/);
      if (!match || !kinds.has(match[1].trim())) throw new Error(`第 ${index + 1} 行请使用“人物：原名 | 别称”等格式，类别须为页面列出的类型。`);
      const aliases = match[2].split(/[|｜]/).map((s) => s.trim());
      if (aliases.some((s) => s.length < 2 || s.length > 2000)) throw new Error(`第 ${index + 1} 行的每个原词需为 2—2000 个字符。`);
      for (const alias of aliases) {
        const key = alias.toLocaleLowerCase();
        if (seen.has(key)) throw new Error(`第 ${index + 1} 行有重复原词；同一实体的别称请写在同一行。`);
        seen.add(key);
      }
      return { kind: match[1].trim(), aliases, key: "rule-" + index };
    });
  }

  // Export an allowlist, not a recursive copy of a diagnostic record. In particular,
  // raw prompts, answers, URLs, DOM ids, fingerprints and source offsets are excluded.
  function minimalInput(input, arm) {
    if (!input || !str(input.selected).trim() || !Array.isArray(input.evidence) || !input.evidence.length) throw new Error("请先生成完整的本地两组输入。");
    if (input.evidence.length > 20) throw new Error("单组依据超过 20 个，请减少本次对照内容。");
    const relations = new Set(["anchor", "manual_reference", "same_speaker", "previous_turn", "next_turn", "same_term"]);
    const coverage = ["complete", "loaded_content_only", "unknown"].includes(input.coverage?.coverage) ? input.coverage.coverage : "unknown";
    const value = {
      selected: str(input.selected), title: str(input.title), coverage: { coverage },
      anchor: input.anchor ? { excerpt: str(input.anchor.excerpt) } : null,
      conversation: input.conversation ? {
        selected_speaker: str(input.conversation.selected_speaker),
        anchor_time: /^\d{1,3}:\d{2}(?::\d{2})?$/.test(str(input.conversation.anchor_time)) ? input.conversation.anchor_time : "",
      } : null,
      evidence: input.evidence.map((e, i) => {
        if (!str(e?.quote).trim()) throw new Error("依据有空片段，请重新准备。");
        return { evidence_id: arm + "-e" + (i + 1), quote: e.quote,
          speaker: str(e.speaker), time: /^\d{1,3}:\d{2}(?::\d{2})?$/.test(str(e.time)) ? e.time : "",
          relation_to_selection: relations.has(e.relation_to_selection) ? e.relation_to_selection : "reference" };
      }),
    };
    if (JSON.stringify(value).length > 60000) throw new Error("单组输入过大，请减少本次对照内容；不会静默截断。");
    return value;
  }

  const patterns = [
    ["链接", /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'，。；！？）】》]+/gi],
    ["邮箱", /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi],
    ["凭据", /\bBearer\s+[a-z0-9._~+\/-]+=*/gi],
    ["凭据", /(?:api[_ -]?key|access[_ -]?token|secret|password|密码|密钥)\s*["']?\s*[:=：]\s*["']?[^\s"'，。；,;}]+/gi],
    ["手机号", /(?<![\w])(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?!\d)/g],
    ["电话", /(?<![\w])0\d{2,3}[- ]\d{7,8}(?:[- ]\d{1,6})?(?!\d)/g],
    ["证件号", /(?<![\w])\d{17}[\dXx](?![\w])/g],
    ["IP地址", /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w.])/g],
  ];
  function prepare(prepared, rawRules = "") {
    const rules = parseRules(rawRules);
    const clean = { input_a: minimalInput(prepared?.input_a, "a"), input_b: minimalInput(prepared?.input_b, "b") };
    const corpus = JSON.stringify(clean), mappings = new Map(), counts = new Map();
    function token(key, kind, original) {
      if (!mappings.has(key)) {
        let index = counts.get(kind) || 0, replacement;
        do { replacement = `〔脱敏${kind}${++index}〕`; } while (corpus.includes(replacement));
        counts.set(kind, index);
        mappings.set(key, { kind, replacement, originals: new Set(), occurrences: 0 });
      }
      const item = mappings.get(key); item.originals.add(original); item.occurrences++;
      return item.replacement;
    }
    const missedRules = new Set(rules.map((r) => r.key));
    function redact(text) {
      const spans = [];
      for (const [kind, pattern] of patterns) {
        for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) spans.push({ start: m.index, end: m.index + m[0].length, kind, original: m[0], key: "auto-" + kind + "-" + m[0].toLowerCase() });
      }
      for (const rule of rules) for (const alias of rule.aliases) {
        // Latin names must not replace parts of words (e.g. Ann in Planning).
        const left = /^[a-z0-9_]/i.test(alias) ? "(?<![a-z0-9_])" : "";
        const right = /[a-z0-9_]$/i.test(alias) ? "(?![a-z0-9_])" : "";
        for (const m of text.matchAll(new RegExp(left + escape(alias) + right, "gi"))) spans.push({ start: m.index, end: m.index + m[0].length, kind: rule.kind, original: m[0], key: rule.key });
      }
      spans.sort((a, b) => a.start - b.start || b.end - a.end);
      let end = 0, output = "";
      for (const span of spans) {
        if (span.start < end) continue;
        output += text.slice(end, span.start) + token(span.key, span.kind, span.original);
        missedRules.delete(span.key); end = span.end;
      }
      return output + text.slice(end);
    }
    function redactInput(input) {
      return { ...input, selected: redact(input.selected), title: redact(input.title),
        anchor: input.anchor ? { excerpt: redact(input.anchor.excerpt) } : null,
        conversation: input.conversation ? { ...input.conversation, selected_speaker: redact(input.conversation.selected_speaker) } : null,
        evidence: input.evidence.map((e) => ({ ...e, quote: redact(e.quote), speaker: redact(e.speaker) })) };
    }
    // A single replacement map across both arms; replacements are never re-scanned.
    // Only free-text fields are replaced, not generated ids or structural enum values.
    const payload = {
      schema_version: 1, mode: "local-redacted-preparation-only", model_runs: 0,
      external_transmission_allowed: false,
      privacy: { method: "local-pseudonymization", human_reviewed_for_local_export: false,
        mapping_exported: false, position_mode: "semantic_only",
        warning: "代称化不等于完全匿名。业务细节和组合线索仍可能识别身份。原始位置已移除，不能用此副本验收原网页定位或高亮。" },
      input_a: redactInput(clean.input_a), input_b: redactInput(clean.input_b),
    };
    const warnings = ["请检查遗漏的人名、机构、项目、地址及独特业务细节；自动规则不能保证完全匿名。",
      "请检查替换是否误删角色、否定、条件或指代线索；这些变化可能影响语义对照结果。"];
    if (missedRules.size) warnings.push(`${missedRules.size} 组规则没有独立命中（可能原文未出现或被更长规则覆盖），请核对别称与片段。`);
    return { payload, warnings, mapping: [...mappings.values()].map((m) => ({ ...m, originals: [...m.originals] })) };
  }

  function suggestSpeakers(prepared) {
    const names = new Set();
    const add = (v) => {
      const name = str(v).trim();
      if (name.length >= 2 && name.length <= 30 && !/说话人|讲话人|发言者|speaker|主持人|参会者|人物|[:：|｜\n\d]/i.test(name)) names.add(name);
    };
    for (const input of [prepared?.input_a, prepared?.input_b]) {
      add(input?.conversation?.selected_speaker);
      for (const e of input?.evidence || []) {
        add(e.speaker);
        for (const m of str(e.quote).matchAll(/(?:^|\n)\s*([\p{L}·. ]{2,30}?)\s+\d{1,3}:\d{2}(?::\d{2})?\s/gu)) add(m[1]);
      }
    }
    return [...names].map((name) => "人物：" + name).join("\n");
  }

  function createSession() {
    let preview = null, reviewed = false;
    const invalidate = () => { preview = null; reviewed = false; };
    return {
      invalidate,
      prepare(input, rules) { invalidate(); preview = prepare(input, rules); return structuredClone(preview); },
      review(value) { reviewed = value === true && preview !== null; return reviewed; },
      exportData() {
        if (!preview || !reviewed) throw new Error("请生成并核对当前脱敏预览，再确认保存；这不代表同意外发。");
        const data = structuredClone(preview.payload);
        data.privacy.human_reviewed_for_local_export = true;
        return data;
      },
    };
  }
  return { parseRules, prepare, suggestSpeakers, createSession };
});

(function attachContextExplainerParser(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ContextExplainerParser = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createParser() {
  const patterns = {
    meaning: /(?:这里指什么|meaning_here)\s*[：:]/gi,
    intent: /(?:作者想表达什么|author_intent)\s*[：:]/gi,
    naturalIntent: /作者\s*(?:(?:想表达|想说)\s*的|的意思|意在)\s*(?:是|在于)?\s*[：:，,]?/g,
    certainty: /(?:判断|certainty)\s*[：:]/gi,
    note: /(?:提示|note)\s*[：:]/gi,
    general: /(?:通用定义|专业定义|一般来说)\s*[：:]/g,
    example: /举个例子\s*[：:]/g,
    simple: /一句话解释\s*[：:]/g,
  };

  function find(pattern, text, from = 0) {
    const regex = new RegExp(pattern.source, pattern.flags);
    regex.lastIndex = from;
    const match = regex.exec(text);
    return match ? { index: match.index, end: match.index + match[0].length, text: match[0] } : null;
  }

  function earliest(text, from, candidates) {
    return candidates
      .map((pattern) => find(pattern, text, from))
      .filter(Boolean)
      .sort((a, b) => a.index - b.index)[0] || null;
  }

  function sliceAfter(text, startMarker, endPatterns) {
    const start = startMarker?.end || 0;
    const end = earliest(text, start, endPatterns);
    return text.slice(start, end?.index ?? text.length).trim();
  }

  function cleanVisible(text) {
    return String(text || "")
      .replace(/\s*(?:判断|certainty|提示|note)\s*[：:].*$/gis, "")
      // 免费模型偶尔会模仿提示词的栏目括号，甚至输出成反向的“】正文【”。
      // 这里只清理字段最外沿的全角包装符，不碰正文中的括号或引用角标。
      .replace(/^[【】]+\s*/g, "")
      .replace(/\s*[【】]+$/g, "")
      .replace(/^[-—\s]+|[-—\s]+$/g, "")
      .trim();
  }

  function normalizeCertainty(value) {
    const match = String(value || "").toLocaleLowerCase().match(/\b(clear|inferred|ambiguous|insufficient|unrecognized)\b/);
    return match?.[1] || "";
  }

  function cleanOptionalNote(value) {
    const text = cleanVisible(value);
    return /^(?:无|暂无|没有|none|null|n\/?a|clear|not[_ -]?applicable)[。.!！]?$/i.test(text)
      ? ""
      : text;
  }

  function tryJson(raw) {
    try {
      const cleaned = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      if (!cleaned.startsWith("{") || !cleaned.endsWith("}")) return null;
      return JSON.parse(cleaned);
    } catch (_) {
      return null;
    }
  }

  function parseInitial(raw) {
    const text = String(raw || "");
    const json = tryJson(text);
    if (json?.schema_version === "2.0") {
      const senses = Array.isArray(json.candidate_senses) ? json.candidate_senses : [];
      const selectedSenseId = json.resolution?.selected_sense_id;
      const selectedSense = senses.find((item) => item?.sense_id === selectedSenseId) || null;
      return {
        structured: true,
        schemaVersion: "2.0",
        selectedText: cleanVisible(json.selected_text),
        resolvedSense: selectedSense ? {
          label: cleanVisible(selectedSense.label),
          referent_type: selectedSense.referent_type || "other",
          specificity: json.resolution?.specificity || "category",
        } : null,
        meaning: cleanVisible(json.meaning_here?.text),
        intent: cleanVisible(json.author_intent?.text),
        certainty: normalizeCertainty(json.resolution?.status),
        note: "",
        noticeCode: cleanVisible(json.notice_code),
        claims: Array.isArray(json.claims) ? json.claims : [],
        evidence: Array.isArray(json.page_evidence) ? json.page_evidence : [],
        externalSources: Array.isArray(json.external_sources) ? json.external_sources : [],
      };
    }
    if (json) return {
      structured: !!json.selected_text && !!json.resolved_sense,
      selectedText: cleanVisible(json.selected_text),
      resolvedSense: json.resolved_sense || null,
      meaning: cleanVisible(json.meaning_here),
      intent: cleanVisible(json.author_intent),
      certainty: normalizeCertainty(json.certainty),
      note: cleanOptionalNote(json.note),
      noticeCode: cleanVisible(json.notice_code),
      claims: Array.isArray(json.claims) ? json.claims : [],
      evidence: Array.isArray(json.evidence) ? json.evidence : [],
    };

    const meaningMarker = find(patterns.meaning, text);
    const intentMarker = earliest(text, meaningMarker?.end || 0, [patterns.intent, patterns.naturalIntent]);
    const certaintyMarker = find(patterns.certainty, text, meaningMarker?.end || 0);
    const noteMarker = find(patterns.note, text, meaningMarker?.end || 0);
    const meaningEndPatterns = [patterns.intent, patterns.naturalIntent, patterns.certainty, patterns.note];
    const intentEndPatterns = [patterns.certainty, patterns.note];

    const meaning = cleanVisible(sliceAfter(text, meaningMarker, meaningEndPatterns));
    const intent = intentMarker
      ? cleanVisible(sliceAfter(text, intentMarker, intentEndPatterns))
      : "";
    const certainty = certaintyMarker
      ? normalizeCertainty(sliceAfter(text, certaintyMarker, [patterns.note, patterns.intent]))
      : "";
    const note = noteMarker ? cleanOptionalNote(sliceAfter(text, noteMarker, [])) : "";
    return { structured: false, selectedText: "", resolvedSense: null, meaning, intent, certainty, note, noticeCode: "", claims: [], evidence: [] };
  }

  function parseExpanded(raw) {
    const text = String(raw || "");
    const generalMarker = find(patterns.general, text);
    const exampleMarker = find(patterns.example, text, generalMarker?.end || 0);
    return {
      general: cleanVisible(sliceAfter(text, generalMarker, [patterns.example])),
      example: exampleMarker ? cleanVisible(sliceAfter(text, exampleMarker, [])) : "",
    };
  }

  function parseSimple(raw) {
    const text = String(raw || "");
    const marker = find(patterns.simple, text);
    return cleanVisible(marker ? text.slice(marker.end) : (text.length > 8 ? text : ""));
  }

  function isPlainSimple(raw) {
    const text = parseSimple(raw);
    if (text.length < 10 || text.length > 82) return false;
    if (!/(?:就是|说白了|简单说|相当于|可以理解为)/.test(text)) return false;
    const sentenceEnds = (text.match(/[。！？!?]/g) || []).length;
    if (sentenceEnds > 1) return false;
    return !/(?:通常译为.{0,18}指|用于.{0,24}从而.{0,24}(?:优化|提升)|预设指标或自身表现|调整本轮的数据类型)/.test(text);
  }

  function generalHasContextLeak(general, selectedTerm = "") {
    const selected = String(selectedTerm || "");
    return ["本文", "文中", "文章", "作者", "上下文", "在这里", "这里指"]
      .some((word) => !selected.includes(word) && String(general || "").includes(word));
  }

  function generalStartsWithSelection(general, selectedTerm) {
    const text = cleanVisible(general).replace(/^[“”'‘’`\s]+/, "").toLocaleLowerCase();
    const term = String(selectedTerm || "").trim().toLocaleLowerCase();
    return !!term && text.startsWith(term);
  }

  function hasCircularTranslation(general) {
    const firstSentence = String(general || "").split(/[。！？!?\n]/)[0];
    const match = firstSentence.match(/^\s*([^（(，,：:]{2,30}?)\s*(?:通常)?译为\s*[“'‘]?([^”'’。，,]{2,30})/i);
    if (!match) return false;
    const normalize = (value) => String(value || "").replace(/[\s“”'‘’]/g, "").toLocaleLowerCase();
    return normalize(match[1]) === normalize(match[2]);
  }

  function formatGeneralParagraphs(general) {
    const text = cleanVisible(general).replace(/\r\n?/g, "\n");
    const existingParagraphs = text.split(/\n\s*\n|\n/).map((part) => part.trim()).filter(Boolean);
    // 模型已经按知识角度分段时保留其段内补充句；只有挤成一整块时才按句拆开。
    if (existingParagraphs.length >= 2) return existingParagraphs.join("\n");
    const sentences = text
      .replace(/([。！？!?](?:\[\d+\])*)\s*/g, "$1\n")
      .split(/\n+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return sentences.length > 1 ? sentences.join("\n") : text;
  }

  function generalHasExample(general) {
    return /(?:例如|比如|举例(?:来说)?|以[^。！？!?\n]{1,24}为例|for example|e\.g\.)/i
      .test(String(general || ""));
  }

  function generalHasCaseLeak(general, selectedTerm = "", identity = {}) {
    const text = String(general || "");
    if (generalHasExample(text)) return true;
    const protectedNames = [selectedTerm, identity.chineseName, identity.englishFullName]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const paragraphs = text.split(/\n\s*\n|\n/).map((part) => part.trim()).filter(Boolean);
    const laterText = paragraphs.slice(1).join("\n");
    let inspectable = laterText;
    for (const name of protectedNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      inspectable = inspectable.replace(new RegExp(escaped, "gi"), "");
    }
    if (/(?:具体|现实|实际|代表性?)(?:公司|企业|产品|项目|平台|案例|应用)/.test(inspectable)) return true;
    if (/(?:公司|企业|产品|项目|平台).{0,24}(?:采用|使用|部署|推出|发布|开发|应用)/.test(inspectable)) return true;
    const namedEntity = /\b[A-Z][A-Za-z0-9.-]{2,}\b/g;
    for (const paragraph of inspectable.split(/\n+/)) {
      const names = paragraph.match(namedEntity) || [];
      if (names.length && /^(?:此外|另外|另有|还有|代表性?的?)[，,:：\s]*/.test(paragraph)) return true;
      if (names.length && /(?:公司|企业|产品|项目|平台|框架).{0,20}(?:采用|使用|部署|推出|发布|开发|提供|展示|作为|应用于)/.test(paragraph)) return true;
      if (names.length && /(?:采用|使用|部署|推出|发布|开发|提供|展示|作为|应用于).{0,20}(?:公司|企业|产品|项目|平台|框架)/.test(paragraph)) return true;
    }
    return false;
  }

  function generalWithinLimit(general, limit = 300) {
    const visible = cleanVisible(general).replace(/\s+/g, "");
    return visible.length >= 50 && visible.length <= limit;
  }

  function generalHasValidPointCount(general, minimum = 2, maximum = 5) {
    const points = cleanVisible(general)
      .split(/\n\s*\n|\n/)
      .map((point) => point.trim())
      .filter(Boolean);
    return points.length >= minimum && points.length <= maximum;
  }

  function generalHasRepeatedPoints(general) {
    const points = cleanVisible(general)
      .split(/\n\s*\n|\n/)
      .map((point) => point.replace(/\[\d+\]/g, "").replace(/[\s，。！？!?；;：:（）()“”'‘’]/g, ""))
      .filter((point) => point.length >= 10);
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        const shorter = points[left].length <= points[right].length ? points[left] : points[right];
        const longer = shorter === points[left] ? points[right] : points[left];
        if (longer.includes(shorter)) return true;
        const chunks = new Set();
        for (let index = 0; index <= shorter.length - 5; index += 1) chunks.add(shorter.slice(index, index + 5));
        if (!chunks.size) continue;
        let overlap = 0;
        for (const chunk of chunks) if (longer.includes(chunk)) overlap += 1;
        if (overlap / chunks.size >= 0.82) return true;
      }
    }
    return false;
  }

  function hasInvalidEnglishGloss(general) {
    const text = String(general || "");
    if (/中文叫/i.test(text)) return true;
    const cue = /(?:中文(?:通常)?(?:意为|译为)|通常译为|可译为)/gi;
    let match;
    while ((match = cue.exec(text))) {
      const tail = text.slice(match.index + match[0].length);
      if (!/^[：:\s]*“[^”]{1,60}”/.test(tail)) return true;
    }
    return false;
  }

  function englishIdentityMatches(text, selectedTerm, identity = {}) {
    if (!/[A-Za-z]/.test(String(selectedTerm || ""))) return true;
    const content = String(text || "").toLocaleLowerCase();
    const fullName = String(identity.englishFullName || "").trim().toLocaleLowerCase();
    const chineseName = String(identity.chineseName || "").trim().toLocaleLowerCase();
    const properName = /(?:专有名称|产品|人物|公司|品牌|型号|代码|模型)/.test(String(identity.conceptType || ""));
    if (fullName && !content.includes(fullName)) return false;
    if (chineseName && !properName && !content.includes(chineseName)) return false;
    return true;
  }

  return {
    parseInitial,
    parseExpanded,
    parseSimple,
    isPlainSimple,
    normalizeCertainty,
    cleanOptionalNote,
    generalHasContextLeak,
    generalStartsWithSelection,
    hasCircularTranslation,
    formatGeneralParagraphs,
    generalHasExample,
    generalHasCaseLeak,
    generalWithinLimit,
    generalHasValidPointCount,
    generalHasRepeatedPoints,
    hasInvalidEnglishGloss,
    englishIdentityMatches,
  };
});

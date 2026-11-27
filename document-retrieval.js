(function attachYuliuDocumentRetrieval(root, factory) {
  const api = factory(root.YuliuDocumentContext);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuDocumentRetrieval = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createYuliuDocumentRetrieval(DocumentContext) {
  const normalizeText = DocumentContext?.normalizeText || ((value) => String(value || "").replace(/\s+/g, " ").trim());
  const DEFAULT_LIMIT = 12;
  const MAX_PROMPT_CHARACTERS = 9000;
  const STOP_WORDS = new Set([
    "的", "了", "和", "与", "或", "在", "是", "为", "把", "被", "这", "那", "一个", "一种", "以及", "通过", "进行", "可以", "需要", "用于",
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "be", "this", "that", "it",
  ]);

  function normalizeForMatch(value) {
    return normalizeText(value).toLocaleLowerCase();
  }

  function tokenize(value) {
    const text = normalizeForMatch(value);
    const tokens = [];
    for (const word of text.match(/[a-z][a-z0-9._/-]*/g) || []) {
      if (!STOP_WORDS.has(word) && word.length > 1) tokens.push(word);
    }
    for (const run of text.match(/[\u3400-\u9fff]+/g) || []) {
      if (run.length === 1) {
        if (!STOP_WORDS.has(run)) tokens.push(run);
        continue;
      }
      for (let index = 0; index < run.length - 1; index += 1) {
        const bigram = run.slice(index, index + 2);
        if (!STOP_WORDS.has(bigram)) tokens.push(bigram);
      }
    }
    return tokens;
  }

  function termPattern(term) {
    const escaped = String(term || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!escaped) return null;
    return /^[A-Za-z0-9._/-]+$/.test(term)
      ? new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "gi")
      : new RegExp(escaped, "gi");
  }

  function countTermOccurrences(text, term) {
    const pattern = termPattern(term);
    if (!pattern) return 0;
    return (String(text || "").match(pattern) || []).length;
  }

  function termVariants(term) {
    const source = normalizeText(term);
    const variants = new Set();
    const suffixes = ["策略", "机制", "方法", "系统", "任务", "分析", "流程", "管理", "方案", "工程", "模型", "能力", "技术"];
    for (const suffix of suffixes) {
      if (!source.endsWith(suffix)) continue;
      const root = source.slice(0, -suffix.length).trim();
      if (/^[A-Za-z][A-Za-z0-9._/-]{1,}$/.test(root) || /[\u3400-\u9fff]{2,}/.test(root)) variants.add(root);
    }
    const mixedParts = source.match(/[A-Za-z][A-Za-z0-9._/-]{1,}|[\u3400-\u9fff]{2,}/g) || [];
    for (const part of mixedParts) {
      if (normalizeForMatch(part) !== normalizeForMatch(source)) variants.add(part);
    }
    return [...variants];
  }

  function countVariantOccurrences(text, term, preparedVariants = null) {
    const variants = Array.isArray(preparedVariants) ? preparedVariants : termVariants(term);
    return variants.reduce((sum, variant) => sum + countTermOccurrences(text, variant), 0);
  }

  function definitionSignal(text, term) {
    const source = normalizeText(text);
    const normalizedSource = source.toLocaleLowerCase();
    const normalizedTerm = normalizeForMatch(term);
    if (!normalizedSource || !normalizedTerm) return 0;
    const positions = [];
    let from = 0;
    while (from <= normalizedSource.length) {
      const index = normalizedSource.indexOf(normalizedTerm, from);
      if (index < 0) break;
      positions.push(index);
      from = index + normalizedTerm.length;
    }
    let strength = 0;
    const cues = /(?:是指|指的是|(?:在这里|这里|此处)指|(?:^|[，,：:\s])指(?!标|数|针|令)|意为|意味着|定义为|定义成|称为|叫作|叫做|统称为|所谓|可理解为|refers?\s+to|means?|is\s+defined\s+as|is\s+called|denotes?)/i;
    // 中文技术文章最常见的定义形式还包括“X 是 Y”“X 即 Y”，以及
    // “MaaS（Model as a Service，模型即服务）是……”这类括号展开。
    // 这里只在术语后紧邻的位置识别，避免把远处普通的“是”误当成定义。
    const directAfterCue = /^\s*(?:[（(][^（）()]{1,180}[）)])?\s*(?:是(?:指|一种|一个|一类)?|为(?:一种|一个|一类)?|即|全称(?:为|是)?|英文全称(?:为|是)?|简称(?:为|是)?)/i;
    const colonDefinition = /^\s*[：:]\s*\S.{2,220}/;
    const abbreviationCue = /^\s*是[^。！？；;]{1,160}(?:的简称|的缩写)/i;
    const parentheticalExpansion = /^\s*[（(](?=[^）)]*[A-Za-z])(?=[^）)]*(?:[，,][^）)]*|\b(?:Protocol|Service|Generation|Authentication|Authorization)\b))[^）)]{2,180}[）)]/i;
    for (const position of positions) {
      const before = source.slice(Math.max(0, position - 45), position);
      const after = source.slice(position + normalizedTerm.length, position + normalizedTerm.length + 220);
      if (cues.test(after)) strength = Math.max(strength, 2);
      if (cues.test(before)) strength = Math.max(strength, 2);
      if (directAfterCue.test(after) || abbreviationCue.test(after) || parentheticalExpansion.test(after) || colonDefinition.test(after)) {
        strength = Math.max(strength, 2);
      }
      if (/(?:^|[。；;])[^。；;]{0,18}(?:所谓|本文把|这里把)/.test(before + normalizedTerm)) strength = Math.max(strength, 3);
    }
    return strength;
  }

  function termFrequency(tokens) {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return counts;
  }

  function bm25Scores(blocks, queryText) {
    const documents = blocks.map((block) => tokenize(`${block.heading_path?.join(" ") || ""} ${block.text}`));
    const queryTokens = [...new Set(tokenize(queryText))];
    const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(1, documents.length);
    const documentFrequency = new Map();
    for (const tokens of documents) {
      for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
    const k1 = 1.2;
    const b = 0.75;
    return documents.map((tokens) => {
      const frequencies = termFrequency(tokens);
      let score = 0;
      for (const token of queryTokens) {
        const frequency = frequencies.get(token) || 0;
        if (!frequency) continue;
        const df = documentFrequency.get(token) || 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const denominator = frequency + k1 * (1 - b + b * tokens.length / Math.max(1, averageLength));
        score += idf * (frequency * (k1 + 1)) / denominator;
      }
      return score;
    });
  }

  function headingOverlap(left, right) {
    const a = new Set(tokenize(left));
    const b = new Set(tokenize(right));
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const token of a) if (b.has(token)) overlap += 1;
    return overlap / Math.max(a.size, b.size);
  }

  function bestQuote(text, term, maximum = 260, selectedStart = null) {
    const raw = String(text || ""), needle = normalizeText(term);
    if (Number.isInteger(selectedStart) && selectedStart >= 0 && raw.slice(selectedStart, selectedStart + needle.length) === needle) {
      const from = Math.max(0, selectedStart - Math.max(0, Math.min(80, maximum - needle.length)));
      return raw.slice(from, Math.max(selectedStart + needle.length, from + maximum)).trim();
    }
    const source = normalizeText(text);
    if (source.length <= maximum) return source;
    const sentences = source.split(/(?<=[。！？!?；;])\s*/).filter(Boolean);
    const normalizedTerm = normalizeForMatch(term);
    const matched = sentences.find((sentence) => normalizeForMatch(sentence).includes(normalizedTerm) && definitionSignal(sentence, term))
      || sentences.find((sentence) => normalizeForMatch(sentence).includes(normalizedTerm));
    if (matched) return matched.slice(0, maximum);
    return `${source.slice(0, maximum - 1)}…`;
  }

  function roleFor(signals) {
    if (signals.definition > 0) return "direct_support";
    if (signals.anchor) return "coreference_support";
    if (signals.exactOccurrences > 0) return "coreference_support";
    if (signals.variantOccurrences > 0) return "coreference_support";
    if (signals.headingOverlap > 0.15) return "structural_support";
    return "sense_disambiguation";
  }

  // A heading is a retrieval bridge, not necessarily an explanation. Preserve
  // short definitions and assertions; classify structure, never term-specific words.
  function isStructuralLabel(block, term) {
    const value = normalizeText(block.text);
    if (definitionSignal(value, term) || /[。！？!?；;]/.test(value)
      || /(?:用于|表示|意味着|必须|需要|包含|采用|负责|不能|不得)/.test(value)) return false;
    return block.type === "heading" || (value.length <= 48
      && (/^[0-9]+(?:\.[0-9]+)*[.、\s]/.test(value) || /[：:]$/.test(value)));
  }

  function retrieve(snapshot, options = {}) {
    const blocks = Array.isArray(snapshot?.blocks) ? snapshot.blocks : [];
    const selection = snapshot?.selection || {};
    const term = selection.normalized_text || selection.raw_text || "";
    const anchorId = selection.anchor_block_id || "";
    const anchor = blocks.find((block) => block.block_id === anchorId) || blocks[0];
    if (!anchor || !term) {
      return {
        candidates: [],
        promptContext: "",
        summary: { candidate_count: 0, term_occurrence_count: 0, definition_match_count: 0, strategy: "local_multi_signal_v1" },
      };
    }

    const queryText = [term, anchor.text, ...(anchor.heading_path || [])].join(" ");
    const lexicalScores = bm25Scores(blocks, queryText);
    const maxLexical = Math.max(0, ...lexicalScores);
    const anchorHeading = (anchor.heading_path || []).join(" ");
    const variants = termVariants(term);
    let totalOccurrences = 0;
    let definitionMatches = 0;

    const labels = blocks.map(b => isStructuralLabel(b, term));
    const headingSupport = new Set();
    for (let i = 0; i < blocks.length; i++) {
      if (!labels[i] || !(countTermOccurrences(blocks[i].text, term)
        || countVariantOccurrences(blocks[i].text, term, variants))) continue;
      // Pull the following explanatory text even when it omits the selected word.
      for (let j = i + 1, kept = 0; j < Math.min(blocks.length, i + 5) && kept < 2; j++) {
        if (labels[j]) break;
        headingSupport.add(blocks[j].block_id); kept++;
      }
    }

    const scored = blocks.map((block, index) => {
      const exactOccurrences = countTermOccurrences(block.text, term);
      const variantOccurrences = exactOccurrences ? 0 : countVariantOccurrences(block.text, term, variants);
      const definition = definitionSignal(block.text, term);
      const distance = Math.abs((block.order ?? index) - (anchor.order ?? blocks.indexOf(anchor)));
      const sameSection = anchorHeading && (block.heading_path || []).join("\n") === (anchor.heading_path || []).join("\n");
      const overlap = headingOverlap(anchorHeading, (block.heading_path || []).join(" "));
      const lexical = maxLexical > 0 ? lexicalScores[index] / maxLexical : 0;
      const isAnchor = block.block_id === anchor.block_id;
      totalOccurrences += exactOccurrences;
      if (definition > 0) definitionMatches += 1;

      let score = lexical * 70;
      if (isAnchor) score += 1000;
      if (exactOccurrences) score += 180 + Math.min(3, exactOccurrences) * 15;
      if (variantOccurrences) score += 105 + Math.min(3, variantOccurrences) * 10;
      if (definition) score += 260 + definition * 40;
      if (distance === 1) score += 75;
      else if (distance === 2) score += 35;
      else if (distance <= 5) score += 12;
      if (sameSection) score += 30;
      score += overlap * 35;
      if (options.headingAware !== false) {
        if (labels[index] && !isAnchor) score -= 245;
        if (headingSupport.has(block.block_id)) score += 190;
      }

      const reasons = [];
      if (isAnchor) reasons.push("当前选区");
      if (options.headingAware !== false && labels[index] && !isAnchor) reasons.push("结构标题降权（未删除）");
      if (options.headingAware !== false && headingSupport.has(block.block_id)) reasons.push("相关标题后的正文");
      if (definition) reasons.push("定义句");
      if (exactOccurrences) reasons.push(`同词出现×${exactOccurrences}`);
      if (variantOccurrences) reasons.push(`词干出现×${variantOccurrences}`);
      if (distance > 0 && distance <= 2) reasons.push("相邻段落");
      if (sameSection && !isAnchor) reasons.push("同一章节");
      if (lexical >= 0.2 && !isAnchor) reasons.push("关键词相关");
      if (overlap > 0.15 && !sameSection) reasons.push("标题相关");

      const signals = {
        anchor: isAnchor,
        exactOccurrences,
        variantOccurrences,
        definition,
        distance,
        sameSection,
        headingOverlap: Number(overlap.toFixed(3)),
        bm25: Number(lexicalScores[index].toFixed(4)),
        structural_label: labels[index],
        heading_body: headingSupport.has(block.block_id),
      };
      return {
        block,
        score,
        reasons,
        signals,
        role: roleFor(signals),
      };
    });

    scored.sort((left, right) => right.score - left.score || left.block.order - right.block.order);
    const limit = Math.max(4, Math.min(20, Number(options.limit) || DEFAULT_LIMIT));
    // Keep the local antecedent even when many distant repetitions outrank it.
    // This supports prose references as well as spoken question/answer pairs.
    const anchorIndex = blocks.findIndex((b) => b.block_id === anchor.block_id);
    const localIds = new Set(blocks.slice(Math.max(0, anchorIndex - 2), anchorIndex + 3).map((b) => b.block_id));
    const reserved = scored.filter((s) => localIds.has(s.block.block_id));
    const selected = [...reserved, ...scored.filter((s) => !localIds.has(s.block.block_id)).slice(0, Math.max(0, limit - reserved.length))]
      .sort((a, b) => b.score - a.score || a.block.order - b.block.order);
    const candidates = selected.map((item, index) => ({
      evidence_id: `e${index + 1}`,
      block_id: item.block.block_id,
      quote: bestQuote(item.block.text, term, 260, item.signals.anchor ? selection.start_offset : null),
      text: item.block.text,
      source_start: 0,
      source_end: item.block.text.length,
      heading_path: item.block.heading_path || [],
      relation_to_selection: item.signals.anchor ? "anchor" : item.block.relation_to_selection || "",
      role: item.role,
      score: Number(item.score.toFixed(3)),
      reasons: item.reasons,
      signals: item.signals,
    }));
    const Discourse = typeof module !== "undefined" && module.exports ? require("./discourse-context.js") : globalThis.YuliuDiscourseContext;
    const dialogue = Discourse?.retrieve(snapshot, candidates, options);
    if (dialogue) {
      snapshot.conversation = dialogue.conversation;
      return { ...dialogue, promptContext: formatForPrompt(dialogue.candidates, options.maxPromptCharacters || 14500) };
    }
    const promptContext = formatForPrompt(candidates, options.maxPromptCharacters);
    return {
      candidates,
      promptContext,
      summary: {
        strategy: options.headingAware === false ? "local_multi_signal_v1" : "heading_body_v2",
        block_count: blocks.length,
        candidate_count: candidates.length,
        term_occurrence_count: totalOccurrences,
        definition_match_count: definitionMatches,
        anchor_block_id: anchor.block_id,
      },
    };
  }

  function formatForPrompt(candidates, maximum = MAX_PROMPT_CHARACTERS) {
    const chunks = [];
    let length = 0;
    for (const candidate of candidates || []) {
      const heading = candidate.heading_path?.length ? `｜章节：${candidate.heading_path.join(" > ")}` : "";
      const reasons = candidate.reasons?.length ? `｜召回原因：${candidate.reasons.join("、")}` : "";
      const chunk = `[${candidate.evidence_id}｜段落 ${candidate.block_id}${heading}${reasons}]\n${candidate.text}`;
      if (length + chunk.length > maximum && chunks.length >= 4) break;
      chunks.push(chunk);
      length += chunk.length + 2;
    }
    return chunks.join("\n\n").slice(0, maximum);
  }

  function compactSnapshot(snapshot, requestId = "") {
    if (!snapshot) return null;
    const candidates = Array.isArray(snapshot.evidence_candidates) ? snapshot.evidence_candidates : [];
    const ids = new Set(candidates.map((candidate) => candidate.block_id));
    return {
      snapshot_version: snapshot.snapshot_version,
      request_id: requestId,
      selection: snapshot.selection,
      page: snapshot.page,
      blocks: (snapshot.blocks || []).filter((block) => ids.has(block.block_id)),
      evidence_candidates: candidates,
      retrieval: snapshot.retrieval || null,
      extraction: snapshot.extraction,
      conversation: snapshot.conversation || null,
    };
  }

  return {
    tokenize,
    countTermOccurrences,
    termVariants,
    definitionSignal,
    bm25Scores,
    bestQuote,
    isStructuralLabel,
    retrieve,
    formatForPrompt,
    compactSnapshot,
  };
});

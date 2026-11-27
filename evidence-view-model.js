(function attachYuliuEvidenceViewModel(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuEvidenceViewModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEvidenceViewModel() {
  function text(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function safeHttpUrl(value) {
    try {
      const parsed = new URL(text(value));
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch (_) {
      return "";
    }
  }

  function unique(items, keyOf) {
    const seen = new Set();
    return items.filter((item) => {
      const key = keyOf(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function interval(item) {
    if (!Number.isInteger(item.source_start) || item.source_start < 0) return null;
    const start = (item.source_offset || 0) + item.source_start;
    return { start, end: start + item.quote.length };
  }

  // Presentation only. Keep original citations/claim links intact in `members`.
  function mergePair(a, b) {
    if (a.block_id !== b.block_id) return null;
    const x = interval(a), y = interval(b);
    if (!x || !y) {
      // Without positions, different IDs may refer to repeated words at distinct locations.
      if (a.quote !== b.quote || x || y || !a.evidence_id || a.evidence_id !== b.evidence_id) return null;
      return { ...a, members: [...a.members, ...b.members] };
    }
    const start = Math.max(x.start, y.start), end = Math.min(x.end, y.end);
    if (start >= end || a.quote.slice(start - x.start, end - x.start) !== b.quote.slice(start - y.start, end - y.start)) return null;
    const [first, last, left, right] = x.start <= y.start ? [a, b, x, y] : [b, a, y, x];
    const quote = first.quote + (right.end > left.end ? last.quote.slice(left.end - right.start) : "");
    return { ...a, quote, source_offset: 0, source_start: Math.min(x.start, y.start),
      source_end: Math.max(x.end, y.end), members: [...a.members, ...b.members] };
  }

  function mergeEvidence(items) {
    const result = [];
    for (const item of items) {
      let merged = { ...item, members: [item] }, insertAt = result.length;
      for (let i = 0; i < result.length;) {
        const candidate = mergePair(result[i], merged);
        if (!candidate) { i++; continue; }
        insertAt = Math.min(insertAt, i);
        merged = candidate;
        result.splice(i, 1);
        i = 0; // Handle bridging overlap, independent of citation ordering.
      }
      result.splice(Math.min(insertAt, result.length), 0, merged);
    }
    return result;
  }

  function groupEvidence(page, blocks) {
    const positions = new Map((blocks || []).map((b, i) => [b.block_id, i]));
    const groups = [];
    // Reading order is used within a group, while groups retain relevance order.
    for (const item of page) {
      const pos = positions.get(item.block_id);
      const heading = JSON.stringify(item.heading_path || []);
      let group = groups.find(g => pos != null && !item.speaker && !item.time &&
        heading !== '[]' && g.heading === heading && g.items.every(e => !e.speaker && !e.time) &&
        g.items.some(e => { const other = positions.get(e.block_id); return other != null && Math.abs(other - pos) <= 1; }) &&
        g.items.reduce((n, e) => n + e.quote.length, item.quote.length) <= 900);
      if (!group) { group = { heading, items: [] }; groups.push(group); }
      group.items.push(item);
      group.items.sort((a, b) => (positions.get(a.block_id) - positions.get(b.block_id)) ||
        ((interval(a)?.start || 0) - (interval(b)?.start || 0)));
    }
    return groups;
  }

  function readingContext(item, blocks) {
    const block = (blocks || []).find(b => b.block_id === item.block_id);
    const source = block?.text;
    if (typeof source !== 'string') return '';
    const start = interval(item)?.start;
    if (start == null || source.slice(start, start + item.quote.length) !== item.quote) return '';
    if (source.length <= 600) return source === item.quote ? '' : source;
    // Bounded reading window, explicitly not additional supporting evidence.
    const from = Math.max(0, start - 100), to = Math.min(source.length, start + item.quote.length + 100);
    return (from ? '…' : '') + source.slice(from, to) + (to < source.length ? '…' : '');
  }

  function build(pageEvidence, externalSources, blocks = []) {
    const page = mergeEvidence((Array.isArray(pageEvidence) ? pageEvidence : [])
      .filter((item) => text(item?.block_id) && text(item?.quote)));
    const pageGroups = groupEvidence(page, blocks);
    const terminology = unique((Array.isArray(externalSources) ? externalSources : [])
      .map((item) => {
        const url = safeHttpUrl(item?.url || item?.link);
        if (!url || !text(item?.title)) return null;
        const parsed = new URL(url);
        return {
          source_id: text(item.source_id),
          title: text(item.title),
          url,
          publisher: text(item.publisher || item.media),
          excerpt: text(item.excerpt || item.content),
          host: parsed.hostname.replace(/^www\./i, ""),
        };
      }).filter(Boolean), (item) => item.source_id || item.url);
    const total = page.length + terminology.length;
    const parts = [];
    if (page.length) parts.push(`原文${page.length}个片段`);
    if (terminology.length) parts.push(`术语资料${terminology.length}条`);
    return { page, pageGroups, terminology, total, summary: parts.length ? `依据 · ${parts.join(" / ")}` : "" };
  }

  return { build, safeHttpUrl, mergeEvidence, groupEvidence, readingContext };
});

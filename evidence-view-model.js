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

  function build(pageEvidence, externalSources) {
    const page = unique((Array.isArray(pageEvidence) ? pageEvidence : [])
      .filter((item) => text(item?.block_id) && text(item?.quote)), (item) => text(item.evidence_id) || `${item.block_id}:${item.quote}`);
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
    if (page.length) parts.push(`原文${page.length}处`);
    if (terminology.length) parts.push(`术语资料${terminology.length}条`);
    return { page, terminology, total, summary: parts.length ? `依据 · ${parts.join(" / ")}` : "" };
  }

  return { build, safeHttpUrl };
});

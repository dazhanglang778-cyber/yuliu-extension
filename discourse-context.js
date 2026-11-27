(function attach(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuDiscourseContext = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Cache raw structure, never model conclusions; content changes invalidate the index.
  const cache = new Map();
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const identity = (s) => norm(s).replace(/\s/g, "").toLowerCase();
  function hash(s) {
    let n = 2166136261;
    for (const c of String(s)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
    return (n >>> 0).toString(36);
  }
  function headers(text) {
    const pattern = /(^|\s)((?:说话人|发言人|Speaker)\s*\d+|[\u3400-\u9fff]{2,12}|[A-Za-z][A-Za-z ._-]{1,30})\s+((?:\d{1,2}:)?\d{1,2}:\d{2})(?=\s|$)/gi;
    const found = [];
    let m;
    while ((m = pattern.exec(text))) {
      const parts = m[3].split(":").map(Number);
      if (parts.at(-1) >= 60 || parts.length === 3 && parts[1] >= 60) continue;
      found.push({ start: m.index + m[1].length, end: pattern.lastIndex, speaker: norm(m[2]), time: m[3], seconds: parts.reduce((n, p) => n * 60 + p, 0) });
    }
    return found;
  }
  function index(snapshot) {
    const blocks = snapshot.blocks || [];
    const signature = `${snapshot.page?.url || ""}\n${blocks.map((b) => `${b.block_id}:${b.text}`).join("\n")}`;
    const fingerprint = hash(signature);
    if (cache.get(fingerprint)?.signature === signature) return cache.get(fingerprint).result;
    const turns = [];
    let active = null;
    function segment(block, start, end) {
      while (start < end && /\s/.test(block.text[start])) start++;
      while (end > start && /\s/.test(block.text[end - 1])) end--;
      if (active && end > start) active.segments.push({ block_id: block.block_id, start, end, text: block.text.slice(start, end), heading_path: block.heading_path || [] });
    }
    for (const block of blocks) {
      const matches = headers(block.text);
      let offset = 0;
      for (const h of matches) {
        segment(block, offset, h.start);
        active = { turn_id: `t${turns.length + 1}`, speaker: h.speaker, time: h.time, seconds: h.seconds, segments: [] };
        turns.push(active);
        offset = h.start;
      }
      segment(block, offset, block.text.length);
    }
    const valid = turns.length >= 2;
    const result = { fingerprint, turns: valid ? turns : [], valid };
    cache.set(fingerprint, { signature, result });
    while (cache.size > 2) cache.delete(cache.keys().next().value);
    return result;
  }
  function analyze(snapshot) {
    const indexed = index(snapshot);
    if (!indexed.valid) return null;
    const selection = snapshot.selection || {};
    const selected = selection.normalized_text || selection.raw_text || "";
    let at = indexed.turns.findIndex((t) => t.segments.some((s) => s.block_id === selection.anchor_block_id
      && (Number.isFinite(selection.start_offset) ? selection.start_offset >= s.start && selection.start_offset < s.end : s.text.includes(selected))));
    // A page title outside the dialogue is not automatically treated as a meeting reference.
    if (at < 0) return null;
    const speaker = indexed.turns.map((t) => t.speaker).find((s) => identity(s) === identity(selected)) || null;
    return { ...indexed, at, selected_speaker: speaker, anchor: indexed.turns[at] };
  }
  function crop(segment, selected, startOffset, max = 850) {
    if (segment.text.length <= max) return { ...segment, quote: segment.text };
    const at = Number.isFinite(startOffset) && startOffset >= segment.start && startOffset < segment.end
      ? startOffset - segment.start : Math.max(0, segment.text.indexOf(selected));
    const from = Math.max(0, Math.min(at - 240, segment.text.length - max));
    return { ...segment, start: segment.start + from, end: segment.start + from + max, quote: segment.text.slice(from, from + max) };
  }
  function retrieve(snapshot, baseCandidates = [], options = {}) {
    const info = analyze(snapshot);
    if (!info) return null;
    const selection = snapshot.selection;
    const selected = selection.normalized_text || selection.raw_text;
    const baseScores = new Map(baseCandidates.map((c) => [c.block_id, c.score]));
    const ranked = info.turns.map((turn, i) => {
      const body = turn.segments.map((s) => s.text).join(" ");
      const distance = Math.abs(i - info.at);
      const local = distance <= 3 && Math.abs(turn.seconds - info.anchor.seconds) <= 180;
      const sameSpeaker = info.selected_speaker && identity(turn.speaker) === identity(info.selected_speaker);
      const mention = body.includes(selected);
      const identityCue = /(?:我叫|我是|我来自|我负责|负责|这位是|介绍一下|代表|所属|担任|不是)/.test(body);
      const score = (i === info.at ? 2000 : 0) + (local ? 700 - distance * 55 : 0)
        + (sameSpeaker ? 220 : 0) + (mention ? 150 : 0)
        + ((sameSpeaker || mention) && identityCue ? 350 : 0)
        + Math.min(100, Math.max(0, ...turn.segments.map((s) => baseScores.get(s.block_id) || 0)) / 5);
      return { turn, i, score, local, sameSpeaker, identityCue, mention };
    });
    // Remote evidence often needs its own question/answer, e.g. an introduction followed by a brief reply.
    const remote = ranked.filter((r) => r.sameSpeaker && !r.local).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 4);
    for (const target of remote) {
      for (const i of [target.i - 1, target.i + 1]) {
        const neighbor = ranked[i];
        if (neighbor && Math.abs(neighbor.turn.seconds - target.turn.seconds) <= 120) neighbor.score += 260;
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.i - b.i);
    const candidates = [];
    const included = new Set();
    const maxChars = options.maxPromptCharacters || 14500;
    let chars = 0;
    for (const item of ranked) {
      if (candidates.length >= 20) break;
      if (!item.local && !item.sameSpeaker && !item.mention && item.score < 30) continue;
      for (const segment of item.turn.segments) {
        if (candidates.length >= 20) break;
        const isAnchor = segment.block_id === selection.anchor_block_id
          && (!Number.isFinite(selection.start_offset) || selection.start_offset >= segment.start && selection.start_offset < segment.end);
        const part = crop(segment, selected, isAnchor ? selection.start_offset : undefined);
        if (chars + part.quote.length > maxChars) continue;
        chars += part.quote.length;
        included.add(item.turn.turn_id);
        candidates.push({
          evidence_id: `e${candidates.length + 1}`, block_id: segment.block_id,
          text: part.quote, quote: part.quote, source_start: part.start, source_end: part.end,
          heading_path: segment.heading_path, role: "coreference_support", score: item.score,
          relation_to_selection: isAnchor ? "anchor" : item.local ? "dialogue_neighbor" : "dialogue_related",
          speaker: item.turn.speaker, time: item.turn.time, turn_id: item.turn.turn_id,
          reasons: [isAnchor ? "当前发言" : item.local ? "完整问答邻接" : item.sameSpeaker ? "同一文内对象的相关发言" : "跨段关联线索"],
          signals: { anchor: isAnchor, dialogue: true, distance: Math.abs(item.i - info.at) },
        });
      }
    }
    // Retain non-dialogue introductions/definitions; timestamps are a helpful structure, not a prerequisite for evidence.
    for (const candidate of baseCandidates) {
      if (candidates.length >= 20 || chars + candidate.text.length > maxChars) break;
      if (candidates.some((c) => c.block_id === candidate.block_id)) continue;
      if (candidate.role !== "direct_support" && !candidate.text.includes(selected)) continue;
      candidates.push({ ...candidate, evidence_id: `e${candidates.length + 1}` });
      chars += candidate.text.length;
    }
    return {
      candidates,
      conversation: {
        fingerprint: info.fingerprint, selected_speaker: info.selected_speaker,
        anchor_turn_id: info.anchor.turn_id, anchor_speaker: info.anchor.speaker,
        anchor_time: info.anchor.time, indexed_turn_count: info.turns.length,
        retrieved_turn_count: included.size,
        coverage: snapshot.extraction?.coverage || "loaded_content_only",
      },
      summary: { strategy: "dialogue_adjacency_v1", candidate_count: candidates.length,
        indexed_turn_count: info.turns.length, retrieved_turn_count: included.size, fingerprint: info.fingerprint },
    };
  }
  return { analyze, retrieve, headers, clearCache() { cache.clear(); }, cacheSize() { return cache.size; } };
});

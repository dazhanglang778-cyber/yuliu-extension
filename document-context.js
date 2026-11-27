(function attachYuliuDocumentContext(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.YuliuDocumentContext = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createYuliuDocumentContext() {
  const BLOCK_SELECTOR = [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "li", "blockquote", "pre", "td", "th", "figcaption",
    "[role='heading']", "[role='paragraph']", ".docx-text-block", ".text-block",
  ].join(",");
  const ROOT_SELECTOR = "article, main, [role='main']";
  const CONTENT_SELECTOR = "[itemprop='articleBody'], .article-content, .article-body, .post-content, .post-body, .entry-content, .markdown-body";
  const NOISE_SELECTOR = [
    "script", "style", "noscript", "template", "svg", "canvas",
    "nav", "aside", "footer", "form", "dialog",
    "[aria-hidden='true']", "[hidden]",
    "[role='navigation']", "[role='complementary']", "[role='contentinfo']",
    ".article-footer", ".translation-banner",
    "#context-explainer-host",
  ].join(",");
  const NOISE_NAME = /(?:^|[-_\s])(comment|comments|recommend|related|advert|ads|promo|share|toolbar|breadcrumb|pagination|cookie|modal|popup|sidebar)(?:$|[-_\s])/i;
  const MAX_BLOCK_LENGTH = 6000;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[\t\f\v ]+/g, " ")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
  }

  function blockType(tagName = "", role = "") {
    const tag = String(tagName).toLocaleLowerCase();
    const normalizedRole = String(role).toLocaleLowerCase();
    if (/^h[1-6]$/.test(tag) || normalizedRole === "heading") return "heading";
    if (tag === "li") return "list_item";
    if (tag === "blockquote") return "quote";
    if (tag === "pre") return "code";
    if (tag === "td" || tag === "th") return "table_cell";
    if (tag === "figcaption") return "caption";
    return "paragraph";
  }

  function headingLevel(tagName = "", ariaLevel = "") {
    const match = String(tagName).toLocaleLowerCase().match(/^h([1-6])$/);
    if (match) return Number(match[1]);
    const level = Number(ariaLevel);
    return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 2;
  }

  function createBlockRecords(items) {
    const headingStack = [];
    const duplicateCounts = new Map();
    const records = [];

    const expandedItems = (items || []).flatMap((item, index) => {
      const source = normalizeText(item.text);
      const parts = [];
      for (let start = 0; start < source.length;) {
        let end = Math.min(source.length, start + MAX_BLOCK_LENGTH);
        if (end < source.length) {
          const tail = source.slice(Math.max(start, end - 500), end);
          const boundaries = [...tail.matchAll(/[。！？;；\n]/g)];
          if (boundaries.length) end = Math.max(start, end - 500) + boundaries.at(-1).index + 1;
        }
        let contentStart = start;
        while (contentStart < end && /\s/.test(source[contentStart])) contentStart++;
        parts.push({ ...item, text: source.slice(contentStart, end), sourceIndex: item.sourceIndex ?? index, sourceStart: contentStart });
        start = end;
      }
      return parts;
    });
    for (const item of expandedItems) {
      const text = normalizeText(item.text);
      if (text.length < 2) continue;

      const type = item.type || blockType(item.tagName, item.role);
      if (type === "heading") {
        const level = item.headingLevel || headingLevel(item.tagName, item.ariaLevel);
        headingStack.length = Math.max(0, level - 1);
        headingStack[level - 1] = text;
      }
      const path = headingStack.filter(Boolean);
      const fingerprint = `${type}\n${path.join(" > ")}\n${text}`;
      const baseId = `b-${hashString(fingerprint)}`;
      const duplicateIndex = duplicateCounts.get(baseId) || 0;
      duplicateCounts.set(baseId, duplicateIndex + 1);
      const blockId = duplicateIndex ? `${baseId}-${duplicateIndex + 1}` : baseId;

      records.push({
        block_id: blockId,
        type,
        heading_path: path,
        text,
        order: records.length,
        source_index: item.sourceIndex ?? records.length,
        source_start: item.sourceStart || 0,
      });
    }
    return records;
  }

  function nearestOccurrence(text, exact, approximateStart = 0) {
    const source = normalizeText(text);
    const needle = normalizeText(exact);
    if (!source || !needle) return { start: -1, end: -1, occurrenceIndex: -1 };
    const occurrences = [];
    let from = 0;
    while (from <= source.length) {
      const index = source.indexOf(needle, from);
      if (index < 0) break;
      occurrences.push(index);
      from = index + Math.max(needle.length, 1);
    }
    if (!occurrences.length) return { start: -1, end: -1, occurrenceIndex: -1 };
    let chosen = 0;
    for (let index = 1; index < occurrences.length; index += 1) {
      if (Math.abs(occurrences[index] - approximateStart) < Math.abs(occurrences[chosen] - approximateStart)) chosen = index;
    }
    return {
      start: occurrences[chosen],
      end: occurrences[chosen] + needle.length,
      occurrenceIndex: chosen,
    };
  }

  function createTextQuote(blockText, selectedText, approximateStart = 0, contextLength = 36) {
    const text = normalizeText(blockText);
    const exact = normalizeText(selectedText);
    const located = nearestOccurrence(text, exact, approximateStart);
    if (located.start < 0) {
      return { exact, prefix: "", suffix: "", start: -1, end: -1, occurrence_index: -1 };
    }
    return {
      exact,
      prefix: text.slice(Math.max(0, located.start - contextLength), located.start),
      suffix: text.slice(located.end, located.end + contextLength),
      start: located.start,
      end: located.end,
      occurrence_index: located.occurrenceIndex,
    };
  }

  function buildNormalizedTextIndex(chunks) {
    const text = [];
    const positions = [];
    for (let chunkIndex = 0; chunkIndex < (chunks || []).length; chunkIndex += 1) {
      const chunk = String(chunks[chunkIndex] || "");
      for (let offset = 0; offset < chunk.length; offset += 1) {
        const character = chunk[offset];
        if (/\s/.test(character)) {
          if (!text.length || text[text.length - 1] === " ") continue;
          text.push(" ");
          positions.push({ chunkIndex, offset });
        } else {
          text.push(character);
          positions.push({ chunkIndex, offset });
        }
      }
    }
    while (text[text.length - 1] === " ") {
      text.pop();
      positions.pop();
    }
    return { text: text.join(""), positions };
  }

  function findTextQuoteRange(element, quote, documentObject = element?.ownerDocument, approximateStart = 0) {
    if (!element || !documentObject?.createRange) return null;
    const showText = documentObject.defaultView?.NodeFilter?.SHOW_TEXT || globalThis.NodeFilter?.SHOW_TEXT || 4;
    const walker = documentObject.createTreeWalker(element, showText);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    if (!nodes.length) return null;
    const indexed = buildNormalizedTextIndex(nodes.map((node) => node.nodeValue || ""));
    const target = normalizeText(quote);
    const start = nearestOccurrence(indexed.text, target, approximateStart).start;
    if (start < 0 || !target) return null;
    const first = indexed.positions[start];
    const last = indexed.positions[start + target.length - 1];
    if (!first || !last) return null;
    const range = documentObject.createRange();
    range.setStart(nodes[first.chunkIndex], first.offset);
    range.setEnd(nodes[last.chunkIndex], last.offset + 1);
    return range;
  }

  function buildLegacyContext(blocks, anchorBlockId, limit = 6000) {
    const list = Array.isArray(blocks) ? blocks : [];
    if (!list.length) return "";
    let anchor = Math.max(0, list.findIndex((block) => block.block_id === anchorBlockId));
    if (anchor < 0) anchor = 0;
    const included = new Set([anchor]);
    let total = list[anchor].text.length;
    let left = anchor - 1;
    let right = anchor + 1;
    while ((left >= 0 || right < list.length) && total < limit) {
      const candidates = [];
      if (left >= 0) candidates.push(left);
      if (right < list.length) candidates.push(right);
      let added = false;
      for (const index of candidates) {
        const extra = list[index].text.length + 1;
        if (total + extra > limit && included.size > 1) continue;
        included.add(index);
        total += extra;
        added = true;
      }
      left -= 1;
      right += 1;
      if (!added) break;
    }
    return [...included]
      .sort((a, b) => a - b)
      .map((index) => list[index].text)
      .join("\n")
      .slice(0, limit);
  }

  function elementFromNode(node) {
    if (!node) return null;
    return node.nodeType === 1 ? node : node.parentElement;
  }

  function isNoiseElement(element, root) {
    if (!element || element === root) return false;
    const noiseAncestor = element.closest?.(NOISE_SELECTOR);
    if (noiseAncestor && noiseAncestor !== root) return true;
    // Noise is usually named on a wrapper, not on its descendant paragraphs.
    // Never classify prose by its words: an article may discuss ads or comments.
    for (let current = element; current && current !== root; current = current.parentElement) {
      const names = `${current.id || ""} ${typeof current.className === "string" ? current.className : ""}`;
      if (NOISE_NAME.test(names)) return true;
    }
    if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return true;
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return true;
    }
    return false;
  }

  function findReadingBlock(startElement, root) {
    const semantic = startElement?.closest?.(BLOCK_SELECTOR);
    if (semantic && root.contains(semantic)) return semantic;
    let current = startElement;
    while (current && current !== root) {
      const text = normalizeText(current.innerText || current.textContent);
      if (text.length >= 2 && text.length <= MAX_BLOCK_LENGTH && !current.querySelector?.(BLOCK_SELECTOR)) return current;
      current = current.parentElement;
    }
    return root;
  }

  function chooseRoot(startElement, documentObject) {
    const content = startElement?.closest?.(CONTENT_SELECTOR);
    if (content && content.querySelector?.(BLOCK_SELECTOR)) return content;
    const nearby = startElement?.closest?.(ROOT_SELECTOR);
    if (nearby) return nearby;
    return documentObject.body || documentObject.documentElement;
  }

  function collectBlockElements(root, anchorElement, stats = {}) {
    const candidates = [...root.querySelectorAll(BLOCK_SELECTOR)];
    if (anchorElement && !candidates.includes(anchorElement)) candidates.push(anchorElement);
    candidates.sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      return position & 4 ? -1 : 1;
    });
    stats.candidate_count = candidates.length;
    stats.excluded_noise_count = 0;
    return candidates.filter((element) => {
      if (isNoiseElement(element, root) && element !== anchorElement) {
        stats.excluded_noise_count++;
        return false;
      }
      const text = normalizeText(element.innerText || element.textContent);
      if (text.length < 2) return false;
      if (element !== anchorElement && element.querySelector?.(BLOCK_SELECTOR)) return false;
      return true;
    });
  }

  function approximateRangeOffset(range, blockElement) {
    try {
      const before = blockElement.ownerDocument.createRange();
      before.selectNodeContents(blockElement);
      before.setEnd(range.startContainer, range.startOffset);
      return normalizeText(before.toString()).length;
    } catch (_) {
      return 0;
    }
  }

  function collect(range, selectedText, options = {}) {
    const documentObject = options.document || range?.startContainer?.ownerDocument || globalThis.document;
    if (!documentObject || !range) return null;
    const startElement = elementFromNode(range.startContainer || range.commonAncestorContainer);
    const root = chooseRoot(startElement, documentObject);
    const readingBlock = findReadingBlock(startElement, root);
    const collectionStats = {};
    const elements = collectBlockElements(root, readingBlock, collectionStats);
    const items = elements.map((element, sourceIndex) => ({
      sourceIndex,
      tagName: element.tagName,
      role: element.getAttribute?.("role") || "",
      ariaLevel: element.getAttribute?.("aria-level") || "",
      text: element.innerText || element.textContent,
    }));
    const blocks = createBlockRecords(items);
    const elementByBlockId = new Map();
    const blockIdByElement = new Map();
    for (const block of blocks) {
      const element = elements[block.source_index];
      if (!element) continue;
      elementByBlockId.set(block.block_id, element);
      if (!blockIdByElement.has(element)) blockIdByElement.set(element, block.block_id);
    }

    let anchorBlockId = blockIdByElement.get(readingBlock) || "";
    if (!anchorBlockId) {
      for (let current = startElement; current && current !== root.parentElement; current = current.parentElement) {
        anchorBlockId = blockIdByElement.get(current) || "";
        if (anchorBlockId) break;
      }
    }
    const approximateStart = approximateRangeOffset(range, readingBlock);
    const sourceIndex = elements.indexOf(readingBlock);
    const sourceBlocks = blocks.filter((block) => block.source_index === sourceIndex);
    const anchorBlock = sourceBlocks.find((block) => approximateStart >= block.source_start && approximateStart < block.source_start + block.text.length)
      || blocks.find((block) => block.block_id === anchorBlockId) || blocks[0];
    if (!anchorBlock) return null;
    anchorBlockId = anchorBlock.block_id;
    const quote = createTextQuote(anchorBlock.text, selectedText, approximateStart - (anchorBlock.source_start || 0));
    const occurrenceId = `${anchorBlockId}:o${Math.max(0, quote.occurrence_index)}`;

    const enrichedBlocks = blocks.map((block) => {
      let relation;
      if (block.block_id === anchorBlockId) relation = "anchor";
      else if (normalizeText(selectedText) && block.text.includes(normalizeText(selectedText))) relation = "term_occurrence";
      else if (Math.abs(block.order - anchorBlock.order) <= 1) relation = "neighbor";
      else if (block.heading_path.join("\n") === anchorBlock.heading_path.join("\n")) relation = "same_section";
      return relation ? { ...block, relation_to_selection: relation } : block;
    });
    const rect = readingBlock?.getBoundingClientRect?.() || range.getBoundingClientRect();
    const localContext = anchorBlock.text;
    const snapshot = {
      snapshot_version: "1.0",
      selection: {
        raw_text: String(selectedText || "").trim(),
        normalized_text: normalizeText(selectedText),
        occurrence_id: occurrenceId,
        anchor_block_id: anchorBlockId,
        start_offset: quote.start,
        end_offset: quote.end,
        occurrence_index: quote.occurrence_index,
        text_quote: { exact: quote.exact, prefix: quote.prefix, suffix: quote.suffix },
      },
      page: {
        title: documentObject.title || "",
        url: documentObject.location?.href || options.url || "",
        language: documentObject.documentElement?.lang || "",
      },
      blocks: enrichedBlocks.map(({ source_index, ...block }) => block),
      extraction: {
        collector_version: "article-scope-v1-2026-10-30",
        scope_strategy: root.matches?.(CONTENT_SELECTOR) ? "article_content" : root === documentObject.body ? "body_fallback" : "semantic_root",
        scope_uncertain: root === documentObject.body,
        candidate_element_count: collectionStats.candidate_count,
        excluded_noise_count: collectionStats.excluded_noise_count,
        selected_noise_preserved: isNoiseElement(readingBlock, root),
        root_type: root === documentObject.body ? "body" : String(root.tagName || "root").toLocaleLowerCase(),
        block_count: enrichedBlocks.length,
        character_count: enrichedBlocks.reduce((sum, block) => sum + block.text.length, 0),
        truncated: false,
        coverage: "loaded_content_only",
        coverage_note: "仅索引当前页面已加载的正文；未验证是否为完整文档。",
        chunked_source_count: new Set(blocks.filter((b) => b.source_start > 0).map((b) => b.source_index)).size,
      },
      evidence_candidates: [],
    };

    return {
      snapshot,
      elementByBlockId,
      readingBlock,
      localContext,
      legacyContext: buildLegacyContext(enrichedBlocks, anchorBlockId),
      readingRect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      },
    };
  }

  return {
    BLOCK_SELECTOR,
    normalizeText,
    hashString,
    blockType,
    createBlockRecords,
    nearestOccurrence,
    createTextQuote,
    buildNormalizedTextIndex,
    findTextQuoteRange,
    buildLegacyContext,
    collect,
  };
});

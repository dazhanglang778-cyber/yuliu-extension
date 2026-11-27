(() => {
  const Parser = globalThis.ContextExplainerParser;
  const EvidenceViewModel = globalThis.YuliuEvidenceViewModel;
  const DocumentContext = globalThis.YuliuDocumentContext;
  const DocumentRetrieval = globalThis.YuliuDocumentRetrieval;
  const HOST_ID = "context-explainer-host";
  const HIGHLIGHT_CLASS = "context-explainer-selection-mark";
  const HIGHLIGHT_NAME = "context-explainer-active-selection";
  const EVIDENCE_HIGHLIGHT_NAME = "context-explainer-active-evidence";
  const EVIDENCE_FALLBACK_CLASS = "context-explainer-evidence-target";
  let armedSelection = null;
  let armTimer = null;
  let activePort = null;
  let activeRequestId = "";
  let activeInitialRequestId = "";
  const requestTimings = new Map();
  const requestStreams = new Map();
  let initialAnswer = "";
  let normalAnswer = "";
  let simpleAnswer = "";
  let expandedAnswers = { general: "", example: "" };
  let activeSources = [];
  let activeSenseIdentity = null;
  const expansionPorts = new Set();
  let expansionRunId = 0;
  let waitingTimer = null;
  let selectionDragStart = null;
  let primaryBusy = false;
  let expansionBusy = false;
  let activeDiagnosticSessionId = "";
  let activeDiagnosticItem = null;
  let evidenceHighlightTimer = null;
  let fallbackEvidenceElement = null;

  window.addEventListener("mousedown", rememberExistingSelection, true);
  window.addEventListener("mouseup", rememberDraggedSelection, true);
  window.addEventListener("dblclick", explainRememberedSelection, true);

  function rememberExistingSelection(event) {
    if (event.button !== 0 || isInsideCard(event.target)) return;
    selectionDragStart = { x: event.clientX, y: event.clientY };

    // 在双击的第二次按下时立即触发，避免网页或划词工具截走最终 dblclick 事件。
    if (event.detail > 1 && armedSelection) {
      if (canExplainAt(event.clientX, event.clientY, 8000)) launchExplanation(event);
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      if (event.detail === 1) disarm();
      return;
    }

    const range = selection.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (!pointIsInRects(event.clientX, event.clientY, rects)) {
      disarm();
      return;
    }

    armSelection(selection);
  }

  function rememberDraggedSelection(event) {
    if (event.button !== 0 || isInsideCard(event.target) || !selectionDragStart) return;
    const moved = Math.hypot(event.clientX - selectionDragStart.x, event.clientY - selectionDragStart.y);
    selectionDragStart = null;
    if (moved < 4) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
    armSelection(selection);
  }

  function armSelection(selection) {
    const range = selection.getRangeAt(0).cloneRange();
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rects.length) return;

    const contextInfo = collectContext(range, selection.toString().trim());
    armedSelection = {
      text: selection.toString().trim().slice(0, 500),
      range,
      rects,
      anchorRect: range.getBoundingClientRect(),
      context: contextInfo.text,
      localContext: contextInfo.localContext,
      documentContext: contextInfo.documentContext,
      blockElements: contextInfo.blockElements,
      readingRect: contextInfo.readingRect,
      readingBlock: contextInfo.readingBlock,
      title: document.title,
      armedAt: Date.now(),
    };

    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      if (!document.getElementById(HOST_ID)) disarm();
    }, 8000);
  }

  function explainRememberedSelection(event) {
    if (isInsideCard(event.target)) return;
    if (!canExplainAt(event.clientX, event.clientY, 8000)) return;
    launchExplanation(event);
  }

  function canExplainAt(x, y, maxAge) {
    return !!armedSelection
      && Date.now() - armedSelection.armedAt <= maxAge
      && pointIsInRects(x, y, armedSelection.rects);
  }

  function launchExplanation(event) {
    const item = armedSelection;
    if (!item) return;
    armedSelection = null;

    event.preventDefault();
    event.stopPropagation();
    clearTimeout(armTimer);
    showCard(item);
    requestExplanation("initial", item);
  }

  function collectContext(range, selectedText) {
    const structured = DocumentContext?.collect?.(range, selectedText);
    if (structured) {
      const retrieval = DocumentRetrieval?.retrieve?.(structured.snapshot) || null;
      if (retrieval) {
        structured.snapshot.evidence_candidates = retrieval.candidates;
        structured.snapshot.retrieval = retrieval.summary;
      }
      return {
        text: retrieval?.promptContext || structured.legacyContext,
        localContext: structured.localContext,
        documentContext: structured.snapshot,
        blockElements: structured.elementByBlockId,
        readingBlock: structured.readingBlock,
        readingRect: structured.readingRect,
      };
    }
    let element = range.commonAncestorContainer;
    if (element.nodeType !== Node.ELEMENT_NODE) element = element.parentElement;
    const readingBlock = element?.closest("p, li, blockquote, pre, td, article") || element;
    const root = element?.closest("article, main, [role='main']") || document.body;
    const text = cleanText(root?.innerText || document.body?.innerText || "");
    const readingRect = readingBlock?.getBoundingClientRect?.() || range.getBoundingClientRect();
    const result = {
      text,
      localContext: cleanText(readingBlock?.innerText || selectedText).slice(0, 1200),
      documentContext: null,
      blockElements: new Map(),
      readingBlock,
      readingRect: {
        left: readingRect.left,
        right: readingRect.right,
        top: readingRect.top,
        bottom: readingRect.bottom,
      },
    };
    const contextLength = 6000;
    if (text.length <= contextLength) return result;

    const index = text.indexOf(cleanText(selectedText));
    if (index < 0) {
      result.text = text.slice(0, contextLength);
      return result;
    }
    const start = Math.max(0, index - 3200);
    result.text = text.slice(start, start + contextLength);
    return result;
  }

  function cleanText(text) {
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function showCard(item) {
    closeCard(true);
    activeInitialRequestId = "";
    activeDiagnosticSessionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeDiagnosticItem = item;
    sendDiagnosticEvent("session_started", {
      selectedLength: item.text.length,
      pageUrl: `${location.origin}${location.pathname}`,
    }, "", item);
    initialAnswer = "";
    normalAnswer = "";
    simpleAnswer = "";
    expandedAnswers = { general: "", example: "" };
    activeSources = [];
    activeSenseIdentity = null;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.zIndex = "2147483647";
    host.style.width = "390px";
    host.style.height = "auto";
    host.style.maxHeight = "min(600px, calc(100vh - 24px))";
    host.style.maxWidth = "calc(100vw - 24px)";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${cardStyles()}
      <section class="card" aria-live="polite">
        <header class="card-header">
          <button class="close" title="关闭" aria-label="关闭">×</button>
          <div class="term"><span class="quote open">“</span><strong></strong><span class="quote close-quote">”</span></div>
          <div class="rule"></div>
        </header>
        <div class="card-body">
          <div class="answer-mode" hidden></div>
          <div class="loading-status">
            <span class="loading-orbit" aria-hidden="true"><i></i></span>
            <span data-field="status">正在读取选区与文章上下文……</span>
          </div>
          <div class="normal-answer">
            <div class="section">
              <h3><span>♧</span> <span data-label="meaning">这里指什么</span></h3>
              <p data-field="meaning"><span class="streaming">正在理解这里的意思</span></p>
            </div>
            <div class="section" data-section="intent" hidden>
              <h3><span>✎</span> <span data-label="intent">作者想表达什么</span></h3>
              <p data-field="intent"></p>
            </div>
          </div>
          <div class="evidence-panel" hidden>
            <small class="coverage-note" hidden></small>
            <button class="evidence-toggle" type="button" aria-expanded="false">
              <span data-field="evidence-summary">依据</span><i aria-hidden="true">⌄</i>
            </button>
            <div class="evidence-list" hidden></div>
          </div>
          <div class="simple-answer" hidden>
            <h3>一句话讲懂：</h3>
            <p data-field="simple"><span class="cursor"></span></p>
            <small class="coverage-note">依据供核对原语境；本句及类比未另行核验。</small>
          </div>
          <p class="notice" hidden></p>
          <div class="expanded" hidden>
            <div data-module="general"><h4>通用定义</h4><small class="coverage-note" data-state="general" hidden></small><p data-field="general"></p><button class="module-retry" data-retry="general" hidden>重试通用定义</button></div>
            <div data-module="example"><h4>举个例子</h4><small class="coverage-note" data-state="example" hidden></small><p data-field="example">通用定义完成后，可按需生成一个例子。</p><button class="module-retry" data-retry="example" disabled>举个例子</button></div>
          </div>
        </div>
        <footer class="actions">
          <button class="simple secondary" disabled>说简单点</button>
          <button class="expand primary" disabled>展开讲讲</button>
        </footer>
      </section>`;

    shadow.querySelector(".term strong").textContent = item.text;
    shadow.querySelector(".close").addEventListener("click", () => closeCard(false));
    shadow.querySelector(".simple").addEventListener("click", () => showSimpler(item));
    shadow.querySelector(".expand").addEventListener("click", () => toggleExpanded(item));
    shadow.querySelectorAll("[data-retry]").forEach((button) => {
      button.addEventListener("click", () => startExpansion(item, button.dataset.retry));
    });
    placeCard(host, item);
    paintSelection(item.range, item.rects);
    ensureCardVisible(host);
  }

  function requestExplanation(mode, item, focusRetry = 0) {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const shadow = host.shadowRoot;
    const previousAnswer = mode === "simplify" ? (normalAnswer || initialAnswer) : initialAnswer;
    const notice = shadow.querySelector(".notice");
    notice.classList.remove("error");
    notice.removeAttribute("title");
    notice.hidden = true;
    notice.classList.remove("error");
    setBusy(shadow, true, mode);
    showLoading(shadow, loadingText(mode));
    clearTimeout(waitingTimer);
    waitingTimer = setTimeout(() => {
      showLoading(shadow, "正在等待所选模型响应，请稍候……");
    }, 3500);
    if (mode === "initial") {
      initialAnswer = "";
      shadow.querySelector("[data-section='intent']").hidden = true;
      shadow.querySelector("[data-field='meaning']").innerHTML = '<span class="cursor"></span>';
      shadow.querySelector("[data-field='intent']").textContent = "";
    } else if (mode === "simplify") {
      initialAnswer = "";
      shadow.querySelector("[data-field='simple']").innerHTML = '<span class="cursor"></span>';
    }

    activePort?.disconnect();
    let requestPort;
    try {
      requestPort = chrome.runtime.connect({ name: "context-explainer" });
      activePort = requestPort;
    } catch (_) {
      showError(shadow, "插件刚刚更新过，请刷新当前网页后再试。", false);
      return;
    }
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeRequestId = requestId;
    requestTimings.set(requestId, performance.now());
    if (requestTimings.size > 20) requestTimings.delete(requestTimings.keys().next().value);
    if (mode === "initial") activeInitialRequestId = requestId;
    let settled = false;
    requestPort.onMessage.addListener((message) => {
      if (message.requestId !== requestId) return;
      if (["DONE", "ERROR", "NEED_KEY"].includes(message.type)) settled = true;
      receiveStream(message, mode, item, focusRetry);
    });
    requestPort.onDisconnect.addListener(() => {
      if (settled || activePort !== requestPort) return;
      const currentHost = document.getElementById(HOST_ID);
      if (!currentHost) return;
      showError(currentHost.shadowRoot, "插件后台连接中断，请刷新网页后重新尝试。", false);
    });
    requestPort.postMessage({
      type: "EXPLAIN",
      requestId,
      diagnosticSessionId: activeDiagnosticSessionId,
      mode,
      selection: item.text,
      senseMeaning: "",
      localContext: mode === "initial" ? (item.localContext || cleanText(item.readingBlock?.innerText || item.text).slice(0, 1200)) : "",
      context: mode === "initial" ? item.context : "",
      documentContext: mode === "initial" && item.documentContext
        ? (DocumentRetrieval?.compactSnapshot?.(item.documentContext, requestId)
          || { ...item.documentContext, request_id: requestId })
        : null,
      title: mode === "initial" ? item.title : "",
      existing: mode === "simplify" ? Parser.simplificationSource(previousAnswer) : "",
      strictSimple: mode === "simplify" && focusRetry > 0,
    });
  }

  function receiveStream(message, mode, item, focusRetry = 0) {
    if (message.requestId !== activeRequestId) return;
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const shadow = host.shadowRoot;

    if (message.type === "NEED_KEY") {
      sendDiagnosticEvent("ui_error", { mode, message: "缺少 API Key" }, message.requestId);
      showError(shadow, "请先点击 Chrome 右上角的插件图标，粘贴并保存 API Key。", true);
      return;
    }
    if (message.type === "ERROR") {
      sendDiagnosticEvent("ui_error", { mode, message: message.message || "请求失败" }, message.requestId);
      showError(shadow, message.message || "这次解释没有生成，请稍后再试。", false);
      return;
    }
    if (message.type === "STATUS" || message.type === "START") {
      showLoading(shadow, message.message || "正在生成解释……");
      return;
    }
    if (message.type === "SOURCES") {
      activeSources = Array.isArray(message.sources) ? message.sources : [];
      return;
    }
    if (message.type === "MEANING_PREVIEW" && mode === "initial") {
      hideLoading(shadow);
      const field = shadow.querySelector("[data-field='meaning']");
      field.dataset.preview = "true";
      setAnswerMode(shadow, "释义预览 · 尚未核验");
      setStreamText(field, message.text, false);
      noteVisibleStream(message.requestId, mode, message.text);
      return;
    }
    if (message.type === "GROUNDED_RESULT") {
      delete shadow.querySelector("[data-field='meaning']").dataset.preview;
      setAnswerMode(shadow, "");
      initialAnswer = JSON.stringify(message.result || {});
      hideLoading(shadow);
      renderInitial(shadow, initialAnswer, false);
      return;
    }
    if (message.type === "DELTA") {
      initialAnswer += message.delta;
      if (mode === "simplify") {
        hideLoading(shadow);
        renderSimple(shadow, initialAnswer, false);
        noteVisibleStream(message.requestId, mode, Parser.parseSimple(initialAnswer));
      } else if (answerNamesSelection(parseInitial(initialAnswer).meaning, item.text)) {
        hideLoading(shadow);
        renderInitial(shadow, initialAnswer, false);
      } else {
        showLoading(shadow, `正在确认回答是否聚焦“${item.text}”……`);
      }
      return;
    }
    if (message.type === "DONE") {
      hideLoading(shadow);
      const parsedInitial = mode === "initial" ? parseInitial(initialAnswer) : null;
      const missedSelection = mode === "initial" && !parsedInitial.structured && !answerNamesSelection(parsedInitial.meaning, item.text);
      if (missedSelection) {
        sendDiagnosticEvent("validation_failed", {
          mode,
          rule: "回答必须聚焦选中词",
          attempt: focusRetry + 1,
          rawOutput: initialAnswer,
        }, message.requestId);
        if (focusRetry < 1) {
          showLoading(shadow, `回答没有聚焦“${item.text}”，正在自动纠正……`);
          requestExplanation("initial", item, focusRetry + 1);
        } else {
          showError(shadow, `模型连续两次没有正确解释“${item.text}”，请重新双击尝试。`, false);
        }
        return;
      }
      if (mode === "simplify") {
        if (!Parser.parseSimple(initialAnswer)) {
          sendDiagnosticEvent("ui_error", { mode, code: "EMPTY_SIMPLIFICATION", message: "简明解释返回空内容" }, message.requestId);
          showError(shadow, "这次没有返回简明解释，可返回原解释查看；不会自动重试。", false);
          return;
        }
        simpleAnswer = initialAnswer;
        renderSimple(shadow, simpleAnswer, true);
        sendDiagnosticEvent("answer_displayed", { mode: "simplify", finalOutput: Parser.parseSimple(simpleAnswer) }, message.requestId);
        setAnswerMode(shadow, "简明版");
        shadow.querySelector(".simple").textContent = "返回原解释";
      } else {
        normalAnswer = initialAnswer;
        renderInitial(shadow, normalAnswer, true);
        sendDiagnosticEvent("answer_displayed", { mode: "initial", finalOutput: parseInitial(normalAnswer),
          rendered: { meaning: shadow.querySelector("[data-field='meaning']")?.textContent || "",
            intent: shadow.querySelector("[data-section='intent']")?.hidden ? "" : shadow.querySelector("[data-field='intent']")?.textContent || "" } }, message.requestId);
        setAnswerMode(shadow, "");
      }
      setBusy(shadow, false, mode);
    }
  }

  function answerNamesSelection(answer, selection) {
    const normalize = (value) => String(value || "")
      .toLocaleLowerCase()
      .replace(/[\s“”'‘’`]/g, "");
    const term = normalize(selection);
    return !!term && normalize(answer).includes(term);
  }

  function closedExpansionLabel(parsed) {
    return parsed.viewKind === "contextual" && !parsed.canExpandGeneral ? "查看依据" : "展开讲讲";
  }

  function renderInitial(shadow, raw, done) {
    const parsed = parseInitial(raw);
    const inDialogue = !!activeDiagnosticItem?.documentContext?.conversation;
    shadow.querySelector('[data-label="meaning"]').textContent = parsed.targetType === "person" ? "这里指谁" : "这里指什么";
    shadow.querySelector('[data-label="intent"]').textContent = inDialogue ? "这段话的作用" : "作者想表达什么";
    shadow.querySelector('.expand').textContent = closedExpansionLabel(parsed);
    const coverageNote = shadow.querySelector('.coverage-note');
    coverageNote.hidden = !(parsed.viewKind === "contextual" && parsed.contextualDetails?.coverage === "loaded_content_only");
    coverageNote.textContent = coverageNote.hidden ? "" : "依据来自页面当前已读取内容，未确认全文完整性。";
    setStreamText(shadow.querySelector("[data-field='meaning']"), parsed.meaning, done);
    const intentSection = shadow.querySelector("[data-section='intent']");
    intentSection.hidden = !parsed.intent?.trim();
    if (!intentSection.hidden) setStreamText(shadow.querySelector("[data-field='intent']"), parsed.intent, done);

    const notice = shadow.querySelector(".notice");
    notice.classList.remove("error");
    notice.removeAttribute("title");
    const notices = {
      multiple_senses: "原文存在多种合理理解，目前无法唯一确定。",
      insufficient_context: "当前原文信息不足，暂时无法可靠确定这里的具体所指。",
      external_knowledge_needed: "当前原文只能确定大致义项，完整解释还需要外部资料。",
      term_unrecognized: "暂时无法可靠识别这个词；它可能是生僻术语、拼写变体或乱码。",
      external_lookup_failed: "需要核对的外部资料暂时没有加载成功，当前仅保留能够可靠说明的范围。",
    };
    const programNotice = parsed.viewKind === "contextual" ? parsed.contextualDetails?.citation_warning || "" : notices[parsed.noticeCode] || "";
    const legacyUncertain = !parsed.structured && parsed.certainty && !["clear", "inferred"].includes(parsed.certainty);
    if (done && (programNotice || legacyUncertain || (!parsed.structured && parsed.note))) {
      notice.hidden = false;
      notice.textContent = programNotice || parsed.note || "当前原文信息不足，暂时无法可靠确定这里的具体所指。";
    } else if (done) {
      notice.hidden = true;
    }
    renderEvidencePanel(shadow, parsed.evidence, parsed.externalSources, done);
  }

  function renderEvidencePanel(shadow, evidence, externalSources, done) {
    const panel = shadow.querySelector(".evidence-panel");
    const list = shadow.querySelector(".evidence-list");
    const toggle = shadow.querySelector(".evidence-toggle");
    const groups = done && EvidenceViewModel
      ? EvidenceViewModel.build(evidence, externalSources, activeDiagnosticItem?.documentContext?.blocks)
      : { page: [], terminology: [], total: 0, summary: "" };
    if (!groups.total) {
      panel.hidden = true;
      list.replaceChildren();
      return;
    }
    panel.hidden = false;
    shadow.querySelector("[data-field='evidence-summary']").textContent = groups.summary;
    list.replaceChildren();
    list.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.querySelector("i").textContent = "⌄";
    toggle.onclick = () => {
      list.hidden = !list.hidden;
      toggle.setAttribute("aria-expanded", String(!list.hidden));
      toggle.querySelector("i").textContent = list.hidden ? "⌄" : "⌃";
    };
    if (groups.page.length) {
      const pageGroup = document.createElement("section");
      pageGroup.className = "evidence-group page-evidence-group";
      const heading = document.createElement("h4");
      heading.textContent = `原文依据 · ${groups.pageGroups.length}组 / ${groups.page.length}个片段`;
      pageGroup.append(heading);
      for (const [groupIndex, group] of groups.pageGroups.entries()) {
        const section = document.createElement("section");
        section.className = "evidence-location-group";
        const title = document.createElement("h4");
        const first = group.items[0];
        title.textContent = `${groupIndex + 1}. ${first.heading_path?.at(-1) || "原文位置"} · ${group.items.length}个片段`;
        section.append(title);
      for (const [index, item] of group.items.entries()) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "evidence-item";
        const meta = document.createElement("span");
        meta.className = "evidence-meta";
        meta.textContent = evidencePositionLabel(item, activeDiagnosticItem, index, false);
        const quote = document.createElement("q");
        quote.textContent = item.quote;
        button.append(meta, quote);
        button.addEventListener("click", () => focusEvidence(item, activeDiagnosticItem));
        section.append(button);
        const context = evidenceReadingContext(item, activeDiagnosticItem);
        if (context) {
          const details = document.createElement("details");
          details.className = "evidence-reading-context";
          const label = document.createElement("summary");
          label.textContent = "阅读上下文（非新增依据）";
          const text = document.createElement("p");
          text.textContent = context;
          details.append(label, text);
          section.append(details);
        }
      }
        pageGroup.append(section);
      }
      list.append(pageGroup);
    }
    if (groups.terminology.length) {
      const sourceGroup = document.createElement("section");
      sourceGroup.className = "evidence-group terminology-source-group";
      const heading = document.createElement("h4");
      heading.textContent = `术语资料 · ${groups.terminology.length}条`;
      sourceGroup.append(heading);
      for (const source of groups.terminology) {
        const link = document.createElement("a");
        link.className = "terminology-source";
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const title = document.createElement("strong");
        title.textContent = source.title;
        const meta = document.createElement("span");
        meta.className = "source-meta";
        meta.textContent = [source.publisher, source.host].filter(Boolean).join(" · ");
        link.append(title, meta);
        if (source.excerpt) {
          const excerpt = document.createElement("span");
          excerpt.className = "source-excerpt";
          excerpt.textContent = source.excerpt;
          link.append(excerpt);
        }
        link.addEventListener("click", () => sendDiagnosticEvent("terminology_source_opened", {
          sourceId: source.source_id,
          host: source.host,
        }, "", activeDiagnosticItem));
        sourceGroup.append(link);
      }
      list.append(sourceGroup);
    }
  }

  function evidencePositionLabel(evidence, item, index, includeHeading = true) {
    const anchorId = item?.documentContext?.selection?.anchor_block_id;
    let relation = "文内依据";
    if (evidence.display_purpose === "current_location") relation = "当前位置";
    else if (evidence.display_purpose === "meaning_support") relation = "核心释义依据";
    else if (evidence.display_purpose === "author_intent_support") relation = "作者意图依据";
    else if (evidence.display_purpose === "context_support") relation = "语境补充";
    else if (evidence.block_id === anchorId && !evidence.display_purpose) relation = "当前位置";
    else if (evidence.role === "direct_support") relation = "原文定义";
    else if (evidence.relation_to_selection === "neighbor") relation = "相邻段落";
    else if (evidence.relation_to_selection === "same_section") relation = "同一章节";
    else if (evidence.relation_to_selection === "term_occurrence") relation = "同词位置";
    const heading = Array.isArray(evidence.heading_path) ? evidence.heading_path.at(-1) : "";
    const turn = [evidence.speaker, evidence.time].filter(Boolean).join(" · ");
    return `${index + 1}. ${relation}${turn ? ` · ${turn}` : heading && includeHeading ? ` · ${heading}` : ""}`;
  }

  function evidenceReadingContext(evidence, item) {
    const element = item?.blockElements?.get?.(evidence.block_id);
    const cell = element?.closest?.("td, th");
    const row = cell?.closest?.("tr");
    if (row) {
      const table = cell.closest("table");
      const firstRow = table?.rows?.[0];
      const header = table?.tHead?.rows?.[0] || (firstRow?.cells?.length &&
        Array.from(firstRow.cells).every(c => c.tagName === "TH") ? firstRow : null);
      const rowText = Array.from(row.cells || []).map(c => cleanText(c.innerText || c.textContent)).join(" | ");
      const headerText = header && header !== row ? Array.from(header.cells || []).map(c => cleanText(c.innerText || c.textContent)).join(" | ") : "";
      if (rowText && rowText.length + headerText.length <= 1000)
        return (headerText ? `表头：${headerText}\n` : "") + `所在行：${rowText}`;
    }
    return EvidenceViewModel.readingContext(evidence, item?.documentContext?.blocks);
  }

  function focusEvidence(evidence, item) {
    const element = item?.blockElements?.get?.(evidence.block_id);
    if (!element?.isConnected) return;
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    clearEvidenceFocus();
    const range = DocumentContext?.findTextQuoteRange?.(element, evidence.quote, element.ownerDocument,
      (evidence.source_offset || 0) + (evidence.source_start || 0));
    if (range && globalThis.CSS?.highlights && globalThis.Highlight) {
      ensureEvidenceHighlightStyle();
      CSS.highlights.set(EVIDENCE_HIGHLIGHT_NAME, new Highlight(range));
    } else {
      ensureEvidenceHighlightStyle();
      element.classList.add(EVIDENCE_FALLBACK_CLASS);
      fallbackEvidenceElement = element;
    }
    sendDiagnosticEvent("evidence_navigated", {
      evidenceId: evidence.evidence_id,
      evidenceIds: (evidence.members || [evidence]).map(e => e.evidence_id).filter(Boolean),
      blockId: evidence.block_id,
      role: evidence.role,
      match: range && globalThis.CSS?.highlights && globalThis.Highlight ? "exact_range" : "element_fallback",
      quote_length: String(evidence.quote || "").length,
      element_length: String(element.innerText || element.textContent || "").length,
    }, activeInitialRequestId, item);
    evidenceHighlightTimer = setTimeout(clearEvidenceFocus, 3500);
  }

  function ensureEvidenceHighlightStyle() {
    let style = document.getElementById("context-explainer-evidence-highlight-style");
    if (style) return;
    style = document.createElement("style");
    style.id = "context-explainer-evidence-highlight-style";
    style.textContent = `::highlight(${EVIDENCE_HIGHLIGHT_NAME}) { background: rgba(112, 176, 255, .38); text-decoration: underline 2px rgba(49, 114, 194, .92); } .${EVIDENCE_FALLBACK_CLASS} { background: rgba(112, 176, 255, .18) !important; outline: 2px solid rgba(49, 114, 194, .72) !important; outline-offset: 4px !important; }`;
    document.documentElement.appendChild(style);
  }

  function clearEvidenceFocus() {
    clearTimeout(evidenceHighlightTimer);
    evidenceHighlightTimer = null;
    globalThis.CSS?.highlights?.delete?.(EVIDENCE_HIGHLIGHT_NAME);
    fallbackEvidenceElement?.classList?.remove?.(EVIDENCE_FALLBACK_CLASS);
    fallbackEvidenceElement = null;
  }

  function renderSimple(shadow, raw, done) {
    const text = Parser.parseSimple(raw);
    setStreamText(shadow.querySelector("[data-field='simple']"), text, done);
  }

  function parseInitial(raw) {
    return Parser.parseInitial(raw);
  }

  async function startExpansion(item, from = "general") {
    const shadow = document.getElementById(HOST_ID)?.shadowRoot;
    if (!shadow || primaryBusy || expansionBusy) return;
    const fields = ["general", "example"];
    const selectedField = fields.includes(from) ? from : "general";
    if (selectedField === "example" && !expandedAnswers.general) return;
    const fieldsToReset = selectedField === "general" ? fields : [selectedField];
    const runId = ++expansionRunId;
    expansionBusy = true;
    disconnectExpansionPorts();

    shadow.querySelector(".expanded").hidden = false;
    shadow.querySelector(".expand").textContent = "收起";
    refreshActionButtons(shadow);
    for (const field of fieldsToReset) {
      expandedAnswers[field] = "";
      setModuleStatus(shadow, field, field === selectedField ? expansionStatus(field) : "通用定义完成后，可点击下方按钮生成例子。");
      const state = shadow.querySelector(`[data-state='${field}']`);
      state.hidden = field !== selectedField;
      state.textContent = "正在生成 · 预览尚未完成检查";
    }

    const runField = async (field) => {
      if (runId !== expansionRunId || !document.getElementById(HOST_ID)) return;
      setModuleStatus(shadow, field, expansionStatus(field));
      try {
        const result = await requestExpansionWithCheck(field, item, runId);
        if (runId !== expansionRunId) return;
        expandedAnswers[field] = result.text;
        const element = shadow.querySelector(`[data-field='${field}']`);
        if (field === "general" && result.outputPolicy !== "concept-general-v1") setTextWithCitationLinks(element, result.text, activeSources);
        else setStreamText(element, result.text, true);
        const state = shadow.querySelector(`[data-state='${field}']`);
        state.hidden = false;
        state.textContent = result.outputPolicy === "concept-general-v1"
          ? "基于模型知识生成 · 未联网检索或独立事实核验"
          : "已完成输出检查 · 不代表逐项事实核验";
        shadow.querySelector(`[data-retry='${field}']`).hidden = true;
        return true;
      } catch (error) {
        if (runId !== expansionRunId || error?.cancelled) return false;
        setModuleError(shadow, field, error?.message || "这部分暂时没有生成成功，可以单独重试。");
        return false;
      }
    };

    if (selectedField === "general") {
      const generalSucceeded = await runField("general");
      if (generalSucceeded && runId === expansionRunId) {
        setModuleStatus(shadow, "example", "需要具体场景时再点击；会新增模型请求。", true);
        const button = shadow.querySelector("[data-retry='example']");
        button.textContent = "举个例子";
        button.hidden = false;
      } else if (runId === expansionRunId) {
        setModuleStatus(shadow, "example", "通用定义完成后再生成这一部分。", true);
      }
    } else {
      await runField(selectedField);
    }

    if (runId === expansionRunId && document.getElementById(HOST_ID)) {
      expansionBusy = false;
      refreshActionButtons(shadow);
    }
  }

  async function requestExpansionWithCheck(field, item, runId) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await requestExpansionModule(field, item, runId, attempt);
        if (field === "general" && result.outputPolicy === "concept-general-v1") {
          if (!result.text.trim()) throw Object.assign(new Error("通用定义未返回正文，可手动重试。"), { noRetry:true });
          sendDiagnosticEvent("module_generated", { field, policy:result.outputPolicy,
            validation:"nonempty_only", finalOutput:result.text, externalSearch:false }, "");
          return result;
        }
        if (result.text.trim().length < 4) throw new Error("这部分没有完整生成，正在重新整理。");
        if (field === "general" && Parser.generalHasContextLeak(result.text, item.text)) {
          throw new Error("通用定义的表达仍带有当前文章口吻，正在重新整理。");
        }
        if (field === "general" && !Parser.generalStartsWithSelection(result.text, item.text)) {
          throw new Error("通用定义没有从用户选中的原词开始，正在重新整理。");
        }
        if (field === "general" && Parser.hasCircularTranslation(result.text)) {
          throw new Error("通用定义出现了无意义的重复翻译，正在重新整理。");
        }
        if (field === "general" && Parser.hasInvalidEnglishGloss(result.text)) {
          throw new Error("英文中文释义的格式不规范，正在统一整理。");
        }
        if (field === "general" && !Parser.englishIdentityMatches(result.text, item.text, activeSenseIdentity || {})) {
          throw new Error("英文全称或中文名称与已核验身份不一致，正在重新整理。");
        }
        if (field === "general" && Parser.generalHasExample(result.text)) {
          throw new Error("通用定义混入了案例，正在删除与举例模块重合的内容。");
        }
        if (field === "general" && Parser.generalHasCaseLeak(result.text, item.text, activeSenseIdentity || {})) {
          throw new Error("通用定义混入了具体公司、产品或项目案例，正在只保留通用知识。");
        }
        if (field === "general") result.text = Parser.formatGeneralParagraphs(result.text);
        if (field === "general" && !Parser.generalWithinLimit(result.text)) {
          throw new Error("通用定义篇幅不足或超过300字，正在调整并保留必要知识点。");
        }
        if (field === "general" && !Parser.generalHasValidPointCount(result.text)) {
          throw new Error("通用定义的知识点过少或过密，正在整理为二至五个独立角度。");
        }
        if (field === "general" && Parser.generalHasRepeatedPoints(result.text)) {
          throw new Error("通用定义存在重复知识点，正在保留不同角度并压缩重复表达。");
        }
        sendDiagnosticEvent("module_validated", { field, attempt: attempt + 1, finalOutput: result.text }, "");
        return result;
      } catch (error) {
        lastError = error;
        sendDiagnosticEvent("validation_failed", {
          mode: `expand_${field}`,
          field,
          attempt: attempt + 1,
          rule: error?.message || "模块校验失败",
        }, "");
        if (error?.cancelled || error?.noRetry || runId !== expansionRunId) throw error;
        if (attempt === 0) {
          const shadow = document.getElementById(HOST_ID)?.shadowRoot;
          if (shadow) setModuleStatus(shadow, field, "第一次结果未通过检查，正在重新整理……");
        }
      }
    }
    throw new Error(lastError?.message || (field === "general"
      ? "专业资料暂未整理成功，可单独重试通用定义。"
      : "这部分暂时没有生成成功，可以单独重试。"));
  }

  function requestExpansionModule(field, item, runId, attempt) {
    return new Promise((resolve, reject) => {
      const mode = `expand_${field}`;
      const requestId = `${Date.now()}-${field}-${attempt}-${Math.random().toString(16).slice(2)}`;
      requestTimings.set(requestId, performance.now());
      if (requestTimings.size > 20) requestTimings.delete(requestTimings.keys().next().value);
      let raw = "";
      let settled = false;
      let port;
      try {
        port = chrome.runtime.connect({ name: "context-explainer" });
        expansionPorts.add(port);
      } catch (_) {
        reject(Object.assign(new Error("插件刚刚更新过，请刷新当前网页后再试。"), { noRetry:true }));
        return;
      }

      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        expansionPorts.delete(port);
        try { port.disconnect(); } catch (_) {}
        callback(value);
      };

      port.onMessage.addListener((message) => {
        if (message.requestId !== requestId || runId !== expansionRunId) return;
        const shadow = document.getElementById(HOST_ID)?.shadowRoot;
        if (!shadow) {
          finish(reject, { cancelled: true });
          return;
        }
        if (message.type === "STATUS" || message.type === "START") {
          setModuleStatus(shadow, field, message.message || expansionStatus(field));
        } else if (message.type === "SOURCES") {
          activeSources = Array.isArray(message.sources) ? message.sources : [];
        } else if (message.type === "SENSE_IDENTITY") {
          activeSenseIdentity = message.identity || null;
        } else if (message.type === "DELTA") {
          raw += message.delta;
          const partial = Parser.parseExpanded(raw)[field];
          const labelOnly = field === "general" && ["通用定义：", "通用定义:", "专业定义：", "专业定义:", "一般来说：", "一般来说:"]
            .some(label => label.startsWith(raw.trim()));
          // Real model deltas, explicitly marked as a preview until checks finish.
          if (partial && !labelOnly) {
            const state = shadow.querySelector(`[data-state='${field}']`);
            state.hidden = false;
            state.textContent = "正在生成 · 预览尚未完成检查";
            setStreamText(shadow.querySelector(`[data-field='${field}']`), partial, false);
            noteVisibleStream(requestId, mode, partial);
          }
        } else if (message.type === "DONE") {
          const text = Parser.parseExpanded(raw)[field];
          const state = shadow.querySelector(`[data-state='${field}']`);
          state.hidden = false;
          state.textContent = "生成结束 · 正在检查输出";
          sendDiagnosticEvent("module_response_received", { mode }, requestId, item);
          finish(resolve, { text, raw, outputPolicy:message.outputPolicy });
        } else if (message.type === "NEED_KEY") {
          finish(reject, new Error("请先点击 Chrome 右上角的语流图标，填写并保存 API Key。"));
        } else if (message.type === "ERROR") {
          finish(reject, Object.assign(new Error(message.message || "这部分暂时没有生成成功。"), { noRetry:true }));
        }
      });
      port.onDisconnect.addListener(() => {
        expansionPorts.delete(port);
        if (!settled && runId === expansionRunId) finish(reject,
          Object.assign(new Error("插件后台连接中断，请刷新网页后重试。"), { noRetry:true }));
      });
      port.postMessage({
        type: "EXPLAIN",
        requestId,
        diagnosticSessionId: activeDiagnosticSessionId,
        mode,
        selection: item.text,
        senseMeaning: parseInitial(normalAnswer).meaning || item.text,
        senseIdentity: activeSenseIdentity,
        generalContext: field === "general" ? Parser.generalDefinitionContext(item, normalAnswer) : undefined,
        generalDefinition: expandedAnswers.general,
        context: "",
        strictGeneral: field === "general" && attempt > 0,
      });
    });
  }

  function expansionStatus(field) {
    if (field === "general") return "正在整理独立于本文的通用定义……";
    return "正在准备一个同义项的例子……";
  }

  function disconnectExpansionPorts() {
    for (const port of expansionPorts) {
      try { port.disconnect(); } catch (_) {}
    }
    expansionPorts.clear();
  }

  function setModuleStatus(shadow, field, text, muted = false) {
    const element = shadow.querySelector(`[data-field='${field}']`);
    const retry = shadow.querySelector(`[data-retry='${field}']`);
    element.textContent = text;
    element.classList.toggle("module-status", true);
    element.classList.remove("module-error");
    element.classList.toggle("muted", muted);
    retry.hidden = true;
  }

  function setModuleError(shadow, field, text) {
    const element = shadow.querySelector(`[data-field='${field}']`);
    element.textContent = text;
    element.classList.add("module-status", "module-error");
    const state = shadow.querySelector(`[data-state='${field}']`);
    state.hidden = false;
    state.textContent = "未完成 · 预览不作为最终结果";
    const retry = shadow.querySelector(`[data-retry='${field}']`);
    retry.hidden = false;
    retry.textContent = field === "general" ? "重试通用定义" : "重试举例";
    sendDiagnosticEvent("module_error", { field, message: text }, "");
  }

  function setTextWithCitationLinks(element, text, sources) {
    element.classList.remove("module-status", "module-error", "muted");
    element.replaceChildren();
    const citationPattern = /\[(\d+)]/g;
    let cursor = 0;
    let match;
    while ((match = citationPattern.exec(text))) {
      element.append(document.createTextNode(text.slice(cursor, match.index)));
      const source = sources[Number(match[1]) - 1];
      if (source?.link) {
        const link = document.createElement("a");
        link.className = "citation";
        link.href = source.link;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[0];
        link.title = [source.title, source.media].filter(Boolean).join("｜") || "打开参考资料";
        element.append(link);
      }
      cursor = match.index + match[0].length;
    }
    element.append(document.createTextNode(text.slice(cursor)));
  }

  function setStreamText(element, text, done) {
    element.classList.remove("module-status", "module-error", "muted");
    element.textContent = text || (done ? "这部分没有生成，请重新尝试。" : "");
    if (!done) {
      const cursor = document.createElement("span");
      cursor.className = "cursor";
      element.appendChild(cursor);
    }
  }

  function toggleExpanded(item) {
    const shadow = document.getElementById(HOST_ID)?.shadowRoot;
    if (!shadow) return;
    const parsed = parseInitial(normalAnswer || initialAnswer);
    if (parsed.viewKind === "contextual" && !parsed.canExpandGeneral) {
      const list = shadow.querySelector('.evidence-list');
      const toggle = shadow.querySelector('.evidence-toggle');
      list.hidden = !list.hidden;
      toggle.setAttribute('aria-expanded', String(!list.hidden));
      return;
    }
    shadow.querySelector(".simple-answer").hidden = true;
    shadow.querySelector(".normal-answer").hidden = false;
    shadow.querySelector(".simple").textContent = "说简单点";
    setAnswerMode(shadow, "");
    if (normalAnswer) renderInitial(shadow, normalAnswer, true);
    const panel = shadow.querySelector(".expanded");
    const button = shadow.querySelector(".expand");
    if (!panel.hidden) {
      panel.hidden = true;
      button.textContent = closedExpansionLabel(parsed);
      return;
    }
    panel.hidden = false;
    button.textContent = "收起";
    paintSelection(item.range, item.rects);
    requestAnimationFrame(() => panel.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    if (!expandedAnswers.general) startExpansion(item, "general");
  }

  function showSimpler(item) {
    const shadow = document.getElementById(HOST_ID)?.shadowRoot;
    if (!shadow) return;
    const simplePanel = shadow.querySelector(".simple-answer");
    const normalPanel = shadow.querySelector(".normal-answer");
    const simpleButton = shadow.querySelector(".simple");

    if (!simplePanel.hidden) {
      simplePanel.hidden = true;
      normalPanel.hidden = false;
      simpleButton.textContent = "说简单点";
      setAnswerMode(shadow, "");
      if (normalAnswer) renderInitial(shadow, normalAnswer, true);
      return;
    }

    shadow.querySelector(".expanded").hidden = true;
    shadow.querySelector(".expand").textContent = closedExpansionLabel(parseInitial(normalAnswer || initialAnswer));
    normalPanel.hidden = true;
    simplePanel.hidden = false;
    simpleButton.textContent = "返回原解释";
    setAnswerMode(shadow, simpleAnswer ? "简明版" : "正在生成简明版");
    const body = shadow.querySelector(".card-body");
    if (body) body.scrollTo({ top: 0, behavior: "smooth" });
    if (simpleAnswer) {
      renderSimple(shadow, simpleAnswer, true);
      setBusy(shadow, false, "simplify");
    } else {
      requestExplanation("simplify", item);
    }
  }

  function setBusy(shadow, busy, mode) {
    primaryBusy = busy;
    refreshActionButtons(shadow);
    shadow.querySelector(".card").classList.toggle("is-streaming", primaryBusy || expansionBusy);
  }

  function refreshActionButtons(shadow) {
    const simple = shadow.querySelector(".simple");
    const expand = shadow.querySelector(".expand");
    simple.disabled = primaryBusy;
    expand.disabled = primaryBusy || expansionBusy;
    for (const button of shadow.querySelectorAll("[data-retry]")) {
      button.disabled = primaryBusy || expansionBusy || (button.dataset.retry === "example" && !expandedAnswers.general);
    }
  }

  function loadingText(mode) {
    if (mode === "simplify") return "正在用一句话讲清核心意思……";
    if (mode === "expand") return "正在检索外部专业资料并核对来源……";
    return "正在读取选区，并结合文章上下文理解……";
  }

  function setAnswerMode(shadow, text) {
    const badge = shadow.querySelector(".answer-mode");
    if (!badge) return;
    badge.textContent = text;
    badge.hidden = !text;
  }

  function showLoading(shadow, text) {
    const status = shadow.querySelector(".loading-status");
    status.hidden = false;
    status.querySelector("[data-field='status']").textContent = text;
  }

  function hideLoading(shadow) {
    clearTimeout(waitingTimer);
    const status = shadow.querySelector(".loading-status");
    if (status) status.hidden = true;
  }

  function showError(shadow, text, needsKey) {
    hideLoading(shadow);
    const field = shadow.querySelector("[data-field='meaning']");
    if (field?.dataset?.preview) {
      field.textContent = "";
      delete field.dataset.preview;
      setAnswerMode(shadow, "");
    }
    const notice = shadow.querySelector(".notice");
    notice.hidden = false;
    notice.textContent = text;
    notice.classList.add("error");
    setBusy(shadow, false, "initial");
    if (needsKey) notice.title = "点击 Chrome 右上角扩展图标进行设置";
  }

  function paintSelection(range, rects) {
    clearSelectionPaint();
    if (globalThis.CSS?.highlights && globalThis.Highlight) {
      let style = document.getElementById("context-explainer-highlight-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "context-explainer-highlight-style";
        style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background: rgba(244, 190, 73, .42); text-decoration: underline 2px rgba(197, 132, 23, .9); }`;
        document.documentElement.appendChild(style);
      }
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      return;
    }
    for (const rect of rects) {
      const mark = document.createElement("div");
      mark.className = HIGHLIGHT_CLASS;
      Object.assign(mark.style, {
        position: "absolute",
        left: `${rect.left + window.scrollX}px`,
        top: `${rect.top + window.scrollY}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        background: "rgba(244, 190, 73, .34)",
        borderBottom: "2px solid rgba(197, 132, 23, .8)",
        pointerEvents: "none",
        zIndex: "2147483645",
      });
      document.documentElement.appendChild(mark);
    }
  }

  function clearSelectionPaint() {
    globalThis.CSS?.highlights?.delete?.(HIGHLIGHT_NAME);
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => node.remove());
  }

  function closeCard(preserveHighlight = false) {
    if (activeDiagnosticSessionId) sendDiagnosticEvent("session_closed", { preserveHighlight }, "");
    document.getElementById(HOST_ID)?.remove();
    activePort?.disconnect();
    expansionRunId += 1;
    expansionBusy = false;
    primaryBusy = false;
    disconnectExpansionPorts();
    activePort = null;
    clearTimeout(waitingTimer);
    clearEvidenceFocus();
    if (!preserveHighlight) clearSelectionPaint();
    activeDiagnosticSessionId = "";
    activeDiagnosticItem = null;
  }

  function noteVisibleStream(requestId, mode, text) {
    if (!text || !requestTimings.has(requestId)) return;
    let metrics = requestStreams.get(requestId);
    if (!metrics) {
      metrics = { firstVisibleMs: Math.round(performance.now() - requestTimings.get(requestId)), visibleUpdates: 0 };
      requestStreams.set(requestId, metrics);
      if (requestStreams.size > 20) requestStreams.delete(requestStreams.keys().next().value);
      sendDiagnosticEvent("first_text_displayed", { mode, firstVisibleMs: metrics.firstVisibleMs }, requestId);
    }
    metrics.visibleUpdates++;
  }

  function sendDiagnosticEvent(eventType, data = {}, requestId = "", item = activeDiagnosticItem) {
    if (["answer_displayed", "module_response_received"].includes(eventType) && requestTimings.has(requestId)) {
      data = { ...data, responseElapsedMs: Math.round(performance.now() - requestTimings.get(requestId)), ...requestStreams.get(requestId) };
      requestTimings.delete(requestId);
      requestStreams.delete(requestId);
    }
    if (!activeDiagnosticSessionId || !chrome.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage({
        type: "DIAGNOSTIC_EVENT",
        sessionId: activeDiagnosticSessionId,
        requestId,
        eventType,
        occurredAt: Date.now(),
        selection: item?.text || "",
        pageTitle: item?.title || document.title,
        localContext: (item?.localContext || cleanText(item?.readingBlock?.innerText || item?.text || "")).slice(0, 1200),
        data,
      });
    } catch (_) {}
  }

  function disarm() {
    armedSelection = null;
    clearTimeout(armTimer);
    clearSelectionPaint();
  }

  function isInsideCard(target) {
    return target?.getRootNode?.().host?.id === HOST_ID || target?.closest?.(`#${HOST_ID}`);
  }

  function pointIsInRects(x, y, rects) {
    return rects.some((rect) => x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3);
  }

  function placeCard(host, item) {
    const maxCardHeight = Math.min(600, window.innerHeight - 24);
    const cardWidth = getAdaptiveCardWidth(item);
    host.style.position = "fixed";
    host.style.right = "12px";
    host.style.left = "auto";
    host.style.width = `${cardWidth}px`;
    host.style.top = `${Math.max(12, Math.min(item.anchorRect.top - 30, window.innerHeight - maxCardHeight - 12))}px`;
    host.style.margin = "0";
    host.style.zIndex = "2147483647";
    document.body.appendChild(host);
  }

  function getAdaptiveCardWidth(item) {
    const minWidth = 300;
    const preferredWidth = 390;
    const pageEdgeGap = 12;
    const textCardGap = 16;
    let readingRight = Number(item?.readingRect?.right) || 0;
    let block = item?.readingBlock;

    // 有些网页把正文包在行内标签中。向上寻找最近的块级阅读容器，
    // 避免只按被选中词语的宽度误判正文右侧空白。
    while (block instanceof Element) {
      const display = getComputedStyle(block).display;
      if (!display.startsWith("inline") && display !== "contents") {
        const rect = block.getBoundingClientRect();
        if (rect.width > 160 && rect.right > 0 && rect.right <= window.innerWidth + 2) {
          readingRight = rect.right;
        }
        break;
      }
      block = block.parentElement;
    }

    const availableRightSpace = window.innerWidth - readingRight - pageEdgeGap - textCardGap;
    return Math.round(Math.max(minWidth, Math.min(preferredWidth, availableRightSpace)));
  }

  function ensureCardVisible(host) {
    requestAnimationFrame(() => {
      if (!host.isConnected) return;
      const rect = host.getBoundingClientRect();
      const unusable = rect.width < 200
        || rect.height < 120
        || rect.right < 0
        || rect.left > window.innerWidth
        || rect.bottom < 0
        || rect.top > window.innerHeight;
      if (!unusable) return;

      host.style.setProperty("display", "block", "important");
      host.style.setProperty("visibility", "visible", "important");
      host.style.setProperty("opacity", "1", "important");
      host.style.position = "fixed";
      host.style.right = "12px";
      host.style.left = "auto";
      host.style.top = "12px";
      host.style.height = "auto";
      host.style.maxHeight = "min(600px, calc(100vh - 24px))";
      host.style.zIndex = "2147483647";
      document.body.appendChild(host);
    });
  }

  function cardStyles() {
    return `<style>
      :host { all: initial; display: block; visibility: visible; opacity: 1; }
      *, *::before, *::after { box-sizing: border-box; }
      .card { position: relative; display: flex; flex-direction: column; width: 100%; height: auto; max-height: min(600px, calc(100vh - 24px)); overflow: hidden; color: #222b32; background: rgba(255, 253, 248, .98); border: 1px solid #dfbd82; border-radius: 15px; box-shadow: 0 16px 42px rgba(57, 44, 25, .18); font: 15px/1.75 "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; }
      .card-header { position: relative; flex: 0 0 auto; padding: 20px 26px 0; background: rgba(255, 253, 248, .99); }
      .card-body { flex: 0 1 auto; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 0 26px 18px; scrollbar-width: thin; scrollbar-color: #c9a567 #f3ecdf; }
      .card-body::-webkit-scrollbar { width: 8px; }
      .card-body::-webkit-scrollbar-track { background: #f3ecdf; border-radius: 8px; }
      .card-body::-webkit-scrollbar-thumb { background: #c9a567; border-radius: 8px; border: 2px solid #f3ecdf; }
      .close { position: absolute; right: 10px; top: 8px; width: 28px; height: 28px; border: 0; background: transparent; color: #a29888; font-size: 23px; cursor: pointer; }
      .term { display: grid; grid-template-columns: 44px 1fr 44px; align-items: center; text-align: center; min-height: 58px; }
      .term strong { overflow-wrap: anywhere; color: #171c20; font: 700 27px/1.35 SimSun, STSong, serif; }
      .quote { color: #d4a04a; font: 58px/.8 Georgia, serif; opacity: .84; }
      .close-quote { align-self: end; }
      .rule { height: 1px; margin: 5px 0 18px; background: #eadbc1; }
      .loading-status { display: flex; align-items: center; gap: 9px; margin: -2px 0 17px; padding: 9px 11px; color: #826b45; background: #faf3e5; border-radius: 8px; font-size: 13px; }
      .loading-status[hidden] { display: none; }
      .answer-mode { width: max-content; margin: -3px 0 11px auto; padding: 3px 9px; color: #9a671c; background: #f8eedc; border: 1px solid #ead4ad; border-radius: 999px; font-size: 12px; line-height: 1.5; }
      .answer-mode[hidden] { display: none; }
      .loading-orbit { position: relative; width: 15px; height: 15px; flex: 0 0 15px; border: 1.5px solid rgba(197, 140, 47, .28); border-radius: 50%; }
      .loading-orbit i { position: absolute; left: 5px; top: -2px; width: 4px; height: 4px; background: #c58c2f; border-radius: 50%; transform-origin: 2px 9px; animation: orbit 1.05s linear infinite; }
      @keyframes orbit { to { transform: rotate(360deg); } }
      .section { margin: 0 0 17px; }
      .section[hidden] { display: none; }
      .evidence-panel { min-width: 0; margin: -2px 0 17px 29px; border-top: 1px solid #eee1cb; }
      .evidence-panel[hidden], .evidence-list[hidden] { display: none; }
      .evidence-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 9px 0 3px; color: #8f651f; background: transparent; border: 0; font: 600 13px/1.6 "Microsoft YaHei UI", sans-serif; cursor: pointer; text-align: left; }
      .evidence-toggle b { font: inherit; }
      .evidence-toggle i { font-style: normal; font-size: 17px; }
      .evidence-list { display: grid; min-width: 0; gap: 10px; margin-top: 5px; }
      .evidence-group { display: grid; min-width: 0; gap: 7px; }
      .evidence-group h4 { margin: 0; color: #80683e; font: 600 12px/1.5 "Microsoft YaHei UI", sans-serif; }
      .evidence-item { min-width: 0; width: 100%; padding: 8px 10px; color: #3b4650; background: #faf6ed; border: 1px solid #eadcc2; border-radius: 7px; cursor: pointer; text-align: left; }
      .evidence-item:hover { border-color: #d5b479; background: #fffaf0; }
      .evidence-meta { display: block; margin-bottom: 3px; color: #9a702b; font: 600 11px/1.5 "Microsoft YaHei UI", sans-serif; }
      .evidence-location-group { display: grid; gap: 7px; margin-bottom: 12px; }
      .evidence-reading-context { color: #756650; font: 12px/1.7 "Microsoft YaHei UI", sans-serif; }
      .evidence-reading-context p { white-space: pre-wrap; overflow-wrap: anywhere; }
      .evidence-item q { display: block; color: #48525b; font: 12px/1.65 "Microsoft YaHei UI", sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; }
      .evidence-item q::before, .evidence-item q::after { color: #b58a45; }
      .terminology-source { display: grid; min-width: 0; gap: 2px; padding: 8px 10px; overflow: hidden; color: #394752; background: #f7f4ed; border: 1px solid #e4dac8; border-radius: 7px; text-decoration: none; }
      .terminology-source:hover { border-color: #caa96e; background: #fffaf0; }
      .terminology-source strong, .source-meta, .source-excerpt { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
      .terminology-source strong { color: #2f3b45; font: 600 12px/1.55 "Microsoft YaHei UI", sans-serif; }
      .source-meta { color: #9a702b; font: 11px/1.5 "Microsoft YaHei UI", sans-serif; }
      .source-excerpt { display: -webkit-box; overflow: hidden; color: #69727a; font: 11px/1.55 "Microsoft YaHei UI", sans-serif; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
      .normal-answer[hidden], .simple-answer[hidden] { display: none; }
      .simple-answer { margin: 0 0 17px; padding: 14px 15px; background: #f8f3e9; border-radius: 9px; }
      .simple-answer h3 { margin-bottom: 8px; }
      .simple-answer p { color: #20282f; font-size: 15px; line-height: 1.75; }
      h3 { margin: 0 0 7px; color: #bf780d; font: 700 17px/1.4 "Microsoft YaHei UI", sans-serif; }
      h3 > span:not([data-label]) { display: inline-block; width: 23px; font-size: 20px; }
      .coverage-note { display: block; color: #81725d; margin: 6px 0; font-size: 12px; line-height: 1.5; }
      .coverage-note[hidden] { display: none; }
      p { margin: 0; overflow-wrap: anywhere; }
      .section p { padding-left: 29px; color: #20282f; }
      .streaming { color: #8d8981; }
      .cursor { display: inline-block; width: 2px; height: 1.05em; margin-left: 2px; vertical-align: -2px; background: #c58c2f; animation: blink .75s steps(1) infinite; }
      @keyframes blink { 50% { opacity: 0; } }
      .notice { margin: 3px 0 15px; padding: 9px 11px; color: #785a27; background: #fff5df; border-left: 3px solid #d7a54c; border-radius: 5px; font-size: 13px; }
      .notice.error { color: #8d3f39; background: #fff0ee; border-color: #cc625a; }
      .expanded { margin: 4px 0 17px; padding: 14px 15px; background: #f8f3e9; border-radius: 9px; }
      .expanded > div + div { margin-top: 10px; }
      h4 { margin: 0 0 2px; color: #9b6b21; font-size: 14px; }
      .expanded p { white-space: pre-wrap; font-size: 14px; }
      .expanded p.module-status { padding: 8px 9px; color: #7d6b4d; background: #fbf6ec; border-left: 2px solid #d7b476; border-radius: 5px; font-size: 13px; }
      .expanded p.module-status.muted { color: #999084; border-color: #d8d0c4; }
      .expanded p.module-error { color: #7e554b; background: #fff7f3; border-color: #c98a78; }
      .module-retry { margin-top: 7px; padding: 5px 10px; color: #9b6414; background: #fffdfa; border: 1px solid #d4ad70; border-radius: 6px; font: 600 12px "Microsoft YaHei UI", sans-serif; cursor: pointer; }
      .module-retry[hidden] { display: none; }
      .citation { margin: 0 1px; color: #9b6414; font-size: .82em; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; vertical-align: super; cursor: pointer; }
      .actions { display: flex; flex: 0 0 auto; gap: 14px; padding: 16px 26px 18px; border-top: 1px solid #eadbc1; background: rgba(255, 253, 248, .99); box-shadow: 0 -8px 18px rgba(91, 69, 36, .05); }
      .actions button { flex: 1 1 0; min-width: 0; height: 44px; border-radius: 8px; font: 700 16px "Microsoft YaHei UI", sans-serif; cursor: pointer; transition: opacity .15s, transform .15s; }
      .actions button:not(:disabled):active { transform: translateY(1px); }
      .actions button:disabled { cursor: default; opacity: .52; }
      .secondary { color: #b6791e; background: #fffdfa; border: 1px solid #d29b48; }
      .primary { color: white; background: linear-gradient(135deg, #d39a37, #bd7f18); border: 1px solid #bd7f18; }
    </style>`;
  }
})();

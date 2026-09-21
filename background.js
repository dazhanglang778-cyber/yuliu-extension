const API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
const FREE_MODELS = ["glm-4.7-flash", "glm-4-flash-250414"];
const sourceCache = new Map();
const DIAGNOSTIC_STORAGE_KEY = "yuliuDiagnosticsV1";
const DIAGNOSTIC_ENABLED_KEY = "diagnosticsEnabled";
const DIAGNOSTIC_MAX_SESSIONS = 100;
const DIAGNOSTIC_MAX_EVENTS = 80;
let diagnosticWriteQueue = Promise.resolve();
let diagnosticsEnabledCache = null;

chrome.storage?.local?.get?.(DIAGNOSTIC_ENABLED_KEY).then((saved) => {
  diagnosticsEnabledCache = saved[DIAGNOSTIC_ENABLED_KEY] === true;
}).catch(() => {});
chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area === "local" && changes[DIAGNOSTIC_ENABLED_KEY]) {
    diagnosticsEnabledCache = changes[DIAGNOSTIC_ENABLED_KEY].newValue === true;
  }
});

chrome.runtime?.onMessage?.addListener?.((message) => {
  if (message?.type !== "DIAGNOSTIC_EVENT") return;
  recordDiagnosticEvent({
    sessionId: message.sessionId,
    requestId: message.requestId,
    eventType: message.eventType,
    selection: message.selection,
    pageTitle: message.pageTitle,
    localContext: message.localContext,
    data: message.data,
  });
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "context-explainer") return;

  port.onMessage.addListener((message) => {
    if (message?.type !== "EXPLAIN") return;
    runRequest(port, message).catch((error) => {
      recordDiagnosticEvent({
        sessionId: message.diagnosticSessionId,
        requestId: message.requestId,
        eventType: "request_error",
        selection: message.selection,
        data: { mode: message.mode, code: error?.code, status: error?.status, message: friendlyError(error) },
      });
      safePost(port, {
        type: "ERROR",
        requestId: message.requestId,
        message: friendlyError(error),
      });
    });
  });
});

async function runRequest(port, request) {
  void recordDiagnosticEvent({
    sessionId: request.diagnosticSessionId,
    requestId: request.requestId,
    eventType: "request_started",
    selection: request.selection,
    pageTitle: request.title,
    localContext: request.localContext,
    data: { mode: request.mode, strictSimple: request.strictSimple, strictGeneral: request.strictGeneral },
  });
  const { bigmodelApiKey = "" } = await chrome.storage.local.get("bigmodelApiKey");
  if (!bigmodelApiKey.trim()) {
    void recordDiagnosticEvent({
      sessionId: request.diagnosticSessionId,
      requestId: request.requestId,
      eventType: "api_key_missing",
      selection: request.selection,
      data: { mode: request.mode },
    });
    safePost(port, {
      type: "NEED_KEY",
      requestId: request.requestId,
    });
    return;
  }

  let sources = [];
  let preparedRequest = request;
  if (request.mode === "expand_general") {
    safePost(port, {
      type: "STATUS",
      requestId: request.requestId,
      message: "正在确定词义并撰写独立于本文的解释……",
    });
    const diagnostics = { sessionId: request.diagnosticSessionId, requestId: request.requestId };
    const plan = await planGeneralDefinition({
      apiKey: bigmodelApiKey.trim(),
      term: request.selection,
      senseMeaning: request.senseMeaning,
      strict: request.strictGeneral,
      diagnostics,
    });
    preparedRequest = {
      ...request,
      senseIdentity: plan.identity,
    };
    safePost(port, {
      type: "SENSE_IDENTITY",
      requestId: request.requestId,
      identity: plan.identity,
    });
    if (plan.needsSearch) {
      safePost(port, { type: "STATUS", requestId: request.requestId, message: "这个词需要核对，正在查找相关资料……" });
      try {
        sources = await searchExternalSources({
          apiKey: bigmodelApiKey.trim(),
          query: buildGeneralSearchQuery(request.selection, plan.identity),
          diagnostics,
          searchStage: "按需核对",
        });
        sources = sources.filter((source) => sourceMatchesIdentity(source, request.selection, plan.identity)).slice(0, 4);
      } catch (error) {
        void recordDiagnosticEvent({ ...diagnostics, eventType: "optional_search_failed", selection: request.selection, data: { message: friendlyError(error) } });
      }
    }
    if (sources.length) {
      safePost(port, {
        type: "SOURCES",
        requestId: request.requestId,
        sources: sources.map(({ title, link, media, publishDate }) => ({ title, link, media, publishDate })),
      });
    }
    // 资料是可选的核对工具，不是生成资格。模型已形成的合格词条可以立即返回。
    // 有资料时再交给模型核对并改写，避免把搜索摘要直接搬进词条。
    if (!sources.length && plan.definition) {
      void recordDiagnosticEvent({ ...diagnostics, eventType: "model_definition_used", selection: request.selection, data: { reason: plan.needsSearch ? "search_unavailable_or_irrelevant" : "retrieval_not_needed" } });
      safePost(port, { type: "DELTA", requestId: request.requestId, delta: `通用定义：${plan.definition}` });
      safePost(port, { type: "DONE", requestId: request.requestId, model: plan.model });
      return;
    }
    safePost(port, { type: "STATUS", requestId: request.requestId, message: sources.length ? "正在核对资料并整理词条……" : "正在生成词条……" });
  }

  const messages = buildMessages(preparedRequest, sources);
  let lastError;

  for (const [modelIndex, model] of FREE_MODELS.entries()) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        void recordDiagnosticEvent({
          sessionId: request.diagnosticSessionId,
          requestId: request.requestId,
          eventType: "model_attempt_started",
          selection: request.selection,
          data: { mode: request.mode, model, attempt },
        });
        await streamModel({
          port,
          requestId: request.requestId,
          apiKey: bigmodelApiKey.trim(),
          model,
          messages,
          maxTokens: request.mode === "expand_general" ? 380 : request.mode === "simplify" ? 180 : 800,
          diagnostics: {
            sessionId: request.diagnosticSessionId,
            requestId: request.requestId,
            selection: request.selection,
            mode: request.mode,
          },
        });
        return;
      } catch (error) {
        lastError = error;
        void recordDiagnosticEvent({
          sessionId: request.diagnosticSessionId,
          requestId: request.requestId,
          eventType: "model_attempt_failed",
          selection: request.selection,
          data: { mode: request.mode, model, attempt, code: error?.code, status: error?.status, hasOutput: error?.hasOutput, message: friendlyError(error) },
        });
        if (!isTemporary(error) || error.hasOutput) throw error;
        if (error.code === "FIRST_TOKEN_TIMEOUT") {
          safePost(port, {
            type: "STATUS",
            requestId: request.requestId,
            message: "主模型响应较慢，正在切换另一个免费模型……",
          });
          break;
        }
        if (attempt < 2) {
          safePost(port, {
            type: "STATUS",
            requestId: request.requestId,
            message: "免费模型当前较忙，正在自动重试……",
          });
          await delay(2000);
        }
      }
    }
    if (!isTemporary(lastError)) break;
    if (modelIndex < FREE_MODELS.length - 1) {
      safePost(port, {
        type: "STATUS",
        requestId: request.requestId,
        message: "主免费模型暂时繁忙，正在切换备用免费模型……",
      });
    }
  }

  throw lastError || new Error("模型暂时没有完成请求");
}

async function planGeneralDefinition({ apiKey, term, senseMeaning, strict = false, diagnostics = {} }) {
  const selected = String(term || "").trim();
  const messages = [
    {
      role: "system",
      content: `你是词典编辑，不是网页摘要器。先用“当前所指”辨别用户原词的义项，再仅凭原词及该义项撰写独立的通用定义。当前所指只能用于辨义；其中的文章场景、作者观点、具体项目、案例、相邻术语绝不能写入定义。可以运用已有知识，不需要先有搜索结果才准解释。遇到新术语或说法不统一时，说明它的一般用法，不能编造唯一正式定义。需要核对的具体事实、专名、罕见或明显不确定的术语，设置needsSearch=true；成熟且有把握的概念不必搜索。仅输出JSON，不要Markdown。`,
    },
    {
      role: "user",
      content: `【用户选中的原词】${selected}\n【当前所指，仅用于选择义项，不得写入词条】${String(senseMeaning || "").slice(0, 320)}\n\n输出JSON：{"neutralIdentity":"不含文章场景的简短义项名称或类别","chineseName":"可靠的中文译名，没有则空","englishFullName":"仅缩写填写可靠英文全称，否则空","conceptType":"普通术语/缩写/专有名称/产品/人物/其他","needsSearch":false,"searchReason":"需核对的原因，无则空","definition":"通用定义正文"}。definition必须从原词“${selected}”开始。英文词或中英混合词先给中文译名再释义；缩写先给英文全称。按不同知识角度换行，不插空行；写2至5个简短段落，总计50至300个可见字符。只写概念的一般含义、特征、机制或边界，不举例，不引用当前文章。${strict ? "上一次词条未通过格式检查，请特别核对开头、译名、分段和篇幅。" : ""}`,
    },
  ];
  let raw;
  try {
    raw = await completeModel({ apiKey, messages, maxTokens: 700 });
  } catch (error) {
    void recordDiagnosticEvent({ ...diagnostics, eventType: "general_plan_failed", selection: selected, data: { message: friendlyError(error) } });
    if (termNeedsDisambiguation(selected, senseMeaning)) {
      error.platformMessage = "这个词可能有不同含义，暂时未能确认当前义项，请单独重试通用定义。";
      throw error;
    }
    // 规划服务不可用时仍尝试直接生成；单个预处理模型不能成为词条的否决器。
    return { identity: { neutralIdentity: selected, chineseName: "", englishFullName: "", conceptType: "" }, needsSearch: false, definition: "", model: "fallback" };
  }
  let value;
  try {
    value = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] || "");
  } catch (_) {
    value = {};
  }
  if (termNeedsDisambiguation(selected, senseMeaning) && !value.neutralIdentity) {
    const error = new Error("多义词的当前义项未确认");
    error.platformMessage = "这个词可能有不同含义，暂时未能确认当前义项，请单独重试通用定义。";
    throw error;
  }
  const identity = {
    neutralIdentity: cleanShortField(value.neutralIdentity || selected),
    chineseName: cleanShortField(value.chineseName),
    englishFullName: cleanShortField(value.englishFullName),
    conceptType: cleanShortField(value.conceptType),
  };
  let definition = String(value.definition || "").replace(/^\s*通用定义[:：]\s*/, "").trim();
  if (!definition.startsWith(selected) || /(?:本文|文中|文章|作者|在这里|这里指)/.test(definition)) definition = "";
  const needsSearch = value.needsSearch === true
    || /^(?:专有名称|产品|人物|缩写)$/.test(identity.conceptType)
    || (termNeedsDisambiguation(selected, senseMeaning) && !definition);
  void recordDiagnosticEvent({ ...diagnostics, eventType: "general_plan_ready", selection: selected, data: { identity, needsSearch, searchReason: value.searchReason || "", hasDraft: !!definition } });
  return { identity, needsSearch, definition, model: "model_draft" };
}

function buildGeneralSearchQuery(term, identity = {}) {
  const selected = String(term || "").trim();
  const qualifier = String(identity.englishFullName || identity.chineseName || identity.neutralIdentity || "").trim();
  if (!qualifier || qualifier.toLocaleLowerCase() === selected.toLocaleLowerCase()) return buildBroadQuery(selected);
  return `${selected} ${qualifier}`.replace(/\s+/g, " ").slice(0, 70);
}

function sourceMatchesIdentity(source, term, identity = {}) {
  const selected = String(term || "").toLowerCase();
  const haystack = `${source.title || ""} ${source.content || ""}`.toLowerCase();
  const label = `${identity.neutralIdentity || ""} ${identity.conceptType || ""}`.toLowerCase();
  if (/^skills?$/.test(selected) && /(?:ai|agent|智能体|模型|模块)/i.test(label)) {
    return /(?:ai|agent|智能体|模型|模块)/i.test(haystack);
  }
  if (/^benchmarks?$/.test(selected) && /(?:评测|评估|测试|evaluation|test)/i.test(label)) {
    return /(?:评测|评估|测试|evaluation|test|model|performance)/i.test(haystack);
  }
  if (/^apple$/.test(selected) && /(?:公司|company|inc|科技)/i.test(label)) {
    return /(?:apple\s+inc|apple\s+developer|苹果公司|technology\s+company)/i.test(haystack);
  }
  return haystack.includes(selected) || !!identity.chineseName && haystack.includes(String(identity.chineseName).toLowerCase());
}

async function getCachedGeneralEvidence({ apiKey, term, senseMeaning, onStatus = () => {}, diagnostics = {} }) {
  const key = `${term}\n${senseMeaning}`.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const cached = sourceCache.get(key);
  if (cached && Date.now() - cached.savedAt < 30 * 60 * 1000) {
    onStatus("正在使用已经核对过的专业资料……");
    void recordDiagnosticEvent({ ...diagnostics, eventType: "evidence_cache_hit", selection: term, data: { identity: cached.evidence.identity, sources: diagnosticSources(cached.evidence.sources) } });
    return cached.evidence;
  }

  // 第一轮严格只搜索用户原词。先用确定性规则判断是否已经有足够证据；
  // 只有确有多义风险时才让模型从候选义项中选择，不能让模型成为单点否决器。
  let broadSources = await searchExternalSources({
    apiKey,
    query: buildBroadQuery(term),
    diagnostics,
    searchStage: "原词检索",
  });
  const requiresDisambiguation = termNeedsDisambiguation(term, senseMeaning);
  void recordDiagnosticEvent({
    ...diagnostics,
    eventType: "ambiguity_triage",
    selection: term,
    data: { requiresDisambiguation, reason: disambiguationReason(term, senseMeaning) },
  });

  let fastIndexes = fastPathSourceIndexes(term, broadSources, senseMeaning);
  if (!fastIndexes.length && !requiresDisambiguation) {
    onStatus(broadSources.length
      ? "正在补充论文、官方文档和专业词条，交叉核对定义……"
      : "原词搜索暂未找到合适资料，正在改查论文、官方文档和专业词条……");
    const recoverySources = await searchExternalSources({
      apiKey,
      query: buildBroadRecoveryQuery(term),
      diagnostics,
      searchStage: "专业资料补充检索",
    });
    broadSources = mergeEvidenceSources(broadSources, recoverySources);
    fastIndexes = fastPathSourceIndexes(term, broadSources, senseMeaning);
  }

  let resolution;
  if (fastIndexes.length) {
    onStatus("专业资料已经形成一致证据，正在直接整理通用定义……");
    resolution = {
      ...emptyResolution(term),
      match: true,
      neutralIdentity: String(term || "").trim(),
      sourceIndexes: fastIndexes,
      resolutionPath: "deterministic_evidence",
    };
  } else {
    onStatus(broadSources.length
      ? requiresDisambiguation
        ? "这个词可能有不同含义，正在从候选义项中选择当前所指……"
        : "直接证据尚不充分，正在做最后一次候选义项核对……"
      : "原词搜索暂未找到合适资料，正在检查其他中性检索方式……");
    resolution = broadSources.length
      ? await resolveSenseIdentity({ apiKey, term, senseMeaning, sources: broadSources, diagnostics })
      : emptyResolution(term);
    resolution.resolutionPath = "candidate_reranking";
  }
  resolution = applyReferentSafeguard(term, senseMeaning, broadSources, resolution);
  let matchedSources = selectMatchedSources(broadSources, resolution.sourceIndexes);

  // 多义词只有在候选义项仍未命中时才做限定检索。限定结果与原结果合并，
  // 避免后一次低质量搜索覆盖前一次已经找到的权威资料。
  if (broadSources.length && (!resolution.match || !matchedSources.length)) {
    const targetedQuery = buildTargetedQuery(term, resolution)
      || buildStructuredFallbackQuery(term);
    onStatus("正在补充更适合当前对象的专业资料……");
    const targetedSources = await searchExternalSources({ apiKey, query: targetedQuery, diagnostics, searchStage: "义项限定检索" });
    if (targetedSources.length) {
      broadSources = mergeEvidenceSources(broadSources, targetedSources);
      const targetedFastIndexes = fastPathSourceIndexes(term, broadSources, senseMeaning);
      resolution = targetedFastIndexes.length && !requiresDisambiguation
        ? {
          ...emptyResolution(term),
          match: true,
          neutralIdentity: String(term || "").trim(),
          sourceIndexes: targetedFastIndexes,
          resolutionPath: "deterministic_recovery",
        }
        : await resolveSenseIdentity({ apiKey, term, senseMeaning, sources: broadSources, diagnostics });
      resolution = applyReferentSafeguard(term, senseMeaning, broadSources, resolution);
      matchedSources = selectMatchedSources(broadSources, resolution.sourceIndexes);
    }
  }

  if (!resolution.match || !matchedSources.length || !resolution.neutralIdentity) {
    const error = new Error("没有找到与当前义项匹配的合格资料");
    error.code = "NO_QUALIFIED_SOURCES";
    error.platformMessage = !broadSources.length
      ? "没有检索到可用的专业资料，可单独重试通用定义。"
      : !resolution.candidateSenses.length
        ? "已找到资料，但候选义项没有整理完整，可单独重试通用定义。"
        : "已找到专业资料，但其中没有与当前所指匹配的义项，可单独重试通用定义。";
    throw error;
  }

  const evidence = {
    identity: {
      // 比对器生成的解释句可能夹带应用语境。通用定义只接收由原词、
      // 可靠中英文名称组成的规范身份，不接收该解释句。
      neutralIdentity: buildCanonicalIdentity(term, resolution),
      chineseName: resolution.chineseName,
      englishFullName: resolution.englishFullName,
      conceptType: resolution.conceptType,
    },
    sources: matchedSources,
    resolutionPath: resolution.resolutionPath || "candidate_reranking",
  };
  sourceCache.set(key, { savedAt: Date.now(), evidence });
  void recordDiagnosticEvent({
    ...diagnostics,
    eventType: "evidence_ready",
    selection: term,
    data: { identity: evidence.identity, resolutionPath: evidence.resolutionPath, sources: diagnosticSources(evidence.sources) },
  });
  return evidence;
}

async function streamModel({ port, requestId, apiKey, model, messages, maxTokens = 800, diagnostics = {} }) {
  const performanceStartedAt = Date.now();
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: true,
  };
  if (model === "glm-4.7-flash") body.thinking = { type: "disabled" };

  const controller = new AbortController();
  let timeoutId = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.name === "AbortError") {
      const timeoutError = new Error("等待首字超过 12 秒");
      timeoutError.code = "FIRST_TOKEN_TIMEOUT";
      timeoutError.platformMessage = "两个免费模型都未能及时响应，请稍后重新尝试。";
      throw timeoutError;
    }
    throw error;
  }

  if (!response.ok) {
    const raw = await response.text();
    clearTimeout(timeoutId);
    const error = new Error(raw || `HTTP ${response.status}`);
    error.status = response.status;
    try {
      const parsed = JSON.parse(raw);
      const detail = parsed.error || parsed;
      error.code = String(detail.code || "");
      error.platformMessage = detail.message || detail.msg || "";
    } catch (_) {}
    throw error;
  }

  safePost(port, {
    type: "START",
    requestId,
    model,
    message: "模型已响应，正在生成解释……",
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let hasOutput = false;
  let sawDone = false;
  let outputText = "";

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    try {
      const packet = JSON.parse(data);
      const delta = packet.choices?.[0]?.delta?.content || "";
      if (!delta) return;
      outputText += delta;
      if (!hasOutput) {
        hasOutput = true;
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => controller.abort(), 30000);
      }
      safePost(port, { type: "DELTA", requestId, delta });
    } catch (_) {}
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
      if (sawDone) {
        try { await reader.cancel(); } catch (_) {}
        break;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(hasOutput ? "生成过程超过 30 秒" : "等待首字超过 12 秒");
      timeoutError.code = hasOutput ? "GENERATION_TIMEOUT" : "FIRST_TOKEN_TIMEOUT";
      timeoutError.platformMessage = hasOutput
        ? "回答生成中断，请重新点击后再试。"
        : "两个免费模型都未能及时响应，请稍后重新尝试。";
      timeoutError.hasOutput = hasOutput;
      throw timeoutError;
    }
    error.hasOutput = hasOutput;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  safePost(port, { type: "DONE", requestId, model });
  void recordDiagnosticEvent({
    ...diagnostics,
    requestId,
    eventType: "model_completed",
    data: { model, mode: diagnostics.mode, elapsedMs: Date.now() - performanceStartedAt, rawOutput: outputText },
  });
  tracePerformance("模型生成", performanceStartedAt, { model, maxTokens });
}

async function resolveSenseIdentity({ apiKey, term, senseMeaning, sources, diagnostics = {} }) {
  const performanceStartedAt = Date.now();
  const sourceText = sources.map((source, index) =>
    `[${index + 1}] ${source.cleanTitle || sanitizeEvidenceTitle(source.title)}\n机构：${source.media || source.domain}\n摘要：${source.cleanContent || sanitizeEvidenceText(source.content)}`
  ).join("\n\n");
  const messages = [
    {
      role: "system",
      content: `你是词典义项整理与来源质量核验器，不负责向用户解释文章。必须先把候选资料归并成彼此不同的候选义项，再用“当前含义”只选择其中一个义项，禁止跳过候选义项池直接判断网页是否可用。义项不仅比较抽象功能，还必须比较词义、实体、所属领域和指称对象；不能只因两者都能笼统称为“能力”“工具”“方法”“标准”或“系统”就判为一致：人的技能与AI/Agent可调用的技能模块、测量基准点与模型评测基准、公司与同名水果、产品与人物都是不同义项。官方文件、标准、论文、大学或研究机构、专业词典、可靠百科、正式技术文档和有明确编辑责任的专业媒体可以采用；匿名内容、UGC问答、论坛帖子、营销软文、内容农场、搜索聚合页和无法判断出处的转载不得采用。最终sourceIndexes必须同时属于被选义项并且来源专业可信。输出中性、词典式义项身份，不能复述具体文章场景、作者观点、用途举例或上下文专属名词；除非某名称本身就是概念不可分割的正式名称。不得缩小概念的完整范围。只输出JSON。`,
    },
    {
      role: "user",
      content: `【原词】\n${term}\n\n【当前含义——只能用于选择义项，不得复制进义项名称、中性身份或检索词】\n${senseMeaning || term}\n\n【原词搜索得到的候选资料】\n${sourceText}\n\n输出JSON：{"candidateSenses":[{"label":"中性词典式义项名称","referentType":"该义项指称的对象类型或所属领域","sourceIndexes":[支持该义项的资料编号]}],"chosenSenseIndex":与当前含义匹配的候选义项序号、没有则为0,"match":true或false,"neutralIdentity":"被选义项的不含文章场景的完整中性身份","chineseName":"被选义项的可靠中文名称，没有则空","englishFullName":"缩写的可靠英文全称，不适用则空","conceptType":"普通术语/缩写/专有名称/产品/人物/其他","sourceIndexes":[既属于被选义项又专业可信的资料编号],"searchTerms":[最多3个用于限定搜索的中性词]}。candidateSenses必须覆盖资料中实际出现的不同义项并合并同义表述；不能为了迎合当前含义编造候选资料里没有的义项。只有chosenSenseIndex有效且存在合格sourceIndexes时match才可为true。没有匹配义项时chosenSenseIndex为0、match为false，并根据当前含义给出不带文章场景的中性检索词。`,
    },
  ];
  const raw = await completeModel({ apiKey, messages, maxTokens: 460 });
  const resolution = parseResolution(raw, term);
  void recordDiagnosticEvent({
    ...diagnostics,
    eventType: "sense_resolved",
    selection: term,
    data: {
      candidateSenses: resolution.candidateSenses,
      chosenSenseIndex: resolution.chosenSenseIndex,
      chosenSense: resolution.chosenSenseLabel,
      neutralIdentity: resolution.neutralIdentity,
      sourceIndexes: resolution.sourceIndexes,
      rawResolution: raw,
    },
  });
  console.info("[语流辨义]", {
    term,
    candidateSenses: resolution.candidateSenses.map((item, index) => `${index + 1}. ${item.label}｜${item.referentType}`),
    chosenSenseIndex: resolution.chosenSenseIndex,
    chosenSense: resolution.chosenSenseLabel,
  });
  tracePerformance("候选义项整理与来源核验", performanceStartedAt, {
    sourceCount: sources.length,
    candidateCount: resolution.candidateSenses.length,
    matched: resolution.sourceIndexes.length,
  });
  return resolution;
}

async function completeModel({ apiKey, messages, maxTokens = 360 }) {
  let lastError;
  for (const model of FREE_MODELS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const body = {
        model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      };
      if (model === "glm-4.7-flash") body.thinking = { type: "disabled" };
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(await response.text() || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("义项比对没有返回内容");
      return content;
    } catch (error) {
      lastError = error;
      if (!isTemporary(error) && error?.name !== "AbortError") break;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  const error = lastError || new Error("义项比对暂时失败");
  error.platformMessage = "专业资料的义项比对暂时失败，可稍后单独重试。";
  throw error;
}

function parseResolution(raw, term) {
  try {
    const match = String(raw || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("没有JSON");
    const value = JSON.parse(match[0]);
    const candidateSenses = Array.isArray(value.candidateSenses)
      ? value.candidateSenses.slice(0, 8).map((item) => ({
        label: cleanNeutralIdentity(item?.label, term),
        referentType: cleanShortField(item?.referentType),
        sourceIndexes: normalizeSourceIndexes(item?.sourceIndexes),
      })).filter((item) => item.label)
      : [];
    const chosenSenseIndex = Number.isInteger(Number(value.chosenSenseIndex))
      ? Number(value.chosenSenseIndex)
      : 0;
    const chosenSense = chosenSenseIndex > 0 ? candidateSenses[chosenSenseIndex - 1] : null;
    const declaredSources = normalizeSourceIndexes(value.sourceIndexes);
    const chosenSources = chosenSense
      ? declaredSources.filter((index) => chosenSense.sourceIndexes.includes(index))
      : [];
    return {
      match: value.match === true && !!chosenSense && chosenSources.length > 0,
      neutralIdentity: cleanNeutralIdentity(value.neutralIdentity, term),
      chineseName: cleanShortField(value.chineseName),
      englishFullName: cleanShortField(value.englishFullName),
      conceptType: cleanShortField(value.conceptType || chosenSense?.referentType),
      sourceIndexes: chosenSources,
      searchTerms: Array.isArray(value.searchTerms)
        ? value.searchTerms.map(cleanShortField).filter(Boolean).slice(0, 3)
        : [],
      candidateSenses,
      chosenSenseIndex: chosenSense ? chosenSenseIndex : 0,
      chosenSenseLabel: chosenSense?.label || "",
    };
  } catch (_) {
    return emptyResolution(term);
  }
}

function normalizeSourceIndexes(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(Number).filter((number) => Number.isInteger(number) && number > 0))]
    : [];
}

function cleanNeutralIdentity(value, term) {
  return String(value || "")
    .replace(/(?:在|就|针对)(?:本文|文中|文章|当前|这里|该段)[^，。；;]*[，。；;]?/g, "")
    .replace(/作者[^，。；;]*[，。；;]?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || String(term || "").trim();
}

function cleanShortField(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
}

function emptyResolution(term) {
  return {
    match: false,
    neutralIdentity: String(term || "").trim(),
    chineseName: "",
    englishFullName: "",
    conceptType: "",
    sourceIndexes: [],
    searchTerms: [],
    candidateSenses: [],
    chosenSenseIndex: 0,
    chosenSenseLabel: "",
  };
}

// 免费模型有时会把共享抽象词（如“能力”）误当成同一义项。
// 这里仅在证据明显描述“人的技能”、当前义项明确描述AI/Agent模块时阻断误配；
// 正文只参与这一步辨义，不会进入通用定义或最终来源摘要。
function applyReferentSafeguard(term, senseMeaning, sources, resolution) {
  const selected = String(term || "").trim();
  const sense = String(senseMeaning || "");
  const corpus = (Array.isArray(sources) ? sources : [])
    .map((source) => `${source.cleanTitle || source.title || ""} ${source.cleanContent || source.content || ""}`)
    .join(" ");
  const isSkillsTerm = /^skills?$/i.test(selected);
  const meansAiModule = /(?:AI|人工智能|模型|Agent(?:ic)?|智能体|工具调用|功能模块|能力模块|技能模块)/i.test(sense);
  const describesHumanSkill = /(?:个人|人类|员工|工作能力|职业|教育|培训|学习者|people|person|human|employee|workplace|education|training|learner)/i.test(corpus);
  const describesAiSkill = /(?:AI\s*agent|agentic|智能体|模型技能|技能模块|skill\s*module|agent\s*skill)/i.test(corpus);
  if (isSkillsTerm && meansAiModule && describesHumanSkill && !describesAiSkill) {
    return {
      ...emptyResolution(selected),
      neutralIdentity: "AI agent skill modules",
      conceptType: "AI系统功能模块",
      searchTerms: ["AI agent skills", "agent skill modules", "AI system skills"],
    };
  }

  const isBenchmarkTerm = /^benchmarks?$/i.test(selected);
  const meansEvaluation = /(?:评估|评价|评测|测试|性能|指标|模型|算法|数据集|任务|accuracy|performance|evaluation|test)/i.test(sense);
  const describesSurveyMark = /(?:地标|标志|标高|测量参考点|永久性特征|survey|geodetic|elevation|landmark|permanent\s+feature)/i.test(corpus);
  const describesEvaluation = /(?:基准测试|性能评估|模型评测|评测基准|benchmark\s+(?:test|suite|dataset)|evaluation|performance\s+(?:test|measure))/i.test(corpus);
  if (isBenchmarkTerm && meansEvaluation && describesSurveyMark && !describesEvaluation) {
    return {
      ...emptyResolution(selected),
      neutralIdentity: "evaluation benchmark",
      chineseName: "评测基准",
      conceptType: "评估标准或测试体系",
      searchTerms: ["benchmark evaluation", "benchmark test", "评测基准"],
    };
  }
  return resolution;
}

function selectMatchedSources(sources, indexes) {
  const unique = [...new Set(indexes)];
  return unique.map((index) => sources[index - 1]).filter(Boolean).slice(0, 4);
}

function fastPathSourceIndexes(term, sources, senseMeaning = "") {
  const value = String(term || "").replace(/\s+/g, " ").trim();
  if (!value || !Array.isArray(sources) || sources.length < 1) return [];
  if (/(?:不是|而不是|并非|而非)/.test(String(senseMeaning || ""))) return [];
  if (/^[A-Z][A-Z0-9.-]{0,7}$/.test(value)) return [];
  if (/^[A-Za-z][A-Za-z.'-]*$/.test(value)) return [];
  if (/^[\u3400-\u9fff]{1,2}$/.test(value)) return [];

  const normalizedTerm = value.toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
  const trustedIndexes = [];
  let hasHighlyTrustedExactMatch = false;
  sources.forEach((source, index) => {
    const haystack = `${source.title || ""} ${source.content || ""}`
      .toLocaleLowerCase()
      .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
    if (normalizedTerm.length >= 4 && haystack.includes(normalizedTerm) && Number(source.score || 0) >= 1) {
      trustedIndexes.push(index + 1);
      if (Number(source.score || 0) >= 4) hasHighlyTrustedExactMatch = true;
    }
  });
  const distinctivePhrase = /\s|[-/]/.test(value) || /[\u3400-\u9fff]{3,}/.test(value);
  return distinctivePhrase && (hasHighlyTrustedExactMatch || trustedIndexes.length >= 2)
    ? trustedIndexes.slice(0, 4)
    : [];
}

function termNeedsDisambiguation(term, senseMeaning = "") {
  const value = String(term || "").replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (/(?:不是|而不是|并非|而非)/.test(String(senseMeaning || ""))) return true;
  if (/^[A-Z][A-Z0-9.-]{0,7}$/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z.'-]*$/.test(value)) return true;
  if (/^[\u3400-\u9fff]{1,2}$/.test(value)) return true;
  return false;
}

function disambiguationReason(term, senseMeaning = "") {
  const value = String(term || "").replace(/\s+/g, " ").trim();
  if (/(?:不是|而不是|并非|而非)/.test(String(senseMeaning || ""))) return "当前所指明确排除了另一个同名对象";
  if (/^[A-Z][A-Z0-9.-]{0,7}$/.test(value)) return "英文缩写通常存在多个展开或领域含义";
  if (/^[A-Za-z][A-Za-z.'-]*$/.test(value)) return "单个英文词可能跨领域或兼具专名与普通词义";
  if (/^[\u3400-\u9fff]{1,2}$/.test(value)) return "短中文词可能存在多个常见义项";
  return "多词术语或较完整名称，优先按精确术语证据处理";
}

function mergeEvidenceSources(...groups) {
  const merged = [];
  const seen = new Set();
  for (const source of groups.flat()) {
    if (!source) continue;
    const key = String(source.link || `${source.domain || ""}|${source.title || ""}`).toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }
  return merged.sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 8);
}

function buildCanonicalIdentity(term, resolution) {
  const original = String(term || "").replace(/\s+/g, " ").trim();
  const extras = [resolution.englishFullName, resolution.chineseName]
    .map(cleanShortField)
    .filter((value) => value && value.toLocaleLowerCase() !== original.toLocaleLowerCase());
  return extras.length ? `${original}（${[...new Set(extras)].join("；")}）` : original;
}

function buildBroadQuery(term) {
  const cleanTerm = String(term || "").replace(/\s+/g, " ").trim();
  return cleanTerm.slice(0, 70);
}

function buildBroadRecoveryQuery(term) {
  const cleanTerm = String(term || "").replace(/\s+/g, " ").trim();
  const english = /[A-Za-z]/.test(cleanTerm);
  return `${cleanTerm} ${english ? "paper official documentation encyclopedia" : "论文 官方文档 专业百科 释义"}`
    .trim()
    .slice(0, 80);
}

function buildStructuredFallbackQuery(term) {
  const cleanTerm = String(term || "").replace(/\s+/g, " ").trim();
  const english = /[A-Za-z]/.test(cleanTerm);
  return `${cleanTerm} ${english ? "technical glossary academic definition" : "专业术语 学术定义 权威释义"}`
    .trim()
    .slice(0, 80);
}

function buildTargetedQuery(term, resolution) {
  const neutralTerms = [
    resolution.chineseName,
    resolution.englishFullName,
    ...(resolution.searchTerms || []),
    resolution.neutralIdentity,
  ]
    .map(cleanShortField)
    .filter(Boolean)
    .join(" ");
  if (!neutralTerms || neutralTerms.toLocaleLowerCase() === String(term || "").trim().toLocaleLowerCase()) {
    return "";
  }
  return buildSenseAwareQuery(term, neutralTerms);
}

function englishOpeningRule(term, conceptType = "", chineseName = "", englishFullName = "") {
  const value = String(term || "").trim();
  const chinese = String(chineseName || "").trim();
  const fullName = String(englishFullName || "").trim();
  if (!/[A-Za-z]/.test(value)) return "";
  const properName = /(?:专有名称|产品|人物|公司|品牌|型号|代码|模型)/.test(String(conceptType || ""));
  if (/^[A-Z][A-Z0-9.-]{1,11}$/.test(value)) {
    if (fullName && chinese) {
      return `选中的是英文缩写。第一段必须严格从“${value}（英文全称 ${fullName}，中文通常译为“${chinese}”）”开始，再给定义；不得改写已核验名称。`;
    }
    if (fullName) {
      return `选中的是英文缩写。第一段必须严格从“${value}（英文全称 ${fullName}）”开始；资料没有提供可靠统一中文名称，不得猜译。`;
    }
    return `选中的是英文缩写。第一段必须按“${value}（英文全称 Reliable English Full Name，中文通常译为“可靠中文名称”）”的结构开头；统一使用中文双引号“”，不得使用单引号。如果资料不能可靠确认全称，不得猜测，应说明缩写存在多义。`;
  }
  if (/\s|[-/]/.test(value)) {
    if (chinese) {
      return `选中的是英文词组。第一段必须严格从“${value}（通常译为“${chinese}”）”开始，再给定义；不得改写已核验中文名称。`;
    }
    return `选中的是英文词组。第一段必须从原词“${value}”开始，再在原词后给中文翻译和定义，写成“${value}（通常译为“……”）是指……”。统一使用中文双引号“”，禁止单引号、中译中和先翻译后开头；没有统一译名时写“可译为”或“可理解为”。`;
  }
  if (properName) {
    return `选中的是英文专有名称“${value}”。不要生硬直译；必须从原名开始，直接用中文说明它是什么。`;
  }
  if (chinese) {
    return `选中的是英文普通词。第一段必须严格从“${value}（中文意为“${chinese}”）”开始；不得改写已核验中文释义。`;
  }
  return `选中的是英文普通词。第一段必须写成“${value}（中文意为“……”）……”；统一使用中文双引号“”，不得写“中文叫”、不得使用单引号。若专业资料明确表明它是专有名称，则不要生硬直译，直接说明其身份。`;
}

function buildMessages(request, sources = []) {
  const selectedTerm = String(request.selection || "").trim();
  const common = `你是一个页面内阅读解释器。唯一需要解释的对象是用户明确选中的“${selectedTerm}”。绝不能改为解释文章主题、页面标题、附近的其他术语或之前解释过的词。即使文章主要讨论另一个概念，也必须始终围绕“${selectedTerm}”回答。不要虚构资料或原文没有的信息。使用中文，不要使用 Markdown。`;
  const citationRule = `只有使用下方外部资料支持可核查事实时，才在对应事实后标注[1]至[${sources.length}]；数字必须对应实际资料，不要集中堆在段末，也不要输出范围之外的角标。角标将由插件自动变成链接。`;
  const chineseGlossRule = englishOpeningRule(
    selectedTerm,
    request.senseIdentity?.conceptType,
    request.senseIdentity?.chineseName,
    request.senseIdentity?.englishFullName,
  );
  let instruction;

  if (request.mode === "simplify") {
    instruction = `请像一个真正懂行的人，给完全没有该行业背景的朋友顺口解释这个词。目标不是把专业解释简单缩短，而是把它翻译成一听就懂的大白话。

写作要求：
1. 优先使用日常动作和直接结果，少用抽象名词堆叠。例如不要写“用于监控和改进产品性能”，应写成“让团队一眼看出产品有没有变好”；不要只说“关键指标”，应说明是“最值得盯的几组数字”。
2. 先讲最核心的“它到底是什么”，有余地再讲“能帮人做什么”；不要罗列三四项专业指标来假装解释。
3. 普通词能说清时不用行业黑话；确实不能省略的术语，要顺手用白话解释。
4. 保留关键事实和当前语境，不得说错、不得儿童化，不用夸张、玩笑或牵强比喻，不增加新事实。
5. 一般控制在25至55个汉字；复杂概念最多70个汉字。只写一个完整句子，不再拆成“这里指什么”和“作者想表达什么”。
6. 成品必须出现“就是”“说白了”“简单说”“相当于”或“可以理解为”之一，让句子真正完成从术语到日常语言的翻译；不要使用“通常译为……指……用于……”的词典句式。

英文普通词可简短写成“${selectedTerm}（中文意为“……”），说白了就是……”；英文术语写成“${selectedTerm}（通常译为“……”），说白了就是……”；统一使用中文双引号，不得写“中文叫”或使用单引号。缩写只在全称可靠且确有助于理解时补充全称。中文翻译服务于理解，不能把回答重新写成专业定义。

${request.strictSimple ? "上一次回答仍然偏专业。本次必须换用普通读者日常会说的话，删掉未解释的指标、类型、机制、优化等抽象词。" : ""}

只输出：
一句话解释：……`;
  } else if (request.mode === "expand_general") {
    instruction = `只生成“通用定义”。这是一份独立于任何当前文章、让人一眼抓住重点的专业微型词条。

必须严格解释【中性义项身份】指定的完整概念范围。你可以用已有知识综合写出释义；外部资料只是核对和补充，不要求照抄，更不能把资料中的特定案例当成概念定义。优先核对官方文档、论文和专业机构资料；百科词条可核对基本含义；专业博客及社区文章可作参考线索，但单篇帖子不能证明具体技术事实。搜索排名不是权威背书，资料必须先与本义项相关。资料不存在或不足时，保守说明一般含义，不捏造专名、年代、数字或公认程度。不得出现“本文、文中、文章、作者、上下文、在这里、这里指”等语境表述。

输出正文的第一个字符必须属于用户选中的原词“${selectedTerm}”，不能先翻译、改写或换成近义词后再开头。${chineseGlossRule}

篇幅和结构是硬限制：不同知识角度必须分别换行，每段只讲一个角度、通常一句。简单常见词写二至三个短段、约90至160字；普通专业术语写三至四个短段、约140至240字；复杂或具有科普价值的概念写四至五个短段、约200至300字；包括角标在内不得超过300个可见字符。不得为了缩短而只留下空泛的一句话，也不得为了凑段数重复表达。

知识角度按概念实际情况选择：第一段必须完成原词、中文名称或翻译与核心定义；其余段落从主要组成或工作机制、关键特征或判断方式、通常用途与适用范围、相近概念的区别、限制或风险中选择有资料支持且最有助于理解的内容。不要机械设置“定义、特点、用途”等小标题。

禁止举例，禁止出现“例如、比如、以……为例”等表达，禁止具体公司、产品、项目、论文或应用案例，禁止罗列代表应用；所有帮助理解的案例只属于单独的“举个例子”模块。除非起源或时间是理解概念不可缺少的一部分，否则省略历史沿革。${sources.length ? citationRule : "没有可核对的外部资料时不要输出角标或暗示已核验。"}

${request.strictGeneral ? `上一次输出没有通过检查。本次必须逐项确认：从“${selectedTerm}”开始；不使用单引号；不出现当前文章口吻；不举例、不列举产品项目；不同知识角度分别换行且不超过300个可见字符。` : ""}

只输出：
通用定义：……`;
  } else if (request.mode === "expand_example") {
    instruction = `只生成“举个例子”。依据【义项身份】和【已核验通用定义】，给出一个能帮助理解同一概念机制的简短例子。不得使用当前文章内容，不得切换到同名的其他对象。虚构示例要使用“例如”表达，不得伪装成真实案例。${chineseGlossRule}

只输出：
举个例子：……`;
  } else {
    instruction = `默认简短、直接。${chineseGlossRule}回答前先自检：解释对象必须是“${selectedTerm}”，不是文章主旨。必须严格输出以下四个独立段落，每个字段名都必须原样保留并另起一行，不得把不同字段合并成一个段落：\n这里指什么：第一句必须以““${selectedTerm}”在这里指”开头，说明当前语境中的具体所指。只有概念要素与文中对象存在明确对应且确实有助于理解时，才用第二句简短说明“什么对应什么”；不要为凑内容强行扩展。本段禁止讨论“作者想表达、强调、提醒或推动什么”。\n作者想表达什么：即使“这里指什么”已经解释清楚，也必须单独填写本段；根据上下文说明作者使用“${selectedTerm}”是在强调、对比、区分、提醒或推动读者理解什么，不能留空，不能重复上一段定义。\n判断：这是内部字段，只能单独填写 clear、inferred、ambiguous、insufficient 之一，绝不能写进前两段。\n提示：这是内部字段，只有存在多种理解、信息不足或必须借助外部资料时才填写；正常情况留空，绝不能写进前两段。`;
  }

  const existing = request.existing
    ? `\n\n【已有解释】\n${request.existing}`
    : "";

  const context = request.mode === "simplify" && request.existing
    ? "请沿用已有解释的含义，不需要重新分析全文。"
    : request.context;

  const sourceText = sources.map((source, index) =>
    `[${index + 1}] ${source.cleanTitle || sanitizeEvidenceTitle(source.title)}\n站点：${source.media || source.domain}\n参考级别：${source.score >= 5 ? "较高" : source.score >= 1 ? "一般" : "线索，需交叉核对"}\n网址：${source.link}\n摘要：${source.cleanContent || sanitizeEvidenceText(source.content)}`
  ).join("\n\n");

  return [
    { role: "system", content: `${common}\n${instruction}` },
    {
      role: "user",
      content: request.mode === "simplify"
        ? `【要解释的词】\n${request.selection}\n\n【已经确认的原解释——只把它改写成一句大白话，不重新分析文章】\n${request.existing || ""}`
        : request.mode === "expand_general"
          ? `【要解释的词】\n${request.selection}\n\n【中性义项身份——已经完成语境比对，不含文章内容】\n中文名称：${request.senseIdentity?.chineseName || ""}\n英文全称：${request.senseIdentity?.englishFullName || ""}\n概念类型：${request.senseIdentity?.conceptType || ""}\n完整义项：${request.senseIdentity?.neutralIdentity || request.selection}\n\n【外部专业资料】\n${sourceText}`
        : request.mode === "expand_example"
            ? `【要解释的词】\n${request.selection}\n\n【中性义项身份】\n${request.senseIdentity?.neutralIdentity || request.senseMeaning || request.selection}\n\n【已核验通用定义】\n${request.generalDefinition || ""}`
            : `【唯一要解释的选中内容——最高优先级】\n${selectedTerm}\n\n【选词所在的局部段落——用于精确定位】\n${request.localContext || ""}\n\n【较完整的文章语境——用于理解作者整体表达，不得替代解释对象】\n${context}\n\n【页面标题——仅供辅助，不是解释对象】\n${request.title || ""}\n\n【输出前必须确认】\n回答的主语和解释对象只能是“${selectedTerm}”。文章主题即使出现次数更多，也绝不能取代“${selectedTerm}”。${existing}`,
    },
  ];
}

async function searchExternalSources({ apiKey, query, diagnostics = {}, searchStage = "外部资料检索" }) {
  const performanceStartedAt = Date.now();
  void recordDiagnosticEvent({ ...diagnostics, eventType: "search_started", data: { stage: searchStage, query } });
  let response;
  try {
    response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        search_query: query,
        search_engine: "search_std",
        search_intent: false,
        count: 12,
        search_recency_filter: "noLimit",
        content_size: "high",
      }),
    });
  } catch (error) {
    void recordDiagnosticEvent({ ...diagnostics, eventType: "search_failed", data: { stage: searchStage, query, elapsedMs: Date.now() - performanceStartedAt, message: error?.message } });
    throw error;
  }

  if (!response.ok) {
    const raw = await response.text();
    void recordDiagnosticEvent({ ...diagnostics, eventType: "search_failed", data: { stage: searchStage, query, elapsedMs: Date.now() - performanceStartedAt, status: response.status, response: raw } });
    const error = new Error(raw || `搜索接口 HTTP ${response.status}`);
    error.status = response.status;
    error.platformMessage = "专业资料检索暂时失败，请稍后再次点击“展开讲讲”。";
    throw error;
  }

  const payload = await response.json();
  const results = Array.isArray(payload.search_result) ? payload.search_result : [];
  const normalized = results
    .map(normalizeSource)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  void recordDiagnosticEvent({
    ...diagnostics,
    eventType: "search_completed",
    data: {
      stage: searchStage,
      query,
      elapsedMs: Date.now() - performanceStartedAt,
      rawResultCount: results.length,
      candidateResults: diagnosticSearchCandidates(results),
      acceptedSources: diagnosticSources(normalized),
    },
  });
  tracePerformance("外部资料检索", performanceStartedAt, { resultCount: results.length, acceptedCount: normalized.length });
  return normalized;
}

function buildSenseAwareQuery(term, senseMeaning) {
  const cleanTerm = String(term || "").replace(/\s+/g, " ").trim();
  const cleanSense = String(senseMeaning || "")
    .replace(/[“”'‘’]/g, "")
    .replace(new RegExp(`^${escapeRegExp(cleanTerm)}(?:在这里)?指(?:的是)?`, "i"), "")
    .replace(/作者(?:想表达|想说|的意思|意在)[\s\S]*$/i, "")
    .replace(/[，,；;]\s*(?:而)?不是[^。！？!?；;]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/[。！？!?]/)[0]
    .slice(0, 46);
  return `${cleanTerm} ${cleanSense} 定义 官方`.replace(/\s+/g, " ").trim().slice(0, 70);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeEvidenceText(value) {
  const sentences = String(value || "")
    .replace(/([。！？!?])\s*/g, "$1\n")
    .replace(/\.\s+(?=[A-Z])/g, ".\n")
    .split(/\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !/(?:例如|比如|举例(?:来说)?|以[^。！？!?]{1,24}为例|for example|\be\.g\.)/i.test(sentence))
    .map((sentence) => sentence
      .replace(/(?:在)?(?:本文|文中|本研究|本报告|这篇文章)(?:中)?[，,:：]?\s*/gi, "")
      .replace(/^(?:本文|本研究|本报告|作者)(?:提出|介绍|讨论|研究|展示|认为|指出|说明)(?:了|的是)?[，,:：]?\s*/i, "")
      .replace(/^(?:this paper|this article|this study|the authors?|we)\s+(?:proposes?|presents?|introduces?|discusses?|studies?|shows?|argues?|describes?)\s*/i, "")
      .replace(/\b(?:in this paper|in this article|in this study|in this context|here)\b[,:]?\s*/gi, "")
      .trim())
    .filter((sentence) => sentence.length >= 12);
  return sentences.join(" ").slice(0, 1200);
}

function sanitizeEvidenceTitle(value) {
  return String(value || "")
    .replace(/^(?:本文|本研究|本报告|这篇文章)(?:提出|介绍|讨论|研究|解读|说明)?[：:，,\s-]*/i, "")
    .replace(/^(?:this paper|this article|this study)\s+(?:proposes?|presents?|introduces?|discusses?|studies?)?[:\s-]*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSource(result) {
  try {
    const url = new URL(result.link);
    const domain = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^https?:$/.test(url.protocol)) return null;
    const title = String(result.title || "").trim();
    const content = String(result.content || "").trim();
    if (!title || content.length < 30) return null;
    return {
      title,
      cleanTitle: sanitizeEvidenceTitle(title),
      content: content.slice(0, 1200),
      cleanContent: sanitizeEvidenceText(content),
      link: url.href,
      media: String(result.media || "").trim(),
      publishDate: String(result.publish_date || "").trim(),
      domain,
      score: sourceScore(domain, title, String(result.media || ""), content, url.protocol),
    };
  } catch (_) {
    return null;
  }
}

function isUgcDomain(domain) {
  return [
    "zhihu.com", "csdn.net", "juejin.cn", "jianshu.com", "cnblogs.com",
    "51cto.com", "sohu.com", "toutiao.com", "bilibili.com", "reddit.com",
    "quora.com", "medium.com", "wordpress.com", "blogspot.com", "tieba.baidu.com",
    "weibo.com", "xiaohongshu.com", "douban.com", "stackexchange.com", "stackoverflow.com",
  ].some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

function sourceScore(domain, title, media, content = "", protocol = "https:") {
  let score = 0;
  const identity = `${domain} ${title} ${media}`.toLowerCase();
  if (/\.(gov|edu)$|\.gov\.|\.edu\.|\.ac\./.test(domain)) score += 8;
  if (/(arxiv\.org|openreview\.net|proceedings\.mlr\.press|acm\.org|ieee\.org|springer\.com|nature\.com|science\.org|sciencedirect\.com|wiley\.com|tandfonline\.com|jstor\.org|ssrn\.com|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|crossref\.org|semanticscholar\.org|usenix\.org|neurips\.cc|icml\.cc|iclr\.cc|aclweb\.org)/.test(domain)) score += 8;
  if (/(标准|研究院|研究所|大学|学院|政府|委员会|协会|基金会|官方|documentation|docs|research|standard|institute|university)/i.test(identity)) score += 4;
  if (/(openai\.com|anthropic\.com|google\.com|microsoft\.com|ibm\.com|nvidia\.com|amazon\.com|aws\.amazon\.com|apache\.org|w3\.org|ietf\.org|iso\.org|developer\.|docs\.|huggingface\.co)/.test(identity)) score += 5;
  if (/baike\.baidu\.com|wikipedia\.org/.test(domain)) score += 2;
  if (/(百科|encyclopedia|glossary)/i.test(identity)) score += 2;
  if (/(博客|论坛|社区|问答|个人|blog|forum|community)/i.test(identity)) score -= 4;
  // UGC 可以提供线索，但不因为搜索命中就升格为权威资料。
  if (isUgcDomain(domain)) score -= 3;
  if (score === 0 && protocol === "https:" && title.trim().length >= 4 && content.trim().length >= 80) score = 1;
  return score;
}

function isTemporary(error) {
  const code = String(error?.code || "");
  return error?.status === 429 || error?.status >= 500 || ["1211", "1302", "1305", "FIRST_TOKEN_TIMEOUT"].includes(code);
}

function tracePerformance(stage, startedAt, details = {}) {
  console.info("[语流性能]", {
    stage,
    elapsedMs: Date.now() - startedAt,
    ...details,
  });
}

function friendlyError(error) {
  const code = String(error?.code || "");
  if (error?.status === 401 || /^100[0-4]$/.test(code)) return "API Key 无效或不完整，请点击插件图标重新填写。";
  if (code === "1113") return "平台提示当前账号余额不足；本插件没有调用付费模型，请检查智谱账号状态。";
  if (code === "1304") return "今天的免费调用次数已经达到上限，请明天再试。";
  if (code === "NO_QUALIFIED_SOURCES") return error.platformMessage;
  if (["CLIENT_TIMEOUT", "FIRST_TOKEN_TIMEOUT", "GENERATION_TIMEOUT"].includes(code)) return error.platformMessage;
  if (error?.status === 429 || ["1302", "1305"].includes(code)) return "两个免费模型目前都很忙，请稍后再试。";
  return error?.platformMessage || "这次解释没有生成，请检查网络后重试。";
}

function safePost(port, message) {
  try { port.postMessage(message); } catch (_) {}
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function diagnosticSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => ({
    title: source.title,
    media: source.media,
    domain: source.domain,
    link: source.link,
    score: source.score,
    excerpt: source.cleanContent || sanitizeEvidenceText(source.content),
  }));
}

function diagnosticSearchCandidates(results) {
  return (Array.isArray(results) ? results : []).slice(0, 12).map((result) => {
    try {
      const url = new URL(result.link);
      const domain = url.hostname.toLowerCase().replace(/^www\./, "");
      const title = String(result.title || "").trim();
      const content = String(result.content || "").trim();
      let decision = "进入专业性与义项核验";
      if (!/^https?:$/.test(url.protocol)) decision = "淘汰：网址协议不受支持";
      else if (isUgcDomain(domain)) decision = "淘汰：UGC 来源";
      else if (!title) decision = "淘汰：缺少标题";
      else if (content.length < 50) decision = "淘汰：有效摘要过短";
      return {
        title,
        media: String(result.media || "").trim(),
        domain,
        link: url.href,
        decision,
        score: decision.startsWith("进入") ? sourceScore(domain, title, String(result.media || ""), content, url.protocol) : null,
        excerpt: sanitizeEvidenceText(content).slice(0, 800),
      };
    } catch (_) {
      return { title: String(result?.title || ""), link: String(result?.link || ""), decision: "淘汰：网址无效" };
    }
  });
}

function sanitizeDiagnosticData(value, key = "", depth = 0) {
  if (depth > 6) return "[内容过深，已省略]";
  if (/(?:api.?key|authorization|bearer|token|secret|password)/i.test(key)) return "[已隐藏]";
  if (typeof value === "string") {
    const limit = /(?:rawOutput|finalOutput|answer|context)/i.test(key) ? 6000 : 1600;
    const redacted = value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已隐藏]");
    return redacted.length > limit ? `${redacted.slice(0, limit)}…[已截断]` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDiagnosticData(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => !/(?:api.?key|authorization|bearer|token|secret|password)/i.test(childKey))
      .map(([childKey, childValue]) => [childKey, sanitizeDiagnosticData(childValue, childKey, depth + 1)]));
  }
  return value;
}

async function diagnosticsAreEnabled() {
  if (!chrome.storage?.local) return false;
  if (typeof diagnosticsEnabledCache === "boolean") return diagnosticsEnabledCache;
  try {
    const saved = await chrome.storage.local.get(DIAGNOSTIC_ENABLED_KEY);
    diagnosticsEnabledCache = saved[DIAGNOSTIC_ENABLED_KEY] === true;
    return diagnosticsEnabledCache;
  } catch (_) {
    return false;
  }
}

function recordDiagnosticEvent(event) {
  if (!event?.sessionId || !chrome.storage?.local) return Promise.resolve();
  diagnosticWriteQueue = diagnosticWriteQueue.then(async () => {
    if (!(await diagnosticsAreEnabled())) return;
    const stored = await chrome.storage.local.get(DIAGNOSTIC_STORAGE_KEY);
    const ledger = stored[DIAGNOSTIC_STORAGE_KEY] && typeof stored[DIAGNOSTIC_STORAGE_KEY] === "object"
      ? stored[DIAGNOSTIC_STORAGE_KEY]
      : { schemaVersion: 1, sessions: [] };
    if (!Array.isArray(ledger.sessions)) ledger.sessions = [];
    let session = ledger.sessions.find((item) => item.id === event.sessionId);
    if (!session) {
      session = {
        id: event.sessionId,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        selection: sanitizeDiagnosticData(event.selection || "", "selection"),
        pageTitle: sanitizeDiagnosticData(event.pageTitle || "", "pageTitle"),
        localContext: sanitizeDiagnosticData(event.localContext || "", "localContext").slice(0, 1200),
        outcome: "运行中",
        events: [],
      };
      ledger.sessions.unshift(session);
    }
    if (event.selection && !session.selection) session.selection = sanitizeDiagnosticData(event.selection, "selection");
    if (event.pageTitle && !session.pageTitle) session.pageTitle = sanitizeDiagnosticData(event.pageTitle, "pageTitle");
    if (event.localContext && !session.localContext) session.localContext = sanitizeDiagnosticData(event.localContext, "localContext").slice(0, 1200);
    session.updatedAt = Date.now();
    session.events.push({
      at: Date.now(),
      type: String(event.eventType || "event"),
      requestId: String(event.requestId || ""),
      data: sanitizeDiagnosticData(event.data || {}, "data"),
    });
    session.events = session.events.slice(-DIAGNOSTIC_MAX_EVENTS);
    if (["request_error", "module_error", "api_key_missing", "ui_error"].includes(event.eventType)) {
      session.hasIssue = true;
      session.outcome = "失败";
    } else if (event.eventType === "validation_failed") {
      session.hasIssue = true;
      if (session.outcome !== "失败") session.outcome = "正在自动纠正";
    } else if (["answer_displayed", "module_validated"].includes(event.eventType) && session.outcome !== "失败") {
      session.outcome = session.hasIssue ? "已完成（曾纠正）" : "已完成";
    } else if (event.eventType === "session_closed" && session.outcome === "运行中") {
      session.outcome = "已关闭";
    }
    ledger.sessions = ledger.sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DIAGNOSTIC_MAX_SESSIONS);
    ledger.schemaVersion = 1;
    ledger.updatedAt = Date.now();
    await chrome.storage.local.set({ [DIAGNOSTIC_STORAGE_KEY]: ledger });
  }).catch((error) => console.warn("[语流诊断] 写入失败", error));
  return diagnosticWriteQueue;
}

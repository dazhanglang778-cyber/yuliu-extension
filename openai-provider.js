(function (root) {
  'use strict';
  const MODELS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-4.1', 'gpt-4.1-mini'];
  const DEFAULT_MODEL = 'gpt-6-astra';
  const isReasoning = model => ['gpt-6-astra','gpt-6.1-sol'].includes(model);
  function fail(message) { const e = new Error(message); e.platformMessage = message; return e; }
  async function complete({apiKey, model = DEFAULT_MODEL, messages, maxTokens = 2100,
    reasoningEffort = 'medium', connectionTest = false, webSearch = false,
    includeMetadata = false, onDelta, fetchImpl = root.fetch, timeoutMs = 120000}) {
    if (!apiKey?.trim()) throw fail('请在语流设置中保存 OpenAI API Key。');
    if (!MODELS.includes(model)) throw fail('请选择设置页支持的 OpenAI 模型。');
    const body = {model, input: messages, store: false,
      max_output_tokens: Math.min(4000, Math.max(16, maxTokens)), stream: !!onDelta};
    if (isReasoning(model)) {
      if (!['low','medium','high'].includes(reasoningEffort)) throw fail('不支持的推理强度。');
      body.reasoning = {effort:connectionTest ? 'low' : reasoningEffort};
      // Responses' output budget includes invisible reasoning, not just visible text.
      body.max_output_tokens = connectionTest ? 1024 : 8192;
    } else body.temperature = 0;
    // Explicit opt-in, used only by the isolated public-concept comparison.
    if (webSearch === true) {
      body.tools = [{type:'web_search',search_context_size:'low'}];
      body.tool_choice = 'required';
      body.max_tool_calls = 2;
      body.include = ['web_search_call.action.sources'];
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}`},
        body: JSON.stringify(body), signal: controller.signal
      });
      if (!response.ok) {
        const labels = {401:'密钥无效或已撤销',403:'当前账号、地区或密钥权限不允许访问',
          404:'当前项目无法访问所选模型',429:'额度不足或请求达到限流，请检查 API 平台余额与 Limits'};
        throw fail(`OpenAI 请求失败（${response.status}）：${labels[response.status] || '服务暂时不可用，请稍后手动重试'}。`);
      }
      let payload;
      if (onDelta) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        const consume = (line) => {
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') return;
          const event = JSON.parse(data);
          if (event.type === 'response.output_text.delta') onDelta(event.delta);
          if (event.type === 'response.completed') payload = event.response;
          if (['error', 'response.failed', 'response.incomplete'].includes(event.type))
            throw fail('OpenAI 生成未完成，请缩短内容或稍后手动重试。');
        };
        while (true) {
          const {done, value} = await reader.read();
          buffer += decoder.decode(value, {stream: !done});
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) consume(line.trim());
          if (done) { if (buffer) consume(buffer.trim()); break; }
        }
      } else payload = await response.json();
      if (!payload || payload.status !== 'completed') throw fail(payload?.incomplete_details?.reason === 'max_output_tokens'
        ? 'OpenAI 达到输出预算（含推理），未完成答案；不会自动重试或降级。' : 'OpenAI 返回内容未完成，未作为完整答案使用。');
      const content = (payload.output || []).filter(x => x.type === 'message')
        .flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('');
      if (!content.trim()) throw fail('OpenAI 没有返回可用文本，可能拒绝了请求。');
      return includeMetadata ? {content, model: payload.model || model, usage: payload.usage,
        ...(webSearch === true ? {search:searchMetadata(payload)} : {}),
        parameters: {provider:'openai',requested_model:model,max_output_tokens:body.max_output_tokens,
          reasoning_effort:body.reasoning?.effort || 'none',temperature:body.temperature,
          stream:body.stream,store:false,...(webSearch === true ? {web_search:true,max_tool_calls:2} : {})}} : content;
    } catch (error) {
      if (error.platformMessage) throw error;
      throw fail(error.name === 'AbortError' ? 'OpenAI 请求超过时限，已停止；不会自动重试。' : 'OpenAI 连接或响应解析失败，请检查网络后手动重试。');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  function safeURL(value) {
    try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
    catch (_) { return ''; }
  }
  function searchMetadata(payload) {
    const calls = [], citations = []; let offset = 0;
    for (const item of payload.output || []) {
      if (item.type === 'web_search_call') {
        const a = item.action || {};
        calls.push({id:item.id,status:item.status,action:a.type,
          queries:Array.isArray(a.queries) ? a.queries.filter(x=>typeof x==='string') : typeof a.query==='string' ? [a.query] : [],
          url:safeURL(a.url), sources:(a.sources || []).map(s=>({url:safeURL(s.url),title:String(s.title || s.url || '')})).filter(s=>s.url)});
      }
      if (item.type === 'message') for (const part of item.content || []) {
        if (part.type !== 'output_text') continue;
        for (const a of part.annotations || []) if (a.type === 'url_citation' && safeURL(a.url)) {
          citations.push({url:safeURL(a.url),title:String(a.title || a.url),
            start: Number.isInteger(a.start_index) ? offset+a.start_index : null,
            end: Number.isInteger(a.end_index) ? offset+a.end_index : null});
        }
        offset += (part.text || '').length;
      }
    }
    return {calls,citations};
  }
  root.YuliuOpenAI = {MODELS, DEFAULT_MODEL, isReasoning, complete, searchMetadata};
  if (typeof module === 'object') module.exports = root.YuliuOpenAI;
})(globalThis);

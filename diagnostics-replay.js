// Explicit user-click only. Loading this page never starts model calls.
(() => {
  const byId = id => document.getElementById(id);
  const run = byId('replayRun'), stop = byId('replayStop'), exp = byId('replayExport');
  const status = byId('replayStatus'), output = byId('replayResults');
  const mode = byId('replayMode');
  const isComparison = () => mode?.value === 'comparison';
  const isModelComparison = () => mode?.value === 'models';
  const latestKey = () => isModelComparison() ? 'yuliuExplanationModelComparisonLatest'
    : isComparison() ? 'yuliuExplanationComparisonLatest' : 'yuliuExplanationReplayLatest';
  let report = null, busy = false, refreshSequence = 0;
  const node = (tag, text) => {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  };
  const seconds = ms => typeof ms === 'number' ? (ms / 1000).toFixed(2) + ' 秒' : '未记录';
  function render() {
    if (!report) return;
    exp.disabled = false;
    const labels = {running:'运行中（若刷新或重启后长期不动，请导出已有结果，不视为完成）',
      completed:'四例已运行，语义质量待评阅', completed_with_errors:'已运行，含异常，需查看具体行',
      stopped:'已停止，保留已运行部分', interrupted:'运行中断'};
    status.textContent = `${labels[report.status] || report.status}：${report.completed_cases}/${report.planned} 例；`
      + `已记录模型请求 ${report.recorded_http_calls} 次。${report.current_term ? '当前：' + report.current_term : ''}`;
    output.replaceChildren();
    for (const row of report.rows) {
      const section = node('article', '');
      section.className = 'evaluation-case';
      section.append(node('h3', row.term));
      if (row.model_outputs) {
        section.append(node('p', `本例顺序：${row.comparison_order}；${row.actual_http_calls} 次请求；总计 ${seconds(row.comparison_elapsed_ms)}`));
        for (const modelOutput of [...row.model_outputs].sort((a,b)=>a.requested_model.localeCompare(b.requested_model))) {
          section.append(node('h4', modelOutput.requested_model),
            node('p', modelOutput.raw_output || modelOutput.error || '没有可见回答'),
            node('p', `${seconds(modelOutput.elapsed_ms)}；返回模型：${modelOutput.model || '未返回'}；引文未经校验，回答质量待人工评阅。`));
        }
        const details=node('details','');
        details.append(node('summary','完整输入、原始回答、参数与错误记录'),node('pre',JSON.stringify(row,null,2)));
        section.append(details);output.append(section);continue;
      }
      section.append(node('h4', '历史实际答案'), node('p', row.historical_answer || '未记录'));
      if (row.natural) {
        section.append(node('h4', 'B · 简洁自然解释（原始输出，未核验，引用也待核对）'),
          node('p', row.natural.raw_output || row.natural.error || '未返回'),
          node('p', `B 耗时 ${seconds(row.natural.elapsed_ms)}；1 次请求；顺序：${row.comparison_order}`));
      }
      const generations = (row.trace.history || []).filter(h => h.stage === 'generation');
      for (const [i, call] of generations.entries()) {
        const draft = call.parsed?.statements;
        const text = Array.isArray(draft) ? draft.map(s => `[${s.part} / ${s.basis}] ${s.text}`).join('\n')
          : call.raw_output || call.error || '无返回';
        section.append(node('h4', `${row.natural ? 'A · 结构化初稿' : '新初稿'}${generations.length > 1 ? ' · 第' + (i + 1) + '次' : ''}`), node('p', text));
      }
      section.append(node('h4', '核验后实际答案'), node('p', row.result?.meaning_here?.text || '没有形成可显示答案'));
      if (row.result?.author_intent?.text) section.append(node('p', '作者想表达什么：' + row.result.author_intent.text));
      const time = row.trace.stage_elapsed_ms || {};
      section.append(node('p', `生成 ${seconds(time.generation)}；核验 ${seconds(time.verification)}；`
        + `结构化流程耗时 ${seconds(row.trace.elapsed_ms)}；本例合计 ${row.actual_http_calls} 次请求。`));
      if (row.trace.error || row.trace.repair_error) section.append(node('p', '异常：' + (row.trace.error || row.trace.repair_error)));
      for (const call of (row.trace.history || []).filter(h => h.stage === 'verification')) {
        const details = node('details', '');
        details.append(node('summary', `核验原始判断（第 ${call.sequence} 次请求）：修改理由与引文`),
          node('pre', call.raw_output || call.error || '无返回'));
        section.append(details);
      }
      const trace = node('details', '');
      trace.append(node('summary', '完整输入、初稿、最终结果与精确引文（未自动判定正确）'),
        node('pre', JSON.stringify(row, null, 2)));
      section.append(trace);
      output.append(section);
    }
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    const key = latestKey();
    const pointer = (await chrome.storage.local.get(key))[key];
    if (!pointer) return;
    const saved = (await chrome.storage.local.get(pointer))[pointer];
    if (sequence !== refreshSequence || !saved) return;
    report = saved;
    render();
  }
  run.addEventListener('click', async () => {
    if (busy) return;
    busy = true; run.disabled = true; stop.disabled = false; if (mode) mode.disabled = true;
    status.textContent = '正在检查四例输入和扩展配置……';
    try {
      const response = await chrome.runtime.sendMessage({type:isModelComparison() ? 'EXPLANATION_MODEL_COMPARE_START'
        : isComparison() ? 'EXPLANATION_COMPARE_START' : 'EXPLANATION_REPLAY_START'});
      await refresh();
      if (!response?.ok) status.textContent = response?.error || '未连接到新重放模块，请重新加载语流扩展并刷新本页；尚不能确认运行状态';
    } catch (_) {
      status.textContent = '与扩展连接中断，请重新打开诊断后台查看已保存部分；不要将中断当作语义失败';
    } finally { busy = false; run.disabled = false; stop.disabled = true; if (mode) mode.disabled = false; }
  });
  stop.addEventListener('click', async () => {
    try {
      const response = await chrome.runtime.sendMessage({type:'EXPLANATION_REPLAY_STOP'});
      status.textContent = response?.ok ? '已请求停止，正在运行的一例结束后保存，不启动下一例。' : '停止请求未送达';
    } catch (_) { status.textContent = '停止请求未送达，请勿重复启动'; }
  });
  exp.addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], {type:'application/json'}));
    const link = document.createElement('a');
    link.href = url; link.download = report.version === 'explanation-model-comparison-v1'
      ? '语流-model-comparison-v1-实测.json' : report.version === 'explanation-generation-comparison-v1'
      ? '语流-generation-comparison-v1-实测.json' : '语流-explanation-v82-实测.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some(k => k === latestKey() || k.startsWith('yuliuExplanationReplay:') || k.startsWith('yuliuExplanationComparison:') || k.startsWith('yuliuExplanationModelComparison:')))
      refresh().catch(() => { status.textContent = '读取结果失败，已运行部分可能仍在本地存储中'; });
  });
  mode?.addEventListener('change', () => {
    report = null; exp.disabled = true; output.replaceChildren();
    status.textContent = '此模式尚无已读取结果，未自动启动模型。';
    run.textContent = isModelComparison() ? '开始两款模型对照' : isComparison() ? '开始四例生成对照' : '开始四例重放';
    refresh().catch(() => { status.textContent = '读取结果失败'; });
  });
  refresh().catch(() => { status.textContent = '读取旧结果失败；请从扩展的诊断后台打开本页'; });
})();

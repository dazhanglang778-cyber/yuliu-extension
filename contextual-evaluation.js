const Suite = globalThis.YuliuContextualSuite;
const STORAGE = document.body.dataset.storage || 'yuliuContextualEvaluationV1';
const DATASET_FILE = document.body.dataset.dataset || 'evaluation/fixtures/contextual-generalization-v1.json';
const list = document.getElementById('cases');
const progress = document.getElementById('progress');
let dataset, report = null, running = false, cancelled = false;
function node(tag, content, className) {
  const el = document.createElement(tag);
  if (content != null) el.textContent = content;
  if (className) el.className = className;
  return el;
}
function section(card, title, content, className) {
  card.append(node('h3', title), node('p', content, className));
}
function details(card, label, content) {
  const box = node('details');
  box.append(node('summary', label), node('pre', content));
  card.append(box);
}
function render(item, row) {
  const old = document.getElementById(item.id);
  const card = node('article', null, 'context-case'); card.id = item.id;
  card.append(node('h2', `${item.selection} · ${item.kind} · ${item.split === 'development' ? '开发案例' : '验收案例'}`));
  section(card, '选中位置', item.blocks[item.anchor]);
  section(card, '期望解释（人工编写，不是模型结果）', item.expected);
  details(card, '查看完整测试文档', item.blocks.map((t, i) => `${i === item.anchor ? '▶ ' : ''}[p${i}] ${t}`).join('\n\n'));
  if (row) {
    const models = [...new Set((row.trace?.history || []).map((h) => h.model).filter((m) => m && m !== 'unreported'))];
    section(card, '执行版本与耗时', `规则：${row.trace?.ruleset_version || '旧记录未记录'}；模型：${models.join(' / ') || '未记录'}；${row.trace?.model_calls ?? '未知'} 次流程调用；${row.meta?.elapsed_ms != null ? (row.meta.elapsed_ms / 1000).toFixed(1) + ' 秒' : '耗时未记录'}`);
    section(card, '实际回答', row.actual?.meaning_here?.text || row.error || '没有收到回答', 'actual');
    if (row.trace?.error) section(card, '失败环节', ({ protocol: '核验格式或编号未完成（不代表内容错误）', content: '内容或依据核验未完成', input: '选区或输入依据异常', service: '模型服务异常' }[row.trace.failure_category] || '旧记录未分类') + '：' + row.trace.error);
    if (row.actual?.author_intent?.text) section(card, '实际表达作用分析', row.actual.author_intent.text);
    section(card, '实际采用的原文依据', (row.actual?.page_evidence || []).map((e) => `[${e.evidence_id}/${e.block_id}] ${e.speaker || ''} ${e.time || ''}\n${e.quote}`).join('\n\n') || '未采用有效原文依据');
    section(card, '自动检查，仅供定位问题', row.checks.failures.length ? row.checks.failures.join('\n') : '基础检查通过；仍需人工确认含义、指代与推断是否正确。');
    if (row.checks.evidenceMissing.length) section(card, '建议核对的证据覆盖', `未采用预期段落：${row.checks.evidenceMissing.map((i) => 'p' + i).join('、')}。可能有替代证据，需要人工核对。`);
    details(card, '查看检索候选、被拒主张及模型核验过程', JSON.stringify({ retrieval: row.retrieval, trace: row.trace, meta: row.meta }, null, 2));
  } else section(card, '实际回答', '尚未运行真实模型。', 'pending');
  if (old) old.replaceWith(card); else list.append(card);
}
async function initialize() {
  dataset = await (await fetch(chrome.runtime.getURL(DATASET_FILE))).json();
  const subsetIds = (document.body.dataset.cases || '').split(',').map((id) => id.trim()).filter(Boolean);
  if (subsetIds.length) {
    const selected = subsetIds.map((id) => dataset.cases.find((item) => item.id === id));
    if (new Set(subsetIds).size !== subsetIds.length || selected.some((item) => !item)) throw new Error('小样本案例编号缺失或重复');
    const subsetName = document.body.dataset.subsetName || 'protocol-smoke';
    if (!/^[a-z0-9-]+$/.test(subsetName)) throw new Error('小样本名称无效');
    dataset = { ...dataset, dataset_id: dataset.dataset_id + '-' + subsetName, cases: selected,
      source: dataset.source + ' 本次仅执行小样本子集，不代表完整评测。' };
  }
  const saved = await chrome.storage.local.get(STORAGE);
  report = saved[STORAGE]?.dataset_id === dataset.dataset_id ? saved[STORAGE] : null;
  for (const item of dataset.cases) render(item, report?.rows?.find((r) => r.id === item.id));
  if (report) progress.textContent = `已加载上次真实模型结果：${report.completed}/${report.planned}，${report.generated_at}`;
  document.getElementById('export').disabled = !report;
}
document.getElementById('run').addEventListener('click', async () => {
  if (running || !dataset) return;
  running = true; cancelled = false;
  document.getElementById('run').disabled = true; document.getElementById('stop').disabled = false;
  document.getElementById('export').disabled = true;
  for (const item of dataset.cases) render(item, null);
  try {
    report = await Suite.run(dataset, {
      send: (message) => chrome.runtime.sendMessage(message), cancelled: () => cancelled,
      progress: ({ item, completed, total }) => { progress.textContent = `正在运行 ${completed + 1}/${total}：${item.kind} — ${item.selection}`; },
      row: (row) => render(dataset.cases.find((i) => i.id === row.id), row),
    });
    await chrome.storage.local.set({ [STORAGE]: report });
    progress.textContent = `已完成 ${report.completed}/${report.planned}。请逐例核对实际回答；不要只看自动检查。`;
  } catch (error) { progress.textContent = `测试未完成：${error.message}`; }
  finally { running = false; document.getElementById('run').disabled = false; document.getElementById('stop').disabled = true; document.getElementById('export').disabled = !report; }
});
document.getElementById('stop').addEventListener('click', () => { cancelled = true; progress.textContent += '（将在当前案例结束后停止）'; });
document.getElementById('export').addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = '语流-' + dataset.dataset_id + '-实测.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
initialize().catch((error) => { progress.textContent = `测试集未加载：${error.message}`; });

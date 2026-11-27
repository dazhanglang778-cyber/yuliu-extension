const Audit = globalThis.YuliuContextualAudit;
const View = globalThis.YuliuContextualAuditView;
const Redaction = globalThis.YuliuContextualRedaction;
const redaction = Redaction.createSession();
const selector = document.getElementById("record"), status = document.getElementById("status");
let records = [], selected = null, prepared = null;
function invalidateRedaction(message = "") {
  redaction.invalidate();
  const check = document.getElementById("reviewed"); check.checked = false; check.disabled = true;
  document.getElementById("export").disabled = true;
  document.getElementById("redacted").textContent = "";
  document.getElementById("mapping").textContent = "";
  document.getElementById("mapping-panel").hidden = true;
  document.getElementById("redaction-warnings").replaceChildren();
  document.getElementById("redaction-status").textContent = message;
}
function invalidatePreparation() {
  prepared = null; invalidateRedaction();
  document.getElementById("preview").disabled = true;
  document.getElementById("suggest").disabled = true;
  document.getElementById("prepared").replaceChildren();
}
function loadRecords(value) {
  const sessions = Array.isArray(value?.sessions) ? value.sessions : [];
  records = sessions.flatMap((s) => Audit.fromSession(s));
  selector.replaceChildren();
  records.forEach((r, i) => {
    const option = document.createElement("option"); option.value = String(i);
    option.textContent = (r.selected || r.input?.selected || "未知选区") + " · " + (r.title || "") + " · " + r.request_id;
    selector.append(option);
  });
  const params = new URLSearchParams(location.search);
  const index = records.findIndex((r) => r.session_id === params.get("session") && r.request_id === params.get("request"));
  if (index >= 0) selector.value = String(index);
  selectRecord();
}
function selectRecord() {
  selected = records[Number(selector.value)] || null;
  invalidatePreparation();
  document.getElementById("prepared-status").textContent = "";
  document.getElementById("manual").value = "";
  document.getElementById("entities").value = "";
  const observed = document.getElementById("observed"); observed.replaceChildren();
  if (selected) observed.append(View.render(selected));
  status.textContent = selected?.input?.evidence?.length
    ? "A 组是该次请求实际送入模型的原文；下方整理 B 组。未重新调用任何模型。"
    : "没有可用输入快照。旧记录无法补回缺失内容；启用诊断后新产生的请求会保留快照。";
  document.getElementById("prepare").disabled = !selected?.input?.evidence?.length;
}
selector.addEventListener("change", selectRecord);
document.getElementById("manual").addEventListener("input", () => {
  invalidatePreparation();
  document.getElementById("prepared-status").textContent = "文本已修改，需要重新生成输入对照。";
});
document.getElementById("prepare").addEventListener("click", () => {
  invalidatePreparation();
  try {
    Audit.validateEvidence(selected?.input?.evidence);
    if (selected.warnings.some((w) => w.code === "PARTIAL_TRACE")) throw new Error("原记录已截断，不可作为精确对照。");
    const evidence = Audit.manualEvidence(selected.input, document.getElementById("manual").value);
    prepared = { input_a: selected.input, input_b: { ...selected.input, evidence, candidates: [] } };
    const panel = document.getElementById("prepared"); panel.replaceChildren();
    View.evidence(panel, evidence);
    document.getElementById("prepared-status").textContent = "已准备 B 组 " + evidence.length + " 个片段。真实模型对照未运行，没有通过率或实测答案。";
    document.getElementById("preview").disabled = false;
    document.getElementById("suggest").disabled = false;
  } catch (error) { document.getElementById("prepared-status").textContent = error.message; }
});
document.getElementById("entities").addEventListener("input", () => invalidateRedaction("替换清单已修改，请重新生成并核对脱敏预览。"));
document.getElementById("suggest").addEventListener("click", () => {
  if (!prepared) return;
  const field = document.getElementById("entities");
  try {
    const existing = new Set(Redaction.parseRules(field.value).flatMap((r) => r.aliases.map((a) => a.toLowerCase())));
    const suggested = Redaction.suggestSpeakers(prepared).split("\n").filter((s) => s && !existing.has(s.slice(3).toLowerCase()));
    if (suggested.length) field.value = [field.value.trim(), ...suggested].filter(Boolean).join("\n");
    invalidateRedaction(suggested.length ? "已添加候选，请核对：它们未必都是人名，也不会自动合并别称。机构、项目仍需自行补充。" : "未找到新的明确发言标签候选；这不代表没有敏感信息，请人工检查。");
  } catch (error) { invalidateRedaction(error.message); }
});
document.getElementById("preview").addEventListener("click", () => {
  invalidateRedaction();
  try {
    const preview = redaction.prepare(prepared, document.getElementById("entities").value);
    document.getElementById("redacted").textContent = JSON.stringify(preview.payload, null, 2);
    document.getElementById("mapping").textContent = preview.mapping.map((m) => m.originals.join(" / ") + " → " + m.replacement + "（" + m.occurrences + " 次）").join("\n");
    document.getElementById("mapping-panel").hidden = !preview.mapping.length;
    const warnings = document.getElementById("redaction-warnings");
    for (const message of preview.warnings) { const p = document.createElement("p"); p.className = "audit-warning"; p.textContent = message; warnings.append(p); }
    document.getElementById("redaction-status").textContent = "已生成本地预览，替换 " + preview.mapping.length + " 组内容。请逐段核对，不代表已完全匿名；模型调用 0 次。";
    document.getElementById("reviewed").disabled = false;
  } catch (error) { document.getElementById("redaction-status").textContent = error.message; }
});
document.getElementById("reviewed").addEventListener("change", (event) => {
  document.getElementById("export").disabled = !redaction.review(event.target.checked);
});
document.getElementById("export").addEventListener("click", () => {
  try {
    const data = redaction.exportData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "语流-脱敏上下文对照准备.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById("redaction-status").textContent = "已保存脱敏副本到本机，未发送到模型。原文和原始诊断记录未修改。";
  } catch (error) { document.getElementById("redaction-status").textContent = error.message; }
});
document.getElementById("import").addEventListener("change", async (event) => {
  try {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) throw new Error("文件超过 5 MB，请导出较少记录后再导入。");
    loadRecords(JSON.parse(await file.text()));
  } catch (error) { status.textContent = "导入失败：" + error.message; }
});
chrome.storage.local.get("yuliuDiagnosticsV1").then((saved) => loadRecords(saved.yuliuDiagnosticsV1))
  .catch((error) => { status.textContent = "读取本地记录失败：" + error.message; });

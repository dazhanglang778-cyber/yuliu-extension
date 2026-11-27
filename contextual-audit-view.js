(function attach(root) {
  const el = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  function section(parent, title, text) {
    const s = el("section", null, "audit-section");
    s.append(el("h4", title), el("p", text || "未记录"));
    parent.append(s);
    return s;
  }
  function details(parent, title, text) {
    const d = el("details");
    d.append(el("summary", title), el("pre", text));
    parent.append(d); return d;
  }
  function evidence(parent, items) {
    for (const e of items || []) details(parent,
      "[" + e.evidence_id + "] " + [e.speaker, e.time, e.block_id].filter(Boolean).join(" · ") + " · " + (e.quote || "").length + " 字符",
      e.quote || "没有引文");
  }
  function render(r) {
    const box = el("section", null, "context-audit");
    box.append(el("h3", "分层诊断 · " + (r.selected || r.input?.selected || "当前选区")));
    box.append(el("p", "这里展示实际输入和输出，不将核验器判断当作正确答案。旧记录缺少的字段不会被补造。", "audit-note"));
    for (const w of r.warnings || []) box.append(el("p", w.text, "audit-warning"));
    const read = section(box, "1 · 用户选中的这一次", r.input?.anchor?.excerpt || "没有保留选区定位快照");
    read.append(el("p", "块：" + (r.input?.exact_selection?.anchor_block_id || "未知")
      + "；块内位置：" + (r.input?.exact_selection?.start_offset ?? "未知")
      + "；读取范围：" + (r.input?.coverage?.coverage || "未知"), "audit-note"));
    const input = section(box, "模型实际收到的原文", (r.input?.evidence?.length || 0) + " 个片段；这不代表它们都支持最终结论。");
    evidence(input, r.input?.evidence);
    const generated = section(box, "2 · 初稿、核验与引用对应", r.claims?.length ? "逐项查看哪些主张保留、哪些被删除，以及绑定了什么原文。" : "尚无可解析初稿");
    if (r.answer_review) {
      const names = { adequate: "已给出有用解释", missing_supported_detail: "仍有原文可支持的关键解释遗漏", insufficient: "当前材料确实不足" };
      section(generated, r.answer_review.source === "review_delivery_state" ? "审阅交付状态（不是语义验收）" : "回答覆盖核验（模型判断，需人工复核）",
        (r.answer_review.source === "review_delivery_state" ? "已按审阅结果组装可展示内容；正确性仍需人工核对。" : names[r.answer_review.status] || "核验字段不完整")
        + (r.selected_attempt ? "；最终采用第 " + r.selected_attempt + " 稿" : ""));
      for (const m of r.answer_review.missing || []) generated.append(el("p", "待核对缺项：" + m.detail + " · " + (m.evidence_ids || []).join("、")));
      if (r.repair_error) generated.append(el("p", "补写未完成，已保留此前可靠结果：" + r.repair_error, "audit-warning"));
    }
    for (const c of r.claims || []) {
      const claim = el("article", null, "audit-claim");
      claim.append(el("strong", c.text), el("p", c.status + " · " + c.basis + (c.reason ? " · " + c.reason : "")));
      if (c.revised) claim.append(el("p", "核验修正后：" + c.final_text));
      if (c.selection_fit) claim.append(el("p", "与选中用法的对应（模型判断）：" + c.selection_fit, "audit-note"));
      if (c.relation_audit) details(claim, "主体、范围与状态核对（模型提取，需人工复核）", JSON.stringify(c.relation_audit, null, 2));
      evidence(claim, c.evidence); generated.append(claim);
    }
    section(box, "3 · 后台最终回答", r.actual || "未记录");
    section(box, "4 · 前端实际可见正文", r.visible || "未记录；离线测试不经过网页卡片");
    if (r.navigation?.length) section(box, "点击依据的实际结果", r.navigation.map((n) =>
      "[" + n.evidenceId + "] " + (n.match === "exact_range" ? "精确引文高亮" : n.match === "element_fallback" ? "整块高亮" : "旧记录未记录匹配方式")
      + "；引用 " + n.quote_length + " 字符；所在元素 " + n.element_length + " 字符").join("\n"));
    const calls = el("details", null, "audit-history");
    if (r.stage_elapsed_ms) box.append(el("p", "生成累计：" + r.stage_elapsed_ms.generation + " ms；审阅累计：" + r.stage_elapsed_ms.verification + " ms", "audit-note"));
    calls.append(el("summary", "展开所有调用和重试 · " + r.model_calls + " 次 · " + (r.elapsed_ms ?? "未知") + " ms"));
    for (const h of r.history || []) {
      const call = section(calls, (h.stage === "generation" ? "生成" : "核验") + " · 第 " + h.attempt + " 次",
        "模型：" + h.model + "；" + h.status + "；" + h.elapsed_ms + " ms");
      details(call, "完整输入消息", JSON.stringify(h.messages || [], null, 2));
      details(call, "原始输出", h.raw_output || h.error || "未记录");
    }
    box.append(calls);
    return box;
  }
  root.YuliuContextualAuditView = { render, evidence };
})(typeof globalThis !== "undefined" ? globalThis : this);

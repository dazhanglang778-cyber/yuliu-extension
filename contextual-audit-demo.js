YuliuAuditReproductions.run().then((report) => {
  document.getElementById("status").textContent = "本地检查：实际选区偏移 " + report.checks.selected_offset
    + "，送给模型的片段从 " + report.checks.actual_quote_start
    + " 开始；是否包含选中的那次出现：" + (report.checks.selected_occurrence_reached_model ? "是" : "否")
    + "；预设空泛回答是否被现有规则通过：" + (report.checks.generic_answer_was_accepted ? "是" : "否")
    + (report.checks.selected_occurrence_reached_model ? "。此样本的选区截取已正确覆盖。" : "。此样本仍有选区截取错位。")
    + (report.checks.generic_answer_was_accepted ? "空泛回答验收问题仍待处理。" : "预设空泛回答未被通过。")
    + "模型返回为预设数据，不是模型实测。";
  document.getElementById("result").append(YuliuContextualAuditView.render(report.review));
}).catch((error) => { document.getElementById("status").textContent = "本地复现失败：" + error.message; });

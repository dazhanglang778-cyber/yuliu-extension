const assert = require("node:assert/strict");
const fs = require("node:fs");

const code = fs.readFileSync(require.resolve("../content.js"), "utf8");

const deltaBlock = code.match(/else if \(message\.type === "DELTA"\) \{([\s\S]*?)\n\s*\} else if \(message\.type === "DONE"\)/)?.[1] || "";
assert.ok(deltaBlock, "必须能找到流式增量处理代码");
assert.ok(!deltaBlock.includes('field !== "general"'), "通用定义应能真实流式预览");
assert.ok(deltaBlock.includes('预览尚未完成检查'), "草稿预览必须明确标记");
assert.ok(!code.includes('await runField("example")'), "通用定义完成后不得自动调用例子");
assert.ok(!code.includes('data-module="mapping"'), "界面不得再展示放到本文中模块");
assert.ok(!code.includes('expand_mapping'), "前端不得再发起放到本文中的请求");
assert.ok(code.includes('const fieldsToReset = selectedField === "general" ? fields : [selectedField]'), "单栏重试不得清空其他成功模块");
assert.ok(!code.includes("Parser.isPlainSimple(initialAnswer)"), "简明解释不得因为固定措辞或字数被自动重试和拦截");
assert.ok(code.includes("Parser.simplificationSource(previousAnswer)"), "简化必须收到完整核心含义与不确定性而非单条主张");

console.log("PASS 通用定义真实流式预览并区分完成状态");
console.log("PASS 展开讲讲只保留通用定义和举个例子");

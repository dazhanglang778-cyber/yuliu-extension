const assert = require("node:assert/strict");
const fs = require("node:fs");

const code = fs.readFileSync(require.resolve("../content.js"), "utf8");

const deltaBlock = code.match(/else if \(message\.type === "DELTA"\) \{([\s\S]*?)\n\s*\} else if \(message\.type === "DONE"\)/)?.[1] || "";
assert.ok(deltaBlock, "必须能找到流式增量处理代码");
assert.ok(deltaBlock.includes('field !== "general"'), "通用定义必须与其他模块采用不同的预览策略");
assert.ok(!/field\s*===\s*"general"[\s\S]{0,240}setStreamText/.test(deltaBlock), "未经检查的通用定义不得进入界面");
assert.ok(code.includes('await runField("example")'), "通用定义完成后应继续生成举例模块");
assert.ok(!code.includes('data-module="mapping"'), "界面不得再展示放到本文中模块");
assert.ok(!code.includes('expand_mapping'), "前端不得再发起放到本文中的请求");
assert.ok(code.includes('const fieldsToReset = selectedField === "general" ? fields : [selectedField]'), "单栏重试不得清空其他成功模块");
assert.ok(code.includes("Parser.hasInvalidEnglishGloss(initialAnswer)"), "一句话解释也必须检查英文中文释义格式");

console.log("PASS 通用定义草稿不会在最终检查前显示");
console.log("PASS 展开讲讲只保留通用定义和举个例子");

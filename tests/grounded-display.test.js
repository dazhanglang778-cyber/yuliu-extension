const assert = require("node:assert/strict");
const fs = require("node:fs");

const content = fs.readFileSync(require.resolve("../content.js"), "utf8");
const background = fs.readFileSync(require.resolve("../background.js"), "utf8");

assert.ok(content.includes('message.type === "GROUNDED_RESULT"'), "前端必须接收校验后的结构化结果");
assert.ok(content.includes("!parsedInitial.structured && !answerNamesSelection"), "结构化结果不得再靠答案复述选词来判断正确性");
assert.ok(!content.includes("const missedIntent"), "作者意图为空不得导致整条解释重试");
assert.ok(/data-section="intent"[\s\S]{0,160}作者想表达什么/.test(content), "可独立隐藏的必须是作者意图板块，而不是核心解释板块");
assert.ok(content.includes('intentSection.hidden = done && !parsed.intent'), "作者意图为空时必须隐藏板块");
assert.ok(content.includes('multiple_senses: "原文存在多种合理理解，目前无法唯一确定。"'));
assert.ok(content.includes('insufficient_context: "当前原文信息不足，暂时无法可靠确定这里的具体所指。"'));
assert.ok(background.includes('request.mode === "initial" && request.documentContext && Grounding'), "结构化文档请求必须走证据校验链");
assert.ok(background.includes("Grounding.validateStructured"));
assert.ok(background.includes("Grounding.fallbackResult"));

console.log("PASS 结构化初始回答只在后台校验后显示");
console.log("PASS 作者意图为空不会拖垮核心语境义");
console.log("PASS 提示语由程序状态映射，不再由模型自由发挥");

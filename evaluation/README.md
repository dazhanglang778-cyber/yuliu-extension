# 语流 0.10 核心语境释义测试集

本目录保存“完整网页或文档 + 用户选中的具体位置 + 人工金标准”，用于评测“这里指什么”，不用于训练模型。

## 目录

- `schema/context-case.schema.json`：测试集的机器可读格式约束。
- `datasets/core-context-v1.json`：首批人工控制案例及金标准。
- `documents/*.html`：可直接在 Chrome 中打开、也可被自动测试读取的完整页面。
- `tests/evaluation-dataset.test.js`：检查选区、证据引文、段落编号和标注完整性。

## 一个案例包含什么

每条案例至少记录：

1. 用户实际选中的文字及其所在段落；
2. 该词在当前位置的正确义项；
3. 允许回答到多具体；
4. 必须包含和禁止出现的信息；
5. 支持判断的原文段落与精确引文；
6. 人工认可的参考解释；
7. 期望确定性及是否允许推断。

这类做法称为 **Golden Dataset（金标准测试集）**。以完整内容为测试单元称为 **Document-grounded Evaluation（文档有据评测）**；专门插入同名实体、远距离定义和无关专名，称为 **Adversarial Testing（对抗测试）**。

## 首批覆盖范围

首批包含 8 份人工控制页面、16 个精确选区，覆盖：

- 普通概念被错误绑定到具体产品；
- 同词在公司、水果、人的技能和 Agent 模块间切换；
- Benchmark 等跨领域多义词；
- 文档开头定义、结尾使用的作者自定义词；
- 中英文混合术语及其中文对应；
- 同一页面中的远距离定义和干扰实体；
- 上下文确实不足时的歧义与保守回答。

首批全部是人工控制内容，便于准确归因。后续按总路线增加真实公开网页及其对抗性变体，最终扩展到 20 份内容、60 至 100 个选区案例。

## 标注纪律

- 先标注原文证据，再写参考解释。
- `maximum_specificity` 只能是 `category`、`named_entity` 或 `exact_variant`。
- `must_not_include` 优先记录曾经真实出现过的错误内容。
- 证据引文必须是对应正文块的连续原文，不能由标注者改写。
- 页面标题只能辅助辨义，不能成为具体实体指认的唯一证据。
- 更新金标准时必须说明原因，不能为了让当前模型通过而降低标准。

## 批量评测

第 9 步已经接入批量评测器，分成三种运行方式：

```powershell
# 只评测本地RAG能否召回正确证据，不调用模型
node evaluation/run-batch.js --retrieval-only --output evaluation/results/retrieval-baseline-v1

# 评分一份已有预测文件
node evaluation/run-batch.js --predictions evaluation/results/predictions.json --output evaluation/results/scored

# 使用智谱模型完成整套实时语义评测
$env:BIGMODEL_API_KEY="你的密钥"
node evaluation/run-batch.js --live --output evaluation/results/live
Remove-Item Env:BIGMODEL_API_KEY
```

实时评测默认执行全部案例。调试时可加 `--case harness-later-use` 或 `--limit 3`。密钥只从临时环境变量读取，不写入预测、报告或仓库。

每次运行同时生成 JSON 机器报告和 Markdown 人读报告。核心指标包括：义项正确率、确定性正确率、证据有效率、关键证据支持率、全部金标准证据召回率、无依据具体化率、提示误报率和首次成功率。

失败分类及对应责任模块见 `failure-taxonomy.md`。其中 `RETRIEVAL_MISS` 表示正确证据没有进入候选集；`GENERATION_IGNORED_RETRIEVED_EVIDENCE` 表示 RAG 已经找到正确证据，但 WSD/生成阶段没有采用。两者不得混为同一种“模型答错”。

## 从开发诊断后台运行真实评测

第 10 步把同一套评测器接入了扩展内的开发诊断后台，不再需要把 API Key 复制到命令行：

1. 在 `chrome://extensions` 中重新加载语流。
2. 打开语流设置页，进入“开发诊断后台”。
3. 在“核心语义实时评测”中点击“开始完整评测”。
4. 等待 16 个案例依次完成；需要中止时点击“完成当前案例后停止”。
5. 查看发布门槛、指标和失败类型，也可以导出不含密钥的 JSON 报告。

评测由扩展后台读取已经保存在本机扩展存储中的智谱 API Key。密钥不会传给诊断页面、测试案例或导出报告。案例采用顺序执行，避免并发请求加剧免费模型限流；每例最多进行一次结构修复。后台显示“测试管线可运行”并不等于发布门槛通过，只有真实 16 例报告达到门槛才算完成第 10 步。

# 语流核心语境释义失败分类

失败码用于确定应该修改哪个模块，不用于向普通用户展示。

| 失败码 | 含义 | 优先检查模块 |
| --- | --- | --- |
| `NO_OUTPUT` / `OUTPUT_SCHEMA_FAILURE` | 没有结果或结构不合法 | 模型请求、结构化输出、修复链 |
| `SELECTION_MISMATCH` | 回答对象不是当前选中词 | 选区定位、请求隔离 |
| `RETRIEVAL_MISS` | 正确支持证据没有进入候选集 | 文档解析、全文RAG检索 |
| `MISSING_KEY_INFORMATION` | 没覆盖金标准要求的关键语义 | WSD、生成提示、证据利用 |
| `REFERENT_TYPE_MISMATCH` | 公司、产品、方法、普通概念等对象类型判断错误 | WSD、实体链接 |
| `UNJUSTIFIED_SPECIFICITY` | 输出比原文证据允许的程度更具体 | 具体化闸门、grounding |
| `FORBIDDEN_CONTENT` | 混入已知错误义项或无关实体 | WSD、请求隔离、grounding |
| `EVIDENCE_BLOCK_NOT_FOUND` | 引用了当前快照不存在的段落 | 证据校验、请求隔离 |
| `EVIDENCE_QUOTE_MISMATCH` | 引文不是对应段落的连续原文 | 引文校验、模型修复 |
| `EVIDENCE_MISS` | 答案没有采用能够支持正确义项的金标准证据 | 生成与证据选择 |
| `GENERATION_IGNORED_RETRIEVED_EVIDENCE` | RAG已召回正确证据，但生成阶段没有采用 | WSD、生成提示 |
| `CERTAINTY_MISMATCH` | clear、inferred、ambiguous、insufficient 判断错误 | 确定性决策 |
| `NOTICE_FALSE_POSITIVE` | 明确案例错误显示警告 | notice状态机 |
| `NOTICE_STATE_MISMATCH` | 歧义或信息不足时的提示状态不正确 | notice状态机 |

判断顺序：先看解析与选区，再看检索召回，再看义项与证据利用，最后看显示状态。禁止看到最终答案错误就直接给提示词追加特例。

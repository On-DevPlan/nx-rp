# doc-dir-zg-recall：独立 doc 目录 + zvec-grep 召回（2026-09-22 v1）

> **Date:** 2026-09-22
> **Topic:** teamai-context-enhance
> **类型:** intent doc (预测设计)
> **版本:** v1（首版，试验）
> **状态:** 试验
> **核心问题:** nx-rp 用一个独立目录做 doc 目录（知识语料），检索/召回直接复用 zvec-grep——哪些 zg 能直接用，哪些 nx-rp 必须自己写

## 原始请求（用户原话）

> 我在思考一个东西 使用一个单独的目录作为doc目录 然后结合zvec-grep 进行召回控制 方案如何 哪些可以zg直接复用 哪些需要nx-rp自己写

## 轻微重写版（仅修错别字与口癖）

> 我在思考一个东西：使用一个单独的目录作为 doc 目录，然后结合 zvec-grep 进行召回控制。这个方案如何？哪些可以 zg 直接复用？哪些需要 nx-rp 自己写？

## 本版要验证的假设

zg 对「独立的 markdown 知识目录」场景开箱可用度足够高（nx-rp 侧只需薄薄一层编排），不需要自己写检索。

## 一、方案评估：可行，且分工清晰

「单独 doc 目录 + zg 检索」正好落在 zg 的甜区：

1. **Markdown 是 zg 的一等公民**——`MarkdownExtractor`（src/engine/extraction/markdown/extractor.ts）按标题分节抽取，长节自动切窗（maxChunkChars + overlapChars），代码围栏感知（fenceLines 不切断代码块），每个 fragment 带 breadcrumb（标题路径）与行号范围。`.claude/repo/_self/` 的知识文档正是这种形态。
2. **知识库场景 zg 官方明说支持**——03-mcp.md 原文：同一套规则适用于 "documentation, books, research material, meeting notes, knowledge-base exports, manuals"。doc 目录不需要任何特殊处理。
3. **nx-rp 的现有职责（登记/面板/工作流）与检索正交**——zg 补的正是 compare 文档里 nx-rp 缺的「检索层」，且是外部进程方式补，不内嵌。

## 二、zg 直接复用的部分（nx-rp 零实现）

| 能力 | 用法 | 备注 |
| --- | --- | --- |
| 索引构建与增量 | `zg --index`（首次）；例行 `--refresh background/wait/off` 三档 | doc 目录一次索引，之后 daemon watch 增量 |
| 混合检索 | `zg "<语义查询>"`（hybrid = BM25/FTS + 向量 + RRF 融合） | 中文知识文档建议配 `local/potion-multilingual-128m`（101 语言静态模型，默认 potion-code 偏代码） |
| 精确词法 | `zg --fts "关键词"` / `zg --rg -F "原文"` | rg 路免索引、穷尽式，兜底幻觉 |
| 输出预算控制 | `--limit N --preview short` / 非 TTY 自动 compact | 召回「控制」的第一层就是这里——喂给 agent 的上下文字节可控 |
| 新鲜度标注 | 结果带 `fresh`/`possibly_stale` | agent 可以据此决定信不信 |
| MCP 端点 | `zg --install` 后 `http://127.0.0.1:7999/mcp` 暴露 `zvec_grep_search` 工具 | Claude Code 直连；`root` 参数指 doc 目录绝对路径 |
| 质量护栏 | RRF 融合、渐进召回深度（200→2000）、符号类型过滤 | 全部内建 |

## 三、nx-rp 必须自己写的部分

### 1. doc 目录的生命周期管理（zg 完全不管）

zg 的世界观是「workspace 即仓库」，它不知道「这个目录是 nx-rp 登记的知识库」。nx-rp 负责：

- **登记**：doc 目录作为 cwd-scope 资源入 store.json（现有 link/doc 机制的自然延伸），记录 root 绝对路径
- **索引引导**：`nx-rp doc-index <dir>` 薄命令 = 校验目录存在 + 调 `zg --index --embedding ... --root`（或让用户直接跑 zg，nx-rp 只做状态探测）
- **状态查询**：`zg --status` 的结果解析进面板（索引存在？模型？文件数？stale？）

### 2. 召回「控制」层——这是设计的核心增量

zg 返回 ranked 结果，但「何时召回、召回什么、喂多少」是 nx-rp 的职责：

| 控制点 | nx-rp 要写的 |
| --- | --- |
| **何时召回** | workflow 原语：`ctx.recall(query)` 编排步骤——agent 写 .mjs 时声明「这一步之前先召回」；或 skill 约定（teamai-cli 的 rule 方案：把「开工先召回」写进 skill 文档，不写隐式 hook） |
| **召回什么** | 查询组编排：doc 目录可分域（`_self/hook-enhance/` vs `_read/`），nx-rp 把域映射成 zg 的 glob 过滤（`-g "hook-enhance/**"`）——这层映射表 nx-rp 管 |
| **喂多少** | token 预算策略：zg 的 `--limit/--preview` 是字节级控制，nx-rp 需要把它包成「预算档位」（如 quick=3 条 short / deep=8 条 full） |
| **召回质量反馈** | teamai-cli 式质量闭环的对齐物：记录「召回了哪些 fragment（doc_id+行号）」，后续 hook-prompt 日志可关联「本次会话用了哪条召回」——投票/健康分的地基，nx-rp 自己存 JSONL |

### 3. 结果到上下文的格式化

zg 输出文件级证据（路径+行号+preview），但喂给 agent 的格式（比如带 nx-rp 的 doc 链接回指、来源标注）由 nx-rp 决定。轻量，但必须自己写。

### 4. 不需要写的（明确排除）

- 检索算法/索引/融合——zg 全包
- embedding 模型管理——zg 的 manifest 管模型绑定与授权
- watch/增量——zg daemon 自带
- MCP server——zg 自带，Claude Code 直连即可

## 四、架构草图

```
┌─ nx-rp 层（自己写）───────────────────────────────┐
│ store.json 登记 doc 目录（cwd-scope）              │
│ workflow 原语 ctx.recall(query, {domain, budget})  │
│ 域→glob 映射 / 预算档位 / 召回记录 JSONL / 面板    │
└──────────────────┬───────────────────────────────┘
                   │ child_process / MCP
┌──────────────────▼───────────────────────────────┐
│ zvec-grep 层（直接复用）                          │
│ <doc-root>/.zvec-grep/ 索引                       │
│ hybrid = BM25 + vector + RRF │ rg 精确兜底        │
│ freshness 标注 │ compact 输出 │ daemon watch      │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│ doc 目录（语料，唯一事实源）                       │
│ .claude/repo/_self/**.md 或用户指定目录           │
└──────────────────────────────────────────────────┘
```

## 五、关键决策

| 决策点 | 推荐结论 | 理由 | 备选 |
| --- | --- | --- | --- |
| 集成方式 | CLI 子进程调用起步（`zg` 命令），MCP 直连作为面板/agent 的高级路径 | CLI 可控性好（nx-rp 能拿到 stdout 结构化解析）；MCP 适合 agent 自主调用场景 | 全 MCP（放弃 CLI 解析） |
| embedding 模型 | `local/potion-multilingual-128m`（静态 256 维） | 中文知识文档为主，默认 potion-code 偏代码；静态模型索引快、内存小 | jina-v2-base-code（更强但更重） |
| 召回触发 | skill 约定优先（文档写明「先召回」），隐式 hook 明确不做 | teamai-cli 的教训写在源码注释里：auto-recall hook 「噪声大收益小」已被官方废弃 | PostToolUse hook 自动召回（不推荐） |
| 召回记录 | nx-rp 自己存 JSONL（fragment id + query + ts + sessionId），不做投票 UI | 质量闭环地基先打好，投票/健康分等有数据再上 | 不记录（丢失质量信号） |
| doc 目录默认值 | `./doc/`（项目根，gitignore 可选）或复用 `.claude/repo/_self/` | 用户「单独的目录」意图明确；_self 是现成语料但要考虑它含 intent 等工作文档是否适合全文召回 | 只用 _self |

## 六、待用户拍板的决策

| # | 决策 | 推荐 |
| --- | --- | --- |
| 1 | doc 目录放哪：项目根 `doc/` 独立目录，还是复用 `.claude/repo/_self/`，还是两者都支持（登记任意目录） | 登记任意目录（最通用），默认建议 `doc/` |
| 2 | 集成起步：CLI 子进程 or MCP 直连 | CLI 子进程（可测试性） |
| 3 | 召回触发形态：workflow 原语 `ctx.recall()` or skill 约定文档 or 两者 | 两者都要，先做 skill 约定（零代码），workflow 原语随后 |
| 4 | 召回记录 JSONL 是否第一期就做 | 做（数据不能重放，晚做=丢数据） |

## 七、参考

- compare 检索方案：`project/compare_retrieval-approaches-2026-09-22-v1-status.md`
- 功能全景：`project/teamai-context-enhance-2026-09-22-v1-status.md`
- zg 关键源码/文档行号：MarkdownExtractor `src/engine/extraction/markdown/extractor.ts:34`；RRF `src/engine/pipeline/search/index.ts:77`；MCP 工具表 `docs/03-mcp.md`；refresh 策略 `docs/06-server.md:154`；模型选型 `docs/07-embedding.md`
- teamai-cli 反面教材：`builtin-rules.ts` 注释（auto-recall hook 废弃原因）

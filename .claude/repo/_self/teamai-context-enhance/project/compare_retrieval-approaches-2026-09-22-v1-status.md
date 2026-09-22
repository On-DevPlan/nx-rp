# compare_检索方案：teamai-cli vs zvec-grep vs nx-rp（2026-09-22 v1）

> **Date:** 2026-09-22
> **Topic:** teamai-context-enhance
> **类型:** project compare（外部检索实现 vs 本项目现状）
> **版本:** v1（首次对比；teamai-cli 侧基于 `utils/search-index.ts`(903行) + `utils/tokenizer.ts` + `types.ts:1438-1513` 实读；zvec-grep 侧基于 `docs/04-pipeline.md` + `docs/05-architecture.md` + `docs/07-embedding.md` + `src/engine/pipeline/search/index.ts` 实读）

## 原始请求（用户原话）

> 比较teamaicli和zvev_grep的检索方案

## 轻微重写版（仅修错别字与口癖）

> 比较 teamai-cli 和 zvec-grep 的检索方案。

## 一句话定位

- **teamai-cli**：单文件 JSON + 自研 TF-IDF——**零依赖的知识条目检索**，语料是「团队沉淀的几百条 markdown」
- **zvec-grep**：BM25 + 向量 + RRF 融合 + ripgrep 三路合一——**本地优先的混合检索引擎**，语料是「整个代码仓库」
- **nx-rp 现状**：无检索层——提示词/skill 记录是纯 JSONL 追加 + 按时间倒序遍历

## 对照表

| 维度 | teamai-cli | zvec-grep | nx-rp 现状 |
| --- | --- | --- | --- |
| **语料规模假设** | 几百条知识文档（实测注释：163 条语料调阈值） | 整个 workspace（万级文件；glob/type/max-filesize 圈范围） | 单项目 JSONL 日志（提示词/skill 记录，万行级） |
| **索引结构** | 单文件 `~/.teamai/search-index.json`（schema v6）：`entries[]`（每文档一条：tokens/votes/domain/path…）+ `df` 文档频率表 | workspace 目录 `<root>/.zvec-grep/`：`manifest.json`（模型/元数据）+ `files.zvec` + `index.zvec`（zvec 引擎存储，BM25/FTS 与向量同库） | 无索引（`~/.nx-rp/prompts|skills/<cwd哈希>.jsonl` 原始追加） |
| **索引可重建性** | 纯派生物：builtAt + elapsedMs 记录，损坏即重建；分词「只减 token 安全，增 token 必须 bump 版本」触发全量重建 | manifest 记录模型与 schema；换模型显式 `--index --rebuild`；增量更新复用存储 schema | ——（无需重建） |
| **分词** | `Intl.Segmenter('zh-CN')` + CJK bigram 兜底（单字 run 内拼接，「推理服务」不会产出「理服」）+ camelCase 拆分（ModuleNotFoundError→4 个子词）+ 50K 截断 | 结构感知抽取替代纯分词：CodeExtractor（符号/签名/breadcrumb）、MarkdownExtractor（标题分节 + breadcrumb）、TextExtractor 兜底分块 | 无 |
| **检索模型** | TF-IDF：命中 token 的 IDF 加权和，title×3 / tag×2 位置加成，÷√query长度 归一，+ 票数 bonus，× 4×4 领域权重矩阵（查询域 × 条目域） | 三路路由：`--hybrid`（默认）/ `--fts`（BM25 词法）/ `--vector`（语义向量）；多查询组 `--fuse`；另一路 managed ripgrep 精确/正则（免索引、穷尽式） | 遍历 + 时间过滤 |
| **多路融合** | 无（单一打分公式） | RRF（`src/engine/pipeline/search/index.ts:77`，`RRF_K=60`）：`score += 1/(60+rank)`，多查询组/多路候选按排名倒数融合 | 无 |
| **召回深度策略** | 全 entries 遍历（语料小，无需剪枝） | 渐进扩深：初始 200 → 最大 2000，×2 增长，目标候选数 = limit×5（最少 50） | 全量遍历（日志文件小） |
| **语义理解** | 无向量——靠 CJK bigram + camelCase 拆分 + domain 权重近似「语义」 | 本地 embedding 模型（默认 `local/potion-code-16m-v2` Model2Vec 静态模型 256 维；可选 Transformer 级 jina/e5/minilm 或远程 API）；远程模型显式授权才外发数据 | 无 |
| **质量验证** | 注释内实测数据（163 条语料真阳性 11.2~63.2 vs cutoff 7.3） | 独立 benchmark 套件：SWE-QA 20 题 × 11 仓库，Hit@1/5/10、MRR@10、nDCG@10，CI 固定协议 `sweqa20-zg-three-modes-full-v5`；文档诚实列出标签局限（部分正例、未盲验） | 无 |
| **面向 agent 的输出** | recall subagent：紧凑摘要 + doc_id，主会话上下文不被全文污染；`--check` 轻量预检 RELEVANT/NOT_RELEVANT | 紧凑输出：stdout 非 TTY 时自动精简省 preview；`--preview short --limit 5`；MCP 端点供 agent 调用；「更少搜索更少上下文」是产品口号 | hook 记录 + 面板可视化（人看，非 agent 检索） |
| **新鲜度** | 写入即重建（contribute 后立即 buildIndex） | 结果带 `fresh`/`possibly_stale` 标注；例行 reconcile 保 fresh | 追加即最新（无索引所以无失同步问题） |
| **安全边界** | 全本地 | 全本地默认；远程 embedding 是唯一外发路径，显式一次性/workspace 授权；MCP Bearer 保护本地端点 | 全本地 |

## 关键差异的根因

1. **语料性质决定检索形态**。teamai-cli 的语料是「人写的知识条目」——标题/标签即元数据，TF-IDF + 位置加成够用；zvec-grep 的语料是「代码仓库」——符号结构、语义意图、精确文本三类查询需求并存，必须三路互补。两者都不是「谁的方案更先进」，而是各对自己的语料刚好够用。
2. **索引的可弃性**。teamai-cli 把索引当纯缓存（903 行代码里大量防御逻辑是「索引坏了/旧了怎么办」）；zvec-grep 把索引当资产（manifest 管模型绑定、增量维护、stale 标注）。前者重建成本低到可以随便扔，后者重建要跑 embedding 所以精心维护。
3. **检索质量被当作工程指标**。zvec-grep 有冻结题库 + 固定协议 + CI 门禁的 benchmark，且文档专门一节「局限性」说明标签偏差——这个「自证清白」的工程化程度在检索项目里少见。teamai-cli 的质量验证停留在注释里的经验数据。
4. **agent 上下文经济学是共同目标**。teamai-cli 用 subagent 隔离 + doc_id 摘要省上下文；zvec-grep 用紧凑输出 + 排名靠前的少量结果 + 文件级证据减少工具调用轮次。殊途同归：检索层的产出物不是「结果列表」而是「喂给模型的上下文预算」。

## nx-rp 现状在检索维度的位置

nx-rp 当前没有任何检索层（现状描述）：提示词日志与 skill 记录的查询语义是「按 cwd 过滤 + 时间倒序 + limit」，本质是浏览而非检索。若未来要做「从会话记录里找上次怎么解决的」，两条 JSONL 的量级（单项目万行内）更适合 teamai-cli 式的轻索引路线，而非 zvec-grep 的仓库级混合检索——zvec-grep 本身可作为外部工具被 workflow 编排调用，不需要内嵌。

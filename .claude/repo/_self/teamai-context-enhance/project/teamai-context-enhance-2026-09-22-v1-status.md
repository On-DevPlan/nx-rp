# teamai-context-enhance 项目学习（2026-09-22 v1）

> **Date:** 2026-09-22
> **Topic:** teamai-context-enhance
> **类型:** project status（参考项目功能全景 · 上下文增强视角）
> **版本:** v1（首版；基于源码实读 `.claude/repo/teamai-cli/src/`（108 个 ts 文件）+ agents/ + skills/ 打包资产）

## 原始请求（用户原话）

> teamai-cli有哪些功能 增强整个agent的上下文

## 轻微重写版（仅修错别字与口癖）

> teamai-cli 有哪些功能？怎么增强整个 agent 的上下文？

## 功能全景（按源码模块盘点）

### 一、上下文注入类——直接往 agent 会话里塞信息

| 功能 | 源码模块 | 机制 | 注入时机 |
| --- | --- | --- | --- |
| **recall 知识召回** | `recall.ts` + `utils/search-index.ts` | TF-IDF 检索本地知识库（learnings/docs/rules/skills），分数除以 √query长度 归一，双阈值（相对 ratio 1.35 + 绝对 floor）防冷启动误判；`recall --check` 轻量预检输出 RELEVANT/NOT_RELEVANT | 由 recall subagent 调用 |
| **teamai-recall subagent** | `agents/teamai-recall.md`（打包资产） | 独立 subagent 搜知识库返回**紧凑结构化摘要 + doc_id**，不把全文灌进主会话——「主对话的上下文窗口不被原始知识污染」是它的核心设计宣言 | 主对话显式委派 |
| **teamai-recall rule** | `builtin-rules.ts` | 内置 rule（`teamai-recall.md`）部署到各 agent 的 rules 目录，指示模型「开工前先召回」——把主动检索写成行为规范而非隐式 hook（注释明说：老的 auto-recall PostToolUse hook「加了噪声却没有 subagent 的收益」，已废弃） | 常驻规则 |
| **mr-hint** | `mr-hint.ts` | SessionStart 时查最近 7 天合并的 MR（TGit REST / gh CLI），缓存防重复提示，`additionalContext` 注入「最近合了什么」 | SessionStart |
| **todowrite-hint** | `todowrite-hint.ts` | TodoWrite 后注入「任务已规划，可检索团队知识库」提醒；session 级 dedup 文件（TTL 24h）保证只提醒一次 | PostToolUse·TodoWrite |
| **package-hint** | `pkg/pkg-hint.ts` | pull 前后包 manifest hash 对比，依赖变更时下次会话提示 | SessionStart / UserPromptSubmit |

### 二、上下文采集类——把会话/代码变成可检索知识

| 功能 | 源码模块 | 机制 |
| --- | --- | --- |
| **contribute 经验沉淀** | `contribute.ts` + `contribute-check.ts` | Stop 时摩擦分（interrupt/reject/correction/toolError 加权，阈值 20）判定「值得沉淀的会话」→ 提示 → `/contribute` 写 learnings markdown，写入即建索引立即可召回 |
| **codebase graph** | `codebase.ts` + `wiki-engine/` | 调 AI CLI 扫描仓库（git log 20 条 + 文件树 + package.json + 入口命令 + types 接口 + docs 摘要，各有字符截断上限）→ 生成 code-knowledge wiki（15 类节点 architecture/component/flow/...，EXTRACTED/INFERRED/AMBIGUOUS 三级置信度） |
| **dashboard-collector 事件流** | `dashboard-collector.ts` | hook 事件 → 本地 events.jsonl（工具调用/干预/模型/ token），是摩擦分、digest、session 统计的共同数据底座 |
| **import 系列** | `import-mr/repo/org/local/iwiki.ts` | 从 MR 描述、仓库 README、组织文档批量导入知识条目 |
| **deep-enrich** | `deep-enrich.ts` + `enrich-with-ai.ts` | 调 AI 给已沉淀的 learnings 补充上下文（标签/摘要/关联） |
| **save-session** | `save-session.ts` | 会话隐私脱敏摘要（只存计数、工具名、脱敏后的首条 prompt）入月度日志 |

### 三、上下文分发类——团队级配置与知识同步（git-native）

| 功能 | 源码模块 | 机制 |
| --- | --- | --- |
| **pull / push** | `pull.ts` / `push.ts` | Git 仓库为唯一事实源；pull 时 reconcile 到各工具目录（幂等），push 走分支/PR |
| **skills / rules / agents / docs 分发** | `builtin-skills.ts` / `builtin-rules.ts` / `builtin-agents.ts` | CLI 自带资产（skills/teamai、skills/teamai-share-learnings、skills/team-wiki-codebase、agents/teamai-recall.md）随版本部署到 `~/.claude/skills/` 等目录，版本升级自动同步 |
| **MCP 分发** | `mcp-reconcile.ts` | 团队 MCP server 配置渲染到各工具的 MCP 配置格式（JSON / Codex TOML block），占位符展开 + hash 记录 |
| **env 分发** | `env-commands.ts` | 团队环境变量经 env.yaml 分发，值默认 mask |
| **角色/标签/订阅** | `roles.ts` / `tags.ts` / `source.ts` | 按角色过滤分发内容；多源订阅组合其他团队的公共仓库 |

### 四、观测与治理类——上下文质量的可视化闭环

| 功能 | 源码模块 | 机制 |
| --- | --- | --- |
| **skill 健康分** | `skill-health.ts` | 使用分 60 + 新鲜度 40（nx-rp 0.3.0 已借鉴） |
| **skill-recommend** | `skill-recommend.ts` | pull 后推荐「团队高频用但你没用过」的 skill（usage.jsonl + known-skills.json 双数据源） |
| **agent-skills 溯源** | `agent-skills.ts` | 扫描各工具 skills 目录，给每个 skill 打来源标签：team / builtin / source(跨团队) / local-only——「这个 skill 是哪来的、push 过没有」一目了然 |
| **promote 晋升** | `maintenance/promote.ts` | 置信度≥0.90 + ≥5 赞 + ≥2 用户 + ≥14 天 → AI 改写为正式 skill/rule/doc |
| **quality-update 僵尸检测** | `maintenance/quality-update.ts` | 召回≥5 次但≤1 赞跨≥2 用户 → 质量改进候选 |
| **digest 周报** | `digest.ts` | 聚合 stats + learnings + sessions 生成周报（skill 变更/新经验/会话亮点） |
| **viz 知识图谱** | `viz.ts` / `viz-render.ts` | 知识库 HTML 可视化 |
| **doctor** | `doctor.ts` + `doctor-delivery.ts` | 体检：hook/skill/rule/agent/MCP/env 六类资源的「声明了但没送达」检查 |

### 五、多宿主基础设施（nx-rp 刻意不做的部分）

`resources/`（9 工具格式翻译）、`providers/`（GitHub/GitLab/TGit/CNB/gitcode API）、`hermes/omp/openclaw/opencode-hooks.ts`（各宿主 hook 适配）、`wiki-engine/ast/`（AST 解析）——均为多工具/团队场景服务。

## 「增强 agent 上下文」的完整链路（源码实证）

```
                    ┌── 采集侧 ──────────────────────────────┐
  AI 会话 ──hooks──▶│ dashboard-collector（事件流）           │
                    │ contribute（摩擦分→经验沉淀）           │
                    │ codebase graph（代码→结构化wiki）       │
                    │ import 系列（MR/README→条目）           │
                    └──────────────┬─────────────────────────┘
                                   ▼
                    ┌── 存储与治理 ──────────────────────────┐
                    │ learnings/ docs/ rules/ skills/         │
                    │ TF-IDF 索引（√len 归一 + 双阈值）       │
                    │ votes 投票 / promote 晋升 / 僵尸检测    │
                    └──────────────┬─────────────────────────┘
                                   ▼
                    ┌── 注入侧（回到会话）───────────────────┐
  AI 会话 ◀─hints──│ recall subagent（紧凑摘要，不灌全文）   │
                    │ recall rule（行为规范：开工先召回）      │
                    │ mr-hint / todowrite-hint / pkg-hint     │
                    └────────────────────────────────────────┘
```

核心设计思想（源码注释原话佐证）：

1. **subagent 隔离上下文**——检索走独立 subagent 返回摘要，主会话上下文窗口只收 doc_id 和要点，不被原始知识污染
2. **规则优于隐式 hook**——auto-recall hook 因「噪声大收益小」被显式 rule + subagent 方案替代
3. **摩擦信号驱动沉淀**——不是所有会话都值得记，只有真实受挫的会话才提示沉淀
4. **写入即可召回**——contribute 后立即重建本地索引，不等下次 pull
5. **反幻觉投票**——投票只认「本会话召回过 ∩ 回复里声明引用过」的交集

## 与 nx-rp 现状的天然衔接点（现状描述，非设计建议）

nx-rp 0.3.1 已有：hook-prompt（提示词 JSONL）、hook-skill（skill 调用 JSONL + 健康分）、core/hook-io（stdin 容错）、Web 面板双 tab、cwd-scope 隔离存储。

对照上表，teamai-cli 中 nx-rp 尚无对应物的上下文相关能力：recall 索引与 subagent、事件流采集（dashboard-collector 对应物）、摩擦分、codebase graph、digest、doctor、MCP/env 分发。其中 hook 事件维度此前已有对照（见 [[compare_hook-implementation-2026-09-22-v1-status]]），本文档补充的是 hook 之外的知识库/检索/治理维度。

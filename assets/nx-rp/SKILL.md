---
name: nx-rp
description: nx-rp（npx-repo）—— 给当前项目管理外部上下文信息。当用户需要整理项目上下文文档、或查看项目源码依赖图（import 关系、分层架构可视化）时使用。触发词：上下文文档、依赖图、依赖分析、deps、架构图、scope、cwd 作用域、nx-rp、npx-repo、提示词日志、prompt log、hook、召回、知识库、zvec-grep、zg、semantic recall、embedding、文件批注、批注、评价、待办、annotation。
---

# nx-rp — 给当前项目接一组外部上下文 + 源码依赖图

**nx-rp = npx-repo**，给当前项目（cwd）统一登记外部上下文信息，存在
`~/.nx-rp/store.json`，按 cwd 自动隔离 scope。

它**不抓取内容、不存原始文件**——只存上下文文档。

## 核心能力

1. **`doc`** — 写上下文文档（Markdown 短文）；agent 拿来当 prompt 上下文
2. **`deps`** — 源码依赖图：扫 `src/` 的 import 关系（.js/.mjs/.cjs/.jsx），输出 DOT /
   面板可视化（Graphviz 官方 WASM 渲染）。词法清洗后匹配（注释/字符串里的假 import 不算边），
   分层着色（core 绿 / modules 蓝 / runtime 橙 / web 紫），跨层边红色标出。
   DOT 可另存为 .dot 文件（graphviz 交接）/ 从外部 .dot 导入预览；
   面板双模式：预览（只读看图）/ 编辑（改 DOT 文本实时渲染，草稿不回写源码）

另有 **两个 hook 模块**（与 doc / deps 平级，各自独立 tab 与开关）：

- **`hook-prompt` 提示词日志**：UserPromptSubmit，把每个会话里用户提交的提示词按目录记进
  `~/.nx-rp/prompts/<cwd哈希>.jsonl`（`hook on` / `hook off` / `hook log`）
- **`hook-skill` Skill 追踪**：PostToolUse（matcher Skill），把 skill 调用记进
  `~/.nx-rp/skills/<cwd哈希>.jsonl`，健康分 = 使用量 + 新鲜度（`hook skill-on` / `hook skill-off` / `hook skills`）

两者开关互不影响（各自只动自己 marker 指纹的 settings entry）：

```
nx-rp hook on / off          # 提示词日志开关（幂等；写前自动留快照）
nx-rp hook skill-on / skill-off  # Skill 追踪开关
nx-rp hook log               # 提示词记录（--all 跨目录，--limit N）
nx-rp hook skills            # Skill 使用统计与健康分（--all 跨目录）
nx-rp hook status / skill-status  # 各自的开关状态
```

面板上「提示词日志」「Skill 追踪」两个 tab 与上述命令一一对应。
使用与排障详见 [[prompt-log]]；依赖图用法与准确性边界详见 [[deps-graph]]。

另有 **文档与召回**（doc 域，一个 tab 管完整数据流）：
每个工作目录对应一个知识库 `<docRoot>/<路径序列化>/`（默认 docRoot `~/.nx-rp/doc`，
序列化规则与 Claude Code 项目目录一致）。doc 条目经 `doc export` 实例化为 KB 目录的
md 文件，`zg index` 后即可语义召回（远程 qwen embedding，模型三选一）。

```
nx-rp zg onboard            # 新用户引导：装 zg → 拿 key → 选模型 → 用起来
nx-rp doc export            # doc 条目镜像为 KB md 文件（幂等）
nx-rp zg index              # 建/增索引（direct 模式，零常驻）
nx-rp zg query --q "问题"    # 语义召回（结果带知识库根/子目录/来源工作目录头块）
nx-rp doc root --set <dir>  # 改全局知识库根（自动迁移旧 KB）
```

安全边界：API key 只写入 zg 全局配置（~/.zvec-grep/config.json），nx-rp 不存储
不回显不入库；刻意不装 zg 的 MCP（zg 只做召回引擎）。
使用、模型选型与 agent 召回用法详见 [[zg-recall]]。

另有 **`annotations` 文件批注**：给任意本机文件挂 review（评价）/ todo（待办）/
note（思考），支持行号锚点；`ann load` 加载文件预览（默认 1000 字符，超限拒绝渲染，
`--full` 显式全量受 200K 硬上限）；`ann todos` 跨文件看待办。
快速上手与渲染铁律详见 [[annotations]]。

每个资源的可见性都按 cwd 自动隔离：同一 cwd 看到一致数据，切换目录是不同 scope。
多项目场景：`nx-rp recents` 列最近目录；面板右上角可一键切换数据范围；
默认端口上已有面板时再跑 `nx-rp serve` 不会起第二进程，登记当前目录并直接打开。

## CLI 与 Web 同源

`nx-rp serve` 启面板后，**每一条 CLI 命令都有等价 Web 操作**。反过来不一定：
CLI 可以有 `validate` 这类纯检查命令，Web 没有按钮。

```
nx-rp serve                          # 启 :7820 面板（--no-open 不弹浏览器；
                                     #   端口已有 nx-rp 面板则复用它）
nx-rp recents                        # 最近工作目录（面板快速切换 scope 的数据源）
nx-rp doc list
nx-rp deps                           # 扫 src/ 的 import 关系 → 依赖图（DOT 文本）
nx-rp deps --json                    # {dot, nodes, edges, stats} 结构化输出
nx-rp deps save --file deps.dot      # 依赖图 DOT 落盘（graphviz 交接）
nx-rp deps load --file ext.dot       # 读外部 .dot 文本
nx-rp skill install                    # 装内置 skill 到 ~/.claude/skills
nx-rp skill get [name] [ref]            # 输出 SKILL.md（默认）/ references/<ref> 到 stdout；
                                       #   同时按 install 既有逻辑装到 ~/.claude/skills/<name>；
                                       #   三段拼接（prefix → 文档 → install 状态），
                                       #   prefix 固定最前——给不直接识别 ~/.claude/skills
                                       #   的 agent 一条命令拿全上下文，建议 agent 把
                                       #   内容复制到自己可访问路径后续直接调用。
                                       #   ref 接受 `references/foo.md` / 裸名 `foo`
                                       #   （自动查 references/foo.md）/ `./foo.md`。
```

加 `--json` 得机器可读输出。

## agent 怎么用依赖图

`nx-rp deps` 一条命令拿全项目 import 关系：改架构前先看图（谁依赖谁、
哪些边跨层）、回答「这个模块被谁用着」。**图是只读的**——从源码推导，
改图 = 改代码。`nx-rp deps save --file deps.dot` 可把图导出为 graphviz
文件（用户可直接用 graphviz 工具链渲染或提交进仓库）。

准确性边界与典型用法见 [[deps-graph]]。

## 触发场景

- 用户：「整理一下这个项目的上下文文档」→ agent 写 doc 条目 → `nx-rp doc list` 给 agent 当上下文
- 用户：「画一下这个项目的依赖图 / 哪些模块耦合了」→ `nx-rp deps` → DOT 文本或面板可视化

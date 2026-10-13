---
name: nx-rp
description: nx-rp（npx-repo）—— 给当前项目管理外部上下文信息。当用户需要查看项目源码依赖图（import 关系、分层架构可视化）、登记/切换 archify 图表、管理提示词日志 / Skill 追踪 / 文件批注时使用。触发词：依赖图、依赖分析、deps、dot、架构图、archify、图表、chart、scope、cwd 作用域、nx-rp、npx-repo、提示词日志、prompt log、hook、文件批注、批注、评价、待办、annotation。
---

# nx-rp — 给当前项目接一组外部上下文 + 源码依赖图

**nx-rp = npx-repo**，给当前项目（cwd）统一登记外部上下文信息，存在
`~/.nx-rp/store.json`，按 cwd 自动隔离 scope。

它**不抓取内容、不存原始文件**——只存轻量的上下文信息（提示词日志、Skill 统计、文件批注等）。

## 核心能力

1. **`chart`** — 项目图表域：「依赖图」（扫 `src/` 的 import 关系，
   .js/.mjs/.cjs/.jsx，词法清洗后匹配，DOT 输出 / Graphviz WASM 渲染，
   分层着色 core 绿 / modules 蓝 / runtime 橙 / web 紫，跨层边红色标出，
   .dot 可另存/导入）+ 「图表」（archify 产物登记展示）双视图同源模块。
   图一律出自 archify skill 的精修流程——机器自动生成的架构图不可信，
   面板无「一键生成」按钮；agent 用 archify skill 画图后 `chart archify add` 登记
   **另有 `rp-archify` skill**（`nx-rp skill install --group=rp-archify`）：教 agent 把
   archify 产出的图表登记进面板并多图切换

另有 **两个 hook 模块**（与 chart 平级，各自独立 tab 与开关）：

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
使用与排障详见 [[prompt-log]]；依赖图用法与准确性边界详见 [[chart-graph]]。

另有 **`annotations` 文件批注**：给任意本机文件挂 review（评价）/ todo（待办）/
note（思考），支持行号锚点；`ann load` 加载文件预览（默认 1000 字符，超限拒绝渲染，
`--full` 显式全量受 200K 硬上限）；`ann todos` 跨文件看待办。
快速上手与渲染铁律详见 [[annotations]]。

每个资源的可见性都按 cwd 自动隔离：同一 cwd 看到一致数据，切换目录是不同 scope。
多项目场景：`nx-rp recents` 列最近目录；面板右上角可一键切换数据范围；
默认端口上已有面板时再跑 `nx-rp serve` 不会起第二进程，登记当前目录并直接打开。
`nx-rp recents remove <path>` 可移除（面板右上角鼠标悬停条目右侧的 × 也能移除）。
首次在某路径下用 nx-rp：直接在面板下拉底部的"+ 添加目录"输入路径即可，无需切终端。

## CLI 与 Web 同源

`nx-rp serve` 启面板后，**每一条 CLI 命令都有等价 Web 操作**。反过来不一定：
CLI 可以有 `validate` 这类纯检查命令，Web 没有按钮。

```
nx-rp serve                          # 启 :7820 面板（--no-open 不弹浏览器；
                                     #   端口已有 nx-rp 面板则复用它）
nx-rp recents                        # 最近工作目录（面板快速切换 scope 的数据源）
nx-rp chart                           # 扫 src/ 的 import 关系 → 依赖图（DOT 文本）
nx-rp chart --json                    # {dot, nodes, edges, stats} 结构化输出
nx-rp chart save --file deps.dot      # 依赖图 DOT 落盘（graphviz 交接）
nx-rp chart load --file ext.dot       # 读外部 .dot 文本
nx-rp skill install                    # 装内置 skill 到 ~/.claude/skills
nx-rp skill get [name] [ref]            # 输出 SKILL.md（默认）/ references/<ref> 到 stdout；
                                       #   同时按 install 既有逻辑装到 ~/.claude/skills/<name>；
                                       #   三段拼接（prefix → 文档 → install 状态），
                                       #   prefix 固定最前——给不直接识别 ~/.claude/skills
                                       #   的 agent 一条命令拿全上下文，建议 agent 把
                                       #   内容复制到自己可访问路径后续直接调用。
                                       #   ref 接受 `references/foo.md` / 裸名 `foo`
                                       #   （自动查 references/foo.md）/ `./foo.md`。
nx-rp skill install --group=rp-loop     # 按 group 装另一个内置 skill（group 名即 skill 名，
                                       #   等价于 `skill install rp-loop`）
nx-rp skill groups                     # 看有哪些内置 group
```

加 `--json` 得机器可读输出。

**另有 `rp-loop` skill**（`nx-rp skill install --group=rp-loop`）：
教 agent 用 `nx-rp loop` 做**自引用循环**（Ralph 技术）——把同一条提示词反复灌回当前会话，
直到输出完成承诺或达到轮次上限。适用于"跑到测试全绿""无人值守把它做完"这类
有明确验收信号的任务。完整用法（`loop on/start/status/cancel/log`、prompt 怎么写、
与官方 ralph-loop 插件的差异、排障）见该 skill。

## agent 怎么用依赖图

`nx-rp chart` 一条命令拿全项目 import 关系：改架构前先看图（谁依赖谁、
哪些边跨层）、回答「这个模块被谁依赖着」。**图是只读的**——从源码推导，
改图 = 改代码。`nx-rp chart save --file deps.dot` 可把图导出为 graphviz
文件（用户可直接用 graphviz 工具链渲染或提交进仓库）。

准确性边界与典型用法见 [[chart-graph]]。

## 触发场景

- 用户：「画一下这个项目的依赖图 / 哪些模块耦合了」→ `nx-rp chart` → DOT 文本或面板可视化

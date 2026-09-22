# hook-enhance 意图：hook 拆 tab + teamai-cli 技巧借鉴（2026-09-22）

## 背景与动机

nx-rp 0.3.0 的 hook 模块刚接入第二条 hook（提示词日志 UserPromptSubmit + Skill 追踪 PostToolUse），
两条 hook 共用「提示词日志」一个 tab、一个开关。用户使用后提出两点：

1. 当前 tab 粒度太粗——「一个 hook 就单独作为一个 tab，然后 hook 开关对应该功能」，
   即提示词日志和 Skill 追踪要各自独立 tab、各自开关。
2. teamai-cli（克隆在 `.claude/repo/teamai-cli/`）还有其他 hook 工程技巧值得调研借鉴，
   **先实现 Claude Code 支持的部分即可**（不做 Cursor/CodeBuddy/Codex 等其他宿主的翻译层）。

同时要求用 compare 文档对比双方 hook 实现程度，明确差距图谱。

## 目标

- 每个 hook 一个独立 tab，tab 内的启用/停用开关只控制该条 hook
- 调研 teamai-cli 的 hook 技巧清单，筛选出适配 Claude Code-only 场景的可借鉴项
- 产出 compare 文档固化双方 hook 实现程度对照
- 不破坏 nx-rp 既有结构保证：CLI/Web 同源（registry 双端声明）、capture 永不报错、外科手术式 settings 写入

## 约束与边界

- 只面向 Claude Code 宿主，不做多工具翻译层（HookDef → N 种宿主格式）
- registry 测试约束：`带 view 的模块都在前端视图注册表登记` + `视图文件真实存在`——
  tab 粒度 = 模块粒度（VIEWS 一行对应 `modules/{id}/view.jsx`），拆 tab 的方案必须绕开或顺应这个约束
- 每条 hook 的 JSONL 记录路径、marker 指纹机制保持不变
- 严格模式（铁律）：讨论期间不改代码，本文档先沉淀意图与设计

## 关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 模式判定 | 意图模式 | 有明确改造意图（拆 tab）+ 调研需求 + 对比需求 |
| topic-slug | `hook-enhance` | 语义直接，与既有 `_read/` 目录无冲突 |
| 拆 tab 方案 | 见 `hook-per-tab-2026-09-22-v1-design.md`，三案对比 | registry 约束下有三条路径，需用户拍板 |
| teamai-cli 技巧取舍 | 见 compare 文档「可借鉴项分级」 | Claude-only 先落地前景台/后台分离、stdin 兜底等 4 项 |

## 待定问题

1. 拆 tab 三方案（子注册表 / 拆双模块 / tab 内二级导航）选哪个？
2. hooks 各自独立开关后，`nx-rp hook on` 不带子命令时是「全开」还是要求显式写 `hook on prompt|skill`？
3. teamai-cli 的后台分离 handler（detached spawn）要不要在 v1 就做，还是等 Stop hook 场景出现再做？

---
name: rp-loop
description: nx-rp loop —— 自引用循环（Ralph 技术）：把同一条提示词反复灌回当前会话，直到出现完成承诺或达到轮次上限。当用户要求「用循环跑任务 / 反复迭代到完成 / 无人值守让它自己做到 / 让它自己跑一晚上 / 一直做到 X 为止 / 失败就重试直到成功 / 迭代到测试全绿 / ralph」时使用。触发词：loop、循环、自引用循环、ralph、ralph loop、迭代到完成、无人值守、跑一晚上、重试直到成功、loop start/status/cancel/log、completion promise、max-iterations。**不适用于**：一次性任务、普通多轮对话、需要人工判断的设计决策、成功判据说不清的任务——循环会拦截会话退出，误用代价高。
---

# rp-loop — 让 agent 在同一会话里迭代到完成

`nx-rp loop` 是 nx-rp 实现的 **Ralph 技术**（自引用循环）：把同一条提示词反复灌回
**当前会话**，agent 每轮从文件系统与 git 历史里看到自己上一轮的成果，逐步逼近目标，
直到输出完成承诺或达到轮次上限。

原理出处：Geoffrey Huntley 的 [Ralph 技术](https://ghuntley.com/ralph/)
（"Ralph is a Bash loop"）。nx-rp 用 Node + Stop hook 实现，不依赖 `jq`/`perl`/`awk`/`sed`。

## 三条铁律（布防前必读）

1. **先与用户确认三件事**：任务是什么、**可验证的**完成判据是什么、轮次上限多少。
   判据说不清就不该布防——循环会在错误的信号上停下，或永远不停。
2. **完成承诺只在完全为真时输出**。哪怕你觉得卡住了、任务不可能、跑太久了，
   也**不许为了脱身说假话**。循环设计上就是为了持续到真的完成。
3. **不设 `--completion-promise` 就永远不会判定完成**，只能靠 `--max-iterations` 收口。
   所以上限不是可选项，是主保险丝。

## 不是什么

- **不是把 agent 的输出喂回输入**。"自引用"指的是：同一 prompt 重复、进度存在
  **文件与 git 历史**里、每轮都看到上一轮的产物并在此基础上改进。
- **不是在替你做事**。循环只是"不停重来"的机制，做事的仍是当前会话里的 agent。
- **不是官方 ralph-loop 插件**。两者机制同源但不是一回事（见下表），命令不要混用。

## 六条命令

```
nx-rp loop on             # 在当前项目启用 Stop hook（项目级，写 .claude/settings.local.json）
nx-rp loop start "<任务>"  # 布防：把 prompt 写进状态，之后每次要结束回合都会被拦
nx-rp loop status         # 看 hook 开关 + 当前目录的循环与轮次
nx-rp loop log            # 看每轮判定审计（继续 / 命中 / 超限）
nx-rp loop cancel         # 取消循环（不带 --id 则取消全部活跃；记录保留）
nx-rp loop off            # 停用 hook（本地级+项目级都摘，其余 hooks 不动）
```

`loop start` 的完整参数：

```
nx-rp loop start "<任务描述>" \
  --completion-promise "DONE" \      # 出现 <promise>DONE</promise> 且一字不差即结束
  --max-iterations 20                # 轮次上限（默认 20；0 = 无限）
```

## 标准起手式

```bash
# 1. 写一条"给未来的自己看"的 prompt（判据必须可验证）
# 2. 在本项目启用 hook（只需一次，幂等）
nx-rp loop on
# 3. 布防
nx-rp loop start "把 src/foo.js 的测试补到全绿：每次迭代先跑 npm test，
                 全通过后输出 <promise>TESTS GREEN</promise>" \
  --completion-promise "TESTS GREEN" --max-iterations 15
```

布防后，**每次你尝试结束回合，Stop hook 都会把同一条 prompt 原样灌回来**——
直到命中承诺或达到上限。

**关键差异**（别按官方插件的用法去调）：

| | 官方 ralph-loop 插件 | nx-rp loop |
|---|---|---|
| 启动 | 插件自带的 slash 命令 | `nx-rp loop start "..."`（CLI） |
| 开关 | 装插件即全局生效 | `loop on` **按项目**写配置，只有本项目被拦 |
| 状态 | 项目内单文件（单实例） | `~/.nx-rp/loops/`（**数组，多会话并行**） |
| 取消 | 插件自带的 cancel 命令 | `nx-rp loop cancel` |
| 观测 | 读状态文件 | `loop status` / `loop log` / Web 面板 |

**本 skill 讲的全是 nx-rp 的命令。** 两者机制同源但不是一回事，别把官方插件的
命令名套到这里来——那会调不存在的命令。

## 什么时候该用 / 不该用

**适合**：成功判据明确（测试、lint、构建）、需要反复迭代精炼、可以无人值守、
greenfield 探索

**不适合**：需要人拍板的设计决策、一次性操作、成功判据说不清、
生产环境排障（用定向调试）、会被循环无限放大的破坏性操作

## 排障速查

| 症状 | 先查 |
|---|---|
| 回合照常结束，循环没起 | 本项目 `nx-rp loop on` 了吗；全局 `disableAllHooks`；是不是在**别的目录**跑的 |
| 停不下来 | 没设 `--completion-promise`；`--max-iterations 0`（无限）；用 `nx-rp loop cancel` |
| 输出过承诺却没停 | 标签不在**最后一条 assistant 文本**里 / 承诺词不完全一致 / 子 agent 的输出不算 |
| 循环归属混乱 | `nx-rp loop status` 看 `sessionId`；多会话并行时显式 `--session-id` |
| 与官方插件同时启用 | **两个 Stop hook 都会拦**，同一会话别开两套 |

详细命令语义与状态机见 [[loop-commands]]；
prompt 怎么写、承诺词怎么选见 [[loop-prompt-craft]]；
排查清单见 [[loop-troubleshooting]]；
原理与哲学见 [[ralph-philosophy]]。

## 触发场景

- 用户：「让这个任务跑到测试全绿为止」→ 确认判据与上限 → `loop on` + `loop start`
- 用户：「这个不好修，你反复试试直到好」→ 先谈清"好"的可验证定义，再布防
- 用户：「我下班了，你把它做完」→ 必须有自动验收信号，且上限要设得保守

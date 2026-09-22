# compare_hook-实现程度：teamai-cli vs nx-rp（2026-09-22 v1）

> **Date:** 2026-09-22
> **Topic:** hook-enhance
> **类型:** project compare（外部实现 vs 本项目实现程度）
> **版本:** v1（首次对比）

## 原始请求（用户原话）

> 一个hook就单独作为一个tab 然后hook开关对应该功能 team-cli还有没有其他可以参考的hook技巧 先实现claude的即可, 增强我的nx-rp /intent-capture-discuss 对比hook的实现程度

## 轻微重写版（仅修错别字与口癖）

> 一个 hook 就单独作为一个 tab，然后 hook 开关对应该功能。teamai-cli 还有没有其他可以参考的 hook 技巧？先实现 Claude 的即可，增强我的 nx-rp。对比 hook 的实现程度。

## 对比对象与维度

- **teamai-cli**（Tencent/teamai-cli，v0.22.0，TypeScript，源码在 `.claude/repo/teamai-cli/`）
- **nx-rp**（本项目 0.3.0，`src/modules/hook/`）
- 维度：hook 注入方式、事件覆盖、dispatcher、容错工程、输出口、质量评分、统计面板、多宿主支持

## 对照表

| 维度 | teamai-cli | nx-rp 现状 | 差距 |
| --- | --- | --- | --- |
| **hook 注入** | `HookDef[]` 数据结构 + reconcile 引擎渲染到各宿主 settings；description 前缀做指纹识别；golden test 锁字节级一致 | 直接构造 settings entry；marker 字段（`__nx_rp_prompt_log__` / `__nx_rp_skill_track__`）做指纹；单测断言写盘结果 | 相对落后：无数据化 HookDef、无 golden 字节锁（但有同源 snippet 断言）；单宿主场景够用 |
| **事件覆盖** | 6+ 事件：SessionStart / Stop / PostToolUse(*/Skill/TodoWrite) / UserPromptSubmit / SessionEnd | 2 事件：UserPromptSubmit（提示词）、PostToolUse·Skill（skill 追踪） | 落后：无 SessionStart（会话开始拉取/上报）、无 Stop（会话结算）、无 TodoWrite 提示 |
| **dispatcher** | 单入口 `hook-dispatch <event>` 读一次 STDIN，按 event+matcher 扇出给 handler 注册表；前台/后台分离 | 每条 hook 一个独立命令（`hook capture` / `hook skill-track`），无扇出层 | 形态不同：nx-rp 每事件一命令在 2 条 hook 时更简单；hook 数量 >3 后 dispatcher 收益才显现 |
| **STDIN 容错** | 读 STDIN 与 1s deadline 竞速（防宿主不关管道挂死）；坏 JSON 降级为字段抢救（salvage）非整体放弃；非对象 JSON 降级 `{}` | `readStdin` 3s 兜底超时；坏 JSON 整体静默丢弃 | 落后：无「已收内容的抢救」——半截 JSON 直接丢；3s vs 1s 都偏保守但无碍 |
| **前台/后台分离** | 前台 handler 统一 4.5s 预算；纯副作用 handler `background: true` 分离 spawn（Windows 走 WMI 逃生），不阻塞宿主 | 双条 hook 均 `async: true`（宿主侧后台），CLI 进程内无再分离 | 相对落后：async 已保证不阻塞会话；CLI 内部分离仅当单 handler 需 >4.5s 才必要（当前无此场景） |
| **输出口（向会话回注）** | 三种格式按宿主分：Claude `hookSpecificOutput.additionalContext` / Cursor `followup_message` / Codex `systemMessage`；Stop 无法输出时 stash 到下次 UserPromptSubmit 交付 | 无——两条 hook 纯记录，不回注任何上下文 | 落后（也是取舍）：nx-rp 定位纯观测不干扰；回注能力是「提示类 hook」的前置 |
| **质量评分** | 健康分（使用 0-60 + 新鲜度 0-40）、摩擦分（interrupt/reject/correction/toolError 加权，阈值 20 触发沉淀提示）、召回质量缓存、投票反幻觉（召回∩引用交集） | 健康分（同公式借鉴实现，24 单测覆盖） | 落后：无摩擦分（需 Stop + transcript 解析）、无投票/召回闭环 |
| **统计面板** | CLI + dashboard（本地 web）；团队聚合（多用户投票、贡献者数） | CLI + 本地面板 Skill 使用统计卡片（星级/次数/最近使用）、跨目录勾选 | 各有侧重：它强在团队聚合；nx-rp 面板同源 action 结构更干净，单人场景信息已够 |
| **多宿主支持** | 9 种工具格式翻译（含 Windows cmd.exe 语法分支、GUI PATH wrapper） | 仅 Claude Code | 刻意不做（用户已明确 Claude-only） |
| **settings 安全** | reconcile 幂等 + 快照；`disableAllHooks` 场景处理 | 写前快照（轮转 5 份）+ 损坏拒写 + `disableAllHooks` 标注 + 幂等 | 持平（nx-rp 更细化：损坏 JSON 拒写保护） |

## 可借鉴项分级（Claude-only 前提下）

### A 级：直接可落地，与宿主无关

1. **STDIN EOF 竞速**（`hook-dispatch-cli.ts:44` STDIN_READ_TIMEOUT_MS=1s）——防宿主写 payload 不关管道导致挂到 timeout；nx-rp 现为 3s 纯超时，可改为「竞速 + 用已收内容」
2. **半截 JSON 字段抢救**（`parseStdin` salvage 路径）——nx-rp 现在坏 JSON 整体丢，至少可救回 `session_id`/`cwd`
3. **会话 ID 派生统一**（`deriveSessionId`：payload → env → pid+cwd）——nx-rp 两条 hook 各自裸取 `session_id`，统一后跨事件可关联
4. **dedup 缓存文件模式**（`~/.teamai/sessions/<sid>-*.json` + TTL）——「本会话已提示过」类幂等靠文件 TTL，nx-rp 未来做提示类 hook 直接可用

### B 级：需要新事件 hook，先留设计位

5. **Stop 结算 hook**——摩擦分/会话总结的前置；需 transcript 解析，工作量大
6. **additionalContext 回注**——Claude 格式简单（`hookSpecificOutput.additionalContext`），可做「会话开始注入项目上下文」类功能
7. **TodoWrite 提示**（session 级 dedup 一次）——依赖回注能力

### C 级：明确不借

8. 多宿主翻译层、golden 字节锁、WMI detached spawn——均为 9 宿主支持服务的复杂度，Claude-only 不需要

## 实现程度总结

- teamai-cli 的 hook 层是**平台级**：数据化 HookDef、dispatcher、前后台分离、多宿主渲染、团队数据闭环
- nx-rp 的 hook 层是**单宿主工具级**：两条记录型 hook 打磨得干净（外科手术写入、同源断言、永不报错铁律、cwd scope 隔离），但缺事件广度（无 Stop/SessionStart）与回注能力
- 借鉴重点不是追平平台级复杂度，而是 A 级 4 项工程细节（容错与幂等）+ B 级按需扩展

# prompt-log · 提示词日志 + Skill 追踪（两个 hook 模块）的使用与排障

> 加载时机：用户要「记录我在 Claude Code 里发的提示词 / skill 用了多少」「管理 hook 开关」，
> 或 hook 表现为不记录 / 疑似干扰会话需要排障时。
> 一句话：两个 hook 模块平级独立——`nx-rp hook on` 开提示词日志、`nx-rp hook skill-on` 开 Skill 追踪；
> hook 本体是 `nx-rp hook capture`（UserPromptSubmit）与 `nx-rp hook skill-track`（PostToolUse·Skill），async 后台跑。

---

## 一、它们是什么

两个平级的 hook 模块（面板各自一个 tab，与链接/文档/工作流平级），开关互不影响：

- **hook-prompt 提示词日志**（UserPromptSubmit）：每次提交提示词，
  事件 JSON 从 stdin 进入 `nx-rp hook capture`，追加一行到本地 JSONL。
- **hook-skill Skill 追踪**（PostToolUse，matcher `Skill`）：每次 skill 调用进入
  `nx-rp hook skill-track`，追加一行到 skills JSONL；`hook skills` 聚合出
  健康分（借鉴 teamai-cli）：**使用分 0-60**（相对最高频 skill 归一）+ **新鲜度 0-40**
  （30 天线性衰减），显示为五星。

记录按 cwd 自动分目录——不同项目互不混杂。

配置写在 `~/.claude/settings.json`（用户级），每个模块只动自己那条 entry
（带 `__nx_rp_prompt_log__` / `__nx_rp_skill_track__` marker 指纹），
**其余 hooks 与 settings 键一律不碰**——两个开关互不误伤。

## 二、命令

```
nx-rp hook on                # 提示词日志：启用（幂等）；写前自动留 settings.json 快照
nx-rp hook off [--dry-run]   # 提示词日志：停用；只摘自己的组
nx-rp hook skill-on          # Skill 追踪：启用（幂等）
nx-rp hook skill-off         # Skill 追踪：停用
nx-rp hook status            # 提示词日志：开关状态 + 日志目录
nx-rp hook skill-status      # Skill 追踪：开关状态 + 统计目录
nx-rp hook log [--all] [--limit N] [--json]  # 提示词记录，最新在前
nx-rp hook skills [--all] [--limit N]        # Skill 统计 + 健康分
nx-rp hook capture           # hook 落点（stdin 收 UserPromptSubmit 事件；永不报错、退出码恒 0）
nx-rp hook skill-track       # hook 落点（stdin 收 PostToolUse 事件；永不报错、退出码恒 0）
```

**面板等价**：`nx-rp serve` 后「提示词日志」「Skill 追踪」两个 tab 有同构操作——
各自的记录/统计卡片、开关状态卡片（含 `disableAllHooks` 警告）、启用/停用按钮
（停用走确认弹窗）、手动添加片段卡片。面板调的是同一条 action，不存在第二份逻辑。

日志文件：`~/.nx-rp/prompts/<cwd哈希>.jsonl`，每行：

```json
{"ts":"2026-09-21T02:21:41.974Z","cwd":"D:/proj","sessionId":"abc","prompt":"..."}
```

Skill 记录：`~/.nx-rp/skills/<cwd哈希>.jsonl`，每行：

```json
{"ts":"2026-09-22T10:28:50.000Z","cwd":"D:/proj","sessionId":"abc","skill":"nx-rp"}
```

## 三、agent 典型场景

- 「帮我看看最近在这个项目都让 AI 干了什么」→ `nx-rp hook log --limit 20`
- 「哪些 skill 常用 / 哪些僵死了」→ `nx-rp hook skills`（星级低的要么是没用过，要么久未用）
- 「skill 记录别记了，提示词继续记」→ `nx-rp hook skill-off`（两个开关独立）
- 「这些记录别记了」→ 对应模块 `hook off` / `hook skill-off`（settings 有快照可恢复）
- 用户问「hook 会不会拖慢会话」→ 不会：两条 entry 都配了 `async: true`（后台跑，不给当轮加延迟）
  + `timeout: 10` 兜底；capture / skill-track 本身任何异常静默吞掉。

## 四、排障

| 症状 | 先查 | 说明 |
| --- | --- | --- |
| `hook log` 一直是空 | `nx-rp hook status` 是否已启用 | 未启用则 `hook on`；启用后新会话才生效（settings 有文件监听，通常免重启） |
| `hook skills` 一直是空 | `nx-rp hook skill-status` 是否已启用 | 两个开关独立，只开了提示词日志时 skill 不会被记 |
| 已启用但记不到 | 全局 `"disableAllHooks": true` | status 会提示；它一票否决所有 hooks |
| 全局 nx-rp 没有 skill-on 等子命令 | `nx-rp version` < 0.3.1 | 升级全局包（`pnpm run link:local` 或 npm 重装） |
| 想核对配置长什么样 | settings.json 的 `hooks.UserPromptSubmit` / `hooks.PostToolUse` | 我们的 entry 带 marker 字段，一眼可辨 |
| 误改了 settings.json | 同目录 `settings.json.nx-rp-bak-<时间戳>` | 写前快照，直接覆盖回去即可 |

## 五、为什么这么设计（不变量）

- **每个 hook 一个模块一个 tab**：开关与数据天然对应，"这个 tab 的按钮动哪条配置" 一目了然
- **外科手术写入**：按 marker 认亲，只增删自己的 entry；模块拆分后互不误伤有单测锁死
- **永不报错**：capture/skill-track 的 run 包 try/catch 兜底，退出码恒 0——hook 在 transcript 里零存在感
- **CLI/Web 同源**：同一份 action 声明派生 CLI 命令与 HTTP 路由，registry 装载期自检防分叉

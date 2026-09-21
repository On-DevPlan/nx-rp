# prompt-log · 提示词日志 hook 的使用与排障

> 加载时机：用户要「记录我在 Claude Code 里发的提示词」「管理 prompt log hook 的开关」，
> 或 hook 表现为不记录 / 疑似干扰会话需要排障时。
> 一句话：`nx-rp hook on` 开、`nx-rp hook log` 查；hook 本体是 `nx-rp hook capture`，挂在 UserPromptSubmit 上，async 后台跑。

---

## 一、它是什么

一条 Claude Code **UserPromptSubmit** hook：每个会话里用户每次提交提示词，
事件 JSON 从 stdin 进入 `nx-rp hook capture`，追加一行到本地 JSONL。
记录按 cwd 自动分目录——不同项目互不混杂。

配置写在 `~/.claude/settings.json`（用户级），本工具只动自己那条 entry
（带 `__nx_rp_prompt_log__` marker 指纹），**其余 hooks 与 settings 键一律不碰**。

## 二、命令

```
nx-rp hook on                # 启用（幂等）；写前自动留 settings.json 快照
nx-rp hook on --dry-run      # 只预览，不写盘
nx-rp hook off [--dry-run]   # 停用；只摘自己的组，hooks 空了连字段一起摘
nx-rp hook status            # 开关状态 + 日志目录 + disableAllHooks 提示
nx-rp hook log               # 当前 cwd 的记录，最新在前（默认 50 条）
nx-rp hook log --all         # 跨全部目录
nx-rp hook log --limit N     # 条数
nx-rp hook log --json        # 机器可读
nx-rp hook capture           # hook 落点（stdin 收事件 JSON；永不报错、退出码恒 0）
```

日志文件：`~/.nx-rp/prompts/<cwd哈希>.jsonl`，每行：

```json
{"ts":"2026-09-21T02:21:41.974Z","cwd":"D:/proj","sessionId":"abc","prompt":"..."}
```

## 三、agent 典型场景

- 「帮我看看最近在这个项目都让 AI 干了什么」→ `nx-rp hook log --limit 20`
- 「这些记录别记了」→ `nx-rp hook off`（告知用户可随时 `hook on` 恢复，settings 有快照）
- 用户问「hook 会不会拖慢会话」→ 不会：entry 配了 `async: true`（后台跑，不给当轮加延迟）
  + `timeout: 10` 兜底；capture 本身任何异常静默吞掉。

## 四、排障

| 症状 | 先查 | 说明 |
| --- | --- | --- |
| `hook log` 一直是空 | `nx-rp hook status` 是否已启用 | 未启用则 `hook on`；启用后新会话才生效（settings 有文件监听，通常免重启） |
| 已启用但记不到 | 全局 `"disableAllHooks": true` | status 会提示；它一票否决所有 hooks |
| 全局 nx-rp 没有 hook 子命令 | `nx-rp version` < 0.2.0 | 升级全局包，或临时改用本地仓库绝对路径 |
| 想核对配置长什么样 | settings.json 的 `hooks.UserPromptSubmit` | 我们的 entry 带 marker 字段，一眼可辨 |
| 误改了 settings.json | 同目录 `settings.json.nx-rp-bak-<时间戳>` | 写前快照，直接覆盖回去即可 |

## 五、为什么这么设计（不变量）

1. **capture 永不抛错**——hook 协议里非零退出码会留错误记录；日志 hook 的存在感必须是零。
2. **外科手术式改 settings**——按 marker 认亲，幂等；用户手工配的其他 hooks 原样保留。
3. **破坏性写必有退路**——on/off 写前快照 + `--dry-run` 预览。

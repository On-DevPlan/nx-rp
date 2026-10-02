# loop-commands — 命令语义与状态机

`rp-loop` 的命令面。所有命令同时有 Web 面板等价物（`nx-rp serve` → 「循环」tab）。

## 一、开关（项目级）

```
nx-rp loop on   [--scope local|shared] [--dry-run]
nx-rp loop off  [--dry-run]
nx-rp loop status
```

**开关是项目级的，不是全局的**——这是与官方 ralph-loop 插件最大的结构差异：

| 作用域 | 目标文件 | 是否入库 |
| --- | --- | --- |
| `local`（默认） | `<项目>/.claude/settings.local.json` | 通常 gitignore（个人） |
| `shared` | `<项目>/.claude/settings.json` | 通常入库（团队共享） |

- 默认写 `local`：hook 命令引用的是**本机装的 nx-rp**，对没装的同事毫无意义，
  且写入/快照会污染仓库
- 写 `local` 时会**自动补一行 `.gitignore` 忽略规则**，并在输出里明确告知
- **快照集中到 `~/.nx-rp/snapshots/`**，不落进项目目录
- `--scope shared` 不碰 `.gitignore`

`status` 会分别报两个文件的开关状态（`detail.local` / `detail.shared`），
以及当前目录的循环列表。

## 二、布防与取消

```
nx-rp loop start "<prompt>" [--max-iterations N] [--completion-promise TEXT] [--session-id ID] [--cwd DIR]
nx-rp loop start - [...] <<'EOF'      # prompt 传 `-` = 从 stdin 读（多行必用）
nx-rp loop cancel [--id <loop-id>]
```

| flag | 默认 | 语义 |
| --- | --- | --- |
| `--max-iterations` | `20` | 轮次上限。**显式 `0` = 无限**（不会被抬成 20） |
| `--completion-promise` | 无 | 完成短语。**字面量精确匹配**（区分大小写、空白归一）。**不传 = 仅轮次循环**——永不判定完成，跑到上限或手动 cancel 才停；每轮 systemMessage 明示「未设完成承诺」。用户只要轮次循环 / 没提结束关键词时就不传，不要自己发明承诺词 |
| `--session-id` | 读 `CLAUDE_CODE_SESSION_ID` | 绑定会话；通常不用手传 |
| `--cwd` | 当前 cwd | 作用目录（决定状态文件落到哪个哈希桶） |

### prompt 传 `-`：多行长规范的主通道

任务描述通常是多行（长规范、分点要求），**当命令行参数传会被平台切开**：

```
实测（Windows / Git Bash）：
  loop start "$P" --max-iterations 7      # P = "第一行\n第二行"
  → 程序收到的 argv = ['loop','start','第一行']     ← 只剩第一行
    argv 个数 9 → 5，--max-iterations / --session-id 全丢
  → 上限静默变成默认 20、承诺词变成 null
```

传 `-` 走 stdin，多行内容不经过 argv：

```bash
nx-rp loop start - --max-iterations 7 <<'EOF'
多行任务描述
第二行
EOF
```

- 末尾换行会被 trim（heredoc 必带）；首尾空白对任务描述无意义
- `loop update --prompt -` 同规则
- 管道亦可：`cat spec.md | nx-rp loop start - ...`
- stdin 为空 → 报 `INVALID_INPUT` 并给出用法，**不会建出空循环**

`cancel` 不带 `--id` 时取消该目录下**全部活跃**循环。取消是**标记 `active:false` 而不删记录**，
所以 `status` 还能看到历史。

## 三、观测

```
nx-rp loop status        # hook 开关（两个项目级文件明细）+ 循环列表
nx-rp loop log [--all] [--limit N]
```

`loop log` 每轮一行，`decision` 取三种：

| decision | 含义 |
| --- | --- |
| `continue` | 未命中承诺 → 迭代 +1，prompt 被灌回 |
| `promise-hit` | 命中承诺 → 循环结束 |
| `max-iterations` | 到达上限 → 循环结束 |

`continue` 行里会记 `lastTextChars`（从 transcript 解析到的最后一条 assistant 文本长度）。
**字数为 `null` 或 `0` 说明 transcript 解析失效**——这是判断"循环为什么不结束"的第一手线索。

## 四、Stop hook 的判决分支

Stop hook 落点 `nx-rp loop stop` 是 **cli-only**（`http: null`）——它的入参是 hook 协议的
stdin 事件 JSON，输出判决 JSON，面板没有对应交互。

| # | 条件 | 输出 |
| --- | --- | --- |
| 1 | 无任何活跃循环 | 空（放行） |
| 2 | 有循环但不属于本会话 | 空（放行），不写审计 |
| 3 | 迭代数已达上限 | `{"systemMessage":"🛑 …"}`，循环标记结束 |
| 4 | 最后一条 assistant 文本含 `<promise>X</promise>` 且 `X ==` 承诺词 | `{"systemMessage":"✅ …"}`，循环结束 |
| 5 | 未命中且未超限 | `{"decision":"block","reason":"<prompt原文>","systemMessage":"🔄 第 N/M 轮"}` |
| 6 | 任何异常（transcript 缺失/坏行/状态损坏/抢锁失败） | 空（放行） |

**任何情况下退出码恒为 0、绝不抛错**——Stop hook 失败会直接卡住用户会话。

### 关键取舍：读不到 transcript 时保持 active

分支 6 里，若 transcript 读不到，nx-rp **不终结循环**（保持 `active`，这一轮放行）。
官方 ralph-loop 在这里会 `rm` 掉状态文件——一次瞬时 IO 抖动就永久杀掉循环。
排障时容易误判这条：看不到日志 ≠ 循环挂了。

### `reason` 是 prompt 原文

分支 5 的 `reason` 严格等于 prompt 原文（不含轮次等元信息）——这样 prompt 是稳定前缀，
有利于 KV cache，且 agent 每轮看到的任务描述完全一致。

## 五、会话隔离（多实例）

状态文件按 cwd 分文件，内容是**数组**，所以同一项目可多会话并行：

```
~/.nx-rp/loops/<cwdSha1>.json    # { loops: [ {id, sessionId, claudeSessionId, ...} ] }
~/.nx-rp/loops/<cwdSha1>.jsonl   # 审计日志
```

Stop hook 触发时按会话选路（`pickLoop`）：

1. 用事件声明的 `session_id` 去比对 loop 的 `sessionId` 与 `claudeSessionId`
2. 都不中，但存在**恰好一条**完全没有会话标识的活跃 loop → 收养它（回填 sessionId）
3. 多条无名候选 → **歧义，放行**（宁可循环不动，也不能把 A 的 prompt 灌进 B）

`sessionId` 来自显式 `--session-id`；`claudeSessionId` 来自启动时读 `CLAUDE_CODE_SESSION_ID`
环境变量（agent 用 Bash 工具调用时会自动带上）。两者都是"这个会话"的等价标识。

## 六、与官方 ralph-loop 插件的命令对照

| 官方插件 | nx-rp |
| --- | --- |
| 插件自带的 start 命令（带 max-iterations / completion-promise 参数） | `nx-rp loop start "<p>" --max-iterations N --completion-promise X` |
| 插件自带的 cancel 命令 | `nx-rp loop cancel` |
| 读项目内的状态文件看轮次 | `nx-rp loop status` |
| （无） | `nx-rp loop log` / Web 面板 |

**不要混用**：两者的 Stop hook 若在同一会话同时启用，会各自 block，行为叠加。
本 skill 只用 nx-rp 的命令名——官方插件的命令名在这里统统不存在。

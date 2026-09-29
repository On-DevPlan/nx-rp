# loop-troubleshooting — 排障清单

## 一、循环根本没起来

| 症状 | 先查 | 说明 |
| --- | --- | --- |
| 回合照常结束，prompt 没被灌回 | `nx-rp loop status` | hook 是否已启用；循环是否还在 `active` |
| hook 显示未启用 | 本项目跑过 `nx-rp loop on` 吗 | **开关是项目级的**——在 A 项目启用不生效于 B 项目 |
| 已启用但不拦 | 全局 `"disableAllHooks": true` | status 会提示；它一票否决所有 hooks |
| 已启用但本会话不拦 | `sessionId` 是否匹配 | `loop status` 看循环的 `sessionId`；是不是在**另一个会话**里看这个循环 |
| 在错误的目录跑 | `--cwd` / 当前目录 | 状态文件按 cwd 哈希分桶，换目录就是另一个循环 |

**最快的自检**：手动喂一个事件给 Stop 落点，看它出不出判决 JSON。

```bash
echo '{"hook_event_name":"Stop","session_id":"<你的会话id>","transcript_path":"<transcript路径>","cwd":"<项目路径>"}' \
  | nx-rp loop stop
```

- 输出 `{"decision":"block",...}` → 落点正常，问题在 hook 是否真的被 Claude Code 调用
- 输出为空 → 落点认为"不归我管"（无循环 / 会话不匹配 / 读不到 transcript）

## 二、循环停不下来

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 一直在灌回 | 没设 `--completion-promise` | 只能靠 `--max-iterations` 收口；或直接 `nx-rp loop cancel` |
| 一直在灌回 | `--max-iterations 0`（无限） | `nx-rp loop cancel` |
| 一直在灌回 | 承诺词太常见或判据模糊，模型总不输出 | 改判据；先 `cancel` 再重新布防 |
| 到上限也不停 | 检查上限是否真写进了状态 | `nx-rp loop status` 看 `iteration/max` |

`nx-rp loop cancel` 是**标记结束**（保留记录），不是删文件——所以随时可安全执行。

## 三、输出过承诺却没停

按可能性排序：

1. **标签不在最后一条 assistant 文本里**。若最后一条 assistant 消息全是 `tool_use` 没有文本块，
   或最新一行文本是空的，就取不到标签 → 判定为未命中。**空文本块不会往前翻**（这是刻意的：
   往前翻会把上一轮遗留的旧 `<promise>` 翻出来，造成提前误判完成）。
2. **承诺词不完全一致**。匹配是字面量精确比较：大小写不同（`done` vs `DONE`）、
   内部空白归一后仍不同，都不算命中。
3. **标签在子 agent 的输出里**。`isSidechain` 的助手文本**不算**完成信号——
   循环的完成判据只认主 agent 最后一条文本。
4. **promise 未设**（`null`）——此时任何 `<promise>` 都不算完成，见「停不下来」。

**诊断命令**：`nx-rp loop log` 看该轮的 `promise` 与 `lastTextChars`。
`lastTextChars: null` = transcript 没解析到文本，问题在 1；有字数但 `promise: null` = 标签没写或写错。

## 四、transcript 解析相关

| 现象 | 说明 |
| --- | --- |
| `lastTextChars` 一直是 `null` | transcript 路径不对 / 文件不可读 / 尾部窗口内没有 assistant 文本 |
| 大 transcript | 只读文件尾（默认 2MB 上限内）+ 最多扫 100 行，不会整体读入 |
| 解析失效的后果 | 方向是安全的：**检测不到承诺 → 继续循环**，不会误判完成。配合 `--max-iterations` 可控 |

注意：**读不到 transcript 时循环保持 active**（这一轮放行），不像官方插件那样终结循环。

## 五、会话归属混乱

| 现象 | 处理 |
| --- | --- |
| 几个会话都在推进同一个循环 | `loop status` 看 `sessionId`；用 `--session-id` 显式绑定 |
| 布防后本会话不生效 | 检查是不是在别的会话/目录布防的 |
| `sessionId` 与 `claudeSessionId` 都为 null | 启动时既没传 `--session-id` 也拿不到 `CLAUDE_CODE_SESSION_ID`。此时若只有一条活跃循环会被"收养"，多条则歧义放行 |

## 六、与官方 ralph-loop 插件并存

**两者都写 Stop hook。** nx-rp 只动自己 marker（`__nx_rp_loop__`）的 entry，
**不会误删**官方插件的配置；但**同一会话同时启用两套会让两边都 block**，行为叠加、承诺判定混乱。

排查：

```bash
nx-rp loop status                    # 看本项目两个 settings 文件的 detail
cat .claude/settings.local.json      # 看 hooks.Stop 数组里有几条
cat ~/.claude/settings.json          # 官方插件可能配在用户级
```

同一会话里只启用一套。

## 七、彻底拆掉

```bash
nx-rp loop cancel       # 先停掉活跃循环
nx-rp loop off          # 摘掉本项目两个 settings 文件里的 hook
```

然后确认：

- `.claude/settings.local.json` 里 `hooks.Stop` 已空（或字段消失）
- `.gitignore` 里那行 `.claude/settings.local.json` 是否还需要（不用可手删）
- `~/.nx-rp/loops/` 下的状态与审计日志（想留着回顾就留着）

快照在 `~/.nx-rp/snapshots/`，需要回滚时直接覆盖回对应的 settings 文件。

## 八、面板

`nx-rp serve` → 「循环」tab 能看到：hook 开关（两个项目级文件明细）、循环列表（带轮次进度条）、
迭代日志。Web 与 CLI 同源，面板上每个按钮都有等价命令。

# Changelog

## 0.9.7 / 2026-10-02

- **loop：「仅轮次循环」升为一等结束模式**（特性型）
  - 支持三种结束形态：仅轮次（不传 `--completion-promise`，跑满上限自动停 / 手动 cancel）、
    无限（上限 0，只能手动 cancel）、承诺模式（输出 `<promise>X</promise>` 提前停，上限兜底）
  - service 层本就支持（空 promise → 永不判定完成），但三个入口都没把「仅轮次」当一等公民暴露：
    - CLI：`--completion-promise` 的 hint 明示「不传 = 仅轮次循环」；布防输出的无承诺分支
      改措辞「仅轮次循环：跑到上限或手动 cancel 才停」
    - 面板：完成短语默认从 `'COMPLETE'` 改为**留空**（原默认是反的——不想要承诺词还得手动删）；
      placeholder 提示「留空 = 仅轮次循环」；完成判定提示语三态化
    - skill：SKILL.md 新增「两种结束模式」对照表（承诺 vs 仅轮次 + 各自适合场景），
      并写明关键指令——**用户只要轮次循环 / 没提结束关键词时不传该 flag，不要自己发明承诺词**
      （编出来的词可能在正常叙述里出现，造成提前误停）；三条铁律同步改写
  - 每轮 `systemMessage` 明示「未设完成承诺」且不含 `<promise>` 字样——模型不会被诱导输出承诺词
  - 测试：仅轮次全链路（布防 null → 每轮 block → 上限收口 → 审计链 2 continue + 1 max-iterations）
    + CLI hint 断言；全量 219 单测 + 7 smoke 全绿

## 0.9.6 / 2026-09-29

- **loop：修改绑会话不彻底 + 面板 tab 重排**（修复型）
  - **修：改绑会话时必须同时清 env 残留的 `claudeSessionId`**（真实事故）
    - `loop-6` 被错误绑到会话 A（env 捕获把两个会话字段都写成了 A）；
      用 `loop update --session-id B` 改绑后，A 的 Stop 事件**仍继续命中它**——
      `updateLoop` 只更新了 `sessionId`，`claudeSessionId` 还留着 A；
      `pickLoop` 的语义是「payload 的 session_id 比对两个字段、取先命中者」，
      于是**改绑不彻底等于没改**，iteration 还在错误会话里往上涨。
    - 修法：显式改绑 `sessionId` 时，若 `claudeSessionId` 与新值不同 → 一并清 null
      （它是「启动进程 env 的残留」，代表执行进程而非用户意图；改绑场景恰恰是
      「env 绑错了」）。传空串（清显式绑定）时保留 `claudeSessionId`——
      那是唯一剩下的身份。
    - 回归测试锁死两个方向；全量 212 单测全绿。
  - **同时落地**：`SubagentStop` 放行不认领——子 agent 与主 agent **共享 session_id**
    （实测），不加闸时子 agent 的回合边界会被当成主会话的，凭空消耗一个轮次。
    放在读状态/抢锁之前：不该发生的事不留痕（不占锁、不写状态、不写审计）。
  - **ui：面板 tab 重排**——提示词日志 / Skill 追踪 / 循环 三个最常看的面板移到最前
    （原来排在文档与召回 / 依赖图之后，要点两次才能到）。

## 0.9.5 / 2026-09-29

- **loop：审计日志存原文 + prompt 版本回溯**（特性型）
  - **审计日志存原文而非折叠单行**（用户：「支持查看全部的成果输出呀 截断干嘛」）
    - 存的是 `text.replace(/\s+/g, ' ')` 折叠后的单行——换行没了，markdown 结构
      （标题/列表/表格）全丢，弹窗里是挤成一坨的文本。改为存**原文**；
      列表摘要另存 `lastTextHead`（由原文折叠，仅原文含换行时才存）。
    - 上限 200 字 → 4000 字 → **50KB（按字节）**。用字节而非字符数：中文 3 字节/字，
      按字符算会让中文条目比英文长 3 倍。`capBytes()` 按 UTF-8 安全截断，
      不切断多字节字符（否则 `JSON.stringify` 产出 U+FFFD）。
      真超限时记 `lastTextTruncated`，弹窗明示「不是完整回复」而非假装完整。
    - 旧条目（v0.9.3 之前）只有 200 字且已折叠，补不回来——弹窗明说
      「这是 v0.9.3 之前记的旧条目」，别让人以为是被新逻辑截的。
  - **prompt 版本回溯**（补齐 loop 相对 ralph-loop 引入的新缺口）
    - ralph-loop 的 prompt 是静态的（写完从不改），所以没有版本问题；
      nx-rp 支持 `updateLoop` 改任务描述后，「第 N 轮用的是哪版 prompt」成了真问题
      ——审计里只有产出、没有指令，复盘时不知道当时在做什么。
    - 状态文件加 `promptVersion`（当前版号）+ `promptVersions`（历史，**上限 10 版**，
      超出丢最旧）。首次布防不存历史——当前版就在 `prompt` 字段里，再存一份纯浪费。
    - 审计**只记版号**（一个整数），不记全文：每轮复制一份几百字的 prompt 会把
      append-only 的 JSONL 撑爆。回溯时按版号去状态文件的 `promptVersions` 查。
    - 面板：审计弹窗显示「本轮任务描述 v3」，可展开看当轮全文；
      当前版标「（当前版）」，被改过的标「（历史版——之后被改过）」，
      超出保留上限标「已超出保留上限，无法回溯」。
      编辑弹窗显示当前版号与已保留的历史版数。
    - 老记录（无该字段）按 v1 读，不崩。
  - 全量 206 单测（新增 3 条：版本归档与升号、历史超限淘汰、老记录兼容）+ 7 smoke；
    lint / build 通过；面板两个弹窗均浏览器实测（含「改过 prompt 后回溯历史版全文」的闭环）

## 0.9.4 / 2026-09-29

- **提示词日志：目录切换修好；Skill 追踪：去掉伪 scope**（修复型）
  - **修：提示词日志的目录下拉从来就是空的**（用户报告「切换不同的组没有显示，
    但显示所有日志又有显示」的**主因**）
    - 面板请求 `/api/hook-prompt/log?shape=with-groups`，但 `shape` **没在 action 里
      声明成 flag**。`applySpec` 只透传声明过的参数 → 参数被静默丢弃 → 服务端永远返回
      裸数组 → `Array.isArray(res.groups)` 恒为 false → `setGroups([])`。
      于是下拉永远显示「全部路径（0 个）」——**根本没有组可切**。
  - **修：同一目录被拆成两条组**（次因）
    - 分组按记录里的**原始 cwd 字符串**建、又用**子串**筛选。`D:\a\x` 记 178 条、
      `D:/a/x` 记 1 条 → 两条组指同一目录；选中其一，另一条形态的记录一条都匹配不上 → 空白。
    - 存储侧 `hashOf()` 本就按 `normalizeScope()` 归一后又 sha1（两个形态**同文件**，
      无需迁移历史数据）；坏的只是读侧，现在分组与筛选一律走归一化 key。
    - 子串筛选换成按归一化 key 精确选文件，顺带修掉 `proj-alpha` 会误捞 `proj-alpha-2`。
  - **目录筛选器只列「已注册目录」**（`store.recents`，上限 20）
    - 日志文件里堆着一堆只跑过一次的临时目录（`.tool/xxx`、某个 repo 子目录…），
      它们不是用户的项目，不该出现在筛选器里。已注册目录之外的一律不列，并明示未列出几个。
  - **目录切换用紧凑下拉**，不再平铺胶囊
    - 曾把全量目录平铺成一排 chip——提示词一多就铺满整屏。改回下拉（跟随当前目录 + 已注册目录，
      当前项并入首项避免两条同值 option），只在锁定时多出一个「↺ 跟随当前目录」按钮。
  - **组列表恒为全量**：切换器不随筛选收窄，否则切进一个目录后就再也切不出去（已加测试锁死）。
  - **修：Skill 追踪的 scope 是伪概念**（用户指出：skill 追踪本身就是全局，没有跨目录一说）
    - skill 装在 `~/.claude/skills` 或 `<项目>/.claude/skills`，是**跨目录的全局资产**。
      原 `skillStats({ all })` 默认只读当前 cwd 那一个分片，健康分只反映当前目录的采样。
    - 现在**无条件全局聚合**，删掉 `--all` flag 与面板「跨全部目录」勾选框。
      （落盘仍按 cwd 分片——那只是并发追加的分片策略，与查询无关。）
  - **修：`eslint.config.js` 的 ignores 漏了 `.tool/`**
    - `.tool/` 与 `.playwright-mcp/` 在 `.gitignore` 里是明确的「本地工具产物」，
      却会被 lint 扫到：随便放个临时脚本就 `pnpm test` 全红。与 `.claude/` 同理排除。
  - 新增 3 条回归测试（其中 2 条经**反向验证**确认能抓住原 bug：装回旧行为即变红）；
    全量 203 单测 + 7 smoke 全绿；lint / build 通过；面板用无头浏览器实测
    （默认 181 条 → 切组 133 条 → 点跟随回 181 条，console 无错误）

## 0.9.3 / 2026-09-29

- **loop 面板：审计日志可展开看成果 + 编辑改弹窗 + 修 CI 测试隔离**（修复型）
  - **修：CI 上 2 个单测失败**（v0.9.2 发布为此中断）
    - `startLoop：缺 prompt 抛 INVALID_INPUT；maxIterations 0 = 无限` 与
      `cancelLoop：标记 inactive 但保留记录` 在 Linux CI 上挂——它们调
      `startLoop({ prompt, cwd })` 不传 sessionId，而 0.9.2 新加的「拿不到会话身份
      就报错」在 CI（无 `CLAUDE_CODE_SESSION_ID`）上抛错。
    - 本地全绿是因为在 Claude Code 里跑、env 有值——**测试依赖了宿主环境**。
      修法：`beforeEach` 抹掉会话 env（需要它的用例自己设置），两个用例显式传 sessionId。
  - **审计日志点开看完整成果**
    - 列表行只放一句摘要（`promise=… · 解析到 N 字`），新增「成果」按钮弹窗看全文——
      那一轮 Agent 到底做了什么，之前只看得到一句。
    - `lastText` 存储上限由 200 字提到 4000 字（`AUDIT_TEXT_CAP`）：200 字没法复盘，
      全文又会把 append-only 的 JSONL 撑大，4000 是折中；面板在超出时明示「仅前 N 字」。
    - 修：`promise-hit` 与 `max-iterations` 两个**终止分支**的审计没记 `lastText`——
      而终止轮次恰恰最值得复盘。transcript 读取提到所有判定分支之前，三处共用同一份。
  - **编辑改弹窗**（原为展开式卡片）
    - 空间大得多：任务描述从 70px 小框变为 200px、可见全文（实测 1580 字的任务完整展示），
      并展示当前状态 / 开始时间 / 最后触发供对照。
    - 保存 / 放弃在弹窗底部，语义不变（点保存才提交）。
  - 全量 200 单测 + 7 smoke 全绿；lint / build 通过；面板两个弹窗均浏览器实测

## 0.9.2 / 2026-09-29

- **loop 面板：会话归属可见可选 + 循环可编辑可删除 + 拒绝匿名循环**（特性型）
  - **修 3 个 loop 面板的实际缺陷**（用户报告字体重叠后连带查出）
    - **字体重叠**：`.row` 的固定行高 `--row-h: 28px` 是给单行列表设计的，
      而循环列表的行里塞了元信息 + prompt + 进度条三行，内容溢出重叠。
      新增 `.row.wrap` 修饰类解除固定高度；循环列表与审计日志改用。
    - **会话归属误报「匿名」**：渲染只检查 `loop.sessionId`，忽略了
      `claudeSessionId`（启动时从 `CLAUDE_CODE_SESSION_ID` 捕获的）。
      于是靠 env 绑定好会话的循环被显示成「匿名——靠 pickLoop 的 env 兜底匹配」，
      与实际不符。**CLI 与面板两处都有此错**，已统一为
      「两个字段取先有值者」的 `sessionLabel()` / `SessionTag`。
    - **面板根本没把 `sessionId` 传给布防接口**：布防只能靠 env 捕获，
      用户无法指定会话。这是 `sessionId: null` 的根因。
  - **A. 会话绑定可见可选**
    - `hookStatus` 补 `currentSessionId`（读服务进程 env）；面板据此显示默认值。
      语义边界写进注释与 UI：这是**服务进程**的会话身份，`serve` 从普通终端启动时为
      null，此时面板明示「拿不到，请填」而非假装知道。
    - 布防表单新增「会话」输入 + 两态绑定提示（留空 / 显式分别提示绑到谁）。
    - CLI `loop start` 渲染改用 `sessionHint()`：绑错会话或没有身份时给出改绑命令。
    - CLI `loop status` 列表也显示会话短码（与面板同规则；env 捕获的带 `*`）——
      只说「无会话」而不显示归属，等于把「布防了却不会被触发」的原因藏起来。
  - **B. 匿名循环不该存在**
    - 删掉 `pickLoop` 末尾的「无名候选收养」回退——留着它只会给「身份匹配失败」
      提供一个静默兜底，掩盖真正的会话归属 bug。
    - `startLoop` 拿不到任何会话身份时抛 `INVALID_INPUT`（附解法），
      而不是静默建一条 Stop hook 永远认领不到的死循环。
    - 旧数据里已有的无名循环：读取不崩、列表标「无会话（旧数据）」、不被认领。
    - 说明边界：此校验跑在**启动进程**里，而 Stop hook 认领时用的是
      **hook 进程**的 env——所以是降低发生概率，非机制上根除。
  - **C. 布防任务可编辑**（为「动态规划」而设：跑起来之后目标会变）
    - `updateLoop({id, prompt, maxIterations, completionPromise, sessionId})`，走原子写。
    - **复活语义**：因到上限而停（`endReason === 'max-iterations'`）的循环，
      提高上限时自动 `active: true`（「再给它 20 轮」的自然表达）；
      手工 `cancel` 的不复活（那是用户的显式停止意图）；只改 prompt 不改上限的也不复活。
    - `sessionId` 可改绑——布防时绑错会话的补救。
    - action `loop.update`（`nx-rp loop update` / `POST /api/loop/update`）；
      面板用**展开式编辑卡片**（多字段，`useDialog` 只支持单输入框），
      改完点「保存」才提交、可「放弃」。
  - **D. 已结束的循环可删除**
    - `removeLoop` 真删记录（区别于 `cancel` 的「标记结束、记录留着」——
      面板上只增不减，列表会越堆越长）。默认只允许删已结束的，删活跃的需 `--force`。
    - action `loop.remove` + 面板「删除」按钮（活跃的显示「取消」，已结束的显示「删除」）。
  - `Copyable` 组件补可选 `style` prop（原先不透传，调用方传了会被静默丢弃）
  - 测试：loop 单测 44 条（新增 updateLoop 正常/复活/不复活/找不到 id、
    removeLoop 活跃拒绝与 force、startLoop 匿名拒绝、pickLoop 去回退后的行为）；
    全量 200 单测 + 7 smoke 全绿

## 0.9.1 / 2026-09-29

- **skill：`--group` 安装机制 + 新增 `rp-loop` skill + 修两处参数解析静默错路径**（特性型）
  - **修 1（`fix(skill)`）**：`skill install` 的位置参数是硬取 `argv[1]`、`--to` 靠 `indexOf`，
    踩出两处**静默**错路径（均已实测复现）
    - `skill install --force bogus` —— `argv[1]` 是 `--force` 被特判成「无名」，
      于是静默装成默认的 `nx-rp`，用户敲的名字被完全忽略且不报错
    - `skill install nx-rp --to --force` —— `--to` 缺值时静默回落到 `DEFAULT_SKILLS_DIR`
      （真实 `~/.claude/skills`），并把 `--force` 当目录名在当前目录建出 `--force/`
    - 解析集中到 `parseSkillArgs()`（install / get 共用）：已知 flag 缺值 / 空值 /
      值以 `-` 开头一律报错；未知 `--x` 容忍跳过；位置参数过多报错
  - **`--group` 安装**：`nx-rp skill install --group=rp-loop`
    - `assets/groups.json` 做「group 名 → skill 名列表」别名表，**group 名 ≡ skill 名**
      （一对一），`skills` 是数组为将来一对多留余地；路径恒由 `assets/<name>/` 推导，
      清单只做聚合，不改目录结构
    - 装载分层降级：清单缺失 / JSON 损坏 → 目录扫描兜底（不崩）；schema 错 → 抛错（不静默）
    - `--group=<v>` / `--group <v>` 两种写法；缺值 / 空值 / 值以 `-` 开头报错；
      与位置参数同时给报错（二者等价）
    - 返回形状：**单 skill 与今天逐字节一致**（多一个 `group` 字段），多 skill 才走聚合
      → `render` 四分支、`runGet` 消费点、既有测试全都不用动
    - 新增 `skill groups` 子命令（带 `source` 暴露「清单驱动 / 降级目录扫描」）
    - `get --group`：只允许单选；给了 `--group` 时位置参数左移一位
    - **无参数 `skill install` 仍装 `nx-rp`**（原命令行为不变）
  - **新增 `rp-loop` skill**（`assets/rp-loop/`，5 文件）
    - 把官方 Claude Code 插件 **ralph-loop** 的机制与哲学融进 nx-rp，教 agent 用
      **nx-rp 自己的 `loop` 命令**（不是官方插件的 slash 命令）
    - `SKILL.md`：三条铁律（布防前确认任务/可验证判据/轮次上限、完成承诺只在为真时输出、
      不设承诺则只能靠上限收口）+ 六条命令表 + 与官方插件的差异对照
      + 什么时候该用 / 不该用 + 排障速查
    - `description` 带**排除句**（一次性任务 / 需人工判断 / 判据说不清）——
      这是唯一一个「误触发会让会话被 Stop hook 拦住」的 skill，误用代价高
    - references：`loop-commands`（命令语义 + Stop hook 判决分支表 + 会话隔离算法）、
      `loop-prompt-craft`（prompt / 承诺词 / 上限怎么写，融合 ralph best practices）、
      `loop-troubleshooting`（表格化排障，含与官方插件并存的检查）、
      `ralph-philosophy`（原理、四条原则、nx-rp 的 5 处改造）
    - 内容严格只用 nx-rp 命令名，不抄官方插件的实现细节（避免把 agent 引向错误用法）
  - 交叉引用：`assets/nx-rp/SKILL.md` 补上 `--group` 与新 skill 的入口（此前完全没提 loop 模块）
  - smoke 新增交叉一致性断言：清单里每个 skill 的 `assets/<name>/SKILL.md` 必须存在，
    且**每个 group 名本身可当位置参数**（把「group 即 skill 名」这条决策固化成断言）
  - 测试：skill-group 23 条 + skill-get 28 条（含 5 条回归），全量 192 条

## 0.9.0 / 2026-09-29

- **loop：自引用循环（Ralph 技术）——Stop hook + 项目级开关 + Web 面板**（特性型，新模块）
  - 机制（复刻官方 ralph-loop 插件，纯 Node 重写）：
    - `nx-rp loop start "<任务>"` 布防 → 状态写 `~/.nx-rp/loops/<cwdSha1>.json`
    - `nx-rp loop stop` 是 Stop hook 落点：stdin 收事件 JSON，stdout 出判决 JSON
      - 未命中 → `{"decision":"block","reason":"<prompt 原文>","systemMessage":"🔄 第 N/M 轮"}`
      - 命中 `<promise>X</promise>` → `{"systemMessage":"✅ 完成"}`；超限 → `{"systemMessage":"🛑 已达上限"}`
      - 其余一律空输出放行；**永不抛错、退出码恒 0**
  - **开关基于项目**（与 ralph 的项目级语义一致）：
    - 默认写 `<项目>/.claude/settings.local.json`（本地级，个人），非全局 `~/.claude/settings.json`
      ——只有配了 hook 的项目才会被拦截退出
    - `--scope shared` 切到 `<项目>/.claude/settings.json`（项目级，入库，团队共享）
    - 写本地级时自动追加 `.gitignore` 忽略行并明确回报；`--scope shared` 不碰 .gitignore
    - **快照集中到 `~/.nx-rp/snapshots/`**，不落进项目目录污染仓库
  - 相对 ralph-loop 的加固：
    - 状态是**数组** + 会话选路 → 同一项目多会话**并行循环**互不干扰
      （ralph 是单文件单实例，同项目第二个会话会顶掉第一个）
    - 异常分支**保持 active 降级放行**（ralph 在 8 个错误路径上 `rm` 状态文件，
      一次瞬时 IO 抖动就永久终结循环）
    - `<promise>` 无标签时返回 `null`（ralph 的 perl 不匹配会返回**全文**，可能误判完成）
    - 排除 `isSidechain`（子 agent 的文本不算主 agent 的完成信号）
    - 每轮判定写审计日志（`~/.nx-rp/loops/<hash>.jsonl`），记 `lastTextChars`
      供面板一眼看出 transcript 解析是否失效
  - 协议纪律：`loop.stop` 刻意**不声明 render**——`cli.js` 的 `renderCli` 优先用
    `action.render`，一旦有 render，钩子拿到的就不是判决 JSON 而是人类可读文本，循环静默失效（smoke 断言锁死）
  - core 改动（向后兼容，另两个 hook 模块零影响）：
    - `core/paths.js` 加 `LOOPS_DIR` / `SNAPSHOTS_DIR` / `loopsFileFor` / `loopsLogFileFor`，
      并把 prompts/skills 的哈希分文件逻辑收敛到共用 `hashOf`
    - `core/claude-settings.js` 的 `readSettings` / `writeSettings` / `toggleSettings` /
      `snapshotSettings` 支持可选 `settingsPath` / `snapshotDir`（缺省＝原行为）
  - 面板：Hook 状态卡（本地级/项目级双路径明细）+ 布防表单 + 循环列表（带轮次进度条）
    + 迭代日志卡 + 复用 `ManualAddCard`（eventKey=Stop）
  - 测试 36 项全绿：六判决分支、transcript 畸形输入（坏行/空文本块/子 agent/尾部截断）、
    promise 精确匹配、项目级开关隔离与快照落点、.gitignore 保护、多实例并存

## 0.8.4 / 2026-09-28

- **hook-prompt：提示词日志 sessionId 落地 + UI / CLI 展示 + 按 cwd 分组筛选**（特性型）
  - 落点：捕获 UserPromptSubmit payload 的 `session_id`，写入 JSONL 记录的 `sessionId` 字段
    - 半截/坏 JSON 走 `salvageFields` 抢救，保证日志写入不丢
    - 测试覆盖正常事件 + 半截 JSON 两种路径
  - 展示：
    - 面板列表行：sessionId 收进行尾操作区做成小胶囊徽标（短码 + 点击复制完整 ID），
      与提示词文本物理隔离；查看弹窗底部给可点击复制的 `claude --resume <sid>` 整条命令
    - CLI `nx-rp hook log`：每条记录下方独立一行给恢复命令，整行可直接复制执行
  - 分组筛选：
    - `nx-rp hook log --all --groups`：仅显示 cwd 分组聚合，按最新 ts 倒序
    - `nx-rp hook log --all --cwd <substr>`：按 cwd 子串筛选（不区分大小写）
    - 面板「跨全部目录」勾选后右侧出现 cwd 下拉，每项带该路径的提示词条数；
      选定后表格只显示该 cwd 的记录
  - 性能：跨目录查询重写为「文件级早停 + 单文件 k 路归并达到 limit 全停」
    - cwdFilter 通过文件首行 JSON 拿 cwd 提前跳过不相关文件
    - groups 聚合与 limit 解耦（`TAIL_PER_FILE = max(limit*4, 200)` 单文件扫描上限），
      limit 缩到 1 仍能看到完整 cwd 列表
  - 测试 19 项全绿（含 cwdFilter 子串匹配 + groups 全量聚合 2 项新测）

## 0.8.1 / 2026-09-26

- **hook-skill：补斜杠追踪 + 修复重复记录 / snippet 冲突**（修复型）
  - 修 1：on/off 按 command 兜底认领手工粘贴的无 marker 条目
    - `core/claude-settings.js` 新增 `ownsGroup`：组归属 = marker 命中 **或**
      无 marker 但 `hooks[].command` 与本工具一致
    - 修此前「同一 Skill 调用记两次、健康分虚高 / 关掉开关 hook 还在跑」
    - 不误伤他人同 matcher 不同 command 的组
  - 修 2：补 slash 追踪，对标 teamai-cli `trackSlashHandler`
    - 用户敲 `/skill-name` 走 prompt 展开、不产生 Skill 工具调用——
      此前全部漏记
    - 加 `UserPromptSubmit` 落点（`nx-rp hook skill-slash`）：`/skill-name`
      提取首词 + **存在性校验**（`~/.claude/skills/<name>/SKILL.md` 或
      项目级 `.claude/skills/` 命中才记录）——防 `/usr/bin` 等误记成幻影 skill
    - 记录带 `via: 'slash'` 区分来源；记录文件不变
    - `skill-status` 分开报两条落点（`工具调用[✓/✗]` / `斜杠[✓/✗]`）
  - 修 3：手动添加 snippet 与 CLI 写盘的 entry **逐字节同源**
    - `manualSnippet()` 含 marker（之前刻意不带是错误取舍）
    - 面板「手动添加」粘进用户级再点「启用」不会重复；「停用」会一并摘除
    - 顺手把斜杠落点也带进 snippet
  - 命令兜底认亲保留——兜住历史遗留的无 marker 老片段与手写场景
- 测试 126 项全绿（hook-prompt 4 项 + hook-skill 8 项覆盖 marker / 兜底 / 斜杠存在性）

## 0.8.0 / 2026-09-25

- **删除 link 域**（破坏性变更——0.7.x 的 `nx-rp link` 命令与 `/api/links` 路由不再存在）：
  - 整个 `src/modules/link/` 模块下线：5 条 CRUD action（`link.list/get/add/update/remove`）、
    CLI 命令（`nx-rp link list/get/add/update/remove`）、HTTP 路由（`/api/links*`）、Web「链接」tab
  - store.json 的 scope 结构移除 `links` 集合（`normalizeScope` 读旧文件时自动丢弃，
    docs / workflows / recents 不受影响）
  - 库导出（`import { link } from 'nx-rp'`）与 eslint 分层白名单同步移除
  - 文档同步：README / SKILL.md（frontmatter 触发词也去掉「外部链接」）/ deps-graph.md 示例
  - 保留：`scripts/link-local.mjs`（本地开发 shim 工具，与 link 资源域无关）
- 面板首个 tab 变为「文档与召回」
- 测试 123 项全绿（store/deps fixture 从 link 样例换 doc 样例）

## 0.7.6 / 2026-09-24

- deps 面板双模式（预览 / 编辑）+ 渲染器换血 @viz-js/viz：
  - **预览**（默认）：服务端扫描结果 → Graphviz 官方 WASM（@viz-js/viz）渲染 SVG。
    布局准确性从自研 dagre 分层升级为 graphviz 官方引擎（dot/neato/fdp/circo/twopi
    全可用），任意合法 DOT 都能渲染——不再受自研子集解析器限制
  - **编辑**：textarea 看/改 DOT 文本，浏览器本地实时预览（300ms debounce，零网络往返）；
    语法错误结构化显示（render 返回 failure 不抛异常），**旧图降透明保留**——
    打字的非法中间态不清空不闪烁；「回填扫描结果」覆盖前确认
  - 新 action `deps.save`（POST /api/deps/save）：DOT 文本落盘到 cwd（激活 scope）相对路径，
    `.dot`/`.gv` 扩展名强制、`..` 穿越与绝对路径拒绝、2MB 上限、二进制（NUL）拒绝；
    `--dot` 缺省 = 重新扫描后保存（`nx-rp deps save --file deps.dot` 即导出 graphviz 文件）
  - 新 action `deps.load`（GET /api/deps/load）：读外部 .dot 文本（绝对路径可读——导入本就
    跨目录；相对按激活 scope；200K 上限、二进制拒绝——边界对齐 annotations load）
  - 面板另存走输入对话框（预填 .nx-rp-deps.dot）；导入走前端 FileReader 直读不落盘；
    缩放 −/＋/适应（25-400%），graphviz svg 自带 viewBox 等比缩放
  - **删除**：自研 DOT 解析器 dot.js、@xyflow/react、@dagrejs/dagre 依赖及 xyflow 全局
    CSS——deps chunk 纯 viz（1.36MB，懒加载不影响其它 tab 首屏）；deps.scan 的扫描根
    改按 cwdDir()（面板激活 scope）解析，与 save 落盘基准一致
  - 依赖图「只读」不变量改述：scan 只读（图从源码推导）+ DOT 文本导出导入，无 CRUD
- 测试 128 项全绿（deps 15 项：scan 准确性 10 + saveDot/loadDot 5）

## 0.7.5 / 2026-09-24

- workflow 模块重构为 deps 依赖图模块（**删编辑，保渲染，提升准确性**）：
  - 删除 DOT 编辑器 / workflow CRUD（list/get/save/remove/validate/import 六 action
    + 画布手势）——图是「从源码推导的只读视图」，编辑无意义（改图 = 改代码）
  - 唯一 action `deps.scan`（cli `nx-rp deps` / GET /api/deps）；面板为全宽只读画布
  - 扫描准确性三修复：
    - **词法清洗后匹配**：剥注释与「非 import 说明符」的字符串再匹配——
      注释/字符串/模板串里的 import 文本不再造成假边（清洗器按说明符位置
      保留真 import：前文匹配 `import…from` / `export…from` / `import(` / `require(`）
    - **JS 家族全覆盖**：.jsx/.mjs/.cjs 与 .js 同等参与——旧扫描只认 .js，
      web 层（App.jsx + 7 个 view.jsx）整个不可见，serve→web 依赖链断裂
      （41 文件/54 边 → 43 文件/102 边）
    - **动态 import() 识别**：`await import('./x.js')` 表达式任意位置可识别；
      边全局去重；node_modules/dist/public 构建产物目录跳过
  - 面板渲染三修复（此前「看不到线条」的根因）：
    - ReactFlow 直接父级必须有确定高度（absolute+100% 塌不进 minHeight 父容器）
    - 自定义节点必须渲染 `<Handle>`——无锚点 ReactFlow **静默丢弃全部边**
    - fitView 在布局落位后重算（挂载时算出 scale(2) 越放越大）
  - 依赖图 DOT 节点 id 允许引号包裹（"core.store"），解析器与序列化器对称支持；
    解析报错自带修法提示（链式边/引号 id/缺包裹各有解释）
  - 删除已无人引用的 src/dispatcher.js（旧 workflow ctx.nx 的遗产）
- 测试：deps 准确性 10 项（词法清洗/正则字面量/JS 家族/解析顺序/动态 import/去重）

## 0.7.4 / 2026-09-23

- 修 vite 外部化报错（浏览器端 `Cannot access node:* in client code`）：
  - 根因是 view.jsx 从 service.js import 纯函数（parseDot），把 service 的
    node:fs / node:path / core/paths 整条服务端依赖链拖进前端 bundle
  - 拆出 `src/modules/workflow/dot.js`：DOT 解析/序列化/校验的**唯一实现**，
    零 node 依赖，面板与服务端共享同一份（语义不会分叉）
  - core/paths.js 全部 node 内置模块改 `createRequire` 懒加载；
    `core/als.js` 隔离 AsyncLocalStorage
  - 验证：构建产物零 `node:` 模块引用、零 createRequire/homedir
- 修依赖图 `edges: 0`：路径解析漏判「import 已带 .js 扩展名」的情况
  （`./paths.js` 被拼成 `paths.js.js` 而永远 miss）——41 文件现在正确解析出
  54 条边、36 条跨层边
- `.gitignore` 加 `.playwright-mcp/`（浏览器自动化调试产物）

## 0.7.3 / 2026-09-23

- workflow + 依赖图合并：DOT 文本是两者共同事实源
  - 删除独立 graph 模块；dependency 扫描作为 `service.depsToDot(root)` 并入 workflow
  - 新增 `workflow deps [--root] [--json]`：扫描 src/ 的 import 关系输出 digraph
  - 面板「工作流」tab 新增「生成依赖分析」按钮，点击注入扫描结果到 DOT 编辑器
- core/paths.js vite 兼容性修复：避免 `node:os.homedir` / `node:path` 顶层求值
  导致前端 bundle 触达 `Cannot access homedir` / `Cannot access join` 错误
  - 全部 node 内置模块走 `createRequire(import.meta.url)` 懒加载
  - `core/als.js` 隔离 AsyncLocalStorage，前端 bundle 不再被静态图拖入
  - docsFile / skillsFile / storePathFromEnv 等保持服务端的 `let + setHookPaths` 行为

## 0.7.2 / 2026-09-23

- annotations 面板重构成 IDE 三栏（左工作树 / 中预览 / 右批注）：
  - 左栏 cwd 目录树可展开/折叠（`▸`/`▾`），每个节点 lazy-load 子项；
    hover 节点露「+批注」按钮，**目录也可挂批注**
  - 中栏：文件预览（保留窗口切片续传）或目录概览（子目录/文件列表，
    点选下钻），顶部面包屑可点回退
  - 右栏：当前路径的批注 + 新增表单；底部折叠区显示跨文件待办，
    点条目跳回文件
- annotations 数据模型扩展：
  - `addAnnotation` / `listAnnotations` 等 CRUD 接受目录路径（按绝对路径
    分桶，不再校验必须是文件）；目录 todo 出现在跨文件待办
  - `loadFile` 对目录返回 `{ isDirectory: true, dirs, files, totalDirs,
    totalFiles }`，不读 body、不走预览铁律
  - 新增 4 项单测（目录分桶、目录概览、隐藏项、跨文件 todo 聚合）

- workflow 模块精简：DOT 文本格式（Graphviz/DOT）作为唯一事实源
  - 删除 JS 执行引擎（ctx.step/parallel/agent-call/http/raw 五节点类型 + SSE）——约 700 行
    删除的复杂度，回归有向依赖图的本质：节点是状态、边是顺序、DOT 一行写完
  - 新增「DOT 编辑器 + 画布」面板：左 textarea 单色专注文本，右 React Flow 实时预览
  - **单向数据流**：DOT 文本是唯一状态，画布是它的派生渲染（每次从 parse 结果重算布局）。
    画布手势不维护自己的图模型，而是**直接改写 DOT 文本**——
    双击空白创建节点 / 右键拖拽从 A 到 B 建边 / 双击节点删除（连边同步移除），
    三者都走 `setDot()` 改文本 → 重新 parse → 重渲染。不存在"两份状态互相同步"
  - 自定义 DOT 子集解析器（digraph + [..] 属性 + 节点行 + 边行 + 分号/换行两种分隔符）
  - 静态校验：自环 / 重复边 / 悬挂边 / 空图 / 语法错
  - 存储路径改 `cwd/.nx-rp-workflows/<name>.dot`（可见、与 store.json 解耦）
  - actions 改为 6 条：list / get / save / remove / validate / import
- workflow 测试 9 项全过（DOT 解析往返、中文/转义、自环/重复边、CRUD、非法名字拒绝）

## 0.7.1 / 2026-09-23

- 新增 `nx-rp skill get [name] [ref]`：
  - 把内置 skill 的 SKILL.md（默认）/ `references/<ref>` 输出到 stdout，
    **prefix → 文档 → install 状态**三段拼接，prefix 固定最前
    （部分 agent 输出过长会截断，prefix 必须最先告诉 agent 文件位置与复制建议）
  - 默认 name = `nx-rp`；ref 接受 `references/foo.md` / 裸名 `foo`（自动查 `references/foo.md`）/
    `./foo.md`，路径穿越（`..`）与绝对路径（ref 越界）拒绝
  - 同时按 install 既有逻辑装到 `~/.claude/skills/<name>`（接受 `--to`，`--force` 静默忽略）；
    conflict 状态正常返回，**不影响文档输出**（get 永远给文档）
  - `--json` 输出 `{skillName, ref, content, contentBytes, install}` 四元，不含 prefix
    （prefix 是给人类的引导语，`--json` 是机器协议）
- skill 子命令用法错误信息补充 get 子命令提示

## 0.7.0 / 2026-09-23

- annotations 文件预览增强（性能优先）：
  - loadFile 支持 offset/limit 窗口切片：服务端整读但只传窗口，
    返回 hasMore/nextOffset 供续传；CLI 不带 limit 时仍按上限铁律拒绝渲染
  - web「文件批注」面板渐进加载：首屏 1000 字符，「加载更多」每次 +3000
    追加渲染（已渲染部分不重排）；超限拒绝仅在 CLI 上限模式生效
  - 新增目录浏览 `ann browse [dir]`：列出直接子项（不递归、隐藏项跳过）；
    web 面板「浏览…」按钮逐级点选进入，性能零损耗（每步一次 readdir）
- share 共享知识库：<docRoot>/shared/ 跨项目共用——放基本信息防丢失
  - `doc add --shared`：标记为共享，export 镜像到 shared 桶不进项目桶
  - `doc export`：项目桶 + shared 桶同时同步；返回 { shared: {...} } 字段
  - `zg query` 自动并查 shared 库（默认开启，`--noShared` 关闭）；
    共享命中以 [shared 共享知识库命中] 标注

## 0.6.0 / 2026-09-23

- 新增 annotations 模块（文件批注，独立 tab「文件批注」）：
  - 三类批注：review（评价）/ todo（待办，带 done 勾选）/ note（思考），
    支持 `--line` 行号锚点（评论链接到文件具体位置）
  - 文件加载器 `ann load`：默认 1000 字符预览，**超限拒绝渲染**（truncated +
    body null，绝不截半截内容）；二进制（NUL 探测）拒绝；`--full` 显式全量
    受 200K 硬上限
  - `ann todos` 跨文件聚合全部未完成待办（待办操作主入口）
  - 存储按目标文件分桶：~/.nx-rp/annotations/<serializePath(file)>.json
    （与 KB 同一序列化规则，全 ASCII；原子写）
  - 声明为 resource（annotation），CRUD 五操作由 registry 完备性测试钉住双端可达
- 测试 81 项全绿

## 0.5.1 / 2026-09-23

- zg-boot 模块并入 doc 域，面板合并为「文档与召回」一个 tab：
  - 完整数据流一处管理：登记 → doc export（实例文件化）→ zg index → zg query
  - 业务迁至 src/modules/doc/zg.js；CLI 命令保持 zg 前缀不变（zg onboard/auth/
    index/query/status/migrate），action id 统一 doc.zg.*（HTTP 路由不变）
  - doc 面板新增「知识库与召回」卡片（引擎状态/导出/索引按钮）与「召回试查」卡片
- 召回结果增强：输出头部注入来源上下文块（知识库根/KB 子目录/来源工作目录/
  相对路径拼接公式）——AI 命中后可判断知识归属、按行号回源读全文
- 真机端到端验证：远程索引（qwen/qwen3.7-text-embedding）+ 中文语义召回 + 增量索引

## 0.5.0 / 2026-09-22

- 新增 zg-boot 模块（召回引擎引导，zvec-grep 集成）：
  - `zg onboard` 新用户一条命令引导：装 zg → 引导页（platform.qianwenai.com）拿 key
    → 配置固定远程模型 → doc export → index → query，按步提示缺啥补啥
  - `zg auth --key <key>`：key 只经 CLI 参数写入 zg 全局配置（~/.zvec-grep/config.json），
    nx-rp 的 store/日志/返回值全程不存储、不回显、不入库
  - embedding 固定为 qwen/qwen3.7-text-embedding（远程 128K 输入，免费额度；常量不开放配置，
    换模型必须 --rebuild 由 zg manifest 保证一致性）
  - `zg index` / `zg query`：全部 --mode direct 一次性子进程（零常驻零端口）；
    query 显式 --refresh wait（新鲜度）+ --compact + --preview short（上下文预算）
  - **不装 MCP**：刻意不跑 `zg install`，zg 只做召回引擎；已有装机的卸载提示内置
  - `zg migrate --new-root`：docRoot 变更全量复制迁移 + 清旧痕迹
- 路径序列化与知识库定位（core/paths.js）：
  - serializePath：与 Claude Code 项目目录同规则（非 [A-Za-z0-9_-] 逐字符→-，
    D:\a_js\js_proj\nx-rp → d--a_js-js_proj-nx-rp），全 ASCII 跨平台安全
  - workspaceKbFor(cwd) = <docRoot>/<序列化名>/——一个工作目录一个知识库
- doc 模块知识实例文件化：
  - `doc export`：store 里的 doc 全量镜像为 KB 目录 md 文件（frontmatter 携带
    title/tags/source；exportedAt 用内容派生值保证镜像幂等；删除条目同步删文件）
  - `doc root` / `doc root --set`：全局 docRoot 查看/变更（默认 ~/.nx-rp/doc）
- 测试 73 项全绿；测试自身的 KB 落盘严格隔离在临时目录（store 缓存跨测试泄漏
  导致污染真实 ~/.nx-rp/doc 的问题已修复并有 forgetStore 纪律）

## 0.4.1 / 2026-09-22

- 包名迁移为 @flowot6/nx-rp（npm 主账号 flowot 被封，改用小号 flowot6 的
  scope 命名发布；scoped 包补 publishConfig.access=public）
- bin 名不变仍是 nx-rp：`npx @flowot6/nx-rp serve` 用法照旧

## 0.4.0 / 2026-09-22

- 最近目录（recents）+ 面板 scope 快速切换——一个面板管所有项目：
  - serve 启动自动登记当前目录；默认端口上已有 nx-rp 面板时不再起第二进程，
    登记 + 打开已有面板即返回（用 /api/health 的 cwdScope 字段做进程签名嗅探）
  - 新命令 `nx-rp recents`（GET /api/recents）；登记入口 `POST /api/recents`
    为面板/serve 专用（纯 HTTP，与 hook capture 相反的方向）；store.json 新增
    全局 `recents` 列表（上限 20 条，老数据自动补字段零迁移）
  - 面板右上角「最近目录」下拉：点击切换激活 scope，之后的查看/新增/编辑都落到
    那个目录（前端所有请求带 x-nx-rp-scope 头，api.js 用 AsyncLocalStorage 在
    paths.js 的 cwdScope() 单点穿透，业务代码零改动）；窗口聚焦自动刷新列表；
    切换状态持久化到 localStorage
  - workflow 相对路径/镜像目录改走 cwdDir()（激活目录原始大小写路径），
    面板切 scope 后保存的工作流落到激活项目；agent spawn 的执行 cwd 仍跟随
    serve 进程（作者可显式传 cwd），注释说明该边界
- serve 参数解析抽为 parseServeArgs 纯函数：顺带修复 `--port N`（空格形式）
  实际无效的 bug（此前只有 `--port=N` 生效）；显式跳过 cli.js 追加的 `--store` 值对，
  避免被误当位置端口

## 0.3.1 / 2026-09-22

- hook 域拆分为两个平级模块（各自独立 tab 与开关，与 link/doc/workflow 平级）：
  - `hook-prompt` 提示词日志（UserPromptSubmit）：`hook on/off/status/log`
  - `hook-skill` Skill 追踪（PostToolUse·Skill）：`hook skill-on/skill-off/skill-status/skills`
  - 开关互不影响：各自只动自己 marker 指纹的 settings entry（单测锁死互不误伤）
  - 共享逻辑下沉 core/：`claude-settings`（外科手术读写 + 快照轮转）、
    `hook-io`（stdin EOF 竞速 1s、半截 JSON 字段抢救 session_id/cwd、
    deriveSessionId 统一派生——借鉴 teamai-cli 的 A 级容错技巧）
  - 「手动添加」卡片抽为共享组件 ManualAddCard
- hook 落点命令 `hook capture` / `hook skill-track` 与 entry 格式不变，
  旧用户的 settings.json 与日志文件零迁移

## 0.3.0 / 2026-09-22

- hook 模块新增 Skill 追踪与健康分（借鉴 Tencent/teamai-cli 的 skill-health 设计）：
  - 第二条 hook：PostToolUse（matcher Skill）→ `nx-rp hook skill-track`，skill 调用
    按 cwd 记进 `~/.nx-rp/skills/<cwd哈希>.jsonl`（与提示词日志同一套铁律：
    async 后台跑、永不报错、退出码恒 0）
  - `nx-rp hook on`/`off` 同时管两条 entry（各自带 marker 指纹，分别幂等；
    旧安装只装了提示词日志时，`on` 只补 Skill 条目）；status 分列报告
  - 新命令 `nx-rp hook skills`（GET /api/hook/skills）：按 skill 聚合使用次数，
    健康分 = 使用分 0-60（相对最高频归一）+ 新鲜度 0-40（30 天线性衰减），五星显示
  - 面板「Skill 使用统计」卡片：星级 + 分数 + 次数 + 最近使用；Hook 状态卡片
    分列两条 hook；手动添加片段含 PostToolUse 组
- eslint 忽略 `.claude/**`（嵌套克隆仓库的配置文件不参与主仓库 lint）

## 0.2.3 / 2026-09-21

- hook 面板卡片重排：提示词记录提到最上（主要使用场景），Hook 状态与手动添加
  （配置相关）移到下方

## 0.2.2 / 2026-09-21

- hook 面板新增「手动添加」卡片：
  - 可一键复制的 hook JSON 片段（点代码块或按钮均可复制）——片段由 service 的
    manualSnippet() 生成，与 hook on 实际写入的 entry 同源，并有单测断言防两处漂移
    （片段不含内部 marker 指纹，手写场景不需要）
  - 配置层级说明表：用户级 ~/.claude/settings.json / 项目级 .claude/settings.json /
    本地级 .claude/settings.local.json，各自影响范围与「合并而非覆盖」规则，
    附 /hooks 排查提示
- hook.status 返回值带 snippet 字段（GET /api/hook/status，面板数据源）

## 0.2.1 / 2026-09-21

- hook 模块补 Web 面板（此前 view: null + 全 http: null，面板里看不到）：
  - 新增 `view.jsx`「提示词日志」页：开关状态卡片（含 disableAllHooks 警告）、
    记录表格（跨目录勾选、查看原文弹窗）、启用 / 停用按钮（停用走确认弹窗）
  - `hook.on` / `hook.off` / `hook.status` / `hook.log` 补 HTTP 路由
    （POST /api/hook/{on,off}、GET /api/hook/{status,log}），面板与 CLI 走同一份逻辑
  - `hook.capture` 保持 cli-only：它的入参是 hook 协议的 stdin 事件 JSON，面板无对应交互
  - 前端 registry 登记 hook 视图
- style.css 补通用类：.toolbar / .tag（状态标签）/ .kv（键值表）/ .cli-hint（CLI 等价提示）
  / .card + .card 分隔
- smoke 补断言：面板操作必须 http 可达、capture 必须保持 cli-only
- 开发体验：
  - `pnpm dev` 改为 `scripts/dev.mjs` 启动器——一条命令起 vite(5180) + 后端(7820)，
    任意一个挂掉一并收尾，一个 ctrl-c 一起退；vite 显式 `--host 127.0.0.1`
    （Node 18+ 默认监听 [::1]，否则 curl 127.0.0.1 会 ECONNREFUSED）
  - 新增 `pnpm run link:local`：把全局 nx-rp 指向本仓库的 dev shim。
    两种模式——`--mode=volta`（pack + volta install tarball，零 PATH 改动）
    / `--mode=shim`（写转发脚本，改代码即时生效）。默认 dry-run，`--unlink` 还原。
    改 PATH 前先做防御性校验（%VAR% 展开风险 / setx 1024 字符截断），
    不满足则中止并提示手动操作

## 0.2.0 / 2026-09-21

- 新增 hook 模块（纯 CLI，http: null）：
  - `nx-rp hook on` — 往 ~/.claude/settings.json 写 UserPromptSubmit hook（async + timeout 10s，
    marker 指纹识别自己的 entry；幂等；他人 hooks 原样保留；settings 其余键不动；
    写前自动留 .nx-rp-bak-<时间戳> 快照；--dry-run 只预览）
  - `nx-rp hook off` — 只摘自己的组；hooks 空了连字段一起摘；幂等；同样有快照 + --dry-run
  - `nx-rp hook status` / `nx-rp hook log`（--all / --limit）
  - `nx-rp hook capture` — UserPromptSubmit 落点：stdin 事件 JSON → ~/.nx-rp/prompts/<cwd哈希>.jsonl
    追加一行；任何异常静默吞掉，退出码恒 0（日志 hook 零存在感）
- paths.js：新增 CLAUDE_SETTINGS_PATH / PROMPTS_DIR / promptsFileFor；
  normalizeScope 从 cwdScope 拆出可复用；hook 路径用 let + setHookPaths 供测试重定向
- 按 server-cli-web 闭环表补齐：src/index.js 导出全部 service（含 link/doc/workflow 积欠）、
  eslint 互依禁列补 ../hook/*（反向测试验证规则真的会红）、
  smoke 从占位改为真实只读断言、assets/nx-rp/references/prompt-log.md 场景文档

## 0.1.9 / 2026-09-20

- 修「列表混乱」：.row 补 flex 布局（display: flex / .name / .desc / .acts 子类），
  三个视图（link / doc / workflow）的列表行恢复正常三段式
- 修画布节点翻倍：ctx.nx / ctx.http / ctx.agent 在 step/parallel 的 fn 里调用时
  不再自己声明节点，只把外层节点 type 修正为具体动作类型（nxAction / http / agent-call），
  并重发 graph 事件让前端更新节点 label
- dagre 布局只用 seq 边定层级（parallel / conditional 边不参与），
  并发组节点不再被拉成一条竖线
- parallel 边前端渲染去重（service 侧保留全量，画布一条虚线足够）

## 0.1.8 / 2026-09-20

- 修「画布看不到图」：ReactFlow 容器从 minHeight: 460 改为 height: 480 + position: relative
  （React Flow 内部 height:100%，父级只有 minHeight 时高度解析为 0，画布整体塌缩不可见）

## 0.1.7 / 2026-09-20

- 修 t.mkdir is not a function：浏览器侧 view.jsx 不再 import('node:fs/promises')
- 新增后端 action `workflow.write`（POST /api/workflows/write，body={name, body}）
- 新增后端 action `workflow.source`（GET /api/workflows/:name/source）
- view 的 save/run 改为调这两个 HTTP 端；run 不需要 file 参数——后端从 store 读 sourceFile 兜底
- 允许 action cli: null（纯 HTTP 专用 action）；registry 装载期不再强求 cli
- cli: null 时 cliPathsOf 返回 []，保留原有的「http 必有 cli」对 http-only 之外的断言

## 0.1.6 / 2026-09-20

- workflow 改成 JS 一等格式（agent 写 JS 远好过写 JSON）：
  - service：JS 执行引擎，ctx.step / ctx.parallel 自动建图 + emit SSE
  - 5 种 Node type：nxAction / agent-call / http / raw
  - 5 种 Node status：idle / running / success / error / skipped
  - 3 种 Edge type：seq（实线强依赖）/ parallel（虚线并发组）/ conditional（虚线条件）
  - 6 类 SSE 帧：graph / nodeStart / nodeDone / nodeLog / done / error
  - 新增 @dagrejs/dagre 自动布局
- 完整原语定义写在 assets/nx-rp/references/workflow-author.md
- 校验必须 export default（拒绝 export const run 旧约定）
- saveWorkflow 支持绝对路径与 cwd 相对路径
- workflow view：三栏（已保存 / JS 编辑器 / 自动布局画布），5 色 status + 3 形边类型
- nx-rp workflow run HTTP 端 SSE 流式输出 nodeStart/nodeDone/done

## 0.1.5 / 2026-09-20

- 修画布拖动节点闪烁：nodes/edges 改用本地 state（useNodesState/useEdgesState），
  body 不再作为 derived source；外部变更（load / reset / apply）才同步进画布。
- 修右栏 UI 一致性：「已保存」列表始终显示；选中节点时在列表下方追加 Inspector，
  而不是互斥切换。两条信息不再互不可见。
- 清理掉几条无意义的 eslint-disable 注释（项目没装 react-hooks plugin）。

## 0.1.4 / 2026-09-20

- 补 `nx-rp skill install` 命令（之前漏注册）
  - 默认装到 ~/.claude/skills/<name>
  - `--to <dir>` 改目标；`--force` 覆盖冲突
  - 三态返回：未存→安装；一致→跳过；冲突→业务结果（exit 0）
- 修 `nx-rp --help` / `-h` 兼容（之前报「未知命令: --help」）

## 0.1.3 / 2026-09-20

- 修画布不渲染：reactflow 11.11.4 在 React 19 下不兼容
- 换成 @xyflow/react@12.11.6（v12 是为 React 19 设计的；API 与 v11 几乎一致）
- workflow 面板样式补齐（之前 css append 失败，wf-* 规则全缺失）

## 0.1.2 / 2026-09-20

- workflow 面板加 React Flow 可视化画布
  - 左 palette（4 种节点模板：nxAction / agent-call / http）拖拽入画布
  - 中 ReactFlow 画布（自定义节点显示 kind + 关键参数）
  - 右 选中节点的属性表单（按 kind 推导字段）
  - 底 JSON 折叠预览（手敲 JSON 也会反映到画布）
- 画布与 JSON 双向同步：拖拽 / 移动 / 连线 / 改属性 → 写回 body 字符串

## 0.1.1 / 2026-09-20

- 定位明确为 npx-repo（外部信息以链接方式管理）
- README / package.json description / SKILL.md frontmatter 同步更新
- 废弃 ZHLX2005/nx-ak；项目已迁移到 On-DevPlan/nx-rp

## 0.1.0 / 2026-09-20

- 首个版本：CLI + Web 面板骨架
- 单一全局存储 `~/.nx-rp/store.json`，按 cwd 自动隔离 scope
- 内置命令：serve / help / version / bootstrap / health / routes
- 三个功能域：link / doc / workflow
- workflow 暴露 validate / format / apply 三条 agent 编辑命令
- 32 个单测 + 1 个 smoke，全绿
# ralph-philosophy — 原理与哲学

## 一、Ralph 是什么

Geoffrey Huntley 的原始描述只有一句：**"Ralph is a Bash loop"**。

```bash
while :; do
  cat PROMPT.md | claude-code --continue
done
```

同一条 prompt 反复喂给 agent。**"自引用"不是把输出当输入**——
而是 agent 每轮从**文件系统与 git 历史**里看到自己上一轮的成果，
在既有的产物上继续改进。跨轮的上下文载体是磁盘，不是对话。

每一轮的循环：

1. agent 收到**同一条** prompt
2. 干活、改文件
3. 尝试结束回合
4. Stop hook 拦住，把同一条 prompt 灌回
5. agent 从文件里看到自己上一轮的成果
6. 迭代改进，直到完成

## 二、四条原则

### 1. 迭代优于完美

不要指望一次做对。让循环去精炼——第一轮的产物是素材，不是成品。

### 2. 失败是数据

Geoffrey 的说法是 *"deterministically bad in an undeterministic world"*：
失败是可预测、可复现的，因此可以用它来**调 prompt**。
模型是随机的，但"这个 prompt 会稳定地漏掉某件事"是可观察的规律。

### 3. 操作者技巧决定成败

成败取决于**写 prompt 的能力**，不只取决于模型强弱。
一个好的 loop prompt 有明确判据、分阶段目标、自纠错环与逃逸舱（见 [[loop-prompt-craft]]）。

### 4. 坚持到底

这个技术的精神内核来自《辛普森一家》的 Ralph Wiggum——
明知会失败还一直试。听起来像玩笑，实际是工程判断：
**当验证是自动的，重试的边际成本极低，而收敛是概率性的。**

## 三、什么时候**不**该用

- 需要人拍板的设计决策（循环里没人可问）
- 一次性操作
- 成功判据说不清的任务
- 生产环境排障（用定向调试，不是暴力重试）
- 含不可逆操作（删除、发布、付费）

## 四、nx-rp 的实现与改造

nx-rp 的 `loop` 是同源机制的 Node 重写，做了五处刻意改造：

| # | 官方 ralph-loop 插件 | nx-rp loop | 为什么 |
| --- | --- | --- | --- |
| 1 | bash + `jq`/`perl`/`awk`/`sed` | 纯 Node | 跨平台；官方插件在 Windows 上要教用户绕开 WSL bash |
| 2 | 项目内单文件，单实例 | 按 cwd 分文件 + **数组** | 同一项目多会话并行循环互不干扰 |
| 3 | 装插件即全局生效 | `loop on` **按项目**写配置 | 只有配了 hook 的项目才被拦退出，不打扰无关项目 |
| 4 | 异常时删状态文件 | 异常**保持 active** 降级放行 | 一次瞬时 IO 抖动不该永久杀掉循环 |
| 5 | 只能读状态文件观测 | 每轮审计日志 + Web 面板 | 出问题时有据可查 |

另有两处细节差异：

- **承诺提取**：官方插件的 `perl` 在不匹配时会返回**全文**，理论上可能误判完成；
  nx-rp 无标签时返回"无承诺"，方向安全
- **子 agent 排除**：`isSidechain` 的助手文本不算完成信号（主 agent 的最后一句话才算）

## 五、更深一层：为什么放在 nx-rp 里

nx-rp 已有 **`hook-prompt`（提示词日志）** 与 **`hook-skill`（Skill 追踪）** 两个 hook 模块，
它们与 `loop` 共用同一套底层机制：

- **settings.json 外科手术**：按 marker 指纹认亲，只增删自己的 entry，
  写前自动留快照（`~/.nx-rp/snapshots/`），其余 hooks 与配置键一律不动
- **永不打扰会话**：hook 落点任何异常都吞掉、退出码恒 0
- **CLI 与 Web 同源**：同一份 action 声明派生 CLI 命令与 HTTP 路由，
  装载期自检防止两端分叉

所以 `loop` 不是外挂进来的一个脚本，而是这个体系里的第三个 hook 模块——
有面板、有审计、有快照、与另两个模块互不误伤（各有单测锁死）。

## 六、延伸阅读

- 原技术：[ghuntley.com/ralph](https://ghuntley.com/ralph/)
- Ralph Orchestrator：<https://github.com/mikeyobrien/ralph-orchestrator>
- nx-rp 的命令与状态机：[[loop-commands]]
- prompt 写法：[[loop-prompt-craft]]
- 排障：[[loop-troubleshooting]]

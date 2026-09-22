# hook-per-tab 拆分设计（2026-09-22 v1）

> **Date:** 2026-09-22
> **Topic:** hook-enhance
> **类型:** intent doc (预测设计)
> **版本:** v1（首版）
> **状态:** 已采纳（方案 A 变体：拆双模块；用户拍板记录见 v2）
> **核心问题:** registry 的 tab 粒度 = 模块粒度（VIEWS 一行 = `modules/{id}/view.jsx`），
> 在这个约束下如何让「每个 hook 一个独立 tab、开关对应各自功能」

## 原始请求（用户原话）

> 一个hook就单独作为一个tab 然后hook开关对应该功能 team-cli还有没有其他可以参考的hook技巧 先实现claude的即可, 增强我的nx-rp /intent-capture-discuss 对比hook的实现程度

## 轻微重写版（仅修错别字与口癖）

> 一个 hook 就单独作为一个 tab，然后 hook 开关对应该功能。teamai-cli 还有没有其他可以参考的 hook 技巧？先实现 Claude 的即可，增强我的 nx-rp。对比 hook 的实现程度。

## 本版要验证的假设

三方案中存在一个「不破坏 registry 结构保证（CLI/Web 同源断言、CRUD 完备性测试）且改动量最小」的拆 tab 路径。

## 一、约束事实（决定方案空间）

1. `src/web/frontend/registry.js` 的 `VIEWS` 数组驱动 tab 导航/hash 路由/懒加载，一行一 tab
2. `tests/unit/registry.test.mjs:64` 断言「带 view 的模块都在前端注册表登记」且文件为 `src/modules/{id}/view.jsx`——**view 挂在模块上，一个模块一个 view 文件**
3. `src/runtime/registry.js` 装载期自检：action 的 CLI/HTTP 声明双端同源
4. hook 模块现有 7 个 action：capture / skill-track（cli-only）+ on / off / status / log / skills（双端）
5. settings.json 层面两条 hook entry 天然独立（各自 marker），开关拆分在 service 层无障碍

## 二、三个候选方案

### 方案 A：拆双模块 `hook-prompt` + `hook-skill`（模块即 tab）

```
src/modules/
├── hook-prompt/    # 提示词日志：capture / on / off / status / log + view.jsx
└── hook-skill/     # Skill 追踪：skill-track / on / off / status / skills + view.jsx
```

- 改动：模块目录一分为二；VIEWS 登记两行；eslint SIBLINGS 加两项
- 开关天然对应：每个模块自己的 `on/off` 只写/摘自己的 marker 组（service 层现成逻辑按 marker 过滤，拆开即用）
- 代价：`shared` 代码（readSettings/writeSettings/快照/stdin 读取）必须下沉 `core/`（eslint 禁止模块互依）；CLI 命令空间从 `hook *` 变为两组；**旧用户的已启用 hook 由两个模块共同认领各自的 marker，无迁移问题**
- 结构影响：把「hook 域」从 1 模块变 2 模块，未来加第三条 hook（如 Stop 结算）= 再加一个模块，模块数线性膨胀

### 方案 B：单模块 + VIEWS 子视图注册（tab 粒度下沉到视图层）

```
VIEWS = [
  { id: 'hook-prompt', title: '提示词日志', component: lazy(...) },
  { id: 'hook-skill',  title: 'Skill 追踪',  component: lazy(...) },
]
// 两个 view.jsx 文件都在 src/modules/hook/ 下：
src/modules/hook/view-prompt.jsx
src/modules/hook/view-skill.jsx
```

- registry 测试断言「前端注册表里的视图文件真实存在」走 `modules/{id}/view.jsx` 路径拼接——id `hook-prompt` 会映射到不存在的 `modules/hook-prompt/view.jsx`，**该测试需改为从注册表条目读显式路径字段**（registry.js 的 VIEWS 条目加 `file` 字段，测试读 `file` 不再拼 id）
- 开关：hook 模块的 action 加作用域 flag（`hook on --feature skill`），或拆成 `hook.on.prompt` / `hook.on.skill` 两条 action
- 代价：动测试 + VIEWS 结构（一处契约变更）；CLI 命令也要拆双 action，registry 自检里 `hook.on` 类命令数翻倍
- 收益：模块数不变，未来第三条 hook 只加 view + action，不加模块

### 方案 C：保持单 tab，tab 内二级页签（不改 tab 结构）

- 「提示词日志」页内部加子页签切换两个 hook 的数据与开关
- 代价最小但**不满足用户诉求**（明确要「单独作为一个 tab」）——仅作对照记录，不推荐

## 三、推荐与理由

**推荐方案 B**，理由：

1. 「hook」是 nx-rp 的一个**功能域**（共享 settings 写入、快照、安全铁律、stdout 协议），拆成两个模块会把域知识撕开、强迫共享逻辑下沉 core——core 现在是纯基础设施层（paths/errors/store），塞入 hook 域逻辑破分层语义
2. 方案 B 的代价集中在「VIEWS 条目加 file 字段 + 测试读显式路径」，是一次性契约变更，换来未来每条新 hook 零模块成本
3. 开关粒度：action 拆成 `hook.on.prompt` / `hook.on.skill`（各自 http 路由 `/api/hook/on/prompt` 等），比 flag 更符合 registry「一 action 一语义」风格；保留无参 `hook on` = 全开（向后兼容旧用户习惯）

方案 A 的适用条件：若未来 hook 数量预期 ≤3 且各 hook 语义差异极大（不只是记录型），拆模块反而清晰。

## 四、开关矩阵（方案 B 落地后的行为）

| 命令/操作 | 作用 |
| --- | --- |
| `hook on` | 两条全开（幂等） |
| `hook on prompt` / `hook on skill` | 只开对应条 |
| `hook off [prompt\|skill]` | 无参=全关；带参=只关对应条 |
| `hook status` | 分列两条状态（现状已支持） |
| 面板「提示词日志」tab | 启用/停用按钮只动 prompt 条 |
| 面板「Skill 追踪」tab | 启用/停用按钮只动 skill 条 |

## 五、A 级技巧落地清单（与拆 tab 并行的小改动）

| # | 技巧 | 来源 | 落点 |
| --- | --- | --- | --- |
| 1 | STDIN EOF 竞速（1s deadline 内用已收内容） | teamai-cli hook-dispatch-cli.ts | service.js `readStdin`（现 3s 纯超时） |
| 2 | 半截 JSON 字段抢救 session_id/cwd | parseStdin salvage | `captureRaw` / `skillTrackRaw` 的 catch 分支 |
| 3 | deriveSessionId 统一（payload→env→pid+cwd） | utils/session-id.ts | 两条 capture 共用的小工具函数 |
| 4 | 会话 dedup 缓存文件 + TTL | todowrite-hint.ts | 暂不实现，留模式备注（无提示类 hook） |

## 六、验收标准（方案 B 拍板后）

| # | 验证项 | 方法 |
| --- | --- | --- |
| 1 | 两个 tab 各自渲染，数据隔离 | `pnpm dev` 目测 + smoke 断言 VIEWS 含 hook-prompt/hook-skill 两个 id |
| 2 | 各 tab 开关只动自己的 entry | 单测：`hook.on.skill` 写盘后 UserPromptSubmit 组不变，反之亦然 |
| 3 | 无参 `hook on` 行为不变（全开） | 既有幂等测试全绿 |
| 4 | CLI/Web 同源保持 | registry 自检 + 「HTTP 必有 CLI」断言通过 |
| 5 | A 级 1-3 项容错 | 新单测：半截 JSON 救回 session_id；stdin 竞速不挂 |

## 七、待用户拍板的决策

| # | 决策 | 推荐 |
| --- | --- | --- |
| 1 | 拆 tab 方案 A / B / C | B（单模块双视图 + action 拆分） |
| 2 | 无参 `hook on` 语义 | 全开（向后兼容） |
| 3 | A 级技巧是否随本次一起落 | 1-3 随本次；4 留模式备注 |

## 八、参考

- compare 文档：`project/compare_hook-implementation-2026-09-22-v1-status.md`
- registry 测试约束：`tests/unit/registry.test.mjs:64-78`
- VIEWS 结构：`src/web/frontend/registry.js`
- teamai-cli 源码行号：STDIN 竞速 `hook-dispatch-cli.ts:44`；deriveSessionId `utils/session-id.ts:31`；dedup 缓存 `todowrite-hint.ts:27`

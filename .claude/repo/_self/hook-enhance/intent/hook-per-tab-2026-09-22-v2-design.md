# hook-per-tab 拆分设计（2026-09-22 v2）

> **Date:** 2026-09-22
> **Topic:** hook-enhance
> **类型:** intent doc (预测设计)
> **版本:** v2（相对 v1：推翻「推荐方案 B」——用户拍板选了方案 A 的完全体；
> 保留 v1 的约束分析与 A 级技巧清单，全部落地）
> **状态:** 已落地（0.3.1 实现完成）
> **核心问题:** 同 v1——「每个 hook 一个独立 tab、开关对应各自功能」

## 原始请求（用户原话）

> 一个hook就单独作为一个tab 然后hook开关对应该功能 team-cli还有没有其他可以参考的hook技巧 先实现claude的即可, 增强我的nx-rp /intent-capture-discuss 对比hook的实现程度

v1 落文档后的拍板回复：

> 把提示词记录和skill调用记录完全分为两个view,和链接文档工作流平级 修改代码

（中段版本号指示：）

> 0.3.1版本

## 轻微重写版（仅修错别字与口癖）

> 把提示词记录和 skill 调用记录完全分为两个 view，和链接、文档、工作流平级，修改代码。版本 0.3.1。

## 拍板结论（相对 v1 的变化）

| v1 推荐 | 用户拍板 | 结果 |
| --- | --- | --- |
| 方案 B（单模块双视图 + action 拆分） | **方案 A 的完全体**：拆双模块，且「和链接文档工作流平级」= 完全平级的独立模块，不是 hook 域内子功能 | `hook-prompt` + `hook-skill` 两个模块，各自 view.jsx / service.js / index.js |
| 无参 `hook on` = 全开 | 每模块自己的开关（`hook on` 只管提示词；`hook skill-on` 只管 Skill）——无「全开」语义 | 命令空间按模块分配 |
| A 级技巧 1-3 随本次落 | 未否决，全部落地 | stdin 竞速 / 字段抢救 / deriveSessionId 进入 `core/hook-io.js` |

v1 推荐方案 B 的理由（共享逻辑下沉 core 破分层语义）被用户选择推翻：
共享逻辑确实下沉了 core（`claude-settings.js` / `hook-io.js`），但落地证明
这两个文件是纯基础设施（settings 协议、stdin 协议），**没有**把 hook 域业务语义带进 core——
v1 对「破分层」的担忧过重。教训：约束分析时高估了耦合，实际拆分边界比预想干净。

## 最终结构（与 v1 方案 A 描述一致）

```
src/
├── core/
│   ├── claude-settings.js   # settings 外科手术（共享）：read/write/snapshot/findGroups/append/remove/toggle
│   └── hook-io.js           # stdin EOF 竞速(1s) + 半截 JSON 抢救 + deriveSessionId（共享）
├── modules/
│   ├── hook-prompt/         # 提示词日志：capture / on / off / status / log + view.jsx（order 50）
│   └── hook-skill/          # Skill 追踪：skill-track / skill-on / skill-off / skill-status / skills + view.jsx（order 51）
└── web/frontend/components/
    └── ManualAddCard.jsx    # 手动添加卡片（两模块共用，eventKey 参数化）
```

## 验收结果（对照 v1 验收标准）

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | 两个 tab 各自渲染，数据隔离 | ✅ VIEWS 登记 hook-prompt / hook-skill 两行；smoke 断言 action 清单 |
| 2 | 各 tab 开关只动自己的 entry | ✅ 单测互不误伤（prompt on 保留 skill 组、反之亦然）+ 真机 E2E 验证 |
| 3 | 兼容性 | ✅ `hook capture` / `hook skill-track` 命令与 entry 格式不变，旧 settings 零迁移 |
| 4 | CLI/Web 同源保持 | ✅ 61/61 测试全绿（registry 自检 + HTTP 必有 CLI 断言） |
| 5 | A 级 1-3 容错 | ✅ hook-core.test.mjs：salvage / parseHookEvent / deriveSessionId |

## 参考

- v1 设计（方案对比与 A 级技巧来源）：`hook-per-tab-2026-09-22-v1-design.md`
- compare 文档：`project/compare_hook-implementation-2026-09-22-v1-status.md`
- 实现落点：`src/core/claude-settings.js`、`src/core/hook-io.js`、`src/modules/hook-{prompt,skill}/`

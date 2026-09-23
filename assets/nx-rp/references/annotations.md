# annotations · 文件批注 / 评价 / 待办 / 思考

> 加载时机：用户要「给某个文件加批注 / 评价」「记个待办」「看一下文件的批注」，
> 或 agent 需要快速查看文件内容并挂评论时。
> 一句话：`nx-rp ann load --file <路径>` 加载预览（默认 1000 字符，超限拒绝渲染）→
> `ann add --kind review|todo|note` 挂批注（`--line` 行号锚点）→ `ann todos` 看跨文件待办。

---

## 一、它是什么

给**任意本机文件**挂批注的独立面板。三类批注：

| kind | 用途 | 交互 |
| --- | --- | --- |
| `review` | 评价（这段代码好/坏、设计对/错） | 纯文本 |
| `todo` | 待办操作 | 有 done 状态，可勾选完成 |
| `note` | 思考（随想、疑点、后续方向） | 纯文本 |

批注可带 `line` 行号锚点——评论链接到文件的具体位置。

**存储**：按目标文件分桶，`~/.nx-rp/annotations/<serializePath(file)>.json`。
序列化规则与知识库目录一致（`D:\a_js\js_proj\nx-rp` → `d--a_js-js_proj-nx-rp`），
全 ASCII 跨平台；一个文件一个桶，原子写（pid tmp + rename）。

## 二、文件加载器的渲染铁律

`ann load` 是查看目标文件的入口，三条硬规则：

1. **默认 1000 字符预览**。超过 → `truncated: true` + `body: null`——**拒绝渲染**，
   绝不截半截内容糊弄；如实报告总字符数与建议
2. **二进制拒绝**（前 8KB 含 NUL 即判二进制——二进制进对话是灾难）
3. `--full` 显式才给全文，仍受 **200K 硬上限**；超过连 --full 也不放行

## 三、命令

```
nx-rp ann load --file <路径> [--full]     # 加载文件（预览/拒绝渲染见上）
nx-rp ann add --file <路径> --body <内容> [--kind review|todo|note] [--line N]
nx-rp ann list --file <路径> [--kind ...] [--open]   # 该文件的批注（最新在前）
nx-rp ann get --file <路径> <id>          # 单条详情
nx-rp ann update --file <路径> <id> [--body/--line/--done]
nx-rp ann remove --file <路径> <id>
nx-rp ann todos                           # 跨文件的全部未完成 todo
```

**面板等价**：「文件批注」tab——顶部输入文件路径加载预览（超限时给「--full 查看」
按钮）、批注表（todo 带勾选框、review/note 带类型标签）、底部跨文件待办清单。
面板与 CLI 走同一 action。

## 四、agent 典型场景

- 「帮我看看这个文件，有问题记下来」→ `ann load --file <路径>` → `ann add --kind review --line N`
- 「这事记个待办」→ `ann add --file <路径> --kind todo --body "..."`（挂在相关文件上）
- 「我现在有哪些没做完的事」→ `ann todos`
- 「这个文件之前批注过什么」→ `ann list --file <路径>`

## 五、边界（不变量）

- 批注是**短评论**（≤4000 字符）——长文/成体系的知识请进 doc 域（文档与召回）
- 批注挂在**绝对路径**上；文件移动后批注不会自动跟随（重新 add 即可）
- `done` 只属于 todo；对 review/note 设 done 会被拒绝

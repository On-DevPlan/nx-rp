# zg-recall · 召回引擎（zvec-grep 集成）与知识实例文件化

> 加载时机：用户要「把知识/文档做成可语义检索的知识库」「配召回引擎」「查 zg/embedding/key」，
> 或 agent 需要**语义召回项目知识**（关键词 grep 不到的场景）时。
> 一句话：`nx-rp doc add` 登记知识 → `doc export` 实例文件化 → `zg index` 建索引 →
> `zg query "问题"` 语义召回；每个工作目录一个知识库（路径序列化隔离）。

---

## 一、架构与数据流

```
store.json 的 doc 条目（登记态）
    │ doc export（镜像，幂等）
    ▼
<docRoot>/<路径序列化>//*.md        # 知识实例文件（唯一事实源是 md 文件）
    │ zg index（远程 qwen embedding，direct 一次性子进程）
    ▼
<docRoot>/<路径序列化>/.zvec-grep/   # zg 索引（派生物，可随时重建）
    │ zg query（词法 FTS + 语义向量双路）
    ▼
带来源头块的召回结果（知识库根 / 子目录 / 来源工作目录 / 相对路径写法）
```

**路径序列化规则**：与 Claude Code 项目目录一致——非 `[A-Za-z0-9_-]` 逐字符替换为 `-`。
`D:\a_js\js_proj\nx-rp` → `d--a_js-js_proj-nx-rp`。一个工作目录一个知识库，互不混杂。

## 二、命令

```
nx-rp zg onboard                       # 新用户引导：装 zg → 拿 key → 选模型 → 用起来
nx-rp zg auth --key <key> [--model m]  # 配 key + 全局默认模型 + workspace 授权
nx-rp zg install                       # 探测 zg 可用性与 KB 状态（不装 MCP！）
nx-rp doc export [--root dir]          # doc 条目镜像为 KB md 文件（幂等；删除条目同步删文件）
nx-rp zg index [--rebuild] [--model m] # 建/增索引；--model 必须搭配 --rebuild
nx-rp zg query --q "问题" [--root dir] [--limit n]  # 语义召回（结果带来源头块）
nx-rp zg status [--root dir]           # 索引状态
nx-rp doc root                         # 看全局知识库根（默认 ~/.nx-rp/doc）
nx-rp doc root --set <dir>             # 改全局根（旧 KB 全量复制迁移 + 清旧痕迹）
```

**面板等价**：「召回引擎」tab——引擎状态卡片（zg 版本/KB 目录/索引/模型/key）、
召回试查（输入即查，结果含来源头块）、引导页链接。面板与 CLI 走同一 action。

## 三、可选远程模型（zg 目录内的全部远程款）

| 模型 id | 维度 | 输入 tokens | 说明 |
| --- | --- | --- | --- |
| `qwen/qwen3.7-text-embedding` | 1024 | 128K | **默认**；超长文档 |
| `qwen/text-embedding-v4` | 1024 | 8K | 经典款 |
| `qwen/qwen3-vl-embedding` | 2560 | 32K | 唯一支持图片 |

模型统一存 zg 全局配置（`~/.zvec-grep/config.json`），所有 workspace 共用。
换模型必须对已建索引的 KB 跑 `zg index --rebuild --model <m>`（维度锁定，否则拒绝）。

## 四、召回结果的用法（agent 视角）

`zg query` 的输出开头有**来源头块**：

```
[nx-rp 知识库召回]
知识库根: C:\Users\<user>\.nx-rp\doc
知识库子目录: d--a_js-js_proj-nx-rp
来源工作目录: D:\a_js\js_proj\nx-rp
命中文件相对路径: <知识库根>/<子目录>/<文件名>#L<起>-L<止>
```

- 命中条目格式 `文件名:起-止` 是 KB 内相对路径 + 行号；**预览只是片段**，
  需要更多上下文时直接按头块拼出绝对路径读全文（Read 工具即可）
- 头块里的「来源工作目录」告诉你这份知识属于哪个项目——跨项目召回时先看这个

## 五、agent 典型场景

- 「把这份 API 文档放进知识库」→ `doc add --name xxx --body @file` → `doc export` → `zg index`
- 「项目里有没有关于 X 的知识」→ `zg query --q "X"`（grep 不到的语义场景）
- 「换 embedding 模型」→ `zg index --rebuild --model <id>`（每个建过索引的 KB 都要重跑）
- 「知识库挪个地方」→ `doc root --set <新目录>`（自动迁移，迁移后各 KB 需 `zg index --rebuild`）
- 用户问 key 放哪了 → 只在 `~/.zvec-grep/config.json`（zg 全局配置）；nx-rp 不存储不回显不入库

## 六、安全与边界（不变量）

- **不装 MCP**：刻意不跑 `zg install`。zg 只做召回引擎（direct 一次性子进程，
  零常驻零端口）；已有装机的用户跑 `zg uninstall --target claude` 摘掉
- **key 纪律**：key 只经 CLI 参数写入 zg 全局配置；nx-rp 的 store、日志、
  返回值全程不存储、不回显
- **KB 目录隔离**：`workspaceKbFor` 的序列化产物不可能含 `/\..`，无路径穿越面
- **镜像幂等**：`doc export` 两次产出逐字节一致（exportedAt 用 doc.createdAt 派生），
  靠「内容不等才写」实现同步；KB 里非 doc 导出的文件（`d_` 前缀之外）不被清理

## 七、排障

| 症状 | 先查 | 说明 |
| --- | --- | --- |
| `WORKSPACE_INDEX_NOT_FOUND` | KB 目录是否有 `.zvec-grep/` | `zg status`；没有就 `zg index`（zg 0.2.x query 从进程 cwd 解析 workspace，nx-rp 已在 KB 目录里跑子进程） |
| `Unsupported embedding model` | `zg help models` | 模型 id 必须在 zg 目录内；nx-rp 侧 `resolveModel` 也会先拦 |
| 召回结果过旧 | 改过 md 后是否重新 `zg index` | zg 0.2.x 无查询前自动探测（新版 direct 才有），改完知识要手动重建/增量 |
| 索引失败：401/403 | key 是否有效 / workspace 授权 | `zg auth status`；重新 `zg auth --key` |

# workflow-author · 写工作流的标准指南

> 加载时机：你（agent）要生成一段 nx-rp 工作流文件时。
> 一句话：写一个 `export default async function run(ctx) { ... }`，
> 用 JS 原生控制流 + 四个 Node 类型，把「依赖图」画在 ctx.step/parallel 调用上。

---

## 一、最小骨架

```js
// my-workflow.mjs
export default async function run(ctx) {
  await ctx.step('节点名', () => /* 你的逻辑 */, { type: 'nxAction' });
}
```

文件可放在任何 cwd 相对路径，常见是项目根 `.nx-rp-workflows/<name>.mjs`。
保存：`nx-rp workflow add <name> --file .nx-rp-workflows/<name>.mjs`。

---

## 二、原语定义（agent 写工作流时只用这些）

### 2.1 Node（节点）

```
Node = {
  id:        string,        // 稳定 ID，服务端生成（n1, n2, ...），前端用作 React Flow key
  name:      string,        // 节点名（用户起的，可能重复）
  type:      'nxAction' | 'agent-call' | 'http' | 'raw',
                          // 画布按 type 上色 + 节点卡片显示哪种图标
  status:    'idle' | 'running' | 'success' | 'error' | 'skipped',
                          // 画布状态色：灰 / 蓝 / 绿 / 红 / 灰斜线
  startedAt: number?,        // Date.now() 开始时间
  finishedAt: number?,       // Date.now() 结束时间
  ms:        number?,        // 耗时 = finishedAt - startedAt
  payload:   any?,           // 节点 fn 的返回值（成功时）；err.message（失败时）
}
```

**type 默认值**：如果 ctx.step 不写 `{type}`，默认 `raw`（你愿意自己处理）。
推荐：`nxAction`（调 nx-rp 自身 action）/ `agent-call`（spawn CLI）/ `http`（fetch）/ `raw`（其他）。

### 2.2 Status（节点状态机）

```
        ┌──── idle（已声明未启动）
        ↓
   ┌─ running ─┐
   ↓           ↓
success     error

任意状态都可以被「外部跳过」到 skipped（条件边的 false 分支、运行中止等）
```

### 2.3 Edge（边）

```
Edge = {
  source:    NodeId,
  target:    NodeId,
  type:      'seq' | 'parallel' | 'conditional',
  blocking:  true | false,    // 默认 true；parallel 边 false（仅表达同组可读性）
}
```

| type | 含义 | blocking | 视觉 |
|---|---|---|---|
| **seq** | 强依赖：target 等 source 完成才走 | true | 实线带箭头 |
| **parallel** | 同组节点（ctx.parallel 内部），互相不依赖 | false | 虚线双向（k8s 风格） |
| **conditional** | 条件边：source 返回 true / false 决定走哪条 | true | 虚线带条件标签 |

**画布边长相**：
- seq 实线 + 实箭头
- parallel 虚线 + 双箭头 + 「∥」标记
- conditional 虚线 + 「? true / ? false」标签

### 2.4 事件帧（SSE 协议）

所有事件都是 `event: <type>\ndata: <json>\n\n` 格式：

| 事件 | data 形状 | 时机 |
|---|---|---|
| `graph` | `{ nodes: Node[], edges: Edge[] }`（完整图） | 每次声明新节点 / 新边 |
| `nodeStart` | `{ id, name }` | 节点开始执行 |
| `nodeDone` | `{ id, name, ok, ms, data?, error? }` | 节点执行结束 |
| `nodeLog` | `{ id?, line }` | 节点内自定义日志（来自 ctx.log） |
| `done` | `{ ok, elapsedMs }` | 整体结束（最后） |
| `error` | `{ message }` | 顶层未捕获错误 |

前端按事件合并：graph 全量覆盖、nodeStart/ Done 按 id 查节点改 status。

---

## 三、ctx 全部能力

```js
ctx.step(name, fn, opts?)
  opts.type    // 'nxAction' | 'agent-call' | 'http' | 'raw'，默认 raw
  opts.after   // string | string[]  显式前驱节点名（默认自动连上一节点）

ctx.parallel({ name1: fn1, name2: fn2 })  // 并发跑；不连实线边，用 parallel 虚线表同组
ctx.series({ name1: fn1, name2: fn2 })    // 顺序跑（一般用 await 链，少用）

ctx.http(url, opts?)        // fetch wrapper；自动包成 type:'http' 的节点
ctx.nx(actionId, params)    // 调 nx-rp 自身 action；自动包成 type:'nxAction' 节点
ctx.agent(cmd, args, opts?)  // spawn CLI；自动包成 type:'agent-call' 节点
ctx.log(line)               // 自定义日志（不进 graph，只是 log 事件）
```

**ctx.http / ctx.nx / ctx.agent 是 ctx.step 的语法糖**——它们内部都走 ctx.step 并加默认 type + 默认前驱。AI 写工作流时**只用 ctx.step 即可**，ctx.http/ctx.nx/ctx.agent 是给习惯 DSL 的用户用的。

---

## 四、典型模板（你举的 CI 例子）

```js
export default async function run(ctx) {
  // 启动后端 + 启动db（并发）
  await ctx.parallel({
    '启动后端': () => ctx.agent('node', ['./server.js']),
    '启动db':   () => ctx.agent('docker', ['compose', 'up', '-d', 'postgres']),
  });

  // 等后端健康（循环 + 条件跳出）
  for (let i = 0; i < 30; i++) {
    const r = await ctx.step('健康检查', () => ctx.http('http://localhost:3000/health'));
    if (r.ok) break;
    await new Promise((res) => setTimeout(res, 1000));
  }

  // 跑测试
  await ctx.step('跑测试', () => ctx.agent('pnpm', ['test']));

  // 并发收尾：db 健康 + 日志检查
  await ctx.parallel({
    'db 健康':  () => ctx.agent('docker', ['compose', 'exec', '-T', 'postgres', 'pg_isready']),
    '日志检查': () => ctx.agent('bash', ['-c', 'grep -i error server.log | tail -20']),
  });
}
```

**画布上呈现**：
- 「启动后端」与「启动db」中间一条虚线（parallel 边）
- 两节点各自「实线箭头」指向前一个节点（默认 seq 边）
- 整体是 DAG：左两节点 → 中间若干 → 右两节点

---

## 五、常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 用 JSON / YAML 描述节点 | AI 写错概率高；并发要发明「group」字段 | **写 JS**，`Promise.all` 就是并发 |
| `export const run = ...` | 校验失败：必须 `export default` | `export default async function run(ctx) { ... }` |
| 不写 ctx.step，直接 await | 节点不进 graph，画布上看不到 | 所有「有意义的工作」都包 ctx.step |
| `ctx.agent('cd dir && cmd', [])` | shell 不解析 | 用 `ctx.agent('cmd', [], { cwd: 'dir' })` |
| 错误被静默吞 | 看不到失败 | 让 fn 抛错——ctx.step 发 nodeDone.ok:false |
| 节点名重复 | 画布同色块混淆 | 用具体名字（「启动后端」「建索引」），别用「step1」 |

---

## 六、检查清单

- [ ] 文件第一行 `export default async function run(ctx) {`
- [ ] `nx-rp workflow validate --file <你的文件>` 返回 ✓
- [ ] `nx-rp workflow add <name> --file <你的文件>` 写入成功
- [ ] `nx-rp workflow run <name>` 能跑到底
- [ ] 画布上能看到节点状态变化（idle → running → success/error）

---

## 七、CLI 速查

```bash
nx-rp workflow validate --file workflow.mjs
nx-rp workflow add    <name> --file workflow.mjs
nx-rp workflow run    <name>                  # 跑（SSE 流式输出）
nx-rp workflow list                          # 列当前 cwd scope 的工作流
nx-rp workflow remove <name>                 # 删
```
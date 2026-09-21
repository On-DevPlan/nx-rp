# Changelog

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
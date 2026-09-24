# Changelog

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
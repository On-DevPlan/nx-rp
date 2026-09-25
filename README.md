# nx-rp（npx-repo）

**项目外部上下文信息管理，让项目开发更轻。**

`nx-rp` = `npx-repo` 的缩写。给当前项目（cwd）统一登记项目开发用得着的外部信息（上下文文档、源码依赖图、提示词日志、Skill 追踪、文件批注……），存在 `~/.nx-rp/store.json`，按 cwd 自动隔离 scope。

- **文档（doc）**：上下文 Markdown 短文——给 agent 当 prompt 上下文
- **依赖图（deps）**：扫 `src/` 的 import 关系（.js/.mjs/.cjs/.jsx，词法清洗后匹配），
  Graphviz WASM 渲染；面板双模式（预览/编辑 DOT 文本）+ .dot 另存/导入；只读——从源码推导
- **提示词日志（hook）**：Claude Code UserPromptSubmit hook——每次提交的提示词按目录记进本地 JSONL；面板里有「提示词日志」页

CLI 与 Web 面板同源（一条 action 同时声明 CLI 与 HTTP）。agent 通过 CLI 自助管理。

存储：`~/.nx-rp/store.json`（全局），按 cwd 自动隔离 scope。

GitHub: https://github.com/On-DevPlan/nx-rp

## 快速开始

```bash
npx nx-rp serve               # 打开 http://127.0.0.1:7820
npx nx-rp skill install       # 把内置 skill 装到 ~/.claude/skills
npx nx-rp routes              # 看 CLI ↔ Web 路由对照
```

## 命令速查

```
nx-rp serve                  启动 Web 面板（默认 :7820；端口上已有 nx-rp 面板则
                             登记当前目录到「最近目录」并直接打开它，不重复起进程）
nx-rp recents                最近使用的工作目录（面板可一键切换数据范围）
nx-rp skill install          装内置 skill 到 ~/.claude/skills
nx-rp skill get              把内置 skill 文档（SKILL.md / references/*）输出到 stdout；
                             同时按 install 既有逻辑装到 ~/.claude/skills——给不直接
                             识别 ~/.claude/skills 的 agent 一条命令拿全上下文
nx-rp help                   列出全部命令
nx-rp routes                 命令 ↔ 路由对照表
nx-rp bootstrap --json       一次性拿齐上下文
nx-rp deps                   扫 src/ 的 import 关系 → 依赖图（DOT 文本；
                             --json 拿 {nodes, edges, stats}；面板可视化）
nx-rp deps save --file <f>   依赖图 DOT 落盘为 .dot 文件（graphviz 交接）
nx-rp deps load --file <f>   读外部 .dot 文本（导入预览）
nx-rp hook on                启用提示词日志 hook（写 ~/.claude/settings.json）
nx-rp hook log               看当前目录的提示词记录（--all 跨目录）
nx-rp hook off               停用（只摘自己的 entry，其余 hooks 不动）
nx-rp hook skill-on / skills 启用 Skill 追踪 / 看 skill 使用统计与健康分
nx-rp zg onboard             召回引擎引导：装 zg → 拿 key → 选模型 → 用起来
nx-rp doc export             doc 知识实例文件化（镜像到知识库目录，可被 zg 索引）
nx-rp zg index / query       知识库建索引 / 语义召回（远程 qwen embedding）
nx-rp doc root --set <dir>   改全局知识库根（自动迁移）
nx-rp ann load / add         加载文件预览（1000 字符限）/ 挂批注（评价/待办/思考）
nx-rp ann todos              跨文件的未完成待办清单
```

加 `--json` 到任何命令得机器可读输出。

### 多项目 / 最近目录

数据按工作目录隔离（cwd scope）。在一个面板里管理多个项目：

- 每次在任何项目目录执行 `nx-rp serve`，该目录会被自动登记进「最近目录」——
  如果默认端口上已经有面板在跑，不会再起第二个进程，直接打开它
- 面板右上角「最近目录」下拉可切换数据范围：切换后的查看/新增/编辑都落到那个目录
- 想真正并行开两个面板：`nx-rp serve --port 7830` 显式指定端口

## 开发

```bash
pnpm install
pnpm dev          # vite + serve 双进程
pnpm start        # 生产模式：build + serve
pnpm test         # lint + build + smoke + unit
```

## License

MIT
# nx-rp（npx-repo）

**外部信息以链接方式管理，让项目开发更轻。**

`nx-rp` = `npx-repo` 的缩写。给当前项目（cwd）一组**链接**，把所有「项目用得着但不该放进来」的东西（外部 API 入口、工具面板、上下文文档、CI 仪表盘、Slack 工作区、第三方脚本入口……）统一登记在 `~/.nx-rp/store.json`，按 cwd 自动隔离 scope。

- **链接（link）**：URL / OpenAPI / CLI 入口 / 工具面板——只存元信息，不抓取内容
- **文档（doc）**：上下文 Markdown 短文——给 agent 当 prompt 上下文
- **工作流（workflow）**：节点 + 边编排；可视化或 JSON，4 种节点类型（nxAction / agent-call / http）
- **提示词日志（hook）**：Claude Code UserPromptSubmit hook——每次提交的提示词按目录记进本地 JSONL；面板里有「提示词日志」页

CLI 与 Web 面板同源（一条 action 同时声明 CLI 与 HTTP）。agent 通过 CLI 自助管理：写文件 → `workflow validate` → `workflow apply`。

存储：`~/.nx-rp/store.json`（全局），按 cwd 自动隔离 scope。

GitHub: https://github.com/On-DevPlan/nx-rp

## 快速开始

```bash
npx nx-rp serve               # 打开 http://127.0.0.1:7820
npx nx-rp skill install       # 把内置 skill 装到 ~/.claude/skills
npx nx-rp link add --name "GitHub API" --url "https://api.github.com"
npx nx-rp routes              # 看 CLI ↔ Web 路由对照
```

## 命令速查

```
nx-rp serve                  启动 Web 面板（默认 :7820）
nx-rp skill install          装内置 skill 到 ~/.claude/skills
nx-rp help                   列出全部命令
nx-rp routes                 命令 ↔ 路由对照表
nx-rp bootstrap --json       一次性拿齐上下文
nx-rp workflow validate <file>
nx-rp workflow format <file>
nx-rp workflow apply <file>
nx-rp hook on                启用提示词日志 hook（写 ~/.claude/settings.json）
nx-rp hook log               看当前目录的提示词记录（--all 跨目录）
nx-rp hook off               停用（只摘自己的 entry，其余 hooks 不动）
```

加 `--json` 到任何命令得机器可读输出。

## 开发

```bash
pnpm install
pnpm dev          # vite + serve 双进程
pnpm start        # 生产模式：build + serve
pnpm test         # lint + build + smoke + unit
```

## License

MIT
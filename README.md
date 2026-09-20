# nx-rp

外部资源链接器 + 工作流编排器（CLI + Web 面板）。

- 给当前项目（cwd）登记一组**外部资源链接**（URL / OpenAPI / 工具入口）
- 整理**上下文文档**（Markdown 短文）
- 编排**工作流**（节点 + 边），一键执行

存储：`~/.nx-rp/store.json`（全局），按 cwd 自动隔离 scope。

GitHub: https://github.com/On-DevPlan/nx-rp

## 快速开始

```bash
npm install -g nx-rp        # 或 pnpm add -g
npx nx-rp serve             # 打开 http://127.0.0.1:7820
nx-rp skill install         # 把内置 skill 装到 ~/.claude/skills
nx-rp routes                # 看 CLI ↔ Web 路由对照
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
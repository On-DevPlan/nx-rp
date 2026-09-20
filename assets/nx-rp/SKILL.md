---
name: nx-rp
description: nx-rp（npx-repo）—— 给当前项目用「链接」管理外部信息。当用户需要给某个项目登记一组外部资源链接（URL / OpenAPI / 工具面板 / Slack 频道）、整理上下文文档、或编排工作流（节点 + 边，含 nxAction / agent-call / http 四种节点类型）以便一键执行时使用。触发词：外部链接、外部资源整理、上下文文档、工作流编排、workflow、scope、cwd 作用域、nx-rp、npx-repo。
---

# nx-rp — 给当前项目接一组外部资源 + 编排工作流

**nx-rp = npx-repo**，给当前项目（cwd）一组**链接**，把所有「项目用得着但不该塞进代码库」的东西——外部 API、工具面板、上下文文档、CI 仪表盘——统一登记在 `~/.nx-rp/store.json`，按 cwd 自动隔离 scope。

它**不抓取内容、不存原始文件**——只存链接 + 上下文文档 + 工作流定义。

## 三件核心事

1. **`link`** — 登记外部资源链接（URL / OpenAPI 入口 / 工具入口 / Slack 频道）
2. **`doc`** — 写上下文文档（Markdown 短文）；agent 拿来当 prompt 上下文
3. **`workflow`** — 编排节点（可视化有向图 / pipeline / agent-call / HTTP 端点）；一键执行

每个资源的可见性都按 cwd 自动隔离：同一 cwd 看到一致数据，切换目录是不同 scope。

## CLI 与 Web 同源

`nx-rp serve` 启面板后，**每一条 CLI 命令都有等价 Web 操作**。反过来不一定：
CLI 可以有 `validate` / `format` 这类纯检查命令，Web 没有按钮。

```
nx-rp serve                    # 启 :7820 面板（--no-open 不弹浏览器）
nx-rp link list                # 当前 cwd scope 下的所有链接
nx-rp doc list
nx-rp workflow validate file.yaml   # 校验工作流文件
nx-rp workflow format file.yaml    # 美化输出
nx-rp workflow apply file.yaml     # 校验通过后写入当前 cwd scope
```

加 `--json` 得机器可读输出。

## agent 怎么编辑工作流

CLI **不**暴露 `workflow add` / `workflow remove` 这类 wrapper——
agent 编辑走文件：

1. 写一个 `my-flow.yaml`（声明式：节点 / 边 / 类型）
2. `nx-rp workflow validate my-flow.yaml` 校验
3. `nx-rp workflow apply my-flow.yaml` 写入当前 cwd scope

这是结构化编辑，agent 不需要去摸 JSON 细节。

## 触发场景

- 用户：「帮我把项目里那 5 个外部 API 整理一下，列个清单」→ agent 写 `links.yaml` → `nx-rp link apply links.yaml`（link 模块化后开放）
- 用户：「画个工作流：每周一拉一次 GitHub 数据 → 调 OpenAPI 解析 → 写到一个 doc」 → agent 写 `workflow.yaml` → `nx-rp workflow apply`
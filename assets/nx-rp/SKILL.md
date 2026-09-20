---
name: nx-rp
description: nx-rp（外部资源链接器 + 工作流编排器）。当用户需要在某个项目目录里登记一组外部资源链接、整理上下文文档、或定义可视化工作流（节点 + 边）以便在面板上一键执行时使用。触发词：外部链接、上下文文档、工作流编排、workflow、外部资源整理、scope、cwd 作用域、nx-rp。
---

# nx-rp — 给当前项目接一组外部资源 + 编排工作流

nx-rp 是个**本机 CLI + Web 面板**：每个 cwd 是独立范围，全局存储在 `~/.nx-rp/store.json`。

它本身**不抓取内容、不存原始文件**——只存**链接 + 上下文文档 + 工作流定义**。

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
---
name: nx-rp
description: nx-rp（npx-repo）—— 给当前项目用「链接」管理外部信息。当用户需要给某个项目登记一组外部资源链接（URL / OpenAPI / 工具面板 / Slack 频道）、整理上下文文档、或编排工作流（agent 用 JS 写 .mjs 文件，nx-rp 直接执行，SSE 流式输出进度）时使用。触发词：外部链接、外部资源整理、上下文文档、工作流编排、workflow、scope、cwd 作用域、nx-rp、npx-repo、提示词日志、prompt log、hook。
---

# nx-rp — 给当前项目接一组外部资源 + 编排工作流

**nx-rp = npx-repo**，给当前项目（cwd）一组**链接**，把所有「项目用得着但不该塞进代码库」的东西——外部 API、工具面板、上下文文档、CI 仪表盘——统一登记在 `~/.nx-rp/store.json`，按 cwd 自动隔离 scope。

它**不抓取内容、不存原始文件**——只存链接 + 上下文文档 + 工作流定义。

## 三件核心事

1. **`link`** — 登记外部资源链接（URL / OpenAPI 入口 / 工具入口 / Slack 频道）
2. **`doc`** — 写上下文文档（Markdown 短文）；agent 拿来当 prompt 上下文
3. **`workflow`** — 编排工作流；**agent 用 JS 写 `.mjs` 文件**（AI 生成 JS 质量远超 JSON），nx-rp 加载并执行，SSE 流式输出 nodeStart / nodeDone / log / done 事件

另有 **两个 hook 模块**（与 link / doc / workflow 平级，各自独立 tab 与开关）：

- **`hook-prompt` 提示词日志**：UserPromptSubmit，把每个会话里用户提交的提示词按目录记进
  `~/.nx-rp/prompts/<cwd哈希>.jsonl`（`hook on` / `hook off` / `hook log`）
- **`hook-skill` Skill 追踪**：PostToolUse（matcher Skill），把 skill 调用记进
  `~/.nx-rp/skills/<cwd哈希>.jsonl`，健康分 = 使用量 + 新鲜度（`hook skill-on` / `hook skill-off` / `hook skills`）

两者开关互不影响（各自只动自己 marker 指纹的 settings entry）：

```
nx-rp hook on / off          # 提示词日志开关（幂等；写前自动留快照）
nx-rp hook skill-on / skill-off  # Skill 追踪开关
nx-rp hook log               # 提示词记录（--all 跨目录，--limit N）
nx-rp hook skills            # Skill 使用统计与健康分（--all 跨目录）
nx-rp hook status / skill-status  # 各自的开关状态
```

面板上「提示词日志」「Skill 追踪」两个 tab 与上述命令一一对应。
使用与排障详见 [[prompt-log]]；工作流生成详见 [[workflow-author]]。

每个资源的可见性都按 cwd 自动隔离：同一 cwd 看到一致数据，切换目录是不同 scope。
多项目场景：`nx-rp recents` 列最近目录；面板右上角可一键切换数据范围；
默认端口上已有面板时再跑 `nx-rp serve` 不会起第二进程，登记当前目录并直接打开。

## CLI 与 Web 同源

`nx-rp serve` 启面板后，**每一条 CLI 命令都有等价 Web 操作**。反过来不一定：
CLI 可以有 `validate` 这类纯检查命令，Web 没有按钮。

```
nx-rp serve                          # 启 :7820 面板（--no-open 不弹浏览器；
                                     #   端口已有 nx-rp 面板则复用它）
nx-rp recents                        # 最近工作目录（面板快速切换 scope 的数据源）
nx-rp link list                      # 当前 cwd scope 下的所有链接
nx-rp doc list
nx-rp workflow validate --file demo.mjs   # 校验（不写盘）
nx-rp workflow add demo --file demo.mjs    # 写入当前 cwd scope
nx-rp workflow run demo                  # 跑（SSE 流式输出）
```

加 `--json` 得机器可读输出。

## agent 怎么编辑工作流

**写 JS，不写 JSON。** AI 生成 JS 比 JSON 质量好很多（训练数据更多），且
JS 原生支持并发（`Promise.all`）、循环（`for/while/await`）、条件（`if/try/catch`），
这些是复杂工作流的「母语」，不需要发明「group」「dependsOn」之类的 JSON 字段。

完整 API 参考与典型模板见 [[workflow-author]]。

## 触发场景

- 用户：「帮我把项目里那 5 个外部 API 整理一下，列个清单」→ agent 写 `links.json` → `nx-rp link apply`（link 模块化后开放）
- 用户：「画个工作流：启动后端 → 等健康 → 跑测试 → 并发收尾」→ agent 写 `.nx-rp-workflows/ci.mjs` → `nx-rp workflow add ci --file ...` → `nx-rp workflow run ci`
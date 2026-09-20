# Changelog

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
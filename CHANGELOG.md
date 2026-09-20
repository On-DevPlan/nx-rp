# Changelog

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
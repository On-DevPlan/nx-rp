// workflow 模块的 action 声明：5 条 CRUD（list/get/add/update/remove）。
//
// 注意：本模块的 CLI 表面**刻意不暴露**给 agent 用的高频命令：
//   - `workflow validate` 不作为 action（agent 跑 validate 是子操作）
//   - `workflow format` / `apply` 同理
// 这些走文件输入，与 add/update/remove 互补存在：
//   - add / update / remove：直接编辑当前 cwd scope（CLI 等价命令）
//   - validate / format / apply：基于文件（agent 编辑工作流的标准方式）
import * as service from './service.js';

export default {
  id: 'workflow',
  title: '工作流',
  order: 40,
  resource: 'workflow',
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'workflow.list',
      cli: ['workflow', 'list'],
      http: ['GET', '/api/workflows'],
      summary: '列出当前 cwd scope 的全部工作流',
      run: () => service.listWorkflows(),
      render: (list) => {
        if (!list.length) return '（暂无工作流）';
        return list.map((w) => `  ${w.name.padEnd(20)}  type=${w.type}  ${w.nodes} 节点 / ${w.edges} 边`).join('\n');
      },
    },
    {
      id: 'workflow.get',
      cli: ['workflow', 'get'],
      http: ['GET', '/api/workflows/:name'],
      args: ['name'],
      summary: '读单个工作流的完整定义',
      run: (ctx) => service.getWorkflow(ctx.name),
    },
    {
      id: 'workflow.add',
      cli: ['workflow', 'add'],
      http: ['POST', '/api/workflows'],
      summary: '新建工作流（CLI 用 --file 读 JSON；HTTP body 即定义）',
      flags: {
        file: { type: 'string', hint: 'JSON 文件路径（cwd 作用域）' },
      },
      run: async (ctx) => {
        const def = ctx.file ? await readJsonFile(ctx.file) : ctx.body || {};
        return service.addWorkflow(def);
      },
      render: (w) => `已登记工作流: ${w.name}  (${w.type})`,
    },
    {
      id: 'workflow.update',
      cli: ['workflow', 'update'],
      http: ['PATCH', '/api/workflows/:name'],
      args: ['name'],
      summary: '覆盖更新工作流（PATCH 语义）',
      flags: {
        file: { type: 'string', hint: 'JSON 文件路径' },
      },
      run: async (ctx) => {
        const def = ctx.file ? await readJsonFile(ctx.file) : ctx.body || {};
        return service.updateWorkflow(ctx.name, def);
      },
      render: (w) => `已更新: ${w.name}`,
    },
    {
      id: 'workflow.remove',
      cli: ['workflow', 'remove'],
      http: ['DELETE', '/api/workflows/:name'],
      args: ['name'],
      summary: '删除工作流',
      run: (ctx) => service.removeWorkflow(ctx.name),
      render: (w) => `已删除: ${w.name}`,
    },
    {
      // 文件编辑核心：agent 写文件 → validate 校验 → apply 写入
      id: 'workflow.validate',
      cli: ['workflow', 'validate'],
      // 仅 CLI：Web 不需要（validate 是「上传前」动作，agent 用；Web 是「已上传」状态）
      http: null,
      summary: '校验工作流文件（不写盘；通过即返回规范化定义）',
      flags: {
        file: { type: 'string', required: true, hint: 'JSON 文件路径' },
      },
      run: async (ctx) => {
        const def = await readJsonFile(ctx.file);
        const normalized = service.parseWorkflow(def);
        return {
          status: 'ok',
          file: ctx.file,
          name: normalized.name,
          type: normalized.type,
          nodes: normalized.nodes.length,
          edges: normalized.edges.length,
        };
      },
      render: (r) => `工作流「${r.name}」(${r.type}) 校验通过：${r.nodes} 节点 / ${r.edges} 边`,
    },
    {
      // format 是「美化」——agent 不该纠结 JSON 缩进
      id: 'workflow.format',
      cli: ['workflow', 'format'],
      http: null,
      summary: '把工作流定义规范化并美化输出（不写盘；stdout 即可被重定向）',
      flags: {
        file: { type: 'string', required: true, hint: '输入 JSON 文件路径' },
        indent: { type: 'number', hint: '缩进空格数（默认 2）' },
      },
      run: async (ctx) => {
        const def = await readJsonFile(ctx.file);
        const normalized = service.parseWorkflow(def);
        const out = service.formatWorkflow(normalized, { indent: ctx.indent || 2 });
        process.stdout.write(out + '\n');
        return undefined;
      },
    },
    {
      // apply：agent 编辑工作流的最终落点
      id: 'workflow.apply',
      cli: ['workflow', 'apply'],
      http: ['POST', '/api/workflows/apply'],
      summary: '校验 + 写入当前 cwd scope（已存在则覆盖；agent 编辑工作流的标准命令）',
      flags: {
        file: { type: 'string', required: true, hint: 'JSON 文件路径' },
      },
      run: async (ctx) => {
        const def = await readJsonFile(ctx.file);
        const normalized = service.parseWorkflow(def);
        // 已有则 update，没有则 add（apply 一条命令兼顾两种情况，避免 agent 还要先 list）
        return mutateStoreForApply(normalized);
      },
      render: (r) => `已应用: ${r.name}  (${r.nodes.length} 节点 / ${r.edges.length} 边)`,
    },
  ],
};

// apply 内部：先检查再走 add 或 update
async function mutateStoreForApply(def) {
  const { mutateStore } = await import('../../core/store.js');
  const { cwdScope } = await import('../../core/paths.js');
  return mutateStore((store) => {
    const k = cwdScope();
    if (!store.scopes[k]) store.scopes[k] = { links: [], docs: [], workflows: {} };
    const scope = store.scopes[k];
    if (scope.workflows[def.name]) {
      scope.workflows[def.name] = { ...scope.workflows[def.name], ...def, name: def.name, updatedAt: new Date().toISOString() };
    } else {
      scope.workflows[def.name] = { ...def, createdAt: new Date().toISOString() };
    }
    return scope.workflows[def.name];
  });
}

async function readJsonFile(p) {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(p, 'utf8');
  return JSON.parse(text);
}
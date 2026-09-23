// workflow action 声明（DOT 极简版）。
//
// 命令空间：workflow <verb> [name] [args]
//   workflow list                           列出 .nx-rp-workflows/ 下的 .dot
//   workflow get <name>                     取一份（返回 source + 解析后的 nodes/edges）
//   workflow save <name> --body <text|@file> 保存（@前缀从文件读）
//   workflow remove <name>                  删除
//   workflow validate [--file <path>|--text <s>]
//                                             静态校验：语法、连通性、悬挂边、自环
//   workflow import --file <path> [--name <name>]
//                                             从外部 .dot 文件读进来，按名字入库
// 不再做 run（DOT 是声明式有向图语言，无可执行语义——
// 执行由用户的工作流引擎在外部脚本里负责）。
import * as service from './service.js';
import fsp from 'node:fs/promises';

function readBody(body) {
  if (typeof body !== 'string') return body || '';
  if (body.startsWith('@')) return fsp.readFile(body.slice(1), 'utf8');
  return body;
}

export default {
  id: 'workflow',
  title: '工作流',
  order: 40,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'workflow.list',
      cli: ['workflow', 'list'],
      http: ['GET', '/api/workflows'],
      summary: '列出所有工作流（DOT 文件）',
      run: () => service.listWorkflows(),
      render: (list) => list.length
        ? list.map((w) => `  ${w.name}  ${w.bytes}B  ${new Date(w.modifiedAt).toISOString()}`).join('\n')
        : '（无工作流）',
    },
    {
      id: 'workflow.get',
      cli: ['workflow', 'get'],
      http: ['GET', '/api/workflows/:name'],
      args: ['name'],
      summary: '读一份工作流的 DOT 源码 + 解析结果',
      run: (ctx) => service.readWorkflow(ctx.name),
      render: (w) => `${w.name}  (${w.nodes.length} 节点 / ${w.edges.length} 边)\n路径: ${w.path}`,
    },
    {
      id: 'workflow.save',
      cli: ['workflow', 'save'],
      http: ['POST', '/api/workflows'],
      summary: '保存 DOT 文本为工作流（--body 字符串；@前缀从文件读）',
      args: ['name'],
      flags: { body: { type: 'string', required: true, hint: 'DOT 源码（@前缀从文件读）' } },
      run: async (ctx) => {
        const text = await readBody(ctx.body);
        return service.writeWorkflow(ctx.name, text);
      },
      render: (r) => `已保存: ${r.path}${r.problems.length ? '\n警告: ' + r.problems.join('; ') : ''}`,
    },
    {
      id: 'workflow.remove',
      cli: ['workflow', 'remove'],
      http: ['DELETE', '/api/workflows/:name'],
      args: ['name'],
      summary: '删除一份工作流',
      run: (ctx) => service.removeWorkflow(ctx.name),
      render: (r) => `已删除: ${r.name}`,
    },
    {
      id: 'workflow.validate',
      cli: ['workflow', 'validate'],
      http: ['POST', '/api/workflows/validate'],
      summary: '静态校验（语法 / 连通性 / 自环 / 悬挂边）—— 不执行',
      flags: {
        text: { type: 'string', hint: '直接给一段 DOT 文本' },
        file: { type: 'string', hint: 'DOT 文件路径（与 --text 互斥）' },
      },
      run: (ctx) => {
        if (ctx.file) return service.validateWorkflowFile(ctx.file);
        return service.validateWorkflowText(ctx.text || '');
      },
      render: (r) => r.ok
        ? `OK（${r.nodes} 节点 / ${r.edges} 边）`
        : `问题: ${(r.problems || []).join('; ')}`,
    },
    {
      id: 'workflow.import',
      cli: ['workflow', 'import'],
      http: ['POST', '/api/workflows/import'],
      summary: '从外部 DOT 文件导入到 .nx-rp-workflows/ 下',
      flags: {
        file: { type: 'string', required: true, hint: '外部 DOT 文件绝对路径' },
        name: { type: 'string', hint: '导入后存储的名字（默认用文件名去后缀）' },
      },
      run: async (ctx) => {
        const raw = await fsp.readFile(ctx.file, 'utf8');
        const base = ctx.file.split(/[\\/]/).pop().replace(/\.dot$/, '');
        const name = ctx.name || base;
        return service.writeWorkflow(name, raw);
      },
      render: (r) => `已导入: ${r.path}`,
    },
  ],
};
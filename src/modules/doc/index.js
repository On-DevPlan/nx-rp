// doc 模块的 action 声明：5 条 CRUD。
import * as service from './service.js';

export default {
  id: 'doc',
  title: '文档',
  order: 30,
  resource: 'doc',
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'doc.list',
      cli: ['doc', 'list'],
      http: ['GET', '/api/docs'],
      summary: '列出当前 cwd scope 的全部文档',
      run: () => service.listDocs(),
      render: (list) => {
        if (!list.length) return '（暂无文档）';
        return list.map((d) => `  ${d.id}  ${d.name}`).join('\n');
      },
    },
    {
      id: 'doc.get',
      cli: ['doc', 'get'],
      http: ['GET', '/api/docs/:id'],
      args: ['id'],
      summary: '查看单篇文档（含 body）',
      run: (ctx) => service.getDoc(ctx.id),
    },
    {
      id: 'doc.add',
      cli: ['doc', 'add'],
      http: ['POST', '/api/docs'],
      summary: '新建一篇文档（name + body）',
      flags: {
        name: { type: 'string', required: true, hint: '文档名' },
        body: { type: 'string', hint: '正文（CLI 用 --body=@file 读文件）' },
        tags: { type: 'array', hint: '逗号分隔的标签' },
        source: { type: 'string', hint: '来源（URL / 文件路径）' },
      },
      run: (ctx) => service.addDoc({
        name: ctx.name, body: ctx.body || '',
        tags: ctx.tags || [], source: ctx.source || '',
      }),
      render: (d) => `已登记文档: ${d.name}  (${d.id})`,
    },
    {
      id: 'doc.update',
      cli: ['doc', 'update'],
      http: ['PATCH', '/api/docs/:id'],
      args: ['id'],
      summary: '改文档（PATCH 语义）',
      flags: {
        name: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array' },
        source: { type: 'string' },
      },
      run: (ctx) => service.updateDoc(ctx.id, {
        name: ctx.name, body: ctx.body,
        tags: ctx.tags, source: ctx.source,
      }),
      render: (d) => `已更新: ${d.name}`,
    },
    {
      id: 'doc.remove',
      cli: ['doc', 'remove'],
      http: ['DELETE', '/api/docs/:id'],
      args: ['id'],
      summary: '删除文档',
      run: (ctx) => service.removeDoc(ctx.id),
      render: (d) => `已删除: ${d.name}`,
    },
  ],
};
// link 模块的 action 声明：5 条 CRUD（list / get / add / update / remove）。
//
// 五动词的 HTTP 方法与资源路径：
//   list   GET    /api/links
//   get    GET    /api/links/:id
//   add    POST   /api/links
//   update PATCH  /api/links/:id
//   remove DELETE /api/links/:id
//
// update 是 PATCH 语义——只改传入字段，PUT 语义会被并发覆盖。
import * as service from './service.js';

const renderList = (list) => {
  if (!list.length) return '（暂无链接）';
  return list.map((l) => `  ${l.id}  ${l.name.padEnd(20)}  ${l.url}`).join('\n');
};

export default {
  id: 'link',
  title: '链接',
  order: 20,
  resource: 'link',
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'link.list',
      cli: ['link', 'list'],
      http: ['GET', '/api/links'],
      summary: '列出当前 cwd scope 的全部链接',
      run: () => service.listLinks(),
      render: renderList,
    },
    {
      id: 'link.get',
      cli: ['link', 'get'],
      http: ['GET', '/api/links/:id'],
      args: ['id'],
      summary: '查看单个链接（按 id）',
      run: (ctx) => service.getLink(ctx.id),
    },
    {
      id: 'link.add',
      cli: ['link', 'add'],
      http: ['POST', '/api/links'],
      summary: '登记一个链接（url 在同一 scope 内唯一）',
      flags: {
        name: { type: 'string', required: true, hint: '名称' },
        url: { type: 'string', required: true, hint: 'URL 或入口' },
        kind: { type: 'string', enum: ['url', 'openapi', 'cli', 'doc', 'tool', 'other'], hint: '类型' },
        tags: { type: 'array', hint: '逗号分隔的标签' },
        note: { type: 'string', hint: '备注' },
      },
      run: (ctx) => service.addLink({
        name: ctx.name, url: ctx.url,
        kind: ctx.kind, tags: ctx.tags || [], note: ctx.note || '',
      }),
      render: (l) => `已登记链接: ${l.name}  (${l.id})  → ${l.url}`,
    },
    {
      id: 'link.update',
      cli: ['link', 'update'],
      http: ['PATCH', '/api/links/:id'],
      args: ['id'],
      summary: '改链接（PATCH 语义，只改传入的字段）',
      flags: {
        name: { type: 'string' },
        url: { type: 'string' },
        kind: { type: 'string', enum: ['url', 'openapi', 'cli', 'doc', 'tool', 'other'] },
        tags: { type: 'array' },
        note: { type: 'string' },
      },
      run: (ctx) => service.updateLink(ctx.id, {
        name: ctx.name, url: ctx.url,
        kind: ctx.kind, tags: ctx.tags, note: ctx.note,
      }),
      render: (l) => `已更新: ${l.name}`,
    },
    {
      id: 'link.remove',
      cli: ['link', 'remove'],
      http: ['DELETE', '/api/links/:id'],
      args: ['id'],
      summary: '删除链接',
      run: (ctx) => service.removeLink(ctx.id),
      render: (l) => `已删除: ${l.name}`,
    },
  ],
};
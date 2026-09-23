// annotations action 声明：文件加载器 + 批注 CRUD + 跨文件待办。
//
// 所有 action 都以 file（目标文件绝对路径）为主键——批注挂在文件上。
// load 是只读的（带渲染上限铁律）；五条 CRUD 让 annotations 声明为 resource，
// registry 的 CRUD 完备性测试自动钉住两端可达。
import * as service from './service.js';

const FILE_HINT = '目标文件绝对路径';

export default {
  id: 'annotations',
  title: '文件批注',
  order: 53,
  resource: 'annotation',
  view: () => import('./view.jsx'),

  actions: [
    // ─── resource CRUD（registry 断言五操作齐备）──────────────────
    {
      id: 'annotation.list',
      cli: ['ann', 'list'],
      http: ['GET', '/api/annotations'],
      summary: '列出某文件的批注（--kind review/todo/note 过滤，--open 只看未完成）',
      flags: {
        file: { type: 'string', required: true, hint: FILE_HINT },
        kind: { type: 'string', hint: 'review / todo / note' },
        open: { type: 'boolean', hint: '只看未完成 todo' },
      },
      run: (ctx) => service.listAnnotations({ file: ctx.file, kind: ctx.kind, open: ctx.open }),
      render: (list) => {
        if (!list.length) return '（该文件暂无批注——nx-rp ann add --file <路径> --body <内容>）';
        return list.map((a) => {
          const mark = a.kind === 'todo' ? (a.done ? '[x]' : '[ ]') : { review: '评', note: '思' }[a.kind] || '·';
          const line = a.line ? `:L${a.line}` : '';
          return `${mark} ${a.id} ${line} ${a.body.slice(0, 80)}`;
        }).join('\n');
      },
    },
    {
      id: 'annotation.get',
      cli: ['ann', 'get'],
      http: ['GET', '/api/annotations/:id'],
      args: ['id'],
      summary: '看单条批注（需 --file 定位桶）',
      flags: { file: { type: 'string', required: true, hint: FILE_HINT } },
      run: (ctx) => service.getAnnotation({ file: ctx.file, id: ctx.id }),
    },
    {
      id: 'annotation.add',
      cli: ['ann', 'add'],
      http: ['POST', '/api/annotations'],
      summary: '添加批注（--kind review 评价 / todo 待办 / note 思考；--line 行号锚点）',
      flags: {
        file: { type: 'string', required: true, hint: FILE_HINT },
        body: { type: 'string', required: true, hint: '批注内容' },
        kind: { type: 'string', hint: 'review / todo / note（默认 note）' },
        line: { type: 'number', hint: '行号锚点（可选）' },
      },
      run: (ctx) => service.addAnnotation({ file: ctx.file, body: ctx.body, kind: ctx.kind, line: ctx.line }),
      render: (a) => `已添加 (${a.kind}${a.line ? ':L' + a.line : ''}): ${a.id} — ${a.body.slice(0, 60)}`,
    },
    {
      id: 'annotation.update',
      cli: ['ann', 'update'],
      http: ['PATCH', '/api/annotations/:id'],
      args: ['id'],
      summary: '改批注（PATCH 语义；todo 可改 --done）',
      flags: {
        file: { type: 'string', required: true, hint: FILE_HINT },
        body: { type: 'string', hint: '新内容' },
        line: { type: 'number', hint: '新行号' },
        done: { type: 'boolean', hint: 'todo 完成状态' },
      },
      run: (ctx) => service.updateAnnotation({ file: ctx.file, id: ctx.id, body: ctx.body, line: ctx.line, done: ctx.done }),
      render: (a) => `已更新: ${a.id}`,
    },
    {
      id: 'annotation.remove',
      cli: ['ann', 'remove'],
      http: ['DELETE', '/api/annotations/:id'],
      args: ['id'],
      summary: '删除批注',
      flags: { file: { type: 'string', required: true, hint: FILE_HINT } },
      run: (ctx) => service.removeAnnotation({ file: ctx.file, id: ctx.id }),
      render: (a) => `已删除: ${a.id}`,
    },

    // ─── 文件加载器（窗口切片 = web 渐进加载；上限模式 = CLI 铁律）────
    {
      id: 'annotation.load',
      cli: ['ann', 'load'],
      http: ['GET', '/api/annotations/load'],
      summary: '加载文件内容：默认 1000 字符预览（超限拒绝渲染）；--offset/--limit 窗口切片（渐进加载，永不拒绝）',
      flags: {
        file: { type: 'string', required: true, hint: FILE_HINT },
        full: { type: 'boolean', hint: '全量（仍受 200K 硬上限）' },
        offset: { type: 'number', hint: '窗口模式：起始字符（默认 0）' },
        limit: { type: 'number', hint: '窗口模式：本次取多少字符；返回 hasMore/nextOffset' },
      },
      run: (ctx) => service.loadFile({
        file: ctx.file, full: !!ctx.full,
        offset: ctx.offset, limit: ctx.limit,
      }),
      render: (r) => {
        const head = `${r.file}（${r.totalChars} 字符 / ${r.lineCount} 行）`;
        if (r.window) {
          const range = `${r.offset}-${r.offset + r.limit}`;
          const more = r.hasMore ? `\n[更多] nextOffset=${r.nextOffset}（还剩 ${r.totalChars - r.nextOffset} 字符）` : '\n[完]';
          return `${head}  窗口 ${range}\n${r.body}${more}`;
        }
        if (r.truncated) return `${head}\n[拒绝渲染] ${r.message}`;
        return `${head}\n${r.body}`;
      },
    },

    // ─── 目录浏览（路径渐进式加载：逐级 readdir，不递归）────────────
    {
      id: 'annotation.browse',
      cli: ['ann', 'browse'],
      http: ['GET', '/api/annotations/browse'],
      summary: '列出目录直接子项（不递归；隐藏项跳过）——面板路径浏览的数据源',
      flags: {
        dir: { type: 'string', hint: '目录绝对路径（缺省当前工作目录）' },
      },
      run: (ctx) => service.listDir({ dir: ctx.dir }),
      render: (r) => {
        const lines = [`[D] ${r.dir}`];
        if (r.parent) lines.push(`  ..  → ${r.parent}`);
        for (const d of r.dirs) lines.push(`  [D] ${d}/`);
        for (const f of r.files) lines.push(`      ${f}`);
        if (r.filesTruncated) lines.push(`  …（文件超过 ${r.files.length} 个，已截断）`);
        return lines.join('\n');
      },
    },

    // ─── 跨文件待办清单 ────────────────────────────────────────────
    {
      id: 'annotation.todos',
      cli: ['ann', 'todos'],
      http: ['GET', '/api/annotations/todos'],
      summary: '跨文件的全部未完成 todo（待办操作主入口）',
      run: () => service.listAllTodos(),
      render: (list) => {
        if (!list.length) return '（没有未完成的 todo）';
        return list.map((a) => `${a.id}  ${a.file}${a.line ? ':L' + a.line : ''}  ${a.body.slice(0, 70)}`).join('\n');
      },
    },
  ],
};

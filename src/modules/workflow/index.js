// workflow 模块 action 声明：5 条 CRUD（list/get/add/update/remove）+ 3 条文件命令。
//
// 注意：add/update/remove CLI 命令支持两种形态：
//   1. 直接传内容：nx-rp workflow add <name>  --content "export default async (ctx) => { ... }"
//   2. 从文件读：nx-rp workflow add <name> --file workflow.mjs
//
// 因为 LLM 生成 JS 比 JSON 顺手太多，本模块只接受 JS —— 服务端
// 不再解析 JSON 拓扑，运行就是真的把 .mjs 加载执行。
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
        return list.map((w) => `  ${w.name.padEnd(20)}  ${(w.createdAt || '').slice(0, 19)}`).join('\n');
      },
    },
    {
      id: 'workflow.get',
      cli: ['workflow', 'get'],
      http: ['GET', '/api/workflows/:name'],
      args: ['name'],
      summary: '读工作流的存储位置与元数据（不含源码）',
      run: async (ctx) => {
        const list = await service.listWorkflows();
        const hit = list.find((w) => w.name === ctx.name);
        if (!hit) throw (await import('../../core/errors.js')).notFound(`工作流不存在: ${ctx.name}`);
        return hit;
      },
    },
    {
      id: 'workflow.add',
      cli: ['workflow', 'add'],
      http: ['POST', '/api/workflows'],
      summary: '新建工作流（CLI 用 --file 读 .mjs；HTTP body 即源码字符串）',
      args: ['name'],
      flags: {
        file: { type: 'string', hint: 'JS 文件路径（cwd 相对）' },
      },
      run: async (ctx) => {
        if (!ctx.file) throw (await import('../../core/errors.js')).invalidInput('缺少 --file <path>');
        return service.saveWorkflow(ctx.name, ctx.file);
      },
      render: (w) => `已登记工作流: ${w.name}  → ${w.path}`,
    },
    {
      id: 'workflow.update',
      cli: ['workflow', 'update'],
      http: ['PATCH', '/api/workflows/:name'],
      args: ['name'],
      summary: '覆盖更新工作流源码（从 --file 读）',
      flags: {
        file: { type: 'string', required: true, hint: 'JS 文件路径' },
      },
      run: async (ctx) => service.saveWorkflow(ctx.name, ctx.file),
      render: (w) => `已更新: ${w.name}`,
    },
    {
      id: 'workflow.remove',
      cli: ['workflow', 'remove'],
      http: ['DELETE', '/api/workflows/:name'],
      args: ['name'],
      summary: '删除工作流',
      run: async (ctx) => service.removeWorkflow(ctx.name),
      render: (r) => `已删除: ${r.name}`,
    },
    // 给 Web 端用：浏览器不能 fs，直接传源码过来
    {
      id: 'workflow.write',
      cli: null,
      http: ['POST', '/api/workflows/write'],
      summary: '保存工作流源码（HTTP body = {name, body}，写到 cwd + 同步 store）',
      flags: {
        name: { type: 'string', required: true },
        body: { type: 'string', required: true },
      },
      run: async (ctx) => {
        const file = await service.writeWorkflow(ctx.name, ctx.body);
        return { name: ctx.name, file };
      },
      render: (r) => `已保存: ${r.name}  → ${r.file}`,
    },
    {
      id: 'workflow.source',
      cli: null,
      http: ['GET', '/api/workflows/:name/source'],
      summary: '读工作流源码（HTTP 端给 Web 加载用）',
      args: ['name'],
      run: (ctx) => service.readWorkflowSource(ctx.name),
    },
    // ─── 文件命令（agent 编辑工作流的核心接口） ─────────────────────
    {
      id: 'workflow.validate',
      cli: ['workflow', 'validate'],
      http: null,
      summary: '校验 .mjs 文件：能 import、export default 是函数',
      flags: { file: { type: 'string', required: true, hint: 'JS 文件路径' } },
      run: async (ctx) => service.validateWorkflow(ctx.file),
      render: (v) => `✓ 工作流「${v.name}」 校验通过（async=${v.isAsync}）`,
    },
    {
      id: 'workflow.run',
      cli: ['workflow', 'run'],
      http: ['GET', '/api/workflows/run/:name', 'POST', '/api/workflows/run/:name'],
      streamResponse: true,
      summary: '运行工作流（HTTP 端 SSE 流式输出 nodeStart/nodeDone/done）',
      args: ['name'],
      flags: {
        file: { type: 'string', hint: '覆盖工作流存储路径（不指定就用 scope 里的）' },
      },
      run: async (ctx, meta) => {
        // 找文件：file > 存储
        let filePath = ctx.file;
        if (!filePath) {
          const list = await service.listWorkflows();
          const hit = list.find((w) => w.name === ctx.name);
          if (!hit || !hit.sourceFile) throw notFound(`未指定 --file，且工作流「${ctx.name}」没有 sourceFile 记录`);
          filePath = hit.sourceFile;
        }
        const s = await service.runWorkflowFile(filePath);
        if (meta?.transport === 'http') {
          return {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
              connection: 'keep-alive',
            },
            stream: s,
          };
        }
        // CLI：把帧直写 stdout
        s.pipe(process.stdout);
        return undefined;
      },
    },
  ],
};

async function notFound(msg) {
  const { notFound: nf } = await import('../../core/errors.js');
  return nf(msg);
}
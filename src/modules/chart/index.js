// chart action 声明：项目图表域。
//
// 两个并列视图共属一个模块：
//   · dot 依赖图：scan 是事实源（从源码 import 推导，只读）；save/load 是 DOT
//     文本的导出与导入（graphviz 交接、外部 .dot 复用），不回写源码语义。
//     刻意不提供 workflow CRUD（无列表/命名/多实例管理）——图从源码推导。
//   · archify 图表：archify skill 产出的自包含 HTML 登记/发现/直出/移除。
//     图一律出自 archify skill 的精修流程——这里不调 archify CLI、不从源码
//     自动出图（机器自动生成的架构图不可信）。语义见 ./archify.js。
import * as service from './service.js';
import * as archify from './archify.js';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { cwdDir } from '../../core/paths.js';

export default {
  id: 'chart',
  title: '图表',
  order: 40,
  view: () => import('./view.jsx'),

  actions: [
    // ─── dot 依赖图 ──────────────────────────────────────────────
    {
      id: 'chart.scan',
      cli: ['chart'],
      http: ['GET', '/api/chart'],
      summary: '扫描 src/ 的 import 关系 → 依赖图（DOT 文本 + 统计；--root 改扫描根）',
      flags: {
        root: { type: 'string', hint: '扫描根（默认 ./src）' },
        json: { type: 'boolean', hint: '结构化输出（{dot,nodes,edges,stats}）而非 DOT 文本' },
      },
      run: async (ctx) => {
        // 扫描根相对 cwdDir()（面板=激活 scope）——与 save 的落盘基准一致
        const g = await service.depsToDot(join(cwdDir(), ctx.root || 'src'));
        if (ctx.json) return g;
        process.stdout.write(g.dot + '\n');
        return g.stats;
      },
      render: (s) => (typeof s === 'object' && s.files !== undefined
        ? `DOT 已输出（${s.files} 节点 / ${s.edges} 边 / ${s.crossLayer} 跨层）`
        : ''),
    },
    {
      id: 'chart.save',
      cli: ['chart', 'save'],
      http: ['POST', '/api/chart/save'],
      summary: '把 DOT 文本存为 .dot 文件（默认 ./.nx-rp-deps.dot；--dot 缺省 = 重新扫描后保存）',
      flags: {
        file: { type: 'string', hint: '目标文件（cwd 相对路径；必须 .dot/.gv 扩展名）' },
        dot: { type: 'string', hint: 'DOT 文本（缺省 = 扫描 src/ 生成）' },
      },
      run: async (ctx) => service.saveDot({
        file: ctx.file || '.nx-rp-deps.dot',
        dot: ctx.dot !== undefined ? ctx.dot : (await service.depsToDot(join(cwdDir(), ctx.root || 'src'))).dot,
      }),
      render: (r) => `${r.overwritten ? '已覆盖' : '已保存'}: ${r.file}（${r.bytes} 字节）`,
    },
    {
      id: 'chart.load',
      cli: ['chart', 'load'],
      http: null,
      summary: '读取 .dot 文本（绝对或 cwd 相对；上限 200K，二进制拒绝）——CLI 专用：HTML 视图导入走前端 FileReader，不暴露 HTTP',
      flags: { file: { type: 'string', required: true, hint: '.dot 文件路径' } },
      run: (ctx) => service.loadDot({ file: ctx.file }),
      render: (r) => `${r.file}（${r.chars} 字符）\n${r.dot}`,
    },

    // ─── archify 子命令：图表登记 / 发现 / 直出 / 移除 ────────────
    // HTML 是 archify 的只读产物：这里不渲染不改内容，只登记/发现/直出/移除。
    {
      id: 'chart.archify.list',
      cli: ['chart', 'archify', 'list'],
      http: ['GET', '/api/chart/archify'],
      summary: '列出已登记的 archify 图表（scope 隔离）',
      run: () => archify.listDiagrams(),
      render: (r) => {
        if (!r.entries.length) {
          return '（scope 内暂无登记图表——chart archify discover 看 .archify/，或用 archify skill 生成后 chart archify add 登记）';
        }
        return r.entries.map((e) => {
          const mark = e.generated ? '[自动]' : '[登记]';
          const stale = e.present ? '' : ' [文件缺失]';
          return `${e.id}  ${mark}${stale} ${e.type}  ${e.name}`;
        }).join('\n');
      },
    },
    {
      id: 'chart.archify.discover',
      cli: ['chart', 'archify', 'discover'],
      http: ['GET', '/api/chart/archify/discover'],
      summary: '扫描 cwd/.archify/ 里 archify skill 的产物（一层；标注是否已登记）',
      run: () => archify.discoverDiagrams(),
      render: (r) => {
        if (!r.items.length) return `（${r.root} 下没有 archify 产物——先用 archify skill 生成）`;
        return r.items.map((i) =>
          `${i.registered ? '[已登记]' : '[未登记]'} ${i.dir}  ${i.type}${i.title ? '  ' + i.title : ''}`
        ).join('\n');
      },
    },
    {
      id: 'chart.archify.add',
      cli: ['chart', 'archify', 'add'],
      http: ['POST', '/api/chart/archify/add'],
      summary: '把 archify 产物 HTML 拷入 scope 存储并登记（--candidate 带上类型/标题元数据；同名覆盖）',
      flags: {
        file: { type: 'string', required: true, hint: 'archify 产物 .html 路径（绝对或 cwd 相对）' },
        candidate: { type: 'string', hint: 'candidate.json 路径（可选；抽 type/title 元数据）' },
        name: { type: 'string', hint: '登记名（缺省用 candidate 标题或文件名）' },
      },
      run: (ctx) => archify.addDiagram(ctx),
      render: (r) => `${r.overwritten ? '已覆盖登记' : '已登记'}: ${r.id}（${r.name}，${r.type}）`,
    },
    {
      id: 'chart.archify.remove',
      cli: ['chart', 'archify', 'remove'],
      http: ['POST', '/api/chart/archify/remove'],
      summary: '移除登记并删除拷入 scope 的副本（.archify/ 原产物不受影响）',
      flags: { id: { type: 'string', required: true, hint: '图表 id（chart archify list 查看）' } },
      run: (ctx) => archify.removeDiagram({ id: ctx.id }),
      render: (r) => `已移除: ${r.id}（副本 ${r.removed}）`,
    },
    {
      id: 'chart.archify.view',
      cli: ['chart', 'archify', 'view'],
      http: ['GET', '/api/chart/archify/view/:id'],
      args: ['id'],
      streamResponse: true,
      summary: 'HTTP 直出已登记图表的 HTML（面板「图表」模式 iframe 数据源；面板端自动注入 iframe-host CSS 让画面全屏可滚，只留顶部 toolbar）；CLI 打印文件绝对路径',
      flags: { scope: { type: 'string', hint: 'scope 目录绝对路径（iframe 导航不带 scope 头，由前端显式透传）' } },
      run: async (ctx, meta) => {
        const { Transform } = await import('node:stream');
        const r = await archify.readDiagram({ id: ctx.id, scope: ctx.scope });
        if (!meta || meta.transport !== 'http') return r;
        // Iframe-host CSS overlay：archify 的 embed 模式主动锁 overflow（单图截图用），
        // present 模式也锁。面板场景要全屏可滚 + 只留顶部 toolbar——服务端在流中
        // </head> 前注入这段 CSS。HTML 内容与制品字节不动，只加一层覆盖样式。
        const HOST_CSS = '<style data-nxrp-iframe-host="true">' +
          'html,body{overflow:auto!important;height:auto!important;min-height:0!important;padding:0!important;margin:0!important}' +
          '.header,.subtitle,.cards,.diagram-nav,.overview-map,.focus-chip,.route-probe,.semantic-lens,.diagram-guide,.node-finder,.node-outline{display:none!important}' +
          '.container{max-width:none!important;padding:0!important;margin:0!important}' +
          '.toolbar{position:sticky;top:0;z-index:10}' +
          '.diagram-container{padding:0!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;width:100%!important;background:transparent!important}' +
          '.diagram-container>svg{max-width:100%!important;height:auto!important;width:auto!important;display:block;margin:0 auto}' +
          '</style>';
        let injected = false;
        const cssTransform = new Transform({
          transform(chunk, enc, cb) {
            const str = chunk.toString('utf8');
            if (!injected && str.includes('</head>')) {
              const idx = str.indexOf('</head>');
              cb(null, str.slice(0, idx) + HOST_CSS + str.slice(idx));
              injected = true;
            } else {
              cb(null, chunk);
            }
          },
        });
        return {
          status: 200,
          headers: { 'content-type': r.contentType, 'cache-control': 'no-store' },
          stream: createReadStream(r.abs).pipe(cssTransform),
        };
      },
      render: (r) => `${r.entry.name}（${r.bytes} 字节）\n${r.abs}\n（浏览器打开即看；面板「图表」模式会经 ?embed=1 嵌入）`,
    },
  ],
};
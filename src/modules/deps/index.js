// deps action 声明：源码依赖图。
//
// scan 是核心事实源（从源码 import 推导，只读）；save/load 是 DOT 文本的
// 导出与导入（graphviz 交接、外部 .dot 复用），不回写源码语义。
// 刻意不提供 workflow CRUD（无列表/命名/多实例管理）——图从源码推导，
// 编辑图 = 编辑代码。
import * as service from './service.js';
import { join } from 'node:path';
import { cwdDir } from '../../core/paths.js';

export default {
  id: 'deps',
  title: '依赖图',
  order: 40,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'deps.scan',
      cli: ['deps'],
      http: ['GET', '/api/deps'],
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
      id: 'deps.save',
      cli: ['deps', 'save'],
      http: ['POST', '/api/deps/save'],
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
      id: 'deps.load',
      cli: ['deps', 'load'],
      http: ['GET', '/api/deps/load'],
      summary: '读取 .dot 文本（绝对或 cwd 相对；上限 200K，二进制拒绝）——导入外部图',
      flags: { file: { type: 'string', required: true, hint: '.dot 文件路径' } },
      run: (ctx) => service.loadDot({ file: ctx.file }),
      render: (r) => `${r.file}（${r.chars} 字符）\n${r.dot}`,
    },
  ],
};

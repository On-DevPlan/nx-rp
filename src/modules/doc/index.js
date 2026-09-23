// doc 模块的 action 声明：CRUD + 知识实例文件化 + 召回引擎（zg 集成）。
//
// 一个域管完整数据流：登记（add/update）→ 实例化（export）→ 索引（zg index）
// → 召回（zg query）。zg 部分业务在 ./zg.js，CLI 命令保持 zg 前缀（与
// zg 官方命令词表一致，agent 零学习成本），action id 统一 doc.zg.*。
import * as service from './service.js';
import * as zg from './zg.js';

export default {
  id: 'doc',
  title: '文档与召回',
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
      summary: '新建一篇文档（name + body；--shared 进跨项目共享知识库）',
      flags: {
        name: { type: 'string', required: true, hint: '文档名' },
        body: { type: 'string', hint: '正文（CLI 用 --body=@file 读文件）' },
        tags: { type: 'array', hint: '逗号分隔的标签' },
        source: { type: 'string', hint: '来源（URL / 文件路径）' },
        shared: { type: 'boolean', hint: '共享知识（<docRoot>/shared/，所有项目可见）' },
      },
      run: (ctx) => service.addDoc({
        name: ctx.name, body: ctx.body || '',
        tags: ctx.tags || [], source: ctx.source || '',
        shared: !!ctx.shared,
      }),
      render: (d) => `已登记文档: ${d.name}${d.shared ? '（共享）' : ''}  (${d.id})`,
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
    {
      id: 'doc.export',
      cli: ['doc', 'export'],
      http: ['POST', '/api/docs/export'],
      summary: '知识实例文件化：当前 scope 的全部文档镜像到知识库目录（zg 可索引）',
      flags: { root: { type: 'string', hint: '目标工作目录（默认当前 cwd）' } },
      run: (ctx) => service.exportDocs({ root: ctx.root }),
      render: (r) =>
        `已同步到 ${r.kbDir}\n共 ${r.total} 篇（新增 ${r.added} / 更新 ${r.updated} / 移除 ${r.removed}）\n下一步: nx-rp zg index 建索引`,
    },
    {
      id: 'doc.root-get',
      cli: ['doc', 'root'],
      http: ['GET', '/api/docs/root'],
      summary: '查看全局知识库根目录（docRoot）',
      run: () => service.getDocRoot(),
      render: (r) => `${r.docRoot}${r.isDefault ? '（默认值）' : '（已自定义）'}`,
    },
    {
      id: 'doc.root-set',
      cli: ['doc', 'root', '--set'],
      http: ['POST', '/api/docs/root'],
      summary: '改全局知识库根目录（旧知识库全量复制迁移 + 清旧痕迹）',
      flags: { newRoot: { type: 'string', required: true, hint: '新的根目录绝对路径' } },
      run: (ctx) => service.setDocRoot(ctx.newRoot),
      render: (r) => {
        const m = r.migration;
        const line = m.skipped ? '（目录未变化）' : `已迁移 ${m.copied} 个知识库: ${m.from} → ${m.to}`;
        return `docRoot: ${r.docRoot}\n${line}\n注意：迁移后各 workspace 需 nx-rp zg index --rebuild 重建索引`;
      },
    },

    // ─── 召回引擎（zg 集成）：CLI 保持 zg 前缀，action id 归 doc 域 ─────
    {
      id: 'doc.zg.install',
      cli: ['zg', 'install'],
      http: ['GET', '/api/zg/install'],
      summary: '检测 zg 可用性与当前工作区知识库状态（不安装 MCP）',
      flags: { root: { type: 'string', hint: '目标工作目录（默认当前 cwd）' } },
      run: (ctx) => zg.install({ root: ctx.root }),
      render: (r) =>
        (r.zgInstalled ? `zg 已安装: ${r.version}` : 'zg 未安装（npm install -g @zvec/zvec-grep）') + '\n' +
        `知识库目录: ${r.kbDir}${r.indexed ? '（已有索引）' : '（未索引）'}\n` +
        `embedding: ${r.embedding}\n` +
        `key: ${r.keyConfigured ? '已配置 workspace 授权' : '未配置——nx-rp zg auth'}\n` +
        `下一步:\n${r.nextSteps.map((s) => `  - ${s}`).join('\n')}\n` +
        `MCP: ${r.mcpNote}`,
    },
    {
      id: 'doc.zg.auth',
      cli: ['zg', 'auth'],
      http: ['POST', '/api/zg/auth'],
      summary: '配置远程 embedding key 与模型（无 --key 时返回引导信息与可选模型）',
      flags: {
        key: { type: 'string', hint: 'API key（sk- 开头；不传则只给引导）' },
        model: { type: 'string', hint: '远程模型（可选 qwen3.7-text-embedding / text-embedding-v4 / qwen3-vl-embedding）' },
        noBrowser: { type: 'boolean', hint: '不提示打开引导页' },
      },
      run: (ctx) => zg.auth({ key: ctx.key, model: ctx.model, browser: !ctx.noBrowser }),
      render: (r) => {
        if (r.needKey) {
          const models = (r.modelOptions || []).map((m) => `  ${m.id}  (${m.note})`).join('\n');
          return `请在引导页生成 API key：${r.guideUrl}\n然后：nx-rp zg auth --key <key> [--model <模型>]\n可选模型:\n${models}\n${r.hint}`;
        }
        return r.ok
          ? `已配置（provider + 默认模型 ${r.model} + workspace 授权）\n知识库: ${r.kbDir}`
          : `配置失败（${r.step}）: ${r.stderr}`;
      },
    },
    {
      id: 'doc.zg.onboard',
      cli: ['zg', 'onboard'],
      http: ['POST', '/api/zg/onboard'],
      summary: '新用户引导：装 zg → 拿 key → 选模型 → 用起来（一条命令按步引导）',
      flags: {
        key: { type: 'string', hint: 'API key（第一次没有就先不带，看引导）' },
        model: { type: 'string', hint: '远程模型（默认 qwen/qwen3.7-text-embedding）' },
      },
      run: (ctx) => zg.onboard({ key: ctx.key, model: ctx.model }),
      render: (r) => r.message,
    },
    {
      id: 'doc.zg.index',
      cli: ['zg', 'index'],
      http: ['POST', '/api/zg/index'],
      summary: '为当前工作区知识库建/增索引（direct 模式；--model 需搭配 --rebuild）',
      flags: {
        root: { type: 'string', hint: '目标工作目录（默认当前 cwd）' },
        rebuild: { type: 'boolean', hint: '全量重建（换模型时必须）' },
        model: { type: 'string', hint: '仅 --rebuild 时有效：换用的远程模型' },
      },
      run: (ctx) => zg.index({ root: ctx.root, forceRebuild: !!ctx.rebuild, model: ctx.model }),
      render: (r) => (r.ok ? `索引完成: ${r.kbDir}\n${r.summary}` : `索引失败: ${r.kbDir}\n${r.stderr}`),
    },
    {
      id: 'doc.zg.query',
      cli: ['zg', 'query'],
      http: ['POST', '/api/zg/query'],
      summary: '语义召回（本项目 KB + shared 共享库并查；结果带来源头块）',
      flags: {
        q: { type: 'string', required: true, hint: '查询文本' },
        root: { type: 'string', hint: '目标工作目录（默认当前 cwd）' },
        limit: { type: 'number', hint: '条数（默认 5）' },
        noShared: { type: 'boolean', hint: '不查共享库' },
      },
      run: (ctx) => zg.query({ q: ctx.q, root: ctx.root, limit: ctx.limit, shared: !ctx.noShared }),
      render: (r) => {
        if (r.needIndex) return `知识库未索引: ${r.kbDir}\n${r.hint}`;
        return r.ok ? r.results : `召回失败: ${r.stderr}`;
      },
    },
    {
      id: 'doc.zg.status',
      cli: ['zg', 'status'],
      http: ['GET', '/api/zg/status'],
      summary: '看当前工作区知识库的索引状态',
      flags: { root: { type: 'string', hint: '目标工作目录（默认当前 cwd）' } },
      run: (ctx) => zg.status({ root: ctx.root }),
      render: (r) => (r.indexed ? `${r.kbDir}\n${r.summary}` : `${r.kbDir}\n（未索引）`),
    },
    {
      id: 'doc.zg.migrate',
      cli: ['zg', 'migrate'],
      http: ['POST', '/api/zg/migrate'],
      summary: 'docRoot 变更迁移：旧 KB 全量复制到新根 + 清旧痕迹',
      flags: {
        newRoot: { type: 'string', required: true, hint: '新的 doc 根目录' },
      },
      run: (ctx) => zg.migrateDocRoot({ newRoot: ctx.newRoot }),
      render: (r) =>
        r.skipped ? `docRoot 未变: ${r.docRoot}`
          : `已迁移 ${r.copied} 个知识库: ${r.from} → ${r.to}\n注意：复制后索引内绝对路径失效，各 workspace 跑 nx-rp zg index --rebuild`,
    },
  ],
};
// hook-prompt action 声明：capture（hook 落点）/ on / off / status / log。
//
// capture 的 run 永不抛错——hook 协议里非零退出码会在 transcript 留错误记录，
// 日志类 hook 的存在感必须是零。on/off/status/log 是普通命令，错误正常上抛。
//
// capture 是 cli-only 的 action：它的入参形态是 hook 协议的 stdin 事件 JSON，
// 面板没有对应交互。其余四条都 http 可达——面板与 CLI 走同一份逻辑。
import * as service from './service.js';

// --limit 归一化：非正数/NaN → 50（「没给有效条数」的默认），合法值封顶 1000。
// 负数走默认而不是钳到 1——原样透传负数会让 slice 丢掉最新/最早的一批记录。
function normalizeLimit(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}

export default {
  id: 'hook-prompt',
  title: '提示词日志',
  order: 50,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'hook-prompt.capture',
      cli: ['hook', 'capture'],
      http: null,
      summary: 'UserPromptSubmit 落点：stdin 收事件 JSON → 追加记录（永不报错）',
      run: async () => {
        try {
          return await service.captureFromStdin();
        } catch {
          return { ok: false }; // 兜底：任何异常都不许影响会话
        }
      },
    },
    {
      id: 'hook-prompt.on',
      cli: ['hook', 'on'],
      http: ['POST', '/api/hook-prompt/on'],
      summary: '往 ~/.claude/settings.json 写 UserPromptSubmit hook（幂等；--dry-run 只预览）',
      flags: { dryRun: { type: 'boolean', hint: '只预览，不写盘' } },
      run: (ctx) => service.hookOn({ dryRun: !!ctx.dryRun }),
      render: (r) => {
        if (r.dryRun) return `[dry-run] 将写入: ${r.settingsPath}`;
        const snap = r.snapshot ? `\n快照: ${r.snapshot}` : '';
        return (r.skipped ? `已启用（无需改动）: ${r.settingsPath}` : `已启用: ${r.settingsPath}`) + snap;
      },
    },
    {
      id: 'hook-prompt.off',
      cli: ['hook', 'off'],
      http: ['POST', '/api/hook-prompt/off'],
      summary: '从 ~/.claude/settings.json 摘掉提示词日志 hook（其余 hooks 不动；--dry-run 只预览）',
      flags: { dryRun: { type: 'boolean', hint: '只预览，不写盘' } },
      run: (ctx) => service.hookOff({ dryRun: !!ctx.dryRun }),
      render: (r) => {
        if (r.dryRun) return `[dry-run] 将从 ${r.settingsPath} 摘除本 hook`;
        const snap = r.snapshot ? `\n快照: ${r.snapshot}` : '';
        return (r.skipped ? `本就未启用: ${r.settingsPath}` : `已停用: ${r.settingsPath}`) + snap;
      },
    },
    {
      id: 'hook-prompt.status',
      cli: ['hook', 'status'],
      http: ['GET', '/api/hook-prompt/status'],
      summary: '看提示词日志 hook 的开关状态与日志目录',
      run: () => service.hookStatus(),
      render: (r) =>
        `hook: ${r.enabled ? '已启用' : '未启用'}${r.disableAllHooks ? '（注意: disableAllHooks=true，全被关掉）' : ''}\n` +
        `settings: ${r.settingsPath}\n` +
        `日志目录: ${r.logDir}`,
    },
    {
      id: 'hook-prompt.log',
      cli: ['hook', 'log'],
      http: ['GET', '/api/hook-prompt/log'],
      summary: '查提示词记录（默认当前目录，--all 跨全部目录，--cwd 精确选一条目录，--groups 仅看分组）',
      // 读命令的 flag 一律不带 default——「不传」本身是有意义的输入（默认当前 cwd）
      flags: {
        all: { type: 'boolean', hint: '跨全部目录（与 --cwd 互斥，同时给则 --cwd 生效）' },
        limit: { type: 'number', hint: '条数（默认 50）' },
        cwd: { type: 'string', hint: '精确选一条目录（接受任意形态，内部按归一化路径匹配）' },
        groups: { type: 'boolean', hint: '仅显示 cwd 分组聚合，不列记录' },
      },
      run: (ctx) => service.listPrompts({
        all: !!ctx.all,
        limit: normalizeLimit(ctx.limit),
        cwd: ctx.cwd || null,
        shape: ctx.groups ? 'with-groups' : 'records',
      }),
      render: (result, ctx) => {
        // shape=with-groups：{records, groups}
        if (ctx.groups) {
          const groups = Array.isArray(result) ? [] : (result.groups || []);
          if (!groups.length) return '（无 cwd 分组数据）';
          // 展示用 display（该目录最新一条记录的原始形态），选中时把 display 原样回传即可
          return groups.map((g) => `  ${g.display}  —  ${g.count} 条  (最近 ${(g.latestTs || '').replace('T', ' ').slice(0, 19)})`).join('\n');
        }
        // 默认形态：records 数组
        const list = Array.isArray(result) ? result : (result.records || []);
        if (!list.length) return '（暂无记录——在启用 hook 的会话里发一条提示词后再来）';
        // sessionId 独立成行给完整恢复命令——不和提示词混在一行，整行可直接复制执行
        return list
          .map((r) => {
            const base = `[${(r.ts || '').replace('T', ' ').slice(0, 19)}] ${String(r.prompt).replace(/\s+/g, ' ').slice(0, 120)}`;
            return r.sessionId ? `${base}\n    ↳ claude --resume ${r.sessionId}` : base;
          })
          .join('\n');
      },
    },
  ],
};

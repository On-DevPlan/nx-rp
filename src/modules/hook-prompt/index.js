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
      summary: '查提示词记录（默认当前目录，--all 跨全部目录，--cwd 精确选一条目录，--groups 仅看分组，--system 含系统注入）',
      // 读命令的 flag 一律不带 default——「不传」本身是有意义的输入（默认当前 cwd）
      flags: {
        all: { type: 'boolean', hint: '跨全部目录（与 --cwd 互斥，同时给则 --cwd 生效）' },
        limit: { type: 'number', hint: '条数（默认 50）' },
        cwd: { type: 'string', hint: '精确选一条目录（接受任意形态，内部按归一化路径匹配）' },
        groups: { type: 'boolean', hint: '仅显示 cwd 分组聚合，不列记录' },
        system: { type: 'boolean', hint: '连系统注入的记录一起显示（<task-notification> 等，默认不显示）' },
      },
      run: (ctx) => service.listPrompts({
        all: !!ctx.all,
        limit: normalizeLimit(ctx.limit),
        cwd: ctx.cwd || null,
        // 统一返回 with-groups 形状：CLI 与面板同源，面板本来就在用这个形状。
        // 附带 systemCount（范围内系统注入总条数）与 filtered（本次被剔除的条数），
        // 面板据此显示「已隐藏 N 条」并给出清理入口。
        shape: 'with-groups',
        includeSystem: !!ctx.system,
      }),
      render: (result, ctx) => {
        const list = Array.isArray(result) ? result : (result.records || []);
        const systemCount = Array.isArray(result) ? 0 : (result.systemCount || 0);
        // shape=with-groups：{records, groups, systemCount, filtered}
        if (ctx.groups) {
          const groups = Array.isArray(result) ? [] : (result.groups || []);
          if (!groups.length) return '（无 cwd 分组数据）';
          // 展示用 display（该目录最新一条记录的原始形态），选中时把 display 原样回传即可
          return groups.map((g) => `  ${g.display}  —  ${g.count} 条  (最近 ${(g.latestTs || '').replace('T', ' ').slice(0, 19)})`).join('\n');
        }
        // 默认形态：records 数组
        if (!list.length) {
          return systemCount
            ? `（该范围没有真实提示词——只有 ${systemCount} 条系统注入记录；--system 可看，hook clean 可清理）`
            : '（暂无记录——在启用 hook 的会话里发一条提示词后再来）';
        }
        // sessionId 独立成行给完整恢复命令——不和提示词混在一行，整行可直接复制执行
        const body = list
          .map((r) => {
            const base = `[${(r.ts || '').replace('T', ' ').slice(0, 19)}] ${String(r.prompt).replace(/\s+/g, ' ').slice(0, 120)}`;
            return r.sessionId ? `${base}\n    ↳ claude --resume ${r.sessionId}` : base;
          })
          .join('\n');
        const note = systemCount
          ? `\n（范围内另有 ${systemCount} 条系统注入记录：--system 一并显示，hook clean 物理清理）`
          : '';
        return body + note;
      },
    },
    {
      id: 'hook-prompt.clean',
      cli: ['hook', 'clean'],
      http: ['POST', '/api/hook-prompt/clean'],
      summary: '从提示词日志里物理剔除系统注入的记录（<task-notification> 等；写前留快照）',
      flags: {
        all: { type: 'boolean', hint: '清理全部目录（默认只清理当前目录）' },
        cwd: { type: 'string', hint: '精确选一条目录清理（接受任意形态，内部按归一化路径匹配）' },
        dryRun: { type: 'boolean', hint: '只统计要删多少条，不写盘' },
      },
      run: (ctx) => service.cleanSystemRecords({
        all: !!ctx.all,
        cwd: ctx.cwd || null,
        dryRun: !!ctx.dryRun,
      }),
      render: (r) => {
        const scope = r.files ? `${r.files} 个文件` : '0 个文件';
        if (r.dryRun) return `[dry-run] 将从 ${scope} 里剔除 ${r.removed} 条系统注入记录（未写盘）`;
        if (!r.removed) return '没有可清理的系统注入记录';
        const snaps = (r.snapshots || []).join('\n  ');
        return `已清理 ${r.removed} 条系统注入记录（${scope}）\n快照: ${snaps || '（无）'}`;
      },
    },
  ],
};

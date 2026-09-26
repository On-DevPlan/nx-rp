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
      summary: '查提示词记录（默认当前 cwd，--all 跨目录，--limit N 条）',
      // 读命令的 flag 一律不带 default——「不传」本身是有意义的输入（默认当前 cwd）
      flags: {
        all: { type: 'boolean', hint: '跨全部目录' },
        limit: { type: 'number', hint: '条数（默认 50）' },
      },
      run: (ctx) => service.listPrompts({ all: !!ctx.all, limit: normalizeLimit(ctx.limit) }),
      render: (list) => {
        if (!list.length) return '（暂无记录——在启用 hook 的会话里发一条提示词后再来）';
        // 行尾带完整 sessionId——可直接复制给 claude --resume 回到那个会话
        return list
          .map((r) => {
            const sid = r.sessionId ? `  ·  ${r.sessionId}` : '';
            return `[${(r.ts || '').replace('T', ' ').slice(0, 19)}] ${String(r.prompt).replace(/\s+/g, ' ').slice(0, 100)}${sid}`;
          })
          .join('\n');
      },
    },
  ],
};

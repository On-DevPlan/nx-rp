// hook-skill action 声明：skill-track（hook 落点）/ on / off / status / skills。
//
// skill-track 的 run 永不抛错——hook 协议里非零退出码会在 transcript 留错误记录，
// 日志类 hook 的存在感必须是零。其余是普通命令，错误正常上抛。
//
// skill-track 是 cli-only 的 action：入参形态是 hook 协议的 stdin 事件 JSON，
// 面板没有对应交互。其余四条都 http 可达——面板与 CLI 走同一份逻辑。
import * as service from './service.js';

// --limit 归一化：非正数/NaN → 50（「没给有效条数」的默认），合法值封顶 1000。
function normalizeLimit(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}

export default {
  id: 'hook-skill',
  title: 'Skill 追踪',
  order: 51,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'hook-skill.track',
      cli: ['hook', 'skill-track'],
      http: null,
      summary: 'PostToolUse(Skill) 落点：stdin 收事件 JSON → 记 Skill 调用（永不报错）',
      run: async () => {
        try {
          return await service.skillTrackFromStdin();
        } catch {
          return { ok: false };
        }
      },
    },
    {
      id: 'hook-skill.on',
      cli: ['hook', 'skill-on'],
      http: ['POST', '/api/hook-skill/on'],
      summary: '往 ~/.claude/settings.json 写 PostToolUse(Skill) hook（幂等；--dry-run 只预览）',
      flags: { dryRun: { type: 'boolean', hint: '只预览，不写盘' } },
      run: (ctx) => service.hookOn({ dryRun: !!ctx.dryRun }),
      render: (r) => {
        if (r.dryRun) return `[dry-run] 将写入: ${r.settingsPath}`;
        const snap = r.snapshot ? `\n快照: ${r.snapshot}` : '';
        return (r.skipped ? `已启用（无需改动）: ${r.settingsPath}` : `已启用: ${r.settingsPath}`) + snap;
      },
    },
    {
      id: 'hook-skill.off',
      cli: ['hook', 'skill-off'],
      http: ['POST', '/api/hook-skill/off'],
      summary: '从 ~/.claude/settings.json 摘掉 Skill 追踪 hook（其余 hooks 不动；--dry-run 只预览）',
      flags: { dryRun: { type: 'boolean', hint: '只预览，不写盘' } },
      run: (ctx) => service.hookOff({ dryRun: !!ctx.dryRun }),
      render: (r) => {
        if (r.dryRun) return `[dry-run] 将从 ${r.settingsPath} 摘除本 hook`;
        const snap = r.snapshot ? `\n快照: ${r.snapshot}` : '';
        return (r.skipped ? `本就未启用: ${r.settingsPath}` : `已停用: ${r.settingsPath}`) + snap;
      },
    },
    {
      id: 'hook-skill.status',
      cli: ['hook', 'skill-status'],
      http: ['GET', '/api/hook-skill/status'],
      summary: '看 Skill 追踪 hook 的开关状态与统计目录',
      run: () => service.hookStatus(),
      render: (r) =>
        `hook: ${r.enabled ? '已启用' : '未启用'}${r.disableAllHooks ? '（注意: disableAllHooks=true，全被关掉）' : ''}\n` +
        `settings: ${r.settingsPath}\n` +
        `skill 统计目录: ${r.skillsDir}`,
    },
    {
      id: 'hook-skill.stats',
      cli: ['hook', 'skills'],
      http: ['GET', '/api/hook-skill/skills'],
      summary: 'Skill 使用统计与健康分（默认当前 cwd，--all 跨目录）',
      flags: {
        all: { type: 'boolean', hint: '跨全部目录' },
        limit: { type: 'number', hint: '条数（默认 50）' },
      },
      run: (ctx) => service.skillStats({ all: !!ctx.all, limit: normalizeLimit(ctx.limit) }),
      render: (list) => {
        if (!list.length) return '（暂无 Skill 记录——启用 hook 后在会话里触发一个 skill 再来）';
        return list
          .map((r) => `${r.stars} ${String(r.score).padStart(3)}  ${String(r.count).padStart(4)} 次  最近 ${(r.lastUsed || '').replace('T', ' ').slice(0, 19)}  ${r.skill}`)
          .join('\n');
      },
    },
  ],
};

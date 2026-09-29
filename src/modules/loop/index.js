// loop action 声明：自引用循环（Ralph 技术）的 Stop hook 落点 + 开关 + 查询。
//
// stop 的 run 永不抛错——hook 协议里非零退出码会在 transcript 留错误记录，
// 而且 Stop 钩子失败会直接卡住用户的会话。与 hook-prompt.capture 同款双层兜底。
//
// ★ stop 刻意**不声明 render**：runtime/cli.js 的 renderCli 优先用 action.render，
//   一旦这里有了 render，钩子拿到的就是人类可读文本而不是判决 JSON，循环静默失效。
//   `--json` 全局 flag 也绝不能出现在 hook entry 的 command 里。
//
// stop 是 cli-only（http: null）：它的入参形态是 hook 协议的 stdin 事件 JSON，
// 面板没有对应交互。其余都 http 可达——面板与 CLI 走同一份逻辑。
import * as service from './service.js';

// --limit 归一化：非正数/NaN → 50，合法值封顶 1000（与 hook-prompt 同规则）
function normalizeLimit(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}

// 会话归属的**单一判定**：两个字段都是「这个会话」的等价标识，取先有值的那个。
//   sessionId       —— 用户显式 --session-id 传的
//   claudeSessionId —— 启动时从 CLAUDE_CODE_SESSION_ID 捕获的
// 只认 sessionId 会把「靠 env 绑定好」的循环误报成匿名——这条此前在 CLI 与面板
// 两处渲染里各犯过一次（是新模块的显示 bug，已统一到此函数）。
function sessionLabel(loop) {
  const sid = loop?.sessionId || loop?.claudeSessionId;
  if (!sid) return '（无会话——旧数据遗留，Stop hook 不会触发它）';
  return sid + (loop.sessionId ? '' : '（env 捕获）');
}

// 布防后的会话提示：这里最容易踩坑——loop 绑定的是**启动它的那个进程**的会话，
// 不是「你现在正在看的会话」。说清楚，并给出改绑的命令。
function sessionHint(loop) {
  const bound = loop?.sessionId || loop?.claudeSessionId;
  const lines = [`会话: ${sessionLabel(loop)}`];
  if (!bound) {
    lines.push('  ⚠️ 这条循环没有任何会话身份，Stop hook 认领不到它（不会触发）。');
    lines.push(`     改绑：nx-rp loop update --id ${loop.id} --session-id <你的会话ID>`);
  } else if (loop.sessionId === null && loop.claudeSessionId) {
    lines.push('  绑定来源：启动时从 CLAUDE_CODE_SESSION_ID 捕获（不是显式 --session-id）。');
    lines.push('  若它不是你想要的会话，改绑：nx-rp loop update --id ' + loop.id + ' --session-id <会话ID>');
  }
  return lines.join('\n');
}

export default {
  id: 'loop',
  title: '循环',
  order: 52,
  view: () => import('./view.jsx'),

  actions: [
    {
      id: 'loop.stop',
      cli: ['loop', 'stop'],
      http: null,
      summary: 'Stop hook 落点：stdin 收事件 JSON → stdout 出判决 JSON（永不报错；无 render）',
      run: async () => {
        try {
          return await service.stopHookFromStdin();
        } catch {
          return {}; // 兜底：任何异常都降级为「无判决 = 放行」
        }
      },
    },
    {
      id: 'loop.start',
      cli: ['loop', 'start'],
      http: ['POST', '/api/loop/start'],
      summary: '布防一个循环：把 prompt 写进状态，Stop hook 会反复灌回它直到完成',
      args: [{ name: 'prompt', required: true }],
      flags: {
        maxIterations: { type: 'number', hint: '轮次上限（默认 20；0 或负数 = 无限）' },
        completionPromise: { type: 'string', hint: '完成短语——出现 <promise>该短语</promise> 即结束' },
        sessionId: { type: 'string', hint: '会话 ID（缺省读 CLAUDE_CODE_SESSION_ID 环境变量）' },
        cwd: { type: 'string', hint: '作用目录（默认当前 cwd）' },
      },
      run: (ctx) => service.startLoop({
        prompt: ctx.prompt,
        // 原样透传：undefined → service 默认 20；显式 0 → 无限（不能被抬成 20）
        maxIterations: ctx.maxIterations,
        completionPromise: ctx.completionPromise || null,
        sessionId: ctx.sessionId || null,
        cwd: ctx.cwd || undefined,
      }),
      render: (r) => {
        const l = r.loop;
        const max = l.maxIterations > 0 ? l.maxIterations : '∞（无限——建议设 --max-iterations 兜底）';
        const promise = l.completionPromise
          ? `<promise>${l.completionPromise}</promise>（仅当陈述确实为真时才输出）`
          : '（未设——循环只能靠轮次上限收口）';
        return `🔄 循环已布防: ${l.id}\n` +
          `轮次上限: ${max}\n` +
          `完成短语: ${promise}\n` +
          `${sessionHint(l)}\n` +
          `状态: ${r.file}\n\n` +
          `Stop hook 会在你每次想结束回合时，把同一条 prompt 原样灌回来。\n` +
          `先跑 nx-rp loop on 确保 hook 已启用。`;
      },
    },
    {
      id: 'loop.on',
      cli: ['loop', 'on'],
      http: ['POST', '/api/loop/on'],
      summary: '在当前项目启用 Stop hook（默认写 .claude/settings.local.json，不污染仓库）',
      flags: {
        scope: { type: 'string', enum: ['local', 'shared'], hint: 'local=本地级（默认，个人）| shared=项目级（入库，团队共享）' },
        dryRun: { type: 'boolean', hint: '只预览，不写盘' },
      },
      run: (ctx) => service.hookOn({ scope: ctx.scope || 'local', dryRun: !!ctx.dryRun }),
      render: (r) => {
        if (r.dryRun) return `[dry-run] 将写入: ${r.settingsPath}`;
        const snap = r.snapshot ? `\n快照: ${r.snapshot}` : '';
        const gi = r.gitignore?.added ? `\n已追加 .gitignore 忽略规则: ${r.gitignore.path}` : '';
        const scopeNote = r.scope === 'shared'
          ? '\n注意: 写的是项目级 settings.json（通常入库）——确保团队每人都装了 nx-rp'
          : '';
        return (r.skipped ? `已启用（无需改动）: ${r.settingsPath}` : `已启用: ${r.settingsPath}`) + snap + gi + scopeNote;
      },
    },
    {
      id: 'loop.off',
      cli: ['loop', 'off'],
      http: ['POST', '/api/loop/off'],
      summary: '在当前项目停用 Stop hook（本地级+项目级都摘；其余 hooks 一律不动）',
      flags: { dryRun: { type: 'boolean', hint: '只预览，不写盘' } },
      run: (ctx) => service.hookOff({ dryRun: !!ctx.dryRun }),
      render: (r) => {
        if (r.dryRun) return `[dry-run] 将从 ${(r.removedFrom || []).join(' 与 ')} 摘除本 hook`;
        const snap = r.snapshot ? `\n快照: ${r.snapshot}` : '';
        return (r.skipped ? '本就未启用' : `已停用（从 ${(r.removedFrom || []).length} 个文件摘除）`) + snap;
      },
    },
    {
      id: 'loop.status',
      cli: ['loop', 'status'],
      http: ['GET', '/api/loop/status'],
      summary: '看 Stop hook 开关状态与当前目录的循环列表',
      run: () => service.hookStatus().then(async (st) => ({
        ...st,
        loops: await service.listLoops({ limit: 20 }),
      })),
      render: (r) => {
        const mark = (b) => (b ? '✓' : '✗');
        const lines = [
          `hook: ${r.enabled ? '已启用' : '未启用'}${r.activeScope ? `（${r.activeScope === 'shared' ? '项目级' : '本地级'}）` : ''}${r.disableAllHooks ? ' · 注意: disableAllHooks=true，全被关掉' : ''}`,
          `  本地级[${mark(r.detail.local.enabled)}] ${r.detail.local.path}`,
          `  项目级[${mark(r.detail.shared.enabled)}] ${r.detail.shared.path}`,
        ];
        if (r.loops?.length) {
          lines.push('', `循环（${r.loops.length}）:`);
          for (const l of r.loops) {
            const max = l.maxIterations > 0 ? l.maxIterations : '∞';
            // 会话短码：与面板 SessionTag 同口径（两字段取先有值者）。
            // 多会话并行时靠它一眼看出这条循环归谁——只说「无会话」而不显示，
            // 等于把「布防了却不会被触发」的原因藏起来。
            const sid = l.sessionId || l.claudeSessionId;
            const who = sid ? `  [${String(sid).slice(0, 8)}${l.sessionId ? '' : '*'}]` : '  [无会话]';
            lines.push(`  ${l.active === false ? '○' : '●'} ${l.id}  ${l.iteration}/${max}${who}  ${l.completionPromise ? `<promise>${l.completionPromise}</promise>` : '（无承诺）'}  ${String(l.prompt).replace(/\s+/g, ' ').slice(0, 50)}`);
          }
        } else {
          lines.push('', '循环: （无——用 nx-rp loop start "任务" 布防一个）');
        }
        return lines.join('\n');
      },
    },
    {
      id: 'loop.cancel',
      cli: ['loop', 'cancel'],
      http: ['POST', '/api/loop/cancel'],
      summary: '取消循环（不传 id 则取消当前目录全部活跃循环；保留记录可查）',
      flags: { id: { type: 'string', hint: '循环 id（如 loop-1）；缺省取消全部' } },
      run: (ctx) => service.cancelLoop({ id: ctx.id || null }),
      render: (r) => (r.cancelled > 0 ? `已取消 ${r.cancelled} 个循环` : '没有活跃的循环'),
    },
    {
      id: 'loop.update',
      cli: ['loop', 'update'],
      http: ['POST', '/api/loop/update'],
      summary: '改一条循环的任务参数（prompt / 轮次上限 / 完成承诺 / 会话）；因到上限而停的会随上限提高自动复活',
      flags: {
        id: { type: 'string', required: true, hint: '循环 id（如 loop-1）' },
        prompt: { type: 'string', hint: '新的任务描述（缺省不改）' },
        maxIterations: { type: 'number', hint: '新的轮次上限（0 = 无限；提高可复活已到上限的循环）' },
        completionPromise: { type: 'string', hint: '新的完成短语（传空串 = 清掉承诺）' },
        sessionId: { type: 'string', hint: '改绑会话（传空串 = 清掉显式绑定）' },
      },
      run: (ctx) => service.updateLoop({
        id: ctx.id,
        prompt: ctx.prompt,
        maxIterations: ctx.maxIterations,
        // 没传这个 flag 时保持原值；传了空串则清掉（undefined 与 '' 语义不同）
        completionPromise: ctx.completionPromise,
        sessionId: ctx.sessionId,
      }),
      render: (r) => {
        if (r.skipped) return `无改动: ${r.id}`;
        const l = r.loop;
        const max = l.maxIterations > 0 ? l.maxIterations : '∞';
        return `已更新 ${r.id}: ${r.changed.join(' / ')}${r.reactivated ? '（已重新激活）' : ''}\n` +
          `  轮次: ${l.iteration}/${max} · 承诺: ${l.completionPromise ? `<promise>${l.completionPromise}</promise>` : '（无）'}`;
      },
    },
    {
      id: 'loop.remove',
      cli: ['loop', 'remove'],
      http: ['POST', '/api/loop/remove'],
      summary: '删除一条循环记录（默认只允许删已结束的；--force 可删活跃的）',
      flags: {
        id: { type: 'string', required: true, hint: '循环 id' },
        force: { type: 'boolean', hint: '允许删除仍在运行的循环' },
      },
      run: (ctx) => service.removeLoop({ id: ctx.id, force: !!ctx.force }),
      render: (r) => (r.removed ? `已删除 ${r.id}` : '没有可删除的循环'),
    },
    {
      id: 'loop.log',
      cli: ['loop', 'log'],
      http: ['GET', '/api/loop/log'],
      summary: '查循环审计日志（每轮判定：继续/命中/超限；--all 跨目录）',
      flags: {
        all: { type: 'boolean', hint: '跨全部目录' },
        limit: { type: 'number', hint: '条数（默认 50）' },
      },
      run: (ctx) => service.listLoopLog({ all: !!ctx.all, limit: normalizeLimit(ctx.limit) }),
      render: (list) => {
        if (!list.length) return '（暂无记录——启用 hook 并跑起一个循环后再来）';
        const DECISION = { continue: '继续', 'promise-hit': '✅命中', 'max-iterations': '🛑超限' };
        return list
          .map((r) => {
            const t = (r.ts || '').replace('T', ' ').slice(0, 19);
            const d = DECISION[r.decision] || r.decision;
            const extra = r.decision === 'continue'
              ? `promise=${r.promise ?? '—'} 文本=${r.lastTextChars ?? '?'}字`
              : '';
            return `[${t}] ${r.loopId || '—'} 第${r.iteration}轮 ${d} ${extra}`;
          })
          .join('\n');
      },
    },
  ],
};

// 循环面板：开关状态卡 + 活动循环卡 + 布防表单 + 审计日志卡。
//
// 与 hook-prompt / hook-skill 同构：数据从 /api 拉，操作走同一条 action，
// 底部 CLI 提示由命令表派生（CliHints）。
//
// 与另两个 hook 模块的**本质差异**：开关写的是**项目级**配置
// （.claude/settings.local.json），不是全局 ~/.claude/settings.json——
// 只有配了 hook 的项目才会被拦截退出，语义与 ralph-loop 一致。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import ManualAddCard from '../../web/frontend/components/ManualAddCard.jsx';

const LIMIT = 200;

// 判定与结束原因的中文标签（面板展示用）
const DECISION = { continue: '继续', 'promise-hit': '✅ 命中', 'max-iterations': '🛑 超限' };
const END_REASON = { promise: '已完成', 'max-iterations': '到上限', cancelled: '已取消' };

function fmt(ts) {
  return String(ts || '').replace('T', ' ').slice(0, 19);
}

export default function LoopView() {
  const { boot } = useStore();
  const [status, setStatus] = useState(null);
  const [loops, setLoops] = useState(null);
  const [logs, setLogs] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // 布防表单
  const [prompt, setPrompt] = useState('');
  const [maxIter, setMaxIter] = useState('20');
  const [promise, setPromise] = useState('COMPLETE');
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const st = await api('/api/loop/status');
      setStatus(st);
      setLoops(st.loops || []);
      setLogs(await api('/api/loop/log?limit=' + LIMIT));
    } catch (e) {
      // 失败要如实呈现——不能让「请求失败」伪装成「暂无数据」
      setLoadError(e.message || '加载失败');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const enable = () =>
    guard(async () => {
      const r = await api('/api/loop/on', { method: 'POST', body: { scope: 'local' } });
      if (r.gitignore?.added) toast('已启用，并追加了 .gitignore 忽略规则');
      else toast(r.skipped ? '已启用（无需改动）' : '已启用');
      await refresh();
    });

  const disableHook = () =>
    guard(async () => {
      const ok = await dialog({
        title: '停用循环 hook？',
        message: '会从本项目的 .claude/settings*.json 摘掉循环那条 Stop hook（写前自动留快照；提示词日志、Skill 追踪等其他 hooks 不动）。已布防的循环记录保留。',
        danger: true,
        okText: '停用',
      });
      if (!ok) return;
      await api('/api/loop/off', { method: 'POST', body: {} });
      toast('已停用');
      await refresh();
    });

  const start = () =>
    guard(async () => {
      if (!prompt.trim()) { toast('先填任务描述'); return; }
      const max = Number(maxIter);
      const r = await api('/api/loop/start', {
        method: 'POST',
        body: {
          prompt,
          maxIterations: Number.isFinite(max) ? max : 20,
          completionPromise: promise.trim() || undefined,
        },
      });
      toast(`已布防 ${r.id}`);
      setPrompt('');
      await refresh();
    });

  const cancel = (id) =>
    guard(async () => {
      const ok = await dialog({
        title: `取消循环 ${id || '（全部）'}？`,
        message: '标记为已结束，Stop hook 不再灌回提示词。记录保留可查。',
        danger: true,
        okText: '取消循环',
      });
      if (!ok) return;
      const r = await api('/api/loop/cancel', { method: 'POST', body: id ? { id } : {} });
      toast(r.cancelled > 0 ? `已取消 ${r.cancelled} 个` : '没有活跃的循环');
      await refresh();
    });

  const activeCount = (loops || []).filter((l) => l.active !== false).length;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <span className="muted">scope: <code>{boot?.cwdScope || ''}</code></span>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          循环机制：Stop hook 拦截会话退出，把同一条提示词灌回去，直到出现完成短语
        </span>
      </div>

      {loadError && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tag bad">加载失败</span>
            <span className="muted">{loadError}</span>
            <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={refresh}>重试</button>
          </div>
        </div>
      )}

      {/* ── Hook 状态 ── */}
      <div className="card">
        <div className="colhead">
          <span>Hook 状态</span>
          <span className="muted">
            {status
              ? (status.corrupt ? '配置文件异常' : (status.enabled ? `已启用${status.activeScope === 'shared' ? '（项目级）' : '（本地级）'}` : '未启用'))
              : (loadError ? '—' : '加载中…')}
          </span>
        </div>
        <div className="toolbar" style={{ padding: '8px 12px' }}>
          <button className="btn small" onClick={enable} disabled={!status || status.enabled || status.corrupt}>启用</button>
          <button className="btn small ghost" onClick={disableHook} disabled={!status || !status.enabled || status.corrupt}>停用</button>
          <button className="btn small ghost" onClick={refresh}>刷新</button>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            开关写在<b>本项目</b>的 .claude/ 下，不是全局——只有本项目会被拦截退出
          </span>
        </div>
        {!status ? <div className="empty">{loadError ? '无法读取 hook 状态' : '加载中…'}</div> : (
          <div style={{ padding: '10px 12px' }}>
            <dl className="kv">
              <div className="kv-row">
                <dt>状态</dt>
                <dd>
                  <span className={'tag' + (status.enabled ? ' strong' : '')}>{status.enabled ? '已启用' : '未启用'}</span>
                  {status.disableAllHooks ? <span className="tag bad" style={{ marginLeft: 6 }}>disableAllHooks</span> : null}
                  {status.corrupt ? <span className="tag bad" style={{ marginLeft: 6 }}>settings.json 损坏</span> : null}
                </dd>
              </div>
              <div className="kv-row">
                <dt>本地级</dt>
                <dd className="mono nowrap" title={status.detail?.local?.path}>
                  <span className={'tag' + (status.detail?.local?.enabled ? ' strong' : '')}>{status.detail?.local?.enabled ? '✓' : '✗'}</span>{' '}
                  {status.detail?.local?.path}
                </dd>
              </div>
              <div className="kv-row">
                <dt>项目级</dt>
                <dd className="mono nowrap" title={status.detail?.shared?.path}>
                  <span className={'tag' + (status.detail?.shared?.enabled ? ' strong' : '')}>{status.detail?.shared?.enabled ? '✓' : '✗'}</span>{' '}
                  {status.detail?.shared?.path}
                </dd>
              </div>
            </dl>
            {status.disableAllHooks ? (
              <p className="muted" style={{ marginTop: 8 }}>
                全局 <code>disableAllHooks: true</code> 会一票否决所有 hooks——即使这里显示已启用，循环也不会被拦截。
              </p>
            ) : null}
            {status.corrupt ? (
              <p className="muted" style={{ marginTop: 8 }}>
                settings.json 无法解析（可能被手改出错或半截写入）。请先修复该文件；修复前「启用 / 停用」会拒绝写入以防覆盖你的配置。
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* ── 布防 ── */}
      <div className="card">
        <div className="colhead">
          <span>布防一个循环</span>
          <span className="muted">布防后 Stop hook 会反复灌回这条提示词</span>
        </div>
        <div style={{ padding: '10px 12px' }}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            placeholder="任务描述，例如：把 src/foo.js 的测试补到全绿，每次迭代跑一遍 npm test"
            style={{
              width: '100%', height: 90, padding: 10, fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 12, border: '1px solid var(--soft-2)', borderRadius: 4,
              background: 'var(--soft-1)', resize: 'vertical',
            }}
          />
          <div className="toolbar" style={{ marginTop: 8 }}>
            <label className="muted" style={{ fontSize: 12 }}>
              轮次上限
              <input className="dlg-input" style={{ width: 70, marginLeft: 6, height: 'auto' }}
                value={maxIter} onChange={(e) => setMaxIter(e.target.value)} placeholder="20" />
              <span style={{ marginLeft: 4 }}>（0 = 无限）</span>
            </label>
            <label className="muted" style={{ fontSize: 12, marginLeft: 12 }}>
              完成短语
              <input className="dlg-input" style={{ width: 140, marginLeft: 6, height: 'auto' }}
                value={promise} onChange={(e) => setPromise(e.target.value)} placeholder="COMPLETE" />
            </label>
            <button className="btn small" style={{ marginLeft: 'auto' }} onClick={start} disabled={!status?.enabled}>
              布防
            </button>
            {!status?.enabled ? <span className="muted" style={{ fontSize: 11 }}>先启用 hook</span> : null}
          </div>
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            完成判定：模型输出 <code>&lt;promise&gt;{promise || '完成短语'}&lt;/promise&gt;</code> 且与上面一字不差时结束。
            每次迭代轮次 +1，到上限自动停止。
          </p>
        </div>
      </div>

      {/* ── 活动循环 ── */}
      <div className="card">
        <div className="colhead">
          <span>循环</span>
          <span className="muted">
            {loops ? `${activeCount} 活跃 / 共 ${loops.length}` : '加载中…'}
            {activeCount > 0 ? (
              <button className="btn small ghost" style={{ marginLeft: 10 }} onClick={() => cancel(null)}>全部取消</button>
            ) : null}
          </span>
        </div>
        {!loops ? <div className="empty">{loadError ? '无法加载' : '加载中…'}</div>
          : loops.length === 0 ? <div className="empty">（暂无循环——在上面布防一个）</div>
          : loops.map((l) => {
            const max = l.maxIterations > 0 ? l.maxIterations : 0;
            const pct = max > 0 ? Math.min(100, Math.round((l.iteration / max) * 100)) : 0;
            return (
              <div key={l.id} className="row" style={{ alignItems: 'flex-start' }}>
                <div style={{ width: 18, flexShrink: 0, fontSize: 13 }} title={l.active === false ? '已结束' : '活跃'}>
                  {l.active === false ? '○' : '●'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ fontSize: 12 }}>{l.id}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {l.iteration}/{max || '∞'}
                      {l.completionPromise ? ` · <promise>${l.completionPromise}</promise>` : ' · 无承诺'}
                    </span>
                    {l.endReason ? <span className="tag" style={{ fontSize: 11 }}>{END_REASON[l.endReason] || l.endReason}</span> : null}
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {String(l.prompt).replace(/\s+/g, ' ')}
                  </div>
                  {max > 0 && l.active !== false ? (
                    <div style={{ height: 4, background: 'var(--soft-1)', borderRadius: 2, marginTop: 6, maxWidth: 320 }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #0ea5e9)', borderRadius: 2 }} />
                    </div>
                  ) : null}
                </div>
                <div className="acts">
                  <span className="muted" style={{ fontSize: 11 }}>最近 {fmt(l.lastFiredAt || l.startedAt)}</span>
                  {l.active !== false ? (
                    <button className="btn small ghost" onClick={() => cancel(l.id)}>取消</button>
                  ) : null}
                </div>
              </div>
            );
          })}
      </div>

      {/* ── 审计日志 ── */}
      <div className="card">
        <div className="colhead">
          <span>迭代日志</span>
          <span className="muted">{logs ? `${logs.length} 条` : '加载中…'}</span>
        </div>
        {!logs ? <div className="empty">{loadError ? '无法加载' : '加载中…'}</div>
          : logs.length === 0 ? <div className="empty">（暂无记录——跑起一个循环后再来）</div>
          : logs.map((r, i) => (
            <div key={i} className="row">
              <div className="mono" style={{ width: 140, flexShrink: 0, fontSize: 12 }}>{fmt(r.ts)}</div>
              <div className="mono" style={{ width: 70, flexShrink: 0, fontSize: 12 }}>{r.loopId || '—'}</div>
              <div style={{ width: 70, flexShrink: 0, fontSize: 12 }}>第 {r.iteration} 轮</div>
              <div style={{ width: 80, flexShrink: 0 }}>
                <span className={'tag' + (r.decision === 'promise-hit' ? ' strong' : (r.decision === 'continue' ? '' : ' bad'))}
                  style={{ fontSize: 11 }}>
                  {DECISION[r.decision] || r.decision}
                </span>
              </div>
              <div className="muted" style={{ flex: 1, minWidth: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={r.lastText || ''}>
                {r.decision === 'continue'
                  ? `promise=${r.promise ?? '—'} · 解析到 ${r.lastTextChars ?? '?'} 字`
                  : (r.promise ? `<promise>${r.promise}</promise>` : '')}
              </div>
            </div>
          ))}
      </div>

      <ManualAddCard snippet={status?.snippet} eventKey="Stop" />

      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="loop" />
      </div>
    </div>
  );
}

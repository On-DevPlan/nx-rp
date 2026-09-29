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
import { useDialog, useGuard, useToast, Copyable, Modal } from '../../web/frontend/components/ui.jsx';
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

// 一行摘要：优先用服务端存的 lastTextHead（由原文折叠而来，保留了可读性）；
// 旧条目（v0.9.3 之前）没有该字段，回退到把 lastText 折叠成单行——
// 那些条目的 lastText 本来就是折叠过的单行，所以回退也是等价的。
function headOf(r) {
  if (r.lastTextHead !== undefined) return r.lastTextHead;
  return r.lastText ? String(r.lastText).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
}

// 一条循环的会话归属标签。
//
// 两个字段都是「这个会话」的等价标识，取先有值的那个：
//   sessionId       —— 用户显式 --session-id 传的
//   claudeSessionId —— 启动时从 CLAUDE_CODE_SESSION_ID 捕获的
// 只认 sessionId 会把「靠 env 绑定好」的循环误显示成匿名（这是个已修的显示 bug）。
function SessionTag({ loop }) {
  const sid = loop.sessionId || loop.claudeSessionId;
  if (!sid) {    // 走到这里说明这条循环真的没有任何身份——服务端已不再允许新建这种循环，
    // 只可能是旧版本遗留的记录。
    return <span className="tag bad" style={{ fontSize: 11 }} title="没有任何会话标识：Stop hook 无法确定它归谁，不会被触发">无会话（旧数据）</span>;
  }
  const via = loop.sessionId ? '' : '（env 捕获）';
  return (
    <Copyable
      text={sid}
      className="tag mono"
      title={`sessionId: ${sid}${via}\n点击复制完整 ID，用于 claude --resume`}
    >
      {String(sid).slice(0, 8)}{loop.sessionId ? '' : ' *'}
    </Copyable>
  );
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
  // 会话绑定：默认留空 = 用服务端捕获的当前会话（status.currentSessionId）。
  // 之所以要能显式填：布防时拿不到身份的话，Stop hook 永远认领不到这条循环。
  const [sessInput, setSessInput] = useState('');
  // 编辑态：editing = {id}；draft 是那一条的可编辑副本（点「保存」才提交）
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ prompt: '', maxIterations: '20', completionPromise: '', sessionId: '' });
  // 日志详情：审计行里的「成果」被截断成一句摘要，点开看完整文本
  const [viewLog, setViewLog] = useState(null);
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
          // 留空则交给服务端用 env 捕获的会话；填了就用填的（显式优先）
          sessionId: sessInput.trim() || undefined,
        },
      });
      toast(`已布防 ${r.id}`);
      setPrompt('');
      setSessInput('');
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

  // 删除记录（区别于「取消」：取消只标记结束，记录留着，列表会越堆越长）
  const remove = (id) =>
    guard(async () => {
      const ok = await dialog({
        title: `删除循环 ${id}？`,
        message: '从状态文件里真删掉这条记录（取消只是标记结束、记录仍在）。审计日志不受影响。',
        danger: true,
        okText: '删除',
      });
      if (!ok) return;
      await api('/api/loop/remove', { method: 'POST', body: { id } });
      toast(`已删除 ${id}`);
      if (editing?.id === id) setEditing(null);
      await refresh();
    });

  // 进入/退出编辑态。复制一份到 draft 上，改完点「保存」才提交——
  // 避免边输边写盘，也便于「放弃」。
  const beginEdit = (l) => {
    setEditing({ id: l.id });
    setDraft({
      prompt: l.prompt || '',
      maxIterations: String(l.maxIterations ?? 20),
      completionPromise: l.completionPromise || '',
      sessionId: l.sessionId || l.claudeSessionId || '',
    });
  };

  const saveEdit = () =>
    guard(async () => {
      if (!editing) return;
      const max = Number(draft.maxIterations);
      const r = await api('/api/loop/update', {
        method: 'POST',
        body: {
          id: editing.id,
          prompt: draft.prompt,
          maxIterations: Number.isFinite(max) ? max : undefined,
          completionPromise: draft.completionPromise.trim(),
          sessionId: draft.sessionId.trim(),
        },
      });
      toast(r.skipped ? '没有改动'
        : `已更新 ${r.changed.join(' / ')}${r.reactivated ? '（已重新激活）' : ''}`);
      setEditing(null);
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
            <label className="muted" style={{ fontSize: 12, marginLeft: 12 }}>
              会话
              <input className="dlg-input" style={{ width: 200, marginLeft: 6, height: 'auto' }}
                value={sessInput} onChange={(e) => setSessInput(e.target.value)}
                placeholder={status?.currentSessionId ? `默认 ${String(status.currentSessionId).slice(0, 8)}…` : '（拿不到，请填）'} />
            </label>
            <button className="btn small" style={{ marginLeft: 'auto' }} onClick={start} disabled={!status?.enabled}>
              布防
            </button>
            {!status?.enabled ? <span className="muted" style={{ fontSize: 11 }}>先启用 hook</span> : null}
          </div>
          {/* 会话绑定提示：这是最容易踩的坑——留空时绑定的是「运行 nx-rp 那个进程的会话」，
              不是浏览器所在会话。布防前让用户看清会绑到谁。 */}
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {sessInput.trim()
              ? <>将绑定到 <Copyable text={sessInput.trim()} className="tag mono" title="点击复制">{String(sessInput.trim()).slice(0, 8)}</Copyable>（显式指定）</>
              : status?.currentSessionId
                ? <>将绑定到当前会话 <Copyable text={status.currentSessionId} className="tag mono" title={`${status.currentSessionId}\n点击复制`}>{String(status.currentSessionId).slice(0, 8)}</Copyable>（服务端 env 捕获）</>
                : <span className="bad">拿不到会话身份——留空布防会失败，请在上面的「会话」里显式填写 sessionId。</span>}
          </p>
          <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
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
              <div key={l.id} className="row wrap">
                <div style={{ width: 18, flexShrink: 0, fontSize: 13 }} title={l.active === false ? '已结束' : '活跃'}>
                  {l.active === false ? '○' : '●'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="mono" style={{ fontSize: 12 }}>{l.id}</span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {l.iteration}/{max || '∞'}
                      {l.completionPromise ? ` · <promise>${l.completionPromise}</promise>` : ' · 无承诺'}
                    </span>
                    {l.endReason ? <span className="tag" style={{ fontSize: 11 }}>{END_REASON[l.endReason] || l.endReason}</span> : null}
                    {/* 会话归属：多会话并行时靠这个区分这条循环归谁。
                        两个字段都是「本会话」的等价标识——sessionId 是显式传的，
                        claudeSessionId 是启动时从 CLAUDE_CODE_SESSION_ID 捕获的。
                        同时显示短码 + 可点击复制，与 hook-prompt 面板一致。 */}
                    <SessionTag loop={l} />
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
                  <button className="btn small ghost"
                    onClick={() => (editing?.id === l.id ? setEditing(null) : beginEdit(l))}>
                    {editing?.id === l.id ? '收起' : '编辑'}
                  </button>
                  {l.active !== false ? (
                    <button className="btn small ghost" onClick={() => cancel(l.id)}>取消</button>
                  ) : (
                    <button className="btn small ghost" onClick={() => remove(l.id)}>删除</button>
                  )}
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
            <div key={i} className="row wrap" style={{ gap: 8 }}>
              <div className="mono" style={{ flexShrink: 0, fontSize: 12 }}>{fmt(r.ts)}</div>
              <div className="mono" style={{ flexShrink: 0, fontSize: 12 }}>{r.loopId || '—'}</div>
              <div style={{ flexShrink: 0, fontSize: 12 }}>第 {r.iteration} 轮</div>
              <div style={{ flexShrink: 0 }}>
                <span className={'tag' + (r.decision === 'promise-hit' ? ' strong' : (r.decision === 'continue' ? '' : ' bad'))}
                  style={{ fontSize: 11 }}>
                  {DECISION[r.decision] || r.decision}
                </span>
              </div>
              {/* 会话归属：审计行也带 sessionId，便于对照是哪条循环哪个会话产生的 */}
              {r.sessionId ? (
                <Copyable text={r.sessionId} className="tag mono" style={{ flexShrink: 0, fontSize: 11 }}
                  title={`sessionId: ${r.sessionId}\n点击复制完整 ID`}>
                  {String(r.sessionId).slice(0, 8)}
                </Copyable>
              ) : null}
              {/* 一句话摘要：优先用服务端存好的 lastTextHead（从原文折叠而来）；
                  旧条目没有这个字段，回退到把 lastText 折叠——历史数据依然可读。 */}
              <div className="muted" style={{ flex: 1, minWidth: 120, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={headOf(r) || ''}>
                {r.decision === 'continue'
                  ? `promise=${r.promise ?? '—'} · 解析到 ${r.lastTextChars ?? '?'} 字`
                  : (r.promise ? `<promise>${r.promise}</promise>` : '')}
                {headOf(r) ? ` · ${headOf(r)}` : ''}
              </div>
              {/* 展开看完整成果：列表里只放一句摘要，那一轮 Agent 到底做了什么要看全文 */}
              {r.lastText ? (
                <button className="btn small ghost" style={{ flexShrink: 0 }} onClick={() => setViewLog(r)}>成果</button>
              ) : null}
            </div>
          ))}
      </div>

      {/* 编辑弹窗：多字段用 Modal 而非 useDialog（后者只支持单个输入框）。
          空间大，能完整看到任务描述全文与全部参数；改完点「保存」才提交。 */}
      {editing ? (
        <Modal title={`编辑循环 ${editing.id}`} onClose={() => setEditing(null)}>
          <dl className="kv" style={{ marginBottom: 12 }}>
            {(() => {
              const l = (loops || []).find((x) => x.id === editing.id);
              if (!l) return null;
              const max = l.maxIterations > 0 ? l.maxIterations : '∞';
              return (
                <>
                  <div className="kv-row">
                    <dt>当前状态</dt>
                    <dd>
                      <span className={'tag' + (l.active === false ? '' : ' strong')}>{l.active === false ? '已结束' : '运行中'}</span>
                      <span className="muted" style={{ marginLeft: 6 }}>
                        第 {l.iteration}/{max} 轮
                        {l.endReason ? ` · ${END_REASON[l.endReason] || l.endReason}` : ''}
                      </span>
                    </dd>
                  </div>
                  <div className="kv-row">
                    <dt>开始时间</dt>
                    <dd className="mono" style={{ fontSize: 12 }}>{fmt(l.startedAt)}</dd>
                  </div>
                  <div className="kv-row">
                    <dt>最后触发</dt>
                    <dd className="mono" style={{ fontSize: 12 }}>{l.lastFiredAt ? fmt(l.lastFiredAt) : '（尚未触发过）'}</dd>
                  </div>
                </>
              );
            })()}
          </dl>

          <label className="muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            任务描述（下一轮起灌回这段文本）
          </label>
          <textarea
            value={draft.prompt}
            onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
            spellCheck={false}
            style={{
              width: '100%', height: 200, padding: 10,
              fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12,
              border: '1px solid var(--soft-2)', borderRadius: 4,
              background: 'var(--soft-1)', resize: 'vertical',
            }}
          />

          <div className="toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            <label className="muted" style={{ fontSize: 12 }}>
              轮次上限
              <input className="dlg-input" style={{ width: 70, marginLeft: 6, height: 'auto' }}
                value={draft.maxIterations}
                onChange={(e) => setDraft((d) => ({ ...d, maxIterations: e.target.value }))} />
            </label>
            <label className="muted" style={{ fontSize: 12, marginLeft: 12 }}>
              完成短语
              <input className="dlg-input" style={{ width: 180, marginLeft: 6, height: 'auto' }}
                value={draft.completionPromise}
                onChange={(e) => setDraft((d) => ({ ...d, completionPromise: e.target.value }))}
                placeholder="（留空 = 无承诺，只能靠上限收口）" />
            </label>
            <label className="muted" style={{ fontSize: 12, marginLeft: 12 }}>
              会话
              <input className="dlg-input" style={{ width: 220, marginLeft: 6, height: 'auto' }}
                value={draft.sessionId}
                onChange={(e) => setDraft((d) => ({ ...d, sessionId: e.target.value }))}
                placeholder="sessionId（决定哪条 Stop hook 认得它）" />
            </label>
          </div>

          <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            提高轮次上限可**复活**「因到上限而停」的循环（手工取消的不复活）。
            会话决定归属：填错会让这条循环永远等不到 Stop hook。
          </p>

          <div className="toolbar" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>放弃</button>
            <button className="btn" onClick={saveEdit}>保存</button>
          </div>
        </Modal>
      ) : null}

      {/* 日志详情弹窗：该轮从 transcript 解析到的完整文本 */}
      {viewLog ? (
        <Modal
          title={`${viewLog.loopId || '—'} 第 ${viewLog.iteration} 轮 · ${DECISION[viewLog.decision] || viewLog.decision}`}
          onClose={() => setViewLog(null)}
        >
          <dl className="kv" style={{ marginBottom: 12 }}>
            <div className="kv-row"><dt>时间</dt><dd>{fmt(viewLog.ts)}</dd></div>
            <div className="kv-row">
              <dt>会话</dt>
              <dd>{viewLog.sessionId
                ? <Copyable text={viewLog.sessionId} className="tag mono" title="点击复制">{viewLog.sessionId}</Copyable>
                : <span className="muted">（本行未记录——会话不匹配的判定不写审计）</span>}</dd>
            </div>
            <div className="kv-row">
              <dt>解析结果</dt>
              <dd>
                <span className="muted">
                  {viewLog.promise ? <>promise=<code>{viewLog.promise}</code> · </> : '未检出 promise · '}
                  文本 {viewLog.lastTextChars ?? '?'} 字
                  {viewLog.lastTextTruncated
                    ? <span className="bad"> · ⚠ 超出存储上限，下方不是完整回复</span>
                    : null}
                </span>
              </dd>
            </div>
          </dl>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            这一轮 Stop hook 从 transcript 取到的最后一条 assistant 文本——即「这一轮 Agent 做了什么」。
            {/* 早期版本只存 200 字且把换行折叠掉了，那些历史条目补不回来——如实标出，别让人以为是被截了 */}
            {viewLog.lastText && viewLog.lastTextChars > viewLog.lastText.length ? (
              <span className="bad">（这条是 v0.9.3 之前记的旧条目，当时只存前 200 字，原文已无法恢复）</span>
            ) : null}
          </div>
          <pre style={{
            margin: 0, padding: 12, background: 'var(--soft-1)', border: '1px solid var(--soft-2)',
            borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '46vh', overflow: 'auto',
          }}>{viewLog.lastText}</pre>
        </Modal>
      ) : null}

      <ManualAddCard snippet={status?.snippet} eventKey="Stop" />

      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="loop" />
      </div>
    </div>
  );
}

// 循环面板：布防表单 + 活动循环卡 + 审计日志卡。
//
// 头部三件套（toolbar / 加载失败卡 / Hook 状态卡）与启停动作由 useHookDomain
// 生成——hook 域三视图的公共部分，本视图只管循环本身。
//
// 与另两个 hook 模块的**本质差异**在 cfg 里声明：开关写的是**项目级**配置
// （.claude/settings.local.json），不是全局 ~/.claude/settings.json——
// 只有配了 hook 的项目才会被拦截退出，语义与 ralph-loop 一致。
import { useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useGuard, useToast, Copyable, Modal } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import ManualAddCard from '../../web/frontend/components/ManualAddCard.jsx';
import { useHookDomain } from '../../web/frontend/components/hook-domain.jsx';

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

// 会话归属的判定说明与 ✓/✗ 小标签（状态卡里三层作用域用）
function mark(on) {
  return <span className={'tag' + (on ? ' strong' : '')}>{on ? '✓' : '✗'}</span>;
}

// 三层作用域：目标文件 + 一行说明（选择器选项与状态卡共用同一份文案源）
const SCOPES = [
  { id: 'global', label: '全局', note: '本机所有项目生效——无关项目零影响（没有归属本会话的循环会直接放行）' },
  { id: 'local', label: '本地级', note: '仅本项目、仅自己（写入被 gitignore 的本地配置）' },
  { id: 'shared', label: '项目级', note: '入库、团队共享——每人本机需装 nx-rp' },
];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.id, s.label]));

export default function LoopView() {
  const [logs, setLogs] = useState(null);
  // 启用写到哪一层（写之前先选；已启用时跟随当前生效层）
  const [scopeLevel, setScopeLevel] = useState('local');
  // 布防表单
  const [prompt, setPrompt] = useState('');
  const [maxIter, setMaxIter] = useState('20');
  // 完成短语默认**留空** = 仅轮次循环（跑到上限或手动取消才停）——
  // 这是很多场景的合理默认（用户说"跑 10 轮就行"时根本不该编一个承诺词）；
  // 需要提前结束时再填。
  const [promise, setPromise] = useState('');
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

  const dom = useHookDomain({
    statusUrl: '/api/loop/status',
    onUrl: '/api/loop/on',
    // 启用写哪一层由选择器决定——函数形式在**点击那一刻**求值（对象形式会停在旧值）
    onBody: () => ({ scope: scopeLevel }),
    onEnabled: (r) => (r.gitignore?.added ? '已启用，并追加了 .gitignore 忽略规则' : (r.skipped ? '已启用（无需改动）' : '已启用')),
    offUrl: '/api/loop/off',
    offDialog: {
      title: '停用循环 hook？',
      message: '会从全局 / 本地级 / 项目级三个配置里摘掉循环那条 Stop hook（写前自动留快照；其他 hooks 不动）。已布防的循环记录保留。',
      okText: '停用',
    },
    note: 'Stop hook 拦截退出并灌回同一条提示词，直到命中承诺词或轮次上限',
    summary: (st) => (st.corrupt ? '配置文件异常'
      : (st.enabled ? `已启用（${SCOPE_LABEL[st.activeScope] || st.activeScope}）` : '未启用')),
    // 三层各一行：用户可能在层间切过，要能看到哪层开了、哪层缺
    extraRows: (st) => [
      ['全局', <>{mark(st.detail?.global?.enabled)} {st.detail?.global?.path || '（家目录不可知）'}</>, st.detail?.global?.path],
      ['本地级', <>{mark(st.detail?.local?.enabled)} {st.detail?.local?.path}</>, st.detail?.local?.path],
      ['项目级', <>{mark(st.detail?.shared?.enabled)} {st.detail?.shared?.path}</>, st.detail?.shared?.path],
    ],
    extraWarnings: (st) => ((st.enabledScopes || []).length > 1
      // 官方语义：各层 hooks 是**合并**而不是覆盖——同一事件会跑多次
      ? [<>多层同时启用（{(st.enabledScopes || []).map((s) => SCOPE_LABEL[s] || s).join(' + ')}）——同一事件 hook 会跑多次，建议只留一层（先「停用」再在目标层「启用」）。</>]
      : []),
    // 作用域选择器与「启用」同一行：先选层，再点启用
    toolbarExtra: ({ refresh, status: st }) => (
      <>
        <select
          value={scopeLevel}
          onChange={(e) => setScopeLevel(e.target.value)}
          disabled={!!st?.enabled}
          title="启用写到哪一层（已启用时先「停用」再切层）"
          style={{ fontSize: 12 }}
        >
          {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <button className="btn small ghost" onClick={refresh}>刷新</button>
      </>
    ),
    toolbarNote: SCOPES.find((s) => s.id === scopeLevel)?.note,
    // 审计日志跟着状态一起拉；循环列表就在 status 响应里（st.loops）
    afterRefresh: async () => setLogs(await api('/api/loop/log?limit=' + LIMIT)),
  });

  const { status, dialog, dialogNode } = dom;
  const loops = status?.loops || [];

  // 启用后把选择器拨到**实际生效的那层**：否则选择器显示「全局」而实际写在本地级，
  // 用户按上面那行说明去理解就会错。只在生效层变化时拨动（不动用户的手动选择）。
  const activeScope = status?.activeScope || null;
  useEffect(() => { if (activeScope) setScopeLevel(activeScope); }, [activeScope]);

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
      await dom.refresh();
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
      await dom.refresh();
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
      await dom.refresh();
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
      await dom.refresh();
    });

  const activeCount = loops.filter((l) => l.active !== false).length;

  return (
    <div>
      {dom.toolbar}
      {dom.errorCard}

      {dom.statusCard}

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
                value={promise} onChange={(e) => setPromise(e.target.value)} placeholder="（留空 = 仅轮次循环）" />
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
          {/* 会话绑定：这是最容易踩的坑——留空时绑定的是「运行 nx-rp 那个进程的会话」，
              不是浏览器所在会话。布防前让用户看清会绑到谁。 */}
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            {sessInput.trim()
              ? <>会话：绑定 <Copyable text={sessInput.trim()} className="tag mono" title="点击复制">{String(sessInput.trim()).slice(0, 8)}</Copyable>（显式指定）</>
              : status?.currentSessionId
                ? <>会话：绑定当前会话 <Copyable text={status.currentSessionId} className="tag mono" title={`${status.currentSessionId}\n点击复制`}>{String(status.currentSessionId).slice(0, 8)}</Copyable>（服务端 env 捕获）</>
                : <span className="bad">拿不到会话身份——留空布防会失败，请在「会话」里显式填 sessionId。</span>}
          </p>
          <p className="muted" style={{ marginTop: 4, fontSize: 12 }}>
            {promise.trim()
              ? <>完成判定：输出 <code>&lt;promise&gt;{promise.trim()}&lt;/promise&gt;</code> 即提前结束，否则每轮 +1、到上限停。</>
              : <>完成判定：仅轮次——到上限或手动取消才停；需提前结束再填上面的短语。</>}
          </p>
        </div>
      </div>

      {/* ── 活动循环 ── */}
      <div className="card">
        <div className="colhead">
          <span>循环</span>
          <span className="muted">
            {status ? `${activeCount} 活跃 / 共 ${loops.length}` : '加载中…'}
            {activeCount > 0 ? (
              <button className="btn small ghost" style={{ marginLeft: 10 }} onClick={() => cancel(null)}>全部取消</button>
            ) : null}
          </span>
        </div>
        {!status ? <div className="empty">{dom.loadError ? '无法加载' : '加载中…'}</div>
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
                        claudeSessionId 是启动时从 CLAUDE_CODE_SESSION_ID 捕获的。 */}
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
          <span className="muted">{logs ? `${logs.length} 条` : (dom.loadError ? '加载失败' : '加载中…')}</span>
        </div>
        {!logs ? <div className="empty">{dom.loadError ? '无法加载' : '加载中…'}</div>
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
              const l = loops.find((x) => x.id === editing.id);
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
                  <div className="kv-row">
                    <dt>任务版本</dt>
                    <dd>
                      <span className="tag mono" style={{ fontSize: 11 }}>v{l.promptVersion ?? 1}</span>
                      {(l.promptVersions || []).length > 0 ? (
                        <span
                          className="muted"
                          style={{ marginLeft: 6, fontSize: 11 }}
                          title={`在此改动任务描述会把当前版归档进历史，版本升为 v${(l.promptVersion ?? 1) + 1}`}
                        >
                          已保留 {l.promptVersions.length} 个历史版
                        </span>
                      ) : (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>（从未改过任务描述）</span>
                      )}
                    </dd>
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
            提高上限可复活「到顶而停」的循环；会话填错则永远等不到 Stop hook。
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
          {/* 当轮用的 prompt：审计只记版号，全文去状态文件的 promptVersions 里查。
              改过任务描述时这一行能回答「第 N 轮当时在做什么」，不然复盘只剩产出、没有指令。 */}
          {(() => {
            const l = loops.find((x) => x.id === viewLog.loopId);
            if (!l) return null;
            const v = viewLog.promptVersion ?? 1;
            const cur = (l.promptVersion ?? 1) === v;
            const text = cur ? l.prompt : (l.promptVersions || []).find((p) => p.v === v)?.text;
            return (
              <div style={{ marginBottom: 10 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                  本轮任务描述 <span className="tag mono" style={{ fontSize: 11 }}>v{v}</span>
                  {cur ? <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>（当前版）</span>
                    : <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>（历史版——之后被改过）</span>}
                  {!text ? <span className="bad" style={{ marginLeft: 6, fontSize: 11 }}>已超出保留上限，无法回溯</span> : null}
                </div>
                {text ? (
                  <details>
                    <summary className="muted" style={{ fontSize: 11, cursor: 'pointer' }}>展开看当轮完整任务描述</summary>
                    <pre style={{
                      margin: '6px 0 0', padding: 10, background: 'var(--soft-1)', border: '1px solid var(--soft-2)',
                      borderRadius: 4, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '30vh', overflow: 'auto',
                    }}>{text}</pre>
                  </details>
                ) : null}
              </div>
            );
          })()}
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
            本轮最后一条 assistant 回复（成果全文）
            {/* 早期版本只存 200 字且把换行折叠掉了，那些历史条目补不回来——如实标出，别让人以为是被截了 */}
            {viewLog.lastText && viewLog.lastTextChars > viewLog.lastText.length ? (
              <span className="bad">（v0.9.3 前的旧条目只存了前 200 字，原文无法恢复）</span>
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

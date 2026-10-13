// 面板壳：tab 导航 + 当前视图。
//
// VIEWS 是视图注册表（registry.js），每个视图懒加载。
import { Suspense, useEffect, useRef, useState } from 'react';
import { VIEWS } from './registry.js';
import { useStore } from './store.jsx';
import { api } from './api/client.js';
import { ErrorBoundary, useDialog, useGuard, useToast } from './components/ui.jsx';

function viewFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return h || '';
}

// 最近目录下拉：受控 React 组件，替换原 <details> 切换器。
//
// 设计要点：
//   - 触发按钮常驻 header；菜单在 open=true 时挂载到绝对定位层
//   - mousedown（而非 click）监听点击外部：click 阶段事件冒泡会把点击事件
//     一并传到触发按钮的 onClick，导致 setOpen(false) 后又被 setOpen(true) 抵消
//   - 自动跟随最新触发：当 recents 顶部与当前激活 scope 不一致时调用 switchScope(top)
//     ——既覆盖用户主动点击（switchScope 自身会 setActiveScope 后由 refreshBoot 触发顶部对齐），
//       也覆盖「另一终端 nx-rp serve 在新 cwd 启动」后 visibilitychange 拉到的新 bootstrap
//   - 每行右侧的删除按钮用 stopPropagation 防止冒泡到切换按钮
function RecentsDropdown() {
  const { boot, ui, switchScope, removeRecent, refreshBoot } = useStore();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  // 点击外部 / 按 Esc 收回。用 mousedown 而非 click：click 阶段会先冒泡到触发按钮的
  // onClick（setOpen(true)），把刚关掉的又打开；mousedown 早于 click 触发，天然避开。
  // 挂 document 而非 window：菜单是 absolute，滚动不该触发它。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const recents = boot?.recents || [];
  const top = recents[0];
  const activeScope = ui.activeScope;

  // 自动跟随最新触发：仅当顶部与当前激活不一致时才切，避免初次渲染 / 同条目重触发的循环。
  // switchScope 是稳定 useCallback（依赖 patchUi/refreshBoot 都为空），useEffect 不会因此频繁重跑。
  useEffect(() => {
    if (!top) return;
    if (activeScope?.scope === top.scope) return;
    switchScope(top);
  }, [top?.scope, activeScope?.scope, switchScope]);

  // 添加目录：面板内弹窗（useDialog）输入路径——不用 window.prompt（原生弹窗样式突兀，
  // 且无法带出「必须存在」的校验反馈；guard 会把后端的 INVALID_INPUT toast 出来）。
  const handleAdd = () => guard(async () => {
    setOpen(false);
    const raw = await dialog({
      title: '添加目录',
      message: '登记一个已存在的目录到「最近目录」，添加后自动切换到它。',
      input: true,
      placeholder: 'D:\\code\\your-project',
      okText: '添加',
    });
    if (!raw) return;
    const entry = await api('/api/recents', { method: 'POST', body: { path: raw } });
    toast(`已添加: ${entry.path}`);
    // refreshBoot 后顶部就是刚加的；上面的 auto-follow useEffect 会把它切到激活态。
    await refreshBoot().catch(() => {});
  });

  return (
    <div ref={wrapRef} className="recents-wrap">
      <button
        type="button"
        className="recents-trigger"
        onClick={() => setOpen((o) => !o)}
        title={activeScope?.path || '最近目录'}
      >
        {activeScope?.path
          ? activeScope.path.split(/[\\/]/).filter(Boolean).pop()
          : '最近目录'}
        {recents.length > 0 && <span className="recents-count"> {recents.length}</span>}
        <span className="recents-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="recents-menu" role="menu">
          {recents.map((r) => {
            const isActive = activeScope?.scope === r.scope;
            return (
              <li key={r.scope} className={isActive ? 'active' : ''}>
                <button
                  type="button"
                  className="recents-item"
                  title={`${r.path}\n点击切换：之后的查看/新增/编辑都落到这个目录`}
                  onClick={() => { switchScope(isActive ? null : r); setOpen(false); }}
                >
                  <span className="recents-name">{r.path.split(/[\\/]/).filter(Boolean).pop() || r.path}</span>
                  <span className="recents-path">{r.path}</span>
                  {isActive && <span className="recents-check">✓</span>}
                </button>
                <button
                  type="button"
                  className="recents-del"
                  title={`从最近目录中移除: ${r.path}`}
                  onClick={(e) => {
                    e.stopPropagation(); // 不冒泡到 li 内的切换按钮（否则删完还顺手切了目录）
                    guard(() => removeRecent(r));
                  }}
                >×</button>
              </li>
            );
          })}
          <li className="recents-add">
            <button type="button" onClick={handleAdd}>+ 添加目录</button>
          </li>
        </ul>
      )}
      {dialogNode}
    </div>
  );
}

export default function App() {
  const { ui, patchUi, boot, scopeTick, refreshBoot } = useStore();
  const views = VIEWS;

  // 窗口聚焦时刷新 bootstrap：别的终端跑 nx-rp serve 登记了新目录，这里能看到。
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refreshBoot().catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshBoot]);

  // 启动时把 hash 同步进 store；后续切换时也回写 hash（可分享、可后退）
  useEffect(() => {
    const fromHash = viewFromHash();
    if (fromHash && fromHash !== ui.view) patchUi({ view: fromHash });
    else if (!location.hash && ui.view) location.hash = '#/' + ui.view;
  }, []);

  useEffect(() => {
    if (ui.view) location.hash = '#/' + ui.view;
  }, [ui.view]);

  useEffect(() => {
    const onHash = () => patchUi({ view: viewFromHash() });
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [patchUi]);

  const current = views.find((v) => v.id === ui.view) || views[0];

  // header 当前 scope 展示：激活了最近目录显示它的末段，否则显示服务进程目录。
  const activePath = ui.activeScope?.path || boot?.cwdScope || '';
  const activeLabel = String(activePath).split(/[\\/]/).filter(Boolean).pop() || activePath;

  return (
    <>
      <header>
        <div className="brand"><img src="/logo-rounded.png" alt="" />nx-rp<span className="sub">外部资源链接器 + 工作流编排器</span></div>
        <nav>
          {views.map((v) => (
            <button key={v.id} className={'tab' + (current && current.id === v.id ? ' active' : '')}
              onClick={() => patchUi({ view: v.id })}>
              {v.title}
            </button>
          ))}
          {views.length === 0 && <span className="muted" style={{ padding: '6px 12px' }}>暂无视图</span>}
        </nav>
        <div className="meta" title={activePath}>{activeLabel}</div>
        <RecentsDropdown />
      </header>
      <main>
        {!current ? (
          <div className="empty">
            <p>还没有注册任何视图。在 <code>src/modules/&lt;域&gt;/view.jsx</code> 写一个，再在 <code>src/web/frontend/registry.js</code> 登记一行。</p>
            <p>CLI 已就绪：<code>nx-rp help</code> / <code>nx-rp routes</code> / <code>nx-rp bootstrap --json</code>。</p>
          </div>
        ) : (
          <ErrorBoundary key={current.id}>
            {/* scopeTick 进 key：切换激活 scope 时强制重挂载，视图的挂载期请求会带上新 scope 头 */}
            <Suspense fallback={<div className="muted" style={{ padding: 24 }}>加载中…</div>}>
              <section className="panel active" key={scopeTick}><current.component /></section>
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </>
  );
}

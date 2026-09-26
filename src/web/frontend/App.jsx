// 面板壳：tab 导航 + 当前视图。
//
// VIEWS 是视图注册表（registry.js），每个视图懒加载。
import { Suspense, useEffect } from 'react';
import { VIEWS } from './registry.js';
import { useStore } from './store.jsx';
import { ErrorBoundary } from './components/ui.jsx';

function viewFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return h || '';
}

export default function App() {
  const { ui, patchUi, boot, switchScope, scopeTick, refreshBoot } = useStore();
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
        {(boot?.recents?.length > 0) && (
          <details className="recents">
            <summary>最近目录 {boot.recents.length}</summary>
            <ul>
              {boot.recents.map((r) => (
                <li key={r.scope}>
                  <button
                    className={'muted' + (ui.activeScope?.scope === r.scope ? ' active' : '')}
                    title={`${r.path}\n点击切换：之后的查看/新增/编辑都落到这个目录`}
                    onClick={() => switchScope(ui.activeScope?.scope === r.scope ? null : r)}
                    style={{ cursor: 'pointer' }}>
                    {r.path.split(/[\\/]/).filter(Boolean).pop()}
                    {ui.activeScope?.scope === r.scope ? ' ✓' : ''}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
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
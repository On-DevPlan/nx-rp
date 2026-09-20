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
  const { ui, patchUi, boot } = useStore();
  const views = VIEWS;

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

  return (
    <>
      <header>
        <div className="brand">nx-rp<span className="sub">外部资源链接器 + 工作流编排器</span></div>
        <nav>
          {views.map((v) => (
            <button key={v.id} className={'tab' + (current && current.id === v.id ? ' active' : '')}
              onClick={() => patchUi({ view: v.id })}>
              {v.title}
            </button>
          ))}
          {views.length === 0 && <span className="muted" style={{ padding: '6px 12px' }}>暂无视图</span>}
        </nav>
        <div className="meta">{boot?.cwdScope || ''}</div>
      </header>
      <main>
        {!current ? (
          <div className="empty">
            <p>还没有注册任何视图。在 <code>src/modules/&lt;域&gt;/view.jsx</code> 写一个，再在 <code>src/web/frontend/registry.js</code> 登记一行。</p>
            <p>CLI 已就绪：<code>nx-rp help</code> / <code>nx-rp routes</code> / <code>nx-rp bootstrap --json</code>。</p>
          </div>
        ) : (
          <ErrorBoundary key={current.id}>
            <Suspense fallback={<div className="muted" style={{ padding: 24 }}>加载中…</div>}>
              <section className="panel active"><current.component /></section>
            </Suspense>
          </ErrorBoundary>
        )}
      </main>
    </>
  );
}
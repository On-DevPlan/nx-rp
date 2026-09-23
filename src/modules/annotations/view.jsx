// 文件批注面板：文件预览（渐进加载）+ 路径浏览器 + 批注 + 跨文件待办。
//
// 渐进策略（性能优先）：
//   - 文件内容按窗口切片加载：首屏 1000 字符，「加载更多」每次 +3000，追加渲染；
//     服务端窗口切片（annotation.load?offset&limit），单次传输量恒定可控
//   - 路径逐级点选进入（annotation.browse，每步一次 readdir，不递归），
//     不做任何全盘扫描
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Modal, useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const KIND_TAG = { review: '评价', todo: '待办', note: '思考' };

export default function AnnotationsView() {
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState(null);  // { body, totalChars, lineCount, hasMore, nextOffset }
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [list, setList] = useState(null);
  const [kind, setKind] = useState('note');
  const [body, setBody] = useState('');
  const [line, setLine] = useState('');
  const [todos, setTodos] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [browser, setBrowser] = useState(null);  // listDir 结果
  const [showBrowser, setShowBrowser] = useState(false);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const refreshList = useCallback(async (f) => {
    if (!f) { setList(null); return; }
    try {
      setList(await api('/api/annotations?file=' + encodeURIComponent(f)));
    } catch {
      setList([]);
    }
  }, []);

  const refreshTodos = useCallback(async () => {
    try { setTodos(await api('/api/annotations/todos')); } catch { setTodos([]); }
  }, []);

  useEffect(() => { refreshTodos(); }, [refreshTodos]);

  // 首屏：1000 字符窗口。拒绝渲染只发生在 CLI 上限模式——web 用窗口模式，永不拒绝。
  const doLoad = () =>
    guard(async () => {
      if (!file.trim()) return;
      setLoading(true);
      setPreview(null);
      try {
        const r = await api('/api/annotations/load?file=' + encodeURIComponent(file) + '&limit=1000');
        setPreview(r);
        await refreshList(file);
      } catch (e) {
        setPreview({ loadError: e.message });
      } finally {
        setLoading(false);
      }
    });

  // 渐进追加：从 nextOffset 续 3000 字符，追加进已有内容——已渲染部分不重排。
  const doLoadMore = () =>
    guard(async () => {
      if (!preview?.hasMore) return;
      setLoadingMore(true);
      try {
        const r = await api('/api/annotations/load?file=' + encodeURIComponent(file)
          + '&offset=' + preview.nextOffset + '&limit=3000');
        setPreview((prev) => ({
          ...prev,
          body: prev.body + r.body,
          hasMore: r.hasMore,
          nextOffset: r.nextOffset,
        }));
      } catch (e) {
        toast('加载失败: ' + e.message);
      } finally {
        setLoadingMore(false);
      }
    });

  // ── 路径浏览器：逐级浏览，每步一次 readdir ──
  const openBrowser = () =>
    guard(async () => {
      const r = await api('/api/annotations/browse');
      setBrowser(r);
      setShowBrowser(true);
    });

  const browseTo = (d) =>
    guard(async () => {
      const r = await api('/api/annotations/browse?dir=' + encodeURIComponent(d));
      setBrowser(r);
    });

  const pickFile = (dir, name) => {
    const full = dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + '\\' + name;
    setFile(full);
    setShowBrowser(false);
    // 选完直接加载
    guard(async () => {
      setLoading(true);
      setPreview(null);
      try {
        const r = await api('/api/annotations/load?file=' + encodeURIComponent(full) + '&limit=1000');
        setPreview(r);
        await refreshList(full);
      } catch (e) {
        setPreview({ loadError: e.message });
      } finally {
        setLoading(false);
      }
    });
  };

  const doAdd = () =>
    guard(async () => {
      if (!body.trim()) return;
      await api('/api/annotations', {
        method: 'POST',
        body: { file, body, kind, line: line ? Number(line) : undefined },
      });
      setBody('');
      setLine('');
      await refreshList(file);
      await refreshTodos();
    });

  const toggleTodo = (a) =>
    guard(async () => {
      await api('/api/annotations/' + encodeURIComponent(a.id), {
        method: 'PATCH',
        body: { file, done: !a.done },
      });
      await refreshList(file);
      await refreshTodos();
    });

  const removeAnn = (a) =>
    guard(async () => {
      const ok = await dialog({ title: '删除这条批注？', message: a.body.slice(0, 80), danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/annotations/' + encodeURIComponent(a.id) + '?file=' + encodeURIComponent(file), { method: 'DELETE' });
      await refreshList(file);
      await refreshTodos();
    });

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <input
          value={file}
          onChange={(e) => setFile(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doLoad(); }}
          placeholder="目标文件绝对路径，例：D:\proj\src\index.js"
          style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, Consolas, monospace' }}
        />
        <button className="btn small ghost" onClick={openBrowser}>浏览…</button>
        <button className="btn small" onClick={doLoad} disabled={loading || !file.trim()}>{loading ? '加载中…' : '加载'}</button>
      </div>

      {showBrowser && browser && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="colhead">
            <span>浏览：{browser.dir}</span>
            <button className="btn small ghost" onClick={() => setShowBrowser(false)}>收起</button>
          </div>
          <div style={{ padding: '6px 12px', maxHeight: 260, overflowY: 'auto' }}>
            {browser.parent && (
              <div className="row" style={{ cursor: 'pointer' }} onClick={() => browseTo(browser.parent)}>
                <div className="name">↰ 上级</div>
                <div className="desc muted mono" style={{ fontSize: 11 }}>{browser.parent}</div>
              </div>
            )}
            {browser.dirs.map((d) => (
              <div key={'d_' + d} className="row" style={{ cursor: 'pointer' }} onClick={() => browseTo(browser.dir.endsWith('\\') || browser.dir.endsWith('/') ? browser.dir + d : browser.dir + '\\' + d)}>
                <div className="name" style={{ width: 30, flexShrink: 0 }}>[D]</div>
                <div className="desc mono">{d}/</div>
              </div>
            ))}
            {browser.files.map((f) => (
              <div key={'f_' + f} className="row" style={{ cursor: 'pointer' }} onClick={() => pickFile(browser.dir, f)}>
                <div className="name" style={{ width: 30, flexShrink: 0 }}></div>
                <div className="desc mono">{f}</div>
              </div>
            ))}
            {browser.filesTruncated && <div className="muted" style={{ padding: '4px 0', fontSize: 12 }}>…（文件过多已截断）</div>}
          </div>
        </div>
      )}

      {preview && !preview.loadError && (
        <div className="card">
          <div className="colhead">
            <span>文件预览</span>
            <span className="muted">
              {preview.totalChars} 字符 · {preview.lineCount} 行
              {preview.window ? ` · 已加载 ${preview.body.length}` : ''}
            </span>
          </div>
          <pre style={{ margin: '0 12px', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, maxHeight: 360, overflowY: 'auto' }}>{preview.body}</pre>
          <div className="toolbar" style={{ padding: '6px 12px 10px' }}>
            {preview.hasMore ? (
              <button className="btn small ghost" onClick={doLoadMore} disabled={loadingMore}>
                {loadingMore ? '加载中…' : `加载更多（还剩 ${preview.totalChars - preview.nextOffset} 字符）`}
              </button>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>已到文件末尾</span>
            )}
          </div>
        </div>
      )}
      {preview?.loadError && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ padding: '10px 12px' }}>
            <span className="tag bad">加载失败</span>
            <span className="muted" style={{ marginLeft: 8 }}>{preview.loadError}</span>
          </div>
        </div>
      )}

      {file && (
        <div className="card">
          <div className="colhead">
            <span>批注</span>
            <span className="muted">{list ? `${list.length} 条` : ''}</span>
          </div>
          <div className="toolbar" style={{ padding: '8px 12px', flexWrap: 'wrap', gap: 6 }}>
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ height: 32 }}>
              <option value="note">思考</option>
              <option value="review">评价</option>
              <option value="todo">待办</option>
            </select>
            <input value={line} onChange={(e) => setLine(e.target.value.replace(/\D/g, ''))}
              placeholder="行号(可选)" style={{ width: 90 }} />
            <input value={body} onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doAdd(); }}
              placeholder={kind === 'todo' ? '要做什么…' : kind === 'review' ? '评价…' : '想法…'}
              style={{ flex: 1, minWidth: 120 }} />
            <button className="btn small" onClick={doAdd} disabled={!body.trim()}>添加</button>
          </div>
          {!list ? <div className="empty">加载文件后显示</div>
            : list.length === 0 ? <div className="empty">（还没有批注）</div>
            : list.map((a) => (
              <div key={a.id} className="row">
                {a.kind === 'todo'
                  ? <input type="checkbox" checked={!!a.done} onChange={() => toggleTodo(a)} style={{ height: 'auto', flexShrink: 0 }} />
                  : <span className="tag" style={{ flexShrink: 0 }}>{KIND_TAG[a.kind]}</span>}
                <div className="name" style={{ width: 52, flexShrink: 0 }}>{a.id}</div>
                {a.line ? <span className="muted mono" style={{ flexShrink: 0, fontSize: 11 }}>L{a.line}</span> : null}
                <div className="desc" style={{ textDecoration: a.done ? 'line-through' : 'none', opacity: a.done ? 0.55 : 1 }}>{a.body}</div>
                <div className="acts">
                  <button className="btn small ghost" onClick={() => setViewing(a)}>详情</button>
                  <button className="btn small ghost danger" onClick={() => removeAnn(a)}>删</button>
                </div>
              </div>
            ))}
        </div>
      )}

      <div className="card">
        <div className="colhead">
          <span>跨文件待办</span>
          <span className="muted">{todos ? `${todos.length} 项未完成` : ''}</span>
        </div>
        {!todos ? <div className="empty">加载中…</div>
          : todos.length === 0 ? <div className="empty">（没有未完成的 todo）</div>
          : todos.map((a) => (
            <div key={a.id} className="row">
              <div className="name mono" style={{ fontSize: 11, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.file}>{a.file}{a.line ? ':L' + a.line : ''}</div>
              <div className="desc">{a.body}</div>
            </div>
          ))}
      </div>

      {viewing && (
        <Modal title={KIND_TAG[viewing.kind] + ' · ' + viewing.id} onClose={() => setViewing(null)}>
          <p className="muted mono" style={{ fontSize: 11, marginBottom: 8 }}>
            {viewing.file}{viewing.line ? ' :L' + viewing.line : ''} · {viewing.createdAt}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 }}>{viewing.body}</pre>
        </Modal>
      )}
      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="annotations" />
      </div>
    </div>
  );
}

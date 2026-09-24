// 文件批注面板：IDE 三栏布局。
//
// ─ 左 ─ 中 ─ 右 ─
// 左 280px：cwd 目录树（可展开/折叠）；点节点切换中栏选中；
//           节点 hover 露出「+批注」按钮，可挂目录批注。
// 中 1fr：当前选中的「文件预览」或「目录概览」（子项列表）。
// 右 360px：当前路径的批注列表 + 新增表单；底部折叠区显示跨文件待办。
//
// 渐进策略（性能优先）：
//   - 文件内容按窗口切片加载：首屏 1000 字符，「加载更多」每次 +3000
//   - 目录树按需 lazy-load：每个节点点开才查其子项，绝不做整树递归
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Modal, useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const KIND_TAG = { review: '评价', todo: '待办', note: '思考' };
const KIND_DOT = { review: '#3a8', todo: '#e83', note: '#888' };

// 把路径拼成子项的完整绝对路径（统一正反斜杠）。
function joinPath(dir, name) {
  if (!dir) return name;
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + '\\' + name;
}

// 路径最后一段名字（用于面包屑/树节点的 label）。
function baseName(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export default function AnnotationsView() {
  // ─── 选中态 ───
  const [selected, setSelected] = useState(null); // 中栏当前展示的绝对路径
  const [preview, setPreview] = useState(null);   // load 结果（文件 body 或目录概览）
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // ─── 右侧批注 ───
  const [list, setList] = useState(null);
  const [kind, setKind] = useState('note');
  const [body, setBody] = useState('');
  const [line, setLine] = useState('');
  const [todos, setTodos] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [showTodosPanel, setShowTodosPanel] = useState(true);

  // ─── 左侧目录树 ───
  // 树节点 = { path, name, loaded, expanded, dirs: [节点], files: [节点] }
  // loaded = true 表示已 readdir 过；展开才发请求。
  const [hoveredPath, setHoveredPath] = useState(null);

  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  // ─── 数据刷新 ───
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

  // ─── 选中某条路径 → 加载预览 + 拉批注 ───
  const selectPath = useCallback((p) =>
    guard(async () => {
      if (!p) return;
      setSelected(p);
      setLoading(true);
      setPreview(null);
      try {
        const r = await api('/api/annotations/load?file=' + encodeURIComponent(p) + '&limit=1000');
        setPreview(r);
        await refreshList(p);
      } catch (e) {
        setPreview({ loadError: e.message });
      } finally {
        setLoading(false);
      }
    }), [guard, refreshList]);

  // 渐进追加文件内容（窗口模式续传）。
  const doLoadMore = () =>
    guard(async () => {
      if (!preview?.hasMore) return;
      setLoadingMore(true);
      try {
        const r = await api('/api/annotations/load?file=' + encodeURIComponent(selected)
          + '&offset=' + preview.nextOffset + '&limit=3000');
        setPreview((prev) => ({ ...prev, body: prev.body + r.body, hasMore: r.hasMore, nextOffset: r.nextOffset }));
      } catch (e) {
        toast('加载失败: ' + e.message);
      } finally {
        setLoadingMore(false);
      }
    });

  // ─── 目录树：初始构建 + 展开节点 ───
  // 服务端给的是平铺 readdir；前端递归渲染成树。
  // 每个目录节点点开才向服务端请求其直接子项（lazy-load）。
  // 从一次 /browse 的结果直接造节点，不再二次请求同路径。
  const buildNode = useCallback((r) => ({
    path: r.dir,
    name: baseName(r.dir),
    loaded: true,        // 根自带数据
    expanded: false,
    dirs: r.dirs.map((d) => ({
      path: joinPath(r.dir, d), name: d, loaded: false, expanded: false, dirs: [], files: [],
    })),
    files: r.files.map((f) => ({ path: joinPath(r.dir, f), name: f })),
  }), []);

  // 用 lazy initializer 加载根目录树：只在挂载时跑一次。
  // 不再走 useEffect——后者会因为 deps 变化/严格模式双调用反复触发，
  // 把 toggleDir 展开的子树整个清掉。
  const [tree, setTree] = useState(null);
  const [cwd, setCwd] = useState(null);
  useState(() => {
    (async () => {
      try {
        const root = await api('/api/annotations/browse');
        setCwd(root.dir);
        setTree(buildNode(root));
      } catch { /* 静默：树没拿到就显示「加载中…」 */ }
    })();
    return null; // 该 useState 不存值
  });

  // ↻ 按钮：用户主动刷新根目录——此时整棵树重新加载是可接受的。
  const refreshCwd = useCallback(async () => {
    try {
      const root = await api('/api/annotations/browse');
      setCwd(root.dir);
      setTree(buildNode(root));
    } catch { /* 静默 */ }
  }, [buildNode]);

  // 展开/折叠：未加载则先读 dir；已加载则翻转 expanded。
  // 注意：setTree 的 updater 必须同步返回新树对象。我们用闭包变量 t
  // 在 await 后手动 setTree，而不是传 async updater（React 不接受）——
  // async updater 会被忽略，导致「点了展开但状态不变」。
  // 防御性检查 parentPath：undefined 直接 no-op，避免把 "undefined" 字面量
  // 当路径发给服务端（旧版曾因 useEffect 重渲触发过此类请求）。
  const toggleDir = (parentPath) => {
    if (!parentPath) return;
    guard(async () => {
      const update = (node) => {
        if (node.path === parentPath) {
          if (!node.loaded) {
            // 异步分支：先翻转 expanded 让 UI 立刻给反馈，
            // 然后异步加载子项再用 functional setTree 替换该节点。
            const markLoading = { ...node, expanded: true };
            (async () => {
              try {
                const r = await api('/api/annotations/browse?dir=' + encodeURIComponent(parentPath));
                setTree((t) => {
                  if (!t) return t;
                  const patch = (n) => {
                    if (n.path === parentPath) {
                      return { ...n, loaded: true, dirs: r.dirs.map((d) => ({
                        path: joinPath(r.dir, d), name: d, loaded: false, expanded: false, dirs: [], files: [],
                      })), files: r.files.map((f) => ({ path: joinPath(r.dir, f), name: f })) };
                    }
                    if (n.dirs?.length) return { ...n, dirs: n.dirs.map(patch) };
                    return n;
                  };
                  return patch(t);
                });
              } catch (e) { toast('展开失败: ' + e.message); }
            })();
            return markLoading;
          }
          return { ...node, expanded: !node.expanded };
        }
        if (node.dirs?.length) {
          return { ...node, dirs: node.dirs.map(update) };
        }
        return node;
      };
      setTree((t) => t ? update(t) : t);
    });
  };

  // 给指定节点追加一条批注（目录/文件都走这条路；form 在右侧）。
  const doAdd = () =>
    guard(async () => {
      if (!body.trim() || !selected) return;
      await api('/api/annotations', {
        method: 'POST',
        body: { file: selected, body, kind, line: line ? Number(line) : undefined },
      });
      setBody('');
      setLine('');
      await refreshList(selected);
      await refreshTodos();
    });

  // 在左侧目录树上直接给某个目录挂批注：复用右侧表单，但 target 切换到 hover 的目录。
  const addForDir = (dirPath) =>
    guard(async () => {
      const text = window.prompt('给目录 ' + dirPath + ' 加一条批注：');
      if (!text || !text.trim()) return;
      const k = window.prompt('类型？note / review / todo（回车默认 note）') || 'note';
      await api('/api/annotations', {
        method: 'POST',
        body: { file: dirPath, body: text.trim(), kind: k },
      });
      toast('已添加批注到目录');
      // 如果该目录就是当前选中，刷新右侧列表；否则只刷新跨文件待办。
      if (selected === dirPath) await refreshList(dirPath);
      await refreshTodos();
    });

  const toggleTodo = (a) =>
    guard(async () => {
      await api('/api/annotations/' + encodeURIComponent(a.id), {
        method: 'PATCH',
        body: { file: a.file, done: !a.done },
      });
      await refreshList(selected);
      await refreshTodos();
    });

  const removeAnn = (a) =>
    guard(async () => {
      const ok = await dialog({ title: '删除这条批注？', message: a.body.slice(0, 80), danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/annotations/' + encodeURIComponent(a.id) + '?file=' + encodeURIComponent(a.file), { method: 'DELETE' });
      await refreshList(a.file);
      await refreshTodos();
    });

  // 树渲染：递归。
  const renderNode = (node, depth) => {
    const isHovered = hoveredPath === node.path;
    const isSelected = selected === node.path;
    return (
      <div key={node.path}>
        <div
          className="tree-row"
          onMouseEnter={() => setHoveredPath(node.path)}
          onMouseLeave={() => setHoveredPath(null)}
          onClick={() => { setSelected(node.path); /* 默认不展开——点箭头才展开 */ }}
          style={{
            paddingLeft: 8 + depth * 14,
            display: 'flex', alignItems: 'center', gap: 4,
            cursor: 'pointer',
            background: isSelected ? 'var(--accent-soft, rgba(80,140,200,0.12))' : 'transparent',
            borderRadius: 3, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12,
            lineHeight: '22px',
          }}
        >
          <span
            onClick={(e) => { e.stopPropagation(); toggleDir(node.path); }}
            style={{ width: 14, display: 'inline-block', textAlign: 'center', color: 'var(--muted)', userSelect: 'none' }}
            title={node.expanded ? '折叠' : '展开'}
          >{node.loaded ? (node.expanded ? '▾' : '▸') : '▸'}</span>
          <span style={{ color: 'var(--muted)', flexShrink: 0 }}>📁</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={node.path}>{node.name}</span>
          {isHovered && (
            <button
              className="btn small ghost"
              onClick={(e) => { e.stopPropagation(); addForDir(node.path); }}
              style={{ padding: '0 6px', fontSize: 11 }}
              title="给这个目录挂批注"
            >+批注</button>
          )}
        </div>
        {node.expanded && node.dirs.map((d) => renderNode(d, depth + 1))}
        {node.expanded && node.files.map((f) => {
          const fileHovered = hoveredPath === f.path;
          const fileSelected = selected === f.path;
          return (
            <div
              key={f.path}
              className="tree-row"
              onMouseEnter={() => setHoveredPath(f.path)}
              onMouseLeave={() => setHoveredPath(null)}
              onClick={() => selectPath(f.path)}
              style={{
                paddingLeft: 8 + (depth + 1) * 14,
                display: 'flex', alignItems: 'center', gap: 4,
                cursor: 'pointer',
                background: fileSelected ? 'var(--accent-soft, rgba(80,140,200,0.12))' : 'transparent',
                borderRadius: 3, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: '22px',
              }}
            >
              <span style={{ width: 14, display: 'inline-block' }}></span>
              <span style={{ color: 'var(--muted)', flexShrink: 0 }}>📄</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.path}>{f.name}</span>
              {fileHovered && (
                <button
                  className="btn small ghost"
                  onClick={(e) => { e.stopPropagation(); addForDir(f.path); }}
                  style={{ padding: '0 6px', fontSize: 11 }}
                  title="给这个文件挂批注"
                >+批注</button>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // 顶部面包屑：路径每段可点回退（直接调 selectPath 即跳到该目录预览）。
  const crumbs = useMemo(() => {
    if (!selected) return [];
    const parts = selected.split(/[\\/]/).filter(Boolean);
    // 拼出从盘符起的绝对路径前缀
    const out = [];
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 && /^[A-Za-z]:$/.test(parts[0]) ? parts[0] + '\\' : (acc ? acc + '\\' + parts[i] : parts[i]);
      out.push({ name: parts[i], path: acc });
    }
    return out;
  }, [selected]);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '280px 1fr 360px',
      gap: 12,
      minHeight: 480,
    }}>
      {/* ─── 左栏：目录树 ─── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="colhead" style={{ flexShrink: 0 }}>
          <span>工作树</span>
          <button className="btn small ghost" onClick={refreshCwd} title="刷新根目录">↻</button>
        </div>
        <div style={{ fontSize: 11, padding: '4px 12px', color: 'var(--muted)', borderBottom: '1px solid var(--border)', fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cwd}>{cwd}</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 4px' }}>
          {!tree ? <div className="empty">加载中…</div>
            : renderNode(tree, 0)}
        </div>
      </div>

      {/* ─── 中栏：文件预览 / 目录概览 ─── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="colhead" style={{ flexShrink: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {preview?.isDirectory ? '目录概览' : preview?.loadError ? '加载失败' : (selected ? baseName(selected) : '请在左侧选择一个文件或目录')}
          </span>
          {selected && <span className="muted" style={{ fontSize: 11 }}>{selected}</span>}
        </div>
        {/* 面包屑：路径每段可点跳转 */}
        {crumbs.length > 1 && (
          <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {crumbs.map((c, i) => (
              <span key={'crumb_' + i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <span className="muted">/</span>}
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); selectPath(c.path); }}
                  style={{
                    color: i === crumbs.length - 1 ? 'var(--fg)' : 'var(--accent)',
                    textDecoration: i === crumbs.length - 1 ? 'none' : 'underline',
                    cursor: 'pointer',
                  }}
                  title={c.path}
                >{c.name}</a>
              </span>
            ))}
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
          {loading && <div className="empty">加载中…</div>}
          {preview?.loadError && <div><span className="tag bad">错误</span> <span className="muted">{preview.loadError}</span></div>}
          {preview && !preview.loadError && preview.isDirectory && (
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{preview.totalDirs} 个子目录 · {preview.totalFiles} 个文件</div>
              {preview.dirs.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>目录</div>
                  {preview.dirs.map((d) => {
                    const full = joinPath(selected, d);
                    return (
                      <div key={'pd_' + d} onClick={() => { selectPath(full); toggleDir(selected); }} style={{ padding: '2px 6px', cursor: 'pointer', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>📁 {d}/</div>
                    );
                  })}
                </div>
              )}
              {preview.files.length > 0 && (
                <div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>文件</div>
                  {preview.files.map((f) => {
                    const full = joinPath(selected, f);
                    return (
                      <div key={'pf_' + f} onClick={() => selectPath(full)} style={{ padding: '2px 6px', cursor: 'pointer', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>📄 {f}</div>
                    );
                  })}
                  {preview.filesTruncated && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>…（文件过多已截断）</div>}
                </div>
              )}
              {preview.dirs.length === 0 && preview.files.length === 0 && <div className="empty">（空目录）</div>}
            </div>
          )}
          {preview && !preview.loadError && !preview.isDirectory && (
            <div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>{preview.body}</pre>
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {preview.totalChars != null && <span className="muted">{preview.totalChars} 字符 · {preview.lineCount} 行{preview.window ? ` · 已加载 ${preview.body?.length ?? 0}` : ''}</span>}
              </div>
              <div style={{ marginTop: 6 }}>
                {preview.hasMore ? (
                  <button className="btn small ghost" onClick={doLoadMore} disabled={loadingMore}>
                    {loadingMore ? '加载中…' : `加载更多（还剩 ${preview.totalChars - preview.nextOffset} 字符）`}
                  </button>
                ) : preview.window ? (
                  <span className="muted" style={{ fontSize: 12 }}>已到文件末尾</span>
                ) : null}
              </div>
            </div>
          )}
          {!preview && !loading && <div className="empty">从左侧选个文件或目录开始</div>}
        </div>
      </div>

      {/* ─── 右栏：批注 + 跨文件待办 ─── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div className="colhead" style={{ flexShrink: 0 }}>
          <span>批注 {selected ? `· ${baseName(selected)}` : ''}</span>
          <span className="muted">{list ? `${list.length} 条` : ''}</span>
        </div>
        {selected && (
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ height: 28, fontSize: 12 }}>
                <option value="note">思考</option>
                <option value="review">评价</option>
                <option value="todo">待办</option>
              </select>
              {!preview?.isDirectory && (
                <input value={line} onChange={(e) => setLine(e.target.value.replace(/\D/g, ''))}
                  placeholder="行号" style={{ width: 60, fontSize: 12 }} />
              )}
              <input value={body} onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doAdd(); }}
                placeholder={kind === 'todo' ? '要做什么…' : kind === 'review' ? '评价…' : '想法…'}
                style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
              <button className="btn small" onClick={doAdd} disabled={!body.trim()}>添加</button>
            </div>
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {!selected ? <div className="empty">选中文件或目录后查看批注</div>
            : !list ? <div className="empty">加载中…</div>
            : list.length === 0 ? <div className="empty">（还没有批注——在左侧 hover 节点也可直接挂）</div>
            : list.map((a) => (
              <div key={a.id} className="row" style={{ alignItems: 'flex-start' }}>
                {a.kind === 'todo'
                  ? <input type="checkbox" checked={!!a.done} onChange={() => toggleTodo(a)} style={{ height: 'auto', flexShrink: 0, marginTop: 4 }} />
                  : <span className="tag" style={{ flexShrink: 0, background: KIND_DOT[a.kind], color: '#fff', fontSize: 10 }}>{KIND_TAG[a.kind]}</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                    {a.id}{a.line ? ` · L${a.line}` : ''}
                  </div>
                  <div style={{ fontSize: 12, textDecoration: a.done ? 'line-through' : 'none', opacity: a.done ? 0.55 : 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.body}</div>
                </div>
                <div className="acts" style={{ flexShrink: 0 }}>
                  <button className="btn small ghost" onClick={() => setViewing(a)}>详情</button>
                  <button className="btn small ghost danger" onClick={() => removeAnn(a)}>删</button>
                </div>
              </div>
            ))}
        </div>
        {/* 跨文件待办：折叠区，不抢主屏空间 */}
        <div style={{ borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          <div className="colhead" style={{ cursor: 'pointer' }} onClick={() => setShowTodosPanel(!showTodosPanel)}>
            <span>跨文件待办 {todos ? `(${todos.length})` : ''}</span>
            <span className="muted">{showTodosPanel ? '▾' : '▸'}</span>
          </div>
          {showTodosPanel && (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {!todos ? <div className="empty">加载中…</div>
                : todos.length === 0 ? <div className="empty">（没有未完成的 todo）</div>
                : todos.map((a) => (
                  <div key={a.id} className="row" onClick={() => selectPath(a.file)} style={{ cursor: 'pointer' }} title="跳到该文件">
                    <input type="checkbox" checked={false} readOnly style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.file}>{baseName(a.file)}{a.line ? `:L${a.line}` : ''}</div>
                      <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.body}</div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
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
      <div style={{ gridColumn: '1 / -1', marginTop: 12 }}>
        <CliHints module="annotations" />
      </div>
    </div>
  );
}

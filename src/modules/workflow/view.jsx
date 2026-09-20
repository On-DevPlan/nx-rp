// workflow 面板：JSON 编辑 + 实时校验 + apply 到当前 cwd scope。
//
// v1 设计：不做可视化有向图画布（React Flow 体积大、且画布不是核心）。先把
// 「JSON 编辑 → validate → apply」闭环做稳——这是 agent 编辑工作流的核心，
// 也是用户最常用的一条路径。
//
// 后续可在此基础上加 React Flow 画布：左边 palette（4 种节点模板）+ 中间画布 +
// 右边属性表单。但核心仍走 JSON 文件——画布只是可视化的甜点，不替代 JSON。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';

const STARTER = JSON.stringify({
  version: 1,
  name: 'demo',
  type: 'pipeline',
  nodes: [
    { id: 'a', kind: 'agent-call', command: 'claude', prompt: '介绍 nx-rp 是什么' },
  ],
  edges: [],
}, null, 2);

export default function WorkflowView() {
  const { boot } = useStore();
  const [list, setList] = useState(null);
  const [body, setBody] = useState(STARTER);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const scopeKey = boot?.cwdScope || '';

  const refresh = useCallback(async () => {
    setList(await api('/api/workflows'));
  }, []);

  useEffect(() => { refresh().catch(() => setList([])); }, [refresh]);

  // 实时校验：解析 + 校验，把结果显在面板里。
  useEffect(() => {
    try {
      const o = JSON.parse(body);
      const required = ['name', 'type', 'nodes', 'edges'];
      const missing = required.filter((k) => !(k in o));
      if (missing.length) { setError('缺字段: ' + missing.join(', ')); setPreview(null); return; }
      const typeOk = ['graph', 'pipeline', 'agent-call', 'http'].includes(o.type);
      if (!typeOk) { setError(`非法 type: ${o.type}`); setPreview(null); return; }
      setError(null);
      setPreview({ name: o.name, type: o.type, nodes: Array.isArray(o.nodes) ? o.nodes.length : 0, edges: Array.isArray(o.edges) ? o.edges.length : 0 });
    } catch (e) {
      setError('JSON 解析失败: ' + (e.message || e));
      setPreview(null);
    }
  }, [body]);

  const load = (w) =>
    guard(async () => {
      const full = await api('/api/workflows/' + encodeURIComponent(w.name));
      setBody(JSON.stringify(full, null, 2));
      toast('已加载 ' + w.name);
    });

  const remove = (w) =>
    guard(async () => {
      const ok = await dialog({ title: `删除「${w.name}」？`, danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/workflows/' + encodeURIComponent(w.name), { method: 'DELETE' });
      toast('已删除');
      await refresh();
    });

  const apply = () =>
    guard(async () => {
      if (error) { toast('JSON 校验失败，请先修正'); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) { toast('JSON 解析失败: ' + e.message); return; }
      try {
        await api('/api/workflows/apply', { method: 'POST', body: parsed });
        toast('已写入当前 cwd scope');
        await refresh();
      } catch (e) {
        if (String(e.message).includes('INVALID_INPUT') || String(e.message).includes('缺少')) {
          toast('校验失败: ' + e.message);
        } else {
          toast('写入失败: ' + e.message);
        }
      }
    });

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn small primary" onClick={apply} disabled={!!error}>应用到当前 scope</button>
        <button className="btn small ghost" onClick={() => setBody(STARTER)}>重置</button>
        <span style={{ flex: 1 }} />
        <span className="muted">scope: <code>{scopeKey}</code></span>
      </div>

      <div className="cols" style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14, alignItems: 'flex-start' }}>
        <div className="card">
          <div className="colhead"><span>已保存</span><span className="muted">{list ? `${list.length} 条` : ''}</span></div>
          {!list ? <div className="empty">加载中…</div>
            : list.length === 0 ? <div className="empty">（暂无）</div>
            : list.map((w) => (
              <div key={w.name} className="row" style={{ gap: 6 }}>
                <div className="name" style={{ flex: 1 }}>
                  <div>{w.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{w.type} · {w.nodes} 节 / {w.edges} 边</div>
                </div>
                <div className="acts">
                  <button className="btn small ghost" onClick={() => load(w)}>加载</button>
                  <button className="btn small ghost danger" onClick={() => remove(w)}>删除</button>
                </div>
              </div>
            ))}
        </div>

        <div className="card">
          <div className="colhead">
            <span>工作流定义（JSON）</span>
            <span className="muted">
              {error
                ? <span className="bad">{error}</span>
                : preview
                  ? <span>通过 · {preview.nodes} 节点 / {preview.edges} 边 · {preview.type}</span>
                  : '编辑中…'}
            </span>
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={20}
            style={{
              width: '100%', padding: 12, fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 13, border: 'none', outline: 'none', resize: 'vertical',
              background: 'var(--paper)',
            }}
          />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <CliHints module="workflow" />
      </div>
      {dialogNode}
    </div>
  );
}
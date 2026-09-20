// workflow 面板：JSON 编辑 + React Flow 画布（双向同步）。
//
// 三栏布局 + 底部 JSON 折叠：
//   左 palette（4 种节点模板，拖入画布）
//   中 ReactFlow 画布（自定义节点按 kind 渲染）
//   右 选中节点的属性表单（按 kind 推导字段）
//   底 JSON 预览（折叠；点击展开看原始 JSON 与校验状态）
//
// 双向同步：画布上拖拽 / 移动 / 连线 → 写回 body 字符串 → 实时校验。
// JSON 修改（手敲）也会反映到画布——但只在受控模式下做：画布是「真」，JSON 是「投影」。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, MiniMap, Position,
  ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges,
} from '@xyflow/react';
import { api } from '../../web/frontend/api/client.js';
import { useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';

const STARTER = JSON.stringify({
  version: 1, name: 'demo', type: 'pipeline',
  nodes: [{ id: 'a', kind: 'nxAction', actionId: 'link.list' }],
  edges: [],
}, null, 2);

// ─── 节点模板（palette 显示） ──────────────────────────────────────────

const PALETTE = [
  { kind: 'nxAction',  label: 'nxAction',  desc: '调用 nx-rp 自身的命令',
    defaults: () => ({ id: '', kind: 'nxAction', actionId: 'link.list' }) },
  { kind: 'agent-call', label: 'agent-call', desc: '调外部 agent CLI（claude / codex 等）',
    defaults: () => ({ id: '', kind: 'agent-call', command: 'claude', prompt: '' }) },
  { kind: 'http',      label: 'http',       desc: '调任意 HTTP 端点',
    defaults: () => ({ id: '', kind: 'http', method: 'GET', url: '', headers: {}, body: '' }) },
];

// ─── 画布上的自定义节点 ──────────────────────────────────────────────

function CanvasNode({ data, selected }) {
  return (
    <div className={'wf-canvas-node' + (selected ? ' selected' : '')}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-canvas-node-kind">{data.kind}</div>
      <div className="wf-canvas-node-title">{labelFor(data)}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function labelFor(d) {
  if (d.kind === 'nxAction') return d.actionId || '(no actionId)';
  if (d.kind === 'agent-call') return `${d.command || '?'}: ${(d.prompt || '').slice(0, 18)}`;
  if (d.kind === 'http') return `${d.method || 'GET'} ${d.url || ''}`;
  return d.id || '?';
}

const NODE_TYPES = { nxAction: CanvasNode, 'agent-call': CanvasNode, http: CanvasNode };

// ─── 校验（与 service.parseWorkflow 同形，但只读不抛） ────────────────

const WORKFLOW_TYPES = new Set(['graph', 'pipeline', 'agent-call', 'http']);
const NODE_KINDS = new Set(['nxAction', 'agent-call', 'http']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function validateBody(body) {
  try {
    const o = JSON.parse(body);
    if (!o || typeof o !== 'object') return 'JSON 必须是对象';
    if (!o.name) return '缺 name';
    if (!WORKFLOW_TYPES.has(o.type)) return 'type 必须是 graph / pipeline / agent-call / http';
    if (!Array.isArray(o.nodes)) return 'nodes 必须是数组';
    if (!Array.isArray(o.edges)) return 'edges 必须是数组';
    const seen = new Set();
    for (const n of o.nodes) {
      if (!n.id) return '节点缺 id';
      if (seen.has(n.id)) return '重复节点 id: ' + n.id;
      seen.add(n.id);
      if (!NODE_KINDS.has(n.kind)) return `节点 ${n.id} 的 kind 非法: ${n.kind}`;
      if (n.kind === 'nxAction' && !n.actionId) return `nxAction 节点 ${n.id} 缺 actionId`;
      if (n.kind === 'agent-call' && !n.command) return `agent-call 节点 ${n.id} 缺 command`;
      if (n.kind === 'http' && !n.url) return `http 节点 ${n.id} 缺 url`;
      if (n.kind === 'http' && n.method && !HTTP_METHODS.has(String(n.method).toUpperCase())) {
        return `http 节点 ${n.id} 的 method 非法`;
      }
    }
    for (const e of o.edges) {
      if (!seen.has(e.source) || !seen.has(e.target)) return `边的端点引用了不存在的节点`;
    }
    return null;
  } catch (e) {
    return 'JSON 解析失败: ' + (e.message || e);
  }
}

// ─── 主面板 ──────────────────────────────────────────────────────────

export default function WorkflowView() {
  return (
    <ReactFlowProvider>
      <WorkflowInner />
    </ReactFlowProvider>
  );
}

function WorkflowInner() {
  const { boot } = useStore();
  const [list, setList] = useState(null);
  const [body, setBody] = useState(STARTER);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [showJson, setShowJson] = useState(false);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const scopeKey = boot?.cwdScope || '';
  const wrapperRef = useRef(null);

  const error = useMemo(() => validateBody(body), [body]);
  const parsed = useMemo(() => {
    if (error) return null;
    try { return JSON.parse(body); } catch { return null; }
  }, [body, error]);

  const nodes = useMemo(() => (parsed?.nodes || []).map(toRfNode), [parsed]);
  const edges = useMemo(() => (parsed?.edges || []).map(toRfEdge), [parsed]);

  const refresh = useCallback(async () => {
    setList(await api('/api/workflows'));
  }, []);
  useEffect(() => { refresh().catch(() => setList([])); }, [refresh]);

  // 选中节点
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return (parsed?.nodes || []).find((n) => n.id === selectedNodeId) || null;
  }, [selectedNodeId, parsed]);

  // ── 画布事件 ────────────────────────────────────────────────────

  const onNodesChange = useCallback((changes) => {
    setBody((cur) => patchNodes(JSON.parse(cur), changes));
  }, []);

  const onEdgesChange = useCallback((changes) => {
    setBody((cur) => patchEdges(JSON.parse(cur), changes));
  }, []);

  const onConnect = useCallback((c) => {
    setBody((cur) => {
      const o = JSON.parse(cur);
      o.edges = addEdge({ ...c, id: `${c.source}->${c.target}` }, o.edges || []);
      return JSON.stringify(o, null, 2);
    });
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/x-nx-node');
    if (!raw) return;
    const tmpl = JSON.parse(raw);
    const rect = wrapperRef.current.getBoundingClientRect();
    const id = newId(parsed?.nodes || []);
    setBody((cur) => {
      const o = JSON.parse(cur);
      o.nodes = o.nodes || [];
      o.nodes.push({
        id,
        kind: tmpl.kind,
        position: { x: Math.round(e.clientX - rect.left - 60), y: Math.round(e.clientY - rect.top - 24) },
        ...defaultsFor(tmpl.kind),
        // 已有 defaults 字段优先（拖出来已经是完整节点）
      });
      // 把 tmpl 的字段也写进来
      for (const k of Object.keys(tmpl)) {
        if (k !== 'kind' && tmpl[k] !== undefined) o.nodes[o.nodes.length - 1][k] = tmpl[k];
      }
      return JSON.stringify(o, null, 2);
    });
    setSelectedNodeId(id);
  }, [parsed]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  // ── 选中节点的属性编辑 ──────────────────────────────────────────

  const updateNode = (patch) => {
    if (!selectedNodeId) return;
    setBody((cur) => {
      const o = JSON.parse(cur);
      o.nodes = o.nodes.map((n) => n.id === selectedNodeId ? { ...n, ...patch } : n);
      return JSON.stringify(o, null, 2);
    });
  };

  const removeNode = (id) => {
    setBody((cur) => {
      const o = JSON.parse(cur);
      o.nodes = (o.nodes || []).filter((n) => n.id !== id);
      o.edges = (o.edges || []).filter((e) => e.source !== id && e.target !== id);
      return JSON.stringify(o, null, 2);
    });
    setSelectedNodeId(null);
  };

  // ── CRUD on store ───────────────────────────────────────────────

  const apply = () =>
    guard(async () => {
      if (error || !parsed) { toast('JSON 校验失败：' + error); return; }
      try {
        await api('/api/workflows/apply', { method: 'POST', body: parsed });
        toast('已写入当前 cwd scope');
        await refresh();
      } catch (e) { toast('写入失败: ' + e.message); }
    });

  const load = (w) =>
    guard(async () => {
      const full = await api('/api/workflows/' + encodeURIComponent(w.name));
      setBody(JSON.stringify(full, null, 2));
      setSelectedNodeId(null);
      toast('已加载 ' + w.name);
    });

  const removeWf = (w) =>
    guard(async () => {
      const ok = await dialog({ title: `删除「${w.name}」？`, danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/workflows/' + encodeURIComponent(w.name), { method: 'DELETE' });
      toast('已删除');
      await refresh();
    });

  // ── 渲染 ────────────────────────────────────────────────────────

  return (
    <div className="wf-root">
      <div className="wf-toolbar">
        <button className="btn small primary" onClick={apply} disabled={!!error || !parsed}>应用到当前 scope</button>
        <button className="btn small ghost" onClick={() => { setBody(STARTER); setSelectedNodeId(null); }}>重置</button>
        <span style={{ flex: 1 }} />
        {error
          ? <span className="bad">{error}</span>
          : parsed
            ? <span className="muted">{parsed.name} · {parsed.type} · {nodes.length} 节点 / {edges.length} 边</span>
            : null}
        <button className="btn small ghost" onClick={() => setShowJson((v) => !v)}>{showJson ? '收起 JSON' : '展开 JSON'}</button>
        <span className="muted">scope: <code>{scopeKey}</code></span>
      </div>

      <div className="wf-body">
        <aside className="wf-palette">
          <div className="wf-side-title">palette · 拖到画布</div>
          {PALETTE.map((p) => (
            <div key={p.kind}
              className="wf-palette-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-nx-node', JSON.stringify(p.defaults()));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title={p.desc}>
              <div className="wf-palette-kind">{p.kind}</div>
              <div className="muted" style={{ fontSize: 11 }}>{p.desc}</div>
            </div>
          ))}
        </aside>

        <div className="wf-canvas-wrap" ref={wrapperRef} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedNodeId(n.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="wf-canvas-empty">从左侧 palette 拖一个节点到这里</div>
          )}
        </div>

        <aside className="wf-side">
          {selectedNode
            ? <NodeInspector node={selectedNode} onChange={updateNode} onDelete={() => removeNode(selectedNode.id)} />
            : <SavedList list={list} onLoad={load} onRemove={removeWf} />}
        </aside>
      </div>

      {showJson && (
        <div className="wf-json">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} rows={10}
            style={{ width: '100%', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, padding: 10, border: 'none', outline: 'none', resize: 'vertical' }} />
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <CliHints module="workflow" />
      </div>
      {dialogNode}
    </div>
  );
}

// ─── 工具 ────────────────────────────────────────────────────────────

function newId(nodes) {
  let i = nodes.length + 1;
  while (nodes.some((n) => n.id === 'n' + i)) i++;
  return 'n' + i;
}

function defaultsFor(kind) {
  if (kind === 'nxAction') return { actionId: 'link.list', params: {} };
  if (kind === 'agent-call') return { command: 'claude', prompt: '', params: {} };
  if (kind === 'http') return { method: 'GET', url: '', headers: {}, body: '', params: {} };
  return { params: {} };
}

function toRfNode(n) {
  return {
    id: n.id,
    type: n.kind, // 节点 kind 直接当 ReactFlow node type
    position: n.position || { x: 0, y: 0 },
    data: { ...n },
  };
}

function toRfEdge(e) {
  return {
    id: e.id || `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
  };
}

function patchNodes(o, changes) {
  // 用 rf 的 applyNodeChanges 在我们自己的节点格式上跑——多写一层 adapter
  const rfNodes = (o.nodes || []).map(toRfNode);
  const next = applyNodeChanges(changes, rfNodes);
  o.nodes = next.map((rn) => {
    const orig = (o.nodes || []).find((n) => n.id === rn.id) || {};
    // 删除
    if (rn.type === 'remove' || (changes.find?.((c) => c.id === rn.id && c.type === 'remove'))) return null;
    return { ...orig, id: rn.id, position: rn.position, kind: rn.data.kind };
  }).filter(Boolean);
  return JSON.stringify(o, null, 2);
}

function patchEdges(o, changes) {
  const rfEdges = (o.edges || []).map(toRfEdge);
  const next = applyEdgeChanges(changes, rfEdges);
  // 把 id 映射回我们自己的 id（rf 改的 id 可能不同）
  const idMap = new Map((o.edges || []).map((e) => [`${e.source}->${e.target}`, e.id || `${e.source}->${e.target}`]));
  o.edges = next.map((re) => {
    const id = idMap.get(re.id) || `${re.source}->${re.target}`;
    return { id, source: re.source, target: re.target };
  });
  return JSON.stringify(o, null, 2);
}

// ─── 节点属性检视器 ──────────────────────────────────────────────────

function NodeInspector({ node, onChange, onDelete }) {
  const set = (k, v) => onChange({ [k]: v });
  return (
    <div className="wf-inspector">
      <div className="wf-side-title">
        节点 · {node.id}
        <button className="btn small ghost" style={{ float: 'right' }} onClick={onDelete}>移除</button>
      </div>
      <Field label="id">
        <input value={node.id} onChange={(e) => set('id', e.target.value)} />
      </Field>
      <Field label="kind">
        <select value={node.kind} onChange={(e) => onChange({ kind: e.target.value })}>
          {['nxAction', 'agent-call', 'http'].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </Field>

      {node.kind === 'nxAction' && (
        <Field label="actionId (nx-rp 命令 id)">
          <input value={node.actionId || ''} onChange={(e) => set('actionId', e.target.value)} placeholder="例: link.list" />
        </Field>
      )}
      {node.kind === 'agent-call' && (
        <>
          <Field label="command (agent CLI)">
            <input value={node.command || ''} onChange={(e) => set('command', e.target.value)} placeholder="claude / codex / iflow" />
          </Field>
          <Field label="prompt">
            <textarea value={node.prompt || ''} onChange={(e) => set('prompt', e.target.value)} rows={4}
              style={{ width: '100%', padding: 6, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }} />
          </Field>
        </>
      )}
      {node.kind === 'http' && (
        <>
          <Field label="method">
            <select value={node.method || 'GET'} onChange={(e) => set('method', e.target.value)}>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="url">
            <input value={node.url || ''} onChange={(e) => set('url', e.target.value)} placeholder="https://..." />
          </Field>
          <Field label="headers (JSON)">
            <textarea value={JSON.stringify(node.headers || {}, null, 0)} onChange={(e) => {
              try { set('headers', JSON.parse(e.target.value || '{}')); } catch { /* ignore */ }
            }} rows={2}
              style={{ width: '100%', padding: 6, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }} />
          </Field>
          <Field label="body (字符串)">
            <textarea value={typeof node.body === 'string' ? node.body : JSON.stringify(node.body || '', null, 0)}
              onChange={(e) => set('body', e.target.value)} rows={3}
              style={{ width: '100%', padding: 6, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }} />
          </Field>
        </>
      )}
    </div>
  );
}

function SavedList({ list, onLoad, onRemove }) {
  return (
    <>
      <div className="wf-side-title">已保存</div>
      {!list ? <div className="muted">加载中…</div>
        : list.length === 0 ? <div className="muted">（暂无）</div>
        : list.map((w) => (
          <div key={w.name} className="wf-list-row">
            <div>
              <div>{w.name}</div>
              <div className="muted" style={{ fontSize: 11 }}>{w.type} · {w.nodes} 节 / {w.edges} 边</div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="btn small ghost" onClick={() => onLoad(w)}>加载</button>
              <button className="btn small ghost danger" onClick={() => onRemove(w)}>删除</button>
            </div>
          </div>
        ))}
    </>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}
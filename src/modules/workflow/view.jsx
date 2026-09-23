// workflow 面板：DOT 编辑器（左）+ 画布（右，双击建节点、右键拖拽建边）。
//
// 极简工作流：DOT 文本 = 唯一事实源，画布只是它的可视化。
//   - 编辑区：textarea 单色（专注文本），Ctrl+S 存盘
//   - 画布：ReactFlow 节点以 label 显示（DOT 的 shape 用作形状）
//   - 双击空白 → 弹输入框 → 新节点（直接修改 DOT）
//   - 从节点 A 右键拖到节点 B → 创建 a -> b 边（自动写入 DOT）
//   - 节点删除会从 DOT 同步移除（避免不一致）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, ReactFlowProvider,
  useNodesState, useEdgesState, MarkerType,
} from '@xyflow/react';
import * as dagre from '@dagrejs/dagre';
import { api } from '../../web/frontend/api/client.js';
import { Modal, useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { parseDot } from './service.js';

const DEFAULT_DOT = `digraph workflow {
  start [label="开始", shape=ellipse, fillcolor="#e0f2fe"]
  start -> a
  a [label="节点 A"]
  a -> b
  b [label="节点 B"]
  b -> end
  end [label="结束", shape=ellipse, fillcolor="#dcfce7"]
}
`;

export default function WorkflowView() {
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [dot, setDot] = useState(DEFAULT_DOT);
  const [problems, setProblems] = useState([]);
  const [savedAt, setSavedAt] = useState(null);
  const [creating, setCreating] = useState(null); // { x, y } for new node modal
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const refreshList = useCallback(async () => {
    try { setList(await api('/api/workflows')); } catch { setList([]); }
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  const parsed = useMemo(() => parseDot(dot), [dot]);
  useEffect(() => { setProblems(parsed.errors); }, [parsed.errors]);

  // ── 保存 ──
  const doSave = () =>
    guard(async () => {
      if (!name) return;
      const r = await api('/api/workflows', { method: 'POST', body: { name, body: dot } });
      setSavedAt(Date.now());
      toast('已保存');
      await refreshList();
      if (r.problems?.length) toast(`警告: ${r.problems.length} 个问题`, 'warn');
    });

  const doLoad = (n) =>
    guard(async () => {
      const r = await api('/api/workflows/' + encodeURIComponent(n));
      setName(n);
      setDot(r.source);
      setSavedAt(Date.now());
      toast(`已加载: ${n}`);
    });

  const doDelete = (n) =>
    guard(async () => {
      const ok = await dialog({ title: `删除 workflow「${n}」？`, danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/workflows/' + encodeURIComponent(n), { method: 'DELETE' });
      toast('已删除');
      await refreshList();
    });

  // ── 节点 → 画布 ──
  const nodeTypes = useMemo(() => ({
    dot: NodeRender,
  }), []);

  const rfNodes = useMemo(() => parsed.nodes.map((n) => ({
    id: n.id,
    type: 'dot',
    position: { x: 0, y: 0 }, // 由 dagre 重写
    data: n,
  })), [parsed.nodes]);

  const rfEdges = useMemo(() => parsed.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label || '',
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: '#64748b' },
  })), [parsed.edges]);

  // dagre 布局
  const layouted = useMemo(() => {
    if (rfNodes.length === 0) return { nodes: [], edges: [] };
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 60 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of rfNodes) g.setNode(n.id, { width: 130, height: 40 });
    for (const e of rfEdges) g.setEdge(e.source, e.target);
    dagre.layout(g);
    return {
      nodes: rfNodes.map((n) => {
        const pos = g.node(n.id);
        return { ...n, position: { x: pos.x - 65, y: pos.y - 20 } };
      }),
      edges: rfEdges,
    };
  }, [rfNodes, rfEdges]);

  const [, setNodes, onNodesChange] = useNodesState(layouted.nodes);
  const [, setEdges, onEdgesChange] = useEdgesState(layouted.edges);
  useEffect(() => { setNodes(layouted.nodes); setEdges(layouted.edges); }, [layouted.nodes, layouted.edges, setNodes, setEdges]);

  // ── 双击空白 → 新节点 ──
  const onPaneClick = useCallback((event) => {
    const bounds = event.target.getBoundingClientRect();
    setCreating({
      // 屏幕坐标 → 画布坐标（用 dagre 已有的坐标做近似：直接用屏幕偏移）
      clientX: event.clientX - bounds.left,
      clientY: event.clientY - bounds.top,
    });
  }, []);

  const createNode = (label) => {
    // 生成不冲突的 id：node_1, node_2 ...
    const used = new Set(parsed.nodes.map((n) => n.id));
    let i = 1;
    while (used.has(`node_${i}`)) i++;
    const id = `node_${i}`;
    const attr = label && label !== id ? ` [label="${label.replace(/"/g, '\\"')}"]` : '';
    const newLine = `${id}${attr}`;
    setDot((prev) => prev.replace(/(\s*}\s*)$/, `  ${newLine}\n$1`));
    setCreating(null);
  };

  // ── 右键拖拽：从某节点拖到另一节点 → 创建边 ──
  const dragSource = useRef(null);
  const onNodeContextMenu = useCallback((event, node) => {
    event.preventDefault();
    dragSource.current = node.id;
    // 视觉反馈：标记源节点
    toast(`拖到目标节点创建 ${node.id} → ? 的边（Esc 双击取消）`, 'hint', 8000);
  }, [toast]);

  const onPaneClickClear = useCallback(() => {
    if (dragSource.current) {
      // 拖到空白就取消
      dragSource.current = null;
      toast('已取消（拖到空白）', 'hint', 3000);
    }
  }, [toast]);

  const onNodeClickWhileDragging = useCallback((event, node) => {
    if (!dragSource.current || dragSource.current === node.id) return;
    // 避免与 ReactFlow 内置的连线冲突：在右键源节点已经定了，我们通过 Shift 修饰
    // 不引入新交互——直接走修改 DOT 的方式，更可靠
    const source = dragSource.current;
    const target = node.id;
    // 自环拦截
    if (source === target) {
      toast('自环被拒绝', 'warn');
      dragSource.current = null;
      return;
    }
    // 检查是否已存在
    const exists = parsed.edges.some((e) => e.source === source && e.target === target);
    if (exists) {
      toast(`边已存在: ${source} -> ${target}`, 'hint');
      dragSource.current = null;
      return;
    }
    const newEdge = `  ${source} -> ${target}`;
    setDot((prev) => prev.replace(/(\s*}\s*)$/, `${newEdge}\n$1`));
    toast(`已加边: ${source} → ${target}`);
    dragSource.current = null;
  }, [parsed.edges, toast]);

  // ── 节点删除 → 从 DOT 移除（不引入新菜单，统一走 click 后删）──
  const onNodeDoubleClick = useCallback((event, node) => {
    event.preventDefault();
    guard(async () => {
      const ok = await dialog({ title: `删除节点 ${node.id}？`, message: '会同时移除与它相连的所有边。', danger: true, okText: '删除' });
      if (!ok) return;
      // 移除节点行 + 与之相关的边
      setDot((prev) => {
        const lines = prev.split('\n');
        const next = lines.filter((line) => {
          const t = line.trim();
          if (!t) return true;
          if (t === '}' || t === 'digraph workflow {' ) return true;
          // 节点行：a [attrs] 或 a
          const nodeMatch = t.match(/^([A-Za-z_][\w-]*)\s*(\[.*\])?\s*;?\s*$/);
          if (nodeMatch && nodeMatch[1] === node.id) return false;
          // 边行：a -> b [attrs]
          const edgeMatch = t.match(/^([A-Za-z_][\w-]*)\s*->\s*([A-Za-z_][\w-]*)/);
          if (edgeMatch && (edgeMatch[1] === node.id || edgeMatch[2] === node.id)) return false;
          return true;
        });
        return next.join('\n');
      });
    });
  }, [dialog, guard]);

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <select value={name} onChange={(e) => { setName(e.target.value); }} style={{ height: 32 }}>
          <option value="">— 新工作流 —</option>
          {list && list.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
        </select>
        {name && <button className="btn small ghost danger" onClick={() => doDelete(name)}>删除</button>}
        <button className="btn small ghost" onClick={() => doLoad(name)} disabled={!name}>加载</button>
        <button className="btn small" onClick={doSave} disabled={!name}>保存</button>
        <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {savedAt ? `已保存 ${new Date(savedAt).toLocaleTimeString()}` : ''}
          {problems.length ? ` · ${problems.length} 个问题` : ''}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="card">
          <div className="colhead"><span>DOT 源码</span><span className="muted">左键编辑</span></div>
          <textarea
            value={dot}
            onChange={(e) => setDot(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%', height: 420, padding: 10, fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 12, border: '1px solid var(--soft-2)', borderRadius: 4,
              background: 'var(--soft-1)', resize: 'vertical',
            }}
          />
          {problems.length > 0 && (
            <div style={{ padding: '6px 10px' }}>
              {problems.map((p, i) => <div key={i} className="muted" style={{ color: '#b91c1c', fontSize: 12 }}>⚠ {p}</div>)}
            </div>
          )}
        </div>

        <div className="card" style={{ minHeight: 460 }}>
          <div className="colhead">
            <span>画布</span>
            <span className="muted">
              {parsed.nodes.length} 节点 / {parsed.edges.length} 边 · 双击建节点 / 右键拖边
            </span>
          </div>
          <ReactFlowProvider>
            <ReactFlow
              nodes={layouted.nodes}
              edges={layouted.edges}
              nodeTypes={nodeTypes}
              onPaneClick={(e) => { onPaneClick(e); onPaneClickClear(); }}
              onNodeClick={onNodeClickWhileDragging}
              onNodeContextMenu={onNodeContextMenu}
              onNodeDoubleClick={onNodeDoubleClick}
              onEdgesChange={onEdgesChange}
              onNodesChange={onNodesChange}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        </div>
      </div>

      {creating && (
        <Modal title="新建节点" onClose={() => setCreating(null)}>
          <form onSubmit={(e) => { e.preventDefault(); const v = e.target.label.value.trim(); createNode(v || undefined); }}>
            <label style={{ display: 'block', marginBottom: 10 }}>
              <span className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>节点标签（留空用 id）</span>
              <input name="label" autoFocus placeholder="例如：构建后端" style={{ width: '100%', padding: 8 }} />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" onClick={() => setCreating(null)}>取消</button>
              <button type="submit" className="btn">创建</button>
            </div>
          </form>
        </Modal>
      )}

      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="workflow" />
      </div>
    </div>
  );
}

function NodeRender({ data }) {
  const { label, shape, fillcolor, color } = data;
  const bg = fillcolor || '#ffffff';
  const border = color || '#64748b';
  return (
    <div
      style={{
        background: bg,
        border: `1.5px solid ${border}`,
        borderRadius: shape === 'ellipse' ? 999 : 4,
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 500,
        minWidth: 80,
        textAlign: 'center',
        boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
        color: '#1e293b',
      }}
      title={label}
    >
      {label}
    </div>
  );
}
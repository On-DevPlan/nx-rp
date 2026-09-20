// workflow 面板：JS 编辑器（左） + 自动布局画布（右）。
//
// agent 写 JS（user 不写）；运行时 SSE 推 4 类事件：
//   graph       整图（含 nodes + edges）
//   nodeStart   节点进入 running
//   nodeDone    节点结束（ok / error）
//   nodeLog     自定义日志
//   done        全部完成
//
// 节点 status 色：
//   idle       灰底
//   running    蓝底 + 边框
//   success    绿底
//   error      红底
//   skipped    灰斜线
//
// 边 type：
//   seq         实线箭头（强依赖）
//   parallel    虚线双箭头（并发组）
//   conditional 虚线带 ?label（条件边）
//
// 布局：dagre 自动布局，从 sources（无前驱的节点）开始按列展开。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, Handle, Position,
  ReactFlowProvider, MarkerType,
  useNodesState, useEdgesState,
} from '@xyflow/react';
import * as dagre from '@dagrejs/dagre';
import { api } from '../../web/frontend/api/client.js';
import { useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';

const STARTER = `// 写一个 async 函数，导出默认。
// ctx.step(name, fn, opts?)  节点：自动建图 + 状态追踪
//   opts.type:    'nxAction' | 'agent-call' | 'http' | 'raw'
//   opts.after:   [name]  显式前驱
// ctx.parallel({ a: fn, b: fn })  并发：节点同组、虚线相连
// ctx.http(url) / ctx.nx(id, p) / ctx.agent(cmd, args)  都是 ctx.step 的语法糖
export default async function run(ctx) {
  await ctx.parallel({
    '启动后端': () => ctx.agent('node', ['./server.js']),
    '启动db':   () => ctx.agent('docker', ['compose', 'up', '-d']),
  });
  await ctx.step('健康检查', () => ctx.http('http://localhost:3000/health'));
  await ctx.step('跑测试', () => ctx.agent('pnpm', ['test']));
}
`;

// ─── 节点卡片：按 type 与 status 上色 ──────────────────────────────────────

const TYPE_LABEL = {
  nxAction: 'nx',
  'agent-call': 'agent',
  http: 'http',
  raw: 'step',
};

function CanvasNode({ data, selected }) {
  const status = data.status || 'idle';
  return (
    <div className={'wf-canvas-node wf-status-' + status + (selected ? ' selected' : '')}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-canvas-node-type">{TYPE_LABEL[data.type] || data.type}</div>
      <div className="wf-canvas-node-name">{data.name}</div>
      {data.ms != null && status !== 'idle' && status !== 'running' && (
        <div className="wf-canvas-node-ms">{data.ms} ms</div>
      )}
      {data.status === 'error' && data.payload && (
        <div className="wf-canvas-node-err">{String(data.payload).slice(0, 40)}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { nxAction: CanvasNode, 'agent-call': CanvasNode, http: CanvasNode, raw: CanvasNode };

// ─── dagre 自动布局 ──────────────────────────────────────────────────────

function layoutWithDagre(nodes, edges, direction = 'LR') {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: 180, height: 60 });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - 90, y: pos.y - 30 },
      targetPosition: direction === 'LR' ? Position.Left : Position.Top,
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
    };
  });
}

// ─── 状态色（CSS 直接用 wf-status-* 类名）────────────────────────────────

// ─── 主组件 ────────────────────────────────────────────────────────────

export default function WorkflowView() {
  return <ReactFlowProvider><WorkflowInner /></ReactFlowProvider>;
}

function WorkflowInner() {
  const { boot } = useStore();
  const [list, setList] = useState(null);
  const [name, setName] = useState('demo');
  const [body, setBody] = useState(STARTER);
  const [events, setEvents] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [selected, setSelected] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const scopeKey = boot?.cwdScope || '';
  const abortRef = useRef(null);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  // 实时校验 JS 语法
  useEffect(() => {
    try {
      new Function(body.replace(/^export\s+default\s+/m, '').replace(/^export\s+/gm, ''));
      setError(null);
    } catch (e) {
      setError('语法错误: ' + (e.message || e));
    }
  }, [body]);

  const refresh = useCallback(async () => {
    setList(await api('/api/workflows'));
  }, []);
  useEffect(() => { refresh().catch(() => setList([])); }, [refresh]);

  // ── 保存 ──────────────────────────────────────────────────────────

  const save = () =>
    guard(async () => {
      if (error) { toast('JS 有语法错误，请先修正'); return; }
      const fsp = await import('node:fs/promises');
      const dir = '.nx-rp-workflows';
      await fsp.mkdir(dir, { recursive: true });
      const fname = `${dir}/${name}.mjs`;
      await fsp.writeFile(fname, body, 'utf8');
      setFileName(fname);
      try {
        await api('/api/workflows/' + encodeURIComponent(name), { method: 'PUT', body: { file: fname } });
      } catch (e) {
        if (String(e.message).includes('404') || String(e.message).includes('NOT_FOUND')) {
          await api('/api/workflows', { method: 'POST', body: { name, file: fname } });
        } else { throw e; }
      }
      toast('已保存');
      await refresh();
    });

  const load = (w) =>
    guard(async () => {
      const fsp = await import('node:fs/promises');
      if (!w.sourceFile) { toast('该工作流没有 sourceFile 记录'); return; }
      setBody(await fsp.readFile(w.sourceFile, 'utf8'));
      setName(w.name);
      setFileName(w.sourceFile);
      setEvents([]);
      setRfNodes([]); setRfEdges([]);
      toast('已加载 ' + w.name);
    }).catch((e) => { toast('加载失败: ' + e.message); });

  const remove = (w) =>
    guard(async () => {
      const ok = await dialog({ title: `删除「${w.name}」？`, danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/workflows/' + encodeURIComponent(w.name), { method: 'DELETE' });
      toast('已删除');
      await refresh();
    });

  // ── 运行：SSE 流 → 画布 ──────────────────────────────────────────

  const run = () =>
    guard(async () => {
      if (error) { toast('JS 有语法错误，请先修正'); return; }
      const fsp = await import('node:fs/promises');
      const dir = '.nx-rp-workflows';
      await fsp.mkdir(dir, { recursive: true });
      const fname = fileName || `${dir}/${name}.mjs`;
      await fsp.writeFile(fname, body, 'utf8');
      setFileName(fname);
      setEvents([]);
      setRfNodes([]); setRfEdges([]);
      setSelected(null);
      setRunning(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch('/api/workflows/run/' + encodeURIComponent(name) + '?file=' + encodeURIComponent(fname), {
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error('运行失败: HTTP ' + res.status);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseFrame(frame);
            if (ev) applyEvent(ev);
          }
        }
      } catch (e) {
        if (e?.name !== 'AbortError') toast('运行失败: ' + (e?.message || e));
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    });

  // SSE 事件 → React Flow 节点/边
  const applyEvent = (ev) => {
    setEvents((arr) => [...arr, { ...ev, at: Date.now() }]);
    if (ev.event === 'graph') {
      const laid = layoutWithDagre(
        ev.data.nodes.map(toRfNode),
        ev.data.edges.map(toRfEdge),
      );
      setRfNodes(laid);
      setRfEdges(ev.data.edges.map(toRfEdge));
    } else if (ev.event === 'nodeStart') {
      setRfNodes((ns) => ns.map((n) => n.id === ev.data.id ? { ...n, data: { ...n.data, status: 'running', startedAt: Date.now() } } : n));
    } else if (ev.event === 'nodeDone') {
      const ok = ev.data.ok;
      setRfNodes((ns) => ns.map((n) => n.id === ev.data.id ? {
        ...n, data: { ...n.data, status: ok ? 'success' : 'error', ms: ev.data.ms, payload: ev.data.error || ev.data.data },
      } : n));
    }
  };

  const stop = () => abortRef.current?.abort();

  // ── 渲染 ──────────────────────────────────────────────────────────

  return (
    <div>
      <div className="wf-toolbar">
        <input className="wf-name" placeholder="工作流名" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn small primary" onClick={save} disabled={!!error}>保存</button>
        <button className="btn small" onClick={run} disabled={!!error || running}>
          {running ? '运行中…' : '运行'}
        </button>
        {running && <button className="btn small ghost" onClick={stop}>停止</button>}
        <button className="btn small ghost" onClick={() => { setBody(STARTER); setEvents([]); }}>模板</button>
        <span style={{ flex: 1 }} />
        <span className="muted">
          {error ? <span className="bad">{error}</span>
            : <span className="muted">JS 校验通过 · {events.length} 事件</span>}
        </span>
        <span className="muted">scope: <code>{scopeKey}</code></span>
      </div>

      <div className="cols" style={{ display: 'grid', gridTemplateColumns: '220px 1fr 1fr', gap: 14, alignItems: 'flex-start' }}>
        {/* 左：已保存 */}
        <div className="card">
          <div className="colhead"><span>已保存</span><span className="muted">{list ? `${list.length} 条` : ''}</span></div>
          {!list ? <div className="empty">加载中…</div>
            : list.length === 0 ? <div className="empty">（暂无）</div>
            : list.map((w) => (
              <div key={w.name} className="row" style={{ gap: 6 }}>
                <div className="name" style={{ flex: 1 }}>
                  <div>{w.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{(w.createdAt || '').slice(0, 19)}</div>
                </div>
                <div className="acts">
                  <button className="btn small ghost" onClick={() => load(w)}>加载</button>
                  <button className="btn small ghost danger" onClick={() => remove(w)}>删除</button>
                </div>
              </div>
            ))}
        </div>

        {/* 中：JS 编辑器 */}
        <div className="card">
          <div className="colhead"><span>JS</span><span className="muted">{body.length} 字符</span></div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={20}
            style={{
              width: '100%', padding: 12, fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 13, border: 'none', outline: 'none', resize: 'vertical',
              background: 'var(--paper)', lineHeight: 1.5,
            }}
          />
        </div>

        {/* 右：画布 */}
        <div className="card" style={{ padding: 0, overflow: 'hidden', minHeight: 460 }}>
          {rfNodes.length === 0 ? (
            <div className="muted" style={{ padding: 16, textAlign: 'center' }}>
              {running ? '运行中，画布即将出现…' : '点「运行」看图'}
            </div>
          ) : (
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges.map(edgeStyle)}
              nodeTypes={NODE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={(_, n) => setSelected(n)}
              fitView
              minZoom={0.4}
              maxZoom={1.6}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} size={1} />
              <Controls />
            </ReactFlow>
          )}
        </div>
      </div>

      {selected && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="colhead"><span>选中节点</span>
            <button className="btn small ghost" onClick={() => setSelected(null)}>关闭</button></div>
          <pre style={{ padding: 10, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>
{JSON.stringify(selected, null, 2)}
          </pre>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="colhead">
          <span>事件流</span>
          <span className="muted">{events.length} 个事件</span>
        </div>
        <div className="wf-run-body">
          {events.length === 0 ? <span className="muted">尚未运行</span>
            : events.map((e, i) => (
              <div key={i} className={'wf-ev wf-ev-' + e.event}>
                <span className="wf-ev-tag">{e.event}</span>
                <span className="wf-ev-data">{JSON.stringify(e.data).slice(0, 200)}</span>
              </div>
            ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}><CliHints module="workflow" /></div>
      {dialogNode}
    </div>
  );
}

// ─── 工具 ──────────────────────────────────────────────────────────────

function toRfNode(n) {
  return {
    id: n.id,
    type: n.type || 'raw',
    position: { x: 0, y: 0 }, // dagre 重新算
    data: { id: n.id, name: n.name, type: n.type || 'raw', status: n.status || 'idle' },
  };
}

function toRfEdge(e) {
  return {
    id: e.id || `${e.source}->${e.target}`,
    source: e.source,
    target: e.target,
    data: { type: e.type, blocking: e.blocking },
  };
}

// 按 edge type 加视觉样式：seq 实线，parallel 虚线双箭头，conditional 虚线
function edgeStyle(e) {
  if (e.data?.type === 'parallel') {
    return {
      ...e,
      style: { strokeDasharray: '6 4', stroke: '#999' },
      markerEnd: { type: MarkerType.Arrow, color: '#999' },
      markerStart: { type: MarkerType.Arrow, color: '#999' },
    };
  }
  if (e.data?.type === 'conditional') {
    return {
      ...e,
      style: { strokeDasharray: '3 3', stroke: '#888' },
      label: '?',
      markerEnd: { type: MarkerType.Arrow, color: '#888' },
    };
  }
  // seq：默认实线
  return {
    ...e,
    style: { stroke: '#333' },
    markerEnd: { type: MarkerType.Arrow, color: '#333' },
  };
}

function parseFrame(frame) {
  let event = 'message';
  let data = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      const raw = line.slice(5).trim();
      try { data = JSON.parse(raw); } catch { data = raw; }
    }
  }
  return data === null ? null : { event, data };
}
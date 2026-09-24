// deps 面板：双模式（预览 / 编辑）。
//
// 预览（默认）：服务端扫描结果（depsToDot 的 DOT）→ viz-js 渲染。
// 编辑：textarea 看/改 DOT 文本 → 浏览器本地 WASM 实时预览（零网络往返）；
//   语法错误结构化显示（render 返回 failure 不抛异常），旧图降透明保留——
//   清空会在打字过程（半个引号、少个花括号的中间态）闪烁且丢失定位。
// 另存：当前模式的 DOT 文本落盘到 cwd（激活 scope）相对路径（.dot/.gv）。
// 导入：<input type=file> 前端 FileReader 直读，不落盘不过服务端。
// 图的事实源永远是源码 import（scan）；编辑器里的只是 DOT 文本草稿。
import { useCallback, useEffect, useRef, useState } from 'react';
import { instance as vizInstance } from '@viz-js/viz';
import { api } from '../../web/frontend/api/client.js';
import { useGuard, useToast, useDialog } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

// viz 实例 module 级 Promise 缓存：instance() 是异步 WASM 编译，
// StrictMode 双挂载 / 模式反复切换都只编译一次。
let vizPromise = null;
const getViz = () => (vizPromise ??= vizInstance());

const DOT_FILE_DEFAULT = '.nx-rp-deps.dot';

export default function DepsView() {
  const [mode, setMode] = useState('preview');        // 'preview' | 'edit'
  const [graph, setGraph] = useState(null);           // 服务端 {dot, stats}——预览事实源
  const [editText, setEditText] = useState('');       // 编辑器内容——编辑事实源
  const [editDirty, setEditDirty] = useState(false);  // 编辑器是否被改过（回填确认用）
  const [editErrors, setEditErrors] = useState([]);   // 最近一次 render 的 errors
  const [svg, setSvg] = useState('');                 // 最近一次**成功**的 svg（两模式共用）
  const [zoom, setZoom] = useState(100);
  const [vizReady, setVizReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const renderSeq = useRef(0); // 竞态防护：慢渲染回来时丢弃过期结果

  // viz 初始化（一次性）
  useEffect(() => { getViz().then(() => setVizReady(true)); }, []);

  // 预览模式：进 tab 自动扫描
  const doScan = useCallback(() =>
    guard(async () => {
      setLoading(true);
      try {
        const r = await api('/api/deps?json=true');
        setGraph(r);
      } catch (e) {
        toast('依赖图生成失败: ' + e.message);
      } finally {
        setLoading(false);
      }
    }), [guard, toast]);
  useEffect(() => { doScan(); }, [doScan]);

  // 统一渲染：source = 预览 ? graph.dot : editText（编辑模式 300ms debounce）
  useEffect(() => {
    if (!vizReady) return;
    const source = mode === 'preview' ? graph?.dot : editText;
    if (!source || !source.trim()) { setSvg(''); setEditErrors([]); return; }
    const seq = ++renderSeq.current;
    const ctl = setTimeout(() => {
      getViz()
        .then((viz) => viz.render(source, { format: 'svg', engine: 'dot' }))
        .then((out) => {
          if (seq !== renderSeq.current) return; // 过期结果丢弃
          if (out.status === 'failure') {
            setEditErrors(out.errors || []);     // 保留旧 svg（降透明度），不清空
          } else {
            setSvg(out.output);
            setEditErrors([]);
          }
        })
        .catch((e) => { if (seq === renderSeq.current) toast('渲染失败: ' + e.message); });
    }, mode === 'preview' ? 0 : 300);
    return () => clearTimeout(ctl);
  }, [mode, graph, editText, vizReady, toast]);

  // 进编辑模式：首次用扫描结果种子化；再次切换保留草稿
  const enterEdit = useCallback(() => {
    setMode('edit');
    if (!editText && graph?.dot) setEditText(graph.dot);
  }, [editText, graph]);

  // 回填：把最新扫描结果灌进编辑器（有改动先确认）
  const doSyncFromScan = useCallback(() =>
    guard(async () => {
      if (!graph?.dot) { toast('还没有扫描结果'); return; }
      if (editDirty) {
        const ok = await dialog({ title: '覆盖编辑器内容？', message: '当前草稿会被最新扫描结果替换。', danger: true, okText: '覆盖' });
        if (!ok) return;
      }
      setEditText(graph.dot);
      setEditDirty(false);
      toast('已回填扫描结果');
    }), [graph, editDirty, dialog, guard, toast]);

  // 另存：preview 存 graph.dot，edit 存 editText（同一按钮，取材随模式）
  const doSave = useCallback(() =>
    guard(async () => {
      const dot = mode === 'preview' ? graph?.dot : editText;
      if (!dot?.trim()) { toast('没有可保存的 DOT 文本'); return; }
      const file = await dialog({ title: '保存为 .dot 文件', input: true, value: DOT_FILE_DEFAULT, placeholder: 'cwd 相对路径（.dot/.gv）' });
      if (!file) return;
      try {
        const r = await api('/api/deps/save', { method: 'POST', body: { file, dot } });
        toast(`${r.overwritten ? '已覆盖' : '已保存'}: ${r.file}`);
      } catch (e) {
        toast('保存失败: ' + e.message);
      }
    }), [mode, graph, editText, dialog, guard, toast]);

  // 导入：前端直读，不落盘不过服务端
  const doImport = useCallback((e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    f.text().then((t) => {
      setEditText(t);
      setEditDirty(false);
      setMode('edit');
      toast(`已导入 ${f.name}（草稿态，点「另存 .dot」才会写文件）`);
    });
  }, []);

  const errorLines = editErrors.filter((e) => e.level === 'error');
  const warnCount = editErrors.length - errorLines.length;

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className={'btn small' + (mode === 'preview' ? ' strong' : '')} onClick={() => setMode('preview')}>预览</button>
        <button className={'btn small' + (mode === 'edit' ? ' strong' : '')} onClick={enterEdit}>编辑</button>
        {mode === 'preview' ? (
          <button className="btn small" onClick={doScan} disabled={loading}>{loading ? '扫描中…' : '重新扫描'}</button>
        ) : (
          <>
            <button className="btn small ghost" onClick={doSyncFromScan} disabled={!graph}>回填扫描结果</button>
            <label className="btn small ghost" style={{ cursor: 'pointer' }}>
              导入 .dot
              <input type="file" accept=".dot,.gv" hidden onChange={doImport} />
            </label>
          </>
        )}
        <button className="btn small" onClick={doSave}>另存 .dot</button>
        <span style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
          <button className="btn small ghost" onClick={() => setZoom((z) => Math.max(25, z - 25))}>−</button>
          <button className="btn small ghost" onClick={() => setZoom(100)} title="适应宽度">{zoom}%</button>
          <button className="btn small ghost" onClick={() => setZoom((z) => Math.min(400, z + 25))}>＋</button>
        </span>
      </div>

      {mode === 'preview' && graph && (
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {graph.stats.files} 文件 · {graph.stats.edges} 边 · {graph.stats.crossLayer} 跨层（红）
        </div>
      )}

      {mode === 'edit' && (
        <>
          {errorLines.length > 0 && (
            <div style={{ border: '1px solid #fecaca', background: '#fef2f2', borderRadius: 4, padding: '6px 10px', marginBottom: 8, fontSize: 12, color: '#b91c1c' }}>
              {errorLines.map((e, i) => <div key={i}>⚠ {e.message}</div>)}
              {warnCount > 0 && <div className="muted">（另有 {warnCount} 条警告）</div>}
            </div>
          )}
          <textarea
            value={editText}
            onChange={(e) => { setEditText(e.target.value); setEditDirty(true); }}
            spellCheck={false}
            placeholder="DOT 文本，例如：digraph { a -> b }"
            style={{
              width: '100%', height: 180, padding: 10, fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 12, border: '1px solid var(--soft-2)', borderRadius: 4,
              background: 'var(--soft-1)', resize: 'vertical', marginBottom: 8,
            }}
          />
        </>
      )}

      {/* 画布：overflow auto + innerHTML 注入 graphviz svg（自带 viewBox）。
          渲染失败时降透明保留旧图——打字的非法中间态不清空不闪烁。 */}
      <div
        style={{
          height: 560, overflow: 'auto', border: '1px solid var(--soft-2)',
          borderRadius: 4, background: 'var(--paper)', padding: 12,
          opacity: errorLines.length ? 0.5 : 1,
        }}
      >
        {vizReady
          ? (svg
            ? <div className="deps-svg" style={zoom !== 100 ? { width: `${zoom}%` } : undefined}
                dangerouslySetInnerHTML={{ __html: svg }} />
            : <span className="muted">{mode === 'edit' ? '输入 DOT 后实时渲染' : '扫描中…'}</span>)
          : <span className="muted">渲染器加载中…（首次进入需编译 WASM，约 1-2 秒）</span>}
      </div>

      <div style={{ marginTop: 12 }}>
        <CliHints module="deps" />
      </div>
      {dialogNode}
    </div>
  );
}

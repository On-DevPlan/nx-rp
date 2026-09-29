// deps 面板：单一事实源。
//
// 注释里反复强调的事——图是「源码推导的只读视图，编辑无意义」——
// 反映到 UI 上就是：预览画板、编辑器画板、待存的图，三者必须同源。
//
// 收敛后的流程只剩两条入口 + 一条落盘：
//   · 重新扫描      → 服务端重生成 graph.dot（事实源更新）
//   · 导入 .dot     → 用外部 DOT 替换当前事实源（标识符数变，source=imported）
//   · 另存 .dot     → 把"当前画板上看到的"那份 DOT 落盘（语义：你看到什么，存什么）
//
// 编辑模式只是「在最新事实源上打草稿」：进入 edit 时自动同步 graph.dot 到编辑器，
// 不再需要"回填扫描结果"按钮与覆盖确认弹窗——草稿态由 stats 行的小字提示。
// 缩放条原先的"适应宽度"是误标题（只把外层宽度设回 100% 而 svg viewBox 没动），
// 去掉这个误导按钮，只保留 −/100%/＋ 三键。
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
  const [mode, setMode] = useState('preview');         // 'preview' | 'edit'
  const [graph, setGraph] = useState(null);            // 服务端 {dot, stats, source}——事实源
  const [editText, setEditText] = useState('');        // 编辑器内容（草稿）
  const [editDirty, setEditDirty] = useState(false);   // 编辑器是否被改过
  const [editSource, setEditSource] = useState('scan');// 编辑器当前内容来源：'scan' | 'imported'
  const [editErrors, setEditErrors] = useState([]);    // 最近一次 render 的 errors
  const [svg, setSvg] = useState('');                  // 最近一次**成功**的 svg（两模式共用）
  const [zoom, setZoom] = useState(100);
  const [vizReady, setVizReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const fileInputRef = useRef(null);                   // 导入按钮的真 button 触发
  const renderSeq = useRef(0);                         // 竞态防护：慢渲染回来时丢弃过期结果

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

  // 统一渲染：source = preview ? graph.dot : (editDirty ? editText : graph.dot)
  // ——editor 没改过时直接渲最新扫描结果；改了才用 editText。这样保证预览与
  // 编辑画板在「同一份 dot」上看到一致的结果。
  useEffect(() => {
    if (!vizReady) return;
    const source = (mode === 'preview' || !editDirty) ? graph?.dot : editText;
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
  }, [mode, graph, editText, editDirty, vizReady, toast]);

  // 进编辑模式：用最新 graph.dot 种子化编辑器；用户在 edit 里看到的图 = 扫描结果。
  const enterEdit = useCallback(() => {
    setMode('edit');
    setEditText(graph?.dot ?? '');
    setEditDirty(false);
    setEditSource('scan');
  }, [graph]);

  // 切回预览：草稿如果和 graph.dot 不一致（用户改了又没存），提示一下，
  // 但不强制——预览只关心最新 graph.dot。
  const enterPreview = useCallback(() => {
    setMode('preview');
  }, []);

  // 另存：存当前画板上的那份 dot（用户看到什么，存什么）。
  // preview → graph.dot；edit 未改 → graph.dot；edit 改了 → editText。
  const doSave = useCallback(() =>
    guard(async () => {
      const dot = (mode === 'preview' || !editDirty) ? graph?.dot : editText;
      if (!dot?.trim()) { toast('没有可保存的 DOT 文本'); return; }
      const sourceLabel = (mode === 'preview' || !editDirty) ? '扫描结果' : '当前草稿';
      const file = await dialog({
        title: `保存 ${sourceLabel} 为 .dot 文件`,
        input: true, value: DOT_FILE_DEFAULT, placeholder: 'cwd 相对路径（.dot/.gv）',
      });
      if (!file) return;
      try {
        const r = await api('/api/deps/save', { method: 'POST', body: { file, dot } });
        toast(`${r.overwritten ? '已覆盖' : '已保存'}: ${r.file}`);
      } catch (e) {
        toast('保存失败: ' + e.message);
      }
    }), [mode, editDirty, graph, editText, dialog, guard, toast]);

  // 导入：前端直读，不落盘不过服务端。
  // 导入后即视为新的"事实源"——进入 edit 模式显示该内容；用户再点"重新扫描"
  // 会覆盖回 scan 源。
  const doImport = useCallback((e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    f.text().then((t) => {
      setMode('edit');
      setEditText(t);
      setEditDirty(false);
      setEditSource('imported');
      toast(`已导入 ${f.name}（草稿态，点「另存 .dot」才会写文件）`);
    });
  }, []);

  const errorLines = editErrors.filter((e) => e.level === 'error');
  const warnCount = editErrors.length - errorLines.length;

  // stats 行：两模式都显示；edit 模式额外标"草稿态"或"来源：xx"。
  // 用 graph（最新事实源）而不是 editText——草稿可能语法错、stats 算不出来。
  const statsLine = graph && (
    <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
      {graph.stats.files} 文件 · {graph.stats.edges} 边 · {graph.stats.crossLayer} 跨层（红）
      {mode === 'edit' && (
        <>
          {' · 来源：'}
          {editDirty
            ? <span style={{ color: 'var(--accent, #d97706)' }}>草稿（未保存）</span>
            : (editSource === 'imported' ? '外部 .dot' : '扫描结果')}
        </>
      )}
    </div>
  );

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className={'btn small' + (mode === 'preview' ? ' strong' : '')} onClick={enterPreview}>预览</button>
        <button className={'btn small' + (mode === 'edit' ? ' strong' : '')} onClick={enterEdit}>编辑</button>
        <button className="btn small" onClick={doScan} disabled={loading} title="重新扫描 src/">
          {loading ? '扫描中…' : '重新扫描'}
        </button>
        <button className="btn small ghost" onClick={() => fileInputRef.current?.click()} disabled={mode !== 'edit'}>
          导入 .dot
        </button>
        <input ref={fileInputRef} type="file" accept=".dot,.gv" hidden onChange={doImport} />
        <button className="btn small" onClick={doSave}>另存 .dot</button>
        <span style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
          <button className="btn small ghost" onClick={() => setZoom((z) => Math.max(25, z - 25))}>−</button>
          <button className="btn small ghost" onClick={() => setZoom(100)} title="还原 100%">{zoom}%</button>
          <button className="btn small ghost" onClick={() => setZoom((z) => Math.min(400, z + 25))}>＋</button>
        </span>
      </div>

      {statsLine}

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
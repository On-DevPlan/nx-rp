// chart 面板：单一事实源的两面。
//
// 两个并列视图共享一个模块：
//   · 依赖图：扫描结果由 Graphviz 官方 WASM（@viz-js/viz）渲染 SVG，
//     分层着色（core 绿 / modules 蓝 / runtime 橙 / web 紫 / 其它灰），
//     跨层边红色（分层违例信号），同层边灰。预览 / 编辑两子切换
//   · 图表：archify 自包含 HTML 的 iframe 嵌入（产物 ?embed=1 画廊模式）。
//     图一律出自 archify skill 的精修流程——这里没有「一键生成」按钮（自动出图
//     不可信），登记走「扫描 .archify」或 CLI `chart archify add`。
//
// 顶栏分组（视图切换 + 子工具组）：让每个视图只看到自己的动作，去掉「看都看不懂」。
import { useCallback, useEffect, useRef, useState } from 'react';
import { instance as vizInstance } from '@viz-js/viz';
import { api, getActiveScope } from '../../web/frontend/api/client.js';
import { useGuard, useToast, useDialog } from '../../web/frontend/components/ui.jsx';

// viz 实例 module 级 Promise 缓存：instance() 是异步 WASM 编译，
// StrictMode 双挂载 / 模式反复切换都只编译一次。
let vizPromise = null;
const getViz = () => (vizPromise ??= vizInstance());

const DOT_FILE_DEFAULT = '.nx-rp-deps.dot';

// 顶栏分组：组与组之间一条淡色竖线分隔，组名小号灰字；首组无边线。
function ToolbarSection({ label, first, children }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        paddingLeft: first ? 0 : 12,
        marginLeft: first ? 0 : 12,
        borderLeft: first ? 'none' : '1px solid var(--soft-2)',
      }}
    >
      <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>{label}</span>
      <span style={{ display: 'inline-flex', gap: 4 }}>{children}</span>
    </span>
  );
}

export default function ChartView() {
  // 顶层视图：'deps' = 依赖图（dot），'chart' = 图表（archify）
  const [view, setView] = useState(null);                // null = 跟随默认
  // deps 子模式：'preview' | 'edit'
  const [mode, setMode] = useState('preview');
  const [graph, setGraph] = useState(null);              // 服务端 {dot, stats, source}
  const [editText, setEditText] = useState('');          // 编辑器草稿
  const [editDirty, setEditDirty] = useState(false);
  const [editSource, setEditSource] = useState('scan');
  const [editErrors, setEditErrors] = useState([]);
  const [svg, setSvg] = useState('');                     // 最近一次成功的 svg
  const [zoom, setZoom] = useState(100);
  const [vizReady, setVizReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [arch, setArch] = useState(null);                 // archify 登记表 {entries}
  const [archId, setArchId] = useState('');               // 当前查看的图表 id
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const fileInputRef = useRef(null);
  const renderSeq = useRef(0);

  // 默认视图：有登记图表落「图表」，否则落「依赖图」（首次进来一定有扫描结果可看）
  const effView = view ?? (arch?.entries?.length ? 'chart' : 'deps');

  // viz 初始化（一次性）
  useEffect(() => { getViz().then(() => setVizReady(true)); }, []);

  // 依赖图：进 tab 自动扫描一次
  const doScan = useCallback(() =>
    guard(async () => {
      setLoading(true);
      try {
        const r = await api('/api/chart?json=true');
        setGraph(r);
      } catch (e) {
        toast('依赖图生成失败: ' + e.message);
      } finally {
        setLoading(false);
      }
    }), [guard, toast]);
  useEffect(() => { doScan(); }, [doScan]);

  // archify 登记：进 tab 拉一次；操作后手动刷新
  const loadArch = useCallback(() =>
    guard(async () => {
      try {
        const r = await api('/api/chart/archify');
        setArch(r);
        setArchId((cur) => (r.entries.some((e) => e.id === cur && e.present !== false)
          ? cur
          : (r.entries.find((e) => e.present !== false)?.id || '')));
      } catch {
        setArch({ entries: [] });
      }
    }), [guard]);
  useEffect(() => { loadArch(); }, [loadArch]);

  // 统一渲染 dot：preview 拿扫描结果；edit 改过用草稿，没改用扫描结果
  // —— 保证预览画板与编辑画板在「同一份 dot」上看到一致结果。
  useEffect(() => {
    if (!vizReady) return;
    if (effView !== 'deps') return;
    const source = (mode === 'preview' || !editDirty) ? graph?.dot : editText;
    if (!source || !source.trim()) { setSvg(''); setEditErrors([]); return; }
    const seq = ++renderSeq.current;
    const ctl = setTimeout(() => {
      getViz()
        .then((viz) => viz.render(source, { format: 'svg', engine: 'dot' }))
        .then((out) => {
          if (seq !== renderSeq.current) return;
          if (out.status === 'failure') {
            setEditErrors(out.errors || []);
          } else {
            setSvg(out.output);
            setEditErrors([]);
          }
        })
        .catch((e) => { if (seq === renderSeq.current) toast('渲染失败: ' + e.message); });
    }, mode === 'preview' ? 0 : 300);
    return () => clearTimeout(ctl);
  }, [effView, mode, graph, editText, editDirty, vizReady, toast]);

  // 进编辑：用最新 graph.dot 种子化编辑器（裸 setMode 不种子化 → 草稿丢整张图）
  const enterEdit = useCallback(() => {
    setMode('edit');
    setEditText(graph?.dot ?? '');
    setEditDirty(false);
    setEditSource('scan');
  }, [graph]);

  // 扫描 .archify/：把未登记的产物全部登记（name 用 candidate 标题，缺省文件夹名）
  const doDiscover = useCallback(() =>
    guard(async () => {
      try {
        const r = await api('/api/chart/archify/discover');
        const fresh = r.items.filter((i) => !i.registered);
        if (!fresh.length) { toast(r.items.length ? '.archify/ 里的产物都已登记' : '.archify/ 下没有 archify 产物'); return; }
        for (const i of fresh) {
          await api('/api/chart/archify/add', {
            method: 'POST',
            body: { file: i.html, candidate: i.candidate || undefined, name: i.title || undefined },
          });
        }
        toast(`已登记 ${fresh.length} 张图表`);
        await loadArch();
      } catch (e) {
        toast('登记失败: ' + e.message);
      }
    }), [guard, toast, loadArch]);

  // 移除登记：连 scope 副本一起删（.archify/ 原产物不动）。
  const doRemove = useCallback(async () => {
    const entry = arch?.entries.find((e) => e.id === archId);
    if (!entry) return;
    const ok = await dialog({
      title: `移除图表「${entry.name}」？`,
      message: '只删 scope 里的副本与登记，.archify/ 原产物不受影响。',
      danger: true, okText: '移除',
    });
    if (!ok) return;
    try {
      await api('/api/chart/archify/remove', { method: 'POST', body: { id: archId } });
      toast(`已移除: ${entry.name}`);
      await loadArch();
    } catch (e) {
      toast('移除失败: ' + e.message);
    }
  }, [arch, archId, dialog, toast, loadArch]);

  // 另存：存当前画板上的那份 dot（用户看到什么，存什么）。
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
        const r = await api('/api/chart/save', { method: 'POST', body: { file, dot } });
        toast(`${r.overwritten ? '已覆盖' : '已保存'}: ${r.file}`);
      } catch (e) {
        toast('保存失败: ' + e.message);
      }
    }), [mode, editDirty, graph, editText, dialog, guard, toast]);

  // 导入：前端直读，不落盘不过服务端。导入后视为新事实源——进入 edit。
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

  // iframe 数据源：archify 的 ?embed=1 模式主动锁住 body overflow（设计为单图截图用），
  // 我们面板场景要滚动就保留 viewer 自身工具栏——不传 embed 参数。
  // ?scope= 显式透传激活目录（iframe 导航不带 x-nx-rp-scope 头）。
  const scopeParam = getActiveScope() ? `&scope=${encodeURIComponent(getActiveScope())}` : '';
  const iframeSrc = archId
    ? `/api/chart/archify/view/${encodeURIComponent(archId)}?theme=light${scopeParam}`
    : null;

  // deps 视图的统计行（两子模式共用；edit 模式额外标草稿态或来源）
  const statsLine = graph && (
    <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
      {graph.stats.files} 文件 · {graph.stats.edges} 边 · {graph.stats.crossLayer} 跨层（红）
      {effView === 'deps' && mode === 'edit' && (
        <>
          {' · 来源：'}
          {editDirty
            ? <span style={{ color: 'var(--bad)' }}>草稿（未保存）</span>
            : (editSource === 'imported' ? '外部 .dot' : '扫描结果')}
        </>
      )}
    </div>
  );

  // ─── 顶栏：视图切换 + 当前视图的子工具组 ───────────────────────
  const viewBtn = (id, label) => (
    <button
      className={'btn small' + (effView === id ? ' strong' : '')}
      onClick={() => setView(id)}
    >{label}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 60px)', minHeight: 400 }}>
      <div className="toolbar" style={{ marginBottom: 12, flexWrap: 'wrap', rowGap: 8 }}>
        <ToolbarSection label="视图" first>
          {viewBtn('chart', '图表')}
          {viewBtn('deps', '依赖图')}
        </ToolbarSection>

        {effView === 'deps' && (
          <>
            <ToolbarSection label="模式">
              <button
                className={'btn small' + (mode === 'preview' ? ' strong' : '')}
                onClick={() => setMode('preview')}
              >预览</button>
              <button
                className={'btn small' + (mode === 'edit' ? ' strong' : '')}
                onClick={enterEdit}
              >编辑</button>
            </ToolbarSection>
            <ToolbarSection label="数据">
              <button className="btn small" onClick={doScan} disabled={loading} title="重新扫描 src/">
                {loading ? '扫描中…' : '重新扫描'}
              </button>
              <button className="btn small ghost" onClick={() => fileInputRef.current?.click()} disabled={mode !== 'edit'}>
                导入 .dot
              </button>
              <input ref={fileInputRef} type="file" accept=".dot,.gv" hidden onChange={doImport} />
              <button className="btn small" onClick={doSave}>另存 .dot</button>
            </ToolbarSection>
            <ToolbarSection label="缩放">
              <button className="btn small ghost" onClick={() => setZoom((z) => Math.max(25, z - 25))}>−</button>
              <button className="btn small ghost" onClick={() => setZoom(100)} title="还原 100%">{zoom}%</button>
              <button className="btn small ghost" onClick={() => setZoom((z) => Math.min(400, z + 25))}>＋</button>
            </ToolbarSection>
          </>
        )}

        {effView === 'chart' && (
          <ToolbarSection label="管理">
            <select
              className="btn small"
              value={archId}
              onChange={(e) => setArchId(e.target.value)}
              disabled={!arch?.entries.length}
              style={{ maxWidth: 220 }}
            >
              {arch?.entries.length
                ? arch.entries.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}{e.present === false ? '（缺失）' : ''}</option>
                ))
                : <option value="">（暂无登记图表）</option>}
            </select>
            <button className="btn small ghost" onClick={doDiscover} title="扫描 cwd/.archify/ 里未登记的产物并登记">
              扫描 .archify
            </button>
            <button className="btn small ghost" onClick={doRemove} disabled={!archId}>移除</button>
          </ToolbarSection>
        )}
      </div>

      {statsLine}

      {effView === 'deps' && mode === 'edit' && (
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
              background: 'var(--soft)', resize: 'vertical', marginBottom: 8,
            }}
          />
        </>
      )}

      {/* 画布：chart 视图 iframe 直出登记的 HTML；deps 视图 graphviz svg。两个画布容器都 flex:1 占满剩余高度 */}
      {effView === 'chart' ? (
        iframeSrc ? (
          <iframe
            key={archId}
            src={iframeSrc}
            title="archify 图表"
            style={{
              flex: 1, width: '100%', minHeight: 0,
              border: '1px solid var(--soft-2)',
              borderRadius: 4, background: '#fff',
            }}
          />
        ) : (
          <div style={{
            flex: 1, minHeight: 0,
            border: '1px solid var(--soft-2)', borderRadius: 4,
            background: 'var(--paper)', padding: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="muted">
              尚无登记图表——用 archify skill 生成图表后，点「扫描 .archify」登记
            </span>
          </div>
        )
      ) : (
        <div
          style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            border: '1px solid var(--soft-2)',
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
      )}

      {dialogNode}
    </div>
  );
}
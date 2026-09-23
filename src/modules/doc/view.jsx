// doc 面板：文档 CRUD + 知识库与召回（实例文件化 / 索引 / 语义召回一体）。
//
// 与 link 同构——body 是 textarea；下半部分是 zg 集成卡片：
// 引擎状态（zg 版本/KB 目录/索引/模型/key）→ 导出/索引按钮 → 召回试查。
// 数据流一条线：登记 → doc export → zg index → zg query。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Modal, useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const EMPTY = { name: '', body: '', tags: '', source: '' };

export default function DocView() {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [zg, setZg] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [querying, setQuerying] = useState(false);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const refresh = useCallback(async () => {
    setList(await api('/api/docs'));
    setZg(await api('/api/zg/install'));
  }, []);

  useEffect(() => { refresh().catch(() => { setList([]); setZg(null); }); }, [refresh]);

  const save = (form) =>
    guard(async () => {
      const body = {
        name: form.name, body: form.body || '',
        tags: form.tags ? form.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
        source: form.source || '',
      };
      if (editing.id) {
        await api('/api/docs/' + encodeURIComponent(editing.id), { method: 'PATCH', body });
        toast('已更新');
      } else {
        await api('/api/docs', { method: 'POST', body });
        toast('已登记');
      }
      setEditing(null);
      await refresh();
    });

  const remove = (d) =>
    guard(async () => {
      const ok = await dialog({ title: `删除「${d.name}」？`, danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/docs/' + encodeURIComponent(d.id), { method: 'DELETE' });
      toast('已删除');
      await refresh();
    });

  const doExport = () =>
    guard(async () => {
      const r = await api('/api/docs/export', { method: 'POST', body: {} });
      toast(`已同步 ${r.total} 篇到知识库`);
      await refresh();
    });

  const doIndex = () =>
    guard(async () => {
      toast('索引中…（远程 embedding）');
      const r = await api('/api/zg/index', { method: 'POST', body: {} });
      toast(r.ok ? '索引完成' : '索引失败：' + (r.stderr || '').slice(0, 120));
      await refresh();
    });

  const doQuery = () =>
    guard(async () => {
      if (!q.trim()) return;
      setQuerying(true);
      setResults(null);
      try {
        const r = await api('/api/zg/query', { method: 'POST', body: { q } });
        setResults(r.ok ? r.results : '失败: ' + (r.stderr || r.hint || ''));
      } finally {
        setQuerying(false);
      }
    });

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn small" onClick={() => setEditing({ ...EMPTY })}>新建文档</button>
      </div>

      <div className="card">
        <div className="colhead">
          <span>文档</span>
          <span className="muted">{list ? `${list.length} 篇` : '加载中…'}</span>
        </div>
        {!list ? <div className="empty">加载中…</div>
          : list.length === 0 ? <div className="empty">（暂无文档）</div>
          : list.map((d) => (
            <div key={d.id} className="row">
              <div className="name">{d.name}</div>
              <div className="desc">{(d.body || '').slice(0, 80)}</div>
              <div className="acts">
                <button className="btn small ghost" onClick={() => setViewing(d)}>查看</button>
                <button className="btn small ghost" onClick={() => setEditing({ ...d, tags: (d.tags || []).join(',') })}>编辑</button>
                <button className="btn small ghost danger" onClick={() => remove(d)}>删除</button>
              </div>
            </div>
          ))}
      </div>

      <div className="card">
        <div className="colhead">
          <span>知识库与召回</span>
          <span className="muted">{zg ? (zg.zgInstalled ? `zg ${zg.version} · ${zg.indexed ? '已索引' : '未索引'}` : 'zg 未安装') : '加载中…'}</span>
        </div>
        {!zg ? <div className="empty">{loadErrorZg()}</div> : (
          <div style={{ padding: '10px 12px' }}>
            <dl className="kv">
              <div className="kv-row">
                <dt>知识库目录</dt>
                <dd className="mono nowrap" title={zg.kbDir}>{zg.kbDir}</dd>
              </div>
              <div className="kv-row">
                <dt>embedding</dt>
                <dd className="mono">{zg.embedding}</dd>
              </div>
              <div className="kv-row">
                <dt>API key</dt>
                <dd>
                  {zg.keyConfigured
                    ? <span className="tag strong">已配置 workspace 授权</span>
                    : <span className="tag bad">未配置</span>}
                  <a href="https://platform.qianwenai.com/home/" target="_blank" rel="noreferrer" className="muted" style={{ marginLeft: 8, fontSize: 12 }}>引导页 ↗</a>
                </dd>
              </div>
            </dl>
            <div className="toolbar" style={{ padding: '8px 0 0' }}>
              <button className="btn small" onClick={doExport}>导出到知识库</button>
              <button className="btn small" onClick={doIndex} disabled={!zg.zgInstalled}>建立索引</button>
              {!zg.zgInstalled && <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>先 npm install -g @zvec/zvec-grep；引导：nx-rp zg onboard</span>}
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
              数据流：登记文档 → 导出到知识库 → 建索引 → 语义召回。key 只写入 zg 全局配置（~/.zvec-grep/config.json），nx-rp 不存储不回显；刻意不装 zg 的 MCP（direct 一次性子进程，零常驻）。
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <div className="colhead">
          <span>召回试查</span>
          <span className="muted">direct · limit 5 · 结果带来源头块</span>
        </div>
        <div className="toolbar" style={{ padding: '8px 12px' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doQuery(); }}
            placeholder="语义查询，例：hook 开关的外科手术是怎么实现的"
            style={{ flex: 1, minWidth: 0 }}
            disabled={querying}
          />
          <button className="btn small" onClick={doQuery} disabled={querying || !q.trim()}>{querying ? '查询中…' : '查询'}</button>
        </div>
        {results != null && (
          <pre style={{ margin: '0 12px 12px', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>{results}</pre>
        )}
      </div>

      {editing && (
        <Modal title={editing.id ? '编辑文档' : '新建文档'} onClose={() => setEditing(null)}>
          <form onSubmit={(e) => { e.preventDefault(); save(editing); }}>
            <Field label="名称 *"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required /></Field>
            <Field label="正文">
              <textarea value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                rows={14} style={{ width: '100%', padding: 8, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13, border: '1px solid var(--soft-2)', borderRadius: 4 }} />
            </Field>
            <Field label="标签（逗号分隔）">
              <input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} />
            </Field>
            <Field label="来源">
              <input value={editing.source} onChange={(e) => setEditing({ ...editing, source: e.target.value })} placeholder="URL 或文件路径" />
            </Field>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>取消</button>
              <button type="submit" className="btn">保存</button>
            </div>
          </form>
        </Modal>
      )}

      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)}>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 }}>{viewing.body || '（空）'}</pre>
          {viewing.source ? <p className="muted" style={{ marginTop: 12 }}>来源: {viewing.source}</p> : null}
        </Modal>
      )}
      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="doc" />
      </div>
    </div>
  );
}

function loadErrorZg() {
  return '无法读取 zg 状态';
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}
// doc 面板：列表 + Markdown 编辑。
//
// 与 link 同构——但 body 是 textarea，preview 暂不开（Markdown 渲染会引入新依赖）。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Modal, useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';

const EMPTY = { name: '', body: '', tags: '', source: '' };

export default function DocView() {
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const refresh = useCallback(async () => {
    setList(await api('/api/docs'));
  }, []);

  useEffect(() => { refresh().catch(() => setList([])); }, [refresh]);

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

function Field({ label, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span className="muted" style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}
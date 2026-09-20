// link 面板：列表 + 添加/编辑/删除。
//
// 标准 CRUD 视图的范本：右栏「新建」，每行有「编辑/删除」按钮，删除走 dialog 二次确认。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Copyable, Modal, useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';

const EMPTY_FORM = { name: '', url: '', kind: 'url', tags: '', note: '' };

export default function LinkView() {
  const { boot } = useStore();
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();
  const scopeKey = boot?.cwdScope || '';

  const refresh = useCallback(async () => {
    setList(await api('/api/links'));
  }, []);

  useEffect(() => { refresh().catch(() => setList([])); }, [refresh]);

  const save = (form) =>
    guard(async () => {
      const body = {
        name: form.name, url: form.url,
        kind: form.kind,
        tags: form.tags ? form.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
        note: form.note || '',
      };
      if (editing && editing.id) {
        await api('/api/links/' + encodeURIComponent(editing.id), { method: 'PATCH', body });
        toast('已更新');
      } else {
        await api('/api/links', { method: 'POST', body });
        toast('已登记');
      }
      setEditing(null);
      await refresh();
    });

  const remove = (l) =>
    guard(async () => {
      const ok = await dialog({ title: `删除「${l.name}」？`, message: '该链接不会自动通知任何外部系统。', danger: true, okText: '删除' });
      if (!ok) return;
      await api('/api/links/' + encodeURIComponent(l.id), { method: 'DELETE' });
      toast('已删除');
      await refresh();
    });

  const edit = (l) => setEditing({ ...l, tags: Array.isArray(l.tags) ? l.tags.join(',') : '' });
  const add = () => setEditing({ ...EMPTY_FORM });

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <button className="btn small" onClick={add}>新建链接</button>
        <span className="muted" style={{ marginLeft: 8 }}>
          scope: <code>{scopeKey}</code>
        </span>
      </div>

      <div className="card">
        <div className="colhead">
          <span>链接</span>
          <span className="muted">{list ? `${list.length} 条` : '加载中…'}</span>
        </div>
        {!list ? <div className="empty">加载中…</div>
          : list.length === 0 ? <div className="empty">（暂无链接）</div>
          : list.map((l) => (
            <div key={l.id} className="row">
              <div className="name">{l.name}</div>
              <div className="desc"><Copyable text={l.url}>{l.url}</Copyable></div>
              <div className="acts">
                <span className="tag">{l.kind}</span>
                <button className="btn small ghost" onClick={() => edit(l)}>编辑</button>
                <button className="btn small ghost danger" onClick={() => remove(l)}>删除</button>
              </div>
            </div>
          ))}
      </div>

      {editing && (
        <Modal title={editing.id ? '编辑链接' : '新建链接'} onClose={() => setEditing(null)}>
          <form onSubmit={(e) => { e.preventDefault(); save(editing); }}>
            <Field label="名称 *"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required /></Field>
            <Field label="URL / 入口 *"><input value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} required /></Field>
            <Field label="类型">
              <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
                <option value="url">url</option>
                <option value="openapi">openapi</option>
                <option value="cli">cli</option>
                <option value="doc">doc</option>
                <option value="tool">tool</option>
                <option value="other">other</option>
              </select>
            </Field>
            <Field label="标签（逗号分隔）">
              <input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} placeholder="例如: 监控, gcp" />
            </Field>
            <Field label="备注">
              <input value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </Field>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>取消</button>
              <button type="submit" className="btn">保存</button>
            </div>
          </form>
        </Modal>
      )}
      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="link" />
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
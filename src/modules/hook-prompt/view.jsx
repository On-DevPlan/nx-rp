// 提示词日志面板：开关状态卡片 + 提示词记录表格 + 手动添加卡片。
//
// 与 doc / deps 同构：数据从 /api 拉，操作走同一条 action，
// 底部 CLI 提示由命令表派生（CliHints）。开关只动本 hook 的 entry
// （marker `__nx_rp_prompt_log__`），不影响 Skill 追踪等其他 hooks。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Modal, useDialog, useGuard, useToast, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import ManualAddCard from '../../web/frontend/components/ManualAddCard.jsx';

const LIMIT = 200;

export default function HookPromptView() {
  const { boot } = useStore();
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState(null);
  const [groups, setGroups] = useState([]);
  const [all, setAll] = useState(false);
  const [cwdFilter, setCwdFilter] = useState(''); // 空=全部；非空=该 cwd 子串筛
  const [loadError, setLoadError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await api('/api/hook-prompt/status'));
      const qs = new URLSearchParams();
      qs.set('limit', String(LIMIT));
      if (all) {
        qs.set('all', 'true');
        if (cwdFilter) qs.set('cwd', cwdFilter);
        qs.set('shape', 'with-groups'); // 跨目录模式顺手拿分组
      }
      const res = await api('/api/hook-prompt/log?' + qs.toString());
      // 默认形态：records 数组；with-groups：{records, groups}
      if (all && res && Array.isArray(res.groups)) {
        setLogs(res.records);
        setGroups(res.groups);
      } else {
        setLogs(Array.isArray(res) ? res : []);
        setGroups([]);
      }
    } catch (e) {
      // 失败要如实呈现——不能让「请求失败」伪装成「暂无记录」
      setLoadError(e.message || '加载失败');
    }
  }, [all, cwdFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  const enable = () =>
    guard(async () => {
      await api('/api/hook-prompt/on', { method: 'POST', body: {} });
      toast('已启用');
      await refresh();
    });

  const disable = () =>
    guard(async () => {
      const ok = await dialog({
        title: '停用提示词日志？',
        message: '会从 ~/.claude/settings.json 摘掉提示词日志那条 hook（写前自动留快照；Skill 追踪等其他 hooks 不动）。',
        danger: true,
        okText: '停用',
      });
      if (!ok) return;
      await api('/api/hook-prompt/off', { method: 'POST', body: {} });
      toast('已停用');
      await refresh();
    });

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <span className="muted">scope: <code>{boot?.cwdScope || ''}</code></span>
        <span className="muted" style={{ marginLeft: 'auto' }}>记录按 serve 进程的 cwd 过滤，勾选「跨全部目录」查看其它项目</span>
      </div>

      {loadError && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="tag bad">加载失败</span>
            <span className="muted">{loadError}</span>
            <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={refresh}>重试</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="colhead">
          <span>提示词记录</span>
          <span className="muted">{logs ? `${logs.length} 条` : '加载中…'}</span>
        </div>
        <div className="toolbar" style={{ padding: '8px 12px' }}>
          <button className="btn small" onClick={enable} disabled={!status || status.enabled || status.corrupt}>启用</button>
          <button className="btn small ghost" onClick={disable} disabled={!status || !status.enabled || status.corrupt}>停用</button>
          <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <input type="checkbox" checked={all} onChange={(e) => {
              setAll(e.target.checked);
              setCwdFilter(''); // 切到「非跨目录」时清掉筛选；切回来也要重选
            }} style={{ height: 'auto' }} />
            跨全部目录
          </label>
          {all ? (
            <>
              <select
                value={cwdFilter}
                onChange={(e) => setCwdFilter(e.target.value)}
                title="按 cwd 路径分组筛选"
                style={{ minWidth: 280, maxWidth: 480 }}
              >
                <option value="">全部路径（{groups.length} 个）</option>
                {groups.map((g) => (
                  <option key={g.cwd} value={g.cwd}>
                    {g.cwd}  —  {g.count} 条
                  </option>
                ))}
              </select>
              {cwdFilter ? (
                <button className="btn small ghost" onClick={() => setCwdFilter('')}>清除</button>
              ) : null}
            </>
          ) : null}
        </div>
        {!logs ? <div className="empty">{loadError ? '无法加载' : '加载中…'}</div>
          : logs.length === 0 ? <div className="empty">（暂无记录——在启用 hook 的会话里发一条提示词后再来）</div>
          : logs.map((r, i) => (
            <div key={r.ts + i} className="row">
              <div className="name" style={{ width: 140, flexShrink: 0 }}>{fmt(r.ts)}</div>
              <div className="desc">{oneLine(r.prompt)}</div>
              <div className="acts">
                {all ? <span className="muted" style={{ fontSize: 11 }}>{r.cwd}</span> : null}
                {r.sessionId ? (
                  <Copyable
                    text={r.sessionId}
                    className="tag mono"
                    title={r.sessionId + '\n点击复制完整 sessionId，用于 claude --resume'}
                  >
                    {String(r.sessionId).slice(0, 8)}
                  </Copyable>
                ) : null}
                <button className="btn small ghost" onClick={() => setViewing(r)}>查看</button>
              </div>
            </div>
          ))}
      </div>

      <div className="card">
        <div className="colhead">
          <span>Hook 状态</span>
          <span className="muted">{status ? (status.corrupt ? '配置文件异常' : (status.enabled ? '已启用' : '未启用')) : (loadError ? '—' : '加载中…')}</span>
        </div>
        {!status ? <div className="empty">{loadError ? '无法读取 hook 状态' : '加载中…'}</div> : (
          <div style={{ padding: '10px 12px' }}>
            <dl className="kv">
              <div className="kv-row">
                <dt>状态</dt>
                <dd>
                  <span className={'tag' + (status.enabled ? ' strong' : '')}>{status.enabled ? '已启用' : '未启用'}</span>
                  <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>UserPromptSubmit</span>
                  {status.disableAllHooks ? <span className="tag bad" style={{ marginLeft: 6 }}>disableAllHooks</span> : null}
                  {status.corrupt ? <span className="tag bad" style={{ marginLeft: 6 }}>settings.json 损坏</span> : null}
                </dd>
              </div>
              <div className="kv-row">
                <dt>配置文件</dt>
                <dd className="mono nowrap" title={status.settingsPath}>{status.settingsPath}</dd>
              </div>
              <div className="kv-row">
                <dt>日志目录</dt>
                <dd className="mono nowrap" title={status.logDir}>{status.logDir}</dd>
              </div>
            </dl>
            {status.disableAllHooks ? (
              <p className="muted" style={{ marginTop: 8 }}>
                全局 <code>disableAllHooks: true</code> 会一票否决所有 hooks——即使这里显示已启用，提示词也不会被记录。
              </p>
            ) : null}
            {status.corrupt ? (
              <p className="muted" style={{ marginTop: 8 }}>
                settings.json 无法解析（可能被手改出错或半截写入）。请先修复该文件；修复前「启用 / 停用」会拒绝写入以防覆盖你的配置。
              </p>
            ) : null}
          </div>
        )}
      </div>

      <ManualAddCard snippet={status?.snippet} eventKey="UserPromptSubmit" />

      {viewing && (
        <Modal title={fmt(viewing.ts)} onClose={() => setViewing(null)}>
          <p className="muted mono" style={{ fontSize: 11, marginBottom: 8 }}>
            {viewing.cwd}
            {viewing.sessionId ? <span title="sessionId"> · {viewing.sessionId}</span> : null}
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 }}>{viewing.prompt}</pre>
          {viewing.sessionId ? (
            <div
              className="toolbar"
              style={{ marginTop: 12, paddingTop: 10, borderTop: 'var(--border)', fontSize: 12 }}
            >
              <Copyable
                text={`claude --resume ${viewing.sessionId}`}
                title="点击复制恢复命令"
              >
                <code>claude --resume {viewing.sessionId}</code>
              </Copyable>
              <span className="muted" style={{ fontSize: 11 }}>← 点击复制，粘贴到终端即可回到该会话</span>
            </div>
          ) : null}
        </Modal>
      )}
      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="hook-prompt" />
      </div>
    </div>
  );
}

function fmt(ts) {
  return String(ts || '').replace('T', ' ').slice(0, 19);
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ');
}

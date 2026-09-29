// 提示词日志面板：开关状态卡片 + 目录分组切换器 + 提示词记录表格 + 手动添加卡片。
//
// 与 doc / deps 同构：数据从 /api 拉，操作走同一条 action，
// 底部 CLI 提示由命令表派生（CliHints）。开关只动本 hook 的 entry
// （marker `__nx_rp_prompt_log__`），不影响 Skill 追踪等其他 hooks。
//
// 目录维度：**默认跟随当前 scope**（与 doc/deps 一致），顶部一排 chip 是可见的
// 组切换器——切一条就只看该目录的记录。分组由服务端按**归一化路径**聚合
// （同一目录的 `D:\x` 与 `D:/x` 是同一组），所以切换一定能拿到记录。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Modal, useDialog, useGuard, useToast, Copyable } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import ManualAddCard from '../../web/frontend/components/ManualAddCard.jsx';

const LIMIT = 200;

export default function HookPromptView() {
  const { boot, scopeTick } = useStore();
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState(null);
  const [groups, setGroups] = useState([]);
  // null = 跟随当前 scope；字符串 = 锁定到该目录
  const [cwd, setCwd] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  // 切换 scope 时视图会重挂载，但 cwd 是组件内 state——必须跟着复位，
  // 否则会停在上一个 scope 的锁定目录上（用户切了项目却还在看旧项目）。
  useEffect(() => { setCwd(null); }, [scopeTick]);

  const currentScope = boot?.cwdScope || null;
  const currentKey = currentScope ? normalizeKey(currentScope) : null;
  const activeScope = cwd || currentScope;

  // 「已注册目录」= store.recents：nx-rp 真正被用过的那些项目（serve 启动与面板切换时登记，
  // 上限 20）。日志文件里会留着一堆只跑过一次的临时目录（.tool/xxx、某个 repo 子目录…），
  // 它们不该出现在筛选器里——**只列已注册的**，当前 scope 永远可选（它可能刚起来还没登记）。
  const registered = useMemo(
    () => new Set((boot?.recents || []).map((r) => normalizeKey(r.scope))),
    [boot],
  );
  // 目录下拉的选项（options）：
  //   首项 = 「跟随当前目录」，它本身就是当前 scope 那一条，所以**不再重复列一次**
  //   （两条 option 同值会让受控 select 行为含混），条数并进首项文案；
  //   其余只列**已注册**的目录（store.recents），排除当前 scope。
  const currentGroup = groups.find((g) => normalizeKey(g.key) === currentKey) || null;
  const options = useMemo(
    () => groups.filter((g) => normalizeKey(g.key) !== currentKey && registered.has(normalizeKey(g.key))),
    [groups, registered, currentKey],
  );
  const refresh = useCallback(async () => {
    if (!boot) return; // 等 bootstrap 拿到当前 scope，避免先用错目录查一轮
    setLoadError(null);
    try {
      setStatus(await api('/api/hook-prompt/status'));
      const qs = new URLSearchParams();
      qs.set('limit', String(LIMIT));
      // 一律 all=true + groups=1：
      //   all   —— 关掉「默认只看当前 cwd」，否则锁不到别的目录；
      //   groups—— 让服务端带上**全量**分组当切换器（它不随 cwd 收窄，
      //            否则切进某目录后只剩自己一项，再也切不出去）。
      // 这两个都是 action 里**声明过**的 flag——applySpec 只透传声明过的参数，
      // 私传 shape=with-groups 会被丢掉（这正是组列表曾经恒为空的原因）。
      qs.set('all', 'true');
      qs.set('groups', '1');
      if (activeScope) qs.set('cwd', activeScope);
      const res = await api('/api/hook-prompt/log?' + qs.toString());
      setLogs(res && Array.isArray(res.records) ? res.records : []);
      setGroups(res && Array.isArray(res.groups) ? res.groups : []);
    } catch (e) {
      // 失败要如实呈现——不能让「请求失败」伪装成「暂无记录」
      setLoadError(e.message || '加载失败');
    }
  }, [boot, activeScope]);

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

  // 目录下拉的选项：当前 scope 若已不在分组里（该目录还没记录）也要占一项，
  // 否则用户看到「跟随当前目录」选着却找不到对应项，不知道自己在看什么。

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <span className="muted">scope: <code>{boot?.cwdScope || ''}</code></span>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {cwd ? '已锁定到一条目录' : '记录跟随当前 scope，可在下方切换已注册目录'}
        </span>
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
        </div>

        <div className="toolbar" style={{ padding: '0 12px 10px', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>目录</span>
          <select
            value={cwd || ''}
            onChange={(e) => setCwd(e.target.value || null)}
            title="只列已注册的目录（nx-rp 用过的项目）；选「跟随当前目录」即跟随 scope"
            style={{ minWidth: 260, maxWidth: 420, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}
          >
            <option value="">
              跟随当前目录{currentScope ? ` — ${shortPath(currentScope)}` : ''}
              {currentGroup ? `（${currentGroup.count} 条）` : ''}
            </option>
            {options.map((g) => (
              <option key={g.key} value={g.display}>
                {g.display}  —  {g.count} 条
              </option>
            ))}
          </select>
          {cwd ? (
            <button className="btn small ghost" onClick={() => setCwd(null)} title="回到跟随当前 scope">
              ↺ 跟随当前目录
            </button>
          ) : null}
          <span className="muted" style={{ fontSize: 11 }}>
            仅列已注册目录（{options.length} 个）· 日志里另有 {Math.max(0, groups.length - options.length - 1)} 个未注册目录未列出
          </span>
        </div>

        {!logs ? <div className="empty">{loadError ? '无法加载' : '加载中…'}</div>
          : logs.length === 0 ? <div className="empty">（该目录暂无记录——在启用 hook 的会话里发一条提示词后再来）</div>
          : logs.map((r, i) => (
            <div key={r.ts + i} className="row">
              <div className="name" style={{ width: 140, flexShrink: 0 }}>{fmt(r.ts)}</div>
              <div className="desc">{oneLine(r.prompt)}</div>
              <div className="acts">
                {cwd ? <span className="muted" style={{ fontSize: 11 }} title={r.cwd}>{shortPath(r.cwd)}</span> : null}
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
                <dd className="mono nowrap" title={status.logDir}>
                  {status.logDir}
                  <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>
                    ← 一条目录一个文件，按归一化路径分片；查询时按路径聚合
                  </span>
                </dd>
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

// 与后端 normalizeScope 对齐的最小版本：分隔符归一 + Windows 下折叠大小写。
// 只用于前端比较与展示，真正的权威归一化在服务端。
function normalizeKey(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

// 面板空间有限，路径只留末尾两段（完整路径挂在 title 上）。
function shortPath(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/') || String(p || '');
  return '…/' + parts.slice(-2).join('/');
}

function fmt(ts) {
  return String(ts || '').replace('T', ' ').slice(0, 19);
}

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ');
}

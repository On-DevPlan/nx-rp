// 提示词日志面板：目录分组切换器 + 提示词记录表格。
//
// 头部三件套（toolbar / 加载失败卡 / Hook 状态卡）与启停动作由 useHookDomain
// 生成——hook 域三视图的公共部分，本视图只管提示词记录与目录切换。
//
// 目录维度：**默认跟随当前 scope**（与 doc/deps 一致），下方下拉是可见的
// 组切换器——选一条就只看该目录的记录。分组由服务端按**归一化路径**聚合
// （同一目录的 `D:\x` 与 `D:/x` 是同一组），所以切换一定能拿到记录。
//
// 记录与分组是本视图自己的数据（参数随 activeScope 变）——不走 afterRefresh，
// 独立拉取；hook 状态的加载失败由共享错误卡负责，这里的失败只红在记录卡上。
//
// **系统注入的记录默认不显示**：`<task-notification>`（后台任务完成）之类是
// 机器消息，不是用户意图，混在列表里只会灌水（实测占比 22%）。头部给出
// 「已隐藏 N 条」并可点开——想看就看得到，但不占默认视线；「清理」按钮把它们
// 从 JSONL 里物理剔除（写前留快照，可回滚）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { Copyable, Modal, useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import ManualAddCard from '../../web/frontend/components/ManualAddCard.jsx';
import { useHookDomain } from '../../web/frontend/components/hook-domain.jsx';

const LIMIT = 200;

export default function HookPromptView() {
  const { boot, scopeTick } = useStore();
  const [logs, setLogs] = useState(null);
  const [groups, setGroups] = useState([]);
  // null = 跟随当前 scope；字符串 = 锁定到该目录
  const [cwd, setCwd] = useState(null);
  const [logsError, setLogsError] = useState(null);
  const [viewing, setViewing] = useState(null);
  // 系统注入记录：默认不显示；showSystem=true 时一并列出
  const [showSystem, setShowSystem] = useState(false);
  // 范围内系统注入的**总条数**（与是否显示无关）——头部据此给出提示与清理入口
  const [systemCount, setSystemCount] = useState(0);
  const [cleaning, setCleaning] = useState(false);
  const { dialog, node: dialogNode } = useDialog();
  const toast = useToast();
  const guard = useGuard();

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
  // 目录下拉的选项：
  //   首项 = 「跟随当前目录」，它本身就是当前 scope 那一条，所以**不再重复列一次**
  //   （两条 option 同值会让受控 select 行为含混），条数并进首项文案；
  //   其余只列**已注册**的目录（store.recents），排除当前 scope。
  const currentGroup = groups.find((g) => normalizeKey(g.key) === currentKey) || null;
  const options = useMemo(
    () => groups.filter((g) => normalizeKey(g.key) !== currentKey && registered.has(normalizeKey(g.key))),
    [groups, registered, currentKey],
  );
  // 日志里「未注册」的目录数——下拉不列它们（只见 store.recents），但用户得知道还有这批。
  const unregistered = Math.max(0, groups.length - options.length - 1);

  const loadLogs = useCallback(async () => {
    if (!boot) return; // 等 bootstrap 拿到当前 scope，避免先用错目录查一轮
    setLogsError(null);
    try {
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
      if (showSystem) qs.set('system', '1');
      if (activeScope) qs.set('cwd', activeScope);
      const res = await api('/api/hook-prompt/log?' + qs.toString());
      setLogs(res && Array.isArray(res.records) ? res.records : []);
      setGroups(res && Array.isArray(res.groups) ? res.groups : []);
      setSystemCount(Number(res?.systemCount) || 0);
    } catch (e) {
      // 失败要如实呈现——不能让「请求失败」伪装成「暂无记录」
      setLogsError(e.message || '加载失败');
    }
  }, [boot, activeScope, showSystem]);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  // 清理：把系统注入的记录从 JSONL 里物理剔除。范围 = 当前视图锁定的目录
  // （没锁定就是当前 scope）。写前留快照，可从 ~/.nx-rp/snapshots/ 回滚。
  const clean = useCallback(() => guard(async () => {
    if (cleaning) return;
    setCleaning(true);
    try {
      const target = activeScope || '';
      const ok = await dialog({
        danger: true,
        okText: '清理',
        title: '清理系统注入记录？',
        message:
          `将把 ${target || '当前目录'} 里的系统注入记录（<task-notification> 等机器消息）`
          + '从 JSONL 日志中物理删除；真实提示词一条不动。\n'
          + '删除前会自动在 ~/.nx-rp/snapshots/ 留快照，可回滚。\n'
          + '要清全部目录请用命令行：nx-rp hook clean --all',
      });
      if (!ok) return;
      const r = await api('/api/hook-prompt/clean', { method: 'POST', body: { cwd: target } });
      toast(r && r.removed ? `已清理 ${r.removed} 条系统注入记录` : '没有可清理的系统注入记录');
      await loadLogs();
    } finally {
      setCleaning(false);
    }
  }), [guard, dialog, toast, loadLogs, activeScope, cleaning]);

  const dom = useHookDomain({
    statusUrl: '/api/hook-prompt/status',
    onUrl: '/api/hook-prompt/on',
    offUrl: '/api/hook-prompt/off',
    offDialog: {
      title: '停用提示词日志？',
      message: '会从 ~/.claude/settings.json 摘掉提示词日志那条 hook（写前自动留快照；Skill 追踪等其他 hooks 不动）。',
      okText: '停用',
    },
    note: cwd ? '已锁定到一条目录' : '记录跟随当前 scope，下方可切换已注册目录',
    statusNote: () => 'UserPromptSubmit',
    extraRows: (st) => [['日志目录', st.logDir, `${st.logDir}（一条目录一个文件，按归一化路径分片；查询时按路径聚合）`]],
  });

  return (
    <div>
      {dom.toolbar}
      {dom.errorCard}

      <div className="card">
        <div className="colhead">
          <span>提示词记录</span>
          <span className="muted">
            {logs ? `${logs.length} 条` : (logsError ? '加载失败' : '加载中…')}
            {systemCount > 0 ? (
              <>
                {' · '}
                <span
                  style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
                  onClick={() => setShowSystem((v) => !v)}
                  title="系统注入的机器消息（<task-notification> 等），默认不显示。点击切换是否列出。"
                >
                  {showSystem ? `含 ${systemCount} 条系统注入（点击隐藏）` : `已隐藏 ${systemCount} 条系统注入（点击显示）`}
                </span>
              </>
            ) : null}
          </span>
        </div>

        <div className="toolbar" style={{ padding: '8px 12px', gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>目录</span>
          <select
            value={cwd || ''}
            onChange={(e) => setCwd(e.target.value || null)}
            title={`只列已注册的目录（nx-rp 用过的项目，${options.length} 个）；选「跟随当前目录」即跟随当前 scope；日志里另有 ${unregistered} 个未注册目录未列出`}
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
          {systemCount > 0 ? (
            <button
              className="btn small ghost"
              onClick={clean}
              disabled={cleaning}
              title="把系统注入的记录从 JSONL 日志里物理删除（写前留快照，可回滚）"
            >
              {cleaning ? '清理中…' : '清理系统注入记录'}
            </button>
          ) : null}
          {logsError ? (
            <button className="btn small ghost" onClick={loadLogs}>重试</button>
          ) : null}
        </div>

        {!logs ? <div className="empty">{logsError ? '无法加载' : '加载中…'}</div>
          : logs.length === 0 ? (
            <div className="empty">
              {systemCount > 0
                ? `（该范围只有 ${systemCount} 条系统注入记录，没有真实提示词——点「清理系统注入记录」可清掉）`
                : '（该目录暂无记录——在启用 hook 的会话里发一条提示词后再来）'}
            </div>
          ) : logs.map((r, i) => (
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

      {dom.statusCard}
      <ManualAddCard snippet={dom.status?.snippet} eventKey="UserPromptSubmit" />

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
            </div>
          ) : null}
        </Modal>
      )}
      {dom.dialogNode}
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

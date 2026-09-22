// Skill 追踪面板：健康分统计卡片 + 开关状态卡片 + 手动添加卡片。
//
// 与 link / doc / workflow 同构：数据从 /api 拉，操作走同一条 action，
// 底部 CLI 提示由命令表派生（CliHints）。开关只动本 hook 的 entry
// （marker `__nx_rp_skill_track__`），不影响提示词日志等其他 hooks。
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { useDialog, useGuard, useToast } from '../../web/frontend/components/ui.jsx';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import { useStore } from '../../web/frontend/store.jsx';
import ManualAddCard from '../../web/frontend/components/ManualAddCard.jsx';

const LIMIT = 200;

export default function HookSkillView() {
  const { boot } = useStore();
  const [status, setStatus] = useState(null);
  const [skills, setSkills] = useState(null);
  const [all, setAll] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setStatus(await api('/api/hook-skill/status'));
      setSkills(await api('/api/hook-skill/skills' + (all ? '?all=true&limit=' + LIMIT : '?limit=' + LIMIT)));
    } catch (e) {
      // 失败要如实呈现——不能让「请求失败」伪装成「暂无记录」
      setLoadError(e.message || '加载失败');
    }
  }, [all]);

  useEffect(() => { refresh(); }, [refresh]);

  const enable = () =>
    guard(async () => {
      await api('/api/hook-skill/on', { method: 'POST', body: {} });
      toast('已启用');
      await refresh();
    });

  const disable = () =>
    guard(async () => {
      const ok = await dialog({
        title: '停用 Skill 追踪？',
        message: '会从 ~/.claude/settings.json 摘掉 Skill 追踪那条 hook（写前自动留快照；提示词日志等其他 hooks 不动）。',
        danger: true,
        okText: '停用',
      });
      if (!ok) return;
      await api('/api/hook-skill/off', { method: 'POST', body: {} });
      toast('已停用');
      await refresh();
    });

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <span className="muted">scope: <code>{boot?.cwdScope || ''}</code></span>
        <span className="muted" style={{ marginLeft: 'auto' }}>统计按 serve 进程的 cwd 过滤，勾选「跨全部目录」查看其它项目</span>
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
          <span>Skill 使用统计</span>
          <span className="muted">{skills ? `${skills.length} 个` : '加载中…'}</span>
        </div>
        <div className="toolbar" style={{ padding: '8px 12px' }}>
          <button className="btn small" onClick={enable} disabled={!status || status.enabled || status.corrupt}>启用</button>
          <button className="btn small ghost" onClick={disable} disabled={!status || !status.enabled || status.corrupt}>停用</button>
          <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ height: 'auto' }} />
            跨全部目录
          </label>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            健康分 = 使用量(0-60，相对最高频归一) + 新鲜度(0-40，30 天线性衰减)，借鉴 teamai-cli
          </span>
        </div>
        {!skills ? <div className="empty">{loadError ? '无法加载' : '加载中…'}</div>
          : skills.length === 0 ? <div className="empty">（暂无 Skill 记录——启用 hook 后在会话里触发一个 skill 再来）</div>
          : skills.map((r) => (
            <div key={r.skill} className="row">
              <div style={{ width: 80, flexShrink: 0, fontSize: 13, letterSpacing: 1 }} title={`健康分 ${r.score}/100`}>{r.stars}</div>
              <div className="name" style={{ width: 44, flexShrink: 0 }} title={`健康分 ${r.score}/100`}>{r.score}</div>
              <div className="name" style={{ width: 60, flexShrink: 0 }}>{r.count} 次</div>
              <div className="name" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.skill}</div>
              <div className="acts">
                <span className="muted" style={{ fontSize: 11 }}>最近 {fmt(r.lastUsed)}</span>
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
                  <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>PostToolUse · Skill</span>
                  {status.disableAllHooks ? <span className="tag bad" style={{ marginLeft: 6 }}>disableAllHooks</span> : null}
                  {status.corrupt ? <span className="tag bad" style={{ marginLeft: 6 }}>settings.json 损坏</span> : null}
                </dd>
              </div>
              <div className="kv-row">
                <dt>配置文件</dt>
                <dd className="mono nowrap" title={status.settingsPath}>{status.settingsPath}</dd>
              </div>
              <div className="kv-row">
                <dt>Skill 统计目录</dt>
                <dd className="mono nowrap" title={status.skillsDir}>{status.skillsDir}</dd>
              </div>
            </dl>
            {status.disableAllHooks ? (
              <p className="muted" style={{ marginTop: 8 }}>
                全局 <code>disableAllHooks: true</code> 会一票否决所有 hooks——即使这里显示已启用，skill 调用也不会被记录。
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

      <ManualAddCard snippet={status?.snippet} eventKey="PostToolUse" />

      {dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="hook-skill" />
      </div>
    </div>
  );
}

function fmt(ts) {
  return String(ts || '').replace('T', ' ').slice(0, 19);
}

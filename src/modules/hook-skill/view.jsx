// Skill 追踪面板：健康分统计卡。
//
// 头部三件套与启停动作由 useHookDomain 生成（hook 域三视图公共），本视图只管
// Skill 使用统计表。**统计是全局的，没有 scope 维度**：skill 装在
// `~/.claude/skills` 或 `<项目>/.claude/skills`，是跨目录的全局资产——
// 「这个 skill 最近用过吗」问的是本机整体，所以不提供、也不显示 cwd 筛选。
//
// 统计表跟着状态一起拉（afterRefresh）——失败落进共享错误卡，重试一次救全部，
// 符合「同一个作用域下任何一项失败都该被看见」的预期。
import { useState } from 'react';
import { api } from '../../web/frontend/api/client.js';
import { CliHints } from '../../web/frontend/components/CliHints.jsx';
import ManualAddCard from '../../web/frontend/components/ManualAddCard.jsx';
import { useHookDomain } from '../../web/frontend/components/hook-domain.jsx';

const LIMIT = 200;

export default function HookSkillView() {
  const [skills, setSkills] = useState(null);

  const dom = useHookDomain({
    statusUrl: '/api/hook-skill/status',
    onUrl: '/api/hook-skill/on',
    offUrl: '/api/hook-skill/off',
    offDialog: {
      title: '停用 Skill 追踪？',
      message: '会从 ~/.claude/settings.json 摘掉 Skill 追踪那条 hook（写前自动留快照；提示词日志等其他 hooks 不动）。',
      okText: '停用',
    },
    showScope: false,
    note: '全局统计——skill 装在本机、跨项目通用，无目录筛选',
    statusNote: (st) => `工具调用[${st.toolHook ? '✓' : '✗'}] PostToolUse · 斜杠[${st.slashHook ? '✓' : '✗'}] UserPromptSubmit`,
    extraRows: (st) => [['Skill 统计目录', st.skillsDir, `${st.skillsDir}（分片存放；查询时全局聚合）`]],
    extraWarnings: (st) => {
      const out = [];
      if (st.manualCount > 0) out.push(<>检测到 {st.manualCount} 条手工粘贴条目——「停用」时会一并摘除。</>);
      if (st.enabled && !st.slashHook) out.push(<>斜杠落点未启用——<code>/skill</code> 调用不会被记录，重新「启用」可补上。</>);
      return out;
    },
    afterRefresh: async () => setSkills(await api('/api/hook-skill/skills?limit=' + LIMIT)),
  });

  return (
    <div>
      {dom.toolbar}
      {dom.errorCard}

      <div className="card">
        <div className="colhead">
          <span>Skill 使用统计</span>
          <span className="muted">{skills ? `${skills.length} 个` : (dom.loadError ? '加载失败' : '加载中…')}</span>
        </div>
        <div className="toolbar" style={{ padding: '8px 12px' }}>
          <span
            className="muted"
            style={{ fontSize: 12 }}
            title="健康分 = 使用量(0-60，相对最高频归一) + 新鲜度(0-40，30 天线性衰减)，借鉴 teamai-cli"
          >
            健康分 = 使用量 + 新鲜度
          </span>
        </div>
        {!skills ? <div className="empty">{dom.loadError ? '无法加载' : '加载中…'}</div>
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

      {dom.statusCard}
      <ManualAddCard snippet={dom.status?.snippet} eventKey="PostToolUse" />
      {dom.dialogNode}
      <div style={{ marginTop: 12 }}>
        <CliHints module="hook-skill" />
      </div>
    </div>
  );
}

function fmt(ts) {
  return String(ts || '').replace('T', ' ').slice(0, 19);
}

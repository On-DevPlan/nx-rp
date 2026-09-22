// 「手动添加」卡片（hook 域共用）：可复制 JSON 片段 + 配置层级说明。
//
// 面板上的「启用」按钮直接写 ~/.claude/settings.json；但有人想把片段手动
// 放进项目级 / 本地级配置（团队共享、只在某项目生效）。这张卡给两样东西：
// 可整块复制的 JSON 片段（与工具写入的同源，由各模块 service 的
// manualSnippet() 生成）+ 三层配置的作用域说明。
import { useToast, Copyable } from './ui.jsx';

const LEVELS = [
  {
    where: '~/.claude/settings.json',
    scope: '用户级',
    effect: '你的所有项目，只对自己生效',
    hint: '个人偏好放这里。面板「启用」按钮写的就是这个文件。',
  },
  {
    where: '<项目>/.claude/settings.json',
    scope: '项目级',
    effect: '提交进 Git，团队共享',
    hint: '想让全组都记时用；注意 hook 命令要求每人本机装过 nx-rp。',
  },
  {
    where: '<项目>/.claude/settings.local.json',
    scope: '本地级',
    effect: '仅当前项目、仅自己（被 gitignore）',
    hint: '只在某个项目记，又不想影响同事时用。',
  },
];

export default function ManualAddCard({ snippet, eventKey }) {
  const toast = useToast();
  const json = snippet ? JSON.stringify(snippet, null, 2) : null;

  const copyAll = async () => {
    if (!json) return;
    try {
      await navigator.clipboard.writeText(json);
      toast('已复制 hook 配置片段');
    } catch {
      toast('复制失败（剪贴板不可用）');
    }
  };

  return (
    <div className="card">
      <div className="colhead">
        <span>手动添加</span>
        <span className="muted">不想用上面的按钮？把片段粘进配置文件的 hooks 字段</span>
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          粘到目标文件的 <code>"hooks"</code> 字段下（已有 hooks 内容时，把 <code>{eventKey}</code> 数组合并进去，别整个覆盖）：
        </div>
        {json ? (
          <Copyable text={json} title="点击复制整段 JSON" className="snippet-box">
            <pre style={{ margin: 0, whiteSpace: 'pre', overflowX: 'auto' }}>{json}</pre>
          </Copyable>
        ) : (
          <div className="empty">状态加载后显示</div>
        )}
        {json && (
          <div style={{ marginTop: 6 }}>
            <button className="btn small" onClick={copyAll}>复制片段</button>
            <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>点击代码块或按钮均可复制</span>
          </div>
        )}

        <div className="muted" style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>放哪个文件？——三层配置按作用域从大到小：</div>
          <table className="levels">
            <thead>
              <tr><th>文件位置</th><th>层级</th><th>影响范围</th></tr>
            </thead>
            <tbody>
              {LEVELS.map((l) => (
                <tr key={l.where}>
                  <td className="mono">{l.where}</td>
                  <td><span className="tag">{l.scope}</span></td>
                  <td>{l.effect}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="muted" style={{ fontSize: 12, margin: '8px 0 0', paddingLeft: 18 }}>
            <li>各层是<b>合并</b>而不是覆盖：项目级配了 hooks 不会顶掉用户级的，两边都会跑。</li>
            <li>同一个事件下，本片段可以和你已有的其他 hooks 并存，互不影响。</li>
            <li>排查时在 Claude Code 里输入 <code>/hooks</code> 能看到每条 hook 的来源层级。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// 「手动添加」卡片（hook 域共用）：可复制 JSON 片段 + 配置层级说明。
//
// 面板上的「启用」按钮直接写配置文件；但有人想把片段手动放进项目级 / 本地级
// 配置（团队共享、只在某项目生效）。这张卡给两样东西：可整块复制的 JSON 片段
// （与工具写入的同源，由各模块 service 的 manualSnippet() 生成）+ 三层配置的
// 作用域说明。
//
// 三层说明默认**折叠**：它是教学材料而不是操作路径，三个 hook 模块各渲染一份，
// 全展开时是面板上最大的一块常驻小字。折叠后可见区只剩要操作的那一句 + 片段。
import { useToast, Copyable } from './ui.jsx';

const LEVELS = [
  {
    where: '~/.claude/settings.json',
    scope: '用户级',
    effect: '你的所有项目，只对自己生效',
  },
  {
    where: '<项目>/.claude/settings.json',
    scope: '项目级',
    effect: '提交进 Git，团队共享',
  },
  {
    where: '<项目>/.claude/settings.local.json',
    scope: '本地级',
    effect: '仅当前项目、仅自己（被 gitignore）',
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
          粘到目标文件的 <code>"hooks"</code> 字段下（已有内容时合并 <code>{eventKey}</code> 数组，别整体覆盖）：
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
          </div>
        )}

        <details style={{ marginTop: 14 }}>
          <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
            放哪个文件？——三层配置按作用域从大到小
          </summary>
          <div className="muted">
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
            <ul style={{ fontSize: 12, margin: '8px 0 0', paddingLeft: 18 }}>
              <li>各层是<b>合并</b>而不是覆盖：项目级配了 hooks 不会顶掉用户级的，两边都会跑。</li>
              <li>同一个事件下，本片段可以和你已有的其他 hooks 并存，互不影响。</li>
              <li>本片段与面板「启用」按钮写盘的<b>完全一致</b>（含工具的识别指纹）：
                粘进用户级后再点「启用」不会重复添加；「停用」也会把它一并摘掉。</li>
              <li>排查时在 Claude Code 里输入 <code>/hooks</code> 能看到每条 hook 的来源层级。</li>
            </ul>
          </div>
        </details>
      </div>
    </div>
  );
}

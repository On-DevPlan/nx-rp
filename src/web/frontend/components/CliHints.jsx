// 「这个面板上的每个按钮都有等价 CLI 命令」提示：数据驱动，不手写。
import { Fragment } from 'react';
import { Copyable } from './ui.jsx';
import { useStore } from '../store.jsx';

export function CliHints({ module }) {
  const { boot } = useStore();
  const cmds = (boot?.commands || []).filter((c) => c.module === module && c.module !== '_builtin');
  if (!cmds.length) return null;
  return (
    <div className="cli-hint">
      <span className="cli-hint-label">每个按钮都有一条同构 CLI 命令：</span>
      {cmds.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <span className="cli-hint-sep"> · </span>}
          <Copyable className="cli-cmd" text={c.command} title={'点击复制：' + c.command}>{c.command}</Copyable>
        </Fragment>
      ))}
      <span className="cli-hint-tail">。加 <code>--json</code> 得机器可读输出。</span>
    </div>
  );
}
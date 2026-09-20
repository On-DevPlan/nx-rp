// 交给 OS 的动作：开浏览器等。
//
// 唯一原因是「进程启动场景下要打开浏览器，但又不想静默失败」——
// 这种边界情形才值得抽到 core。其他「调用外部命令」直接用 node:child_process 即可。
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

// 打开 URL；best-effort，失败不抛。
export function openBrowser(url) {
  try {
    if (platform() === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
    else if (platform() === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  } catch {
    // ignore
  }
}
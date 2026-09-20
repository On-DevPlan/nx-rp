// 平台命令：serve / help / version —— 不属于任何业务域。
//
// 与模块 action 同形状、同命令表 ALL_COMMANDS。serve / help / version 进同一张表，
// 所以 help 与 routes 不会漏掉它们，也不会出现两张长度不同的「命令表」。
import { startServer } from './server.js';
import { openBrowser } from '../core/open.js';
import { storePathFromEnv } from '../core/paths.js';
import { invalidInput as _invalidInput } from '../core/errors.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')).version;

// 命令表中的 entry —— help / bootstrap / routes 都从这里派生
export function commandEntry(action) {
  // path 第一条作主键
  const cli = action.cli || [];
  const path = Array.isArray(cli[0]) ? cli[0] : cli;
  return {
    id: action.id,
    module: action.module || '_builtin',
    command: 'nx-rp ' + path.join(' '),
    summary: action.summary || '',
    http: action.http ? { method: action.http[0], path: action.http[1] } : null,
  };
}

// ---- serve ----
async function cmdServe(rest) {
  const port = Number(rest?.[0]) || Number(process.env.NX_RP_PORT) || 7820;
  const open = !rest?.includes('--no-open');

  // 触发装载期自检
  await import('./registry.js');
  // 这里 import api.js 会触发路由表装载
  await import('./api.js');

  const server = await startServer({ port });
  const url = `http://127.0.0.1:${port}`;
  console.log(`面板:   ${url}`);
  console.log(`存储:   ${storePathFromEnv()}`);
  console.log(`加 --json 到所有命令得机器可读输出。Ctrl+C 退出。`);

  if (open) openBrowser(url);

  return new Promise((resolve) => {
    process.on('SIGINT', () => {
      server.close(() => { console.log('bye.'); resolve({ status: 'ok' }); process.exit(0); });
    });
  });
}

// ---- help ----

// ---- version ----
async function cmdVersion() {
  return VERSION;
}

export const BUILTINS = [
  {
    id: 'serve',
    cli: ['serve'],
    summary: '启动 Web 面板（默认 :7820；--port N 改端口；--no-open 不开浏览器）',
    run: cmdServe,
    render: () => '',
  },
  {
    id: 'help',
    cli: ['help'],
    summary: '列出全部命令',
    run: async () => {
      const { ACTIONS } = await import('./registry.js');
      return [...BUILTINS, ...ACTIONS].map(commandEntry);
    },
    render: (entries) => {
      const w = Math.max(...entries.map((e) => e.command.length));
      return entries
        .map((e) => `${e.command.padEnd(w + 2)}${e.summary}`)
        .join('\n');
    },
  },
  {
    id: 'version',
    cli: ['version'],
    summary: '版本号',
    run: cmdVersion,
    render: (v) => String(v),
  },
];
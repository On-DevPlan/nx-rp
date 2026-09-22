// 平台命令：serve / help / version —— 不属于任何业务域。
//
// 与模块 action 同形状、同命令表 ALL_COMMANDS。serve / help / version 进同一张表，
// 所以 help 与 routes 不会漏掉它们，也不会出现两张长度不同的「命令表」。
import { startServer } from './server.js';
import { openBrowser } from '../core/open.js';
import { storePathFromEnv, cwdScope } from '../core/paths.js';
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
//
// 参数解析独立成纯函数：builtin 不走 spec parser，rest 就是裸 token 流；
// 手写解析的地方越少越好，这里集中一处、可单测。
// 跳过 `--store <path>` 对：cli.js 的全局解析已把它写进 NX_RP_STORE 并追加进 rest，
// 不跳过的话它的值会被误当位置端口。
export function parseServeArgs(rest) {
  const out = { port: undefined, open: true };
  const tokens = rest || [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--store') { i++; continue; }          // 全局 flag 的「名 值」对，跳过值
    if (tok.startsWith('--store=')) continue;
    if (tok === '--no-open') { out.open = false; continue; }
    if (tok === '--port') {
      const v = tokens[++i];
      if (v === undefined) throw _invalidInput('用法: nx-rp serve [--port N] [--no-open] —— --port 需要值');
      out.port = Number(v);
      if (Number.isNaN(out.port)) throw _invalidInput(`--port 期望数字，收到 ${v}`);
      continue;
    }
    if (tok.startsWith('--port=')) {
      out.port = Number(tok.slice(7));
      if (Number.isNaN(out.port)) throw _invalidInput(`--port 期望数字，收到 ${tok.slice(7)}`);
      continue;
    }
    if (tok.startsWith('--')) continue;                // 未知 flag 容忍跳过（与旧行为一致）
    if (out.port === undefined) out.port = Number(tok); // 第一个位置参数 = 端口
  }
  return out;
}

// 端口上是不是已经在跑一个 nx-rp 面板？/api/health 的 cwdScope 字段就是签名
// （system/index.js 的 health 一定返回它），外来进程要么 404 要么没有这个字段。
async function probeNxRp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body && body.ok && body.data && body.data.cwdScope);
  } catch {
    return false;
  }
}

async function cmdServe(rest) {
  const { port: portArg, open } = parseServeArgs(rest);
  const port = portArg || Number(process.env.NX_RP_PORT) || 7820;

  // 触发装载期自检
  await import('./registry.js');
  // 这里 import api.js 会触发路由表装载
  await import('./api.js');

  let server;
  try {
    server = await startServer({ port });
  } catch (err) {
    // EADDRINUSE 不是无脑报错：先看看端口上是不是自己的面板。
    // 是 → 登记当前目录到 recents + 打开浏览器就完事，一个面板管所有项目；
    // 不是 → 才是真正的端口冲突，让用户换端口。
    if (err && err.code === 'EADDRINUSE' && await probeNxRp(port)) {
      const { touchRecent } = await import('../modules/system/index.js');
      const entry = await touchRecent(process.cwd()).catch(() => null);
      const url = `http://127.0.0.1:${port}`;
      console.log(`面板已在运行: ${url}`);
      console.log(`已登记当前目录: ${entry ? entry.path : process.cwd()}`);
      if (open) openBrowser(url);
      return { status: 'reused', port, url };
    }
    throw err;
  }

  // 启动成功：把自己登记进 recents（面板的「最近目录」列表）。
  // 失败不阻塞启动——recents 是锦上添花，store 只读等异常不该拦住面板。
  await (async () => {
    try {
      const { touchRecent } = await import('../modules/system/index.js');
      await touchRecent(process.cwd());
    } catch (e) {
      console.error(`(recents 登记失败，不影响服务: ${e.message})`);
    }
  })();

  const url = `http://127.0.0.1:${port}`;
  console.log(`面板:   ${url}`);
  console.log(`scope:  ${cwdScope()}`);
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

// ---- skill install ----
//
// 把 assets/<skill名>/ 装到 ~/.claude/skills（默认）或 --to <dir>。
// 三态：不存→安装；存在且一致→{status:'ok',skipped:true}；存在但内容不同→
// {status:'conflict', files:[...]}，退出码 0（业务结果）。
// 用户目录里的东西永远不要静默覆盖。
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

function hashFile(p) {
  const h = createHash('md5');
  h.update(readFileSync(p));
  return h.digest('hex');
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) out.push({ rel, abs, hash: hashFile(abs) });
    }
  };
  walk(root, '');
  return out;
}

function diffTrees(src, dst) {
  const a = listFiles(src);
  const b = listFiles(dst);
  const bMap = new Map(b.map((f) => [f.rel, f.hash]));
  const diffs = [];
  for (const f of a) {
    if (bMap.get(f.rel) !== f.hash) diffs.push(f.rel);
  }
  const aMap = new Map(a.map((f) => [f.rel, true]));
  for (const f of b) {
    if (!aMap.has(f.rel)) diffs.push('-' + f.rel); // 目标端有但源端没有
  }
  return diffs;
}

async function cmdSkill(rest) {
  // rest 形如 ['install', 'name', '--to', '<dir>', '--force']
  // skill 是顶层 dispatcher，子命令在 rest 里
  const argv = rest || [];
  const sub = argv[0];
  if (sub !== 'install') {
    throw new Error(`用法: nx-rp skill ${sub ? '<未知子命令>' : '<子命令>'}\n可用: nx-rp skill install [name] [--to <dir>] [--force]`);
  }
  const force = argv.includes('--force');
  const toIdx = argv.indexOf('--to');
  const to = toIdx >= 0 && argv[toIdx + 1] ? argv[toIdx + 1] : DEFAULT_SKILLS_DIR;

  // skill 名：argv[1]（如果有且不是 --to/--force）
  let skillName = argv[1];
  if (skillName && (skillName === '--to' || skillName === '--force')) {
    // --to 在前
    skillName = undefined;
  }
  // 默认名 = 包名
  if (!skillName) skillName = 'nx-rp';

  // 找源目录：assets/<name>
  const herePkg = dirname(fileURLToPath(import.meta.url));
  const assetsRoot = resolve(herePkg, '..', '..', 'assets');
  const src = join(assetsRoot, skillName);
  if (!existsSync(src) || !existsSync(join(src, 'SKILL.md'))) {
    const available = existsSync(assetsRoot)
      ? readdirSync(assetsRoot).filter((d) => statSync(join(assetsRoot, d)).isDirectory())
      : [];
    throw new Error(`未找到内置 skill: ${skillName}（可用: ${available.join(', ')}）`);
  }

  const dst = resolve(join(to, skillName));
  const diffs = diffTrees(src, dst);

  if (!existsSync(dst)) {
    await copyTree(src, dst);
    return { status: 'ok', installed: true, path: dst, files: listFiles(dst).length };
  }
  if (diffs.length === 0) {
    return { status: 'ok', skipped: true, path: dst, files: 0 };
  }
  if (!force) {
    return { status: 'conflict', path: dst, files: diffs, count: diffs.length };
  }
  // --force 覆盖
  await rmrf(dst);
  await copyTree(src, dst);
  return { status: 'ok', replaced: true, path: dst, files: listFiles(dst).length };
}

async function copyTree(src, dst) {
  const { cp } = await import('node:fs/promises');
  await cp(src, dst, { recursive: true, dereference: true });
}

async function rmrf(p) {
  const { rm } = await import('node:fs/promises');
  await rm(p, { recursive: true, force: true });
}

export const BUILTINS = [
  {
    id: 'serve',
    cli: ['serve'],
    summary: '启动 Web 面板（默认 :7820；--port N 改端口；--no-open 不开浏览器；端口上已有 nx-rp 面板则登记当前目录并直接打开它）',
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
  {
    id: 'skill',
    cli: ['skill'],  // 顶层 dispatcher，子命令 install 在 rest 里分发
    summary: 'skill 子命令（目前: install）',
    run: cmdSkill,
    render: (r) => {
      if (!r) return '';
      if (r.status === 'ok' && r.skipped) return `已是最新: ${r.path}（无差异）`;
      if (r.status === 'ok' && r.installed) return `已安装: ${r.path}（${r.files} 文件）`;
      if (r.status === 'ok' && r.replaced) return `已替换: ${r.path}（${r.files} 文件）`;
      if (r.status === 'conflict') return `冲突: ${r.path}（${r.count} 文件不同，加 --force 覆盖）`;
      return JSON.stringify(r);
    },
  },
];
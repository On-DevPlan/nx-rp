// 平台命令：serve / help / version —— 不属于任何业务域。
//
// 与模块 action 同形状、同命令表 ALL_COMMANDS。serve / help / version 进同一张表，
// 所以 help 与 routes 不会漏掉它们，也不会出现两张长度不同的「命令表」。
import { startServer } from './server.js';
import { openBrowser } from '../core/open.js';
import { storePathFromEnv, cwdScope } from '../core/paths.js';
import { invalidInput as _invalidInput } from '../core/errors.js';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

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
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const ASSETS_ROOT = resolve(HERE, '..', '..', 'assets');
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

async function runInstall(argv) {
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

  const src = join(ASSETS_ROOT, skillName);
  if (!existsSync(src) || !existsSync(join(src, 'SKILL.md'))) {
    const available = existsSync(ASSETS_ROOT)
      ? readdirSync(ASSETS_ROOT).filter((d) => statSync(join(ASSETS_ROOT, d)).isDirectory())
      : [];
    throw _invalidInput(`未找到内置 skill: ${skillName}（可用: ${available.join(', ')}）`);
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

// ---- skill get ----
//
// 把内置 skill 的 SKILL.md（默认）/ references/<x>.md 输出到 stdout，
// 同时按 install 既有逻辑装到 ~/.claude/skills/<name>。
//
// 设计取舍：
//   - 输出顺序 = prefix → 文档 → install 状态。
//     部分 agent 输出过长会自动截断，prefix 必须最先告诉 agent 文件位置与复制建议。
//   - ref 永远给文档：与 install 既有三态共存，conflict 状态不影响内容输出。
//   - --to：与 install 行为一致（覆盖默认目标到沙箱目录）。
//   - --force：静默忽略。get 的语义是"读"，不应被 install 副作用覆盖；向前兼容不抛错。
//   - ref 路径解析：缺省 SKILL.md；带分隔符或 ./ 开头走资产根相对解析（assertInside 兜底）；
//     裸名先查 references/<name>.md，再查 <name>.md。
async function runGet(argv) {
  // 解析 flag；--to 取其值，--force 静默丢弃
  let customTo;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') {
      const v = argv[++i];
      if (v !== undefined) customTo = v;
      continue;
    }
    if (a === '--force') continue;
    positional.push(a);
  }
  const skillName = positional[1] || 'nx-rp';
  const ref = positional[2]; // 缺省 → resolveRefDoc 默认走 SKILL.md

  const doc = resolveRefDoc(skillName, ref);

  // 构造 install argv（剥离 ref 与所有 flag）
  const installArgv = ['install', skillName];
  if (customTo) installArgv.push('--to', customTo);
  const installResult = await runInstall(installArgv);

  return {
    skillName,
    ref: doc.label,
    content: doc.content,
    contentBytes: doc.bytes,
    install: installResult,
  };
}

function resolveRefDoc(skillName, ref) {
  const root = join(ASSETS_ROOT, skillName);
  if (!existsSync(root)) {
    const available = existsSync(ASSETS_ROOT)
      ? readdirSync(ASSETS_ROOT).filter((d) => statSync(join(ASSETS_ROOT, d)).isDirectory())
      : [];
    throw _invalidInput(`未找到内置 skill: ${skillName}（可用: ${available.join(', ')}）`);
  }

  // 路径穿越防护（任何分隔符下的 '..' 段都拒）
  if (ref && ref.split(/[\\/]/).includes('..')) {
    throw _invalidInput(`ref 路径不允许包含 '..': ${ref}`);
  }

  // 1) 缺省 → SKILL.md（绝对路径）
  if (!ref) return readDoc(join(root, 'SKILL.md'), 'SKILL.md');

  // 2) 带分隔符或 ./ 开头 → 相对资产根解析（assertInside 兜底绝对路径越界）
  if (ref.includes('/') || ref.includes(sep) || ref.startsWith('./')) {
    const abs = resolve(root, ref);
    assertInside(abs, root);
    return readDoc(abs, ref);
  }

  // 3) 裸名：先 references/<name>.md，再 <name>.md
  const refMd = join(root, 'references', `${ref}.md`);
  if (existsSync(refMd)) return readDoc(refMd, `references/${ref}.md`);
  const rootMd = join(root, `${ref}.md`);
  if (existsSync(rootMd)) return readDoc(rootMd, `${ref}.md`);

  // 4) 找不到：列可用 references/*.md（剥扩展名，与裸名输入对齐）
  const refsDir = join(root, 'references');
  const available = existsSync(refsDir)
    ? readdirSync(refsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
    : [];
  throw _invalidInput(`未找到 ref: ${ref}（可用: ${available.join(', ')}）`);
}

function readDoc(absPath, label) {
  if (!existsSync(absPath)) throw _invalidInput(`${label} 不存在`);
  return {
    label,
    path: absPath,
    content: readFileSync(absPath, 'utf8'),
    bytes: statSync(absPath).size,
  };
}

function assertInside(p, root) {
  const normP = resolve(p);
  const normR = resolve(root) + sep;
  if (normP !== resolve(root) && !normP.startsWith(normR)) {
    throw _invalidInput(`ref 越界: ${p}`);
  }
}

async function copyTree(src, dst) {
  const { cp } = await import('node:fs/promises');
  await cp(src, dst, { recursive: true, dereference: true });
}

async function rmrf(p) {
  const { rm } = await import('node:fs/promises');
  await rm(p, { recursive: true, force: true });
}

async function cmdSkill(rest) {
  // 顶层 dispatcher：子命令在 rest[0] 里分发。
  // install 与 get 共用 runInstall，避免两块几乎一样的参数解析与拷贝逻辑漂移。
  const argv = rest || [];
  const sub = argv[0];
  if (sub === 'install') return runInstall(argv);
  if (sub === 'get') return runGet(argv);
  throw _invalidInput(`用法: nx-rp skill <子命令>
可用: nx-rp skill install [name] [--to <dir>] [--force]
      nx-rp skill get [name] [ref]  [--to <dir>]
子命令: ${sub || '<空>'}`);
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
    cli: ['skill'],  // 顶层 dispatcher，子命令 install/get 在 rest 里分发
    summary: 'skill 子命令（目前: install, get）',
    run: cmdSkill,
    render: (r) => {
      if (!r) return '';
      // install 三态（status/installed/skipped/replaced/conflict）走原有四分支渲染。
      // get 包装形态（带 .install 字段）走 prefix → doc → install summary 三段拼接。
      if (!r.install) {
        if (r.status === 'ok' && r.skipped) return `已是最新: ${r.path}（无差异）`;
        if (r.status === 'ok' && r.installed) return `已安装: ${r.path}（${r.files} 文件）`;
        if (r.status === 'ok' && r.replaced) return `已替换: ${r.path}（${r.files} 文件）`;
        if (r.status === 'conflict') return `冲突: ${r.path}（${r.count} 文件不同，加 --force 覆盖）`;
        return JSON.stringify(r);
      }
      const lines = [];
      lines.push('# === nx-rp skill context ===');
      lines.push(`# 以下内容来自 nx-rp skill \`${r.skillName}\` ${r.ref}。`);
      lines.push('# 这是给你的 prompt 上下文——');
      lines.push(`#   1) 这个 skill 已经被 install 到 ~/.claude/skills/${r.skillName}/（参见下方 install 状态）`);
      lines.push('#   2) 建议你把这整段内容（包括 SKILL.md / ref 文本）复制到');
      lines.push('#      你可直接访问的路径（例如你自己的笔记或上下文缓存），');
      lines.push('#      后续调用直接读那个文件，不必每次重新执行 `nx-rp skill get`');
      lines.push('#');
      lines.push('# --- begin skill content (do not modify this line) ---');
      lines.push('');
      lines.push(r.content);
      lines.push('');
      lines.push('-- install 状态 --');
      const ins = r.install;
      if (ins.status === 'ok' && ins.skipped) lines.push(`已是最新: ${ins.path}（无差异）`);
      else if (ins.status === 'ok' && ins.installed) lines.push(`已安装: ${ins.path}（${ins.files} 文件）`);
      else if (ins.status === 'ok' && ins.replaced) lines.push(`已替换: ${ins.path}（${ins.files} 文件）`);
      else if (ins.status === 'conflict') lines.push(`冲突: ${ins.path}（${ins.count} 文件不同，加 --force 覆盖）`);
      else lines.push(JSON.stringify(ins));
      return lines.join('\n');
    },
  },
];
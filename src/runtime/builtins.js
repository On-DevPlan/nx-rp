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

// 资产根**在调用时**求值（不是模块加载时）——否则测试的 import 顺序会决定行为。
// NX_RP_ASSETS_ROOT 覆盖是测试"多 skill group / 空清单"分支的唯一手段
// （照 paths.js 的 storePathFromEnv 惯例）。
function assetsRoot() {
  return process.env.NX_RP_ASSETS_ROOT || resolve(HERE, '..', '..', 'assets');
}
const DEFAULT_SKILLS_DIR = join(homedir(), '.claude', 'skills');

// ─── group 清单 ────────────────────────────────────────────────────
//
// assets/groups.json 是「group 名 → skill 名列表」的**别名表**，只做聚合，
// 不做第二条事实源：路径恒由 assets/<skills[i]>/ 推导，目录结构不变。
// 当前 group 名 ≡ skill 名（一对一）；skills 是数组，为将来一对多留余地。
//
// 分层降级（读路径绝不炸，但作者错误要吼）：
//   文件不存在 / JSON 损坏 → 目录扫描兜底，不崩（且损坏时 stderr 一行警告）
//   JSON 合法但 schema 错   → 抛 INVALID_INPUT（这是打包/作者事故，静默会藏 bug）
function listAssetDirs() {
  const root = assetsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => {
      try {
        return statSync(join(root, d)).isDirectory() && existsSync(join(root, d, 'SKILL.md'));
      } catch {
        return false;
      }
    })
    .sort();
}

function loadGroups() {
  const root = assetsRoot();
  const file = join(root, 'groups.json');
  // 目录扫描兜底：group 名即含 SKILL.md 的目录名
  const fallback = () => ({ map: Object.fromEntries(listAssetDirs().map((d) => [d, { skills: [d] }])), source: 'assets-dirs' });

  if (!existsSync(file)) return fallback();

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return fallback();
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.stderr.write(`nx-rp: 忽略损坏的 groups.json（${file}）—— 已降级为目录扫描\n`);
    return fallback();
  }

  // schema 校验：读得出来但没意义 = 作者写错了，不能静默
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.groups
      || typeof data.groups !== 'object' || Array.isArray(data.groups)) {
    throw _invalidInput(`groups.json schema 非法（${file}）：顶层应为 {version, groups:{name:{skills:[...]}}}`);
  }
  const map = {};
  for (const [name, v] of Object.entries(data.groups)) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.skills) || v.skills.length === 0) {
      throw _invalidInput(`groups.json 的 group「${name}」非法（${file}）：应为 {skills:[非空字符串数组]}，收到 ${JSON.stringify(v)}`);
    }
    for (const s of v.skills) {
      if (typeof s !== 'string' || !s || s.includes('..') || s.startsWith('.') || /[\\/]/.test(s)) {
        throw _invalidInput(`groups.json 的 group「${name}」含非法 skill 名: ${JSON.stringify(s)}（${file}）`);
      }
    }
    // 同名去重：避免重复三态与重复计数
    map[name] = { skills: [...new Set(v.skills)], summary: typeof v.summary === 'string' ? v.summary : '' };
  }
  return { map, source: 'manifest' };
}

// 可用的 group 名 = 清单键 ∪ 资产目录名（降级时两者可能各有一半）
function availableGroups() {
  const { map } = loadGroups();
  return [...new Set([...Object.keys(map), ...listAssetDirs()])].sort();
}

function resolveGroup(name) {
  const { map, source } = loadGroups();
  const entry = map[name];
  if (!entry) {
    throw _invalidInput(`未知 group: ${name}（可用: ${availableGroups().join(', ')}）—— group 名即 skill 名，也可直接 nx-rp skill install ${name}`);
  }
  return { group: name, skills: entry.skills, summary: entry.summary || '', source };
}

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

// ─── skill 参数解析 ────────────────────────────────────────────────
//
// 集中式 token 扫描（install 与 get 共用）。**不**用 argv 硬位置取值——
// 那会踩两个已实测复现的坑：
//   `install --force bogus`    → argv[1] 是 '--force'，被特判成「无名」，
//                                于是静默装成默认的 nx-rp，用户敲的名字被忽略
//   `install x --to --force`   → --to 缺值时静默回落到 DEFAULT_SKILLS_DIR
//                                （真实 ~/.claude/skills），且把 --force 当目录名
// 规则：已知 flag 缺值一律抛错（宁可报错，不可静默走错路径）；未知 --x 容忍跳过
// （向前兼容）；值以 '-' 开头视为缺值（否则 --flag 会把下一个 flag 吞成它的值）。
function parseSkillArgs(argv) {
  const positional = [];
  const flags = {};
  const VALUE_FLAGS = new Set(['--to', '--group']);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') { flags.force = true; continue; }

    // --name=value 形态
    const eq = a.indexOf('=');
    if (eq > 2 && a.startsWith('--')) {
      const name = a.slice(0, eq);
      if (VALUE_FLAGS.has(name)) {
        const v = a.slice(eq + 1);
        if (!v) throw _invalidInput(`${name} 需要一个值（收到空值: ${a}）`);
        flags[name.slice(2)] = v;
        continue;
      }
      // 未知 --x=y：容忍跳过（向前兼容）
      continue;
    }

    // --name value 形态
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        throw _invalidInput(`${a} 需要一个值（后面是 ${v === undefined ? '结尾' : `另一个 flag: ${v}`}）`);
      }
      flags[a.slice(2)] = v;
      i++;
      continue;
    }

    if (a.startsWith('--')) continue; // 未知 flag 容忍
    positional.push(a);
  }
  return { positional, flags };
}

// 批量安装：对每个 skill 名跑一次 installOne，再按「最重态」聚合。
//
// 返回值形状的取舍（约束：不能影响原命令）：
//   skills.length === 1 → 返回**与今天完全相同**的对象（仅在给了 --group 时多一个
//     group 字段），这样 render 的四个分支、runGet 的消费点、既有测试全都不用动
//   skills.length > 1   → {status, group, skills:[...]}，用显式 group 字段判别，
//     **不做形状嗅探**（长度 1 的退化结果里也可能带 skills 数组）
async function runInstall(argv) {
  const { positional, flags } = parseSkillArgs(argv);
  const force = !!flags.force;
  const to = flags.to || DEFAULT_SKILLS_DIR;

  // 剥掉子命令名（argv[0] === 'install'）
  const nameArgs = positional.slice(1);
  if (nameArgs.length > 1) {
    throw _invalidInput(`只接受一个 skill 名（收到: ${nameArgs.join(', ')}）`);
  }

  // group 与位置参数二选一：同时给 = 重复输入（二者等价），报错比猜意图友好
  if (flags.group && nameArgs.length > 0) {
    throw _invalidInput(`位置参数「${nameArgs[0]}」与 --group=${flags.group} 都给了（二者等价，二选一）`);
  }

  let skills;
  let group;
  if (flags.group) {
    const r = resolveGroup(flags.group);
    skills = r.skills;
    group = r.group;
  } else {
    skills = [nameArgs[0] || 'nx-rp']; // 约束：无参数仍装 nx-rp
  }

  const results = [];
  for (const name of skills) results.push({ name, ...(await installOne(name, { to, force })) });

  if (results.length === 1) {
    return group === undefined ? results[0] : { ...results[0], group };
  }
  // 最重态：任一 conflict → conflict；否则全 skipped → ok/skipped；否则 ok
  const anyConflict = results.some((r) => r.status === 'conflict');
  const allSkipped = results.every((r) => r.status === 'ok' && r.skipped);
  return {
    status: anyConflict ? 'conflict' : 'ok',
    group,
    skills: results,
    ...(allSkipped ? { skipped: true } : {}),
  };
}

async function installOne(skillName, { to, force }) {
  const src = join(assetsRoot(), skillName);
  if (!existsSync(src) || !existsSync(join(src, 'SKILL.md'))) {
    const available = listAssetDirs();
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
//   - --group：**只允许单选**。展开出 >1 个 skill 时要求显式指定——
//     多份文档拼一起会破坏上面"prefix → 文档 → install 状态"的三段结构。
//     给了 --group 时名字槽已被占用，位置参数**左移一位**（positional[1] 当 ref）。
async function runGet(argv) {
  const { positional, flags } = parseSkillArgs(argv);

  let skillName;
  let group;
  if (flags.group) {
    const r = resolveGroup(flags.group);
    if (r.skills.length > 1) {
      throw _invalidInput(`group「${r.group}」含多个 skill（${r.skills.join(', ')}），请显式指定：nx-rp skill get <name> [ref]`);
    }
    skillName = r.skills[0];
    group = r.group;
    // 名字槽被 --group 占用 → 位置参数左移：argv 里第 1 个位置参数是 ref
    if (positional.length > 2) {
      throw _invalidInput(`--group 模式下位置参数过多（收到: ${positional.slice(2).join(', ')}）—— 用法: nx-rp skill get --group=<g> [ref]`);
    }
  } else {
    skillName = positional[1] || 'nx-rp';
    if (positional.length > 3) {
      throw _invalidInput(`位置参数过多（收到: ${positional.slice(3).join(', ')}）—— 用法: nx-rp skill get [name] [ref]`);
    }
  }
  const ref = flags.group ? positional[1] : positional[2]; // 缺省 → resolveRefDoc 默认走 SKILL.md

  const doc = resolveRefDoc(skillName, ref);

  // 构造 install argv（剥离 ref 与所有 flag）
  const installArgv = ['install', skillName];
  if (flags.to) installArgv.push('--to', flags.to);
  const installResult = await runInstall(installArgv);

  return {
    skillName,
    ref: doc.label,
    content: doc.content,
    contentBytes: doc.bytes,
    install: installResult,
    ...(group === undefined ? {} : { group }),
  };
}

function resolveRefDoc(skillName, ref) {
  const root = join(assetsRoot(), skillName);
  if (!existsSync(root)) {
    throw _invalidInput(`未找到内置 skill: ${skillName}（可用: ${listAssetDirs().join(', ')}）`);
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

// 列出 group → skill 映射。带上 source（manifest / assets-dirs），
// 把「清单驱动还是降级到目录扫描」显式暴露出来——这是降级路径唯一能被观测的地方。
function runGroups(argv) {
  const { flags } = parseSkillArgs(argv);
  if (flags.group) throw _invalidInput('skill groups 不接受 --group（它就是用来列 group 的）');
  const { map, source } = loadGroups();
  const names = availableGroups();
  return names.map((name) => ({
    group: name,
    skills: map[name]?.skills || [name],
    summary: map[name]?.summary || '',
    source,
  }));
}

// `skill list`：列出所有可装的 skill + 默认安装谁 + 可装 group。
//
// 输出形态（render 渲染）：
//   可装的 skill:
//     * nx-rp           项目外部上下文管理（默认 install 装这个）
//     * rp-loop         自引用循环（Ralph 技术）
//   可装的 group:
//     * nx-rp           nx-rp
//     * rp-loop         rp-loop
//
// 数据来源：assets/ 目录扫描（兜底事实源）+ groups.json（默认 install 标记）。
function runList() {
  const skills = listAssetDirs().sort();
  const { map, source } = loadGroups();
  // 默认 install = groups.json 里 key 与 package.json 同名的那一条；缺失则 null。
  // package.json 路径从当前 cwd 解析（CLI 的工作目录）——比 import.meta.dirname 硬推更稳。
  const pkgName = (() => {
    try {
      return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).name;
    } catch { return null; }
  })();
  const defaultGroup = pkgName && map[pkgName] ? pkgName : null;
  const groups = availableGroups().sort();
  return { skills, defaultGroup, groups, source };
}


async function cmdSkill(rest) {
  // 顶层 dispatcher：子命令在 rest[0] 里分发。
  // install 与 get 共用 parseSkillArgs / runInstall，避免参数解析与拷贝逻辑漂移。
  const argv = rest || [];
  const sub = argv[0];
  if (sub === 'install') return runInstall(argv);
  if (sub === 'get') return runGet(argv);
  if (sub === 'groups') return runGroups(argv);
  if (sub === 'list') return runList();
  throw _invalidInput(`用法: nx-rp skill <子命令>
可用: nx-rp skill install [name]    [--to <dir>] [--force]
      nx-rp skill install --group=<g> [--to <dir>] [--force]
      nx-rp skill get [name] [ref]  [--to <dir>]
      nx-rp skill get --group=<g> [ref] [--to <dir>]
      nx-rp skill groups
      nx-rp skill list
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
    summary: 'skill 子命令（install / get / groups / list；--group=<名> 按 group 装）',
    run: cmdSkill,
    render: (r) => {
      if (!r) return '';
      // groups 子命令：返回数组（每个元素带 group 字段）
      if (Array.isArray(r) && r.length && r[0] && r[0].group !== undefined) {
        const w = Math.max(...r.map((g) => g.group.length));
        return r
          .map((g) => `${g.group.padEnd(w + 2)}${g.summary || `（${g.skills.join(', ')}）`}${g.source === 'manifest' ? '' : '（未读清单，按目录扫描）'}`)
          .join('\n');
      }
      // list 子命令：返回 { skills, defaultGroup, groups, source }
      if (Array.isArray(r.skills) && Array.isArray(r.groups)) {
        const skillLines = r.skills.map((s) => {
          const tag = (s === r.defaultGroup) ? '（默认 install）' : '';
          return `  * ${s.padEnd(14)}${tag}`;
        });
        const groupLines = r.groups.map((g) => `  * ${g}`);
        const sourceNote = r.source === 'assets-dirs' ? '（未读清单，按目录扫描）' : '';
        return [
          '可装的 skill:',
          ...skillLines,
          '',
          '可装的 group:',
          ...groupLines,
          sourceNote,
        ].filter(Boolean).join('\n');
      }
      // install 三态（status/installed/skipped/replaced/conflict）走原有四分支渲染。
      // get 包装形态（带 .install 字段）走 prefix → doc → install summary 三段拼接。
      if (!r.install) {
        // 多 skill 聚合（仅 --group 且展开出多个）：逐行列出。
        // 判别必须显式——单 skill 的退化结果里也可能带 skills 数组。
        if (Array.isArray(r.skills)) {
          const head = `group ${r.group}（${r.skills.length} 个 skill${r.skipped ? '，均为最新' : ''}）`;
          const body = r.skills.map((s) => {
            if (s.status === 'ok' && s.skipped) return `  已是最新: ${s.path}（无差异）`;
            if (s.status === 'ok' && s.installed) return `  已安装: ${s.path}（${s.files} 文件）`;
            if (s.status === 'ok' && s.replaced) return `  已替换: ${s.path}（${s.files} 文件）`;
            if (s.status === 'conflict') return `  冲突: ${s.path}（${s.count} 文件不同，加 --force 覆盖）`;
            return `  ${JSON.stringify(s)}`;
          });
          return [head, ...body].join('\n');
        }
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
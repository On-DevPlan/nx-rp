// 本地开发 shim：把全局 `nx-rp` 指向本仓库，改完代码立刻生效，不用发版。
//
// 为什么要脚本而不是让人手敲 `npm link`：
//   Windows 上 npm link 会在 npm 全局 prefix 下建一个 cmd shim，而这个机器的
//   nx-rp 是 volta 装的 —— 两者prefix 不同，link 完 `nx-rp` 仍然走 volta 那份旧包，
//   而且没人会注意到。脚本把这件事显式化：先探测现状，再选一条能真正生效的路子。
//
// 两条路子：
//   shim  —— 直接写一个可执行文件到 PATH 上的目录（volta bin / npm prefix），内容转发到本仓库
//   volta —— 本仓库 pnpm pack 出 tarball，volta install 那个 tarball
//
// 默认按现状自动选：nx-rp 由 volta 管的 → volta；否则 → shim。
// 两条都改全局状态，所以默认 dry-run，加 --yes 才动手；--unlink 还原。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '');
const IS_WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const unlink = argv.includes('--unlink');
const yes = argv.includes('--yes') || argv.includes('-y');
const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice(7);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// ─── 现状探测 ──────────────────────────────────────────────────────

function detect() {
  // 不用 `where`/`which`：解析输出在不同 shell 下格式不一。
  // 更可靠的是直接看 PATH 上的候选目录里有没有 nx-rp 可执行文件。
  const exts = IS_WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const paths = [];
  for (const d of dirs) {
    for (const ext of exts) {
      const f = join(d, 'nx-rp' + ext);
      if (existsSync(f)) { paths.push(f); break; }
    }
  }
  const isLocal = paths.some((p) => {
    if (p.includes(ROOT)) return true;
    try { return readFileSync(p, 'utf8').includes(ROOT); } catch { return false; }
  });

  // volta 的 bin 目录（PATH 上的那个 shim 就在这儿）
  const voltaBin = process.env.VOLTA_HOME
    ? join(process.env.VOLTA_HOME, 'bin')
    : join(process.env.LOCALAPPDATA || '', 'Volta', 'bin');
  const hasVolta = existsSync(voltaBin);

  // volta 装的那份包在哪儿
  const voltaPkg = hasVolta
    ? join(process.env.LOCALAPPDATA || '', 'Volta', 'tools', 'image', 'packages', pkg.name, 'node_modules', pkg.name, 'package.json')
    : null;
  const voltaVersion = voltaPkg && existsSync(voltaPkg)
    ? JSON.parse(readFileSync(voltaPkg, 'utf8')).version
    : null;

  return { paths, isLocal, voltaBin: hasVolta ? voltaBin : null, voltaVersion };
}

function samePath(a, b) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
void samePath; // 保留：跨平台路径比较的备用工具

// ─── 路子一：volta install 本地 tarball ────────────────────────────

function voltaInstall() {
  console.log(`[link:local] volta 模式：pnpm pack → volta install tarball`);
  if (!yes) {
    console.log(`  将执行: pnpm pack  //  volta install <tarball>`);
    return false;
  }
  const pack = run('pnpm', ['pack'], { cwd: ROOT, shell: IS_WIN });
  const tarball = pack.out.split(/\r?\n/).filter((l) => l.endsWith('.tgz')).pop();
  if (!tarball) {
    console.error('pnpm pack 没产出 tarball：\n' + pack.out + pack.err);
    return false;
  }
  const abs = join(ROOT, tarball);
  const inst = run('volta', ['install', pkg.name + '@' + abs], { shell: IS_WIN });
  console.log(inst.out || inst.err);
  console.log(`[link:local] 已装 ${abs}`);
  console.log('[link:local] 注意：这是「快照」，改代码后要重跑本命令；要实时生效用 --mode=shim。');
  return inst.code === 0;
}

// ─── 路子二：往 PATH 写转发 shim ───────────────────────────────────
//
// 刻意**不碰** volta 的 shim 文件。理由：
//   1. volta 装了两个文件（`nx-rp` 给 bash、`nx-rp.cmd` 给 cmd），只覆盖一个会留下
//      另一个指向旧版 —— 同一台机器两个 nx-rp，比没装还糟
//   2. volta 可能在别的命令里重建这两个文件，覆盖等于埋了个定时炸弹
// 改为把 shim 放在一个**排在 volta bin 之前**的目录里，靠 PATH 顺序胜出。
// 卸载 = 删掉那个目录里的文件，volta 那份原样还在，零风险。

const SHIM_TAG = 'nx-rp-local-shim';
const SHIM_DIR_NAME = 'nx-rp-dev';

// shim 的落点：**用户 PATH 里第一个含 volta\bin 的目录**（即 volta 自己的 bin）。
//
// 为什么就用它，不做更多挑选：
//   - 覆盖 volta 的 `nx-rp.cmd` 不需要改 PATH —— volta 把 bin 放在用户 PATH 第 2 位，
//     直接原地替换即可生效
//   - 同一个目录里还有一个无扩展名的 `nx-rp`（bash 用），必须一起写，否则
//     Git Bash 和 cmd 会各自解析到不同版本 —— 那比不装还难排查
//
// 代价：volta 可能在别的命令里重建这两个文件，把 shim 冲掉。这是可接受的——
// 冲掉后 nx-rp 回到 volta 那份，功能仍在（只是版本旧了），重跑本命令即可。
// 注意别用 setx 改 PATH：本机用户 PATH 含 %JAVA_HOME%\bin 这类变量引用，
// setx 会把它们展开成写死的路径。
function pickShimDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!IS_WIN) {
    const dir = join(home, '.local', 'bin');
    const onPath = (process.env.PATH || '').split(':').some((d) => samePath(d, dir));
    return { dir, onPath, source: 'posix 默认' };
  }

  // 读法与 detect() 一致，避免 MSYS 把 reg 的 /v 参数改写成路径
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8' });
  const userDirs = (r.stdout || '').trim().split(';').filter(Boolean);

  const voltaBin = userDirs.find((d) => /Volta\\bin$/i.test(d))
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Volta', 'bin') : null);
  if (voltaBin && existsSync(voltaBin)) {
    return { dir: voltaBin, onPath: true, source: '原地替换 volta 的 shim（无需改 PATH）' };
  }
  return { dir: join(home, SHIM_DIR_NAME), onPath: false, source: '找不到 volta bin，需新建并改 PATH' };
}

function shimBody() {
  const bin = join(ROOT, 'bin', 'nx-rp.mjs').replace(/\\/g, '/');
  const lines = [
    `@REM ${SHIM_TAG} -> ${ROOT}`,
    `@node "${bin}" %*`,
  ];
  return lines.join('\r\n') + '\r\n';
}

function posixShimBody() {
  const bin = join(ROOT, 'bin', 'nx-rp.mjs').replace(/\\/g, '/');
  return `#!/bin/sh\n# ${SHIM_TAG} -> ${ROOT}\nexec node "${bin}" "$@"\n`;
}

// 解析 `reg query` 的一行输出 → { exists, isExpand, value }
// 形如:     Path    REG_SZ    C:\a;C:\b
//           Path    REG_EXPAND_SZ    %USERPROFILE%\bin
// 解析 `reg query HKCU\Environment /v Path` 的输出 → { exists, isExpand, value }
// 形如:     Path    REG_SZ    C:\a;C:\b
//           Path    REG_EXPAND_SZ    %USERPROFILE%\bin
// 读不到（键值不存在）时 reg 会走 stderr，这里只认 stdout 里的匹配。
function readUserPath() {
  const query = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' });
  const m = (query.stdout || '').match(/REG_(EXPAND_)?SZ\s+(.*)$/m);
  if (!m) return { exists: false, isExpand: false, value: '' };
  return { exists: true, isExpand: !!m[1], value: m[2] };
}

// 把目录并进用户 PATH 的**最前面**。
//
// 为什么必须排在最前：本机 volta\bin 位于**系统段**（进程 PATH 索引 70/105），
// 而 Windows 的 PATH = 用户段 + 系统段 —— 用户段天然在前，所以只要写进用户 PATH
// 就赢了。插到最前而不是追加，是为了不依赖「用户段一定整段在前」这个假设。
//
// 两个真实存在的坑：
//   1. setx 在 1024 字符处截断 —— 超长会静默毁掉用户 PATH，先算长度
//   2. setx 会把 REG_EXPAND_SZ 里的 %VAR% 展开成固定值 —— 破坏原语义，先检测
function addToUserPath(dir) {
  const cur = readUserPath();

  if (cur.isExpand || /%[^%]+%/.test(cur.value)) {
    console.error('[link:local] 中止：用户 PATH 含 %VAR% 展开项，setx 会把它展开成固定值。');
    console.error('  请手动把下面这行加到用户 PATH 最前面（系统属性 → 环境变量）：');
    console.error(`    ${dir}`);
    return false;
  }
  if (cur.value.split(';').filter(Boolean).some((d) => samePath(d, dir))) {
    console.log('[link:local] 用户 PATH 已有该目录，无需重复添加。');
    return true;
  }

  const next = cur.value ? dir + ';' + cur.value : dir;
  if (next.length > 1024) {
    console.error(`[link:local] 中止：合并后 ${next.length} 字符，超过 setx 的 1024 上限。`);
    console.error('  请改用「系统属性 → 环境变量」图形界面手动添加，或先清理用户 PATH。');
    return false;
  }

  if (!yes) {
    console.log(`[link:local] 将把 ${dir} 插到用户 PATH 最前面`
      + (cur.exists ? `（${cur.value.length} → ${next.length} 字符）` : '（用户 PATH 当前不存在，将新建）'));
    return false;
  }
  const r = spawnSync('setx', ['PATH', next], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[link:local] setx 失败:\n' + (r.stderr || r.stdout));
    return false;
  }
  console.log(`[link:local] 已写入用户 PATH 最前面。重开终端生效。`);
  return true;
}

function shimInstall() {
  const { dir, onPath, source } = pickShimDir();
  const cmdFile = join(dir, 'nx-rp.cmd');
  const shFile = join(dir, 'nx-rp');
  console.log(`[link:local] shim 模式：${source}`);
  console.log(`  ${cmdFile}   (cmd / PowerShell)`);
  console.log(`  ${shFile}    (Git Bash)`);

  if (!yes) {
    if (!onPath) console.log('[link:local] 该目录不在 PATH 上，将顺带写入用户 PATH 最前面');
    return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(cmdFile, shimBody(), 'utf8');
  writeFileSync(shFile, posixShimBody(), 'utf8');

  if (!onPath) {
    if (IS_WIN) addToUserPath(dir);
    else console.log(`  该目录不在 PATH 上，请加进 shell 配置：export PATH="${dir}:$PATH"`);
  } else {
    console.log('[link:local] 该目录已在用户 PATH 上，未改动任何注册表。');
  }
  console.log(`[link:local] 验证: nx-rp version   # 应显示 v${pkg.version}`);
  console.log('[link:local] 还原: pnpm run unlink:local');
  return true;
}

function removeFromUserPath(dir) {
  const cur = readUserPath();
  if (!cur.exists) return;
  const kept = cur.value.split(';').filter(Boolean).filter((d) => !samePath(d, dir));
  if (kept.length === cur.value.split(';').filter(Boolean).length) return; // 本来就没有
  const next = kept.join(';');
  if (!yes) {
    console.log(`[link:local] 将从用户 PATH 摘除 ${dir}（--yes 时执行）`);
    return;
  }
  const r = spawnSync('setx', ['PATH', next], { encoding: 'utf8' });
  if (r.status !== 0) console.error('[link:local] setx 失败:\n' + (r.stderr || r.stdout));
  else console.log(`[link:local] 已从用户 PATH 摘除（${cur.value.length} → ${next.length} 字符）。重开终端生效。`);
}

function shimUnlink() {
  const { dir } = pickShimDir();
  const files = [join(dir, 'nx-rp.cmd'), join(dir, 'nx-rp')];
  let removed = 0;
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (!readFileSync(f, 'utf8').includes(SHIM_TAG)) {
      console.log(`[link:local] ${f} 不是本工具的 shim（无标记），不动它。`);
      continue;
    }
    rmSync(f);
    removed++;
    console.log(`[link:local] 已删除: ${f}`);
  }
  if (!removed) {
    console.log(`[link:local] ${dir} 下没有本工具的 shim 文件。`);
    return false;
  }
  // 只有在目录是本工具新建的情况下才需要从 PATH 摘掉；复用在既有目录时不动 PATH
  if (dir.includes(SHIM_DIR_NAME)) removeFromUserPath(dir);
  console.log('[link:local] 重开终端后 nx-rp 回到 volta 那份。');
  return true;
}

// ─── 入口 ──────────────────────────────────────────────────────────

const state = detect();

console.log(`仓库:      ${ROOT}  (v${pkg.version})`);
console.log(`当前 nx-rp: ${state.paths.join('\n            ') || '(PATH 上找不到)'}`);
if (state.voltaVersion) console.log(`volta 装的是: v${state.voltaVersion}`);
console.log(`是否已指向本仓库: ${state.isLocal ? '是' : '否'}`);
console.log('');

const mode = modeArg || (state.voltaVersion ? 'volta' : 'shim');

if (unlink) {
  shimUnlink();
  process.exit(0);
}

if (!yes) console.log('[link:local] 预览模式——加 --yes 才真的动手。\n');

const ok = mode === 'volta' ? voltaInstall() : shimInstall();
if (!yes) {
  console.log(`  选定的模式: ${mode}${modeArg ? '（显式指定）' : '（按现状自动判定）'}`);
  console.log(`  用法: pnpm run link:local -- --yes            自动选模式并执行`);
  console.log(`        pnpm run link:local -- --mode=shim --yes`);
  console.log(`        pnpm run link:local -- --unlink`);
}
process.exit(ok ? 0 : 1);

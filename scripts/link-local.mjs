// 本地开发 shim：把全局 `nx-rp` 指向本仓库，改完代码立刻生效，不用发版。
//
// 为什么要脚本而不是让人手敲 `npm link`：
//   Windows 上 npm link 会在 npm 全局 prefix 下建一个 cmd shim，而这个机器的
//   nx-rp 是 volta 装的 —— 两者prefix 不同，link 完 `nx-rp` 仍然走 volta 那份旧包，
//   而且没人会注意到。脚本把这件事显式化：先探测现状，再选一条能真正生效的路子。
//
// 两条路子：
//   shim  —— 把转发脚本写进「PATH 上排在 volta 之前」的目录，或新建专用目录 + 改 PATH。
//            **绝不覆盖 volta 自己的 shim 文件**（详见 pickShimDir 的注释）。
//   volta —— 本仓库 pnpm pack 出 tarball，volta install 那个 tarball（快照式）。
//
// 默认按现状自动选：nx-rp 由 volta 管的 → volta；否则 → shim。
// 两条都改全局状态，所以默认 dry-run，加 --yes 才动手；--unlink 还原。
//
// 还原的依据是安装时写下的清单文件（RECEIPT）：记录了实际落点与是否动过 PATH，
// 保证「install 什么，unlink 撤什么」，不靠猜。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, rmdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

const ROOT = dirname0(import.meta.url).replace(/[\\/]scripts$/, '');
const IS_WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const unlink = argv.includes('--unlink');
const yes = argv.includes('--yes') || argv.includes('-y');
const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice(7);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function dirname0(url) {
  return new URL('.', url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error };
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

  // volta 的 bin 目录
  const voltaBin = findVoltaBin();
  const hasVolta = !!voltaBin;

  // volta 装的那份包在哪儿（VOLTA_HOME 自定义用户也要能找到）
  const voltaHome = process.env.VOLTA_HOME
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Volta') : null);
  const voltaPkg = voltaHome
    ? join(voltaHome, 'tools', 'image', 'packages', pkg.name, 'node_modules', pkg.name, 'package.json')
    : null;
  const voltaVersion = voltaPkg && existsSync(voltaPkg)
    ? JSON.parse(readFileSync(voltaPkg, 'utf8')).version
    : null;

  return { paths, isLocal, voltaBin, hasVolta, voltaVersion };
}

// volta bin 定位：先 PATH 上找（认得准），再按 VOLTA_HOME / LOCALAPPDATA 推导。
// 无论是哪个来源，都要校验目录里有 volta 特征文件（*.cmd 含 "volta run"），
// 防止把用户 PATH 上恰好叫 Volta\bin 的无关目录当成真的。
function findVoltaBin() {
  const candidates = [];
  const dirs = (process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    if (/Volta[/\\]bin$/i.test(d)) candidates.push(d);
  }
  if (process.env.VOLTA_HOME) candidates.push(join(process.env.VOLTA_HOME, 'bin'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Volta', 'bin'));

  for (const d of candidates) {
    if (!existsSync(d)) continue;
    // 校验 volta 特征：目录里任一 .cmd 含 "volta run"（volta 生成的 shim 格式）
    try {
      const files = readdirSync(d).filter((f) => f.endsWith('.cmd')).slice(0, 30);
      for (const f of files) {
        if (readFileSync(join(d, f), 'utf8').includes('volta run')) return d;
      }
    } catch { /* 读不动就换下一个候选 */ }
  }
  return null;
}

// ─── 安装清单（RECEIPT）：unlink 的唯一依据 ────────────────────────

function receiptPath() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return join(home, SHIM_DIR_NAME, 'install.json');
}

function readReceipt() {
  try {
    const r = JSON.parse(readFileSync(receiptPath(), 'utf8'));
    return (r && typeof r === 'object' && Array.isArray(r.shims)) ? r : null;
  } catch { return null; }
}

function writeReceipt(r) {
  mkdirSync(join(receiptPath(), '..'), { recursive: true });
  writeFileSync(receiptPath(), JSON.stringify(r, null, 2) + '\n', 'utf8');
}

function clearReceipt() {
  try {
    rmSync(receiptPath(), { force: true });
    rmdirSync(join(receiptPath(), '..'), { recursive: true, force: true });
  } catch { /* 清理失败不影响主流程 */ }
}

// ─── 路子一：volta install 本地 tarball ────────────────────────────

function voltaInstall() {
  console.log('[link:local] volta 模式：pnpm pack → volta install tarball');
  if (!yes) {
    console.log('  将执行: pnpm pack --pack-destination <tmp>  //  volta install <tarball>');
    return false;
  }
  // tarball 打到系统临时目录 + finally 清理：不往仓库里留 *.tgz 垃圾
  const tmpDest = tmpdir();
  const pack = run('pnpm', ['pack', '--pack-destination', tmpDest], { cwd: ROOT });
  // pnpm pack 最后一行输出 tarball 路径——可能是裸文件名也可能是绝对路径，都能出现
  const last = pack.out.split(/\r?\n/).filter((l) => l.endsWith('.tgz')).pop();
  if (!last) {
    console.error('pnpm pack 没产出 tarball：\n' + pack.out + pack.err);
    return false;
  }
  const abs = isAbsolute(last) ? last : join(tmpDest, last);
  try {
    // shell:false —— Node 对 shell:true 的 args 不加引号，路径含空格直接劈坏；
    // volta.exe / pnpm.cmd 都能被 spawnSync 直接调（cmd shim 会经 cmd.exe 但无参数重排问题）
    const inst = run('volta', ['install', `${pkg.name}@${abs}`]);
    if (inst.code !== 0) {
      console.error('volta install 失败:\n' + (inst.out || inst.err));
      return false;
    }
    console.log(inst.out || inst.err);
    console.log(`[link:local] 已装 ${abs}（快照）`);
    console.log('[link:local] 注意：改代码后要重跑本命令；要实时生效用 --mode=shim。');
    return true;
  } finally {
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
}

// ─── 路子二：往 PATH 写转发 shim ───────────────────────────────────

const SHIM_TAG = 'nx-rp-local-shim';
const SHIM_DIR_NAME = 'nx-rp-dev';

// shim 的落点：**绝不覆盖 volta 自己的 shim 文件。**
//
// 教训（审查实测）：早先版本把落点选成 volta\bin 本身、原地覆盖 nx-rp.cmd，
// 且无备份。用户 unlink 后 PATH 上不再有任何 nx-rp（volta 不会自己重建 shim），
// 而脚本还打印「已回到 volta 那份」——全局命令静默消失，是最恶劣的失败方式。
//
// 现在的落点优先级：
//   1. 用户 PATH 上、排在 volta bin **之前**的既有干净目录（不改注册表）
//   2. 新建 %USERPROFILE%\nx-rp-dev + 插到用户 PATH 最前面（走防御性 addToUserPath）
//
// 关于 setx 的两个坑（第 2 条落点会用到）：
//   - setx 在 1024 字符处截断（真实风险，超长必须中止）
//   - %VAR% 展开：实测本机 setx **保留** REG_EXPAND_SZ 原值不展开，
//     但不同 Windows 版本行为有差异，故只警告不阻断
function pickShimDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!IS_WIN) {
    const dir = join(home, '.local', 'bin');
    const onPath = (process.env.PATH || '').split(':').some((d) => samePath(d, dir));
    return { dir, onPath, source: 'posix 默认' };
  }

  // 用户 PATH（.NET 读法不经 shell，不会被 MSYS 改写参数；拿到的就是注册表原文）
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','User', 'DoNotExpandEnvironmentNames')"], { encoding: 'utf8' });
  const userDirs = (r.stdout || '').trim().split(';').filter(Boolean);

  const voltaBin = findVoltaBin();
  const voltaIdx = voltaBin ? userDirs.findIndex((d) => samePath(d, voltaBin)) : -1;
  const before = voltaIdx >= 0 ? userDirs.slice(0, voltaIdx) : userDirs;

  // 候选目录：无 %VAR%（写入后无法保证解析）、非系统受管、真实存在
  const bad = /WindowsApps|\\uv\\|\\npm$|\\WinGet\\|\\Volta|\\Windows|System32|Program Files/i;
  const okDir = (d) => !/%[^%]+%/.test(d) && !bad.test(d) && existsSync(d);
  const ranked = before.filter(okDir).sort((a, b) => {
    const ha = /[/\\]bin$/i.test(a) && a.split('\\').length <= 3 ? 0 : 1;
    const hb = /[/\\]bin$/i.test(b) && b.split('\\').length <= 3 ? 0 : 1;
    return ha - hb || a.split('\\').length - b.split('\\').length;
  });
  if (ranked.length) {
    return { dir: ranked[0], onPath: true, source: '写入用户 PATH 上、排在 volta 之前的目录', needPathEdit: false };
  }
  return { dir: join(home, SHIM_DIR_NAME), onPath: false, source: 'PATH 上没有合适位置，新建专用目录', needPathEdit: true };
}

function shimBody() {
  const bin = join(ROOT, 'bin', 'nx-rp.mjs').replace(/\\/g, '/');
  return `@REM ${SHIM_TAG} -> ${ROOT}\r\n@node "${bin}" %*\r\n`;
}

function posixShimBody() {
  const bin = join(ROOT, 'bin', 'nx-rp.mjs').replace(/\\/g, '/');
  return `#!/bin/sh\n# ${SHIM_TAG} -> ${ROOT}\nexec node "${bin}" "$@"\n`;
}

// 读用户 PATH（注册表原文，不展开变量）。查询失败时返回 error——
// 上层必须中止，绝不能把「读不到」当成「用户 PATH 为空」去 setx（那会清空它）。
function readUserPath() {
  const query = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8' });
  if (query.status !== 0 || query.error) {
    // 键值不存在（status 1 + stderr）与查询失败（reg 被拦等）在这里无法区分，
    // 交给调用方用 PowerShell 读法复核
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User', 'DoNotExpandEnvironmentNames')"], { encoding: 'utf8' });
    if (ps.status !== 0 || ps.error) return { error: true, exists: false, isExpand: false, value: '' };
    const v = (ps.stdout || '').trim();
    if (v === '') return { error: false, exists: false, isExpand: false, value: '' };
    return { error: false, exists: true, isExpand: /%[^%]*%/.test(v), value: v };
  }
  const m = (query.stdout || '').match(/REG_(EXPAND_)?SZ\s+(.*)$/m);
  if (!m) return { error: true, exists: false, isExpand: false, value: '' };
  return { error: false, exists: true, isExpand: !!m[1], value: m[2] };
}

function addToUserPath(dir) {
  const cur = readUserPath();
  if (cur.error) {
    console.error('[link:local] 中止：读不到用户 PATH（reg 与 PowerShell 双路都失败）。');
    console.error(`  请手动把 ${dir} 加到用户 PATH 最前面（系统属性 → 环境变量）。`);
    return false;
  }
  if (cur.value.split(';').filter(Boolean).some((d) => samePath(d, dir))) {
    console.log('[link:local] 用户 PATH 已有该目录，无需重复添加。');
    return true;
  }
  if (/%[^%]+%/.test(cur.value)) {
    console.warn('[link:local] 注意：用户 PATH 含 %VAR% 引用。实测新版 setx 保留原类型不展开，');
    console.warn('  但为稳妥起见建议改完检查一下这些条目是否原样保留。');
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
  console.log('[link:local] 已写入用户 PATH 最前面。重开终端生效。');
  return true;
}

function removeFromUserPath(dir) {
  const cur = readUserPath();
  if (cur.error || !cur.exists) return;
  const all = cur.value.split(';').filter(Boolean);
  const kept = all.filter((d) => !samePath(d, dir));
  if (kept.length === all.length) return; // 本来就没有
  const next = kept.join(';');
  if (!yes) {
    console.log(`[link:local] 将从用户 PATH 摘除 ${dir}（--yes 时执行）`);
    return;
  }
  const r = spawnSync('setx', ['PATH', next], { encoding: 'utf8' });
  if (r.status !== 0) console.error('[link:local] setx 失败:\n' + (r.stderr || r.stdout));
  else console.log(`[link:local] 已从用户 PATH 摘除（${cur.value.length} → ${next.length} 字符）。重开终端生效。`);
}

function shimInstall() {
  const { dir, onPath, source, needPathEdit } = pickShimDir();
  const cmdFile = join(dir, 'nx-rp.cmd');
  const shFile = join(dir, 'nx-rp');
  console.log(`[link:local] shim 模式：${source}`);
  console.log(`  ${cmdFile}   (cmd / PowerShell)`);
  console.log(`  ${shFile}    (Git Bash)`);

  // POSIX 分支不写 .cmd 垃圾文件
  const cmdBody = IS_WIN ? shimBody() : null;
  if (!yes) {
    if (needPathEdit) console.log('[link:local] 将顺带把该目录插到用户 PATH 最前面');
    return false;
  }
  mkdirSync(dir, { recursive: true });
  if (cmdBody) writeFileSync(cmdFile, cmdBody, 'utf8');
  writeFileSync(shFile, posixShimBody(), 'utf8');

  let pathOk = true;
  if (needPathEdit && !onPath) {
    pathOk = IS_WIN ? addToUserPath(dir) : (console.log(`  请加进 shell 配置：export PATH="${dir}:$PATH"`), false);
  }

  // 写安装清单：unlink 的唯一依据（install 什么，unlink 撤什么）
  if (pathOk || existsSync(shFile)) {
    writeReceipt({
      shims: [cmdBody ? cmdFile : null, shFile].filter(Boolean),
      dir,
      pathEdit: needPathEdit && !onPath ? dir : null,
      mode: 'shim',
      installedAt: new Date().toISOString(),
    });
  }

  console.log(`[link:local] 验证: nx-rp version   # 应显示 v${pkg.version}`);
  console.log('[link:local] 还原: pnpm run unlink:local');
  return pathOk;
}

function shimUnlink() {
  const receipt = readReceipt();
  if (!receipt) {
    console.log('[link:local] 没有安装清单（未用本脚本装过 shim，或清单已被删）。');
    // 兜底：从 receipts 的默认目录位置找一次（老版本装的可能没有清单）
    const guess = join(process.env.USERPROFILE || process.env.HOME || '', SHIM_DIR_NAME);
    let removed = 0;
    for (const f of [join(guess, 'nx-rp.cmd'), join(guess, 'nx-rp')]) {
      if (existsSync(f) && readFileSync(f, 'utf8').includes(SHIM_TAG)) {
        rmSync(f); removed++;
        console.log(`[link:local] 兜底删除: ${f}`);
      }
    }
    if (!removed) console.log(`[link:local] ${guess} 下也没有本工具的 shim。`);
    else {
      clearReceipt();
      console.log('[link:local] 若当时改过用户 PATH，请手动检查是否残留该目录条目。');
    }
    return removed > 0;
  }

  for (const f of receipt.shims) {
    if (!existsSync(f)) continue;
    if (!readFileSync(f, 'utf8').includes(SHIM_TAG)) {
      console.log(`[link:local] ${f} 已不是本工具的 shim（无标记），跳过。`);
      continue;
    }
    rmSync(f);
    console.log(`[link:local] 已删除: ${f}`);
  }
  if (receipt.pathEdit) removeFromUserPath(receipt.pathEdit);
  // 目录是本工具新建的（清单在目录里）→ 空了就删掉
  if (receipt.dir.includes(SHIM_DIR_NAME)) {
    try { rmdirSync(receipt.dir); } catch { /* 非空或他物占用，留着 */ }
  }
  clearReceipt();
  console.log('[link:local] 还原完成。nx-rp 回到安装前的状态（volta 那份不受影响）。');
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
  const ok = shimUnlink();
  process.exit(ok ? 0 : 1);
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

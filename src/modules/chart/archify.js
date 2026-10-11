// chart·archify 子模块：archify 图表与 cwd scope 的登记关系。
//
// 与 deps 本体的分工：本体负责「从源码推导只读的 DOT 依赖图」；这里负责
// 「archify skill 产出的自包含 HTML 图表」的登记与展示。图一律出自 archify
// skill 的精修流程——机器自动生成的架构图不可信，所以这里不渲染、不改内容、
// 也**不调 archify CLI**，只做：
//   discover（扫 cwd/.archify/ 未登记产物）→ add（拷入 scope 存储 + 登记）→
//   view（HTTP 直出，面板 iframe ?embed=1 嵌入）→ remove（移除登记与副本）。
//
// scope 隔离：登记关系存 ~/.nx-rp/archify/<cwd哈希>/（registry.json + 副本），
// 多项目互不干扰。baseDir 参数注入（生产走 cwdDir() 的 ALS 穿透，测试传 tmp）
// ——与 service.js 的 saveDot 同一个模式。
import fsp from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { archifyScopeDirFor, cwdDir, normalizeScope } from '../../core/paths.js';
import { external, invalidInput, notFound } from '../../core/errors.js';

const REGISTRY_FILE = 'registry.json';
const HTML_CAP = 8 * 1024 * 1024; // 单图表副本上限（archify 产物典型 0.7-1MB）

// ─── scope 存储 ──────────────────────────────────────────────────

function scopeDirOf(baseDir) {
  const s = archifyScopeDirFor(baseDir || cwdDir());
  if (!s) throw external('无法解析 archify scope 存储目录（ARCHIFY_DIR 未初始化）');
  return s.dir;
}

async function readRegistry(dir) {
  try {
    const reg = JSON.parse(await fsp.readFile(join(dir, REGISTRY_FILE), 'utf8'));
    return { version: 1, entries: Array.isArray(reg.entries) ? reg.entries : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeRegistry(dir, reg) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, REGISTRY_FILE), JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

// 登记名 → 存储 id：非字母数字（含 CJK 保留）折叠成 '-'。文件名跟 id 走，
// 所以保留 CJK——中文名是这里的一等公民；只是拒绝路径元字符，防穿越。
function idFromName(name) {
  const out = String(name || '').trim().slice(0, 48)
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'diagram';
}

// archify 产物标识：头部 4KB 里的 reader-contract meta 或 generator 标记。
// 这是「别把任意 HTML 当图表收进来」的软校验（防手滑），不是安全边界。
async function assertArchifyArtifact(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    if (!head.includes('archify-reader-contract') && !/name="generator" content="archify/i.test(head)) {
      throw invalidInput('不是 archify 产物（头部缺 archify 标识）——确认文件来自 archify finalize/deliver');
    }
  } finally {
    await fh.close();
  }
}

// ─── 登记查询 ────────────────────────────────────────────────────

export async function listDiagrams({ baseDir } = {}) {
  const dir = scopeDirOf(baseDir);
  const reg = await readRegistry(dir);
  const entries = reg.entries.slice().sort((a, b) => a.id.localeCompare(b.id));
  // 副本可能被手动清掉：登记还在但文件缺失 → present=false，前端标「缺失」
  const detailed = [];
  for (const e of entries) {
    let bytes = 0;
    try { bytes = (await fsp.stat(join(dir, e.file))).size; } catch { bytes = 0; }
    detailed.push({ ...e, present: bytes > 0, bytes });
  }
  return { entries: detailed };
}

// ─── 登记 / 移除 ─────────────────────────────────────────────────

export async function addDiagram({ file, candidate, name, baseDir } = {}) {
  const base = baseDir || cwdDir();
  if (typeof file !== 'string' || !file.trim()) throw invalidInput('缺少 --file（archify 产物 HTML 路径）');
  const srcHtml = isAbsolute(file) ? resolve(file) : resolve(base, file);
  let st;
  try { st = await fsp.stat(srcHtml); } catch { throw notFound(`文件不存在: ${file}`); }
  if (!st.isFile()) throw invalidInput(`不是常规文件: ${file}`);
  if (!/\.html?$/i.test(srcHtml)) throw invalidInput(`必须是 .html 文件（收到: ${file}）`);
  if (st.size > HTML_CAP) throw invalidInput(`HTML 超限（${st.size} > ${HTML_CAP} 字节）`);
  await assertArchifyArtifact(srcHtml);

  // candidate 可选：有则抽 type/title 元数据。损坏的 candidate 明确报错
  // （大概率是路径给错），不静默降级——元数据错了面板显示会误导。
  let candMeta = null;
  if (candidate) {
    const srcCand = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
    try {
      candMeta = JSON.parse(await fsp.readFile(srcCand, 'utf8'));
    } catch (e) {
      throw invalidInput(`candidate JSON 解析失败: ${candidate}（${e.message}）`);
    }
    const TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'];
    if (candMeta.diagram_type && !TYPES.includes(candMeta.diagram_type)) {
      throw invalidInput(`candidate 的 diagram_type 未知: ${candMeta.diagram_type}（应为 ${TYPES.join('/')}）`);
    }
  }

  const title = (candMeta?.meta && typeof candMeta.meta.title === 'string' && candMeta.meta.title) || null;
  const entryName = (typeof name === 'string' && name.trim()) || title || basename(srcHtml).replace(/\.html?$/i, '');
  const id = idFromName(entryName);

  const dir = scopeDirOf(base);
  const reg = await readRegistry(dir);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(srcHtml, join(dir, `${id}.html`));
  let candFile = null;
  if (candMeta) {
    candFile = `${id}.candidate.json`;
    await fsp.writeFile(join(dir, candFile), JSON.stringify(candMeta, null, 2) + '\n', 'utf8');
  }
  const existed = reg.entries.some((e) => e.id === id);
  const entry = {
    id,
    name: entryName,
    type: candMeta?.diagram_type || 'unknown',
    title,
    file: `${id}.html`,
    candidate: candFile,
    source: normalizeScope(srcHtml), // discover 靠它判定「已登记」，跨会话稳定
    addedAt: new Date().toISOString(),
  };
  reg.entries = [...reg.entries.filter((e) => e.id !== id), entry];
  await writeRegistry(dir, reg);
  return { ...entry, overwritten: existed, bytes: st.size };
}

export async function removeDiagram({ id, baseDir } = {}) {
  const dir = scopeDirOf(baseDir);
  const reg = await readRegistry(dir);
  const entry = reg.entries.find((e) => e.id === id);
  if (!entry) throw notFound(`未登记的图表 id: ${id}（chart archify list 查看）`);
  reg.entries = reg.entries.filter((e) => e.id !== id);
  await writeRegistry(dir, reg);
  // 副本一并删（登记语义=拷贝归我管）；缺失容忍——可能已被手动清理
  for (const f of [entry.file, entry.candidate].filter(Boolean)) {
    await fsp.rm(join(dir, f), { force: true });
  }
  return { id, removed: entry.file };
}

// ─── .archify/ 发现 ──────────────────────────────────────────────
//
// archify skill 的产物约定：<type>-<slug>-<时间戳>/ 里放 candidate.json 与
// <slug>.html。这里只做一层扫描（不递归）——skill 每次请求新建文件夹，深度恒为 1。

export async function discoverDiagrams({ baseDir } = {}) {
  const base = baseDir || cwdDir();
  const root = join(base, '.archify');
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return { root, items: [] }; }
  const dir = scopeDirOf(base);
  const reg = await readRegistry(dir);
  const items = [];
  for (const d of dirs.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    // 只认常规文件——产物目录里可能躺着手滑建出的同名目录，不能让它抢匹配
    let entries;
    try { entries = await fsp.readdir(join(root, d.name), { withFileTypes: true }); } catch { continue; }
    const names = entries.filter((e) => e.isFile()).map((e) => e.name);
    const html = names.find((f) => /\.html?$/i.test(f));
    if (!html) continue; // 没有 HTML 的文件夹不是产物（或已被清理），跳过
    const cand = names.find((f) => /candidate.*\.json$/i.test(f)) || null;
    let meta = null;
    try { meta = JSON.parse(await fsp.readFile(join(root, d.name, cand), 'utf8')); } catch { /* 缺 candidate 仍可登记 */ }
    const source = normalizeScope(resolve(root, d.name, html));
    items.push({
      dir: d.name,
      html: source,
      candidate: cand ? resolve(root, d.name, cand) : null,
      type: meta?.diagram_type || 'unknown',
      title: (meta?.meta && typeof meta.meta.title === 'string' && meta.meta.title) || null,
      registered: reg.entries.some((e) => e.source === source),
    });
  }
  return { root, items };
}

// ─── 直出 ────────────────────────────────────────────────────────
//
// 面板 iframe 导航不会带 x-nx-rp-scope 头（那是 fetch 封装加的），激活目录
// 经 ?scope= 显式透传。scope 只决定查哪个哈希桶，最终路径永远落在
// ~/.nx-rp/archify/<hash>/ 之下，不存在任意路径读取。
export async function readDiagram({ id, scope, baseDir } = {}) {
  if (typeof id !== 'string' || !/^[\p{L}\p{N}_-]{1,64}$/u.test(id)) throw invalidInput(`非法图表 id: ${id}`);
  const dir = scopeDirOf(scope || baseDir);
  const reg = await readRegistry(dir);
  const entry = reg.entries.find((e) => e.id === id);
  if (!entry) throw notFound(`未登记的图表 id: ${id}`);
  const abs = join(dir, entry.file);
  let stat;
  try { stat = await fsp.stat(abs); } catch {
    throw notFound(`图表文件缺失（移除后重新登记）: ${entry.file}`);
  }
  return { abs, bytes: stat.size, entry, contentType: 'text/html; charset=utf-8' };
}

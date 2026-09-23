// annotations 模块业务：文件批注 / 评价 / 待办 / 思考。
//
// 数据模型：一条批注 = {
//   id, file: <绝对路径>, kind: 'review'|'todo'|'note',
//   body: <批注文本>, line: <可选行号锚点>, done: <todo 专用>,
//   createdAt, doneAt
// }
//
// 存储按目标文件分桶：~/.nx-rp/annotations/<serializePath(file)>.json
// （与 KB 目录同一序列化规则，全 ASCII 跨平台；一个文件一个桶，桶内是批注数组）。
// 一般评论不会特别多，单桶整读整写 + pid tmp 原子替换足够。
//
// 文件加载器（loader）：为「查看目标文件」服务。铁律：
//   - 默认只出 1000 字符预览；超限**拒绝渲染**（返回 truncated + 总长），绝不截半行糊弄
//   - 文件不存在 / 二进制拒绝（二进制进对话是灾难）
//   - 带 --full 的显式行为才给全文（仍有硬上限，防误读超大文件）
import fsp from 'node:fs/promises';
import { stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serializePath } from '../../core/paths.js';
import { invalidInput, notFound } from '../../core/errors.js';

const PREVIEW_CHARS = 1000;      // 默认预览上限
const FULL_HARD_CAP = 200_000;   // --full 的硬上限（约 200KB 文本）
const ANNOTATIONS_DIR = join(process.env.USERPROFILE || process.env.HOME, '.nx-rp', 'annotations');
// let：仅测试重定向。
export let annotationsDir = ANNOTATIONS_DIR;
export function setAnnotationsDir(dir) { annotationsDir = dir; }

// 校验目标文件路径：必须绝对路径（批注挂在具体文件上，相对路径无意义）。
function assertAbsFile(p) {
  if (!p || typeof p !== 'string' || !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) {
    throw invalidInput('需要绝对文件路径: ' + p);
  }
  return p;
}

function bucketFile(file) {
  return join(annotationsDir, `${serializePath(file)}.json`);
}

// ─── 文件加载器 ────────────────────────────────────────────────────

// 加载目标文件内容。两种模式：
//   1. 窗口模式（web 渐进加载）：offset + limit 切片返回——下次从 nextOffset 续传。
//      服务端单文件整读（200K 内开销可忽略），网络与渲染才是瓶颈，窗口切在正确层。
//   2. 上限模式（CLI / 首查）：不带 limit 时沿用铁律——超过 cap 拒绝渲染。
export async function loadFile({ file, full = false, offset = 0, limit } = {}) {
  assertAbsFile(file);
  let info;
  try {
    info = await stat(file);
  } catch {
    throw notFound('文件不存在: ' + file);
  }
  if (!info.isFile()) throw invalidInput('不是常规文件: ' + file);
  if (info.size > FULL_HARD_CAP) {
    throw invalidInput('文件过大（' + info.size + ' 字节 > ' + FULL_HARD_CAP + '），拒绝加载：请用行号/片段方式查看');
  }

  const rawBuf = await readFile(file);
  if (rawBuf.subarray(0, 8000).includes(0)) throw invalidInput('检测到二进制内容（含 NUL），拒绝渲染');
  const raw = rawBuf.toString('utf8');
  const totalChars = raw.length;
  const lineCount = countLines(raw);

  // ── 窗口模式：渐进加载，永不「拒绝」——要多少给多少 ──
  const winLimit = Number(limit);
  if (limit !== undefined && Number.isFinite(winLimit) && winLimit > 0) {
    const start = Math.max(0, Math.min(Number(offset) || 0, totalChars));
    const len = Math.min(winLimit, totalChars - start, MAX_WINDOW);
    const body = raw.slice(start, start + len);
    return {
      file,
      window: true,
      offset: start,
      limit: len,
      totalChars,
      lineCount,
      hasMore: start + len < totalChars,
      nextOffset: start + len,
      body,
    };
  }

  // ── 上限模式：CLI 铁律（超限拒绝渲染）──
  const cap = full ? FULL_HARD_CAP : PREVIEW_CHARS;
  if (raw.length > cap) {
    return {
      file,
      truncated: true,
      totalChars,
      lineCount,
      limit: cap,
      body: null, // 拒绝渲染——不是截断半截内容，是明确不给
      message: full
        ? '文件共 ' + raw.length + ' 字符，超过 --full 硬上限 ' + FULL_HARD_CAP + '，拒绝渲染'
        : '文件共 ' + raw.length + ' 字符，超过默认预览上限 ' + PREVIEW_CHARS + '。加 --full 查看（硬上限 ' + FULL_HARD_CAP + '），或用行号片段',
    };
  }
  return {
    file,
    truncated: false,
    totalChars,
    limit: cap,
    lineCount,
    body: raw,
  };
}

const MAX_WINDOW = 50_000; // 窗口模式单次切片的绝对上限（防一次拉爆渲染）

function countLines(s) {
  return s.split('\n').length;
}

// ─── 目录浏览（路径渐进式加载）─────────────────────────────────────
//
// 列出目录的直接子项（不递归——每步一次 readdir，性能零损耗）。
// web 面板逐级点选进入，避免任何「扫描全盘」的冲动。
export async function listDir({ dir } = {}) {
  if (!dir || typeof dir !== 'string') {
    dir = process.cwd(); // 缺省从当前工作目录起步
  }
  let info;
  try {
    info = await stat(dir);
  } catch {
    throw notFound('目录不存在: ' + dir);
  }
  if (!info.isDirectory()) throw invalidInput('不是目录: ' + dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // 隐藏项不进浏览（.git 等）
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  return {
    dir,
    parent: dirname(dir) !== dir ? dirname(dir) : null, // 盘根的 parent 为 null
    dirs,
    files: files.slice(0, MAX_DIR_ENTRIES),
    filesTruncated: files.length > MAX_DIR_ENTRIES,
  };
}

const MAX_DIR_ENTRIES = 500; // 单目录文件数上限（正常项目远小于此；超了如实标注）

// ─── 批注 CRUD ─────────────────────────────────────────────────────

async function readBucket(file) {
  try {
    const raw = await fsp.readFile(bucketFile(file), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeBucket(file, list) {
  await fsp.mkdir(annotationsDir, { recursive: true });
  const tmp = `${bucketFile(file)}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(tmp, bucketFile(file));
}

const KINDS = new Set(['review', 'todo', 'note']);

function normalizeKind(kind) {
  const k = kind || 'note';
  if (!KINDS.has(k)) throw invalidInput(`kind 必须是 ${[...KINDS].join('/')}，收到: ${k}`);
  return k;
}

export async function listAnnotations({ file, kind, open } = {}) {
  assertAbsFile(file);
  let list = await readBucket(file);
  if (kind) list = list.filter((a) => a.kind === normalizeKind(kind));
  if (open) list = list.filter((a) => a.kind !== 'todo' || !a.done);
  return list.reverse(); // 最新在前
}

export async function getAnnotation({ file, id } = {}) {
  assertAbsFile(file);
  const list = await readBucket(file);
  const hit = list.find((a) => a.id === id);
  if (!hit) throw notFound(`批注不存在: ${id}`);
  return hit;
}

export async function addAnnotation({ file, kind, body, line } = {}) {
  assertAbsFile(file);
  if (!body || typeof body !== 'string' || !body.trim()) throw invalidInput('批注内容不能为空');
  if (body.length > 4000) throw invalidInput('批注过长（>4000 字符）——批注是短评论，长文请进 doc 域');
  const k = normalizeKind(kind);
  if (line !== undefined && (!Number.isInteger(line) || line < 1)) throw invalidInput('line 必须是正整数行号');
  const ann = {
    id: 'a_' + Math.random().toString(36).slice(2, 10),
    file,
    kind: k,
    body: body.trim(),
    line: line || undefined,
    done: k === 'todo' ? false : undefined,
    createdAt: new Date().toISOString(),
  };
  const list = await readBucket(file);
  list.push(ann);
  await writeBucket(file, list);
  return ann;
}

export async function updateAnnotation({ file, id, body, line, done } = {}) {
  assertAbsFile(file);
  const list = await readBucket(file);
  const hit = list.find((a) => a.id === id);
  if (!hit) throw notFound(`批注不存在: ${id}`);
  if (body !== undefined) {
    if (!body || !body.trim()) throw invalidInput('批注内容不能为空');
    hit.body = body.trim();
  }
  if (line !== undefined) {
    if (!Number.isInteger(line) || line < 1) throw invalidInput('line 必须是正整数行号');
    hit.line = line;
  }
  if (done !== undefined) {
    if (hit.kind !== 'todo') throw invalidInput('只有 todo 类型有 done 状态');
    hit.done = !!done;
    hit.doneAt = hit.done ? new Date().toISOString() : undefined;
  }
  await writeBucket(file, list);
  return hit;
}

export async function removeAnnotation({ file, id } = {}) {
  assertAbsFile(file);
  const list = await readBucket(file);
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) throw notFound(`批注不存在: ${id}`);
  const [removed] = list.splice(idx, 1);
  await writeBucket(file, list);
  return removed;
}

// ─── 跨文件视图 ────────────────────────────────────────────────────

// 全部桶的 open todo（跨文件的待办清单——「待办操作」的主入口）。
export async function listAllTodos() {
  let names = [];
  try {
    names = (await fsp.readdir(annotationsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const list = JSON.parse(await fsp.readFile(join(annotationsDir, name), 'utf8'));
      for (const a of Array.isArray(list) ? list : []) {
        if (a.kind === 'todo' && !a.done) out.push(a);
      }
    } catch { /* 坏桶跳过 */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

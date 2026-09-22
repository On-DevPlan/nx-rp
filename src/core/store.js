// 状态读写：原子写 + 缓存失效。
//
// 文件头结构注释同步：recents 是全局列表，不属于任何 scope 桶。
// 单一 JSON 文件 ~/.nx-rp/store.json，结构：
//   { version, settings, scopes: { [cwdScope]: { links, docs, workflows } }, recents: [...] }
//
// 为什么按 cwd 隔离而不是平铺：同一 nx-rp 可能被多个项目用，每项目独立范围；
// 但用户的所有偏好（设置）还是全局共享 → 拆 settings 与 scopes。
//
// 三件不可妥协的事：
//   1. 原子写（tmp + rename）：中断时数据不会半截
//   2. 缓存按 mtime 失效：CLI 改了数据，Web 服务立刻看见
//   3. 读失败降级返回空结构：损坏时工具还能启动给用户修
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { storePathFromEnv, cwdScope as _cwdScope } from './paths.js';

const VERSION = 1;

// recents 最多保留的目录数：够覆盖活跃项目，又不让 store.json 无限膨胀。
const RECENTS_LIMIT = 20;

const EMPTY = () => ({
  version: VERSION,
  settings: {
    defaultPort: 7820,
    openBrowser: true,
  },
  // 业务集合一律按 cwdScope 索引。
  scopes: {},
  // 最近使用的工作目录（跨 scope 的全局列表，最近在前）：
  // recents[i] = { scope, path, lastUsedAt }
  //   scope = normalizeScope 后的 key（与 scopes 桶同命名空间）
  //   path  = 原始大小写路径（展示 / fs 用）
  recents: [],
});

function normalize(data) {
  const base = EMPTY();
  if (!data || typeof data !== 'object') return base;
  base.version = data.version ?? VERSION;
  base.settings = { ...base.settings, ...(data.settings || {}) };
  if (data.scopes && typeof data.scopes === 'object') {
    for (const [k, v] of Object.entries(data.scopes)) {
      base.scopes[k] = normalizeScope(v);
    }
  }
  if (Array.isArray(data.recents)) {
    base.recents = data.recents
      .filter((r) => r && typeof r.scope === 'string')
      .slice(0, RECENTS_LIMIT);
  }
  return base;
}

function normalizeScope(v) {
  if (!v || typeof v !== 'object') return { links: [], docs: [], workflows: {} };
  return {
    links: Array.isArray(v.links) ? v.links : [],
    docs: Array.isArray(v.docs) ? v.docs : [],
    workflows: v.workflows && typeof v.workflows === 'object' ? v.workflows : {},
  };
}

let cached = null;
let cacheMtime = -1;
let cachePath = null;

function path() {
  return storePathFromEnv();
}

export async function loadStore() {
  const p = path();
  try {
    const st = await fsp.stat(p);
    if (cached && cachePath === p && cacheMtime === st.mtimeMs) return cached;
    const raw = await fsp.readFile(p, 'utf8');
    cached = normalize(JSON.parse(raw));
    cacheMtime = st.mtimeMs;
    cachePath = p;
    return cached;
  } catch {
    cached = normalize(null);
    cacheMtime = -1;
    cachePath = p;
    return cached;
  }
}

export async function saveStore(next) {
  const p = path();
  const data = normalize(next);
  await fsp.mkdir(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p);
  cached = data;
  cacheMtime = (await fsp.stat(p)).mtimeMs;
  cachePath = p;
  return data;
}

// 读-改-写事务。深拷贝确保 fn 抛错时不污染缓存。
export async function mutateStore(fn) {
  const cur = structuredClone(await loadStore());
  const result = fn(cur);
  await saveStore(cur);
  return result === undefined ? cur : result;
}

// 取当前 cwd 作用域。scope 不存在则返回空壳（不写盘）。
export async function getCurrentScope() {
  const store = await loadStore();
  const k = _cwdScope();
  if (!store.scopes[k]) store.scopes[k] = { links: [], docs: [], workflows: {} };
  return { key: k, scope: store.scopes[k], store };
}

// 直接拿某 scope（不一定存在）。
export async function getScope(key) {
  const store = await loadStore();
  const k = (key || _cwdScope()).toLowerCase();
  return { key: k, scope: store.scopes[k] || { links: [], docs: [], workflows: {} }, store };
}

// 测试用：清除缓存与强制下次重读。
export function forgetStore() {
  cached = null;
  cacheMtime = -1;
  cachePath = null;
}
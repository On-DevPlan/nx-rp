// 路径与常量的唯一权威来源。
//
// 单一状态文件：~/.nx-rp/store.json
// cwd 作用域：CLI 启动自动识别 process.cwd() 作为 scope key。
// 允许测试与多实例覆盖：环境变量 NX_RP_STORE 优先。
//
// 关键防 vite 外部化约定：本文件**不在顶层 import 'node:os'/'node:path'**——
// 全部走 createRequire() 同步懒加载。前端即便触达本文件，模块级只看到 ESM 标记；
// node 内置模块只在被调用的瞬间被 require 拉（同步；Node 端 OK；vite/浏览器
// require 抛错 → catch 落空，前端路径访问时给出明确失败而不是返回假路径）。
//
// ALS 单独放在 core/als.js 隔离——本文件通过 require('./als.js') 间接访问，
// try/catch 兜底；前端 vite externalize 时不再通过静态图触达 'node:async_hooks'。

import { createRequire } from 'node:module';
import { invalidInput } from './errors.js';

const _require = createRequire(import.meta.url);

// 安全懒加载：返回 null 表示「在浏览器里 / 模块不可用」。
function _os() { try { return _require('node:os'); } catch { return null; } }
function _path() { try { return _require('node:path'); } catch { return null; } }
function _crypto() { try { return _require('node:crypto'); } catch { return null; } }

function _homedir() {
  const os = _os();
  return os ? os.homedir() : null;
}

// 测试专用：覆盖 home 后所有懒加载常量走新路径。
let _homeOverride = null;
export function setHome(dir) { _homeOverride = dir; }
function home() {
  return _homeOverride || _homedir();
}

export const APP_NAME = 'nx-rp';

// ─── 路径常量：导出表达式 lazy —— import 时不求值，访问时才计算 ──
export const APP_DIR = (() => {
  const h = home();
  const path = _path();
  return h && path ? path.join(h, `.${APP_NAME}`) : null;
})();

export const STORE_PATH = (() => {
  const h = home();
  const path = _path();
  return h && path ? path.join(h, '.nx-rp', 'store.json') : null;
})();

// hook 相关路径：let 让测试能直接重赋值；初值 lazy 求值
export let CLAUDE_SETTINGS_PATH = (() => {
  const h = home();
  const path = _path();
  return h && path ? path.join(h, '.claude', 'settings.json') : null;
})();
export let PROMPTS_DIR = (() => {
  const h = home();
  const path = _path();
  return h && path ? path.join(h, '.nx-rp', 'prompts') : null;
})();
export let SKILLS_DIR = (() => {
  const h = home();
  const path = _path();
  return h && path ? path.join(h, '.nx-rp', 'skills') : null;
})();
// loop 状态与审计日志（按 cwd 分文件，同 prompts/skills 的模式）
export let LOOPS_DIR = (() => {
  const h = home();
  const path = _path();
  return h && path ? path.join(h, '.nx-rp', 'loops') : null;
})();
// 快照集中目录：项目级配置的快照不落在项目里（会污染仓库），统一丢这儿
export let SNAPSHOTS_DIR = (() => {
  const h = home();
  const path = _path();
  return h && path ? path.join(h, '.nx-rp', 'snapshots') : null;
})();

export function setHookPaths({ settingsPath, promptsDir, skillsDir, loopsDir, snapshotsDir } = {}) {
  if (settingsPath !== undefined) CLAUDE_SETTINGS_PATH = settingsPath;
  if (promptsDir !== undefined) PROMPTS_DIR = promptsDir;
  if (skillsDir !== undefined) SKILLS_DIR = skillsDir;
  if (loopsDir !== undefined) LOOPS_DIR = loopsDir;
  if (snapshotsDir !== undefined) SNAPSHOTS_DIR = snapshotsDir;
}

// hook 日志按目录哈希分文件：文件名全 ASCII，避免 cwd 里的中文/空格进路径。
// ext 由调用方给（日志 .jsonl / 状态 .json）。
function hashOf(dir, cwd, ext) {
  const norm = normalizeScope(cwd);
  const hash = (() => {
    const c = _crypto();
    return c ? c.createHash('sha1').update(norm).digest('hex').slice(0, 12) : null;
  })();
  const path = _path();
  if (!path || !dir || !hash) return null;
  return { key: norm, hash, file: path.join(dir, `${hash}${ext}`) };
}

export function promptsFileFor(cwd) {
  return hashOf(PROMPTS_DIR, cwd, '.jsonl');
}

export function skillsFileFor(cwd) {
  return hashOf(SKILLS_DIR, cwd, '.jsonl');
}

// loop 状态：每个 cwd 一个 JSON 文件（loops 数组，支持同 cwd 多会话并存）
export function loopsFileFor(cwd) {
  return hashOf(LOOPS_DIR, cwd, '.json');
}

// loop 审计日志：与状态同 hash，扩展名不同——落同一目录便于人肉对照
export function loopsLogFileFor(cwd) {
  return hashOf(LOOPS_DIR, cwd, '.jsonl');
}

export function storePathFromEnv() {
  return process.env.NX_RP_STORE || STORE_PATH;
}

// cwd 归一化：跨平台把路径折成同一字符串。
export function normalizeScope(p) {
  const path = _path();
  if (!path) return p;
  try {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch {
    return p;
  }
}

// ─── cwdScope / cwdDir（ALS 透明穿透） ────────────────────────────────
let _alsModule = null;
let _alsModuleTried = false;
function getAlsModule() {
  if (_alsModuleTried) return _alsModule;
  _alsModuleTried = true;
  try {
    _alsModule = _require('./als.js');
  } catch {
    _alsModule = null;
  }
  return _alsModule;
}
function syncAlsStore() {
  const mod = getAlsModule();
  if (!mod) return null;
  return mod.scopeStorage.getStore();
}

export function cwdScope() {
  const s = syncAlsStore();
  return normalizeScope(s?.scope || process.cwd());
}

export function cwdDir() {
  const s = syncAlsStore();
  return s?.dir || process.cwd();
}

// 名称安全校验：拒绝路径穿越、保留中文等合法命名。
export function assertSafeName(name, label = '名称') {
  if (!name || typeof name !== 'string' || /[\\/]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw invalidInput('非法 ' + label + ': ' + name);
  }
  return name;
}

// ─── 知识库（KB）目录 ─────────────────────────────────────────────
export function serializePath(p) {
  return normalizeScope(p).replace(/[^A-Za-z0-9_-]/g, '-');
}

export function assertSafeKbName(name) {
  if (!name || typeof name !== 'string' || /[\\/]/.test(name) || name.includes('..')) {
    throw invalidInput('非法知识库目录名: ' + name);
  }
  return name;
}

export function docRootFor(docRootSetting) {
  // 默认 docRoot 是 <APP_DIR>/doc；用户可在 store.settings.docRoot 里改。
  // APP_DIR 为 null（前端路径）→ 返回 null 即可；调用方 (workspaceKbFor) 会
  // 抛明确错误而不是返回假路径。
  if (docRootSetting) return docRootSetting;
  return APP_DIR ? `${APP_DIR}${_path().sep}doc` : null;
}

export function workspaceKbFor(cwd, docRootSetting) {
  const name = assertSafeKbName(serializePath(cwd));
  const path = _path();
  if (!path) throw new Error('paths unavailable in browser');
  return path.join(docRootFor(docRootSetting), name);
}
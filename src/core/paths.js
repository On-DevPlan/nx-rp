// 路径与常量的唯一权威来源。
//
// 单一状态文件（存应用配置 + cwd 作用域业务数据）：
//   ~/.nx-rp/store.json
//
// cwd 作用域：CLI 启动自动识别 process.cwd() 作为 scope key；同一 cwd 看到一致的 scope。
// 允许测试与多实例覆盖：环境变量 NX_RP_STORE 优先。

// 面板 scope 切换的穿透点：HTTP 请求携带 x-nx-rp-scope 头时，api.js 把整个请求
// 包进 scopeStorage.run({ scope, dir })——此后该请求 async 链上所有 cwdScope() /
// cwdDir() 都读到激活的目录，业务代码零感知。
// 之所以在 cwdScope() 单点做：全部业务都现算调用它（无 import 期缓存），一处生效全链路；
// CLI 进程没有 ALS 上下文，getStore() 为 null 自然回落 process.cwd()，行为不变。
export const scopeStorage = new AsyncLocalStorage();
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { invalidInput } from './errors.js';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const APP_NAME = 'nx-rp';
export const APP_DIR = join(homedir(), `.${APP_NAME}`);
export const STORE_PATH = join(APP_DIR, 'store.json');

// Claude Code 用户级设置与 hook 日志目录。
// let：仅测试重定向（ESM live binding，service.js import 的是同一份变量）；生产不写。
export let CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
export let PROMPTS_DIR = join(APP_DIR, 'prompts');
export let SKILLS_DIR = join(APP_DIR, 'skills');

// 测试专用：重定向 hook 相关路径（service.js 每次调用都现读变量）。
export function setHookPaths({ settingsPath, promptsDir, skillsDir } = {}) {
  if (settingsPath) CLAUDE_SETTINGS_PATH = settingsPath;
  if (promptsDir) PROMPTS_DIR = promptsDir;
  if (skillsDir) SKILLS_DIR = skillsDir;
}

// hook 日志按目录哈希分文件：文件名全 ASCII，避免 cwd 里的中文/空格进路径。
export function promptsFileFor(cwd) {
  const norm = normalizeScope(cwd);
  const hash = createHash('sha1').update(norm).digest('hex').slice(0, 12);
  return { key: norm, hash, file: join(PROMPTS_DIR, `${hash}.jsonl`) };
}

export function skillsFileFor(cwd) {
  const norm = normalizeScope(cwd);
  const hash = createHash('sha1').update(norm).digest('hex').slice(0, 12);
  return { key: norm, hash, file: join(SKILLS_DIR, `${hash}.jsonl`) };
}

export function storePathFromEnv() {
  return process.env.NX_RP_STORE || STORE_PATH;
}

// cwd 归一化：跨平台把路径折成同一字符串（Windows 大小写不敏感 / 正反斜杠）。
// 不同形态的「同一目录」必须产生同一个 scope key，否则 CLI 与 Web 不同步。
export function normalizeScope(p) {
  try {
    const r = resolve(p);
    // 路径在 Windows 上大小写不敏感，归一化为小写以保证一致
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch {
    return p;
  }
}

export function cwdScope() {
  const s = scopeStorage.getStore();
  return normalizeScope(s?.scope || process.cwd());
}

// 当前作用域的**原始大小写**目录路径。cwdScope() 在 Windows 上会小写化（scope key
// 需要稳定），但拿去做 fs 相对路径解析、镜像目录（.nx-rp-workflows）时要用原路径，
// 否则路径里的目录名会被悄悄改写。无 ALS 上下文时回落 process.cwd()。
export function cwdDir() {
  const s = scopeStorage.getStore();
  return s?.dir || process.cwd();
}

// 名称安全校验：拒绝路径穿越、保留中文等合法命名。
// 用于「这个字符串会被当作**目录名或标识**」的场景。
export function assertSafeName(name, label = '名称') {
  if (!name || typeof name !== 'string' || /[\\/]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw invalidInput('非法 ' + label + ': ' + name);
  }
  return name;
}

// 让 import 不会爆炸——badInput 在 errors.js 里，这里只做语义位置提示。
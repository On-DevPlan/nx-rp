// 路径与常量的唯一权威来源。
//
// 单一状态文件（存应用配置 + cwd 作用域业务数据）：
//   ~/.nx-rp/store.json
//
// cwd 作用域：CLI 启动自动识别 process.cwd() 作为 scope key；同一 cwd 看到一致的 scope。
// 允许测试与多实例覆盖：环境变量 NX_RP_STORE 优先。
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { invalidInput } from './errors.js';

export const APP_NAME = 'nx-rp';
export const APP_DIR = join(homedir(), `.${APP_NAME}`);
export const STORE_PATH = join(APP_DIR, 'store.json');

export function storePathFromEnv() {
  return process.env.NX_RP_STORE || STORE_PATH;
}

// cwd 归一化：跨平台把路径折成同一字符串（Windows 大小写不敏感 / 正反斜杠）。
// 不同形态的「同一目录」必须产生同一个 scope key，否则 CLI 与 Web 不同步。
export function cwdScope() {
  try {
    const p = resolve(process.cwd());
    // 路径在 Windows 上大小写不敏感，归一化为小写以保证一致
    return process.platform === 'win32' ? p.toLowerCase() : p;
  } catch {
    return process.cwd();
  }
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
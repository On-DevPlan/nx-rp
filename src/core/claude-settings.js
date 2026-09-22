// Claude Code 用户级 settings.json 的外科手术式读写（hook 域共享）。
//
// 从 hook 模块抽出——hook-prompt / hook-skill 两个模块都要改同一份
// ~/.claude/settings.json，共享逻辑下沉 core/（模块互依被 eslint 禁止）。
//
// 铁律：
//   - 只增删带本工具 marker 指纹的 entry，其余 hooks 与 settings 键一律不动
//   - 写前留快照（同目录时间戳命名，轮转保留最近 KEEP 份）
//   - settings 损坏时读路径降级标注、写路径拒绝（绝不拿空对象覆盖用户配置）
import fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLAUDE_SETTINGS_PATH } from './paths.js';

// 写 settings 前留可回滚快照。快照失败视为前置条件失败——「先快照再动手」的
// 保证不能在快照环节悄悄失效。写完轮转，只留最近 KEEP 份。
const SNAPSHOT_KEEP = 5;
const SNAPSHOT_PREFIX = 'settings.json.nx-rp-bak-';

async function snapshotSettings() {
  let raw;
  try {
    raw = await fsp.readFile(CLAUDE_SETTINGS_PATH, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // 原文件不存在，无需快照
    throw e;
  }
  const dir = dirname(CLAUDE_SETTINGS_PATH);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snap = join(dir, SNAPSHOT_PREFIX + stamp);
  await fsp.writeFile(snap, raw, 'utf8');
  // 轮转：按文件名排序（时间戳命名保证字典序=时间序），超出的删旧
  const olds = (await fsp.readdir(dir))
    .filter((f) => f.startsWith(SNAPSHOT_PREFIX))
    .sort()
    .slice(0, -SNAPSHOT_KEEP);
  for (const f of olds) {
    await fsp.rm(join(dir, f), { force: true }).catch(() => {}); // 清理失败不影响主流程
  }
  return snap;
}

// 读 settings。刻意区分三种情形：
//   文件不存在 → {}（用户显式开关动作，允许创建）
//   读失败（权限等）→ 上抛（不许带着空对象走写盘路径）
//   JSON 损坏 → 上抛（绝不能拿 {hooks} 覆盖用户全部配置——permissions/env 全在里面）
export async function readSettings() {
  let raw;
  try {
    raw = await fsp.readFile(CLAUDE_SETTINGS_PATH, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    const err = new Error(`settings.json 无法解析（${CLAUDE_SETTINGS_PATH}）——请先修复该文件再执行 hook on/off`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
}

export async function writeSettings(data) {
  await fsp.mkdir(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  // tmp 名带 pid：并发写者（CLI + 面板同时点）不该共用同一个 tmp 文件
  const tmp = `${CLAUDE_SETTINGS_PATH}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, CLAUDE_SETTINGS_PATH);
}

// 在 hooks.<事件> 数组里找带指定 marker 的组（认亲只看 marker，不看 command 细节）。
export function findOwnGroups(settings, event, marker, hasMarker) {
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.filter(hasMarker);
}

function hasMarkerField(group, marker) {
  return typeof group === 'object' && group !== null && group[marker] === true;
}

// 通用「开」：把 {event, matcher, hook, marker} 追加进 settings（幂等）。
// 返回 changed 布尔——调用方决定 dry-run / skipped 语义。
export function appendOwnGroup(settings, { event, matcher, hook, marker }) {
  const hasMarker = (g) => hasMarkerField(g, marker);
  const existing = findOwnGroups(settings, event, marker, hasMarker);
  if (existing.length > 0) return false;
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  settings.hooks[event].push({ matcher, hooks: [hook], [marker]: true });
  return true;
}

// 通用「关」：摘掉带指定 marker 的组；事件数组空了连事件字段一起摘。
// 返回是否真的有东西被摘。
export function removeOwnGroups(settings, { event, marker }) {
  const hasMarker = (g) => hasMarkerField(g, marker);
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  const own = groups.filter(hasMarker);
  if (own.length === 0) return false;
  settings.hooks[event] = groups.filter((g) => !hasMarker(g));
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return true;
}

// 开关动作的标准骨架：读 → 变更 → 快照 → 写。dry-run 永不写盘。
export async function toggleSettings(mutate, { dryRun = false } = {}) {
  const settings = await readSettings();
  const next = structuredClone(settings);
  const changed = mutate(next);
  if (dryRun) return { changed, written: false, snapshot: null };
  if (!changed) return { changed: false, written: false, snapshot: null };
  const snapshot = await snapshotSettings();
  await writeSettings(next);
  return { changed: true, written: true, snapshot };
}

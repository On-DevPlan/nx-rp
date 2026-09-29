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
//
// 快照落点可指定（snapshotDir）：loop 模块写的是**项目级**配置，快照若落在
// 项目 .claude/ 里会污染仓库，所以它传 ~/.nx-rp/snapshots/。缺省＝与目标同目录
// （用户级配置的历史行为，另两个 hook 模块依赖）。
const SNAPSHOT_KEEP = 5;

async function snapshotSettings(targetPath = CLAUDE_SETTINGS_PATH, snapshotDir = null) {
  let raw;
  try {
    raw = await fsp.readFile(targetPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // 原文件不存在，无需快照
    throw e;
  }
  const dir = snapshotDir || dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });
  // 快照名带目标文件名与时间戳：集中目录里要能区分是哪个配置的快照
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = targetPath.split(/[\\/]/).pop();
  const prefix = `${base}.nx-rp-bak-`;
  const snap = join(dir, prefix + stamp);
  await fsp.writeFile(snap, raw, 'utf8');
  // 轮转：按文件名排序（时间戳命名保证字典序=时间序），超出的删旧。
  // 只轮转同一前缀的——集中目录里可能有多个项目/多个配置的快照共存。
  const olds = (await fsp.readdir(dir))
    .filter((f) => f.startsWith(prefix))
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
export async function readSettings(targetPath = CLAUDE_SETTINGS_PATH) {
  let raw;
  try {
    raw = await fsp.readFile(targetPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    const err = new Error(`settings.json 无法解析（${targetPath}）——请先修复该文件再执行 hook on/off`);
    err.code = 'INVALID_INPUT';
    throw err;
  }
}

export async function writeSettings(data, targetPath = CLAUDE_SETTINGS_PATH) {
  await fsp.mkdir(dirname(targetPath), { recursive: true });
  // tmp 名带 pid：并发写者（CLI + 面板同时点）不该共用同一个 tmp 文件
  const tmp = `${targetPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, targetPath);
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

// 提取一个 hook 组里本工具的 command（组内只要任一 hook 的 command 匹配就算）。
// 认亲的第二依据：手工粘贴的片段没有 marker 字段（manualSnippet 刻意不带内部
// 指纹），但 command 与工具写盘的完全一致——按 command 兜底认领，否则：
//   - on 的幂等检查只认 marker → 手工条目之外再追加一条，同一调用记两次
//   - off 摘不掉手工条目 → 关了开关 hook 还在跑
function groupCommands(group) {
  if (!Array.isArray(group?.hooks)) return [];
  return group.hooks
    .filter((h) => typeof h?.command === 'string')
    .map((h) => h.command);
}

// 组归属判定：有 marker 是本人；无 marker 但 command 一致也认（手工粘贴的）。
export function ownsGroup(group, marker, commands) {
  if (typeof group !== 'object' || group === null) return false;
  if (hasMarkerField(group, marker)) return true;
  const gcmds = groupCommands(group);
  return (commands || []).some((c) => gcmds.includes(c));
}

// 通用「开」：把 {event, matcher, hook, marker} 追加进 settings（幂等）。
// 返回 changed 布尔——调用方决定 dry-run / skipped 语义。
// 幂等检查 = marker 或 command 任一命中：手工粘贴的无 marker 片段也算「已启用」，
// 不再追加第二条导致同一调用记两次。
export function appendOwnGroup(settings, { event, matcher, hook, marker }) {
  const commands = [hook.command].filter(Boolean);
  const own = (g) => ownsGroup(g, marker, commands);
  const existing = findOwnGroups(settings, event, marker, own);
  if (existing.length > 0) return false;
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  settings.hooks[event].push({ matcher, hooks: [hook], [marker]: true });
  return true;
}

// 通用「关」：摘掉带指定 marker 的组（或无 marker 但 command 一致的手工组）；
// 事件数组空了连事件字段一起摘。返回是否真的有东西被摘。
export function removeOwnGroups(settings, { event, marker, commands }) {
  const own = (g) => ownsGroup(g, marker, commands || []);
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  const next = groups.filter((g) => !own(g));
  if (next.length === groups.length) return false;
  settings.hooks[event] = next;
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return true;
}

// 开关动作的标准骨架：读 → 变更 → 快照 → 写。dry-run 永不写盘。
//
// settingsPath / snapshotDir 可指定：loop 模块操作的是**项目级**配置
// （<项目>/.claude/settings.local.json），且快照要丢到 ~/.nx-rp/snapshots/
// 以免污染仓库。缺省＝用户级 ~/.claude/settings.json + 同目录快照。
export async function toggleSettings(mutate, { dryRun = false, settingsPath, snapshotDir } = {}) {
  const target = settingsPath || CLAUDE_SETTINGS_PATH;
  const settings = await readSettings(target);
  const next = structuredClone(settings);
  const changed = mutate(next);
  if (dryRun) return { changed, written: false, snapshot: null };
  if (!changed) return { changed: false, written: false, snapshot: null };
  const snapshot = await snapshotSettings(target, snapshotDir || null);
  await writeSettings(next, target);
  return { changed: true, written: true, snapshot };
}

// hook 模块业务：把「每次提交的提示词」记到本地 JSONL + 管理 ~/.claude/settings.json 的开关。
//
// 两半：
//   1. capture —— UserPromptSubmit hook 的落点：stdin 收事件 JSON，追加一行 JSONL。
//      日志类 hook 的铁律是**绝不打扰会话**：任何异常都吞掉、退出码恒 0。
//   2. on / off / status —— 外科手术式改 ~/.claude/settings.json 的 hooks 字段。
//      只增删自己那条 entry（按 marker 识别），其余 hooks 一律不动；幂等。
//
// 日志文件按 cwd 哈希分文件（promptsFileFor），log --all 跨目录查询。
import fsp from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CLAUDE_SETTINGS_PATH, PROMPTS_DIR, promptsFileFor, cwdScope } from '../../core/paths.js';

// 我们那条 hook entry 的指纹——on/off 都靠 marker 在 hooks 数组里认亲。
const HOOK_COMMAND = 'nx-rp hook capture';
const MARKER = '__nx_rp_prompt_log__';

function hookEntry() {
  return {
    type: 'command',
    command: HOOK_COMMAND,
    async: true, // 日志没有决定要做，后台跑，不给会话加延迟
    timeout: 10, // 秒；UserPromptSubmit 挡在模型前面，显式短超时兜底
  };
}

function matcherGroup() {
  // UserPromptSubmit 不吃 matcher——但结构仍是 事件 → matcher 组 → hook 列表，
  // 组本身要存在，matcher 留空字符串表示「全量触发」。
  return { matcher: '', hooks: [hookEntry()] };
}

function hasMarker(group) {
  return typeof group === 'object' && group !== null && group[MARKER] === true;
}

// 在 hooks.UserPromptSubmit 数组里找我们的组（按 marker 识别，不看 command 细节）。
function findOwnGroups(settings) {
  const groups = settings?.hooks?.UserPromptSubmit;
  if (!Array.isArray(groups)) return [];
  return groups.filter(hasMarker);
}

// ─── on / off / status ─────────────────────────────────────────────

// 写 settings 前留可回滚快照（同目录、时间戳命名）；on/off 都是破坏性写，先快照再动手。
async function snapshotSettings() {
  try {
    const raw = await fsp.readFile(CLAUDE_SETTINGS_PATH, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snap = `${CLAUDE_SETTINGS_PATH}.nx-rp-bak-${stamp}`;
    await fsp.writeFile(snap, raw, 'utf8');
    return snap;
  } catch {
    return null; // 原文件不存在，无需快照
  }
}

export async function hookOn({ dryRun = false } = {}) {
  const settings = await readSettings();
  const already = findOwnGroups(settings).length > 0;
  const next = structuredClone(settings);
  let changed = false;
  if (!already) {
    if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
      next.hooks = {};
    }
    if (!Array.isArray(next.hooks.UserPromptSubmit)) next.hooks.UserPromptSubmit = [];
    next.hooks.UserPromptSubmit.push({ ...matcherGroup(), [MARKER]: true });
    changed = true;
  }
  if (dryRun) {
    return { status: 'ok', dryRun: true, enabled: true, skipped: !changed, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  if (!changed) {
    return { status: 'ok', enabled: true, skipped: true, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  const snapshot = await snapshotSettings();
  await writeSettings(next);
  return { status: 'ok', enabled: true, snapshot, settingsPath: CLAUDE_SETTINGS_PATH };
}

export async function hookOff({ dryRun = false } = {}) {
  const settings = await readSettings();
  const own = findOwnGroups(settings);
  if (own.length === 0) {
    return { status: 'ok', enabled: false, skipped: true, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  const next = structuredClone(settings);
  next.hooks.UserPromptSubmit = next.hooks.UserPromptSubmit.filter((g) => !hasMarker(g));
  if (next.hooks.UserPromptSubmit.length === 0) delete next.hooks.UserPromptSubmit;
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  if (dryRun) {
    return { status: 'ok', dryRun: true, enabled: false, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  const snapshot = await snapshotSettings();
  await writeSettings(next);
  return { status: 'ok', enabled: false, snapshot, settingsPath: CLAUDE_SETTINGS_PATH };
}

export async function hookStatus() {
  const settings = await readSettings();
  const own = findOwnGroups(settings);
  return {
    enabled: own.length > 0,
    settingsPath: CLAUDE_SETTINGS_PATH,
    logDir: PROMPTS_DIR,
    disableAllHooks: settings.disableAllHooks === true,
  };
}

async function readSettings() {
  try {
    const raw = await fsp.readFile(CLAUDE_SETTINGS_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    return {}; // 不存在：从空对象起步（用户显式开关动作，允许创建文件）
  }
}

async function writeSettings(data) {
  await fsp.mkdir(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  const tmp = CLAUDE_SETTINGS_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, CLAUDE_SETTINGS_PATH);
}

// ─── capture / log ─────────────────────────────────────────────────

// stdin 整体是 UserPromptSubmit 事件 JSON。日志 hook 永不抛错。
export async function captureFromStdin() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    return { ok: false };
  }
  return captureRaw(raw);
}

export async function captureRaw(raw) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return { ok: false }; // 非 JSON：静默丢弃
  }
  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (!prompt) return { ok: false };
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  return captureRecord({ prompt, cwd, sessionId: event.session_id });
}

export async function captureRecord({ prompt, cwd, sessionId }) {
  const { file } = promptsFileFor(cwd);
  const record = {
    ts: new Date().toISOString(),
    cwd, // 原样记录；查询时按归一化 key 匹配
    sessionId: sessionId || undefined,
    prompt,
  };
  await fsp.mkdir(PROMPTS_DIR, { recursive: true });
  await fsp.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
  return { ok: true, file };
}

function readStdin() {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolvePromise(chunks.join('')));
    process.stdin.on('error', rejectPromise);
    // hook 管道异常时不许挂着：3 秒兜底（UserPromptSubmit 预算 30s，这里远小于它）
    setTimeout(() => rejectPromise(new Error('stdin timeout')), 3000).unref();
  });
}

// 查询：默认当前 cwd（按归一化 key 匹配）；--all 跨全部目录。倒序（最新在前）。
export async function listPrompts({ all = false, limit = 50 } = {}) {
  const files = all
    ? (await fsp.readdir(PROMPTS_DIR).catch(() => [])).filter((f) => f.endsWith('.jsonl')).map((f) => join(PROMPTS_DIR, f))
    : [promptsFileFor(process.cwd()).file];
  const out = [];
  for (const file of files) {
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue; // 文件不存在 = 还没有记录
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch { /* 坏行跳过 */ }
    }
  }
  if (!all) {
    const key = cwdScope();
    return out.filter((r) => typeof r.cwd === 'string' && promptsFileFor(r.cwd).key === key)
      .slice(-limit).reverse();
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // 稳定：同 ts 保持追加序
  return out.slice(0, limit);
}

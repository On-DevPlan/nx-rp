// hook-prompt 业务：UserPromptSubmit hook——把每次提交的提示词记到本地 JSONL。
//
// 职责单一：只管自己那条 entry（marker `__nx_rp_prompt_log__`）。
// settings 外科手术与 stdin 容错在 core/claude-settings.js / core/hook-io.js。
//
// 日志类 hook 的铁律是**绝不打扰会话**：capture 任何异常都吞掉、退出码恒 0。
// 日志文件按 cwd 哈希分文件（promptsFileFor），log --all 跨目录查询。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_SETTINGS_PATH, PROMPTS_DIR, promptsFileFor, cwdScope } from '../../core/paths.js';
import { appendOwnGroup, removeOwnGroups, toggleSettings, findOwnGroups, ownsGroup, readSettings } from '../../core/claude-settings.js';
import { readStdin, parseHookEvent } from '../../core/hook-io.js';

// 我们那条 hook entry 的指纹——on/off 靠 marker 在 hooks 数组里认亲。
const HOOK_COMMAND = 'nx-rp hook capture';
const MARKER = '__nx_rp_prompt_log__';
const EVENT = 'UserPromptSubmit';

function hookEntry() {
  return {
    type: 'command',
    command: HOOK_COMMAND,
    async: true, // 日志没有决定要做，后台跑，不给会话加延迟
    timeout: 10, // 秒；UserPromptSubmit 挡在模型前面，显式短超时兜底
  };
}

// UserPromptSubmit 不吃 matcher——但结构仍是 事件 → matcher 组 → hook 列表，
// 组本身要存在，matcher 留空字符串表示「全量触发」。
function spec() {
  return { event: EVENT, matcher: '', hook: hookEntry(), marker: MARKER };
}

function hasMarker(group) {
  return typeof group === 'object' && group !== null && group[MARKER] === true;
}

// 手动添加用的 JSON 片段（面板展示 + 复制）。与 hookOn 写盘的 entry **完全同源**
// （同一组常量生成，含 marker）——粘进配置文件的条目和工具写盘的逐字节一致，
// on 的幂等检查直接认领（不再靠 command 兜底），off 也能摘除，不会出现两条并存。
export function manualSnippet() {
  return {
    hooks: {
      [EVENT]: [
        { matcher: '', hooks: [hookEntry()], [MARKER]: true },
      ],
    },
  };
}

// ─── on / off / status ─────────────────────────────────────────────

export async function hookOn({ dryRun = false } = {}) {
  const { changed, snapshot } = await toggleSettings(
    (next) => appendOwnGroup(next, spec()),
    { dryRun },
  );
  if (dryRun) {
    return { status: 'ok', dryRun: true, enabled: true, skipped: !changed, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  if (!changed) {
    return { status: 'ok', enabled: true, skipped: true, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  return { status: 'ok', enabled: true, snapshot, settingsPath: CLAUDE_SETTINGS_PATH };
}

export async function hookOff({ dryRun = false } = {}) {
  const settings = await readSettings();
  const own = findOwnGroups(settings, EVENT, MARKER, (g) => ownsGroup(g, MARKER, [HOOK_COMMAND]));
  if (own.length === 0) {
    return { status: 'ok', enabled: false, skipped: true, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  const { snapshot } = await toggleSettings(
    (next) => removeOwnGroups(next, { event: EVENT, marker: MARKER, commands: [HOOK_COMMAND] }),
    { dryRun },
  );
  if (dryRun) {
    return { status: 'ok', dryRun: true, enabled: false, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  return { status: 'ok', enabled: false, snapshot, settingsPath: CLAUDE_SETTINGS_PATH };
}

export async function hookStatus() {
  let settings;
  let corrupt = false;
  try {
    settings = await readSettings();
  } catch {
    settings = {};   // 只读路径降级：不抛，但如实标注
    corrupt = true;
  }
  const own = findOwnGroups(settings, EVENT, MARKER, (g) => ownsGroup(g, MARKER, [HOOK_COMMAND]));
  return {
    enabled: own.length > 0,
    // 手工粘贴的无 marker 片段数：>0 说明用户手动配过，提醒可能与面板按钮并存
    manualCount: own.filter((g) => !hasMarker(g)).length,
    settingsPath: CLAUDE_SETTINGS_PATH,
    logDir: PROMPTS_DIR,
    disableAllHooks: settings.disableAllHooks === true,
    corrupt,
    snippet: manualSnippet(), // 面板「手动添加」卡片直接展示这段 JSON
  };
}

// ─── capture / log ─────────────────────────────────────────────────

// stdin 整体是 UserPromptSubmit 事件 JSON。日志 hook 永不抛错。
export async function captureFromStdin() {
  const raw = await readStdin();
  return captureRaw(raw);
}

export async function captureRaw(raw) {
  const event = parseHookEvent(raw);
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

// 查询：默认当前 cwd（按归一化 key 匹配）；--all 跨全部目录。倒序（最新在前）。
//
// 默认返回**记录数组**（兼容历史接口）；`{ shape: 'with-groups' }` 时返回
// `{ records, groups }`，面板/CLI 按需取分组聚合。
//
// cwd 筛选（仅 all 模式）：cwdFilter 子串匹配；文件级早停 + ts 早停：
//   - 文件名 = cwd sha1 前 12 位，无法反推 cwd——扫首行拿 cwd 比对，不匹配整文件跳过。
//   - 单文件按 ts 倒序遍历（append-only，文件尾即最新），命中 limit 立即跳出该文件。
export async function listPrompts({ all = false, limit = 50, cwdFilter = null, shape = 'records' } = {}) {
  if (all) {
    const { records, groups } = await collectAll({ limit, cwdFilter });
    return shape === 'with-groups' ? { records, groups } : records;
  }
  // 单文件模式不涉及聚合（cwd 已锁）
  return collectScope({ limit });
}

async function collectScope({ limit }) {
  const file = promptsFileFor(process.cwd()).file;
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const key = cwdScope();
  return parseLines(raw)
    .filter((r) => typeof r.cwd === 'string' && promptsFileFor(r.cwd).key === key)
    .slice(-limit)
    .reverse();
}

async function collectAll({ limit, cwdFilter }) {
  const needle = typeof cwdFilter === 'string' ? cwdFilter.trim().toLowerCase() : '';
  let files;
  try {
    files = (await fsp.readdir(PROMPTS_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { records: [], groups: [] };
  }
  const matched = [];
  for (const f of files) {
    const full = join(PROMPTS_DIR, f);
    let raw;
    try {
      raw = await fsp.readFile(full, 'utf8');
    } catch {
      continue;
    }
    if (needle) {
      // 文件级早停：首行 JSON 拿 cwd，匹配不上整文件跳过
      const head = firstNonEmptyLine(raw);
      if (!head) continue;
      let parsed;
      try { parsed = JSON.parse(head); } catch { continue; }
      const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';
      if (!cwd.toLowerCase().includes(needle)) continue;
    }
    matched.push(raw);
  }

  // 跨文件按 ts 倒序归并：每个文件只 parse 出尾部 N 条即可（ts 单调，尾部即最新）。
  // groups 是「所有 tail 扫描到」的 cwd 聚合——不被 limit 截（用户切 --groups 时
  // 仍能看到全量目录列表）。records 是归并到 limit 的最新前 N。
  //
  // TAIL_PER_FILE：限单文件 parse 上限。limit*4 起步够聚合（覆盖面板默认 200×4=800）；
  // 用户实际 cwd 数量远小于文件数时等于零浪费；存在「一个 cwd 一文件数百条」罕见场景
  // 时会被聚合截到 800 —— 取舍：保留文件扫描 O(1) 内存的简洁、接受聚合有界。
  const TAIL_PER_FILE = Math.max(limit * 4, 200);
  const tails = matched.map((raw) => {
    const lines = raw.split('\n');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < TAIL_PER_FILE; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
    return out;
  });

  // 聚合：来自所有 tail（与 limit 解耦）
  const groupMap = new Map();
  for (const t of tails) {
    for (const r of t) {
      const cwd = typeof r.cwd === 'string' && r.cwd ? r.cwd : '(未知)';
      const g = groupMap.get(cwd) || { cwd, count: 0, latestTs: '' };
      g.count += 1;
      if (typeof r.ts === 'string' && (!g.latestTs || r.ts > g.latestTs)) g.latestTs = r.ts;
      groupMap.set(cwd, g);
    }
  }

  // k 路归并：每个文件看作倒序流，弹出 ts 最大的入 records，达到 limit 即停。
  // tail 数组头 = 最新（倒序遍历先 push 进来的）；比较取头部；取出用 shift（O(N) 但
  // 单文件尾巴顶多几百条 + 文件数小，可接受）。
  const records = [];
  while (records.length < limit) {
    let bestIdx = -1;
    let bestTs = '';
    for (let i = 0; i < tails.length; i++) {
      if (!tails[i].length) continue;
      const head = tails[i][0];
      const t = (head && head.ts) || '';
      if (bestIdx < 0 || t > bestTs) { bestTs = t; bestIdx = i; }
    }
    if (bestIdx < 0) break; // 所有文件流都空了
    records.push(tails[bestIdx].shift());
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => (a.latestTs < b.latestTs ? 1 : a.latestTs > b.latestTs ? -1 : 0));
  return { records, groups };
}

function parseLines(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

function firstNonEmptyLine(raw) {
  for (const line of raw.split('\n')) {
    if (line.trim()) return line;
  }
  return null;
}

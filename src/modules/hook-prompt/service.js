// hook-prompt 业务：UserPromptSubmit hook——把每次提交的提示词记到本地 JSONL。
//
// 职责单一：只管自己那条 entry（marker `__nx_rp_prompt_log__`）。
// settings 外科手术与 stdin 容错在 core/claude-settings.js / core/hook-io.js。
//
// 日志类 hook 的铁律是**绝不打扰会话**：capture 任何异常都吞掉、退出码恒 0。
// 日志文件按 cwd 哈希分文件（promptsFileFor），log --all 跨目录查询。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_SETTINGS_PATH, PROMPTS_DIR, SNAPSHOTS_DIR, promptsFileFor, cwdScope, normalizeScope } from '../../core/paths.js';
import { appendOwnGroup, removeOwnGroups, toggleSettings, findOwnGroups, ownsGroup, readSettings, snapshotFile } from '../../core/claude-settings.js';
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

// ─── 系统注入的提示词（机器塞进 UserPromptSubmit 的消息）─────────────
//
// Claude Code 除了用户真手打的字，还会把机器消息当提示词送进同一个 hook：
// `<task-notification>`（后台任务完成）、`<cross-session-message>`（别的会话）、
// `<agent-message>`（subagent 回报）等。它们不是用户意图，混在记录里会：
//   - 面板列表被灌水（实测 1156 条里 253 条是 task-notification，占 22%）
//   - agent 拿日志做分析时被带偏（得先手工剥一层才能统计真实提示词）
//
// **按标记白名单判定，不按「以 < 开头」判定**：用户真的会贴 `<svg>…</svg>`、
// `<pre>` 之类的代码片段——那是正经提示词，不能误杀。
const SYSTEM_INJECTED_MARKERS = new Set([
  'task-notification',
  'cross-session-message',
  'agent-message',
  'system-reminder',
  'command-message',
  'command-name',
  'local-command-stdout',
  'user-prompt-submit-hook',
]);

export function isSystemInjected(prompt) {
  const s = String(prompt ?? '').trimStart();
  if (!s.startsWith('<')) return false;
  const m = /^<([a-zA-Z][\w-]*)/.exec(s);
  return !!m && SYSTEM_INJECTED_MARKERS.has(m[1].toLowerCase());
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
// `{ records, groups, systemCount, filtered }`，面板/CLI 按需取分组聚合。
//
// **cwd 一律走归一化 key**（`normalizeScope`）。曾经这里拿记录里的原始 `cwd`
// 字符串分组、又用子串筛选，后果是同一个目录派生出两条组（`D:\x` 与 `D:/x`），
// 选中其中一条时另一条形态的记录一条都匹配不上 → 面板切组后**空白**。
// 存储侧 `promptsFileFor` 本来就是按归一化 key 分文件的（见 paths.js 的 hashOf），
// 所以这里对齐它即可，不需要迁移历史数据。
//
// `includeSystem=false`（默认）时**系统注入的记录不进列表**——它们不是用户意图。
// 过滤发生在 limit 之前：否则 limit 条里被滤掉一半，列表永远填不满。
// `systemCount` 仍报出范围内系统注入的**总条数**（面板据此显示「已隐藏 N 条」
// 并提供清理入口），`filtered` 是本次实际被剔除的条数。
export async function listPrompts({ all = false, limit = 50, cwd = null, shape = 'records', includeSystem = false } = {}) {
  // 精确匹配一条目录；`scope: true` 表示「跟随当前 cwd」。两种形态统一收到 `target`。
  const target = cwd ? normalizeScope(cwd) : (all ? null : cwdScope());
  const { records, groups, systemCount, filtered } = await collectAll({ limit, target, includeSystem });
  if (shape === 'with-groups') return { records, groups, systemCount, filtered };
  return records;
}

// 从原始记录取归一化 scope key；cwd 缺失的记为 null（由调用方决定丢还是归入「(未知)」）。
function scopeKeyOf(r) {
  return typeof r.cwd === 'string' && r.cwd ? normalizeScope(r.cwd) : null;
}

async function collectAll({ limit, target, includeSystem }) {
  let files;
  try {
    files = (await fsp.readdir(PROMPTS_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { records: [], groups: [], systemCount: 0, filtered: 0 };
  }

  // 组列表**永远全局**：它是面板上的「目录切换器」——一旦它跟着 target 收窄，
  // 用户切进某个目录后就只剩自己那一项，再也切不出去。
  // 所以无论选没选目录都扫全部文件；**只有 records 受 target 收窄**。
  //
  // TAIL_PER_FILE：限单文件进入 records 归并的条数，避免「一个目录几千条」时全量
  // 载入内存。代价：该目录超过这个数的更早记录不会出现在列表里（groups 的 count
  // 也只统计到这里）。面板一次最多看 200 条，200*20=4000 已是实际使用的天花板。
  const TAIL_PER_FILE = Math.max(limit * 20, 500);
  const exact = target ? promptsFileFor(target).file : null;

  const groupMap = new Map();
  const tails = [];
  let systemCount = 0;
  for (const name of files) {
    const full = join(PROMPTS_DIR, name);
    const recs = await readRecords(full);
    if (!recs.length) continue;

    // 拆成「真实提示词」与「系统注入」两堆。系统注入**默认剔除**——
    // 分组 count 也只算真实提示词，否则下拉里写着 200 条、列表却只有 150 条。
    const real = [];
    let noise = 0;
    for (const r of recs) {
      if (isSystemInjected(r.prompt)) noise++;
      else real.push(r);
    }

    // 分组聚合：按归一化 key 归并（不被 limit 截），display 取该目录最新一条记录的
    // 原始形态，保留用户自己的大小写与分隔符。曾经按原始 cwd 字符串分组 → 同一目录
    // 派生出两条组（`D:\x` 与 `D:/x`），选中其一另一条形态的记录就一条都匹配不上。
    for (const r of real) {
      const key = scopeKeyOf(r);
      if (!key) continue;
      const g = groupMap.get(key) || { key, display: r.cwd, count: 0, latestTs: '' };
      g.count += 1;
      if (typeof r.ts === 'string' && r.ts > g.latestTs) { g.latestTs = r.ts; g.display = r.cwd; }
      groupMap.set(key, g);
    }

    // 选了目录就只让那一个文件进 records——文件名 = 归一化 key 的 sha1 前 12 位，
    // O(1) 定位，既不读别的目录、也不会因为原文大小写/分隔符形态不同而漏掉。
    // 历史版本曾用「首行 cwd 子串」早停：形态一变就误杀，还把兄弟目录
    // （proj-alpha 匹配上 proj-alpha-2）一并捞了进来。
    if (exact && full !== exact) continue;
    systemCount += noise;
    const tail = (includeSystem ? recs : real).slice(-TAIL_PER_FILE);
    tail.reverse(); // ts 单调 → 倒序即最新在前，归并取头
    tails.push(tail);
  }

  // k 路归并：每个文件看作倒序流，弹出 ts 最大的入 records，达到 limit 即停。
  const records = [];
  while (records.length < limit) {
    let bestIdx = -1;
    let bestTs = '';
    for (let i = 0; i < tails.length; i++) {
      const head = tails[i][0];
      if (!head) continue;
      const t = head.ts || '';
      if (bestIdx < 0 || t > bestTs) { bestTs = t; bestIdx = i; }
    }
    if (bestIdx < 0) break; // 所有文件流都空了
    records.push(tails[bestIdx].shift());
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => (a.latestTs < b.latestTs ? 1 : a.latestTs > b.latestTs ? -1 : 0));
  return { records, groups, systemCount, filtered: includeSystem ? 0 : systemCount };
}

// 读一个文件并 parse 出全部记录（坏行跳过）。文件不存在 = 该目录还没记录，返回空数组。
async function readRecords(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

// ─── 清理：把系统注入的记录从 JSONL 里物理剔除 ──────────────────────
//
// 展示层已经默认不显示它们，但行还在文件里——日志继续膨胀、也干扰手工排查。
// 这里提供**物理清理**：写前留快照（可回滚），只删系统注入的行；其余行
// （真实提示词、连解析都失败的坏行）一律原样保留。
//
// 范围：all=true → 全部目录文件；否则只处理 cwd 指向的那一个（默认当前 scope）。
// 坏行**不删**：解析不出来就不知道它是什么，不许替用户做决定。
export async function cleanSystemRecords({ all = false, cwd = null, dryRun = false } = {}) {
  const target = cwd ? normalizeScope(cwd) : (all ? null : cwdScope());
  const empty = { removed: 0, files: 0, scanned: 0, snapshots: [], dryRun: !!dryRun };
  let names;
  try {
    names = (await fsp.readdir(PROMPTS_DIR)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return empty;
  }
  const exact = target ? promptsFileFor(target).file : null;

  const changed = [];
  let removed = 0;
  let scanned = 0;
  for (const name of names) {
    const full = join(PROMPTS_DIR, name);
    if (exact && full !== exact) continue;
    let raw;
    try { raw = await fsp.readFile(full, 'utf8'); } catch { continue; }
    const lines = raw.split('\n');
    const keep = [];
    let drop = 0;
    for (const line of lines) {
      if (!line.trim()) { keep.push(line); continue; } // 空行原样留着
      let rec = null;
      try { rec = JSON.parse(line); } catch { rec = null; }
      if (rec && isSystemInjected(rec.prompt)) { drop++; continue; }
      keep.push(line); // 坏行也留——不知道是什么就不许删
    }
    scanned += lines.filter((l) => l.trim()).length;
    removed += drop;
    if (drop > 0) changed.push({ file: full, content: keep.join('\n') });
  }

  if (!changed.length) return { ...empty, removed: 0, files: 0, scanned };
  if (dryRun) {
    return { removed, files: changed.length, scanned, snapshots: [], dryRun: true };
  }

  // 写前留快照：落在 ~/.nx-rp/snapshots/（集中目录，不污染任何项目仓库）。
  const snapshots = [];
  for (const c of changed) {
    const snap = await snapshotFile(c.file, SNAPSHOTS_DIR);
    if (snap) snapshots.push(snap);
  }
  // 原子替换：先写 tmp 再 rename——中途中断不会留下半截日志文件。
  for (const c of changed) {
    const tmp = `${c.file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, c.content, 'utf8');
    await fsp.rename(tmp, c.file);
  }
  return { removed, files: changed.length, scanned, snapshots, dryRun: false };
}

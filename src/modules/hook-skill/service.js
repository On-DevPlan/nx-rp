// hook-skill 业务：PostToolUse(Skill) hook——把每次 skill 调用记到本地 JSONL + 健康分。
//
// 职责单一：只管自己那条 entry（marker `__nx_rp_skill_track__`）。
// settings 外科手术与 stdin 容错在 core/claude-settings.js / core/hook-io.js。
//
// 健康分借鉴 teamai-cli skill-health.ts：
//   score = 使用分(0-60，相对最高使用量归一化) + 新鲜度分(0-40，30 天线性衰减)
//
// 日志类 hook 的铁律是**绝不打扰会话**：skill-track 任何异常都吞掉、退出码恒 0。
// 记录文件按 cwd 哈希分文件（skillsFileFor），skills --all 跨目录查询。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_SETTINGS_PATH, SKILLS_DIR, skillsFileFor, cwdScope } from '../../core/paths.js';
import { appendOwnGroup, removeOwnGroups, toggleSettings, findOwnGroups, ownsGroup, readSettings } from '../../core/claude-settings.js';
import { readStdin, parseHookEvent, deriveSessionId } from '../../core/hook-io.js';

// 我们那条 hook entry 的指纹——on/off 靠 marker 在 hooks 数组里认亲。
const SKILL_COMMAND = 'nx-rp hook skill-track';
const SLASH_COMMAND = 'nx-rp hook skill-slash';
const MARKER = '__nx_rp_skill_track__';
const MARKER_SLASH = '__nx_rp_skill_track_slash__';
const EVENT = 'PostToolUse';
const EVENT_SLASH = 'UserPromptSubmit';

function skillHookEntry() {
  return {
    type: 'command',
    command: SKILL_COMMAND,
    async: true,
    timeout: 10,
  };
}

function slashHookEntry() {
  return {
    type: 'command',
    command: SLASH_COMMAND,
    async: true,
    timeout: 10,
  };
}

// PostToolUse 的 Skill 追踪挂在 matcher: "Skill" 上——只有 Skill 工具调用才触发，
// 其他工具调用零开销（PostToolUse 对每个工具调用都会走一遍 matcher 过滤）。
function spec() {
  return { event: EVENT, matcher: 'Skill', hook: skillHookEntry(), marker: MARKER };
}

// 斜杠追踪挂 UserPromptSubmit：用户敲 /skill-name 走 prompt 展开，不产生 Skill
// 工具调用（对标 teamai-cli track-slash）——没有这条，斜杠调用的 skill 全部漏记。
function specSlash() {
  return { event: EVENT_SLASH, matcher: '', hook: slashHookEntry(), marker: MARKER_SLASH };
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
        { matcher: 'Skill', hooks: [skillHookEntry()], [MARKER]: true },
      ],
      [EVENT_SLASH]: [
        { matcher: '', hooks: [slashHookEntry()], [MARKER_SLASH]: true },
      ],
    },
  };
}

// ─── on / off / status ─────────────────────────────────────────────

export async function hookOn({ dryRun = false } = {}) {
  const { changed, snapshot } = await toggleSettings((next) => {
    const a = appendOwnGroup(next, spec());
    const b = appendOwnGroup(next, specSlash());
    return a || b;
  }, { dryRun });
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
  const commands = [SKILL_COMMAND, SLASH_COMMAND];
  const own = findOwnGroups(settings, EVENT, MARKER, (g) => ownsGroup(g, MARKER, commands))
    .concat(findOwnGroups(settings, EVENT_SLASH, MARKER_SLASH, (g) => ownsGroup(g, MARKER_SLASH, commands)));
  if (own.length === 0) {
    return { status: 'ok', enabled: false, skipped: true, settingsPath: CLAUDE_SETTINGS_PATH };
  }
  const { snapshot } = await toggleSettings((next) => {
    const a = removeOwnGroups(next, { event: EVENT, marker: MARKER, commands });
    const b = removeOwnGroups(next, { event: EVENT_SLASH, marker: MARKER_SLASH, commands });
    return a || b;
  }, { dryRun });
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
  const commands = [SKILL_COMMAND, SLASH_COMMAND];
  const ownTool = findOwnGroups(settings, EVENT, MARKER, (g) => ownsGroup(g, MARKER, commands));
  const ownSlash = findOwnGroups(settings, EVENT_SLASH, MARKER_SLASH, (g) => ownsGroup(g, MARKER_SLASH, commands));
  const own = [...ownTool, ...ownSlash];
  return {
    enabled: own.length > 0,
    // 两条落点分开报：面板能看到哪条在、哪条缺（旧版本升上来 slash 常缺失）
    toolHook: ownTool.length > 0,
    slashHook: ownSlash.length > 0,
    // 手工粘贴的无 marker 片段数：>0 说明用户手动配过，off 时会被一并摘掉
    manualCount: own.filter((g) => !hasMarker(g)).length,
    settingsPath: CLAUDE_SETTINGS_PATH,
    skillsDir: SKILLS_DIR,
    disableAllHooks: settings.disableAllHooks === true,
    corrupt,
    snippet: manualSnippet(),
  };
}

// ─── skill 追踪 / 健康分 ───────────────────────────────────────────

// 从 PostToolUse 事件的 tool_input 里提取 skill 名。与 teamai-cli 的
// extractSkillUse 同一取舍：Skill 工具的入参字段各宿主版本不一
// （skill / name / command），逐个回退；SKILL.md 路径取父目录名。
export function extractSkillName(toolInput) {
  const parsed = typeof toolInput === 'string' ? safeParse(toolInput) : toolInput;
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed.skill ?? parsed.name ?? parsed.command ?? null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const mdMatch = trimmed.match(/[\\/]+([^/\\]+)[\\/]+SKILL\.md$/i);
  if (mdMatch) return mdMatch[1];
  return trimmed;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// stdin 整体是 PostToolUse 事件 JSON。与 capture 同一铁律：永不抛错。
export async function skillTrackFromStdin() {
  const raw = await readStdin();
  return skillTrackRaw(raw);
}

export async function skillTrackRaw(raw) {
  const event = parseHookEvent(raw);
  if (event.tool_name !== 'Skill') return { ok: false }; // matcher 兜底：非 Skill 调用不记
  const name = extractSkillName(event.tool_input);
  if (!name || !isValidSkillName(name)) return { ok: false };
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  return skillRecord({ skill: name, cwd, sessionId: event.session_id });
}

// 斜杠追踪落点：stdin 是 UserPromptSubmit 事件 JSON。prompt 以 / 开头时提取
// 首词当 skill 名——但必须命中本机已安装的 skill 才记录（skillExists 校验），
// 防止把 /usr/bin 之类的路径、普通以 / 开头的消息误记成 skill 使用。永不抛错。
export async function skillSlashFromStdin() {
  const raw = await readStdin();
  return skillSlashRaw(raw);
}

export async function skillSlashRaw(raw) {
  const event = parseHookEvent(raw);
  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (!prompt.startsWith('/')) return { ok: false };
  const m = prompt.match(/^\/([\w.@/-]+)/);
  if (!m) return { ok: false };
  // 带路径形态（/dir/skill）取末段；裸名直接用
  const name = m[1].includes('/') ? m[1].split('/').filter(Boolean).pop() : m[1];
  if (!name || !isValidSkillName(name)) return { ok: false };
  if (!(await skillExists(name))) return { ok: false, reason: 'not-installed' };
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  return skillRecord({ skill: name, cwd, sessionId: deriveSessionId(event, cwd), via: 'slash' });
}

// skill 是否真实安装。生产版扫已知目录（对标 teamai-cli skillExistsOnDisk）：
//   ~/.claude/skills/<name>/SKILL.md  ← 用户级
//   <cwd>/.claude/skills/<name>/SKILL.md  ← 项目级
// 斜杠输入五花八门，存在性校验是防止幻影 skill 污染统计的唯一闸门。
// 测试可注入额外的目录（skillRoots）——不污染真实家目录。
const _skillRoots = [
  (home) => join(home, '.claude', 'skills'),
  (cwd) => join(cwd, '.claude', 'skills'),
];

export function setSkillRoots(roots) {
  if (!Array.isArray(roots)) return; // null/undefined = 还原（保留默认）
  _skillRoots.length = 0;
  for (const r of roots) _skillRoots.push(r);
}

export async function skillExists(name) {
  const os = await import('node:os').catch(() => null);
  const homeDir = os?.homedir?.() || process.env.USERPROFILE || process.env.HOME;
  const cwd = process.cwd();
  const candidates = [];
  for (const root of _skillRoots) {
    const p = root(homeDir);
    if (!candidates.includes(p)) candidates.push(p);
    if (cwd !== homeDir) {
      const q = root(cwd);
      if (!candidates.includes(q)) candidates.push(q);
    }
  }
  for (const dir of candidates) {
    if (await exists(join(dir, name, 'SKILL.md'))) return true;
  }
  return false;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

// skill 名白名单：面板要把它当展示文本渲染，控制字符直接拒绝。
function isValidSkillName(name) {
  return /^[\w./:@+-]{1,128}$/u.test(name) && !/[<>\\^\r\n]/.test(name);
}

export async function skillRecord({ skill, cwd, sessionId, via }) {
  const { file } = skillsFileFor(cwd);
  const record = {
    ts: new Date().toISOString(),
    cwd,
    sessionId: sessionId || undefined,
    skill,
    via: via || undefined, // 'slash' = 斜杠调用；缺省 = Skill 工具调用
  };
  await fsp.mkdir(SKILLS_DIR, { recursive: true });
  await fsp.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
  return { ok: true, file };
}

// 健康分（借鉴 teamai-cli skill-health.ts）：
//   score = 使用分(0-60，相对全部 skill 里最高次数线性归一化) + 新鲜度分(0-40，30 天线性衰减)
//   没用过的 skill 记 0 分——它没死，只是从未被证明有用。
export function healthScore(count, lastUsedTs, maxCount, now = Date.now()) {
  if (!count || !maxCount) return 0;
  const usage = Math.min(60, Math.round((count / maxCount) * 60));
  const days = Math.max(0, (now - new Date(lastUsedTs).getTime()) / 86_400_000);
  const freshness = days >= 30 ? 0 : Math.round(40 * (1 - days / 30));
  return usage + freshness;
}

export function scoreToStars(score) {
  const filled = Math.round((score / 100) * 5);
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

// 查询：默认当前 cwd（按归一化 key 匹配）；all 跨全部目录。
// 返回按 skill 聚合的使用统计 + 健康分，倒序（分高在前）。
export async function skillStats({ all = false, limit = 50 } = {}) {
  const files = all
    ? (await fsp.readdir(SKILLS_DIR).catch(() => [])).filter((f) => f.endsWith('.jsonl')).map((f) => join(SKILLS_DIR, f))
    : [skillsFileFor(process.cwd()).file];
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
  const scoped = all
    ? out
    : out.filter((r) => typeof r.cwd === 'string' && skillsFileFor(r.cwd).key === cwdScope());

  const agg = new Map();
  for (const r of scoped) {
    if (typeof r.skill !== 'string' || !r.ts) continue;
    const cur = agg.get(r.skill) ?? { skill: r.skill, count: 0, lastUsed: '' };
    cur.count += 1;
    if (r.ts > cur.lastUsed) cur.lastUsed = r.ts;
    agg.set(r.skill, cur);
  }
  const maxCount = Math.max(0, ...Array.from(agg.values()).map((s) => s.count));
  const now = Date.now();
  const rows = Array.from(agg.values()).map((s) => {
    const score = healthScore(s.count, s.lastUsed, maxCount, now);
    return { ...s, score, stars: scoreToStars(score) };
  }).sort((a, b) => b.score - a.score || b.count - a.count);
  return rows.slice(0, limit);
}

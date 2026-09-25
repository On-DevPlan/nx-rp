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

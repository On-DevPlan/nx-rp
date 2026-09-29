// loop 业务：自引用循环（Ralph 技术）——Stop hook 拦截会话退出，把同一条
// prompt 灌回去，直到出现 <promise>X</promise>（X == 预设完成短语）或迭代超限。
//
// 与官方 ralph-loop 插件的差异：
//   1. Node 实现，不依赖 jq/perl/awk/sed（Windows 上不必绕 WSL bash 的坑）
//   2. 状态是**数组**，按 cwd 分文件存放 → 同一项目可多会话并行，互不干扰
//   3. 开关写**项目级**配置（.claude/settings.local.json），不是全局——
//      只有配了 hook 的项目才会被拦截退出
//   4. 每轮判定写审计日志，Web 面板可看
//
// 铁律（对齐 hook-prompt/hook-skill）：stop 落点**永不抛错**、退出码恒 0。
// hook 协议里非零退出码会在 transcript 留错误记录，而且 Stop 钩子的失败会
// 直接卡住用户的会话——这里任何异常都必须降级为「放行」。
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDE_SETTINGS_PATH, SNAPSHOTS_DIR, LOOPS_DIR, loopsFileFor, loopsLogFileFor, cwdDir } from '../../core/paths.js';
import { appendOwnGroup, removeOwnGroups, toggleSettings, findOwnGroups, ownsGroup, readSettings } from '../../core/claude-settings.js';
import { readStdin, parseHookEvent, deriveSessionId } from '../../core/hook-io.js';
import { invalidInput } from '../../core/errors.js';

// 我们那条 hook entry 的指纹——on/off 靠 marker 在 hooks 数组里认亲。
const HOOK_COMMAND = 'nx-rp loop stop';
const MARKER = '__nx_rp_loop__';
const EVENT = 'Stop';

// transcript 尾部最多扫多少行 assistant 记录。够取到最近一条文本，又不会
// 把长会话的整个 transcript 读进内存。
const TRANSCRIPT_TAIL_LINES = 100;

// 单次读取的文件尾字节数上限：JSONL 一行可能很长（大 tool 结果），
// 100 行的上限在极端情况下按字节兜底。
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

// ─── hook 配置（项目级） ──────────────────────────────────────────────

function hookEntry() {
  return {
    // 不做 async：Stop hook 需要**同步拿到判决**才能决定放行还是继续。
    type: 'command',
    command: HOOK_COMMAND,
    timeout: 30, // 秒；读 transcript + 解析，给足余量
  };
}

// Stop 不吃 matcher——但结构仍是 事件 → matcher 组 → hook 列表，组要存在。
function spec() {
  return { event: EVENT, matcher: '', hook: hookEntry(), marker: MARKER };
}

function hasMarker(group) {
  return typeof group === 'object' && group !== null && group[MARKER] === true;
}

// 项目配置路径：默认本地级（个人、通常被 gitignore），--shared 才是入库的项目级。
// 为什么不默认写 settings.json：hook 命令引用的是**本机装的 nx-rp**，
// 对没装的同事毫无意义；而且快照/写入会污染仓库。
export function projectSettingsPath(scope = 'local', cwd = cwdDir()) {
  const dir = join(cwd, '.claude');
  return scope === 'shared' ? join(dir, 'settings.json') : join(dir, 'settings.local.json');
}

// 手动添加用的 JSON 片段（面板展示 + 复制）。与 hookOn 写盘的 entry **完全同源**。
export function manualSnippet() {
  return {
    hooks: {
      [EVENT]: [
        { matcher: '', hooks: [hookEntry()], [MARKER]: true },
      ],
    },
  };
}

// .gitignore 保护：写本地级配置时确保该文件被忽略。
// 返回 { added, path }——added=true 说明我们改了用户的 .gitignore，要如实告知。
async function ensureGitignored(cwd = cwdDir()) {
  const gi = join(cwd, '.gitignore');
  const line = '.claude/settings.local.json';
  let raw = '';
  try {
    raw = await fsp.readFile(gi, 'utf8');
  } catch { /* 不存在 → 下面创建 */ }
  // 已忽略的判定：逐行精确匹配（含带斜杠前缀的写法）
  const ignored = raw.split(/\r?\n/).some((l) => {
    const t = l.trim();
    return t === line || t === '/' + line || t === '.claude/settings.local.json';
  });
  if (ignored) return { added: false, path: gi };
  const next = raw && !raw.endsWith('\n') ? raw + '\n' : raw;
  await fsp.writeFile(gi, next + line + '\n', 'utf8');
  return { added: true, path: gi };
}

// ─── on / off / status ─────────────────────────────────────────────

export async function hookOn({ scope = 'local', dryRun = false, cwd = cwdDir() } = {}) {
  const settingsPath = projectSettingsPath(scope, cwd);
  const { changed, snapshot } = await toggleSettings(
    (next) => appendOwnGroup(next, spec()),
    {
      dryRun,
      settingsPath,
      // 项目级快照集中存放——不落进项目目录污染仓库
      snapshotDir: SNAPSHOTS_DIR,
    },
  );
  if (dryRun) {
    return { status: 'ok', dryRun: true, enabled: true, scope, skipped: !changed, settingsPath };
  }
  // 只有真写盘、且写的是本地级时，才动 .gitignore
  let gitignore = { added: false, path: null };
  if (changed && scope !== 'shared') {
    gitignore = await ensureGitignored(cwd).catch(() => ({ added: false, path: null }));
  }
  return {
    status: 'ok', enabled: true, scope, skipped: !changed, settingsPath, snapshot,
    gitignore,
    // 提示词模板与 on 一体返回：用户不必记 --completion-promise 的语法
    snippet: manualSnippet(),
  };
}

export async function hookOff({ dryRun = false, cwd = cwdDir() } = {}) {
  // 两个项目级文件都要摘——用户可能在作用域之间切过
  const targets = [projectSettingsPath('local', cwd), projectSettingsPath('shared', cwd)];
  const found = [];
  for (const p of targets) {
    let s;
    try {
      s = await readSettings(p);
    } catch {
      continue; // 坏文件跳过（off 是清理动作，不该被坏文件挡住）
    }
    const own = findOwnGroups(s, EVENT, MARKER, (g) => ownsGroup(g, MARKER, [HOOK_COMMAND]));
    if (own.length > 0) found.push(p);
  }
  if (found.length === 0) {
    return { status: 'ok', enabled: false, skipped: true, settingsPath: targets[0] };
  }
  if (dryRun) {
    return { status: 'ok', dryRun: true, enabled: false, settingsPath: found[0], removedFrom: found };
  }
  let lastSnapshot = null;
  for (const p of found) {
    const { snapshot } = await toggleSettings(
      (next) => removeOwnGroups(next, { event: EVENT, marker: MARKER, commands: [HOOK_COMMAND] }),
      { settingsPath: p, snapshotDir: SNAPSHOTS_DIR },
    );
    if (snapshot) lastSnapshot = snapshot;
  }
  return { status: 'ok', enabled: false, skipped: false, settingsPath: found[0], removedFrom: found, snapshot: lastSnapshot };
}

export async function hookStatus({ cwd = cwdDir() } = {}) {
  const localPath = projectSettingsPath('local', cwd);
  const sharedPath = projectSettingsPath('shared', cwd);
  const detail = {};
  let corrupt = false;
  let disableAllHooks = false;
  for (const [scope, p] of [['local', localPath], ['shared', sharedPath]]) {
    let s;
    try {
      s = await readSettings(p);
    } catch {
      corrupt = true;
      detail[scope] = { path: p, enabled: false, manualCount: 0, exists: existsSync(p), corrupt: true };
      continue;
    }
    if (s.disableAllHooks === true) disableAllHooks = true;
    const own = findOwnGroups(s, EVENT, MARKER, (g) => ownsGroup(g, MARKER, [HOOK_COMMAND]));
    detail[scope] = {
      path: p,
      exists: existsSync(p),
      enabled: own.length > 0,
      // 手工粘贴的无 marker 片段：>0 说明用户手动配过
      manualCount: own.filter((g) => !hasMarker(g)).length,
    };
  }
  const activeScope = detail.shared.enabled ? 'shared' : (detail.local.enabled ? 'local' : null);
  return {
    enabled: activeScope !== null,
    activeScope,
    detail,
    // 兼容面板/CLI 的单值读取（当前生效的那个项目级文件）
    settingsPath: activeScope === 'shared' ? sharedPath : localPath,
    globalSettingsPath: CLAUDE_SETTINGS_PATH,
    scopeCwd: cwd,
    // 面板布防表单的默认值：**本 nx-rp 进程**能看到的会话身份。
    //
    // 语义边界要说清：这里读的是服务进程的 env，不是浏览器的、也不是「用户此刻
    // 正在用的那个会话」——serve 若从普通终端启动，这里是 null。所以面板拿到 null
    // 时不能假装知道，必须提示用户显式填 sessionId（否则布防出来的循环
    // Stop hook 永远认领不到，表现为「布防了但一直不动」）。
    currentSessionId: process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null,
    disableAllHooks,
    corrupt,
    snippet: manualSnippet(),
  };
}

// ─── 状态读写（原子写，学 core/store.js） ────────────────────────────

async function readState(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return { version: 1, loops: [] };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.loops)) return { version: 1, loops: [] };
    return { version: data.version ?? 1, loops: data.loops };
  } catch {
    return { version: 1, loops: [] }; // 损坏时降级为空——读路径绝不抛
  }
}

async function writeState(file, data) {
  await fsp.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// ─── 跨进程锁（Stop hook 每次都是全新进程） ──────────────────────────
//
// 状态文件按 cwd 聚合、多会话共享，读-改-写必须串行。O_EXCL 创建锁文件：
//   创建成功 → 持锁，返回 release()
//   已存在且新鲜（< STALE_MS）→ 判定并发，返回 null（调用方放行）
//   已存在但陈旧（进程被杀留下的）→ 夺锁重试一次
const LOCK_STALE_MS = 5000;

export async function acquireLock(targetFile) {
  const lock = `${targetFile}.lock`;
  await fsp.mkdir(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fsp.open(lock, 'wx');
      await fh.writeFile(String(process.pid), 'utf8');
      await fh.close();
      return async () => { await fsp.rm(lock, { force: true }).catch(() => {}); };
    } catch (e) {
      if (e?.code !== 'EEXIST') return null; // 其它错误（权限等）→ 不冒险，放行
      let stale = false;
      try {
        const st = await fsp.stat(lock);
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true; // stat 都失败了说明锁已不在，重试
      }
      if (!stale) return null;   // 新鲜锁 → 并发中，放行
      await fsp.rm(lock, { force: true }).catch(() => {}); // 陈旧锁 → 清掉重试
    }
  }
  return null;
}

// ─── start / list ──────────────────────────────────────────────────

export async function startLoop({
  prompt, maxIterations = 20, completionPromise = null, cwd = cwdDir(), sessionId = null,
} = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    const e = new Error('缺少 prompt——loop 需要一条要反复执行的任务描述');
    e.code = 'INVALID_INPUT';
    throw e;
  }
  // 0 = 无限（与 ralph 的 max_iterations:0 语义一致，也便于 CLI 显式表达）。
  // 只有「没给值 / 给了非数字」才回落默认 20。
  const n = Math.floor(Number(maxIterations));
  const max = maxIterations === undefined || maxIterations === null || !Number.isFinite(n) ? 20 : Math.max(0, n);
  const { file } = loopsFileFor(cwd) || {};
  if (!file) throw new Error('无法确定 loop 状态文件路径（paths 不可用）');

  // 会话身份是硬要求：Stop hook 触发时靠它认领循环，没有身份的循环永远不会被触发
  // （用户看到的就是「布防了但一直不动」）。宁可在这里明确报错，也不静默建一条死记录。
  const claudeSessionId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
  if (!sessionId && !claudeSessionId) {
    throw invalidInput(
      '拿不到会话身份，无法布防——Stop hook 靠它认领循环，没有身份的循环永远不会被触发。\n' +
      '解决：显式传 --session-id <ID>（查看当前会话 ID：在 Claude Code 里跑 claude --resume 列表，或读环境变量 CLAUDE_CODE_SESSION_ID）',
    );
  }

  const state = await readState(file);
  // id 取当前最大值 +1，避免删除后重号
  const nextId = state.loops.reduce((m, l) => Math.max(m, Number(String(l.id).replace(/\D/g, '')) || 0), 0) + 1;
  const id = `loop-${nextId}`;
  const now = new Date().toISOString();
  const rec = {
    id,
    active: true,
    iteration: 1,
    maxIterations: max,
    completionPromise: completionPromise || null,
    prompt,
    // 双保险：payload 的 session_id 最可靠；缺了就用启动时的环境变量兜底
    sessionId: sessionId || null,
    claudeSessionId,
    cwd,
    startedAt: now,
    lastFiredAt: null,
  };
  state.loops.push(rec);
  await writeState(file, state);
  return { status: 'ok', id, file, loop: rec };
}

export async function listLoops({ all = false, limit = 50, cwd = cwdDir() } = {}) {  if (all) {
    let files;
    try {
      files = (await fsp.readdir(LOOPS_DIR)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const st = await readState(join(LOOPS_DIR, f));
      out.push(...st.loops);
    }
    return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
  }
  const { file } = loopsFileFor(cwd) || {};
  if (!file) return [];
  const st = await readState(file);
  return st.loops.slice(-limit).reverse();
}

// 取消：标记 inactive 而不删记录（保留可查历史，等价于 ralph 的 /cancel-ralph）。
// 不传 id 时取消该 cwd 下**全部**活跃的——面板「停用」按钮的语义。
export async function cancelLoop({ id = null, cwd = cwdDir() } = {}) {
  const { file } = loopsFileFor(cwd) || {};
  if (!file) return { status: 'ok', cancelled: 0 };
  const state = await readState(file);
  let n = 0;
  const now = new Date().toISOString();
  for (const l of state.loops) {
    if (l.active === false) continue;
    if (id && l.id !== id) continue;
    l.active = false;
    l.endReason = 'cancelled';
    l.endedAt = now;
    n++;
  }
  if (n > 0) await writeState(file, state);
  return { status: 'ok', cancelled: n };
}

// 改一条循环的任务参数。**为「动态规划」而设**：循环跑起来目标会变——
// 放宽轮次上限让它继续、改 prompt 调方向、换完成短语。
//
// 重新激活的语义（关键）：
//   若之前是**因到上限而停**（endReason === 'max-iterations'），提高上限时自动
//   复活——这正是「再给它 20 轮」的自然表达。
//   手工 cancel 过的不复活：那是用户的显式停止意图，要恢复须重新布防。
//   没改上限的不复活（避免只是改个 prompt 就把已停的循环意外拉起来）。
export async function updateLoop({ id, prompt, maxIterations, completionPromise, sessionId, cwd = cwdDir() } = {}) {
  const { file } = loopsFileFor(cwd) || {};
  if (!file) throw invalidInput('无法确定 loop 状态文件路径（paths 不可用）');
  if (!id) throw invalidInput('缺少 id——要改哪一条循环');

  const state = await readState(file);
  const loop = state.loops.find((l) => l.id === id);
  if (!loop) {
    const ids = state.loops.map((l) => l.id);
    throw invalidInput(`未找到循环: ${id}${ids.length ? `（当前目录有: ${ids.join(', ')}）` : ''}`);
  }

  const changed = [];
  // 改绑会话：布防时绑错了（比如绑到了运行 nx-rp 的那个进程的会话）时的补救。
  // 传空串 = 清掉显式绑定，退回只用 claudeSessionId。
  if (sessionId !== undefined) {
    const next = sessionId ? String(sessionId) : null;
    if (next !== loop.sessionId) { loop.sessionId = next; changed.push('sessionId'); }
  }
  if (typeof prompt === 'string' && prompt.trim() && prompt !== loop.prompt) {
    loop.prompt = prompt;
    changed.push('prompt');
  }
  if (completionPromise !== undefined) {
    // 显式传空串/ null = 清掉承诺词
    const next = completionPromise ? String(completionPromise) : null;
    if (next !== loop.completionPromise) { loop.completionPromise = next; changed.push('completionPromise'); }
  }
  let reactivated = false;
  if (maxIterations !== undefined && maxIterations !== null) {
    const n = Math.floor(Number(maxIterations));
    if (!Number.isFinite(n)) throw invalidInput(`maxIterations 必须是数字，收到 ${JSON.stringify(maxIterations)}`);
    const next = Math.max(0, n);
    if (next !== loop.maxIterations) {
      loop.maxIterations = next;
      changed.push('maxIterations');
      // 到上限停下的：提高上限即复活（0 = 无限也算提高）
      const raised = next === 0 || next > Number(loop.iteration);
      if (loop.active === false && loop.endReason === 'max-iterations' && raised) {
        loop.active = true;
        delete loop.endReason;
        delete loop.endedAt;
        reactivated = true;
      }
    }
  }
  if (!changed.length) return { status: 'ok', skipped: true, id, loop };
  await writeState(file, state);
  return { status: 'ok', id, changed, reactivated, loop };
}

// 真删记录（区别于 cancel 的「标记结束、记录留着」）。
// 面板上 cancel 之后记录会越堆越长，需要一个能清掉的出口。
// 默认只允许删**已结束**的：删活跃循环属于误操作，要求先 cancel
// （force: true 可越权，留给 CLI 的显式场景）。
export async function removeLoop({ id, force = false, cwd = cwdDir() } = {}) {
  const { file } = loopsFileFor(cwd) || {};
  if (!file) return { status: 'ok', removed: 0 };
  const state = await readState(file);
  const target = state.loops.find((l) => l.id === id);
  if (!target) throw invalidInput(`未找到循环: ${id}`);
  if (target.active !== false && !force) {
    throw invalidInput(`循环 ${id} 还在运行——先「取消」再删除（或 CLI 加 --force）`);
  }
  state.loops = state.loops.filter((l) => l.id !== id);
  await writeState(file, state);
  return { status: 'ok', removed: 1, id };
}

// ─── Stop hook：transcript 解析 ─────────────────────────────────────

// 文件尾流式读取：只读最后 N 字节，避免整体读入超大 transcript。
// 返回行数组（可能首行被截断——调用方按 JSON.parse 失败自然跳过）。
export async function readTailLines(file, { maxBytes = TRANSCRIPT_TAIL_BYTES } = {}) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
  } catch {
    return null; // 文件不存在 / 打不开 → 由调用方降级
  }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    // 从中间截断时首行是半个 JSON，丢掉（除非恰好从 0 开始）。
    // 注意：若整块里没有换行，说明是同一行的尾部——那是半截，同样丢。
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    await fh.close().catch(() => {});
  }
}

// 取「最后一条 assistant 文本」。Claude Code 把每个 content block 各写一行
// JSONL（都带 role=assistant），所以要取最后一行**含 text block** 的。
//
// 两个刻意的取舍（对齐 ralph 的 jq `last // ""` 语义）：
//   · 同一行内取**最后一个** text block
//   · 该行有 text block 但文本为空串时返回空串，**不继续往前找**——
//     继续找会把上一轮遗留的 <promise> 翻出来，造成提前误判完成。
export async function readLastAssistantText(transcriptPath, { maxLines = TRANSCRIPT_TAIL_LINES } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const lines = await readTailLines(transcriptPath);
  if (!lines || lines.length === 0) return null;
  const tail = lines.slice(-maxLines);
  let seen = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    // 便宜的前置过滤：先看无空格的常见形态，再容忍带空格的序列化
    if (!line.includes('"role":"assistant"') &&
        !(/^\s*\{/.test(line) && /"role"\s*:\s*"assistant"/.test(line))) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 半截/坏行跳过
    }
    if (obj?.type && obj.type !== 'assistant') continue;
    // 子 agent 的回复不算主 agent 的完成信号（ralph 无此层，是刻意的加固）
    if (obj?.isSidechain === true) continue;
    if (obj?.message?.role !== 'assistant' && obj?.role !== 'assistant') continue;
    if (++seen > maxLines) break;
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b?.type === 'text') return typeof b.text === 'string' ? b.text : '';
    }
    // 该行全是 tool_use：无文本，继续往前找
  }
  return null;
}

// <promise>X</promise> 提取：非贪婪取**首个** tag（与 ralph 的 perl .*? 等价），
// 内部空白归一成单空格、首尾去空白。没有 tag 返回 null。
export function extractPromise(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = /<promise>([\s\S]*?)<\/promise>/.exec(text);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim();
}

// ─── Stop hook：主判定 ──────────────────────────────────────────────

// 从原始 payload 抢救 transcript_path：core/hook-io 的 salvageFields 只认
// session_id/cwd（不为 loop 单独扩它的键清单——那会动到两个日志 hook 的共享行为）。
// 坏 JSON 时 transcript 路径丢了会导致「永远解析不到 promise → 无限循环」，
// 所以这里自己补一次提取。
function salvageTranscriptPath(raw) {
  if (typeof raw !== 'string') return null;
  const m = /"transcript_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

// 按 sessionId 选属于本会话的 loop。
//
// 语义：**只用「本次事件声明的会话」去比对两个字段**，绝不回落到本进程的 env。
//   - payload 给了 session_id → 就是它（权威）
//   - payload 没给（异常 payload）→ 才退化用 env
//   sid 确定后，同时比对 loop.sessionId 与 loop.claudeSessionId：前者是用户
//   显式 --session-id 传的，后者是启动时从 env 兜底存的，两者都是「这个会话」的
//   等价标识。
//
// 为什么不能「payload 不中就再用 env 兜一次」：Stop hook 进程的 env 与 payload
// 指的是同一个会话，那次兜底要么冗余、要么在 env 与 payload 不一致时把
// **别的会话的 loop** 认领过来——多实例隔离（本模块相对 ralph 的核心增量）就此失效。
//
// 刻意**没有**「无名候选收养」回退：startLoop 已拒绝创建无身份的循环（见那里），
// 所以正常情况下不存在无名 loop。留一条收养路径只会给「身份匹配失败」提供一个
// 静默兜底，掩盖真正的会话归属 bug（早期版本就有，已删）。
// 旧版本遗留的无名记录一律不匹配 → 放行，面板上标「无会话（旧数据）」。
export function pickLoop(loops, payloadSessionId, envSessionId) {
  const actives = (loops || []).filter((l) => l && l.active !== false);
  if (!actives.length) return null;
  const sid = payloadSessionId || envSessionId || null;
  if (!sid) return null;
  return actives.find((l) => l.sessionId === sid || l.claudeSessionId === sid) || null;
}

// 写审计日志（失败静默——审计不该影响判决）
async function audit(cwd, entry) {
  const target = loopsLogFileFor(cwd);
  if (!target?.file) return;
  try {
    await fsp.mkdir(dirname(target.file), { recursive: true });
    await fsp.appendFile(target.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 静默 */ }
}

// Stop hook 主逻辑。永不抛错——任何异常都降级为放行（返回 null）。
// 返回 null 表示「不输出任何东西，放行退出」。
export async function stopHookRaw(raw) {
  try {
    return await stopHookInner(raw);
  } catch {
    return null;
  }
}

async function stopHookInner(raw) {
  const event = parseHookEvent(raw);
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : cwdDir();
  const sessionId = deriveSessionId(event, cwd);

  // 事件名有值但不是 Stop → 本 hook 被挂错了事件，放行（防御性）
  if (event.hook_event_name && event.hook_event_name !== 'Stop' && event.hook_event_name !== 'SubagentStop') {
    return null;
  }

  const target = loopsFileFor(cwd);
  if (!target?.file) return null;

  // 状态文件是**多会话共享**的（按 cwd 聚合），读-改-写要串行。
  // 抢不到锁就放行：并发的那个进程自己会 block，reason 不会被漏掉；
  // 反过来两边都 block 会把同一条 prompt 灌两次。
  const release = await acquireLock(target.file);
  if (!release) return null;
  try {
    const state = await readState(target.file);
    if (!state.loops.length) return null; // 分支 1：无 loop

    const payloadSession = event?.session_id || event?.sessionId || null;
    const envSession = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
    const loop = pickLoop(state.loops, payloadSession, envSession);
    if (!loop) return null; // 分支 2：不属于本会话（不写审计，免得别的会话刷满日志）
    // 收养回填：无标识的 loop 被本次事件认领后，记下会话——后续轮次不必再靠
    // 「唯一候选」判定，也便于面板看出它归属哪个会话。
    if (!loop.sessionId && payloadSession) loop.sessionId = payloadSession;

    // 分支 3：迭代超限
    const max = Number(loop.maxIterations) || 0;
    if (max > 0 && Number(loop.iteration) >= max) {
      loop.active = false;
      loop.endReason = 'max-iterations';
      loop.endedAt = new Date().toISOString();
      loop.lastFiredAt = loop.endedAt;
      await writeState(target.file, state);
      await audit(cwd, { loopId: loop.id, iteration: loop.iteration, decision: 'max-iterations', sessionId });
      return { systemMessage: `🛑 Loop ${loop.id}: 已达上限 ${max} 轮，循环停止。` };
    }

    // 提取最后一条 assistant 文本 → 找 promise。
    // transcript_path 优先取解析后的字段，坏了再从原始 payload 抢救。
    const transcriptPath = (typeof event.transcript_path === 'string' && event.transcript_path)
      || salvageTranscriptPath(raw);
    const text = await readLastAssistantText(transcriptPath);
    const promise = extractPromise(text);
    const expected = loop.completionPromise;

    // 分支 4：promise 命中（字面量精确匹配，与 ralph 的 `=` 比较一致，承诺词里的
    // 正则元字符保持字面量；promise 未设时永不判定完成，只能靠 max-iterations 收口）
    if (expected && promise !== null && promise === expected) {
      loop.active = false;
      loop.endReason = 'promise';
      loop.endedAt = new Date().toISOString();
      loop.lastFiredAt = loop.endedAt;
      await writeState(target.file, state);
      await audit(cwd, { loopId: loop.id, iteration: loop.iteration, decision: 'promise-hit', promise, sessionId });
      return { systemMessage: `✅ Loop ${loop.id}: 检测到 <promise>${expected}</promise>，循环完成。` };
    }

    // 分支 5：未命中 → 迭代 +1 并把同一条 prompt 灌回去
    const next = Number(loop.iteration) + 1;
    loop.iteration = next;
    loop.lastFiredAt = new Date().toISOString();
    await writeState(target.file, state);

    // promise 的提示语（无 promise 时明确告知「只能靠上限收口」）
    const hint = expected
      ? `完成时输出 <promise>${expected}</promise>（仅在确实为真时——不要为了退出而说谎）`
      : '未设完成承诺，循环只能靠轮次上限收口';
    await audit(cwd, {
      loopId: loop.id, iteration: next, decision: 'continue', promise,
      // 记录文本摘要：面板上一眼看出 transcript 解析是否正常（解析失效时这里是 null）
      lastText: text === null ? null : text.replace(/\s+/g, ' ').slice(0, 200),
      lastTextChars: text === null ? null : text.length,
      sessionId,
    });
    return {
      decision: 'block',
      reason: loop.prompt,
      systemMessage: `🔄 Loop ${loop.id} 第 ${next}/${max > 0 ? max : '∞'} 轮 | ${hint}`,
    };
  } finally {
    await release();
  }
}

export async function stopHookFromStdin() {
  const raw = await readStdin();
  return stopHookRaw(raw);
}

// ─── 审计日志查询 ───────────────────────────────────────────────────

export async function listLoopLog({ all = false, limit = 50, cwd = cwdDir() } = {}) {
  const readOne = async (file) => {
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
  };
  if (all) {
    let files;
    try {
      files = (await fsp.readdir(LOOPS_DIR)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const all2 = [];
    for (const f of files) {
      all2.push(...(await readOne(join(LOOPS_DIR, f))));
    }
    return all2.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }
  const target = loopsLogFileFor(cwd);
  if (!target?.file) return [];
  const rows = await readOne(target.file);
  return rows.slice(-limit).reverse();
}

export { EVENT, MARKER, HOOK_COMMAND };

// loop 模块单测：Stop hook 判决六分支、transcript 解析的畸形输入、项目级开关的
// 外科手术性与隔离、promise 精确匹配。
//
// 路径隔离：loopsDir / snapshotsDir / settings 全部重定向到临时目录
// （paths.setHookPaths），且项目配置用显式 cwd=tmp 传入——绝不碰真实的
// ~/.claude/、~/.nx-rp/loops，也不碰本仓库的 .claude/。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
let loopsDir;
let snapshotsDir;

const pathsMod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
const serviceUrl = () => pathToFileURL(join(ROOT, 'src', 'modules', 'loop', 'service.js')).href;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-loop-'));
  loopsDir = join(tmp, 'loops');
  snapshotsDir = join(tmp, 'snapshots');
  pathsMod.setHookPaths({
    settingsPath: join(tmp, 'global-settings.json'),
    promptsDir: join(tmp, 'prompts'),
    skillsDir: join(tmp, 'skills'),
    loopsDir,
    snapshotsDir,
  });
});

afterEach(async () => {
  pathsMod.setHookPaths({
    settingsPath: join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json'),
    promptsDir: join(pathsMod.APP_DIR, 'prompts'),
    skillsDir: join(pathsMod.APP_DIR, 'skills'),
    loopsDir: join(pathsMod.APP_DIR, 'loops'),
    snapshotsDir: join(pathsMod.APP_DIR, 'snapshots'),
  });
  await rm(tmp, { recursive: true, force: true });
});

// 写一个 transcript fixture（JSONL）。entries 是对象数组，逐行序列化。
async function writeTranscript(name, entries) {
  const p = join(tmp, name);
  await writeFile(p, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n', 'utf8');
  return p;
}

// 一条 assistant 消息的 JSONL 行（Claude Code 的形态：message.content[] 块数组）
function assistantLine(text, extra = {}) {
  return { type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

// 带上下文 cwd 的 Stop 事件 payload
function stopEvent({ cwd, transcriptPath, sessionId = 'S1' }) {
  return JSON.stringify({
    hook_event_name: 'Stop',
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    stop_hook_active: false,
  });
}

// ─── extractPromise ────────────────────────────────────────────────

test('extractPromise：正常 / 空白归一 / 多标签取首个 / 无标签返回 null', async () => {
  const { extractPromise } = await import(serviceUrl());
  assert.equal(extractPromise('done <promise>COMPLETE</promise> ok'), 'COMPLETE');
  assert.equal(extractPromise('<promise>  DONE  \n now </promise>'), 'DONE now');
  assert.equal(extractPromise('<promise>A</promise><promise>B</promise>'), 'A', '非贪婪取第一个');
  assert.equal(extractPromise('no tag here'), null);
  assert.equal(extractPromise(''), null);
  assert.equal(extractPromise(null), null);
  // 修掉 ralph 的 perl 缺陷：全文恰好等于承诺词但无标签 → 不是完成
  assert.equal(extractPromise('COMPLETE'), null, '无标签时绝不能把全文当成承诺词');
  // 顺序颠倒的标签不算
  assert.equal(extractPromise('</promise>X<promise>'), null);
});

test('extractPromise：承诺词里的正则元字符保持字面量', async () => {
  const { extractPromise } = await import(serviceUrl());
  assert.equal(extractPromise('<promise>DONE*</promise>'), 'DONE*');
  assert.equal(extractPromise('<promise>[x]</promise>'), '[x]');
  assert.equal(extractPromise('<promise>a+b</promise>'), 'a+b');
});

// ─── readLastAssistantText / readTailLines ─────────────────────────

test('readLastAssistantText：取最后一条 assistant 的文本块', async () => {
  const { readLastAssistantText } = await import(serviceUrl());
  const p = await writeTranscript('t1.jsonl', [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    assistantLine('第一轮'),
    assistantLine('第二轮 <promise>DONE</promise>'),
  ]);
  assert.equal(await readLastAssistantText(p), '第二轮 <promise>DONE</promise>');
});

test('readLastAssistantText：同一行取最后一个 text block（对齐 jq 的 last）', async () => {
  const { readLastAssistantText } = await import(serviceUrl());
  const p = await writeTranscript('t2.jsonl', [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: '前面的' },
      { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
      { type: 'text', text: '后面的' },
    ] } },
  ]);
  assert.equal(await readLastAssistantText(p), '后面的');
});

test('readLastAssistantText：全是 tool_use 的行跳过，继续往前找', async () => {
  const { readLastAssistantText } = await import(serviceUrl());
  const p = await writeTranscript('t3.jsonl', [
    assistantLine('有文本的一行'),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } },
  ]);
  assert.equal(await readLastAssistantText(p), '有文本的一行');
});

test('readLastAssistantText：空文本块不往前翻（防翻出上一轮的旧 promise）', async () => {
  const { readLastAssistantText } = await import(serviceUrl());
  const p = await writeTranscript('t4.jsonl', [
    assistantLine('上一轮 <promise>DONE</promise>'),
    assistantLine(''),   // 最新一行是空文本
  ]);
  assert.equal(await readLastAssistantText(p), '', '必须返回空串，不能回退取到旧 promise');
});

test('readLastAssistantText：跳过 isSidechain（子 agent 的回复不算完成信号）', async () => {
  const { readLastAssistantText } = await import(serviceUrl());
  const p = await writeTranscript('t5.jsonl', [
    assistantLine('主 agent 的文本'),
    assistantLine('子 agent 说 <promise>DONE</promise>', { isSidechain: true }),
  ]);
  assert.equal(await readLastAssistantText(p), '主 agent 的文本');
});

test('readLastAssistantText：坏行 / 非 assistant 行 / 不存在文件 全部安全降级', async () => {
  const { readLastAssistantText } = await import(serviceUrl());
  const p = await writeTranscript('t6.jsonl', [
    assistantLine('有效的一行'),
    '{ 这行 JSON 坏了',
    '',
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'u' }] } },
  ]);
  assert.equal(await readLastAssistantText(p), '有效的一行');
  assert.equal(await readLastAssistantText(join(tmp, 'nope.jsonl')), null);
  assert.equal(await readLastAssistantText(''), null);
  assert.equal(await readLastAssistantText(null), null);
});

test('readLastAssistantText：content 是字符串而非数组时不崩', async () => {
  const { readLastAssistantText } = await import(serviceUrl());
  const p = await writeTranscript('t7.jsonl', [
    assistantLine('好的'),
    { type: 'assistant', message: { role: 'assistant', content: '纯字符串' } },
  ]);
  assert.equal(await readLastAssistantText(p), '好的');
});

test('readTailLines：尾部截断时丢掉半截首行，仍能取到最新文本', async () => {
  const { readTailLines, readLastAssistantText } = await import(serviceUrl());
  // 造一个较大的文件：先塞很多行填充，最后放目标行
  const filler = Array.from({ length: 400 }, (_, i) => ({ type: 'user', message: { role: 'user', content: `填充 ${i}` } }));
  const p = await writeTranscript('t8.jsonl', [...filler, assistantLine('尾巴上的目标 <promise>DONE</promise>')]);
  const lines = await readTailLines(p, { maxBytes: 2048 });
  assert.ok(lines.length > 0, '有尾部行');
  // 首行可能被截断——不该出现「半个 JSON 被当成有效行」导致整体崩溃
  assert.equal(await readLastAssistantText(p), '尾巴上的目标 <promise>DONE</promise>');
});

// ─── pickLoop ──────────────────────────────────────────────────────

test('pickLoop：用事件声明的会话比对两个字段 / payload 缺失才用 env', async () => {
  const { pickLoop } = await import(serviceUrl());
  const loops = [{ id: 'a', sessionId: 'S1' }, { id: 'b', sessionId: null, claudeSessionId: 'E2' }];
  assert.equal(pickLoop(loops, 'S1', null)?.id, 'a', '显式 sessionId 命中');
  assert.equal(pickLoop(loops, 'E2', null)?.id, 'b', 'claudeSessionId 同样是本会话的等价标识');
  assert.equal(pickLoop(loops, null, 'E2')?.id, 'b', 'payload 缺失时才用 hook 进程的 env');
  assert.equal(pickLoop(loops, 'SX', 'E2'), null, 'payload 给了就不拿 env 二次兜底');
  assert.equal(pickLoop(loops, 'SX', 'EX'), null);
  assert.equal(pickLoop(loops, null, null), null, '两边都没有 → 无法判定归属');
  assert.equal(pickLoop([{ id: 'a', sessionId: 'S1', active: false }], 'S1', null), null, 'inactive 不参与');
  assert.equal(pickLoop([], 'S1', null), null);
  assert.equal(pickLoop(null, 'S1', null), null);
});

test('pickLoop：payload 有 session 时不走 env 兜底（守住多实例隔离）', async () => {
  const { pickLoop } = await import(serviceUrl());
  // 关键回归位：启动 loop 的进程会把同一个 env session 写进多条 loop 的
  // claudeSessionId。若 payload 已给 session 还去匹配「本进程的 env」,
  // 别的会话的 loop 会被认领过来——多实例隔离（本模块相对 ralph 的核心增量）失效。
  const loops = [{ id: 'a', sessionId: 'OTHER', claudeSessionId: 'ENV1' }];
  assert.equal(pickLoop(loops, 'MINE', 'ENV1'), null, 'payload 优先，不得回落到 env');
  assert.equal(pickLoop(loops, 'OTHER', 'ENV1')?.id, 'a', '精确命中仍然有效');
  assert.equal(pickLoop(loops, null, 'ENV1')?.id, 'a', 'payload 缺失时才轮到 env');
});

test('startLoop：拿不到任何会话身份 → 抛 INVALID_INPUT（匿名循环不该存在）', async () => {
  const { startLoop } = await import(serviceUrl());
  const saved = process.env.CLAUDE_CODE_SESSION_ID;
  const savedAlt = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  try {
    const cwd = join(tmp, 'proj');
    await assert.rejects(
      () => startLoop({ prompt: '任务', completionPromise: 'DONE', maxIterations: 5, cwd }),
      (e) => {
        assert.equal(e.code, 'INVALID_INPUT');
        assert.match(e.message, /拿不到会话身份/);
        assert.match(e.message, /--session-id/, '错误信息要给出解法');
        return true;
      },
    );
    // 显式 --session-id 时不受 env 缺失影响
    const r = await startLoop({ prompt: '任务', sessionId: 'EXPLICIT-1', cwd });
    assert.equal(r.loop.sessionId, 'EXPLICIT-1');
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CODE_SESSION_ID = saved;
    if (savedAlt !== undefined) process.env.CLAUDE_SESSION_ID = savedAlt;
  }
});

test('Stop hook：旧版遗留的无名 loop 不被认领（收养回退已删，不再有静默兜底）', async () => {
  const { stopHookRaw, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  // 直接手写一条「旧版本才会产生」的无名记录：两个会话字段都为空
  const { file } = pathsMod.loopsFileFor(cwd);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1,
    loops: [{
      id: 'loop-old', active: true, iteration: 1, maxIterations: 5,
      completionPromise: 'DONE', prompt: '旧数据', sessionId: null, claudeSessionId: null,
      cwd, startedAt: new Date().toISOString(), lastFiredAt: null,
    }],
  }, null, 2), 'utf8');

  const p = await writeTranscript('named.jsonl', [assistantLine('做完了 <promise>DONE</promise>')]);
  // 旧版这里会把这条无名记录「收养」给当前会话并判完成；现在必须放行、不碰它
  const out = await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  assert.equal(out, null, '无名旧记录不该被认领（否则会掩盖真正的会话归属 bug）');
  const [l] = await listLoops({ cwd });
  assert.equal(l.sessionId, null, '不该被回填 sessionId');
  assert.equal(l.active, true, '不该被改动');
});

test('pickLoop：无 sid 时返回 null（不再靠唯一候选兜底）', async () => {
  const { pickLoop } = await import(serviceUrl());
  assert.equal(pickLoop([{ id: 'a', active: true }], null, null), null, '两个 sid 都空 → 放行');
  assert.equal(pickLoop([{ id: 'a', active: true }], 'S1', null), null, '无名 loop 不被 sid=S1 认领');
  assert.equal(pickLoop([{ id: 'a', active: true, sessionId: 'S1' }], 'S1', null)?.id, 'a');
});

// ─── Stop hook 六分支 ──────────────────────────────────────────────

test('分支 1：无 loop → 放行（返回 null，不输出任何判定）', async () => {
  const { stopHookRaw } = await import(serviceUrl());
  const p = await writeTranscript('e1.jsonl', [assistantLine('x')]);
  assert.equal(await stopHookRaw(stopEvent({ cwd: join(tmp, 'proj'), transcriptPath: p, sessionId: 'S1' })), null);
});

test('分支 2：session 不匹配 → 放行，且不改状态文件', async () => {
  const { startLoop, stopHookRaw } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', sessionId: 'OTHER', cwd });
  const p = await writeTranscript('e2.jsonl', [assistantLine('随便')]);
  assert.equal(await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'MINE' })), null);
});

test('分支 3：迭代超限 → 停止循环并返回 systemMessage', async () => {
  const { startLoop, stopHookRaw, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', maxIterations: 1, sessionId: 'S1', cwd });
  const p = await writeTranscript('e3.jsonl', [assistantLine('还没完')]);
  const out = await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  assert.ok(out.systemMessage.includes('上限'), '应提示到达上限: ' + JSON.stringify(out));
  assert.equal(out.decision, undefined, '超限时不应 block');
  const [l] = await listLoops({ cwd });
  assert.equal(l.active, false);
  assert.equal(l.endReason, 'max-iterations');
});

test('分支 4：promise 命中 → 停止循环（字面量精确匹配）', async () => {
  const { startLoop, stopHookRaw, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', completionPromise: 'DONE', maxIterations: 5, sessionId: 'S1', cwd });
  const p = await writeTranscript('e4.jsonl', [assistantLine('做完了 <promise>DONE</promise>')]);
  const out = await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  assert.ok(out.systemMessage.includes('完成'), JSON.stringify(out));
  assert.equal(out.decision, undefined);
  const [l] = await listLoops({ cwd });
  assert.equal(l.active, false);
  assert.equal(l.endReason, 'promise');
});

test('分支 4b：promise 大小写/前后缀不同 → 不算命中', async () => {
  const { startLoop, stopHookRaw } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', completionPromise: 'DONE', maxIterations: 5, sessionId: 'S1', cwd });
  const p = await writeTranscript('e4b.jsonl', [assistantLine('done <promise>done</promise>')]);
  const out = await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  assert.equal(out.decision, 'block', '大小写不同不应命中');
});

test('分支 5：未命中 → block 且 reason 严格等于 prompt 原文', async () => {
  const { startLoop, stopHookRaw, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  const prompt = '把测试补到全绿。\n注意保持风格一致。';
  await startLoop({ prompt, completionPromise: 'DONE', maxIterations: 5, sessionId: 'S1', cwd });
  const p = await writeTranscript('e5.jsonl', [assistantLine('我正在做，还没完成')]);
  const out = await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, prompt, 'reason 必须是 prompt 原文（稳定前缀，利于 KV cache）');
  assert.ok(out.systemMessage.includes('2/5'), '提示语带 +1 后的轮次: ' + out.systemMessage);
  const [l] = await listLoops({ cwd });
  assert.equal(l.iteration, 2, '未命中时迭代 +1');
  assert.equal(l.active, true);
});

test('分支 5b：未设 promise 时永不判定完成（只能靠上限收口）', async () => {
  const { startLoop, stopHookRaw } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', completionPromise: null, maxIterations: 3, sessionId: 'S1', cwd });
  const p = await writeTranscript('e5b.jsonl', [assistantLine('<promise>任意</promise>')]);
  const out = await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  assert.equal(out.decision, 'block', '无承诺词时任何 promise 都不算完成');
  assert.ok(out.systemMessage.includes('未设完成承诺'), out.systemMessage);
});

test('分支 6：transcript 不可读 → 降级放行但**保持 active**（不终结循环）', async () => {
  const { startLoop, stopHookRaw, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', completionPromise: 'DONE', maxIterations: 5, sessionId: 'S1', cwd });
  // transcript 路径指向不存在的文件 → 解析不到文本 → 仍走 block（未命中）
  const out = await stopHookRaw(stopEvent({ cwd, transcriptPath: join(tmp, 'ghost.jsonl'), sessionId: 'S1' }));
  assert.equal(out.decision, 'block', '读不到 transcript 不等于完成，应继续循环');
  const [l] = await listLoops({ cwd });
  assert.equal(l.active, true, '循环必须保持 active——ralph 在这里会 rm 状态文件，我们不');
});

test('协议纪律：坏输入 / 非对象 / 非 Stop 事件 → 一律放行且不抛错', async () => {
  const { stopHookRaw } = await import(serviceUrl());
  assert.equal(await stopHookRaw('garbage'), null);
  assert.equal(await stopHookRaw(''), null);
  assert.equal(await stopHookRaw('42'), null);
  assert.equal(await stopHookRaw('[]'), null);
  assert.equal(await stopHookRaw(undefined), null);
  // 挂错事件 → 放行
  const p = await writeTranscript('e6.jsonl', [assistantLine('x')]);
  const wrong = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'S1', transcript_path: p, cwd: join(tmp, 'proj') });
  assert.equal(await stopHookRaw(wrong), null);
});

test('坏 JSON payload 里的 transcript_path 仍能被抢救出来', async () => {
  const { startLoop, stopHookRaw, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', completionPromise: 'DONE', maxIterations: 5, sessionId: 'S1', cwd });
  const p = await writeTranscript('e7.jsonl', [assistantLine('完成 <promise>DONE</promise>')]);
  // 半截 JSON：末尾被截断，但 session_id / transcript_path / cwd 都已写出
  const broken = `{"hook_event_name":"Stop","session_id":"S1","transcript_path":${JSON.stringify(p)},"cwd":${JSON.stringify(cwd)}`;
  const out = await stopHookRaw(broken);
  assert.ok(out && out.systemMessage.includes('完成'), '应从半截 JSON 里抢救出 transcript_path 并判完成: ' + JSON.stringify(out));
  const [l] = await listLoops({ cwd });
  assert.equal(l.active, false, 'promise 命中应结束循环');
});

// ─── startLoop / cancelLoop / 多实例 ────────────────────────────────

test('startLoop：原子写 + 同 cwd 多会话并存', async () => {
  const { startLoop, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: 'A 的任务', sessionId: 'SA', cwd });
  await startLoop({ prompt: 'B 的任务', sessionId: 'SB', cwd });
  const loops = await listLoops({ cwd });
  assert.equal(loops.length, 2, '同一 cwd 下两个会话的循环并存');
  assert.deepEqual(loops.map((l) => l.id).sort(), ['loop-1', 'loop-2']);
  assert.equal(loops.find((l) => l.sessionId === 'SB').prompt, 'B 的任务');
});

test('startLoop：缺 prompt 抛 INVALID_INPUT；maxIterations 0 = 无限', async () => {
  const { startLoop, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await assert.rejects(() => startLoop({ prompt: '   ', cwd }), (e) => e.code === 'INVALID_INPUT');
  await startLoop({ prompt: '无限循环', maxIterations: 0, cwd });
  const [l] = await listLoops({ cwd });
  assert.equal(l.maxIterations, 0, '显式 0 表示无限，不能回落成 20');
});

test('cancelLoop：标记 inactive 但保留记录', async () => {
  const { startLoop, cancelLoop, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务1', cwd });
  await startLoop({ prompt: '任务2', cwd });
  const r = await cancelLoop({ id: 'loop-1', cwd });
  assert.equal(r.cancelled, 1);
  const loops = await listLoops({ cwd });
  assert.equal(loops.length, 2, '记录保留');
  assert.equal(loops.find((l) => l.id === 'loop-1').active, false);
  assert.equal(loops.find((l) => l.id === 'loop-1').endReason, 'cancelled');
  assert.equal(loops.find((l) => l.id === 'loop-2').active, true);
  // 不带 id → 取消全部活跃
  const r2 = await cancelLoop({ cwd });
  assert.equal(r2.cancelled, 1);
});

test('状态文件损坏 → 降级为空，不抛错（读路径绝不炸）', async () => {
  const { listLoops, stopHookRaw } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  const { loopsFileFor } = pathsMod;
  const { file } = loopsFileFor(cwd);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, '{ 这不是合法 JSON', 'utf8');
  assert.deepEqual(await listLoops({ cwd }), []);
  const p = await writeTranscript('e8.jsonl', [assistantLine('x')]);
  assert.equal(await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' })), null);
});

// ─── 项目级开关：隔离、快照落点、.gitignore ────────────────────────

test('hookOn：默认写项目本地级 settings.local.json，并追加 .gitignore', async () => {
  const { hookOn, hookStatus } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(cwd, { recursive: true });
  const r = await hookOn({ cwd });
  assert.equal(r.scope, 'local');
  assert.equal(r.settingsPath, join(cwd, '.claude', 'settings.local.json'));
  assert.ok(existsSync(r.settingsPath), '本地级配置文件应存在');
  assert.equal(r.gitignore.added, true, '首次应追加 .gitignore 忽略规则');
  const gi = await readFile(join(cwd, '.gitignore'), 'utf8');
  assert.ok(gi.includes('.claude/settings.local.json'), '.gitignore 应含忽略行');

  const st = await hookStatus({ cwd });
  assert.equal(st.enabled, true);
  assert.equal(st.activeScope, 'local');
  assert.equal(st.detail.local.enabled, true);
  assert.equal(st.detail.shared.enabled, false);
});

test('hookOn：快照落在 ~/.nx-rp/snapshots/，**不污染项目目录**', async () => {
  const { hookOn } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(join(cwd, '.claude'), { recursive: true });
  // 先放一个已有的配置文件，让快照有内容可留
  await writeFile(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: { A: '1' } }), 'utf8');
  const r = await hookOn({ cwd });
  assert.ok(r.snapshot, '应生成快照');
  assert.ok(r.snapshot.startsWith(snapshotsDir), '快照应在集中目录: ' + r.snapshot);
  // 项目 .claude/ 里不该出现任何 nx-rp-bak 文件
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(cwd, '.claude'));
  assert.equal(files.filter((f) => f.includes('nx-rp-bak')).length, 0, '项目目录不应有快照: ' + files.join(','));
});

test('hookOn：已忽略时不再重复追加 .gitignore；已有其它键不被破坏', async () => {
  const { hookOn } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(join(cwd, '.claude'), { recursive: true });
  await writeFile(join(cwd, '.gitignore'), 'node_modules/\n.claude/settings.local.json\n', 'utf8');
  await writeFile(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'x@y': true }, env: { K: 'v' } }), 'utf8');
  const r = await hookOn({ cwd });
  assert.equal(r.gitignore.added, false, '已忽略则不该重复追加');
  const gi = await readFile(join(cwd, '.gitignore'), 'utf8');
  assert.equal(gi.split('.claude/settings.local.json').length - 1, 1, '只有一行');
  // 外科手术性：其它键原样保留
  const data = JSON.parse(await readFile(r.settingsPath, 'utf8'));
  assert.deepEqual(data.enabledPlugins, { 'x@y': true });
  assert.deepEqual(data.env, { K: 'v' });
  assert.ok(Array.isArray(data.hooks.Stop), '应写入 Stop hook');
});

test('hookOn/off：幂等 + 外科手术性（其余 hooks 不动）', async () => {
  const { hookOn, hookOff } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(join(cwd, '.claude'), { recursive: true });
  // 预置另外两个模块的 hook（模拟共存）
  await writeFile(join(cwd, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'nx-rp hook capture' }], __nx_rp_prompt_log__: true }],
    },
  }), 'utf8');

  const r1 = await hookOn({ cwd });
  assert.equal(r1.skipped, false);
  const r2 = await hookOn({ cwd });
  assert.equal(r2.skipped, true, '二次 on 应幂等（skipped）');

  let data = JSON.parse(await readFile(r1.settingsPath, 'utf8'));
  assert.equal(data.hooks.Stop.length, 1, '不该重复追加');
  assert.ok(data.hooks.UserPromptSubmit, '其它事件的 hook 必须保留');

  const off = await hookOff({ cwd });
  assert.equal(off.skipped, false);
  data = JSON.parse(await readFile(r1.settingsPath, 'utf8'));
  assert.equal(data.hooks.Stop, undefined, 'Stop 应被摘干净');
  assert.ok(data.hooks.UserPromptSubmit, '提示词日志 hook 必须原样保留');

  const off2 = await hookOff({ cwd });
  assert.equal(off2.skipped, true, '二次 off 应幂等');
});

test('hookOff：本地级与项目级两个文件一起摘', async () => {
  const { hookOn, hookOff } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(cwd, { recursive: true });
  await hookOn({ cwd, scope: 'local' });
  await hookOn({ cwd, scope: 'shared' });
  const off = await hookOff({ cwd });
  assert.equal(off.removedFrom.length, 2, '两个文件都该摘: ' + JSON.stringify(off.removedFrom));
  const { hookStatus } = await import(serviceUrl());
  assert.equal((await hookStatus({ cwd })).enabled, false);
});

test('hookOn --shared：写项目级 settings.json，且不碰 .gitignore', async () => {
  const { hookOn } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(cwd, { recursive: true });
  const r = await hookOn({ cwd, scope: 'shared' });
  assert.equal(r.settingsPath, join(cwd, '.claude', 'settings.json'));
  assert.ok(existsSync(r.settingsPath));
  assert.equal(r.gitignore.added, false, '项目级（入库）不该动 .gitignore');
  assert.equal(existsSync(join(cwd, '.gitignore')), false, '不该创建 .gitignore');
});

test('hookOn dry-run：不写盘', async () => {
  const { hookOn } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(cwd, { recursive: true });
  const r = await hookOn({ cwd, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(existsSync(r.settingsPath), false, 'dry-run 绝不写盘');
  assert.equal(existsSync(join(cwd, '.gitignore')), false);
});

test('manualSnippet 与 hookOn 写盘的 entry 完全同源', async () => {
  const { hookOn, manualSnippet } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await mkdir(cwd, { recursive: true });
  const r = await hookOn({ cwd });
  const data = JSON.parse(await readFile(r.settingsPath, 'utf8'));
  assert.deepEqual(manualSnippet().hooks.Stop[0], data.hooks.Stop[0],
    '面板片段与写盘必须逐字节一致（否则手工粘贴 + CLI on 会出现两条并存）');
});

// ─── 审计日志 ──────────────────────────────────────────────────────

test('listLoopLog：记录每轮判定，含解析到的文本长度', async () => {
  const { startLoop, stopHookRaw, listLoopLog } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', completionPromise: 'DONE', maxIterations: 5, sessionId: 'S1', cwd });
  const p = await writeTranscript('a1.jsonl', [assistantLine('还在做')]);
  await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  const logs = await listLoopLog({ cwd });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].decision, 'continue');
  assert.equal(logs[0].lastTextChars, 3, '记下解析到的字数——面板上一眼看出解析是否失效');
  assert.equal(logs[0].iteration, 2);
});

// ============================================================
// updateLoop / removeLoop（面板「编辑任务」与「删除」的后端）
// ============================================================

test('updateLoop：改 prompt / 上限 / 承诺，各字段独立', async () => {
  const { startLoop, updateLoop } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  const { id } = await startLoop({ prompt: '原任务', sessionId: 'S1', maxIterations: 5, completionPromise: 'A', cwd });

  const r1 = await updateLoop({ id, prompt: '新任务', cwd });
  assert.deepEqual(r1.changed, ['prompt']);
  assert.equal(r1.loop.prompt, '新任务');
  assert.equal(r1.loop.maxIterations, 5, '没传的字段不动');

  const r2 = await updateLoop({ id, maxIterations: 20, completionPromise: 'B', cwd });
  assert.deepEqual(r2.changed.sort(), ['completionPromise', 'maxIterations']);
  assert.equal(r2.loop.maxIterations, 20);
  assert.equal(r2.loop.completionPromise, 'B');

  // 传空串 = 清掉承诺（与 undefined「不改」语义不同）
  const r3 = await updateLoop({ id, completionPromise: '', cwd });
  assert.equal(r3.loop.completionPromise, null);

  // 无改动 → skipped
  const r4 = await updateLoop({ id, cwd });
  assert.equal(r4.skipped, true);
});

test('updateLoop：因到上限而停的循环，提高上限时自动复活', async () => {
  const { startLoop, updateLoop, stopHookRaw, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', sessionId: 'S1', maxIterations: 1, completionPromise: 'DONE', cwd });
  const p = await writeTranscript('up1.jsonl', [assistantLine('还没完')]);
  // 打到上限 → active=false, endReason=max-iterations
  await stopHookRaw(stopEvent({ cwd, transcriptPath: p, sessionId: 'S1' }));
  let [l] = await listLoops({ cwd });
  assert.equal(l.active, false);
  assert.equal(l.endReason, 'max-iterations');

  const r = await updateLoop({ id: l.id, maxIterations: 10, cwd });
  assert.equal(r.reactivated, true, '提高上限应复活');
  assert.equal(r.loop.active, true);
  assert.equal(r.loop.endReason, undefined);
  [l] = await listLoops({ cwd });
  assert.equal(l.active, true);
});

test('updateLoop：手工取消的循环不因改上限而复活', async () => {
  const { startLoop, cancelLoop, updateLoop, listLoops } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  const { id } = await startLoop({ prompt: '任务', sessionId: 'S1', maxIterations: 5, cwd });
  await cancelLoop({ id, cwd });
  const r = await updateLoop({ id, maxIterations: 50, cwd });
  assert.equal(r.reactivated, false, '显式 cancel 是用户意图，不该被自动拉起');
  const [l] = await listLoops({ cwd });
  assert.equal(l.active, false);
});

test('updateLoop：找不到 id / 缺 id → INVALID_INPUT，错误信息带可用列表', async () => {
  const { startLoop, updateLoop } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  await startLoop({ prompt: '任务', sessionId: 'S1', cwd });
  await assert.rejects(() => updateLoop({ id: 'loop-99', cwd }), /未找到循环: loop-99.*可用|当前目录有/);
  await assert.rejects(() => updateLoop({ cwd }), /缺少 id/);
});

test('removeLoop：只能删已结束的；活跃的需 force', async () => {
  const { startLoop, removeLoop, listLoops, cancelLoop } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  const { id } = await startLoop({ prompt: '任务', sessionId: 'S1', cwd });

  await assert.rejects(() => removeLoop({ id, cwd }), /还在运行/);
  const r = await cancelLoop({ id, cwd });
  assert.equal(r.cancelled, 1);
  const rm = await removeLoop({ id, cwd });
  assert.equal(rm.removed, 1);
  assert.deepEqual(await listLoops({ cwd }), [], '记录真被删掉');

  await assert.rejects(() => removeLoop({ id: 'nope', cwd }), /未找到循环/);

  // force 可删活跃的
  const { id: id2 } = await startLoop({ prompt: '任务2', sessionId: 'S1', cwd });
  assert.equal((await removeLoop({ id: id2, force: true, cwd })).removed, 1);
});

test('updateLoop：可改绑会话（布防时绑错会话的补救）', async () => {
  const { startLoop, updateLoop } = await import(serviceUrl());
  const cwd = join(tmp, 'proj');
  const { id } = await startLoop({ prompt: '任务', sessionId: 'WRONG', cwd });
  const r = await updateLoop({ id, sessionId: 'RIGHT', cwd });
  assert.ok(r.changed.includes('sessionId'));
  assert.equal(r.loop.sessionId, 'RIGHT');
  // 传空串 = 清掉显式绑定，退回只用 claudeSessionId
  const r2 = await updateLoop({ id, sessionId: '', cwd });
  assert.equal(r2.loop.sessionId, null);
  // 不传该字段 = 不动
  const r3 = await updateLoop({ id, prompt: '改个名', cwd });
  assert.ok(!r3.changed.includes('sessionId'));
});

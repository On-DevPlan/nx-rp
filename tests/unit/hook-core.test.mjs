// hook 域共享 core 单测：claude-settings 外科手术 + hook-io stdin 容错。
// 路径重定向到临时目录（paths.setHookPaths），绝不碰真实的 ~/.claude/settings.json。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
let settingsPath;

const pathsMod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
const settingsUrl = () => pathToFileURL(join(ROOT, 'src', 'core', 'claude-settings.js')).href;
const hookIoUrl = () => pathToFileURL(join(ROOT, 'src', 'core', 'hook-io.js')).href;

async function seedSettings(obj) {
  await mkdir(join(tmp, 'claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(obj), 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-core-'));
  settingsPath = join(tmp, 'claude', 'settings.json');
  pathsMod.setHookPaths({ settingsPath, promptsDir: join(tmp, 'prompts'), skillsDir: join(tmp, 'skills') });
});

afterEach(async () => {
  pathsMod.setHookPaths({
    settingsPath: join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json'),
    promptsDir: join(pathsMod.APP_DIR, 'prompts'),
    skillsDir: join(pathsMod.APP_DIR, 'skills'),
  });
  await rm(tmp, { recursive: true, force: true });
});

// ─── core/claude-settings ──────────────────────────────────────────

test('appendOwnGroup / removeOwnGroups：两条 hook 各自幂等，互不干扰', async () => {
  const mod = await import(settingsUrl());
  const promptSpec = { event: 'UserPromptSubmit', matcher: '', hook: { type: 'command', command: 'nx-rp hook capture' }, marker: '__nx_rp_prompt_log__' };
  const skillSpec = { event: 'PostToolUse', matcher: 'Skill', hook: { type: 'command', command: 'nx-rp hook skill-track' }, marker: '__nx_rp_skill_track__' };

  await seedSettings({ env: { A: '1' } });
  const s1 = await mod.readSettings();
  assert.equal(mod.appendOwnGroup(s1, promptSpec), true);
  assert.equal(mod.appendOwnGroup(s1, skillSpec), true);
  await mod.writeSettings(s1);

  // 幂等：已存在返回 false 不重复写
  const s2 = await mod.readSettings();
  assert.equal(mod.appendOwnGroup(s2, promptSpec), false);
  assert.equal(mod.appendOwnGroup(s2, skillSpec), false);

  // 摘除一条：另一条原样保留
  const s3 = await mod.readSettings();
  assert.equal(mod.removeOwnGroups(s3, skillSpec), true);
  assert.ok(s3.hooks.UserPromptSubmit, 'prompt 条保留');
  assert.equal(s3.hooks.PostToolUse, undefined, 'skill 条已摘');
  assert.equal(s3.env.A, '1');

  // 摘到最后一条：hooks 与事件字段整个摘掉
  assert.equal(mod.removeOwnGroups(s3, promptSpec), true);
  assert.equal(s3.hooks, undefined);
});

test('readSettings：文件不存在 → {}；损坏 → 上抛（写路径保护）', async () => {
  const mod = await import(settingsUrl());
  assert.deepEqual(await mod.readSettings(), {});
  await seedSettings({ env: { A: '1' } });
  assert.deepEqual((await mod.readSettings()).env, { A: '1' });
  await writeFile(settingsPath, '{"env": {"A": "1"', 'utf8'); // 截断
  await assert.rejects(() => mod.readSettings(), /无法解析/);
});

test('toggleSettings：dry-run 不写盘；no-op skipped 不留快照', async () => {
  const mod = await import(settingsUrl());
  const spec = { event: 'UserPromptSubmit', matcher: '', hook: { type: 'command', command: 'nx-rp hook capture' }, marker: '__m1__' };

  await seedSettings({ env: { A: '1' } });
  const dry = await mod.toggleSettings((next) => mod.appendOwnGroup(next, spec), { dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(dry.written, false);
  assert.equal((await mod.readSettings()).hooks, undefined, 'dry-run 不得写盘');

  const r1 = await mod.toggleSettings((next) => mod.appendOwnGroup(next, spec));
  assert.equal(r1.written, true);
  assert.ok(r1.snapshot, '实际写入前留快照');
  const r2 = await mod.toggleSettings((next) => mod.appendOwnGroup(next, spec));
  assert.equal(r2.changed, false, '幂等 no-op');
  assert.equal(r2.snapshot, null, 'no-op 不留快照');
});

test('快照轮转：只保留最近 5 份', async () => {
  const mod = await import(settingsUrl());
  await seedSettings({ n: 0 });
  for (let i = 1; i <= 7; i++) {
    await writeFile(settingsPath, JSON.stringify({ n: i }), 'utf8');
    await mod.toggleSettings((next) => { next.n = -i; return true; }); // 直改触发快照路径
  }
  const { readdir } = await import('node:fs/promises');
  const snaps = (await readdir(join(tmp, 'claude'))).filter((f) => f.startsWith('settings.json.nx-rp-bak-'));
  assert.ok(snaps.length <= 5, `快照应轮转到 5 份以内，实际 ${snaps.length}`);
});

// ─── core/hook-io ──────────────────────────────────────────────────

test('salvageFields：半截 JSON 里救回 session_id / cwd', async () => {
  const { salvageFields } = await import(hookIoUrl());
  const half = '{"session_id":"abc-123","cwd":"D:/proj","prompt":"帮我整';
  const got = salvageFields(half);
  assert.equal(got.session_id, 'abc-123');
  assert.equal(got.cwd, 'D:/proj');
  assert.deepEqual(salvageFields('not json at all'), {});
  assert.deepEqual(salvageFields(''), {});
});

test('parseHookEvent：坏 JSON 降级为抢救对象；非对象 JSON 降级 {}', async () => {
  const { parseHookEvent } = await import(hookIoUrl());
  const half = '{"session_id":"s9","cwd":"C:/x","tool_name":"Skill"';
  assert.equal(parseHookEvent(half).session_id, 's9');
  assert.deepEqual(parseHookEvent('42'), {});
  assert.deepEqual(parseHookEvent('[1,2]'), {});
  assert.equal(parseHookEvent('{"prompt":"hi"}').prompt, 'hi');
});

test('isSubagentEvent：认 agent_id / agentId 两种写法；主 agent 事件与垃圾输入都不误判', async () => {
  const { isSubagentEvent } = await import(hookIoUrl());
  // 子 agent：两种拼写都认（hook payload 里叫什么没实测过——子 agent 的 stop 根本
  // 不投递，拿不到真实 payload，所以不赌某一种）
  assert.equal(isSubagentEvent({ agent_id: 'a91e478b' }), true);
  assert.equal(isSubagentEvent({ agentId: 'a91e478b' }), true);
  // 字段在但为空 = 没有子 agent 身份 → 不是子 agent（空串/空白/null 都不算）
  assert.equal(isSubagentEvent({ agent_id: '' }), false);
  assert.equal(isSubagentEvent({ agentId: '   ' }), false);
  assert.equal(isSubagentEvent({ agentId: null }), false);
  assert.equal(isSubagentEvent({ agent_id: undefined }), false);
  // 主 agent 的普通事件：不能因为 payload 里有别的字段就误判
  assert.equal(isSubagentEvent({ session_id: 'S1', cwd: 'D:/x', hook_event_name: 'Stop' }), false);
  assert.equal(isSubagentEvent({ tool_name: 'Skill', agentType: 'general-purpose' }), false, 'agentType 不是子 agent 标识，不该误判');
  // 坏输入不抛
  assert.equal(isSubagentEvent(null), false);
  assert.equal(isSubagentEvent(undefined), false);
  assert.equal(isSubagentEvent('nope'), false);
  assert.equal(isSubagentEvent({}), false);
});

test('salvageFields：半截 JSON 里也救回 agent_id（子 agent 判定不能因坏 JSON 失守）', async () => {
  const { salvageFields } = await import(hookIoUrl());
  const half = '{"session_id":"s1","agent_id":"a91e478b","cwd":"D:/x","prompt":"半';
  const got = salvageFields(half);
  assert.equal(got.agent_id, 'a91e478b', '子 agent 身份救不回来，防线就出缺口');
  assert.equal(got.session_id, 's1');
  // 转义安全：与 session_id 走同一套 JSON.parse 解码，不裸拼
  assert.equal(salvageFields('{"agentId":"a\\"b"}').agentId, 'a"b');
});

test('deriveSessionId：payload 优先，env 次之，pid+cwd 兜底', async () => {
  const { deriveSessionId } = await import(hookIoUrl());
  assert.equal(deriveSessionId({ session_id: 'a' }), 'a');
  assert.equal(deriveSessionId({ sessionId: 'b' }), 'b');
  const origEnv = process.env.CLAUDE_SESSION_ID;
  try {
    process.env.CLAUDE_SESSION_ID = 'env-sid';
    assert.equal(deriveSessionId({}), 'env-sid');
    delete process.env.CLAUDE_SESSION_ID;
    const fallback = deriveSessionId({}, 'D:/proj');
    assert.match(fallback, /^pid-\d+-D:\/proj$/);
  } finally {
    if (origEnv !== undefined) process.env.CLAUDE_SESSION_ID = origEnv;
  }
});

// hook 模块单测：on/off 幂等与外科手术性、capture 追加 JSONL、log 按 cwd 过滤。
// 路径重定向到临时目录（paths.setHookPaths），绝不碰真实的 ~/.claude/settings.json。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
let settingsPath;
let promptsDir;

const pathsMod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
const serviceUrl = () => pathToFileURL(join(ROOT, 'src', 'modules', 'hook', 'service.js')).href;

async function seedSettings(obj) {
  await mkdir(join(tmp, 'claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(obj), 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-hook-'));
  settingsPath = join(tmp, 'claude', 'settings.json');
  promptsDir = join(tmp, 'prompts');
  pathsMod.setHookPaths({ settingsPath, promptsDir });
  // service.js 没有在顶层解构常量（都在函数内现取 live binding），重定向即时生效
});

afterEach(async () => {
  pathsMod.setHookPaths({
    settingsPath: join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json'),
    promptsDir: join(pathsMod.APP_DIR, 'prompts'),
  });
  await rm(tmp, { recursive: true, force: true });
});

test('hook on：空 settings → 写入 UserPromptSubmit 组，其余键不动', async () => {
  await seedSettings({ env: { FOO: 'bar' } });
  const { hookOn } = await import(serviceUrl());
  const r = await hookOn();
  assert.equal(r.enabled, true);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.env.FOO, 'bar', 'env 必须原样保留');
  const groups = settings.hooks.UserPromptSubmit;
  assert.equal(groups.length, 1);
  const entry = groups[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.equal(entry.command, 'nx-rp hook capture');
  assert.equal(entry.async, true, '日志 hook 必须 async，不给会话加延迟');
  assert.equal(typeof entry.timeout, 'number', '必须显式 timeout');
});

test('hook on：settings 文件不存在 → 直接创建', async () => {
  const { hookOn } = await import(serviceUrl());
  const r = await hookOn();
  assert.equal(r.enabled, true);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
});

test('hook on：幂等（重复执行只留一条）', async () => {
  const { hookOn } = await import(serviceUrl());
  await hookOn();
  const r2 = await hookOn();
  assert.equal(r2.skipped, true);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
});

test('hook on：已有他人 hooks → 追加不覆盖', async () => {
  await seedSettings({
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt.sh' }] }],
    },
  });
  const { hookOn } = await import(serviceUrl());
  await hookOn();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 2, '他人的组要保留');
  assert.ok(settings.hooks.PostToolUse, '别的事件不动');
  assert.ok(settings.hooks.UserPromptSubmit.some((g) => g.hooks?.[0]?.command === 'echo other'));
});

test('hook off：只摘自己的组，他人的原样保留', async () => {
  await seedSettings({
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'echo other' }] }],
    },
  });
  const mod = await import(serviceUrl());
  await mod.hookOn();
  const r = await mod.hookOff();
  assert.equal(r.enabled, false);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'echo other');
});

test('hook off 后 hooks 空了 → 字段整个摘掉；重复 off 幂等', async () => {
  const mod = await import(serviceUrl());
  await mod.hookOn();
  await mod.hookOff();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks, undefined);
  const r2 = await mod.hookOff();
  assert.equal(r2.skipped, true);
});

test('hook on/off --dry-run：不写盘', async () => {
  await seedSettings({ env: { A: '1' } });
  const mod = await import(serviceUrl());
  const rOn = await mod.hookOn({ dryRun: true });
  assert.equal(rOn.dryRun, true);
  assert.equal(rOn.enabled, true);
  let settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks, undefined, 'dry-run 不得写盘');
  assert.equal(settings.env.A, '1');

  await mod.hookOn();
  const rOff = await mod.hookOff({ dryRun: true });
  assert.equal(rOff.dryRun, true);
  settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1, 'dry-run 不得写盘');
});

test('hook on/off 写前留快照', async () => {
  await seedSettings({ env: { A: '1' } });
  const mod = await import(serviceUrl());
  const r = await mod.hookOn();
  assert.ok(r.snapshot, '写前应有快照');
  const snap = JSON.parse(await readFile(r.snapshot, 'utf8'));
  assert.equal(snap.env.A, '1', '快照内容是写入前的原文');

  const r2 = await mod.hookOff();
  assert.ok(r2.snapshot);
});

test('settings.json 损坏 → hook on/off 拒绝写入（绝不覆盖用户配置）', async () => {
  await mkdir(join(tmp, 'claude'), { recursive: true });
  await writeFile(settingsPath, '{"env": {"A": "1"', 'utf8'); // 截断的 JSON
  const mod = await import(serviceUrl());
  await assert.rejects(() => mod.hookOn(), /无法解析/);
  await assert.rejects(() => mod.hookOff(), /无法解析/);
  // 原文未被覆盖
  assert.equal(await readFile(settingsPath, 'utf8'), '{"env": {"A": "1"');
  // status 降级不抛，但如实标注 corrupt
  const st = await mod.hookStatus();
  assert.equal(st.corrupt, true);
  assert.equal(st.enabled, false);
});

test('快照轮转：只保留最近 5 份', async () => {
  await seedSettings({ n: 0 });
  const mod = await import(serviceUrl());
  for (let i = 1; i <= 7; i++) {
    await writeFile(settingsPath, JSON.stringify({ n: i }), 'utf8'); // 每轮改变原文，保证快照内容不同
    await mod.hookOn();
    await mod.hookOff();
  }
  const dir = join(tmp, 'claude');
  const snaps = (await (await import('node:fs/promises')).readdir(dir))
    .filter((f) => f.startsWith('settings.json.nx-rp-bak-'));
  assert.ok(snaps.length <= 5, `快照应轮转到 5 份以内，实际 ${snaps.length}`);
});

test('listPrompts 的 limit 在 action 层归一化：负数/NaN 回落 50，超大封顶', async () => {
  await mod_captureTwo();
  // 走 action 层（归一化所在位置），模拟 CLI 传了 --limit=-5
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const logAction = ACTIONS.find((a) => a.id === 'hook.log');
  const res = await logAction.run({ all: true, limit: -5 });
  assert.equal(res.length, 2, '负 limit 回落默认 50，不得丢记录');
  const big = await logAction.run({ all: true, limit: 99999 });
  assert.equal(big.length, 2, '超大 limit 封顶 1000，不得丢记录');
  const nan = await logAction.run({ all: true, limit: NaN });
  assert.equal(nan.length, 2, 'NaN 回落默认 50');
});

async function mod_captureTwo() {
  const mod = await import(serviceUrl());
  const dir = join(tmp, 'lim'); // 同一 cwd → 同一个日志文件，两条记录才可比
  await mod.captureRecord({ prompt: 'p1', cwd: dir });
  await mod.captureRecord({ prompt: 'p2', cwd: dir });
}

test('captureRaw：事件 JSON → 追加一行 JSONL；坏输入静默丢弃', async () => {
  const mod = await import(serviceUrl());
  const bad = await mod.captureRaw('not json');
  assert.equal(bad.ok, false);
  const noPrompt = await mod.captureRaw(JSON.stringify({ session_id: 's1', cwd: 'D:/x' }));
  assert.equal(noPrompt.ok, false);

  const ok = await mod.captureRaw(
    JSON.stringify({ session_id: 's1', cwd: join(tmp, 'proj'), prompt: '帮我整理链接' }),
  );
  assert.equal(ok.ok, true);
  const raw = await readFile(ok.file, 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.prompt, '帮我整理链接');
  assert.equal(rec.sessionId, 's1');
  assert.ok(rec.ts);
  assert.ok(rec.cwd);
});

test('listPrompts --all：跨目录、按时间倒序', async () => {
  const mod = await import(serviceUrl());
  const dirA = join(tmp, 'a');
  const dirB = join(tmp, 'b');
  await mod.captureRecord({ prompt: 'first', cwd: dirA });
  await new Promise((r) => setTimeout(r, 10)); // ts 精度只到 ms，留间隔保证可排序
  await mod.captureRecord({ prompt: 'second', cwd: dirA });
  await new Promise((r) => setTimeout(r, 10));
  await mod.captureRecord({ prompt: 'other-dir', cwd: dirB });

  const everything = await mod.listPrompts({ all: true, limit: 10 });
  assert.deepEqual(everything.map((r) => r.prompt), ['other-dir', 'second', 'first']);
});

test('listPrompts：默认按 process.cwd() 归一化 key 过滤', async () => {
  const mod = await import(serviceUrl());
  const cwdDir = join(tmp, 'proj');
  await mkdir(cwdDir, { recursive: true });
  await mod.captureRecord({ prompt: 'mine', cwd: cwdDir });
  await mod.captureRecord({ prompt: 'elsewhere', cwd: join(tmp, 'other') });

  // 把 cwd 伪装成 cwdDir 再查（chdir 在测试里可控，结束恢复）
  const orig = process.cwd();
  process.chdir(cwdDir);
  try {
    const only = await mod.listPrompts({ all: false, limit: 10 });
    assert.deepEqual(only.map((r) => r.prompt), ['mine']);
  } finally {
    process.chdir(orig);
  }
});

test('capture 后日志文件落在 promptsDir 下（哈希文件名，全 ASCII）', async () => {
  const mod = await import(serviceUrl());
  const r = await mod.captureRecord({ prompt: 'p', cwd: join(tmp, '中文 目录') });
  assert.ok(r.file.startsWith(promptsDir));
  assert.match(r.file, /^[A-Za-z0-9:_\\/.-]+$/);
  assert.ok(existsSync(r.file));
});

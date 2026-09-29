// hook-prompt 模块单测：on/off 幂等与外科手术性、capture 追加 JSONL、log 按 cwd 过滤。
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
const serviceUrl = () => pathToFileURL(join(ROOT, 'src', 'modules', 'hook-prompt', 'service.js')).href;

async function seedSettings(obj) {
  await mkdir(join(tmp, 'claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(obj), 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-hookp-'));
  settingsPath = join(tmp, 'claude', 'settings.json');
  promptsDir = join(tmp, 'prompts');
  pathsMod.setHookPaths({ settingsPath, promptsDir, skillsDir: join(tmp, 'skills') });
  // service.js 没有在顶层解构常量（都在函数内现取 live binding），重定向即时生效
});

afterEach(async () => {
  pathsMod.setHookPaths({
    settingsPath: join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json'),
    promptsDir: join(pathsMod.APP_DIR, 'prompts'),
    skillsDir: join(pathsMod.APP_DIR, 'skills'),
  });
  await rm(tmp, { recursive: true, force: true });
});

test('manualSnippet 与 hookOn 实际写入的 entry 逐字节同源（防面板/写盘两处漂移）', async () => {
  await seedSettings({ env: { A: '1' } });
  const mod = await import(serviceUrl());
  await mod.hookOn();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const written = settings.hooks.UserPromptSubmit[0];
  const snippet = mod.manualSnippet().hooks.UserPromptSubmit[0];
  // 完全一致——含 marker。片段缺 marker 曾导致手工粘贴 + CLI on 出现两条并存
  assert.deepEqual(snippet, written);
  // 字段语义抽查：async 与 timeout 必须在
  assert.equal(snippet.hooks[0].async, true);
  assert.equal(typeof snippet.hooks[0].timeout, 'number');
  assert.equal(snippet.hooks[0].command, 'nx-rp hook capture');
  assert.equal(snippet.__nx_rp_prompt_log__, true, 'marker 必须在——off/幂等都靠它认亲');
});

test('hook status 带 snippet（面板手动添加卡片的数据源）', async () => {
  const mod = await import(serviceUrl());
  const st = await mod.hookStatus();
  assert.ok(st.snippet?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command === 'nx-rp hook capture');
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

test('hook on：只动自己的事件——已有的他人 PostToolUse 组原样保留', async () => {
  await seedSettings({
    hooks: {
      PostToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: 'nx-rp hook skill-track' }] }],
    },
  });
  const { hookOn } = await import(serviceUrl());
  await hookOn();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.equal(settings.hooks.PostToolUse.length, 1, 'Skill 追踪条目不受影响');
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
    },
  });
  const { hookOn } = await import(serviceUrl());
  await hookOn();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 2, '他人的组要保留');
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

test('listPrompts 的 limit 在 action 层归一化：负数/NaN 回落 50，超大封顶', async () => {
  await captureTwo();
  // 走 action 层（归一化所在位置），模拟 CLI 传了 --limit=-5
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const logAction = ACTIONS.find((a) => a.id === 'hook-prompt.log');
  const res = await logAction.run({ all: true, limit: -5 });
  assert.equal(res.length, 2, '负 limit 回落默认 50，不得丢记录');
  const big = await logAction.run({ all: true, limit: 99999 });
  assert.equal(big.length, 2, '超大 limit 封顶 1000，不得丢记录');
  const nan = await logAction.run({ all: true, limit: NaN });
  assert.equal(nan.length, 2, 'NaN 回落默认 50');
});

test('listPrompts：分组按**归一化路径**聚合，同一目录只出一条组', async () => {
  const mod = await import(serviceUrl());
  const dirA = join(tmp, 'proj-norm');
  // 同一目录的另一种形态：路径分隔符不同 + 末尾多一道斜杠。
  // Windows 上这正是真实数据里出现过的 D:\x 与 D:/x 分裂。
  const dirAlt = dirA.replace(/\\/g, '/') + '/';
  await mkdir(dirA, { recursive: true });
  await mod.captureRecord({ prompt: 'a1', cwd: dirA });
  await new Promise((r) => setTimeout(r, 10));
  await mod.captureRecord({ prompt: 'a2', cwd: dirAlt });
  await mod.captureRecord({ prompt: 'b1', cwd: join(tmp, 'proj-other') });

  const { groups } = await mod.listPrompts({ all: true, limit: 50, shape: 'with-groups' });
  const key = pathsMod.normalizeScope(dirA);
  const mine = groups.filter((g) => g.key === key);
  // 曾经按原始字符串分组 → 同一目录派生出两条组，用户在面板上看到两条指同一项目的项
  assert.equal(mine.length, 1, '同一目录只能有一条组（归一化 key 去重）');
  assert.equal(mine[0].count, 2, '两种形态的记录要归到同一条组里');
  assert.ok(mine[0].display, '组要带一个可读的展示路径');

  // 选中该组时必须**真的拿到记录**——这是面板「切组后空白」的原症状。
  // 修复前：筛选走子串 + 文件首行早停，形态对不上就整文件跳过 → 0 条。
  const byNative = await mod.listPrompts({ all: true, limit: 50, cwd: dirA });
  assert.equal(byNative.length, 2, '按原生形态筛该组要拿到 2 条');
  const byAlt = await mod.listPrompts({ all: true, limit: 50, cwd: dirAlt });
  assert.equal(byAlt.length, 2, '按另一种形态筛同一条组也要拿到 2 条（归一化匹配）');
  assert.ok(byNative.every((r) => pathsMod.normalizeScope(r.cwd) === key), '筛出来的记录必须都属于该目录');
});

test('listPrompts cwd：精确选一条目录，不再误捞同前缀的兄弟目录', async () => {
  const mod = await import(serviceUrl());
  const dirA = join(tmp, 'proj-alpha');
  const dirB = join(tmp, 'proj-alpha-2');
  await mod.captureRecord({ prompt: 'a1', cwd: dirA });
  await mod.captureRecord({ prompt: 'b1', cwd: dirB });

  // 曾经是子串匹配：`proj-alpha` 会把 `proj-alpha-2` 一起捞进来
  const onlyA = await mod.listPrompts({ all: true, limit: 50, cwd: dirA });
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].prompt, 'a1', '只返回精确命中的那条目录');
});

test('log action：--groups 走声明过的 flag（面板的组切换器就靠它）', async () => {
  const mod = await import(serviceUrl());
  await mod.captureRecord({ prompt: 'p1', cwd: join(tmp, 'act-a') });
  await mod.captureRecord({ prompt: 'p2', cwd: join(tmp, 'act-b') });
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const act = ACTIONS.find((a) => a.id === 'hook-prompt.log');

  // 声明面：面板用的 groups flag 必须在（applySpec 只透传声明过的参数）
  assert.ok(act.flags.groups, 'log action 必须声明 groups flag，否则面板拿不到分组');
  assert.ok(act.flags.cwd, 'log action 必须声明 cwd flag');

  // 行为面：拉全量分组必须拿到 {records, groups}
  const res = await act.run({ all: true, groups: true, limit: 50 });
  assert.ok(!Array.isArray(res), 'groups=1 时返回 {records, groups}，不是裸数组');
  assert.ok(Array.isArray(res.groups) && res.groups.length >= 2, 'groups 要列出全部目录');
  assert.ok(res.groups.every((g) => 'display' in g && 'key' in g), '每条组要有 key 与可读 display');

  // **组列表不随 cwd 收窄**——否则用户切进一个目录后就再也切不出去
  const locked = await act.run({ all: true, groups: true, cwd: join(tmp, 'act-a'), limit: 50 });
  assert.equal(locked.records.length, 1, 'records 收窄到选中目录');
  assert.ok(locked.groups.length >= 2, 'groups 仍然是全量的（切换器要一直在）');
});

async function captureTwo() {
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

test('captureRaw：半截 JSON 抢救不出 prompt → 静默丢弃（core 容错兜底）', async () => {
  const mod = await import(serviceUrl());
  const r = await mod.captureRaw('{"cwd":"D:/x","prompt":"帮我整');
  assert.equal(r.ok, false, 'prompt 救不回来就不记——日志宁缺毋假');
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

test('listPrompts cwdFilter：归一化后精确选一条目录 + groups 聚合', async () => {
  const mod = await import(serviceUrl());
  const dirA = join(tmp, 'proj-alpha');
  const dirB = join(tmp, 'proj-beta');
  // ts 精度只到 ms——隔 10ms 保可排序
  await mod.captureRecord({ prompt: 'a1', cwd: dirA });
  await new Promise((r) => setTimeout(r, 10));
  await mod.captureRecord({ prompt: 'a2', cwd: dirA });
  await new Promise((r) => setTimeout(r, 10));
  await mod.captureRecord({ prompt: 'b1', cwd: dirB });

  // cwd 命中 dirA —— 精确匹配，不读 dirB 的记录
  const filtered = await mod.listPrompts({ all: true, limit: 50, cwd: dirA });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((r) => pathsMod.normalizeScope(r.cwd) === pathsMod.normalizeScope(dirA)));

  // groups 形状：全量聚合（不被 limit 截）
  const { records, groups } = await mod.listPrompts({
    all: true, limit: 1, cwd: null, shape: 'with-groups',
  });
  assert.equal(records.length, 1, 'limit=1 时只返回一条记录');
  assert.ok(groups.length >= 2, 'groups 是全量聚合');
  // groups 倒序按最新 ts；首项应该是三条里最新的那条
  assert.ok(groups[0].latestTs >= (groups[1]?.latestTs || ''));
});

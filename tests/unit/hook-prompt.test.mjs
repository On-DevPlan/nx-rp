// hook-prompt 模块单测：on/off 幂等与外科手术性、capture 追加 JSONL、log 按 cwd 过滤。
// 路径重定向到临时目录（paths.setHookPaths），绝不碰真实的 ~/.claude/settings.json。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
let settingsPath;
let promptsDir;
let snapshotsDir;

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
  // 清理动作的快照也要重定向——否则测试会往真实的 ~/.nx-rp/snapshots/ 里写
  snapshotsDir = join(tmp, 'snapshots');
  pathsMod.setHookPaths({ settingsPath, promptsDir, skillsDir: join(tmp, 'skills'), snapshotsDir });
  // service.js 没有在顶层解构常量（都在函数内现取 live binding），重定向即时生效
});

afterEach(async () => {
  pathsMod.setHookPaths({
    settingsPath: join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json'),
    promptsDir: join(pathsMod.APP_DIR, 'prompts'),
    skillsDir: join(pathsMod.APP_DIR, 'skills'),
    snapshotsDir: join(pathsMod.APP_DIR, 'snapshots'),
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
  // action 统一返回 with-groups 形状（CLI 与面板同源）
  const res = await logAction.run({ all: true, limit: -5 });
  assert.equal(res.records.length, 2, '负 limit 回落默认 50，不得丢记录');
  const big = await logAction.run({ all: true, limit: 99999 });
  assert.equal(big.records.length, 2, '超大 limit 封顶 1000，不得丢记录');
  const nan = await logAction.run({ all: true, limit: NaN });
  assert.equal(nan.records.length, 2, 'NaN 回落默认 50');
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
  // ~ 在白名单里：Windows 8.3 短路径名（如 MINISF~1）可能出现在 tmpdir 前缀
  assert.match(r.file, /^[A-Za-z0-9:_~/\\.-]+$/);
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

// ─── 系统注入的记录：默认不显示，可切换显示，可物理清理 ──────────────

test('isSystemInjected：认机器消息，但**不误杀**以 < 开头的真实代码', async () => {
  const mod = await import(serviceUrl());
  // 机器消息：后台任务完成 / 跨会话消息 / subagent 回报
  assert.equal(mod.isSystemInjected('<task-notification> <task-id>x</task-id>'), true);
  assert.equal(mod.isSystemInjected('<cross-session-message from="a"></cross-session-message>'), true);
  assert.equal(mod.isSystemInjected('<agent-message from="b">done</agent-message>'), true);
  // 真实提示词：用户贴的代码片段（曾经出现过 <svg> 开头的 SVG 源码）
  assert.equal(mod.isSystemInjected('<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>'), false);
  assert.equal(mod.isSystemInjected('<pre>hello</pre>'), false);
  assert.equal(mod.isSystemInjected('帮我把这个 <div> 改一下'), false);
  assert.equal(mod.isSystemInjected(''), false);
  assert.equal(mod.isSystemInjected(null), false);
});

test('listPrompts：系统注入默认不进列表；includeSystem 才带上', async () => {
  const mod = await import(serviceUrl());
  const dir = join(tmp, 'noise');
  await mod.captureRecord({ prompt: '真实提示词一', cwd: dir });
  await mod.captureRecord({ prompt: '<task-notification> <task-id>abc</task-id> 后台任务完成', cwd: dir });
  await mod.captureRecord({ prompt: '真实提示词二', cwd: dir });

  const def = await mod.listPrompts({ all: true, limit: 50, cwd: dir });
  assert.equal(def.length, 2, '默认只列真实提示词');
  assert.ok(def.every((r) => !String(r.prompt).startsWith('<task-notification>')));

  const withNoise = await mod.listPrompts({ all: true, limit: 50, cwd: dir, includeSystem: true });
  assert.equal(withNoise.length, 3, 'includeSystem=true 时系统注入也列出');
});

test('listPrompts：过滤发生在 limit 之前（否则列表永远填不满）', async () => {
  const mod = await import(serviceUrl());
  const dir = join(tmp, 'fill');
  // 5 条噪声 + 3 条真实 = 8 条；limit=3 必须拿到 3 条**真实**的
  for (let i = 0; i < 5; i++) {
    await mod.captureRecord({ prompt: `<task-notification> n${i}`, cwd: dir });
  }
  for (let i = 0; i < 3; i++) {
    await mod.captureRecord({ prompt: `real-${i}`, cwd: dir });
  }
  const res = await mod.listPrompts({ all: true, limit: 3, cwd: dir });
  assert.equal(res.length, 3, 'limit=3 要给满 3 条');
  assert.ok(res.every((r) => r.prompt.startsWith('real-')), '拿到的必须全是真实提示词');
});

test('listPrompts with-groups：带 systemCount/filtered；分组条数只算真实提示词', async () => {
  const mod = await import(serviceUrl());
  const dir = join(tmp, 'counts');
  await mod.captureRecord({ prompt: 'r1', cwd: dir });
  await mod.captureRecord({ prompt: '<task-notification> x', cwd: dir });
  await mod.captureRecord({ prompt: '<cross-session-message>y</cross-session-message>', cwd: dir });

  const res = await mod.listPrompts({ all: true, limit: 50, cwd: dir, shape: 'with-groups' });
  assert.equal(res.records.length, 1, '列表只有 1 条真实提示词');
  assert.equal(res.systemCount, 2, 'systemCount 报出范围内系统注入的总条数');
  assert.equal(res.filtered, 2, '默认形态下 filtered = systemCount');
  const key = pathsMod.normalizeScope(dir);
  const g = res.groups.find((x) => x.key === key);
  assert.equal(g.count, 1, '分组条数只算真实提示词（否则下拉写 3 条、列表只有 1 条）');

  const shown = await mod.listPrompts({ all: true, limit: 50, cwd: dir, shape: 'with-groups', includeSystem: true });
  assert.equal(shown.filtered, 0, 'includeSystem 时没有记录被剔除');
  assert.equal(shown.systemCount, 2, 'systemCount 不变（与是否显示无关）');
});

test('cleanSystemRecords：只删系统注入的行，真实提示词与坏行原样保留', async () => {
  const mod = await import(serviceUrl());
  const dir = join(tmp, 'clean');
  await mod.captureRecord({ prompt: '真提示词一', cwd: dir });
  await mod.captureRecord({ prompt: '<task-notification> 机器消息', cwd: dir });
  await mod.captureRecord({ prompt: '<svg viewBox="0 0 24 24"/>', cwd: dir });
  const file = pathsMod.promptsFileFor(dir).file;
  // 手工塞一条坏行（解析不出来）——清理**不许**删它
  await appendFile(file, '{ 这不是合法 JSON\n', 'utf8');

  const before = await readFile(file, 'utf8');
  const r = await mod.cleanSystemRecords({ cwd: dir });
  assert.equal(r.removed, 1, '只删掉 1 条系统注入');
  assert.equal(r.files, 1);
  assert.ok(r.snapshots.length === 1, '写前必须留快照');

  const after = await readFile(file, 'utf8');
  assert.ok(after.includes('真提示词一'), '真实提示词必须留着');
  assert.ok(after.includes('<svg viewBox'), '以 < 开头的真实代码必须留着');
  assert.ok(after.includes('{ 这不是合法 JSON'), '坏行必须留着——不知道是什么就不许删');
  assert.ok(!after.includes('机器消息'), '系统注入的行必须被删掉');
  assert.ok(after.length < before.length, '文件应变小');

  // 快照可回滚：快照内容 = 清理前的原文
  const snap = await readFile(r.snapshots[0], 'utf8');
  assert.equal(snap, before, '快照必须是清理前的原文');
});

test('cleanSystemRecords：dry-run 不写盘；无噪声时不动文件', async () => {
  const mod = await import(serviceUrl());
  const dir = join(tmp, 'dry');
  await mod.captureRecord({ prompt: '只有真实提示词', cwd: dir });
  const file = pathsMod.promptsFileFor(dir).file;
  const before = await readFile(file, 'utf8');

  const dry = await mod.cleanSystemRecords({ cwd: dir, dryRun: true });
  assert.equal(dry.removed, 0);
  assert.equal(dry.dryRun, true);
  assert.equal(await readFile(file, 'utf8'), before, 'dry-run 不得写盘');

  const noop = await mod.cleanSystemRecords({ cwd: dir });
  assert.equal(noop.removed, 0, '没有噪声时不该报删了东西');
  assert.equal(await readFile(file, 'utf8'), before, '没有噪声时文件不该被改写');
});

test('cleanSystemRecords：--all 跨目录清理，且不越界动别的目录', async () => {
  const mod = await import(serviceUrl());
  const dirA = join(tmp, 'all-a');
  const dirB = join(tmp, 'all-b');
  await mod.captureRecord({ prompt: '<task-notification> a', cwd: dirA });
  await mod.captureRecord({ prompt: '<task-notification> b', cwd: dirB });
  await mod.captureRecord({ prompt: '真实', cwd: dirB });

  const r = await mod.cleanSystemRecords({ all: true });
  assert.equal(r.removed, 2, '两个目录各一条噪声都要清掉');
  assert.equal(r.files, 2);

  const leftB = await readFile(pathsMod.promptsFileFor(dirB).file, 'utf8');
  assert.ok(leftB.includes('真实'), '真实提示词留着');
  assert.ok(!leftB.includes('task-notification'), '噪声清掉了');
});

test('hook-prompt.clean action：有 CLI + HTTP 路由，dry-run 不写盘', async () => {
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const act = ACTIONS.find((a) => a.id === 'hook-prompt.clean');
  assert.ok(act, '必须有 hook-prompt.clean action');
  assert.deepEqual(act.cli, ['hook', 'clean']);
  assert.ok(Array.isArray(act.http) && act.http[0] === 'POST' && act.http[1] === '/api/hook-prompt/clean',
    'clean 必须有 POST 路由，面板才能调');
  assert.ok(act.flags.all && act.flags.cwd && act.flags.dryRun, 'clean 的 flag 要声明齐（applySpec 只透传声明过的参数）');

  const mod = await import(serviceUrl());
  const dir = join(tmp, 'act-clean');
  await mod.captureRecord({ prompt: '<task-notification> x', cwd: dir });
  const file = pathsMod.promptsFileFor(dir).file;
  const before = await readFile(file, 'utf8');

  const dry = await act.run({ cwd: dir, dryRun: true });
  assert.equal(dry.removed, 1);
  assert.equal(await readFile(file, 'utf8'), before, 'dry-run 不得写盘');

  const real = await act.run({ cwd: dir });
  assert.equal(real.removed, 1);
  assert.ok(!(await readFile(file, 'utf8')).includes('task-notification'));
});

test('hook-prompt.log action：--system 才带系统注入；默认形态带 systemCount', async () => {
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const act = ACTIONS.find((a) => a.id === 'hook-prompt.log');
  assert.ok(act.flags.system, 'log action 必须声明 system flag');

  const mod = await import(serviceUrl());
  const dir = join(tmp, 'act-log');
  await mod.captureRecord({ prompt: '真实', cwd: dir });
  await mod.captureRecord({ prompt: '<task-notification> x', cwd: dir });

  const def = await act.run({ cwd: dir, limit: 50 });
  assert.equal(def.records.length, 1);
  assert.equal(def.systemCount, 1, '默认形态也要报出 systemCount（面板据此显示「已隐藏 N 条」）');

  const withSys = await act.run({ cwd: dir, limit: 50, system: true });
  assert.equal(withSys.records.length, 2);
});

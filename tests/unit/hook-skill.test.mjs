// hook-skill 模块单测：独立开关幂等与外科手术性、skill-track 容错、健康分、stats 聚合。
// 路径重定向到临时目录（paths.setHookPaths），绝不碰真实的 ~/.claude/settings.json。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
let settingsPath;
let skillsDir;

const pathsMod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
const serviceUrl = () => pathToFileURL(join(ROOT, 'src', 'modules', 'hook-skill', 'service.js')).href;
// 测试装技能用的目录——绝对不污染真实 ~/.claude/skills
const skillsRoot = () => join(tmp, 'home-skills');
const cwdSkillsRoot = () => join(tmp, 'proj', '.claude', 'skills');

async function seedSettings(obj) {
  await mkdir(join(tmp, 'claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(obj), 'utf8');
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-hooks-'));
  settingsPath = join(tmp, 'claude', 'settings.json');
  skillsDir = join(tmp, 'skills');
  pathsMod.setHookPaths({ settingsPath, promptsDir: join(tmp, 'prompts'), skillsDir });
  // 注入 skill 目录覆盖——skillExists() 会同时找这里与默认家目录位置
  const mod = await import(serviceUrl());
  mod.setSkillRoots([() => skillsRoot(), () => cwdSkillsRoot()]);
  await mkdir(skillsRoot(), { recursive: true });
});

afterEach(async () => {
  pathsMod.setHookPaths({
    settingsPath: join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json'),
    promptsDir: join(pathsMod.APP_DIR, 'prompts'),
    skillsDir: join(pathsMod.APP_DIR, 'skills'),
  });
  const mod = await import(serviceUrl());
  mod.setSkillRoots(null); // 还原默认（生产路径）
  await rm(tmp, { recursive: true, force: true });
});

test('manualSnippet 与 hookOn 实际写入的 entry 逐字节同源（防面板/写盘两处漂移）', async () => {
  await seedSettings({ env: { A: '1' } });
  const mod = await import(serviceUrl());
  await mod.hookOn();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  // 两条落点：PostToolUse(Skill) + UserPromptSubmit(斜杠)
  const writtenTool = settings.hooks.PostToolUse[0];
  const writtenSlash = settings.hooks.UserPromptSubmit[1] ?? settings.hooks.UserPromptSubmit[0];
  const snippet = mod.manualSnippet();
  // 完全一致——含 marker。片段缺 marker 曾导致手工粘贴 + CLI on 出现两条并存
  assert.deepEqual(snippet.hooks.PostToolUse[0], writtenTool);
  const slashSnip = snippet.hooks.UserPromptSubmit[0];
  assert.equal(slashSnip.matcher, writtenSlash.matcher);
  assert.deepEqual(slashSnip.hooks, writtenSlash.hooks);
  assert.equal(writtenTool.matcher, 'Skill', 'PostToolUse 组必须挂 Skill matcher');
  assert.equal(writtenTool.hooks[0].command, 'nx-rp hook skill-track');
  assert.equal(writtenSlash.hooks[0].command, 'nx-rp hook skill-slash');
  assert.equal(writtenTool.hooks[0].async, true);
  // marker 必须在——off/幂等都靠它认亲
  assert.equal(writtenTool.__nx_rp_skill_track__, true);
  assert.equal(writtenSlash.__nx_rp_skill_track_slash__, true);
  assert.equal(snippet.hooks.PostToolUse[0].__nx_rp_skill_track__, true);
  assert.equal(snippet.hooks.UserPromptSubmit[0].__nx_rp_skill_track_slash__, true);
});

test('hook on：写两条落点——已有提示词日志条目原样保留', async () => {
  await seedSettings({
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'nx-rp hook capture' }] }],
    },
  });
  const mod = await import(serviceUrl());
  await mod.hookOn();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.UserPromptSubmit.length, 2, '提示词日志 + 斜杠追踪并存');
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'Skill');
});

test('幂等认领手工条目：无 marker 但 command 一致 → on 不重复追加，off 一并摘除', async () => {
  // 模拟用户先手动粘贴了片段（无 marker），再跑 on
  await seedSettings({
    hooks: {
      PostToolUse: [
        { matcher: 'Skill', hooks: [{ type: 'command', command: 'nx-rp hook skill-track', async: true, timeout: 10 }] },
      ],
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: 'nx-rp hook skill-slash', async: true, timeout: 10 }] },
      ],
    },
  });
  const mod = await import(serviceUrl());
  const r = await mod.hookOn();
  assert.equal(r.skipped, true, '手工条目被 command 兜底认领，on 不再追加');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 1, '不产生重复条目');
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);

  // status 能看到 manualCount
  const st = await mod.hookStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.manualCount, 2, '两条都是手工粘贴的（无 marker）');

  // off 一并摘掉手工条目
  await mod.hookOff();
  const after = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(after.hooks?.PostToolUse, undefined, '手工 PostToolUse 组被摘除');
  assert.equal(after.hooks?.UserPromptSubmit, undefined, '手工斜杠组被摘除');
});

test('command 兜底不误伤：他人相同 matcher 不同 command 的组保留', async () => {
  await seedSettings({
    hooks: {
      PostToolUse: [
        { matcher: 'Skill', hooks: [{ type: 'command', command: 'other-tool track' }] },
      ],
    },
  });
  const mod = await import(serviceUrl());
  await mod.hookOn();
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 2, '他人的 Skill matcher 组不被认领');
  await mod.hookOff();
  const after = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.equal(after.hooks.PostToolUse[0].hooks[0].command, 'other-tool track', '只摘自己的');
});

test('hook off：只摘自己的 Skill 组——他人 Edit matcher 组与提示词日志保留', async () => {
  await seedSettings({
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'nx-rp hook capture' }] }],
      PostToolUse: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt.sh' }] },
      ],
    },
  });
  const mod = await import(serviceUrl());
  await mod.hookOn();
  let settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 2);

  await mod.hookOff();
  settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 1, '他人的 Edit 组保留');
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, 'fmt.sh');
  assert.ok(settings.hooks.UserPromptSubmit, '提示词日志不受影响');
});

test('hook on/off 幂等 + dry-run 不写盘 + 损坏拒写', async () => {
  await seedSettings({ env: { A: '1' } });
  const mod = await import(serviceUrl());
  const dry = await mod.hookOn({ dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).hooks, undefined);

  await mod.hookOn();
  const r2 = await mod.hookOn();
  assert.equal(r2.skipped, true);
  await mod.hookOff();
  const r4 = await mod.hookOff();
  assert.equal(r4.skipped, true);

  await writeFile(settingsPath, '{"env":', 'utf8');
  await assert.rejects(() => mod.hookOn(), /无法解析/);
  await assert.rejects(() => mod.hookOff(), /无法解析/);
});

test('hookStatus：独立 enabled 标志 + 双落点标志 + snippet', async () => {
  const mod = await import(serviceUrl());
  const st0 = await mod.hookStatus();
  assert.equal(st0.enabled, false);
  assert.equal(st0.toolHook, false);
  assert.equal(st0.slashHook, false);
  await mod.hookOn();
  const st1 = await mod.hookStatus();
  assert.equal(st1.enabled, true);
  assert.equal(st1.toolHook, true, 'PostToolUse 落点在');
  assert.equal(st1.slashHook, true, '斜杠落点在');
  assert.ok(st1.snippet?.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command === 'nx-rp hook skill-track');
  assert.ok(st1.snippet?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command === 'nx-rp hook skill-slash');
  assert.equal(st1.skillsDir, skillsDir);
});

test('skillSlashRaw：/斜杠 prompt + 已安装 skill → 记一行；非斜杠/未安装/坏名静默丢弃', async () => {
  const mod = await import(serviceUrl());
  const proj = join(tmp, 'proj');
  await mkdir(proj, { recursive: true });
  // "已安装"到注入的测试目录，不污染真实家目录
  await mkdir(join(skillsRoot(), 'nx-rp'), { recursive: true });
  await writeFile(join(skillsRoot(), 'nx-rp', 'SKILL.md'), '---\nname: nx-rp\n---\n', 'utf8');

  // 非斜杠 prompt 不记
  assert.equal((await mod.skillSlashRaw(JSON.stringify({ prompt: '普通消息', cwd: proj }))).ok, false);
  // 斜杠但未安装 → 拒记（防幻影 skill）
  const miss = await mod.skillSlashRaw(JSON.stringify({ prompt: '/not-installed', cwd: proj }));
  assert.equal(miss.ok, false);
  assert.equal(miss.reason, 'not-installed');
  // 斜杠裸名命中已安装 → 记录，带 via: slash
  const ok = await mod.skillSlashRaw(JSON.stringify({
    prompt: '/nx-rp 帮我整理链接',
    session_id: 's2',
    cwd: proj,
  }));
  assert.equal(ok.ok, true);
  const rec = JSON.parse((await readFile(ok.file, 'utf8')).trim());
  assert.equal(rec.skill, 'nx-rp');
  assert.equal(rec.via, 'slash');
  assert.equal(rec.sessionId, 's2');
  // 坏名拒绝
  assert.equal((await mod.skillSlashRaw(JSON.stringify({ prompt: '/bad<script>', cwd: proj }))).ok, false);
});

test('skillTrackRaw：Skill 事件 → 记一行；非 Skill / 坏名 / 坏 JSON 静默丢弃', async () => {
  const mod = await import(serviceUrl());
  assert.equal((await mod.skillTrackRaw('not json')).ok, false);
  assert.equal((await mod.skillTrackRaw(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: join(tmp, 'p') }))).ok, false, '非 Skill 不记');
  assert.equal((await mod.skillTrackRaw(JSON.stringify({ tool_name: 'Skill', tool_input: {}, cwd: join(tmp, 'p') }))).ok, false, '无 skill 名不记');
  assert.equal((await mod.skillTrackRaw(JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'bad name<script>' }, cwd: join(tmp, 'p') }))).ok, false, '带控制字符的名单拒绝');

  const ok = await mod.skillTrackRaw(JSON.stringify({
    tool_name: 'Skill',
    tool_input: { skill: 'nx-rp' },
    session_id: 's1',
    cwd: join(tmp, 'proj'),
  }));
  assert.equal(ok.ok, true);
  const rec = JSON.parse((await readFile(ok.file, 'utf8')).trim());
  assert.equal(rec.skill, 'nx-rp');
  assert.equal(rec.sessionId, 's1');
  assert.ok(rec.ts);
});

test('extractSkillName：多字段回退 + SKILL.md 路径取父目录名', async () => {
  const mod = await import(serviceUrl());
  assert.equal(mod.extractSkillName({ skill: 'a' }), 'a');
  assert.equal(mod.extractSkillName('{"name":"b"}'), 'b');
  assert.equal(mod.extractSkillName({ command: '/c' }), '/c');
  assert.equal(mod.extractSkillName('{"skill":"C:/x/.claude/skills/my-skill/SKILL.md"}'), 'my-skill');
  assert.equal(mod.extractSkillName({ skill: '  padded  ' }), 'padded');
  assert.equal(mod.extractSkillName({}), null);
  assert.equal(mod.extractSkillName('broken'), null);
});

test('healthScore：使用分相对归一化 + 新鲜度 30 天线性衰减', async () => {
  const mod = await import(serviceUrl());
  const now = new Date('2026-09-22T12:00:00Z').getTime();
  // 最高频者拿满使用分 + 刚刚使用（同一时刻）→ 满分
  const top = mod.healthScore(10, '2026-09-22T12:00:00Z', 10, now);
  assert.equal(top, 100, '满分 = 60 使用 + 40 新鲜');
  // 一半使用量 → 30 使用分；同一时刻用满 → 30 + 40 = 70
  const half = mod.healthScore(5, '2026-09-22T12:00:00Z', 10, now);
  assert.equal(half, 70);
  // 30 天整 → 新鲜度归零，只剩使用分
  const stale = mod.healthScore(10, '2026-08-23T12:00:00Z', 10, now);
  assert.equal(stale, 60);
  // 15 天 → 新鲜度 20
  const mid = mod.healthScore(10, '2026-09-07T12:00:00Z', 10, now);
  assert.equal(mid, 80);
  assert.equal(mod.healthScore(0, '2026-09-22T12:00:00Z', 10, now), 0, '没用过就是 0');
  // 星级映射
  assert.equal(mod.scoreToStars(100), '★★★★★');
  assert.equal(mod.scoreToStars(0), '☆☆☆☆☆');
  assert.equal(mod.scoreToStars(50), '★★★☆☆');
});

test('skillStats：按 skill 聚合、健康分倒序、cwd 过滤', async () => {
  const mod = await import(serviceUrl());
  const dirA = join(tmp, 'a');
  // a: nx-rp 用 3 次（最近），sl-git 用 1 次；dirB: 别的目录
  for (let i = 0; i < 3; i++) {
    await mod.skillRecord({ skill: 'nx-rp', cwd: dirA });
  }
  await mod.skillRecord({ skill: 'sl-git-standard', cwd: dirA });
  await mod.skillRecord({ skill: 'other-proj-skill', cwd: join(tmp, 'b') });

  const cwdDir = join(tmp, 'a');
  await mkdir(cwdDir, { recursive: true });
  const orig = process.cwd();
  process.chdir(cwdDir);
  try {
    const rows = await mod.skillStats({ all: false, limit: 10 });
    assert.equal(rows.length, 2, '只统计当前 cwd');
    assert.equal(rows[0].skill, 'nx-rp', '高频者排前');
    assert.equal(rows[0].count, 3);
    assert.equal(rows[0].score, 100, '刚用过 + 相对最高 → 满分');
    assert.equal(rows[0].stars, '★★★★★');
    assert.ok(rows[1].score < 100, '低频者分数更低');
  } finally {
    process.chdir(orig);
  }

  const allRows = await mod.skillStats({ all: true, limit: 10 });
  assert.equal(allRows.length, 3, 'all 模式跨目录');
});

test('skillStats limit 归一化：action 层负数回落 50（不丢记录）', async () => {
  const mod = await import(serviceUrl());
  await mod.skillRecord({ skill: 's1', cwd: join(tmp, 'x') });
  await mod.skillRecord({ skill: 's2', cwd: join(tmp, 'x') });
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const act = ACTIONS.find((a) => a.id === 'hook-skill.stats');
  const rows = await act.run({ all: true, limit: -5 });
  assert.equal(rows.length, 2, '负 limit 回落默认 50');
});

// 冒烟测试：端到端只读路径。不写盘、不碰用户真实数据（不测 hook on/off 这类破坏性命令）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '');

test('smoke: 包结构合法', async () => {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  assert.equal(pkg.default.name, '@flowot6/nx-rp');
  assert.equal(pkg.default.type, 'module');
  assert.equal(pkg.default.bin['nx-rp'], 'bin/nx-rp.mjs');
});

test('smoke: registry 装载自检通过、三端命令表可生成', async () => {
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  assert.ok(ACTIONS.length > 0);
  const ids = new Set(ACTIONS.map((a) => a.id));
  // 两个 hook 模块平级：提示词日志 + Skill 追踪，各自独立 tab 与开关
  for (const id of [
    'hook-prompt.capture', 'hook-prompt.on', 'hook-prompt.off', 'hook-prompt.status', 'hook-prompt.log',
    'hook-skill.track', 'hook-skill.on', 'hook-skill.off', 'hook-skill.status', 'hook-skill.stats',
    'system.recents', 'system.recents.touch',
  ]) {
    assert.ok(ids.has(id), `缺 action: ${id}`);
  }
  // 面板操作必须有 HTTP 可达的同源路由（capture/track 是 hook 协议专属，cli-only）
  const httpById = new Map(ACTIONS.map((a) => [a.id, a.http]));
  for (const id of ['hook-prompt.on', 'hook-prompt.off', 'hook-prompt.status', 'hook-prompt.log',
    'hook-skill.on', 'hook-skill.off', 'hook-skill.status', 'hook-skill.stats']) {
    assert.ok(Array.isArray(httpById.get(id)), `${id} 缺 HTTP 路由，面板无法调用`);
  }
  assert.equal(httpById.get('hook-prompt.capture'), null, 'capture 是 stdin 协议入口，不应暴露 HTTP');
  assert.equal(httpById.get('hook-skill.track'), null, 'track 是 stdin 协议入口，不应暴露 HTTP');
  // hook 开关的外科手术性：两模块 off 互不误伤（各自只认自己的 marker）
  const offById = new Map(ACTIONS.map((a) => [a.id, a]));
  assert.equal(offById.get('hook-prompt.off').cli.join(' '), 'hook off');
  assert.equal(offById.get('hook-skill.off').cli.join(' '), 'hook skill-off');
  // recents：读端有 CLI，写端纯 HTTP（登记入口是面板/serve，与 capture 相反的方向）
  assert.ok(Array.isArray(httpById.get('system.recents')), 'recents 缺 HTTP 路由');
  assert.equal(offById.get('system.recents.touch').cli, null, 'recents.touch 是面板/serve 专用，不应有 CLI');
});

test('smoke: bootstrap 携带 recents 与 serverScope', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'nxrp-smoke-boot-'));
  process.env.NX_RP_STORE = join(tmp, 'store.json');
  try {
    const { forgetStore } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'store.js')).href);
    forgetStore();
    const sys = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'system', 'index.js')).href);
    const actions = sys.default.actions;
    const bootstrap = actions.find((a) => a.id === 'system.bootstrap');
    const b = await bootstrap.run({});
    assert.ok(Array.isArray(b.recents), 'bootstrap 应携带 recents 数组');
    assert.equal(typeof b.serverScope, 'string', 'bootstrap 应携带 serverScope');
    assert.ok(b.serverScope.length > 0);
  } finally {
    delete process.env.NX_RP_STORE;
    await rm(tmp, { recursive: true, force: true });
  }
});

test('smoke: parseServeArgs 解析（位置端口 / --port 两种形态 / --store 对跳过 / --no-open）', async () => {
  const { parseServeArgs } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'builtins.js')).href);
  assert.deepEqual(parseServeArgs([]), { port: undefined, open: true });
  assert.deepEqual(parseServeArgs(['7821']), { port: 7821, open: true });
  assert.deepEqual(parseServeArgs(['--port', '3000', '--no-open']), { port: 3000, open: false });
  assert.deepEqual(parseServeArgs(['--port=3001']), { port: 3001, open: true });
  // cli.js 会把全局 --store 以「名 值」对追加进 rest，不能把值误当端口
  assert.deepEqual(parseServeArgs(['--store', 'X', '7820']), { port: 7820, open: true });
  assert.throws(() => parseServeArgs(['--port']), /需要值/);
  assert.throws(() => parseServeArgs(['--port', 'abc']), /期望数字/);
});

test('smoke: hook status/log 只读路径可用（临时目录重定向，不碰真实数据）', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'nxrp-smoke-'));
  try {
    const paths = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
    paths.setHookPaths({
      settingsPath: join(tmp, 'settings.json'),
      promptsDir: join(tmp, 'prompts'),
      skillsDir: join(tmp, 'skills'),
    });
    const promptMod = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'hook-prompt', 'service.js')).href);
    const skillMod = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'hook-skill', 'service.js')).href);
    const st = await promptMod.hookStatus();
    assert.equal(st.enabled, false);
    assert.equal(st.settingsPath, join(tmp, 'settings.json'));
    const stSkill = await skillMod.hookStatus();
    assert.equal(stSkill.enabled, false);
    const logs = await promptMod.listPrompts({ all: false, limit: 5 });
    assert.deepEqual(logs, []);
    const skills = await skillMod.skillStats({ all: false, limit: 5 });
    assert.deepEqual(skills, []);
    // capture 的容错面：坏输入静默、不抛错
    assert.deepEqual(await promptMod.captureRaw('garbage'), { ok: false });
    assert.deepEqual(await skillMod.skillTrackRaw('garbage'), { ok: false });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

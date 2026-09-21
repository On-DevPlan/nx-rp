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
  assert.equal(pkg.default.name, 'nx-rp');
  assert.equal(pkg.default.type, 'module');
  assert.equal(pkg.default.bin['nx-rp'], 'bin/nx-rp.mjs');
});

test('smoke: registry 装载自检通过、三端命令表可生成', async () => {
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  assert.ok(ACTIONS.length > 0);
  const ids = new Set(ACTIONS.map((a) => a.id));
  for (const id of ['hook.capture', 'hook.on', 'hook.off', 'hook.status', 'hook.log']) {
    assert.ok(ids.has(id), `缺 action: ${id}`);
  }
  // 面板操作必须有 HTTP 可达的同源路由（capture 是 hook 协议专属，cli-only）
  const httpById = new Map(ACTIONS.map((a) => [a.id, a.http]));
  for (const id of ['hook.on', 'hook.off', 'hook.status', 'hook.log']) {
    assert.ok(Array.isArray(httpById.get(id)), `${id} 缺 HTTP 路由，面板无法调用`);
  }
  assert.equal(httpById.get('hook.capture'), null, 'capture 是 stdin 协议入口，不应暴露 HTTP');
});

test('smoke: hook status/log 只读路径可用（临时目录重定向，不碰真实数据）', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'nxrp-smoke-'));
  try {
    const paths = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
    paths.setHookPaths({
      settingsPath: join(tmp, 'settings.json'),
      promptsDir: join(tmp, 'prompts'),
    });
    const hook = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'hook', 'service.js')).href);
    const st = await hook.hookStatus();
    assert.equal(st.enabled, false);
    assert.equal(st.settingsPath, join(tmp, 'settings.json'));
    const logs = await hook.listPrompts({ all: false, limit: 5 });
    assert.deepEqual(logs, []);
    // capture 的容错面：坏输入静默、不抛错
    assert.deepEqual(await hook.captureRaw('garbage'), { ok: false });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

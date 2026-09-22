// ALS scope 穿透 + recents 的测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-rp-scope-'));
  const storePath = join(dir, 'store.json');
  process.env.NX_RP_STORE = storePath;
  return { dir, storePath, cleanup() { delete process.env.NX_RP_STORE; rmSync(dir, { recursive: true, force: true }); } };
}

test('ALS: scopeStorage.run 内 cwdScope/cwdDir 读到激活目录，run 外回落 process.cwd', async () => {
  const { scopeStorage, cwdScope, cwdDir, normalizeScope } = await import('../../src/core/paths.js');

  // run 外：无上下文，回落 process.cwd()
  assert.equal(cwdScope(), normalizeScope(process.cwd()));
  assert.equal(cwdDir(), process.cwd());

  // run 内：scope 归一化（resolve，Windows 上额外小写化），dir 保留原始输入
  await scopeStorage.run({ scope: 'D:\\X\\Proj', dir: 'D:\\X\\Proj' }, async () => {
    assert.equal(cwdScope(), normalizeScope('D:\\X\\Proj'));
    assert.equal(cwdDir(), 'D:\\X\\Proj');
  });

  // run 退出后上下文不泄漏
  assert.equal(cwdDir(), process.cwd());
});

test('ALS: async 链上上下文自动延续（模拟 api.js 的 run 包裹）', async () => {
  const { scopeStorage, cwdScope, normalizeScope } = await import('../../src/core/paths.js');
  const inner = () => new Promise((r) => setTimeout(() => r(cwdScope()), 10));
  const got = await scopeStorage.run({ scope: 'D:\\Y\\Z', dir: 'D:\\Y\\Z' }, inner);
  assert.equal(got, normalizeScope('D:\\Y\\Z'));
});

test('recents: touchRecent 新增置顶 + 重复去重 + 截断 + 落盘', async () => {
  const { dir, storePath, cleanup } = tmpStore();
  mkdirSync(join(dir, 'proj-a'));
  mkdirSync(join(dir, 'proj-b'));
  try {
    const { loadStore, forgetStore } = await import('../../src/core/store.js');
    const { touchRecent } = await import('../../src/modules/system/index.js');
    forgetStore();

    const a = await touchRecent(join(dir, 'proj-a'));
    // 不变量：scope key = normalizeScope(路径)。Windows 上会小写化，POSIX 保留原样——
    // 所以不能断言 toLowerCase()（那是 win 专属行为），要与 normalizeScope 对表。
    const { normalizeScope } = await import('../../src/core/paths.js');
    assert.equal(a.scope, normalizeScope(join(dir, 'proj-a')));
    await touchRecent(join(dir, 'proj-b'));

    // 重复 touch A：去重置顶，不产生第二条
    const a2 = await touchRecent(join(dir, 'proj-a'));
    const s1 = await loadStore();
    assert.equal(s1.recents.length, 2);
    assert.equal(s1.recents[0].scope, a2.scope, 'touch 后应置顶');
    assert.ok(s1.recents[0].lastUsedAt >= a.lastUsedAt, 'lastUsedAt 应更新');

    // 超限截断
    for (let i = 0; i < 25; i++) {
      mkdirSync(join(dir, 'p' + i));
      await touchRecent(join(dir, 'p' + i));
    }
    const s2 = await loadStore();
    assert.ok(s2.recents.length <= 20, `应截断到 20 条内，实际 ${s2.recents.length}`);

    // 落盘真实可见
    const onDisk = JSON.parse(readFileSync(storePath, 'utf8'));
    assert.ok(Array.isArray(onDisk.recents) && onDisk.recents.length === s2.recents.length);
  } finally {
    cleanup();
  }
});

test('recents: 不存在的路径 / 文件路径抛 invalidInput', async () => {
  const { dir, cleanup } = tmpStore();
  try {
    const { touchRecent } = await import('../../src/modules/system/index.js');
    await assert.rejects(() => touchRecent(join(dir, 'no-such-dir')), /目录不存在/);
    const filePath = join(dir, 'a-file.txt');
    (await import('node:fs')).writeFileSync(filePath, 'x', 'utf8');
    await assert.rejects(() => touchRecent(filePath), /不是目录/);
    await assert.rejects(() => touchRecent(''), /缺少目录路径/);
  } finally {
    cleanup();
  }
});

test('recents: 老数据没有 recents 字段自动补 []', async () => {
  const { storePath, cleanup } = tmpStore();
  try {
    (await import('node:fs')).writeFileSync(storePath, JSON.stringify({ version: 1, scopes: {} }), 'utf8');
    const { loadStore, forgetStore } = await import('../../src/core/store.js');
    forgetStore();
    const s = await loadStore();
    assert.deepEqual(s.recents, []);
  } finally {
    cleanup();
  }
});

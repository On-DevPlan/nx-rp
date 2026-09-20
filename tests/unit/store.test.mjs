// 存储 + cwd 作用域的纯逻辑测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('mutateStore: 原子写 + 缓存更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-rp-store-'));
  const storePath = join(dir, 'store.json');
  process.env.NX_RP_STORE = storePath;
  try {
    const { mutateStore, loadStore, forgetStore } = await import('../../src/core/store.js');

    forgetStore();

    const r1 = await mutateStore((s) => {
      s.scopes['D:/a'] = { links: [{ id: 'l1', url: 'https://x' }], docs: [], workflows: {} };
      return s.scopes['D:/a'];
    });
    assert.equal(r1.links.length, 1);

    // 文件被实际写入
    const onDisk = JSON.parse(readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.scopes['D:/a'].links.length, 1);

    // 缓存能看见
    const back = await loadStore();
    assert.equal(back.scopes['D:/a'].links.length, 1);
  } finally {
    delete process.env.NX_RP_STORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalize: 老数据缺新字段自动补默认值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-rp-store-'));
  const storePath = join(dir, 'store.json');
  process.env.NX_RP_STORE = storePath;
  try {
    // 写一个旧版格式（只有 version + scopes[cwd].links）
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      scopes: { 'D:/a': { links: [] } },  // 没有 docs / workflows
    }), 'utf8');

    const { loadStore, forgetStore } = await import('../../src/core/store.js');
    forgetStore();
    const s = await loadStore();
    assert.ok(s.scopes['D:/a'], 'scope 应在');
    assert.ok(Array.isArray(s.scopes['D:/a'].docs), 'docs 应自动补默认值');
    assert.ok(s.scopes['D:/a'].workflows && typeof s.scopes['D:/a'].workflows === 'object', 'workflows 应自动补默认值');
    assert.equal(s.settings.defaultPort, 7820, 'settings.defaultPort 应自动补默认值');
  } finally {
    delete process.env.NX_RP_STORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cwd 隔离：mutateStore 只在当前 process.cwd() 对应的 scope 写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-rp-store-'));
  const storePath = join(dir, 'store.json');
  process.env.NX_RP_STORE = storePath;
  const prevCwd = process.cwd();
  try {
    const { mutateStore, forgetStore } = await import('../../src/core/store.js');
    forgetStore();

    // 模拟两个不同 cwd 的 scope 隔离
    const { cwdScope } = await import('../../src/core/paths.js');
    const a = cwdScope();
    assert.ok(a.length > 0, 'cwdScope 应有值');

    // 在当前 cwd 下 mutate，直接走 mutateStore 验证隔离语义
    await mutateStore((store) => {
      const k = cwdScope();
      if (!store.scopes[k]) store.scopes[k] = { links: [], docs: [], workflows: {} };
      store.scopes[k].links.push({ id: 'l_curr', url: 'https://now' });
      return store.scopes[k];
    });

    // 读出来看 scope 键确实是 cwd
    const { loadStore } = await import('../../src/core/store.js');
    const back = await loadStore();
    assert.ok(back.scopes[a], '当前 cwd 应在 scopes 里');
    assert.equal(back.scopes[a].links.length, 1);
    // 其它 scope 不应有副作用
    for (const k of Object.keys(back.scopes)) {
      assert.equal(k, a, '不应有其它 scope 被自动创建');
    }
  } finally {
    process.chdir(prevCwd);
    delete process.env.NX_RP_STORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutateStore: fn 抛错则整个事务不落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-rp-store-'));
  const storePath = join(dir, 'store.json');
  process.env.NX_RP_STORE = storePath;
  try {
    const { mutateStore, forgetStore } = await import('../../src/core/store.js');
    forgetStore();

    await assert.rejects(() => mutateStore((s) => {
      s.scopes['D:/a'] = { links: [], docs: [], workflows: {} };
      s.scopes['D:/a'].links.push({ id: 'l_x', url: 'https://x' });
      throw new Error('boom');
    }), /boom/);

    // 文件不存在（未落盘）
    const exists = await import('node:fs/promises').then(({ stat }) => stat(storePath).then(() => true, () => false));
    assert.equal(exists, false, '事务抛错不应创建文件');
  } finally {
    delete process.env.NX_RP_STORE;
    rmSync(dir, { recursive: true, force: true });
  }
});
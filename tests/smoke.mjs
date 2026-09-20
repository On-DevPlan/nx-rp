// 占位：完整 smoke 测试在 nx-rp 上线后补，先保证 tests/ 不空、pnpm test 不会因 glob 展开失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('smoke: 包结构合法', async () => {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  assert.equal(pkg.default.name, 'nx-rp');
  assert.equal(pkg.default.type, 'module');
  assert.equal(pkg.default.bin['nx-rp'], 'bin/nx-rp.mjs');
});
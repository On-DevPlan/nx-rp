// 占位：核心层的纯逻辑单测。完整测试在各功能模块到位后补。
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('errors: CODES 完整、互斥', async () => {
  const { CODES } = await import('../../src/core/errors.js');
  for (const k of ['INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'BLOCKED', 'EXTERNAL', 'INTERNAL']) {
    assert.ok(CODES[k], `缺少 code: ${k}`);
  }
});

test('errors: httpStatusOf 映射', async () => {
  const { httpStatusOf } = await import('../../src/core/errors.js');
  assert.equal(httpStatusOf('INVALID_INPUT'), 400);
  assert.equal(httpStatusOf('NOT_FOUND'), 404);
  assert.equal(httpStatusOf('CONFLICT'), 409);
  assert.equal(httpStatusOf('BLOCKED'), 409);
  assert.equal(httpStatusOf('EXTERNAL'), 502);
  assert.equal(httpStatusOf('INTERNAL'), 500);
  assert.equal(httpStatusOf('UNKNOWN'), 500);
});

test('errors: toErrorPayload 处理 AppError 与普通 Error', async () => {
  const { toErrorPayload, AppError, CODES } = await import('../../src/core/errors.js');
  const ae = new AppError(CODES.NOT_FOUND, '缺失: foo');
  const p1 = toErrorPayload(ae);
  assert.equal(p1.code, 'NOT_FOUND');
  assert.equal(p1.message, '缺失: foo');
  const e = new Error('boom');
  const p2 = toErrorPayload(e);
  assert.equal(p2.code, 'INTERNAL');
});
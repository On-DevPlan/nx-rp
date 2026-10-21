// runtime/api.js 的请求体解析契约。
//
// 关键一条：**坏 JSON 必须报错，不许静默变成 {}**。
// 静默吞掉等于「请求体没带」——对清理/删除这类动作就是「按默认值动手」：
// 实测里 cwd 与 dryRun 一起丢，结果清错了范围还真的删了数据。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
const pathsMod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
const apiUrl = () => pathToFileURL(join(ROOT, 'src', 'runtime', 'api.js')).href;

// 造一个最小可用的 req/res：req 只需 method / headers / async iterator，res 只需 writeHead / end。
function mockReq(body, { method = 'POST', headers = {} } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body, 'utf8');
    },
  };
}

function mockRes() {
  const out = { status: 0, payload: null };
  return {
    out,
    writeHead(status) { out.status = status; },
    end(text) { out.payload = JSON.parse(text); },
  };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-apibody-'));
  pathsMod.setHookPaths({
    settingsPath: join(tmp, 'settings.json'),
    promptsDir: join(tmp, 'prompts'),
    skillsDir: join(tmp, 'skills'),
    snapshotsDir: join(tmp, 'snapshots'),
  });
  await mkdir(join(tmp, 'prompts'), { recursive: true });
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

test('POST 请求体是坏 JSON → 400 报错，不许静默当成空 body 去按默认值动手', async () => {
  const { handleApi } = await import(apiUrl());
  const res = mockRes();
  await handleApi(
    mockReq('{"cwd": "D:\\bad\\path", "dryRun": true}'),
    res,
    new URL('http://127.0.0.1/api/hook-prompt/clean'),
  );
  assert.equal(res.out.payload.ok, false, '坏请求体必须报错');
  assert.equal(res.out.payload.code, 'INVALID_INPUT');
  assert.equal(res.out.status, 400);
});

test('POST 空 body → 视作 {}（正常的「不带参数」调用不该报错）', async () => {
  const { handleApi } = await import(apiUrl());
  const res = mockRes();
  await handleApi(
    mockReq(''),
    res,
    new URL('http://127.0.0.1/api/hook-prompt/clean'),
  );
  // 走到 action 即为「body 正常解析」；clean 在空目录上无事可做
  assert.equal(res.out.payload.ok, true, '空 body 不该报错');
  assert.equal(res.out.payload.data.removed, 0);
});

test('POST 合法 JSON → 参数真的传到了 action（dryRun 生效，不写盘）', async () => {
  const { handleApi } = await import(apiUrl());
  const res = mockRes();
  await handleApi(
    mockReq(JSON.stringify({ all: true, dryRun: true })),
    res,
    new URL('http://127.0.0.1/api/hook-prompt/clean'),
  );
  assert.equal(res.out.payload.ok, true);
  assert.equal(res.out.payload.data.dryRun, true, 'dryRun 必须传到 action');
  assert.deepEqual(res.out.payload.data.snapshots, [], 'dry-run 不该留快照');
});

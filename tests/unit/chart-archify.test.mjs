// chart·archify 子模块单测：登记关系（scope 存储）与发现。
//
// 覆盖面：
//   1. add/remove/list——拷贝语义、archify 标识软校验、缺失标记
//   2. discover——.archify/ 一层扫描、登记去重（按 source 归一路径）
//   3. action 声明——CLI/HTTP 两端接线
// 不测自动出图：archify 子模块刻意不调 archify CLI、不从源码自动生成
// （机器自动生成的架构图不可信）——图一律出自 archify skill。
// 路径隔离：scope 存储指向临时目录（setHookPaths），fixture 全在临时目录。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
const modUrl = (p) => pathToFileURL(join(ROOT, p)).href;

let tmp;       // fixture（cwd 语义：.archify/ 扫描、add 的相对基准）
let store;     // scope 存储根（ARCHIFY_DIR 覆盖）
let savedArchifyDir;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-arch-'));
  store = await mkdtemp(join(tmpdir(), 'nxrp-arch-store-'));
  const paths = await import(modUrl('src/core/paths.js'));
  savedArchifyDir = paths.ARCHIFY_DIR;
  paths.setHookPaths({ archifyDir: store });
});

afterEach(async () => {
  const paths = await import(modUrl('src/core/paths.js'));
  paths.setHookPaths({ archifyDir: savedArchifyDir });
  await rm(tmp, { recursive: true, force: true });
  await rm(store, { recursive: true, force: true });
});

const archify = () => import(modUrl('src/modules/chart/archify.js'));

// 最小 archify 产物：标识在头部 4KB 内即可过软校验
const FAKE_HTML = '<!DOCTYPE html><html><head><meta name="archify-reader-contract" content="declared-wide-v1"><meta name="generator" content="archify 3.0.1"></head><body><svg></svg></body></html>';
const FAKE_CAND = JSON.stringify({
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'Web Architecture', output: 'web.html' },
});

async function seed(rel, content) {
  const abs = join(tmp, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  return abs;
}

// ============================================================
// add / list / remove（scope 存储指向 store 临时目录）
// ============================================================

test('add：拷贝语义 + candidate 元数据抽取 + 中文名 id', async () => {
  const { addDiagram, listDiagrams, readDiagram } = await archify();
  const html = await seed('out/web.html', FAKE_HTML);
  const cand = await seed('out/candidate.json', FAKE_CAND);
  const r = await addDiagram({ file: html, candidate: cand, name: 'Web 架构', baseDir: tmp });
  assert.equal(r.overwritten, false);
  assert.equal(r.id, 'Web-架构');
  assert.equal(r.type, 'architecture');
  assert.equal(r.title, 'Web Architecture');
  // 副本落在 scope 存储
  const listed = await listDiagrams({ baseDir: tmp });
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].present, true);
  assert.equal(listed.entries[0].source, r.source);
  // readDiagram 定位到的文件可读
  const view = await readDiagram({ id: r.id, baseDir: tmp });
  assert.equal(view.contentType, 'text/html; charset=utf-8');
  await access(view.abs); // 存在
});

test('add：非 archify HTML / 非法输入拒绝', async () => {
  const { addDiagram } = await archify();
  const bad = await seed('bad.html', '<!DOCTYPE html><html><body>plain</body></html>');
  await assert.rejects(() => addDiagram({ file: bad, baseDir: tmp }), /不是 archify 产物/);
  const notFoundCase = join(tmp, 'missing.html');
  await assert.rejects(() => addDiagram({ file: notFoundCase, baseDir: tmp }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(() => addDiagram({ file: '   ', baseDir: tmp }), /缺少 --file/);
});

test('add：同名覆盖；损坏 candidate 报错', async () => {
  const { addDiagram } = await archify();
  const html = await seed('out/web.html', FAKE_HTML);
  await addDiagram({ file: html, name: 'web', baseDir: tmp });
  const r2 = await addDiagram({ file: html, name: 'web', baseDir: tmp });
  assert.equal(r2.overwritten, true);
  await assert.rejects(() => addDiagram({ file: html, candidate: '{broken', baseDir: tmp }), /candidate JSON 解析失败/);
});

test('list：按 id 字典序；文件缺失标记 present=false', async () => {
  const { addDiagram, listDiagrams } = await archify();
  const html = await seed('out/web.html', FAKE_HTML);
  await addDiagram({ file: html, name: 'web', baseDir: tmp });
  const html2 = await seed('out/api.html', FAKE_HTML);
  await addDiagram({ file: html2, name: 'api', baseDir: tmp });

  const listed = await listDiagrams({ baseDir: tmp });
  assert.deepEqual(listed.entries.map((e) => e.id), ['api', 'web'], '按 id 字典序');
  // 删掉副本 → present=false
  const { readdir, rm: rmf } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  const scopeDir = j(store, (await readdir(store))[0]);
  await rmf(j(scopeDir, 'web.html'));
  const after = await listDiagrams({ baseDir: tmp });
  assert.equal(after.entries.find((e) => e.id === 'web').present, false);
  assert.equal(after.entries.find((e) => e.id === 'api').present, true);
});

test('remove：未登记 404；移除后登记与副本都消失（原产物不动）', async () => {
  const { addDiagram, removeDiagram, listDiagrams } = await archify();
  const html = await seed('out/web.html', FAKE_HTML);
  const r = await addDiagram({ file: html, name: 'web', baseDir: tmp });
  await assert.rejects(() => removeDiagram({ id: 'nope', baseDir: tmp }), (e) => e.code === 'NOT_FOUND');
  const removed = await removeDiagram({ id: r.id, baseDir: tmp });
  assert.equal(removed.id, r.id);
  const listed = await listDiagrams({ baseDir: tmp });
  assert.equal(listed.entries.length, 0);
  await access(html); // .archify 原产物不受影响
});

// ============================================================
// discover：.archify/ 一层扫描
// ============================================================

test('discover：未登记被发现；add 后按归一 source 判定已登记', async () => {
  const { discoverDiagrams, addDiagram } = await archify();
  const html = await seed('.archify/architecture-web-20261011-120000/web.html', FAKE_HTML);
  const cand = await seed('.archify/architecture-web-20261011-120000/candidate.json', FAKE_CAND);
  // 干扰项：没有 HTML 的文件夹跳过
  await seed('.archify/workflow-x-20261011-130000/candidate.json', '{}');

  const d1 = await discoverDiagrams({ baseDir: tmp });
  assert.equal(d1.items.length, 1, '只发现含 HTML 的产物目录');
  assert.equal(d1.items[0].registered, false);
  assert.equal(d1.items[0].type, 'architecture');
  assert.equal(d1.items[0].title, 'Web Architecture');

  await addDiagram({ file: html, candidate: cand, baseDir: tmp }); // name 缺省 → candidate 标题
  const d2 = await discoverDiagrams({ baseDir: tmp });
  assert.equal(d2.items[0].registered, true, '登记后的 source 路径应与发现一致');
});

test('discover：无 .archify 目录 → 空清单不抛错', async () => {
  const { discoverDiagrams } = await archify();
  const d = await discoverDiagrams({ baseDir: tmp });
  assert.deepEqual(d.items, []);
});

// ============================================================
// action 声明：CLI/HTTP 两端接线
// ============================================================

test('chart.archify.*：四条子命令接线 + view 双端形态（HTTP 流式 / CLI 报路径）', async () => {
  const { ACTIONS } = await import(modUrl('src/runtime/registry.js'));
  const byId = (id) => ACTIONS.find((a) => a.id === id);
  const cases = [
    ['chart.archify.list', ['chart', 'archify', 'list'], ['GET', '/api/chart/archify']],
    ['chart.archify.discover', ['chart', 'archify', 'discover'], ['GET', '/api/chart/archify/discover']],
    ['chart.archify.add', ['chart', 'archify', 'add'], ['POST', '/api/chart/archify/add']],
    ['chart.archify.remove', ['chart', 'archify', 'remove'], ['POST', '/api/chart/archify/remove']],
  ];
  for (const [id, cli, http] of cases) {
    const a = byId(id);
    assert.ok(a, `${id} 必须存在`);
    assert.deepEqual(a.cli, cli, id);
    assert.deepEqual(a.http, http, id);
  }
  assert.ok(!byId('chart.archify.generate'), '自动生成已移除——图一律出自 archify skill');
  const view = byId('chart.archify.view');
  assert.ok(view, 'chart.archify.view 必须存在');
  assert.equal(view.streamResponse, true, 'view 的 HTTP 形态必须流式直出 HTML');
  assert.deepEqual(view.cli, ['chart', 'archify', 'view'], 'view 保留 CLI 形态（打印文件路径）');
  assert.deepEqual(view.http, ['GET', '/api/chart/archify/view/:id']);
});

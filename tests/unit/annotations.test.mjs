// annotations 单测：文件加载器（1000 字符上限 / 二进制拒绝 / --full）+ 批注 CRUD + 跨文件待办。
// 存储重定向到临时目录，绝不碰真实 ~/.nx-rp/annotations。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
const svcUrl = () => pathToFileURL(join(ROOT, 'src', 'modules', 'annotations', 'service.js')).href;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-ann-'));
  const mod = await import(svcUrl());
  mod.setAnnotationsDir(join(tmp, 'annotations'));
});

afterEach(async () => {
  const mod = await import(svcUrl());
  mod.setAnnotationsDir(join(process.env.USERPROFILE || process.env.HOME, '.nx-rp', 'annotations'));
  await rm(tmp, { recursive: true, force: true });
});

// ─── 文件加载器 ────────────────────────────────────────────────────

test('loadFile：小文件全量返回；>1000 字符拒绝渲染（truncated + body null）', async () => {
  const mod = await import(svcUrl());
  const small = join(tmp, 'small.txt');
  await writeFile(small, 'hello 批注', 'utf8');
  const r1 = await mod.loadFile({ file: small });
  assert.equal(r1.truncated, false);
  assert.equal(r1.body, 'hello 批注');
  assert.equal(r1.totalChars, 8);

  const big = join(tmp, 'big.txt');
  await writeFile(big, 'x'.repeat(1500), 'utf8');
  const r2 = await mod.loadFile({ file: big });
  assert.equal(r2.truncated, true);
  assert.equal(r2.body, null, '超限必须拒绝渲染——不给半截内容');
  assert.equal(r2.totalChars, 1500);
  assert.ok(r2.message.includes('1000'));

  // --full 放行（1500 < 200K 硬上限）
  const r3 = await mod.loadFile({ file: big, full: true });
  assert.equal(r3.truncated, false);
  assert.equal(r3.body.length, 1500);
});

test('loadFile：二进制（NUL）拒绝；文件不存在 notFound；相对路径拒绝', async () => {
  const mod = await import(svcUrl());
  const bin = join(tmp, 'blob.bin');
  await writeFile(bin, Buffer.from([0x89, 0x50, 0x00, 0x4e]));
  await assert.rejects(() => mod.loadFile({ file: bin }), /二进制/);

  await assert.rejects(() => mod.loadFile({ file: join(tmp, 'nope.txt') }), /文件不存在/);
  await assert.rejects(() => mod.loadFile({ file: 'relative/path.txt' }), /绝对/);
});

test('loadFile：超过 200K 硬上限连 --full 也拒绝', async () => {
  const mod = await import(svcUrl());
  const huge = join(tmp, 'huge.txt');
  await writeFile(huge, 'y'.repeat(201_000), 'utf8');
  await assert.rejects(() => mod.loadFile({ file: huge }), /文件过大/);
  await assert.rejects(() => mod.loadFile({ file: huge, full: true }), /文件过大/);
});

// ─── 批注 CRUD ────────────────────────────────────────────────────

test('add/list/update/remove：按文件分桶；todo 有 done；review/note 无 done', async () => {
  const mod = await import(svcUrl());
  const f1 = join(tmp, 'a.ts');
  const f2 = join(tmp, 'b.ts');
  await writeFile(f1, 'x', 'utf8');
  await writeFile(f2, 'x', 'utf8');

  const note = await mod.addAnnotation({ file: f1, kind: 'note', body: '这段设计有点绕', line: 42 });
  const review = await mod.addAnnotation({ file: f1, kind: 'review', body: '好评，外科手术式' });
  const todo = await mod.addAnnotation({ file: f1, kind: 'todo', body: '补单测' });
  await mod.addAnnotation({ file: f2, kind: 'note', body: '另一个文件的思考' });

  // 分桶：f1 只有 3 条
  const l1 = await mod.listAnnotations({ file: f1 });
  assert.equal(l1.length, 3);
  assert.equal(l1[0].body, '补单测', '最新在前');

  // kind 过滤
  const todos = await mod.listAnnotations({ file: f1, kind: 'todo' });
  assert.equal(todos.length, 1);
  assert.equal(todos[0].done, false);

  // done 翻转：todo 可以，note 拒绝
  const t = await mod.updateAnnotation({ file: f1, id: todo.id, done: true });
  assert.equal(t.done, true);
  assert.ok(t.doneAt);
  await assert.rejects(() => mod.updateAnnotation({ file: f1, id: note.id, done: true }), /只有 todo/);

  // 删除
  await mod.removeAnnotation({ file: f1, id: review.id });
  assert.equal((await mod.listAnnotations({ file: f1 })).length, 2);

  // 非法 kind / 空 body / 非法 line
  await assert.rejects(() => mod.addAnnotation({ file: f1, kind: 'bogus', body: 'x' }), /kind/);
  await assert.rejects(() => mod.addAnnotation({ file: f1, body: '  ' }), /不能为空/);
  await assert.rejects(() => mod.addAnnotation({ file: f1, body: 'x', line: 0 }), /行号/);
});

test('listAllTodos：跨文件聚合未完成 todo，完成的与别的 kind 不出现', async () => {
  const mod = await import(svcUrl());
  const f1 = join(tmp, 'a.ts');
  const f2 = join(tmp, 'b.ts');
  await writeFile(f1, 'x', 'utf8');
  await writeFile(f2, 'x', 'utf8');

  const t1 = await mod.addAnnotation({ file: f1, kind: 'todo', body: 'todo A' });
  await mod.addAnnotation({ file: f2, kind: 'todo', body: 'todo B' });
  await mod.addAnnotation({ file: f1, kind: 'note', body: 'note 不是 todo' });

  let all = await mod.listAllTodos();
  assert.equal(all.length, 2);

  await mod.updateAnnotation({ file: f1, id: t1.id, done: true });
  all = await mod.listAllTodos();
  assert.equal(all.length, 1);
  assert.equal(all[0].body, 'todo B');
});

test('批注桶文件名是序列化路径（全 ASCII，同一文件同一桶）', async () => {
  const mod = await import(svcUrl());
  const { serializePath } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
  const f = join(tmp, '中文 目录', 'x.ts');
  await mod.addAnnotation({ file: f, body: '中文路径也可以挂批注' });
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(join(tmp, 'annotations'));
  assert.ok(files.includes(serializePath(f) + '.json'), `桶名=${files.join(',')}`);
  assert.doesNotMatch(files.join(','), /[^A-Za-z0-9_.-]/);
});

test('registry：annotations 声明 resource，CRUD 五操作 + load/todos 双端可达', async () => {
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const ids = new Set(ACTIONS.map((a) => a.id));
  for (const id of ['annotation.list', 'annotation.get', 'annotation.add', 'annotation.update', 'annotation.remove', 'annotation.load', 'annotation.todos']) {
    assert.ok(ids.has(id), `缺 action: ${id}`);
  }
  const httpById = new Map(ACTIONS.map((a) => [a.id, a.http]));
  for (const id of ['annotation.list', 'annotation.get', 'annotation.add', 'annotation.update', 'annotation.remove', 'annotation.load', 'annotation.todos']) {
    assert.ok(Array.isArray(httpById.get(id)), `${id} 缺 HTTP`);
  }
});

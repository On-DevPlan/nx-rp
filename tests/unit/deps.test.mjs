// deps 模块单测：扫描准确性是本模块的唯一职责。
//
// fixture 树覆盖五类判定：
//   1. 词法清洗——注释/字符串/模板串里的 import 文本不是依赖（假边）
//   2. 正则字面量——/re/ 里的引号和 // 不被误判成字符串/注释
//   3. JS 家族全覆盖——.jsx/.mjs 与 .js 同等参与（漏了 web 层整个不可见）
//   4. 解析顺序——显式扩展名 / 补 .js / 目录 index.js
//   5. 去重——多文件指向同一目标只留一条边
// 路径隔离：fixture 全部在临时目录，绝不碰真实源码。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
const serviceUrl = () => pathToFileURL(join(ROOT, 'src', 'modules', 'deps', 'service.js')).href;

let tmp;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-deps-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function seed(rel, content) {
  const abs = join(tmp, rel);
  await mkdir(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

async function scan(root = 'src') {
  const { collectDeps } = await import(serviceUrl());
  return collectDeps(join(tmp, root));
}

test('词法清洗：注释/字符串/模板串里的 import 是假边', async () => {
  await seed('src/a.js', `
    import { x } from './real.js';
    // import { fake1 } from './comment-only.js';
    /* import { fake2 } from './block-comment.js'; */
    const s = "import { fake3 } from './in-string.js';";
    const t = \`import { fake4 } from './in-template.js'\`;
    export const y = x;
  `);
  await seed('src/real.js', 'export const x = 1;\n');
  const { ids, edges } = await scan();
  assert.deepEqual(edges, [{ from: 'a', to: 'real' }], '只有真 import 成边: ' + JSON.stringify(edges));
  assert.ok(ids.includes('a') && ids.includes('real'));
});

test('正则字面量：/re/ 里的引号与 // 不误判', async () => {
  await seed('src/a.js', `
    import { x } from './real.js';
    const re = /import.*from.*'.\\/fake.js'/;  // 字符类和引号都在正则里
    const div = x / 2;                         // 除法不能被当成正则起点
    export const y = div;
  `);
  await seed('src/real.js', 'export const x = 1;\n');
  const { edges } = await scan();
  assert.deepEqual(edges, [{ from: 'a', to: 'real' }], JSON.stringify(edges));
});

test('.jsx/.mjs 与 .js 同等参与扫描', async () => {
  await seed('src/App.jsx', `import { btn } from './btn.jsx';\nimport { util } from './lib/util.mjs';\nexport default App;\n`);
  await seed('src/btn.jsx', 'export const btn = 1;\n');
  await seed('src/lib/util.mjs', 'export const util = 1;\n');
  const { ids, edges } = await scan();
  assert.ok(ids.includes('App') && ids.includes('btn') && ids.includes('lib.util'), 'ids: ' + JSON.stringify(ids));
  assert.equal(edges.length, 2, JSON.stringify(edges));
});

test('裸包名（react 等）不进图', async () => {
  await seed('src/a.js', `import React from 'react';\nimport { x } from './real.js';\nimport fsp from 'node:fs/promises';\nexport const y = x;\n`);
  await seed('src/real.js', 'export const x = 1;\n');
  const { ids, edges } = await scan();
  assert.deepEqual(edges, [{ from: 'a', to: 'real' }]);
  assert.ok(!ids.some((id) => /react|node/.test(id)), '外部包不应成为节点: ' + JSON.stringify(ids));
});

test('解析顺序：显式扩展名 / 补 .js / 目录 index.js', async () => {
  await seed('src/explicit.js', `import { a } from './lib/impl.js';\nexport {};\n`);
  await seed('src/lib/impl.js', 'export const a = 1;\n');
  await seed('src/bare.js', `import { b } from './lib/impl';\nexport {};\n`);        // 补 .js
  await seed('src/dirimport.js', `import { c } from './pkg';\nexport {};\n`);        // 目录 index
  await seed('src/pkg/index.js', 'export const c = 1;\n');
  const { edges } = await scan();
  const set = edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(set, [
    'bare->lib.impl',
    'dirimport->pkg.index',   // 目录导入落到真实文件 pkg/index.js，id 保留文件名
    'explicit->lib.impl',
  ], JSON.stringify(set));
});

test('边全局去重：多文件指向同一目标只留一条', async () => {
  await seed('src/shared.js', 'export const s = 1;\n');
  await seed('src/a1.js', `import { s } from './shared.js';\nimport { s2 } from './shared.js';\nexport {};\n`);
  await seed('src/a2.js', `import { s } from './shared.js';\nexport {};\n`);
  const { edges } = await scan();
  const toShared = edges.filter((e) => e.to === 'shared');
  assert.equal(toShared.length, 2, 'a1 与 a2 各一条（文件级唯一），同文件重复 import 去重: ' + JSON.stringify(edges));
});

test('动态 import() 也算边', async () => {
  await seed('src/a.js', `export async function load() { return (await import('./lazy.js')).v; }\n`);
  await seed('src/lazy.js', 'export const v = 1;\n');
  const { edges } = await scan();
  assert.deepEqual(edges, [{ from: 'a', to: 'lazy' }], JSON.stringify(edges));
});

test('stripCommentsAndStrings：位置不变、代码结构保留', async () => {
  const { stripCommentsAndStrings } = await import(serviceUrl());
  const src = `const a = 1; // hidden "import x from 'y'"
const s = "let b = 2;";
const re = /c\\/d/; const after = 3;`;
  const out = stripCommentsAndStrings(src);
  assert.equal(out.length, src.length, '清洗不改变长度');
  assert.match(out, /const a = 1;/);
  assert.doesNotMatch(out, /hidden/);
  assert.doesNotMatch(out, /let b = 2/);
  assert.match(out, /const after = 3;/, '正则后面的代码保留');
});

test('depsToDot：分层着色 + 跨层统计 + stats', async () => {
  await seed('src/core/store.js', 'export {};\n');
  await seed('src/modules/doc/service.js', `import { s } from '../../core/store.js';\nexport {};\n`);
  const g = await (async () => {
    const mod = await import(serviceUrl());
    return mod.depsToDot(join(tmp, 'src'));
  })();
  assert.equal(g.stats.files, 2);
  assert.equal(g.stats.edges, 1);
  assert.equal(g.stats.crossLayer, 1, 'core←modules 是跨层');
  assert.match(g.dot, /digraph nx_rp_dependencies \{/);
  assert.match(g.dot, /"modules\.doc\.service" -> "core\.store" \[color="#dc2626"\]/);
});

test('空目录 / 无 src：stats 全零不抛错', async () => {
  const mod = await import(serviceUrl());
  const g = await mod.depsToDot(join(tmp, 'src'));
  assert.deepEqual(g.stats, { files: 0, edges: 0, crossLayer: 0 });
  assert.match(g.dot, /digraph nx_rp_dependencies \{/);
});

// ============================================================
// saveDot / loadDot（baseDir 注入 tmp，不碰 cwd）
// ============================================================

const DOT_SAMPLE = 'digraph nx_rp_dependencies { "a" -> "b"; }';

test('saveDot：正常写入 + 绝对路径/bytes 返回；二次保存 overwritten', async () => {
  const { saveDot } = await import(serviceUrl());
  const r1 = await saveDot({ file: 'out.dot', dot: DOT_SAMPLE, baseDir: tmp });
  assert.equal(r1.file, join(tmp, 'out.dot'));
  assert.equal(r1.overwritten, false);
  assert.ok(r1.bytes > 0);
  const r2 = await saveDot({ file: 'out.dot', dot: DOT_SAMPLE, baseDir: tmp });
  assert.equal(r2.overwritten, true);
});

test('saveDot：子目录自动创建；.gv 扩展名合法', async () => {
  const { saveDot } = await import(serviceUrl());
  const r = await saveDot({ file: 'sub/dir/graph.gv', dot: DOT_SAMPLE, baseDir: tmp });
  assert.equal(r.file, join(tmp, 'sub', 'dir', 'graph.gv'));
});

test('saveDot：非法输入全部拒绝', async () => {
  const { saveDot } = await import(serviceUrl());
  await assert.rejects(() => saveDot({ file: 'x.txt', dot: DOT_SAMPLE, baseDir: tmp }),
    /扩展名必须是 \.dot\/\.gv/);
  await assert.rejects(() => saveDot({ file: join(tmp, 'abs.dot'), dot: DOT_SAMPLE, baseDir: tmp }),
    /cwd 相对路径/);
  await assert.rejects(() => saveDot({ file: 'a/../../escape.dot', dot: DOT_SAMPLE, baseDir: tmp }),
    /'\.\.'/);
  await assert.rejects(() => saveDot({ file: 'x.dot', dot: '   ', baseDir: tmp }),
    /空内容不保存/);
  await assert.rejects(() => saveDot({ file: 'x.dot', dot: 'a\0b', baseDir: tmp }),
    /二进制内容/);
  await assert.rejects(() => saveDot({ file: 'x.dot', dot: 'x'.repeat(2 * 1024 * 1024 + 1), baseDir: tmp }),
    /超限/);
});

test('loadDot：读回一致（round-trip）', async () => {
  const { saveDot, loadDot } = await import(serviceUrl());
  await saveDot({ file: 'rt.dot', dot: DOT_SAMPLE, baseDir: tmp });
  const r = await loadDot({ file: join(tmp, 'rt.dot'), baseDir: tmp }); // 绝对路径读
  assert.equal(r.chars, DOT_SAMPLE.length);
  assert.equal(r.dot, DOT_SAMPLE);
});

test('loadDot：不存在 / 超限 / 二进制 拒绝', async () => {
  const { loadDot } = await import(serviceUrl());
  await assert.rejects(() => loadDot({ file: join(tmp, 'nope.dot'), baseDir: tmp }),
    (e) => e.code === 'NOT_FOUND');
  // 造超限文件与二进制文件
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(tmp, 'big.dot'), 'x'.repeat(200_001), 'utf8');
  await writeFile(join(tmp, 'bin.dot'), Buffer.from([0x64, 0x00, 0x69, 0x67]));
  await assert.rejects(() => loadDot({ file: join(tmp, 'big.dot'), baseDir: tmp }),
    /超限/);
  await assert.rejects(() => loadDot({ file: join(tmp, 'bin.dot'), baseDir: tmp }),
    /二进制内容/);
});

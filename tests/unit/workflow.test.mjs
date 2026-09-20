// workflow 服务测试：JS 一等格式下的校验 + 运行 + CRUD。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as service from '../../src/modules/workflow/service.js';

function tempFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'nx-rp-wf-'));
  const path = join(dir, 'wf.mjs');
  writeFileSync(path, body, 'utf8');
  return { dir, path };
}

const VALID = `export default async function run(ctx) {
  await ctx.step('hello', () => 'world');
}`;

const NO_DEFAULT = `export const run = async () => 1;`;

test('validateWorkflow: 合法 export default 通过', async () => {
  const { path, dir } = tempFile(VALID);
  try {
    const r = await service.validateWorkflow(path);
    assert.equal(r.hasDefault, true);
    assert.equal(r.isAsync, true);
    assert.equal(r.name, 'run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateWorkflow: 缺 default 报错', async () => {
  const { path, dir } = tempFile(NO_DEFAULT);
  try {
    await assert.rejects(() => service.validateWorkflow(path), /必须 export default/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateWorkflow: 不存在的文件报错', async () => {
  await assert.rejects(() => service.validateWorkflow('/tmp/__nx_rp_no_such__.mjs'), /加载失败/);
});

test('runWorkflowFile: 节点事件正确发', async () => {
  const { path, dir } = tempFile(`export default async function run(ctx) {
  await ctx.step('a', () => 1);
  await ctx.parallel({ b: () => 2, c: () => 3 });
}`);
  try {
    const stream = await service.runWorkflowFile(path);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    // graph 事件 + nodeStart/Done 帧混合
    assert.match(text, /event: graph\ndata: \{"nodes":\[\{"id":"n1","name":"a"/);
    // n3 / n4 出现在图里（node 列表里有），且含 parallel 边
    assert.match(text, /"id":"n3","name":"b"/);
    assert.match(text, /"id":"n4","name":"c"/);
    // 三种边类型至少出现一次
    assert.match(text, /"type":"parallel"/);
    assert.match(text, /"type":"seq"/);
    // 节点开始 / 结束事件
    assert.match(text, /event: nodeStart\ndata: \{"id":"n1","name":"a"\}/);
    assert.match(text, /event: nodeDone\ndata: \{"id":"n1","name":"a","ok":true/);
    assert.match(text, /event: done\ndata: \{"ok":true/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runWorkflowFile: 节点失败 → done.ok=false', async () => {
  const { path, dir } = tempFile(`export default async function run(ctx) {
  await ctx.step('bad', () => { throw new Error('boom'); });
}`);
  try {
    const stream = await service.runWorkflowFile(path);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    // 错误通过 error 事件冒泡（不再嵌在 nodeDone 里）
    assert.match(text, /event: error\ndata: \{"message":"boom"\}/);
    assert.match(text, /"ok":false/);
    // done 帧存在
    assert.match(text, /event: done\ndata: \{"ok":false/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listWorkflows + saveWorkflow + removeWorkflow: 完整 CRUD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-rp-store-'));
  const storePath = join(dir, 'store.json');
  const wfDir = join(dir, 'wf-src');
  mkdirSync(wfDir, { recursive: true });
  process.env.NX_RP_STORE = storePath;
  try {
    const { forgetStore } = await import('../../src/core/store.js');
    forgetStore();

    const filePath = join(wfDir, 'demo.mjs');
    writeFileSync(filePath, VALID, 'utf8');

    const saved = await service.saveWorkflow('demo', filePath);
    assert.equal(saved.name, 'demo');

    const list = await service.listWorkflows();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'demo');

    // 重新 add 应正常（saveWorkflow 是 create-or-update）
    await service.saveWorkflow('demo', filePath);

    await service.removeWorkflow('demo');
    const after = await service.listWorkflows();
    assert.equal(after.length, 0);
  } finally {
    delete process.env.NX_RP_STORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveWorkflow: 不存在的文件报错', async () => {
  await assert.rejects(
    () => service.saveWorkflow('x', '/tmp/__nx_rp_no__.mjs'),
    /不存在/,
  );
});
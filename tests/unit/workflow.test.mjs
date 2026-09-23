// workflow 极简版单测：DOT 解析 + 校验 + 文件 IO。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;
let origCwd;
let fakeCwd;

const serviceUrl = () => pathToFileURL(join(ROOT, 'src', 'modules', 'workflow', 'service.js')).href;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-wf-'));
  origCwd = process.cwd();
  fakeCwd = join(tmp, 'proj');
  await mkdir(fakeCwd, { recursive: true });
  process.chdir(fakeCwd);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(tmp, { recursive: true, force: true });
});

test('parseDot：基本 digraph 解析', async () => {
  const { parseDot } = await import(serviceUrl());
  const text = `digraph workflow {
    a -> b
    b -> c
    c [label="结束", shape=ellipse, fillcolor="#dcfce7"]
  }`;
  const r = parseDot(text);
  assert.equal(r.errors.length, 0);
  assert.equal(r.nodes.length, 3);
  assert.equal(r.edges.length, 2);
  assert.equal(r.nodes.find((n) => n.id === 'c').label, '结束');
  assert.equal(r.nodes.find((n) => n.id === 'c').shape, 'ellipse');
  assert.equal(r.edges[0].source, 'a');
  assert.equal(r.edges[0].target, 'b');
});

test('parseDot：缺 digraph 包装 / 自环在 parser 不挡（在 validator 挡）', async () => {
  const { parseDot } = await import(serviceUrl());
  const r1 = parseDot('a -> b');
  assert.ok(r1.errors.length > 0);
  const r2 = parseDot('digraph g { a -> a }');
  assert.equal(r2.errors.length, 0, '自环 parser 层不报，validator 才报');
});

test('parseDot：字符串属性含空格/中文/转义', async () => {
  const { parseDot } = await import(serviceUrl());
  const r = parseDot(`digraph g { a [label="你好世界"]; a -> b [label="开始 → 结束"] }`);
  assert.equal(r.nodes.find((n) => n.id === 'a').label, '你好世界');
  assert.equal(r.edges[0].label, '开始 → 结束');
});

test('serializeDot：图 → DOT 往返不丢信息', async () => {
  const { parseDot, serializeDot } = await import(serviceUrl());
  const src = `digraph workflow {
    start [label="开始", shape=ellipse, fillcolor="#e0f2fe"]
    start -> a
    a [label="节点 A"]
    a -> b [label="依赖"]
  }`;
  const out = serializeDot(parseDot(src));
  assert.match(out, /start \[/);
  assert.match(out, /a -> b \[label="依赖"\]/);
});

test('validateWorkflow：自环 + 重复边都拒', async () => {
  const { validateWorkflow } = await import(serviceUrl());
  assert.equal(validateWorkflow('digraph g { a -> b }').ok, true);
  const selfLoop = validateWorkflow('digraph g { a -> a }');
  assert.equal(selfLoop.ok, false);
  assert.ok(selfLoop.problems.some((p) => /自环/.test(p)));
  const dup = validateWorkflow('digraph g { a -> b; a -> b }');
  assert.equal(dup.ok, false);
  assert.ok(dup.problems.length >= 1);
});

test('validateWorkflow：空 digraph / 语法错', async () => {
  const { validateWorkflow } = await import(serviceUrl());
  assert.equal(validateWorkflow('digraph g {}').ok, false);
  assert.equal(validateWorkflow('not a digraph').ok, false);
});

test('listWorkflows + writeWorkflow + readWorkflow + removeWorkflow：完整 CRUD', async () => {
  const svc = await import(serviceUrl());
  const dot = `digraph workflow { a -> b; b -> c }`;
  assert.equal((await svc.listWorkflows()).length, 0);
  await svc.writeWorkflow('flow-a', dot);
  assert.equal((await svc.listWorkflows()).length, 1);
  const got = await svc.readWorkflow('flow-a');
  assert.match(got.source, /a -> b/);
  assert.equal(got.nodes.length, 3);
  await svc.writeWorkflow('flow-b', dot);
  assert.equal((await svc.listWorkflows()).length, 2);
  await svc.removeWorkflow('flow-a');
  assert.equal((await svc.listWorkflows()).length, 1);
  await assert.rejects(() => svc.readWorkflow('flow-a'), /不存在/);
});

test('writeWorkflow：非法名字拒绝；半成品 DOT 不阻断保存', async () => {
  const svc = await import(serviceUrl());
  await assert.rejects(() => svc.writeWorkflow('../etc', 'digraph g {}'), /匹配/);
  await assert.rejects(() => svc.writeWorkflow('', 'digraph g {}'), /匹配/);
  const r = await svc.writeWorkflow('draft', 'digraph draft { broken');
  assert.ok(r.problems.length > 0, '校验问题由 problems 字段反映，不阻断保存');
});

test('validateWorkflowFile：读外部 DOT 文件验证', async () => {
  const svc = await import(serviceUrl());
  const externalDot = join(tmp, 'external.dot');
  await writeFile(externalDot, `digraph ext { x -> y [label="go"] }`, 'utf8');
  const r = await svc.validateWorkflowFile(externalDot);
  assert.equal(r.ok, true);
  assert.equal(r.nodes, 2);
});

test('registry：workflow 6 条 action 双端声明齐全', async () => {
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const ids = new Set(ACTIONS.map((a) => a.id));
  for (const id of ['workflow.list', 'workflow.get', 'workflow.save', 'workflow.remove', 'workflow.validate', 'workflow.import']) {
    assert.ok(ids.has(id), `缺 action: ${id}`);
  }
  const httpById = new Map(ACTIONS.map((a) => [a.id, a.http]));
  for (const id of ['workflow.list', 'workflow.get', 'workflow.save', 'workflow.remove', 'workflow.validate', 'workflow.import']) {
    assert.ok(Array.isArray(httpById.get(id)), `${id} 缺 HTTP`);
  }
});
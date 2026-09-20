// workflow 的纯逻辑测试：解析 + 校验 + 拓扑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as service from '../../src/modules/workflow/service.js';

const _BASE = { version: 1, name: 't', type: 'graph', nodes: [], edges: [] };

test('parseWorkflow: 合法 graph 直接通过', () => {
  const w = service.parseWorkflow({
    name: 't', type: 'graph',
    nodes: [{ id: 'a', kind: 'nxAction', actionId: 'link.list' }],
    edges: [],
  });
  assert.equal(w.name, 't');
  assert.equal(w.type, 'graph');
  assert.equal(w.nodes[0].kind, 'nxAction');
});

test('parseWorkflow: 缺 name 报错', () => {
  assert.throws(() => service.parseWorkflow({ type: 'graph', nodes: [], edges: [] }), /必须有名/);
});

test('parseWorkflow: 顶层 type 非法报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'foo' }), /type 必须是/);
});

test('parseWorkflow: 节点缺 kind 报错（不再默默默认）', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'graph',
    nodes: [{ id: 'a', actionId: 'x' }], edges: [] }), /缺 kind/);
});

test('parseWorkflow: 节点 kind 非法报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'graph',
    nodes: [{ id: 'a', kind: 'BAD' }], edges: [] }), /kind 非法/);
});

test('parseWorkflow: nxAction 缺 actionId 报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'graph',
    nodes: [{ id: 'a', kind: 'nxAction' }], edges: [] }), /必须有 actionId/);
});

test('parseWorkflow: agent-call 缺 command 报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'agent-call',
    nodes: [{ id: 'a', kind: 'agent-call', prompt: 'hi' }], edges: [] }), /必须有 command/);
});

test('parseWorkflow: http 节点 method 非法报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'http',
    nodes: [{ id: 'a', kind: 'http', url: 'https://x', method: 'FOO' }], edges: [] }), /method 必须是/);
});

test('parseWorkflow: 边的端点引用不存在节点报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'graph',
    nodes: [{ id: 'a', kind: 'nxAction', actionId: 'x' }],
    edges: [{ source: 'a', target: 'gone' }],
  }), /不存在的节点/);
});

test('parseWorkflow: 环报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'graph',
    nodes: [{ id: 'a', kind: 'nxAction', actionId: 'x' }, { id: 'b', kind: 'nxAction', actionId: 'y' }],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
  }), /环|悬空/);
});

test('parseWorkflow: 重复节点 id 报错', () => {
  assert.throws(() => service.parseWorkflow({ name: 't', type: 'graph',
    nodes: [{ id: 'a', kind: 'nxAction', actionId: 'x' }, { id: 'a', kind: 'nxAction', actionId: 'y' }],
    edges: [],
  }), /重复节点 id/);
});

test('formatWorkflow: 输出合法 JSON 且字段对齐', () => {
  const w = service.parseWorkflow({
    name: 't', type: 'graph',
    nodes: [{ id: 'a', kind: 'nxAction', actionId: 'x' }],
    edges: [],
  });
  const s = service.formatWorkflow(w, { indent: 2 });
  const back = JSON.parse(s);
  assert.equal(back.name, 't');
  assert.equal(back.nodes.length, 1);
});

test('parseWorkflow: 字符串输入也能解析', () => {
  const w = service.parseWorkflow('{"name":"t","type":"graph","nodes":[{"id":"a","kind":"nxAction","actionId":"x"}],"edges":[]}');
  assert.equal(w.name, 't');
});
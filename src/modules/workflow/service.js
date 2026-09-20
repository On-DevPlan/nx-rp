// workflow 资源业务：解析 / 校验 / 美化 / 应用。
//
// 设计核心：
//   1. workflow = 节点 + 边的有向图；节点 4 种类型（graph/pipeline/agent-call/http）
//   2. v1 不实现节点数据传递（节点 A 输出 → 节点 B 输入）；各节点参数独立
//   3. CLI 只暴露 validate / format / apply 三条命令——agent 通过写文件 + 三条命令自助管理
//   4. apply 走 cwd-scope：每个 cwd 的工作流独立
//
// 文件格式：JSON 顶层 { version, name, type, nodes, edges }。
// 顶层 type 决定节点类型，节点里不再声明 type（自动按 kind 推）。
//
// JSON 不需要解析 YAML——node 内置 JSON.parse 已经够 agent 用。

import { mutateStore } from '../../core/store.js';
import { assertSafeName, cwdScope } from '../../core/paths.js';
import { notFound, invalidInput } from '../../core/errors.js';

// ---- 顶层 type：4 种节点类型的合法取值 ----
const WORKFLOW_TYPES = new Set(['graph', 'pipeline', 'agent-call', 'http']);
const NODE_TYPES = new Set(['nxAction', 'agent-call', 'http']); // 节点级 kind
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function _makeId() {
  return 'w_' + Math.random().toString(36).slice(2, 10);
}

// ---- 解析 + 校验 ----

// 把输入（JSON 字符串 / Buffer / 已解析对象）变成「规范化」的 workflow。
// 任何字段缺失都补默认值；任何字段非法都抛 invalidInput（带清晰提示）。
export function parseWorkflow(input) {
  let raw;
  if (typeof input === 'string' || input instanceof Uint8Array || Buffer.isBuffer(input)) {
    try { raw = JSON.parse(typeof input === 'string' ? input : Buffer.from(input).toString('utf8')); }
    catch (e) { throw invalidInput('JSON 解析失败: ' + (e.message || e)); }
  } else if (typeof input === 'object' && input) {
    raw = input;
  } else {
    throw invalidInput('工作流定义必须是 JSON 字符串或对象');
  }
  return normalize(raw);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw invalidInput('工作流定义必须是对象');
  const type = String(raw.type || 'graph');
  if (!WORKFLOW_TYPES.has(type)) {
    throw invalidInput(`顶层 type 必须是 ${[...WORKFLOW_TYPES].join('|')}，收到: ${raw.type}`);
  }
  const name = String(raw.name || '').trim();
  if (!name) throw invalidInput('工作流必须有名 (name)');
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map((n) => normalizeNode(n, type)) : [];
  const edges = Array.isArray(raw.edges) ? raw.edges.map(normalizeEdge) : [];

  // 拓扑校验：循环 / 悬空边 / 重复节点 id
  const seen = new Set();
  for (const n of nodes) {
    if (seen.has(n.id)) throw invalidInput(`重复节点 id: ${n.id}`);
    seen.add(n.id);
  }
  for (const e of edges) {
    if (!seen.has(e.source) || !seen.has(e.target)) {
      throw invalidInput(`边的端点引用了不存在的节点: ${e.source} -> ${e.target}`);
    }
  }
  topologicalValidate(nodes, edges);

  return { version: 1, name, type, nodes, edges };
}

function normalizeNode(n, _topType) {
  if (!n || typeof n !== 'object') throw invalidInput('节点必须是对象');
  if (typeof n.id !== 'string' || !n.id) throw invalidInput('节点必须有 id');
  // 节点 kind 必填——按 kind 缺省明确比「暗示自动跑一个」更安全
  const kind = n.kind || n.type;
  if (!kind) {
    throw invalidInput(`节点 ${n.id} 缺 kind（必须是 nxAction | agent-call | http 之一）`);
  }
  if (!NODE_TYPES.has(kind)) {
    throw invalidInput(`节点 ${n.id} 的 kind 非法: ${kind}（必须是 nxAction | agent-call | http 之一）`);
  }
  // kind 特定必填字段
  if (kind === 'agent-call') {
    if (typeof n.command !== 'string' || !n.command) {
      throw invalidInput(`agent-call 节点 ${n.id} 必须有 command（要调哪个 agent CLI）`);
    }
  } else if (kind === 'http') {
    if (typeof n.url !== 'string' || !n.url) {
      throw invalidInput(`http 节点 ${n.id} 必须有 url`);
    }
    const method = String(n.method || 'GET').toUpperCase();
    if (!HTTP_METHODS.has(method)) {
      throw invalidInput(`http 节点 ${n.id} 的 method 必须是 ${[...HTTP_METHODS].join('|')}`);
    }
  } else if (kind === 'nxAction') {
    if (typeof n.actionId !== 'string' || !n.actionId) {
      throw invalidInput(`nxAction 节点 ${n.id} 必须有 actionId（要调哪个 nx-rp 命令）`);
    }
  }

  return {
    id: n.id,
    kind,
    position: positionOf(n.position),
    actionId: n.actionId,
    command: n.command,
    prompt: typeof n.prompt === 'string' ? n.prompt : '',
    method: kind === 'http' ? String(n.method || 'GET').toUpperCase() : undefined,
    url: n.url,
    headers: n.headers && typeof n.headers === 'object' ? n.headers : undefined,
    body: n.body,
    params: n.params && typeof n.params === 'object' ? n.params : {},
  };
}

function normalizeEdge(e) {
  if (!e || typeof e !== 'object') throw invalidInput('边必须是对象');
  if (typeof e.source !== 'string' || typeof e.target !== 'string') {
    throw invalidInput('边必须有 source / target');
  }
  return { id: typeof e.id === 'string' ? e.id : `${e.source}->${e.target}`, source: e.source, target: e.target };
}

function positionOf(p) {
  if (!p || typeof p !== 'object') return { x: 0, y: 0 };
  return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
}

// Kahn 拓扑：环报错
function topologicalValidate(nodes, edges) {
  const deg = new Map();
  for (const n of nodes) deg.set(n.id, 0);
  for (const e of edges) {
    if (!deg.has(e.source) || !deg.has(e.target)) continue;
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  }
  const queue = [];
  for (const [id, d] of deg) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited++;
    for (const e of edges) {
      if (e.source !== id) continue;
      deg.set(e.target, deg.get(e.target) - 1);
      if (deg.get(e.target) === 0) queue.push(e.target);
    }
  }
  if (visited !== nodes.length) {
    throw invalidInput('工作流存在环或悬空边，无法解析');
  }
}

// ---- format: 美化输出 ----

export function formatWorkflow(def, { indent = 2 } = {}) {
  return JSON.stringify(def, null, indent);
}

// ---- 当前 cwd scope 的 workflow 存储（map by name） ----

function currentScope(store) {
  const k = cwdScope();
  if (!store.scopes[k]) store.scopes[k] = { links: [], docs: [], workflows: {} };
  return store.scopes[k];
}

// ---- CRUD（与 link / doc 同形，5 条全有） ----

export async function listWorkflows() {
  const { scope } = await (await import('../../core/store.js')).getCurrentScope();
  return Object.entries(scope.workflows).map(([name, w]) => ({
    name,
    type: w.type,
    nodes: w.nodes.length,
    edges: w.edges.length,
  }));
}

export async function getWorkflow(name) {
  assertSafeName(name, '工作流名');
  const { scope } = await (await import('../../core/store.js')).getCurrentScope();
  const w = scope.workflows[name];
  if (!w) throw notFound(`工作流不存在: ${name}`);
  return w;
}

export async function addWorkflow(def) {
  const w = parseWorkflow(def);
  return mutateStore((store) => {
    const scope = currentScope(store);
    if (scope.workflows[w.name]) {
      throw invalidInput(`工作流已存在: ${w.name}（用 update 覆盖）`);
    }
    scope.workflows[w.name] = { ...w, createdAt: new Date().toISOString() };
    return scope.workflows[w.name];
  });
}

export async function updateWorkflow(name, def) {
  assertSafeName(name, '工作流名');
  const w = parseWorkflow({ ...(typeof def === 'object' ? def : {}), name });
  return mutateStore((store) => {
    const scope = currentScope(store);
    if (!scope.workflows[name]) throw notFound(`工作流不存在: ${name}`);
    scope.workflows[name] = { ...scope.workflows[name], ...w, name };
    return scope.workflows[name];
  });
}

export async function removeWorkflow(name) {
  assertSafeName(name, '工作流名');
  return mutateStore((store) => {
    const scope = currentScope(store);
    if (!scope.workflows[name]) throw notFound(`工作流不存在: ${name}`);
    const removed = scope.workflows[name];
    delete scope.workflows[name];
    return removed;
  });
}
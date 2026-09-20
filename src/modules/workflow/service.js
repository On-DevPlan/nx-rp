// workflow 服务：JS 一等格式的执行引擎。
//
// **原语定义**（与 assets/nx-rp/references/workflow-author.md 同步）：
//
//   Node = { id, name, type, status, startedAt?, finishedAt?, ms?, payload? }
//     type:    'nxAction' | 'agent-call' | 'http' | 'raw'
//     status:  'idle' | 'running' | 'success' | 'error' | 'skipped'
//
//   Edge = { source, target, type, blocking }
//     type:    'seq' | 'parallel' | 'conditional'
//     blocking: true | false（仅 seq / conditional 为 true）
//
//   事件（全部 SSE 帧）：
//     graph     完整图（含 nodes + edges，每次新增节点/边都发）
//     nodeStart { id, name }                       节点开始
//     nodeDone  { id, name, ok, ms, data?, error? }  节点结束
//     nodeLog   { id?, line }                       节点内日志
//     done      { ok, elapsedMs }                  整体结束
//     error     { message }                         顶层未捕获错误
//
// AI 生成 JS 源码（不是 JSON）—— JS 的控制流（if/for-await/Promise.all/try）是
// 「母语」，不需要发明「group / dependsOn / when」等 JSON 字段。ctx.step/parallel
// 把这些控制流翻译成 graph 事件，前端按 SSE 流实时画图。

import { PassThrough } from 'node:stream';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cwdScope } from '../../core/paths.js';
import { loadStore, mutateStore } from '../../core/store.js';
import { notFound, invalidInput } from '../../core/errors.js';

const VERSION = 1;

// 工作流源码存储路径：~/.nx-rp/<scopeHash>/workflows/<name>.mjs
// 测试可用 NX_RP_WORKFLOWS_DIR 环境变量覆盖。
function scopeHash() {
  return Buffer.from(cwdScope()).toString('base64url').slice(0, 16);
}
function workflowsDir() {
  if (process.env.NX_RP_WORKFLOWS_DIR) return process.env.NX_RP_WORKFLOWS_DIR;
  return join(process.env.HOME || process.env.USERPROFILE || '.', '.nx-rp', scopeHash(), 'workflows');
}

// ─── 校验 ────────────────────────────────────────────────────────────

export async function validateWorkflow(filePath) {
  const abs = isAbsolute(filePath) ? resolve(filePath) : join(process.cwd(), filePath);
  let mod;
  try { mod = await import(pathToFileURL(abs).href); }
  catch (e) { throw invalidInput(`加载失败: ${e.message}`); }
  // 必须 export default（不接受 export const run 这种旧约定）
  if (typeof mod.default !== 'function') {
    throw invalidInput('工作流文件必须 export default 一个函数（async function run(ctx) 或同步函数）');
  }
  return {
    file: abs,
    hasDefault: typeof mod.default === 'function',
    name: mod.default.name || '(anonymous)',
    isAsync: mod.default.constructor.name === 'AsyncFunction',
  };
}

// ─── 运行 ────────────────────────────────────────────────────────────

// 序列化返回值（避免流 / 不可序列化对象塞进 SSE）
function serialize(d) {
  if (d === undefined || d === null) return null;
  if (typeof d === 'object' && d && typeof d.pipe === 'function') return { __stream__: true };
  try { JSON.stringify(d); return d; }
  catch { return { __unserializable__: true, type: d.constructor?.name || 'unknown' }; }
}

// ctx 是工作流执行时的能力包。所有 API 都通过 ctx 暴露。
// 每个 ctx.step / ctx.parallel 自动 emit 节点/边事件。
function makeCtx(emit) {
  const graph = { nodes: [], edges: [], counter: 0 };

  // 当前游标：记录「上一节点 id」与「当前 parallel 组」
  let lastNodeId = null;
  let lastParallelGroup = null;

  function declareNode(name, type = 'raw') {
    const id = 'n' + (++graph.counter);
    graph.nodes.push({ id, name, type, status: 'idle' });
    emitGraph();
    return id;
  }

  function addEdge(source, target, type, blocking) {
    graph.edges.push({
      id: `${source}->${target}-${graph.edges.length}`,
      source, target, type, blocking: !!blocking,
    });
  }

  function emitGraph() {
    emit({ event: 'graph', data: { nodes: [...graph.nodes], edges: [...graph.edges] } });
  }

  // ── step(name, fn, opts?) ─────────────────────────────────────
  //
  //   opts.type:      节点 type（默认 raw）
  //   opts.after:     显式前驱名（string[]）—— 默认 = 上一个节点
  //   opts.kind:      同 type（alias，保持向后兼容）
  function step(name, fn, opts = {}) {
    const type = opts.type || opts.kind || 'raw';
    const id = declareNode(name, type);

    // 显式前驱
    const afterNames = [].concat(opts.after || []).filter(Boolean);
    if (afterNames.length) {
      const nameMap = collectNameIds(graph);
      for (const a of afterNames) {
        const ids = nameMap.get(a) || [];
        for (const aid of ids) addEdge(aid, id, 'seq', true);
      }
    } else if (lastNodeId && lastParallelGroup !== currentGroup()) {
      // 默认：上一节点 → 本节点（seq 边）
      addEdge(lastNodeId, id, 'seq', true);
    }

    emitGraph();
    lastNodeId = id;
    return runStep(id, name, fn);
  }

  function currentGroup() {
    return lastParallelGroup;
  }

  function runStep(id, name, fn) {
    // status: idle → running
    patchNode(id, { status: 'running', startedAt: Date.now() });
    emit({ event: 'nodeStart', data: { id, name } });

    const t0 = Date.now();
    insideStep++;
    const prevNode = currentNodeId;
    currentNodeId = id;
    return Promise.resolve()
      .then(() => fn())
      .then((data) => {
        insideStep--;
        currentNodeId = prevNode;
        patchNode(id, { status: 'success', finishedAt: Date.now(), ms: Date.now() - t0, payload: serialize(data) });
        emit({ event: 'nodeDone', data: { id, name, ok: true, ms: Date.now() - t0, data: serialize(data) } });
        return data;
      })
      .catch((err) => {
        insideStep--;
        currentNodeId = prevNode;
        const msg = err && err.message ? err.message : String(err);
        patchNode(id, { status: 'error', finishedAt: Date.now(), ms: Date.now() - t0, payload: msg });
        emit({ event: 'nodeDone', data: { id, name, ok: false, ms: Date.now() - t0, error: msg } });
        throw err;
      });
  }

  function patchNode(id, patch) {
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) return;
    const typeChanged = patch.type && patch.type !== n.type;
    Object.assign(n, patch);
    // type 变化要重发 graph（前端节点卡片按 type 显示 label / 上色）
    if (typeChanged) emitGraph();
  }

  // ── parallel(steps) ──────────────────────────────────────────
  //
  // 同组节点之间不连实线边——只画 parallel 虚线（视觉表达同组）。
  // 组入口：上一节点 → 组内每个节点（seq 边）。
  async function parallel(steps) {
    const entries = Object.entries(steps);
    if (!entries.length) return;

    // 预声明所有节点（前端能在并行开始前看到完整一组）
    const groupId = 'g' + (++graph.counter);
    const newIds = entries.map(([name]) => {
      const id = declareNode(name, 'raw');
      // 上一个节点 → 组内每个节点（seq）
      if (lastNodeId) addEdge(lastNodeId, id, 'seq', true);
      return id;
    });
    // 同组内两两之间：parallel 虚线（非阻塞）。service 侧全量记录（API 消费者
// 需要完整依赖信息）；前端画布渲染时按 id 去重（见 view.jsx edgeStyle）。
    for (let i = 0; i < newIds.length; i++) {
      for (let j = i + 1; j < newIds.length; j++) {
        addEdge(newIds[i], newIds[j], 'parallel', false);
      }
    }
    emitGraph();

    const prevGroup = lastParallelGroup;
    lastParallelGroup = groupId;
    lastNodeId = newIds[newIds.length - 1]; // 下一节点的「上一节点」= 组内任意
    try {
      await Promise.all(entries.map(([name, fn], i) => runStep(newIds[i], name, fn)));
    } finally {
      lastParallelGroup = prevGroup;
    }
  }

  async function series(steps) {
    for (const [name, fn] of Object.entries(steps)) await step(name, fn);
  }

  // insideStep > 0 表示当前正在某个 step 的 fn 里执行——此时 http/nx/agent
  // 不再自己声明节点（外层 step 已经在追踪了），只执行动作本身，
  // 并把外层节点的 type 修正为具体动作类型（nxAction / http / agent-call）。
  // 否则「列链接」包装节点 + 内部 link.list 节点会画成两个。
  let insideStep = 0;
  let currentNodeId = null;

  // http / nx / agent 是 ctx.step 的语法糖：
  //   - 在 step/parallel 的 fn 里调用：只执行动作 + 修正外层节点 type
  //   - 裸调用（ctx.http(...) 不包 step）：自动包一层 step + 默认 type
  async function http(url, opts = {}) {
    if (insideStep) {
      patchNode(currentNodeId, { type: 'http' });
      return fetchHttp(url, opts);
    }
    return step(url.replace(/^https?:\/\//, ''), () => fetchHttp(url, opts), { type: 'http' });
  }
  async function nx(actionId, params = {}) {
    if (insideStep) {
      patchNode(currentNodeId, { type: 'nxAction', actionId });
      const { dispatch } = await import('../../dispatcher.js');
      return dispatch(actionId, params, { transport: 'cli' });
    }
    return step(actionId, async () => {
      const { dispatch } = await import('../../dispatcher.js');
      return dispatch(actionId, params, { transport: 'cli' });
    }, { type: 'nxAction' });
  }
  async function agent(command, args = [], opts = {}) {
    if (insideStep) {
      patchNode(currentNodeId, { type: 'agent-call', command });
      return spawnAgent(command, args, opts, emit);
    }
    return step(`${command} ${args.join(' ')}`.trim(), () => spawnAgent(command, args, opts, emit), { type: 'agent-call' });
  }

  function log(line) {
    emit({ event: 'nodeLog', data: { line } });
  }

  return { step, parallel, series, http, nx, agent, log };
}

function collectNameIds(g) {
  const m = new Map();
  for (const n of g.nodes) {
    if (!m.has(n.name)) m.set(n.name, []);
    m.get(n.name).push(n.id);
  }
  return m;
}

async function fetchHttp(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function spawnAgent(command, args, opts, emit) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) {
        if (!line.trim()) continue;
        emit({ event: 'nodeLog', data: { source: command, line } });
      }
    });
    child.stderr.on('data', (chunk) => {
      emit({ event: 'nodeLog', data: { source: command + ':stderr', line: chunk.toString('utf8').trim() } });
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code });
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

// 把事件序列化成 SSE 帧
function writeFrame(stream, ev) {
  stream.write(`event: ${ev.event}\n`);
  stream.write(`data: ${JSON.stringify(ev.data)}\n\n`);
}

// 跑一个工作流文件，返回 PassThrough（前端可订阅）
export async function runWorkflowFile(filePath, opts = {}) {
  const stream = new PassThrough();
  runWorkflowStreamingInto(stream, filePath, opts).catch(() => {});
  return stream;
}

async function runWorkflowStreamingInto(stream, filePath, _opts = {}) {
  const start = Date.now();
  let ok = true;
  const emit = (ev) => writeFrame(stream, ev);
  const ctx = makeCtx(emit);
  try {
    const abs = isAbsolute(filePath) ? resolve(filePath) : join(process.cwd(), filePath);
    // 加 mtime query 绕 Node import cache：每次运行都重新加载源码变更
    const cacheBust = `?t=${(await fsp.stat(abs).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs}`;
    const mod = await import(pathToFileURL(abs).href + cacheBust);
    const run = mod.default;
    if (typeof run !== 'function') throw invalidInput('工作流文件必须 export default 一个函数');
    await run(ctx);
  } catch (e) {
    ok = false;
    emit({ event: 'error', data: { message: e && e.message ? e.message : String(e) } });
  }
  emit({ event: 'done', data: { ok, elapsedMs: Date.now() - start } });
  stream.end();
}

// ─── CRUD ────────────────────────────────────────────────────────────

export async function listWorkflows() {
  const dir = workflowsDir();
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const store = await loadStore();
  const k = cwdScope();
  const meta = (store.scopes[k] && store.scopes[k].workflows) || {};
  return names.filter((n) => n.endsWith('.mjs')).map((n) => {
    const name = n.slice(0, -'.mjs'.length);
    const m = meta[name] || {};
    // m 可能是 0.1.5 时代的 workflow 数据（包含 nodes/edges）——这种不要当成元数据
    const isMeta = !m.nodes && !m.edges;
    return { name, ...(isMeta ? m : {}) };
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export async function saveWorkflow(name, filePath) {
  const abs = isAbsolute(filePath) ? resolve(filePath) : join(process.cwd(), filePath);
  let text;
  try { text = await fsp.readFile(abs, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw notFound(`工作流文件不存在: ${filePath}`);
    throw invalidInput(`读取失败: ${e.message || e}`);
  }
  try { await validateWorkflow(filePath); }
  catch (e) { throw invalidInput(`工作流校验失败: ${e.message || e}`); }

  await writeWorkflowFiles(name, text);
  return { name, path: workflowsDir() + '/' + name + '.mjs' };
}

// 内部：把源码写到两处（cwd 内 .nx-rp-workflows/<name>.mjs + scope 内 ~/.nx-rp/<scopeHash>/workflows/<name>.mjs）+ 同步 store metadata
async function writeWorkflowFiles(name, text) {
  // 1) cwd 内：让用户能在编辑器里打开看到源码
  const cwdFile = join(process.cwd(), '.nx-rp-workflows', `${name}.mjs`);
  await fsp.mkdir(dirname(cwdFile), { recursive: true });
  await fsp.writeFile(cwdFile, text, 'utf8');
  // 2) scope 内：list / run 的真实来源
  const dir = workflowsDir();
  await fsp.mkdir(dir, { recursive: true });
  const dest = join(dir, `${name}.mjs`);
  await fsp.writeFile(dest, text, 'utf8');
  // 3) store metadata
  await mutateStore((s) => {
    const k = cwdScope();
    if (!s.scopes[k]) s.scopes[k] = { links: [], docs: [], workflows: {} };
    s.scopes[k].workflows[name] = {
      name, version: VERSION,
      createdAt: new Date().toISOString(),
      sourceFile: cwdFile,
    };
    return s;
  });
  return cwdFile;
}

// 给 HTTP 端 / Web 端用：直接接受源码字符串（前端不能再读本地文件）
export async function writeWorkflow(name, body) {
  // 校验源码合法（用临时探针文件 import）
  await fsp.mkdir(workflowsDir(), { recursive: true });
  const probe = join(workflowsDir(), `__probe_${name}_${Date.now()}.mjs`);
  await fsp.writeFile(probe, body, 'utf8');
  try {
    await validateWorkflow(probe);
  } finally {
    await fsp.unlink(probe).catch(() => {});
  }
  return writeWorkflowFiles(name, body);
}

// 读源码（HTTP 端：前端从 web 加载时用）
export async function readWorkflowSource(name) {
  const { cwdScope: getCwd } = await import('../../core/paths.js');
  const k = getCwd();
  const store = await loadStore();
  const meta = (store.scopes[k] && store.scopes[k].workflows && store.scopes[k].workflows[name]) || {};
  if (!meta.sourceFile) throw notFound(`工作流「${name}」无源码记录`);
  const text = await fsp.readFile(meta.sourceFile, 'utf8');
  return { name, body: text, file: meta.sourceFile };
}

export async function removeWorkflow(name) {
  const dir = workflowsDir();
  const dest = join(dir, `${name}.mjs`);
  try { await fsp.unlink(dest); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw notFound(`工作流不存在: ${name}`);
    throw e;
  }
  await mutateStore((s) => {
    const k = cwdScope();
    if (s.scopes[k] && s.scopes[k].workflows) delete s.scopes[k].workflows[name];
    return s;
  });
  return { name, removed: true };
}
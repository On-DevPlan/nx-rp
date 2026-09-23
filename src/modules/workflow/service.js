// workflow 服务（DOT 极简版）。
//
// 精简版不再做 JS 执行引擎、agent-call、HTTP 调用……只做有向图编辑与渲染。
// 原因：有向依赖图本来就有更合适的声明式语言——Graphviz DOT。JS 引擎把
// 「节点 = 一段代码，依赖 = 异步返回值」硬塞成图，但用户实际想表达的是
// 「A 完成后才能做 B」——DOT 一行写完，无需运行时引擎。
//
// 数据流：
//   text (DOT) ──┬─ parseDot() → {nodes, edges} → React Flow 渲染
//                └─ validateWorkflow() → 静态语法/连通性校验（不执行）
//   saveWorkflow() ── text → 写入 cwd/.nx-rp-workflows/<name>.dot
//
// 节点状态：编辑态只渲染「形状 + 标签」；执行态可由用户外部工具把 status
// 写回 DOT 文件的 fill/color 属性（DOT 兼容：a [fillcolor=green]），下次
// 加载即看到上次执行的颜色——这是 DOT 的天然属性，不引入新格式。

// DOT 解析器：最小可行子集——digraph { a -> b; b -> c; }
//   支持属性：[a] [label="..."] [shape=box]，多属性空格分隔
//   支持节点行：a [label="..."]（无 ->）
//   支持边的属性：a -> b [label="..."]（属性挂终点）
const VALID_ATTR = /^(shape|label|fillcolor|color|style|fontcolor)$/i;

export function parseDot(text) {
  const out = { nodes: new Map(), edges: [], errors: [] };
  if (!text || typeof text !== 'string') return { ...out, nodes: [], edges: [], errors: ['空内容'] };
  // 去掉单行 // 注释与 /* ... */ 多行注释
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // 抽取 graph 体 {...}
  const m = cleaned.match(/^\s*(?:digraph|graph)\s+\w*\s*\{([\s\S]*?)\}\s*$/);
  if (!m) {
    out.errors.push('缺少 digraph{} 包裹');
    return { nodes: [], edges: [], errors: out.errors };
  }
  const body = m[1];
  // DOT 语法的两种分隔符：分号 `;` **或**换行（裸语句末尾）。前者优先；
  // 后者保证「一行一个语句」的人类友好写法能通过。两个都允许是因为 graphviz
  // 自己就这么做的。切分时尊重属性块里的 [..]，里面的分号/换行不切。
  const stmts = [];
  let buf = '';
  let depth = 0;
  for (const ch of body) {
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (depth === 0) {
      if (ch === ';') { stmts.push(buf); buf = ''; continue; }
      if (ch === '\n') { if (buf.trim()) { stmts.push(buf); buf = ''; continue; } }
    }
    buf += ch;
  }
  if (buf.trim()) stmts.push(buf);

  const applyAttrs = (target, attrs) => {
    for (const { key, value } of attrs) {
      if (!VALID_ATTR.test(key)) continue; // 跳过不认识的属性
      target[key.toLowerCase()] = value;
    }
  };

  for (const raw of stmts) {
    const stmt = raw.trim();
    if (!stmt) continue;
    // 边：a -> b [attrs]
    const edgeMatch = stmt.match(/^([A-Za-z_][\w-]*)\s*->\s*([A-Za-z_][\w-]*)\s*(\[.*\])?\s*$/);
    if (edgeMatch) {
      const [, source, target, attrs] = edgeMatch;
      ensureNode(out.nodes, source);
      ensureNode(out.nodes, target);
      const edge = { id: `${source}__${target}`, source, target, label: '' };
      if (attrs) applyAttrs(edge, parseAttrBlock(attrs));
      out.edges.push(edge);
      continue;
    }
    // 节点行：a [attrs]
    const nodeMatch = stmt.match(/^([A-Za-z_][\w-]*)\s*(\[.*\])?\s*$/);
    if (nodeMatch) {
      const [, id, attrs] = nodeMatch;
      const node = ensureNode(out.nodes, id);
      if (attrs) applyAttrs(node, parseAttrBlock(attrs));
      continue;
    }
    out.errors.push('无法解析: ' + stmt);
  }
  // 节点数组
  const nodes = Array.from(out.nodes.values()).map((n) => ({
    id: n.id, label: n.label || n.id,
    shape: n.shape || 'box', fillcolor: n.fillcolor || '',
    color: n.color || '', style: n.style || '', fontcolor: n.fontcolor || '',
  }));
  return { nodes, edges: out.edges, errors: out.errors };
}

function ensureNode(map, id) {
  if (!map.has(id)) map.set(id, { id });
  return map.get(id);
}

// [key=value, key="value with space"] → [{key, value}]
function parseAttrBlock(block) {
  const inner = block.slice(1, -1).trim();
  if (!inner) return [];
  const out = [];
  let i = 0;
  while (i < inner.length) {
    // 跳属性间分隔：空白 + 可选逗号 + 空白
    while (i < inner.length && /[\s,]/.test(inner[i])) i++;
    if (i >= inner.length) break;
    const eq = inner.indexOf('=', i);
    if (eq < 0) break;
    const key = inner.slice(i, eq).trim();
    i = eq + 1;
    let value;
    if (inner[i] === '"') {
      const end = findMatchingQuote(inner, i);
      value = inner.slice(i + 1, end);
      i = end + 1;
    } else {
      const m = inner.slice(i).match(/^[\w.-]+/);
      if (!m) break;
      value = m[0];
      i += m[0].length;
    }
    out.push({ key, value });
  }
  return out;
}

function findMatchingQuote(s, start) {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return s.length - 1;
}

// 反向：图 → DOT 文本（用户编辑结果存盘 / 跨项目搬运）。
export function serializeDot({ nodes, edges }) {
  const lines = ['digraph workflow {'];
  for (const n of nodes) {
    const attrs = nodeAttrs(n).map(([k, v]) => `${k}=${escape(v)}`).join(', ');
    lines.push(`  ${n.id} [${attrs}];`);
  }
  for (const e of edges) {
    const attrs = edgeAttrs(e).map(([k, v]) => `${k}=${escape(v)}`).join(', ');
    if (attrs) lines.push(`  ${e.source} -> ${e.target} [${attrs}];`);
    else lines.push(`  ${e.source} -> ${e.target};`);
  }
  lines.push('}');
  return lines.join('\n');
}

function nodeAttrs(n) {
  const a = [];
  if (n.label && n.label !== n.id) a.push(['label', n.label]);
  if (n.shape && n.shape !== 'box') a.push(['shape', n.shape]);
  if (n.fillcolor) a.push(['fillcolor', n.fillcolor]);
  if (n.color) a.push(['color', n.color]);
  if (n.style) a.push(['style', n.style]);
  if (n.fontcolor) a.push(['fontcolor', n.fontcolor]);
  return a;
}

function edgeAttrs(e) {
  const a = [];
  if (e.label) a.push(['label', e.label]);
  return a;
}

function escape(v) {
  if (/^[\w.-]+$/.test(v)) return v;
  return JSON.stringify(v);
}

// ─── 校验（连通性、孤立节点、悬挂边） ────────────────────────────

export function validateWorkflow(text) {
  const { nodes, edges, errors } = parseDot(text);
  const problems = [...errors];
  if (nodes.length === 0 && errors.length === 0) problems.push('没有任何节点');

  // 检查边引用的节点是否都已声明（理论上 parseDot 已 ensureNode，但允许更严的输入）
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (!ids.has(e.source)) problems.push(`边起点 ${e.source} 不存在`);
    if (!ids.has(e.target)) problems.push(`边终点 ${e.target} 不存在`);
  }

  // 自环
  for (const e of edges) {
    if (e.source === e.target) problems.push(`自环边: ${e.source} -> ${e.target}`);
  }
  // 重复边（同一对 source/target 出现多次——通常是拖拽多次误操作）
  const seen = new Set();
  for (const e of edges) {
    const key = `${e.source}->${e.target}`;
    if (seen.has(key)) problems.push(`重复边: ${key}`);
    seen.add(key);
  }
  return { ok: problems.length === 0, problems, nodes: nodes.length, edges: edges.length };
}

// ─── 文件 IO ────────────────────────────────────────────────────────

import fsp from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { cwdDir } from '../../core/paths.js';
import { notFound, invalidInput } from '../../core/errors.js';

function workflowsDir() {
  // cwd 下的 .nx-rp-workflows/（可见、独立于 store.json）
  return join(cwdDir(), '.nx-rp-workflows');
}

function workflowPath(name) {
  if (!name || !/^[\w.\-]+$/.test(name)) throw invalidInput('workflow 名必须匹配 [\\w.\\-]+');
  return resolve(join(workflowsDir(), `${name}.dot`));
}

export async function listWorkflows() {
  const dir = workflowsDir();
  await fsp.mkdir(dir, { recursive: true });
  const files = await fsp.readdir(dir).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.dot')) continue;
    const name = f.replace(/\.dot$/, '');
    let stat;
    try { stat = await fsp.stat(join(dir, f)); } catch { continue; }
    out.push({ name, path: join(dir, f), bytes: stat.size, modifiedAt: stat.mtimeMs });
  }
  out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

export async function readWorkflow(name) {
  const path = workflowPath(name);
  let raw;
  try { raw = await fsp.readFile(path, 'utf8'); }
  catch { throw notFound(`workflow 不存在: ${name}`); }
  return { name, path, source: raw, ...parseDot(raw) };
}

export async function writeWorkflow(name, source) {
  const path = workflowPath(name);
  const v = validateWorkflow(source);
  // 静态问题不阻断保存（用户可能故意写半成品）——返回 problems 让面板展示
  await fsp.mkdir(workflowsDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, source, 'utf8');
  await fsp.rename(tmp, path);
  return { name, path, problems: v.problems };
}

export async function removeWorkflow(name) {
  const path = workflowPath(name);
  try { await fsp.unlink(path); }
  catch { throw notFound(`workflow 不存在: ${name}`); }
  return { name };
}

// 接受绝对路径/相对路径的文本校验入口（CLI validate 仍兼容路径参数）
export async function validateWorkflowText(text) {
  return validateWorkflow(text);
}

export async function validateWorkflowFile(filePath) {
  const abs = isAbsolute(filePath) ? resolve(filePath) : join(cwdDir(), filePath);
  let raw;
  try { raw = await fsp.readFile(abs, 'utf8'); }
  catch { throw notFound(`workflow 文件不存在: ${abs}`); }
  return { path: abs, ...validateWorkflow(raw) };
}
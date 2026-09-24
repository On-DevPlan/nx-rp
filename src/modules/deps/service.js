// deps 服务：扫 src/ 的 import 关系 → 有向依赖图。
//
// 唯一职责：**准确**。图是「从源码推导的只读视图」，编辑无意义（改图=改代码）。
//
// 准确性三原则：
//   1. 词法清洗后再匹配——注释/字符串里的 "import ... from" 文本是假边，
//      不清洗就会把「文档里举例的 import」当成真依赖
//   2. 扫全部 JS 家族扩展名（.js/.mjs/.cjs/.jsx）——只扫 .js 会把整个
//      web 层从图里漏掉（view.jsx 看不见，serve→web 的依赖就断了）
//   3. 边全局去重——同 id 多文件指向同一目标时只留一条
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// 识别 JS 家族文件（.jsx/.mjs/.cjs 与 .js 同等对待，否则 web 层整个不可见）
const JS_EXT = /\.(js|mjs|cjs|jsx)$/;
// 扫描时跳过的目录（依赖产物 / 运行时数据 / 嵌套仓库 / 前端构建产物）
const SKIP_DIRS = new Set(['node_modules', '.nx-rp-workflows', '.nx-rp', '.claude', '.git', 'dist', 'public']);

// ─── 词法清洗：剥注释与字符串字面量 ──────────────────────────────
//
// import 识别用正则（无完整 tokenizer），但注释/字符串里的 import 文本
// 会造成假边。这个扫描器把注释与「非 import 说明符」的字符串内容替换成
// 等长空白——保持位置不变，只留下「代码结构 + 真 import 说明符」给正则匹配。
//
// 说明符判定：字符串开始处的已清洗缓冲区尾部若是
//   `import ... from` / `export ... from` / `import(` / `require(`
// 则这是模块说明符，内容保留；否则整串剥掉（伪装 import 的字符串/模板）。
// 模板串同理（说明符位置不会出现模板串，一律剥；${expr} 插值保留）。
export function stripCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (idx) => { if (src[idx] !== '\n') out[idx] = ' '; };

  // 字符串开始处：已清洗内容的前文是否处于「模块说明符」位置
  const atSpecifier = (idx) => {
    const before = out.slice(0, idx).join('').replace(/[ \t]+$/, '');
    // import( / require( ——括号在说明符前
    if (/\b(?:import|require)\($/.test(before)) return true;
    // 去掉 between 的标识符/逗号/花括号（import { a, b } from / export * as x from）
    const stmt = before.replace(/^[\s]*import\s*[^\n]*?\bfrom$/, 'IMPORT').replace(/^[\s]*export\s+[^\n]*?\bfrom$/, 'EXPORT');
    return stmt === 'IMPORT' || stmt === 'EXPORT' || /\bfrom$/.test(before);
  };

  // 除法 vs 正则的粗判：看前一个非空白非注释字符——
  // 能终结表达式的东西（标识符/数字/)/]/}）后面跟 / 是除法，否则是正则。
  let prevSignificant = '';
  const regexAllowed = () => !/[\w$)\]}'"]/.test(prevSignificant);

  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    // 行注释
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') blank(i++);
      continue;
    }
    // 块注释
    if (c === '/' && next === '*') {
      blank(i++); blank(i++);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      if (i < n) { blank(i++); blank(i++); }
      continue;
    }
    // 字符串：说明符位置保留内容（含引号，IMPORT_RE 认引号），其余剥掉
    if (c === '"' || c === "'") {
      const quote = c;
      const keep = atSpecifier(i);
      if (!keep) blank(i++);
      else i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { if (!keep) blank(i); i++; continue; }
        if (!keep) blank(i);
        i++;
      }
      if (i < n) { if (!keep) blank(i); i++; }
      prevSignificant = quote;
      continue;
    }
    // 模板字符串：说明符位置不合法，内容一律剥掉；${expr} 插值保留
    if (c === '`') {
      blank(i++);
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { blank(i++); if (i < n) blank(i++); continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2; // 插值保留：跳过 ${ 不剥
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          continue;
        }
        blank(i++);
      }
      if (i < n) blank(i++);
      prevSignificant = '`';
      continue;
    }
    // 正则字面量：内容剥掉（/re/ 里的引号和 // 会被误判为字符串/注释）
    if (c === '/' && regexAllowed()) {
      // 回溯确认：/ 后不能是空格（/= 除法赋值也不行）
      if (next !== ' ' && next !== '=') {
        let j = i + 1;
        let ok = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') { // 字符类里的 / 不终结
            j++;
            while (j < n && src[j] !== ']') { if (src[j] === '\\') j++; j++; }
            j++;
            continue;
          }
          if (src[j] === '/') { ok = true; break; }
          j++;
        }
        if (ok) {
          blank(i++);
          while (i <= j) blank(i++);
          // 跳过 flags
          while (i < n && /[a-z]/.test(src[i])) blank(i++);
          prevSignificant = '/';
          continue;
        }
      }
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join('');
}

// import 声明识别：静态 import / export-from / 动态 import()
// 静态 import / export-from 锚定行首（清洗后语句前没有别的代码）；
// 动态 import( 不锚定——await import(...) 出现在表达式任意位置。
const IMPORT_RE = /^\s*(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+(?:\*|{[^}]+})\s+from\s+)(?:'|")([^'"]+)(?:'|")/gm;
const DYNAMIC_RE = /\bimport\s*\(\s*(?:'|")([^'"]+)(?:'|")/g;

// ─── 依赖扫描 ───────────────────────────────────────────────────

export async function collectDeps(rootDir) {
  rootDir = resolve(rootDir);
  const files = [];
  async function visit(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.git')) continue;
      const p = resolve(dir, e.name);
      if (e.isDirectory()) await visit(p);
      else if (e.isFile() && JS_EXT.test(e.name)) files.push(p);
    }
  }
  await visit(rootDir);

  const edgeSet = new Set(); // "from\x00to" —— 全局去重
  const ids = new Set();
  for (const abs of files) {
    const id = idOf(abs, rootDir);
    if (id) ids.add(id);
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch { continue; }
    const cleaned = stripCommentsAndStrings(text);
    const seen = new Set();
    // 两类说明符走同一套解析/去重
    const specs = [
      ...[...cleaned.matchAll(IMPORT_RE)].map((m) => m[1]),
      ...[...cleaned.matchAll(DYNAMIC_RE)].map((m) => m[1]),
    ];
    for (const t of specs) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!t.startsWith('.') && !t.startsWith('/')) continue; // 裸包名（react 等）不进图
      const absT = resolve(dirname(abs), t);
      // 解析顺序：原样（import 已带扩展名）→ 加 .js → 目录 index.js。
      // 原样优先——'./paths.js' 若先尝试拼扩展名会变成 paths.js.js 永远 miss。
      const cand = existsSync(absT) && JS_EXT.test(absT) ? absT
        : existsSync(absT + '.js') ? absT + '.js'
        : existsSync(absT + sep + 'index.js') ? absT + sep + 'index.js'
        : null;
      if (!cand) continue;
      const tid = idOf(cand, rootDir);
      if (tid && tid !== id) edgeSet.add(`${id}\x00${tid}`);
    }
  }
  const edges = [...edgeSet].map((k) => { const [from, to] = k.split('\x00'); return { from, to }; });
  edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  return { ids: Array.from(ids).sort(), edges };
}

// 路径 → 点分 ID（路径层级即命名空间）：core/store.js → core.store
function idOf(abs, root) {
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..')) return null;
  return rel.replace(/[\\/]+/g, '.').replace(/\.(js|mjs|cjs|jsx)$/, '');
}

// ─── digraph 生成 ────────────────────────────────────────────────

export async function depsToDot(rootDir) {
  const { ids, edges } = await collectDeps(rootDir);
  const lines = ['digraph nx_rp_dependencies {',
    '  graph [rankdir=LR, splines=true, overlap=false, ranksep=0.6, nodesep=0.3];',
    '  node  [shape=box, style=filled, fontname="Helvetica", fontsize=10];',
  ];
  function color(id) {
    if (id.startsWith('core.')) return '#dcfce7';
    if (id.startsWith('modules.')) return '#dbeafe';
    if (id.startsWith('runtime.')) return '#ffedd5';
    if (id.startsWith('web.')) return '#ede9fe';
    return '#f1f5f9';
  }
  function layerOf(id) {
    return id.split('.')[0];
  }
  for (const id of ids) {
    lines.push(`  "${id}" [label="${id.replace(/\./g, '/')}", fillcolor="${color(id)}"];`);
  }
  for (const e of edges) {
    const c = layerOf(e.from) === layerOf(e.to) ? '#94a3b8' : '#dc2626';
    lines.push(`  "${e.from}" -> "${e.to}" [color="${c}"];`);
  }
  lines.push('}');
  const crossLayer = edges.filter((e) => layerOf(e.from) !== layerOf(e.to)).length;
  return {
    dot: lines.join('\n'),
    nodes: ids.map((id) => ({ id, fillcolor: color(id) })),
    edges,
    stats: { files: ids.length, edges: edges.length, crossLayer },
  };
}

// ─── DOT 文本导出/导入（save/load）───────────────────────────────
//
// save/load 是 DOT 文本的落盘与读回（graphviz 交接、外部 .dot 复用），
// 不回写源码语义——图的事实源永远是源码 import（scan）。
// baseDir 走参数注入：生产不传（走 cwdDir()，ALS 穿透面板激活 scope），
// 测试传 tmp 目录——不走 annotations 那种模块级 setter，deps 没有历史包袱。
import { cwdDir } from '../../core/paths.js';
import { notFound, invalidInput } from '../../core/errors.js';

const DOT_TEXT_CAP = 2 * 1024 * 1024; // save 输入上限
const LOAD_HARD_CAP = 200_000;        // 对齐 annotations 的 FULL_HARD_CAP

export async function saveDot({ file, dot, baseDir } = {}) {
  const base = baseDir || cwdDir();
  if (typeof file !== 'string' || !file.trim()) throw invalidInput('缺少 file（cwd 相对路径，.dot/.gv 扩展名）');
  if (isAbsolute(file)) throw invalidInput(`file 必须是 cwd 相对路径（收到绝对路径: ${file}）`);
  if (file.split(/[\\/]/).includes('..')) throw invalidInput(`file 不允许包含 '..': ${file}`);
  if (!/\.(dot|gv)$/i.test(file)) throw invalidInput(`file 扩展名必须是 .dot/.gv（收到: ${file}）`);
  if (typeof dot !== 'string' || !dot.trim()) throw invalidInput('缺少 dot 文本（空内容不保存）');
  if (dot.length > DOT_TEXT_CAP) throw invalidInput(`DOT 文本超限（${dot.length} > ${DOT_TEXT_CAP} 字符）`);
  if (dot.includes('\0')) throw invalidInput('检测到二进制内容（NUL），拒绝保存');

  const abs = resolve(base, file);
  const existed = existsSync(abs);
  await fsp.mkdir(dirname(abs), { recursive: true });
  await fsp.writeFile(abs, dot, 'utf8');
  return { file: abs, bytes: Buffer.byteLength(dot, 'utf8'), overwritten: existed };
}

export async function loadDot({ file, baseDir } = {}) {
  // 相对按 base（cwd 激活 scope）解析；绝对路径原样——导入外部文件本来就是
  // 跨目录场景（对齐 annotations loadFile 的宽容方向）
  const abs = isAbsolute(file) ? resolve(file) : resolve(baseDir || cwdDir(), file);
  let stat;
  try { stat = await fsp.stat(abs); }
  catch { throw notFound(`文件不存在: ${file}`); }
  if (stat.size > LOAD_HARD_CAP) {
    throw invalidInput(`文件超限（${stat.size} > ${LOAD_HARD_CAP} 字节）；如需加载大文件请先精简`);
  }
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) {
    throw invalidInput('检测到二进制内容，拒绝加载（.dot 必须是文本）');
  }
  const text = buf.toString('utf8');
  return { file: abs, chars: text.length, dot: text };
}

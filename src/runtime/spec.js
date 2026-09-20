// action 规格：CLI 参数解析、HTTP 路由编译、help 用法串生成。
//
// 一份 action 形状（与 [[00-design-and-verify]] 第三节对齐）：
//
//   {
//     id, cli, http, summary,
//     args: ['ref'] | [{name, required}],
//     flags: { name: { type, default, required, enum, hint } },
//     run: async (ctx, meta) => any,
//     render: (data, ctx) => string,
//     streamBody / streamResponse: true,
//   }
//
// flag.type 是关键：只有 action 自己知道哪些 flag 是 boolean，
// 所以规格随 action 声明——不用全局白名单。

// ─── CLI 路径 ──────────────────────────────────────────────────────

// cli 支持二维数组表别名。返回 paths 数组，每条是该 action 的所有 CLI 路径。
export function cliPathsOf(action) {
  const cli = action.cli;
  if (!cli) return [];
  if (Array.isArray(cli[0])) return cli.map((p) => p.map(String));
  return [cli.map(String)];
}

// ─── args / flags 规格 ──────────────────────────────────────────────

// 把 args 标准化为 [{name, required}] 数组。
export function argSpecsOf(action) {
  const args = action.args || [];
  return args.map((a) => {
    if (typeof a === 'string') return { name: a, required: true };
    return { name: a.name, required: a.required !== false };
  });
}

export function flagSpecsOf(action) {
  const flags = action.flags || {};
  return Object.entries(flags).map(([name, spec]) => ({
    name,
    type: spec.type || 'string',
    required: !!spec.required,
    default: spec.default,
    enum: spec.enum,
    hint: spec.hint,
  }));
}

// ─── 用法串生成 ─────────────────────────────────────────────────────

export function usageOf(action) {
  const parts = ['nx-rp', ...cliPathsOf(action)[0]];
  for (const a of argSpecsOf(action)) parts.push(a.required ? `<${a.name}>` : `[${a.name}]`);
  for (const f of flagSpecsOf(action)) {
    let token;
    if (f.type === 'boolean') token = `--${f.name}`;
    else {
      const hint = f.enum ? f.enum.join('|') : f.hint || f.name;
      token = `--${f.name} <${hint}>`;
    }
    parts.push(f.required ? token : `[${token}]`);
  }
  return parts.join(' ');
}

// ─── applySpec：把任意来源的 raw 输入强转成 ctx ─────────────────────

// raw 来源：
//   - CLI argv 解析后的 { args: [], flags: {} }
//   - HTTP 路由占位符 / query / body 合并的扁平对象
//
// 强转做的事：
//   1. 用 args 声明把位置参数具名化
//   2. flag.type 把字符串转成 boolean / number / array
//   3. flag.default **只在传值**时注入（见 [[06-extension-loop]] 第 3 条坑）
//   4. flag.required 不传则抛 INVALID_INPUT
//
// 错误带完整用法串，给 agent「用法:」锚点。
export function applySpec(action, raw) {
  const out = {};
  const positionalNames = argSpecsOf(action).map((a) => a.name);
  const rawArr = Array.isArray(raw.args) ? raw.args : [];
  positionalNames.forEach((n, i) => {
    // 优先从 args 数组取；fallback 到扁平对象（HTTP 路由占位符 / query / body 合并的形态）
    if (i < rawArr.length) out[n] = rawArr[i];
    else if (raw[n] !== undefined) out[n] = raw[n];
  });
  for (const f of flagSpecsOf(action)) {
    if (Object.prototype.hasOwnProperty.call(raw, f.name) || raw[f.name] !== undefined) {
      const v = raw[f.name];
      out[f.name] = coerce(f, v, action);
    }
  }
  for (const a of argSpecsOf(action)) {
    if (out[a.name] === undefined && a.required) {
      throw new Error(`用法: ${usageOf(action)} —— 缺少参数 <${a.name}>`);
    }
  }
  for (const f of flagSpecsOf(action)) {
    if (out[f.name] === undefined && f.required) {
      throw new Error(`用法: ${usageOf(action)} —— 缺少 --${f.name}`);
    }
  }
  return out;
}

function coerce(f, v, action) {
  if (v === undefined || v === null) return v;
  if (f.type === 'boolean') {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    throw new Error(`用法: ${usageOf(action)} —— --${f.name} 期望 boolean，收到 ${JSON.stringify(v)}`);
  }
  if (f.type === 'number') {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`用法: ${usageOf(action)} —— --${f.name} 期望 number，收到 ${JSON.stringify(v)}`);
    return n;
  }
  if (f.type === 'array') {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    throw new Error(`用法: ${usageOf(action)} —— --${f.name} 期望 array，收到 ${JSON.stringify(v)}`);
  }
  if (f.enum && !f.enum.includes(String(v))) {
    throw new Error(`用法: ${usageOf(action)} —— --${f.name} 必须是 ${f.enum.join('|')}，收到 ${JSON.stringify(v)}`);
  }
  return String(v);
}

// ─── HTTP 路由编译 ──────────────────────────────────────────────────

// 把 /api/repos/:ref 编译成正则 + 路径键名。
const ROUTE_CACHE = new WeakMap();

export function compileRoute(action) {
  const cached = ROUTE_CACHE.get(action);
  if (cached) return cached;
  const [method, pattern] = action.http;
  const keys = [];
  const body = pattern
    .split('/')
    .map((seg) => {
      if (!seg.startsWith(':')) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(seg.slice(1));
      return '([^/]+)';
    })
    .join('/');
  const compiled = { method, keys, regex: new RegExp('^' + body + '$') };
  ROUTE_CACHE.set(action, compiled);
  return compiled;
}
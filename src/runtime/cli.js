// CLI 运行器：解析 argv → 匹配 action → 强转 → 调 run → 渲染。
//
// 平台命令与模块 action 共用同一张 ALL_COMMANDS：
//   serve / help / version 在这里；业务能力 → 各模块 action。
// 两条进同一张表，所以 help / routes / bootstrap 都不会漏掉任一侧。

import { ACTIONS } from './registry.js';
import { argSpecsOf, cliPathsOf, flagSpecsOf, usageOf } from './spec.js';

// ---- argv 解析（最小化手工；按 token 切分） ----

// 全局 flag 在任意位置先摘掉，再匹配命令。
const GLOBAL_FLAGS = new Set(['--json']);

function stripGlobal(argv) {
  const out = [];
  const globals = {};
  for (const a of argv) {
    if (GLOBAL_FLAGS.has(a)) {
      globals[a.slice(2)] = true;
      continue;
    }
    // --store=<path> / --port=<n>
    const m = /^--(store|port)=(.+)$/.exec(a);
    if (m) {
      globals[m[1]] = m[2];
      continue;
    }
    out.push(a);
  }
  return { argv: out, globals };
}

function parseFlags(action, tokens) {
  // 把 token 流切成 args（位置）+ flags（命名）。
  const argSpecs = argSpecsOf(action);
  const flagSpecs = flagSpecsOf(action);
  const flagByName = new Map(flagSpecs.map((f) => [f.name, f]));

  const positional = [];
  const flags = {};
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const rawName = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const name = rawName.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // kebab → camel
      const spec = flagByName.get(name) || flagByName.get(rawName);
      if (!spec) throw new Error(`未知 flag: --${rawName}`);
      if (spec.type === 'boolean') {
        flags[name] = eq >= 0 ? tok.slice(eq + 1) : true;
      } else if (eq >= 0) {
        flags[name] = tok.slice(eq + 1);
      } else if (i + 1 < tokens.length) {
        flags[name] = tokens[++i];
      } else {
        throw new Error(`用法: ${usageOf(action)} —— --${rawName} 需要值`);
      }
    } else {
      positional.push(tok);
    }
    i++;
  }
  if (positional.length < argSpecs.filter((a) => a.required).length) {
    throw new Error(`用法: ${usageOf(action)} —— 缺少必填参数`);
  }
  return { args: positional, flags };
}

// ---- 命令匹配（最长前缀） ----

export function matchCommand(commands, argv) {
  let best = null;
  for (const c of commands) {
    for (const path of cliPathsOf(c)) {
      if (argv.length < path.length) continue;
      let ok = true;
      for (let i = 0; i < path.length; i++) {
        if (argv[i] !== path[i]) { ok = false; break; }
      }
      if (!ok) continue;
      if (!best || path.length > best.path.length) best = { command: c, path, rest: argv.slice(path.length) };
    }
  }
  return best;
}

// ---- 渲染：CLI 文本 vs --json ----

function renderCli(data, action, ctx) {
  if (action.render) return action.render(data, ctx);
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  return JSON.stringify(data);
}

function renderJson(data) {
  // 业务结果（包括冲突 status）都是 ok:true，错误才有 ok:false。
  // 输出「单个 JSON 值」，无外壳、无 ANSI。
  const replacer = (_k, v) => (v === undefined ? undefined : v);
  return JSON.stringify(data, replacer);
}

// ---- 入口 ----

import { BUILTINS } from './builtins.js';

export const ALL_COMMANDS = [...BUILTINS, ...ACTIONS];

export async function runCli(argv) {
  // 友好兼容：`--help` / `-h` / `help` 都等价
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    argv = ['help'];
  } else if (argv.length === 0) {
    argv = ['help'];
  }

  const { argv: tokens, globals } = stripGlobal(argv);
  const json = !!globals.json;

  const m = matchCommand(ALL_COMMANDS, tokens);
  if (!m) {
    const e = new Error(`未知命令: ${tokens.join(' ')}\n用 nx-rp help 查看可用命令`);
    e.code = 'INVALID_INPUT';
    throw e;
  }

  // serve / help / version / skill 等平台命令不走 spec parser（它们的 shape 自管）
  const action = m.command;
  const rest = m.rest;

  let ctx;
  const builtinIds = new Set(BUILTINS.map((b) => b.id));
  if (builtinIds.has(action.id)) {
    // 把 --json / --store 等全局 flag 一并喂给 rest，让 serve 等也能识别
    ctx = [...rest];
    if (globals.store) ctx.push('--store', globals.store);
  } else {
    const { args, flags } = parseFlags(action, rest);
    ctx = applySpecInline(action, { args, ...flags });
  }

  if (globals.store) process.env.NX_RP_STORE = globals.store;
  if (globals.port) process.env.NX_RP_PORT = String(globals.port);

  const meta = { transport: 'cli' };
  try {
    const data = await action.run(ctx, meta);
    if (json) {
      console.log(renderJson(data ?? null));
    } else {
      const out = renderCli(data, action, ctx);
      if (out) console.log(out);
    }
  } catch (err) {
    // AppError：友好文案；其它错误：打栈方便排查
    if (err && err.code) {
      console.error(err.code + ': ' + (err.message || err));
      if (err.details !== undefined) console.error('details:', JSON.stringify(err.details));
    } else {
      throw err;
    }
    process.exitCode = 1;
  }
}

// 把 spec.applySpec 包成只接 raw 对象（避免 import 引起循环）
import { applySpec } from './spec.js';
function applySpecInline(action, raw) {
  return applySpec(action, raw);
}
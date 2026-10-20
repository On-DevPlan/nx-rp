// 系统模块：只做聚合与自检，没有自己的业务状态，也没有面板视图。
//
// 分层例外：本模块是**刻意的聚合器**，允许 import 其他模块的 service
// （eslint 对 src/modules/system/** 单独放行）。其余模块之间禁止互相依赖。
import { statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_NAME, storePathFromEnv, cwdScope, normalizeScope } from '../../core/paths.js';
import { loadStore, mutateStore } from '../../core/store.js';
import { invalidInput } from '../../core/errors.js';
import { commandEntry } from '../../runtime/builtins.js';

// recents 上限与 store.js 的 RECENTS_LIMIT 对齐（normalize 会再截一次，这里防抖）。
const RECENTS_LIMIT = 20;

// 包的版本号：app 段要带上它，别的 nx-xx 面板靠 app.name 认领同款。
const VERSION = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
).version;

// 登记一个最近目录：upsert（同 scope 更新置顶，新条目插到最前）。
// path 接受原始大小写，scope 键内部归一化——两条入口（面板 POST、serve 启动登记）
// 都走这里，保证 recents 的排序与去重规则只有一份。
export async function touchRecent(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') throw invalidInput('缺少目录路径');
  const abs = resolve(rawPath);
  let st;
  try { st = statSync(abs); } catch { throw invalidInput(`目录不存在: ${abs}`); }
  if (!st.isDirectory()) throw invalidInput(`不是目录: ${abs}`);
  const scope = normalizeScope(abs);
  const entry = { scope, path: abs, lastUsedAt: new Date().toISOString() };
  return mutateStore((store) => {
    store.recents = [entry, ...store.recents.filter((r) => r.scope !== scope)].slice(0, RECENTS_LIMIT);
    return entry;
  });
}

async function listRecents() {
  const store = await loadStore();
  return store.recents;
}

// 命名导出：测试与库用方可单独 import（同 touchRecent 的导出形态）。
export { listRecents };

// 从最近目录列表移除一个条目：按 normalizeScope 后的 key 过滤。
//
// 业务结果用 { status } 返回，不抛异常——调用方要拿它分支判断
// "目录本来就不在列表里"（幂等视角），与 touchRecent 的失败抛异常形成
// 互补：登记是「目标不在就报错」，移除是「目标不在也算成功」。
async function removeRecent(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') throw invalidInput('缺少目录路径');
  const scope = normalizeScope(rawPath);
  return mutateStore((store) => {
    const before = store.recents.length;
    store.recents = store.recents.filter((r) => r.scope !== scope);
    if (store.recents.length === before) return { status: 'not_found', scope, path: rawPath };
    return { status: 'ok', scope };
  });
}

export { removeRecent };

async function bootstrap() {
  const store = await loadStore();
  return {
    // app 段是跨项目唯一的认领签名：别的 nx-xx 面板靠它认出「同款」，
    // 从而复用端口上已经在跑的那个面板，而不是各起一个进程。
    app: { name: APP_NAME, version: VERSION },
    version: '0.1.0',
    appStorePath: storePathFromEnv(),
    cwdScope: cwdScope(),
    // 服务进程自己的目录：面板切了激活 scope 后，这个字段仍指回 serve 启动目录。
    serverScope: normalizeScope(process.cwd()),
    settings: store.settings,
    recents: store.recents,
    // 命令表随 bootstrap 下发前端，面板底部的「CLI 等价」提示由此渲染。
    commands: await commandTable(),
  };
}

async function commandTable() {
  const { ACTIONS } = await import('../../runtime/registry.js');
  const { BUILTINS } = await import('../../runtime/builtins.js');
  return [...BUILTINS, ...ACTIONS].map(commandEntry);
}

async function health() {
  const store = await loadStore();
  return {
    status: 'ok',
    version: '0.1.0',
    appStorePath: storePathFromEnv(),
    cwdScope: cwdScope(),
    storeReachable: !!store,
  };
}

async function routes(ctx) {
  const { ACTIONS } = await import('../../runtime/registry.js');
  const { BUILTINS } = await import('../../runtime/builtins.js');
  const all = [...BUILTINS, ...ACTIONS].map(commandEntry);
  if (ctx.module) return all.filter((c) => c.module === ctx.module);
  return all;
}

export default {
  id: 'system',
  title: '系统',
  order: 0,
  view: null,

  actions: [
    {
      id: 'system.bootstrap',
      cli: ['bootstrap'],
      http: ['GET', '/api/bootstrap'],
      summary: '聚合上下文：版本 / 存储路径 / cwd 作用域 / 设置 / 命令表',
      run: bootstrap,
    },
    {
      id: 'system.health',
      cli: ['health'],
      http: ['GET', '/api/health'],
      summary: '健康检查（进程存活 + 存储可达 + cwd 作用域）',
      run: health,
    },
    {
      id: 'system.routes',
      cli: ['routes'],
      http: ['GET', '/api/routes'],
      summary: '命令 ↔ 路由对照表（--module 过滤）',
      flags: { module: { type: 'string', hint: '模块名' } },
      run: routes,
    },
    {
      id: 'system.recents',
      cli: ['recents'],
      http: ['GET', '/api/recents'],
      summary: '最近使用的工作目录列表（面板快速切换 scope 的数据源）',
      run: listRecents,
      render: (list) => (list.length
        ? list.map((r) => `${r.path}${r.lastUsedAt ? '    # ' + r.lastUsedAt : ''}`).join('\n')
        : '（还没有记录。nx-rp serve 启动或面板切换时自动登记）'),
    },
    {
      // 纯 HTTP：登记入口是面板/serve，CLI 侧只读（nx-rp recents）。
      // registry 允许「有 http 无 cli」——只要不反过来。
      id: 'system.recents.touch',
      cli: null,
      http: ['POST', '/api/recents'],
      summary: '登记/置顶一个最近目录（body: { path }，必须是存在的目录）',
      flags: { path: { type: 'string', required: true, hint: '目录路径' } },
      run: (ctx) => touchRecent(ctx.path),
    },
    {
      // remove 与 touch 对称：touch 用 POST + body，remove 用 DELETE + body（同形态对齐）。
      // 走 body 而非 URL 占位符 :scope，避开 ctx 契约里 URL 占位符名 ≠ args 名的静默坑
      // （applySpec 从 raw[scope] 取值，但 args 声明为 path，二者对不上 → path 永远 undefined）。
      id: 'system.recents.remove',
      cli: ['recents', 'remove'],
      http: ['DELETE', '/api/recents'],
      summary: '从最近目录列表中移除一个目录（body/--path，不存在也算成功）',
      flags: { path: { type: 'string', required: true, hint: '要移除的目录路径' } },
      run: (ctx) => removeRecent(ctx.path),
      render: (r) => (r.status === 'not_found' ? `未找到: ${r.path}` : `已移除: ${r.scope}`),
    },
  ],
};
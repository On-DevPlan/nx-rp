// 系统模块：只做聚合与自检，没有自己的业务状态，也没有面板视图。
//
// 分层例外：本模块是**刻意的聚合器**，允许 import 其他模块的 service
// （eslint 对 src/modules/system/** 单独放行）。其余模块之间禁止互相依赖。
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { storePathFromEnv, cwdScope, normalizeScope } from '../../core/paths.js';
import { loadStore, mutateStore } from '../../core/store.js';
import { invalidInput } from '../../core/errors.js';
import { commandEntry } from '../../runtime/builtins.js';

// recents 上限与 store.js 的 RECENTS_LIMIT 对齐（normalize 会再截一次，这里防抖）。
const RECENTS_LIMIT = 20;

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

async function bootstrap() {
  const store = await loadStore();
  return {
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
  ],
};
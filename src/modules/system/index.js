// 系统模块：只做聚合与自检，没有自己的业务状态，也没有面板视图。
//
// 分层例外：本模块是**刻意的聚合器**，允许 import 其他模块的 service
// （eslint 对 src/modules/system/** 单独放行）。其余模块之间禁止互相依赖。
import { storePathFromEnv, cwdScope } from '../../core/paths.js';
import { loadStore } from '../../core/store.js';
import { commandEntry } from '../../runtime/builtins.js';

async function bootstrap() {
  const store = await loadStore();
  return {
    version: '0.1.0',
    appStorePath: storePathFromEnv(),
    cwdScope: cwdScope(),
    settings: store.settings,
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
  ],
};
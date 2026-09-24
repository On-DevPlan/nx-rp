// 库入口：导出各模块 service，供程序化调用。
//
// 新增模块时**必须**在这里 export * as <name>，否则库用方拿不到该 service。
// 这是闭环表第 6 项——没有任何断言会替你发现，漏了纯静默。
export * as paths from './core/paths.js';
export * as errors from './core/errors.js';
export * as store from './core/store.js';
export * as claudeSettings from './core/claude-settings.js';
export * as hookIo from './core/hook-io.js';
export * as link from './modules/link/service.js';
export * as doc from './modules/doc/service.js';
export * as deps from './modules/deps/service.js';
export * as hookPrompt from './modules/hook-prompt/service.js';
export * as hookSkill from './modules/hook-skill/service.js';
export * as annotations from './modules/annotations/service.js';
export * as zg from './modules/doc/zg.js';
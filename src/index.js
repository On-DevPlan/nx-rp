// 库入口：导出各模块 service，供程序化调用。
//
// 新增模块时**必须**在这里 export * as <name>，否则库用方拿不到该 service。
// 这是闭环表第 6 项——没有任何断言会替你发现，漏了纯静默。
export * as paths from './core/paths.js';
export * as errors from './core/errors.js';
export * as store from './core/store.js';
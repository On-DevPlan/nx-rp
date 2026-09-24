// AsyncLocalStorage 隔离层——独立模块避免被前端静态图触碰。
//
// 原因：paths.js 被前端通过 store.js → paths.js 链间接拉进 bundle 时，
// paths.js 里的 `import 'node:async_hooks'` 会被 vite externalize 并触发
// 「Cannot access AsyncLocalStorage in client code」。
//
// 解决方案：把 AsyncLocalStorage 单例放独立文件；CLI/服务端代码通过显式
// `import { scopeStorage } from '../../core/als.js'` 引用——前端 bundle
// （不引用此模块）就完全不沾这个外部依赖。
import { AsyncLocalStorage } from 'node:async_hooks';

export const scopeStorage = new AsyncLocalStorage();
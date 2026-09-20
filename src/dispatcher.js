// 跨模块 action 调用器。
//
// workflow 模块的 ctx.nx 需要按 actionId 触发其他模块的 action。
// 直接 import runtime/registry 会破分层（core/modules 不允许依赖 runtime），
// 所以这里只做参数注入与错误翻译，ACTIONS 表由 system/index.js 在调用时注入。
//
// 用法：
//   const { ACTIONS } = await import('../../runtime/registry.js');
//   const { applySpec } = await import('../../runtime/spec.js');
//   dispatcher(ACTIONS, applySpec)(actionId, params, meta)
//
// 但 workflow/service.js 拿不到 ACTIONS 表（破分层）——所以这里只导出
// 一个「按 actionId 字符串触发」的工厂，调用方负责注入。

let cached = null;

async function buildDispatcher() {
  if (cached) return cached;
  const [{ ACTIONS }, { applySpec }] = await Promise.all([
    import('./runtime/registry.js'),
    import('./runtime/spec.js'),
  ]);
  cached = async function dispatch(actionId, ctx = {}, meta = { transport: 'cli' }) {
    const a = ACTIONS.find((x) => x.id === actionId);
    if (!a) {
      const e = new Error(`未知 action: ${actionId}`);
      e.code = 'NOT_FOUND';
      throw e;
    }
    const fullCtx = applySpec(a, ctx);
    return a.run(fullCtx, meta);
  };
  return cached;
}

export async function dispatch(actionId, ctx, meta) {
  const fn = await buildDispatcher();
  return fn(actionId, ctx, meta);
}
export default async function run(ctx) {
  await ctx.parallel({
    '列链接': () => ctx.nx('link.list'),
    '列文档': () => ctx.nx('doc.list'),
    '查路由': () => ctx.nx('system.routes', { module: 'workflow' }),
  });
  await ctx.step('健康检查', () => ctx.nx('system.health'));
}
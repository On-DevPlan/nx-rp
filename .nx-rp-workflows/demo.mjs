// 写一个 async 函数，导出默认。
// ctx.step(name, fn, opts?)  节点：自动建图 + 状态追踪
//   opts.type:    'nxAction' | 'agent-call' | 'http' | 'raw'
//   opts.after:   [name]  显式前驱
// ctx.parallel({ a: fn, b: fn })  并发：节点同组、虚线相连
// ctx.http(url) / ctx.nx(id, p) / ctx.agent(cmd, args)  都是 ctx.step 的语法糖
export default async function run(ctx) {
  await ctx.parallel({
    '启动后端': () => ctx.agent('node', ['./server.js']),
    '启动db':   () => ctx.agent('docker', ['compose', 'up', '-d']),
  });
  await ctx.step('健康检查', () => ctx.http('http://localhost:3000/health'));
  await ctx.step('跑测试', () => ctx.agent('pnpm', ['test']));
}

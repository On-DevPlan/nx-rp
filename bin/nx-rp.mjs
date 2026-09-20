#!/usr/bin/env node
// 唯一可执行入口：转发 argv、兜住未捕获异常。
// 所有命令分发都在 src/runtime/cli.js —— 那里才是命令表。
//
// 为什么唯一入口：多入口 = 多份参数解析 = 迟早不一致。
import { runCli } from '../src/runtime/cli.js';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
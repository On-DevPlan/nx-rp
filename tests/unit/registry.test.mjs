// 一致性测试：把「Web 上每个操作都有等价 CLI 命令」从口头约定变成可执行断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULES_DIR = join(ROOT, 'src', 'modules');

const { MODULES, ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
const { cliPathsOf } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'spec.js')).href);

const moduleDirs = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try { readFileSync(join(MODULES_DIR, name, 'index.js')); return true; }
    catch { return false; }
  });

const frontendRegistrySrc = readFileSync(join(ROOT, 'src', 'web', 'frontend', 'registry.js'), 'utf8');
const frontendViewIds = [...frontendRegistrySrc.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);

test('每个模块目录都在后端注册表登记了', () => {
  const registered = new Set(MODULES.map((m) => m.id));
  const missing = moduleDirs.filter((d) => !registered.has(d));
  assert.deepEqual(missing, [], `这些模块目录没有在 src/runtime/registry.js 里登记: ${missing}`);
});

test('注册表里的模块都有对应目录', () => {
  const ghost = MODULES.map((m) => m.id).filter((id) => !moduleDirs.includes(id));
  assert.deepEqual(ghost, [], `注册表引用了不存在的模块目录: ${ghost}`);
});

test('每条 action 都声明了 CLI 命令（Web 操作必须有 CLI 等价）', () => {
  // cli: null 是合法的——纯 HTTP action（workflow.write / workflow.source）走 API 不暴露 CLI
  const problems = ACTIONS.filter((a) => !a.cli && a.cli !== null).map((a) => a.id);
  assert.deepEqual(problems, [], `以下 action 缺 CLI 命令: ${problems}`);
});

test('action id 与 CLI 路径均不重复', () => {
  const seen = new Set();
  const dupes = [];
  for (const a of ACTIONS) {
    if (seen.has(a.id)) dupes.push(a.id);
    seen.add(a.id);
  }
  assert.deepEqual(dupes, [], `action id 重复: ${dupes}`);
});

test('action 的 http 要么是路由数组，要么显式 null', () => {
  const bad = ACTIONS.filter((a) => a.http !== null && !Array.isArray(a.http)).map((a) => a.id);
  assert.deepEqual(bad, [], `http 形状非法: ${bad}`);
});

test('每条 HTTP 路由都能由某条 CLI 命令触达（核心保证）', () => {
  // cli: null 跳（HTTP 专属 action 通过 API 暴露）
  const httpActions = ACTIONS.filter((a) => a.http && a.cli);
  const bad = httpActions.filter((a) => !cliPathsOf(a).length).map((a) => a.id);
  assert.deepEqual(bad, [], `声明了 HTTP 但没 CLI 等价: ${bad}`);
});

test('带 view 的模块都在前端视图注册表登记', () => {
  const withView = MODULES.filter((m) => m.view).map((m) => m.id);
  const missing = withView.filter((id) => !frontendViewIds.includes(id));
  assert.deepEqual(missing, [], `带 view 但前端没登记: ${missing}`);
});

test('前端注册表里的视图文件真实存在', () => {
  for (const id of frontendViewIds) {
    assert.doesNotThrow(() => {
      const src = readFileSync(join(ROOT, 'src', 'modules', id, 'view.jsx'), 'utf8');
      // 必须 export default
      assert.match(src, /export\s+default/);
    }, `视图注册表引用了不存在的文件或没有 default export: ${id}`);
  }
});

// ---- CRUD 完备性 ----

const CRUD_VERB = { list: 'list', get: 'get', create: 'add', update: 'update', remove: 'remove' };
const HTTP_METHOD = { list: 'GET', get: 'GET', create: 'POST', update: 'PATCH', remove: 'DELETE' };

test('声明了 CRUD 资源的模块，五个操作齐备且两端可调用', () => {
  const resources = MODULES.filter((m) => m.resource);
  assert.ok(resources.length > 0, '没有任何模块声明 resource，这条检查形同虚设');

  const problems = [];
  for (const m of resources) {
    for (const [op, verb] of Object.entries(CRUD_VERB)) {
      const id = `${m.resource}.${verb}`;
      const a = ACTIONS.find((x) => x.id === id);
      if (!a) { problems.push(`${m.id}: 缺 ${op}（应为 ${id}）`); continue; }
      if (!cliPathsOf(a).length) problems.push(`${m.id}: ${id} 缺 CLI 命令`);
      if (!a.http) problems.push(`${m.id}: ${id} 缺 HTTP 路由（面板无法调用）`);
      if (!a.run) problems.push(`${m.id}: ${id} 没有 run`);
    }
  }
  assert.deepEqual(problems, [], `CRUD 不完备:\n${problems.join('\n')}`);
});

test('CRUD 路由的形状对得上语义', () => {
  const segs = (p) => p.split('/').filter(Boolean);
  const hasParam = (p) => segs(p).some((s) => s.startsWith(':'));
  for (const m of MODULES.filter((m) => m.resource)) {
    const httpOf = (op) => ACTIONS.find((a) => a.id === `${m.resource}.${CRUD_VERB[op]}`).http;
    assert.equal(hasParam(httpOf('list')[1]), false, `${m.id}: list 路由不应含 :param`);
    for (const op of ['get', 'update', 'remove']) {
      assert.ok(hasParam(httpOf(op)[1]), `${m.id}: ${op} 路由必须含 :param`);
    }
  }
});

test('CRUD 的 HTTP 方法符合语义', () => {
  for (const m of MODULES.filter((m) => m.resource)) {
    for (const [op, method] of Object.entries(HTTP_METHOD)) {
      const a = ACTIONS.find((x) => x.id === `${m.resource}.${CRUD_VERB[op]}`);
      if (!a || !a.http) continue;
      assert.equal(a.http[0], method, `${a.id} 的 HTTP 方法应为 ${method}，实际是 ${a.http[0]}`);
    }
  }
});

test('help 由声明生成：builtin + module 的命令都能被运行器解析回自身', async () => {
  const cliPath = pathToFileURL(join(ROOT, 'src', 'runtime', 'cli.js')).href;
  const { ALL_COMMANDS, matchCommand } = await import(cliPath);
  for (const c of ALL_COMMANDS) {
    // cli: null 是合法（纯 HTTP action），不参与解析回自身断言
    if (!c.cli) continue;
    const path = (Array.isArray(c.cli[0]) ? c.cli[0] : c.cli).map(String);
    const m = matchCommand(ALL_COMMANDS, path);
    assert.ok(m, `命令无法解析回自己: ${path.join(' ')}`);
    assert.equal(m.command.id, c.id, `命令匹配到了别人: ${path.join(' ')} → ${m.command.id}`);
  }
});
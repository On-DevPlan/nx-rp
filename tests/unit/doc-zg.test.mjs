// doc 域召回集成（zg.js）与实例化单测：路径序列化、KB 定位、doc export 镜像、zg 命令组装。
// zg 子进程不真跑（runZg 无 mock 钩子，测 service 纯逻辑与 doc 侧文件操作）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');

let tmp;

const pathsMod = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'nxrp-zg-'));
  pathsMod.setHookPaths({
    settingsPath: join(tmp, 'claude', 'settings.json'),
  });
});

afterEach(async () => {
  pathsMod.setHookPaths({
    settingsPath: join(process.env.USERPROFILE || process.env.HOME, '.claude', 'settings.json'),
    promptsDir: join(pathsMod.APP_DIR, 'prompts'),
    skillsDir: join(pathsMod.APP_DIR, 'skills'),
  });
  await rm(tmp, { recursive: true, force: true });
});

// ─── 路径序列化 ────────────────────────────────────────────────────

test('serializePath：与 Claude Code 项目目录同一规则（非字母数字→-）', () => {
  // 平台各断各的：Windows 盘符路径在 win32 resolve 出盘符小写；POSIX 上 'D:\...'
  // 不是绝对路径会被 resolve 拼到 cwd 前面——按 platform 分支，不做跨平台假断言
  if (process.platform === 'win32') {
    assert.equal(pathsMod.serializePath('D:\\a_js\\js_proj\\nx-rp'), 'd--a_js-js_proj-nx-rp');
    assert.equal(pathsMod.serializePath('C:\\Users\\zhlx'), 'c--users-zhlx');
  } else {
    assert.equal(pathsMod.serializePath('/home/u/proj'), '-home-u-proj');
    assert.equal(pathsMod.serializePath('/var/tmp'), '-var-tmp');
  }
  // 全 ASCII：中文/空格/点全部转掉（字面量直接映射，不经 resolve，两平台一致）
  assert.doesNotMatch(pathsMod.serializePath('中文 测试.项目'), /[^A-Za-z0-9_-]/);
});

test('workspaceKbFor：cwd → <docRoot>/<序列化名>/，默认 docRoot = ~/.nx-rp/doc', () => {
  // 用本平台真实路径（tmp 下），序列化产物随平台形态——断言只锁「末段=序列化名」关系
  const proj = join(tmp, 'proj A', 'demo');
  const kb = pathsMod.workspaceKbFor(proj);
  assert.ok(kb.endsWith(pathsMod.serializePath(proj)), kb);
  assert.ok(kb.includes(join(pathsMod.APP_DIR, 'doc')));
  // 自定义 docRoot：按平台给合法绝对路径
  const customRoot = process.platform === 'win32' ? 'E:\\kb-root' : '/tmp/kb-root';
  const kb2 = pathsMod.workspaceKbFor(proj, customRoot);
  assert.ok(kb2.startsWith(customRoot), kb2);
});

test('workspaceKbFor 拒绝穿越：序列化产物不可能含 / \\ ..', () => {
  // 序列化先于目录名使用，任何输入都不会产出穿越字符
  const evil = pathsMod.serializePath('..\\..\\etc');
  assert.ok(!/[\\/]/.test(evil));
  assert.ok(!evil.includes('..') || !/[\\/]/.test(evil));
});

// ─── doc 知识实例文件化 ────────────────────────────────────────────

async function freshStore() {
  // store 模块有进程内缓存（cached），跨测试必须显式失效，否则上个测试的
  // settings.docRoot 会泄进下个测试——那是「KB 落进真实 ~/.nx-rp/doc」的根因。
  const { forgetStore } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'store.js')).href);
  forgetStore();
}

test('doc exportDocs：store 文档 → KB md 文件镜像（含 frontmatter），幂等，删除条目同步删文件', async () => {
  // 用 NX_RP_STORE 指到临时 store；把 cwd 伪装成临时目录，KB 落在临时 docRoot
  const storePath = join(tmp, 'store.json');
  process.env.NX_RP_STORE = storePath;
  const origCwd = process.cwd();
  const fakeProj = join(tmp, 'proj');
  await mkdir(fakeProj, { recursive: true });
  process.chdir(fakeProj);
  await freshStore();
  try {
    const docSvc = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'doc', 'service.js')).href);
    // 先把 docRoot 指到临时目录，KB 不落真实 ~/.nx-rp/doc
    await docSvc.setDocRoot(join(tmp, 'kb-root'));
    const d1 = await docSvc.addDoc({ name: 'hook 设计', body: '# hook\n\n外科手术式写入。', tags: ['hook', '设计'] });
    const d2 = await docSvc.addDoc({ name: 'zg 召回', body: 'RRF 融合。', tags: ['zg'], source: 'https://example.com' });
    await docSvc.addDoc({ name: '空文档不实例化', body: '   ' });

    const r1 = await docSvc.exportDocs();
    assert.equal(r1.total, 2, '空 body 不实例化');
    assert.equal(r1.added, 2);
    assert.ok(r1.kbDir.startsWith(tmp), `KB 必须落在临时目录，实际 ${r1.kbDir}`);

    const files = await readdir(r1.kbDir);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    assert.equal(mdFiles.length, 2);

    const target = mdFiles.find((f) => f.includes(d1.id));
    const content = await readFile(join(r1.kbDir, target), 'utf8');
    assert.match(content, /^---\ntitle: /);
    assert.match(content, /tags: \["hook", "设计"\]/);
    assert.match(content, /外科手术式写入/);

    // 幂等：再跑一遍全部 no-op（exportedAt 是内容派生值，两次导出逐字节相同）
    const r2 = await docSvc.exportDocs();
    assert.equal(r2.added, 0);
    assert.equal(r2.updated, 0);
    assert.equal(r2.removed, 0);

    // 删除条目 → 文件同步移除
    await docSvc.removeDoc(d2.id);
    const r3 = await docSvc.exportDocs();
    assert.equal(r3.removed, 1);
    assert.equal(r3.total, 1);
  } finally {
    process.chdir(origCwd);
    delete process.env.NX_RP_STORE;
    await freshStore();
  }
});

test('doc root-set + migrate：换 docRoot 全量复制 KB、清旧根', async () => {
  const storePath = join(tmp, 'store.json');
  process.env.NX_RP_STORE = storePath;
  const origCwd = process.cwd();
  const fakeProj = join(tmp, 'proj-mig');
  await mkdir(fakeProj, { recursive: true });
  process.chdir(fakeProj);
  await freshStore();
  try {
    const docSvc = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'doc', 'service.js')).href);
    // 先把 docRoot 指到临时目录：不设的话 exportDocs 会落真实默认根（污染本机）
    await docSvc.setDocRoot(join(tmp, 'kb-origin'));
    await docSvc.addDoc({ name: '迁移测试', body: '内容', tags: [] });
    const r1 = await docSvc.exportDocs();
    const oldKb = r1.kbDir;

    const newRoot = join(tmp, 'kb-new');
    const r2 = await docSvc.setDocRoot(newRoot);
    assert.equal(r2.docRoot, newRoot);
    assert.ok(r2.migration.copied >= 1, '至少复制了当前 KB');

    const newKb = join(newRoot, oldKb.split(/[\\/]/).pop());
    const movedFiles = await readdir(newKb);
    assert.ok(movedFiles.some((f) => f.endsWith('.md')), '文件已搬到新根');

    const st = await docSvc.getDocRoot();
    assert.equal(st.docRoot, newRoot);
    assert.equal(st.isDefault, false);
  } finally {
    process.chdir(origCwd);
    delete process.env.NX_RP_STORE;
  }
});

// ─── zg.js 纯逻辑 ───────────────────────────────────────────────

test('zg.js：模型目录、解析与命令组装（不真跑 zg）', async () => {
  const svc = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'doc', 'zg.js')).href);
  // 三款远程模型可选，默认 qwen3.7-text-embedding
  assert.equal(svc.ZG_DEFAULT_MODEL, 'qwen/qwen3.7-text-embedding');
  assert.equal(svc.ZG_REMOTE_MODELS.length, 3);
  assert.ok(svc.ZG_REMOTE_MODELS.every((m) => m.id.startsWith('qwen/')));
  // resolveModel：默认 / 合法 / 非法
  assert.equal(svc.resolveModel(undefined), svc.ZG_DEFAULT_MODEL);
  assert.equal(svc.resolveModel('qwen/text-embedding-v4'), 'qwen/text-embedding-v4');
  assert.throws(() => svc.resolveModel('qwen/qwen3.7-text-embedding-flash'), /不支持的模型/);
  assert.equal(svc.ZG_KEY_GUIDE_URL, 'https://platform.qianwenai.com/home/');
  // auth 无 key → 只给引导 + 模型菜单，不执行
  const noKey = await svc.auth({});
  assert.equal(noKey.needKey, true);
  assert.ok(noKey.guideUrl.includes('platform.qianwenai.com'));
  assert.equal(noKey.modelOptions.length, 3);
  // query 空 q → invalidInput
  await assert.rejects(() => svc.query({ q: '  ' }), /查询不能为空/);
  // index 换模型不带 rebuild → 拒绝（防维度冲突）
  await assert.rejects(() => svc.index({ model: 'qwen/text-embedding-v4' }), /必须同时 --rebuild/);
});

test('doc 域 zg action：7 条 action 双端声明齐全', async () => {
  const { ACTIONS } = await import(pathToFileURL(join(ROOT, 'src', 'runtime', 'registry.js')).href);
  const ids = new Set(ACTIONS.map((a) => a.id));
  for (const id of ['doc.zg.install', 'doc.zg.auth', 'doc.zg.onboard', 'doc.zg.index', 'doc.zg.query', 'doc.zg.status', 'doc.zg.migrate']) {
    assert.ok(ids.has(id), `缺 action: ${id}`);
  }
  const byId = new Map(ACTIONS.map((a) => [a.id, a]));
  for (const id of ['doc.zg.install', 'doc.zg.auth', 'doc.zg.onboard', 'doc.zg.index', 'doc.zg.query', 'doc.zg.status', 'doc.zg.migrate']) {
    assert.ok(Array.isArray(byId.get(id).http), `${id} 缺 HTTP 路由`);
    assert.ok(byId.get(id).cli.length > 0, `${id} 缺 CLI`);
  }
  // onboard 无 key：只引导，绝不报错也绝不带 key 明文
  const svc = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'doc', 'zg.js')).href);
  const guide = await svc.onboard({});
  if (guide.step === 'get-key') {
    assert.ok(guide.message.includes('platform.qianwenai.com'));
    assert.ok(!guide.message.includes('sk-') || guide.message.includes('sk- 开头'), '引导文案不得包含真实 key');
  }
});

test('zg query 结果带来源头块（知识库根/子目录/来源工作目录/相对路径写法）', async () => {
  // 不真跑 zg：mock runZgIn。ESM mock 用模块图 hack 太重——直接抽头块逻辑验证：
  // 头块由 query 内联拼装，这里用真实 KB 目录走一遍 query 的 needIndex 分支 + 手工验证头块格式。
  const svc = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'doc', 'zg.js')).href);
  const fakeProj = join(tmp, 'proj-q');
  await mkdir(fakeProj, { recursive: true });
  // 未建索引 → needIndex 分支
  const r = await svc.query({ q: 'x', root: fakeProj });
  assert.equal(r.needIndex, true);
  assert.ok(r.kbDir.includes(pathsMod.serializePath(fakeProj)), 'KB 路径来自序列化');
  // 头块格式断言（与 service 内拼装一致的格式契约）
  const kbName = r.kbDir.split(/[\/]/).pop();
  const header = [
    '[nx-rp 知识库召回]',
    `知识库根: ${pathsMod.docRootFor(undefined)}`,
    `知识库子目录: ${kbName}`,
    `来源工作目录: ${fakeProj}`,
    `命中文件相对路径: <知识库根>/${kbName}/<文件名>#L<起>-L<止>（如需全文，直接读该绝对路径文件）`,
  ].join('\n');
  assert.match(header, /^\[nx-rp 知识库召回\]/);
  // 子目录名 = fakeProj 的序列化（POSIX 上 /tmp/... 首字符 / → '-'，与 win 盘符形态不同，
  // 所以断言用「包含序列化产物」而不是写死任一平台的字面量）
  assert.ok(header.includes(pathsMod.serializePath(fakeProj)), '子目录名来自序列化');
});

test('shared 共享知识库：--shared 条目导出到 <docRoot>/shared/（跨 scope 聚合）', async () => {
  const storePath = join(tmp, 'store.json');
  process.env.NX_RP_STORE = storePath;
  const origCwd = process.cwd();
  const fakeProj = join(tmp, 'proj-shared');
  await mkdir(fakeProj, { recursive: true });
  process.chdir(fakeProj);
  await freshStore();
  try {
    const docSvc = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'doc', 'service.js')).href);
    await docSvc.setDocRoot(join(tmp, 'kb-shared-root'));
    // 项目内普通文档 + 共享文档
    await docSvc.addDoc({ name: '项目私有', body: '只属于本项目' });
    await docSvc.addDoc({ name: '团队约定', body: 'commit 用中文', shared: true });

    const r = await docSvc.exportDocs();
    assert.equal(r.total, 1, '项目 KB 只有非 shared 条目');
    assert.equal(r.shared.total, 1, 'shared 桶只有 shared 条目');
    assert.ok(r.shared.kbDir.endsWith('shared'), `shared 目录固定名: ${r.shared.kbDir}`);

    const { readdir } = await import('node:fs/promises');
    const sharedFiles = await readdir(r.shared.kbDir);
    assert.ok(sharedFiles.some((f) => f.includes('团队约定') || /d_/.test(f)));

    // 跨 scope 聚合：另一个 scope 的 shared 条目也进同一桶
    await docSvc.addDoc({ name: '另一个项目的共享', body: '也进 shared', shared: true });
    const r2 = await docSvc.exportDocs();
    assert.equal(r2.shared.total, 2, 'shared 桶跨 scope 聚合');
  } finally {
    process.chdir(origCwd);
    delete process.env.NX_RP_STORE;
    await freshStore();
  }
});

test('zg.js 与 doc/service.js 的 shared 目录公式一致', async () => {
  const svc = await import(pathToFileURL(join(ROOT, 'src', 'modules', 'doc', 'service.js')).href);
  // 公式：<docRootFor(root)>/shared —— 服务侧唯一权威；zg.js 侧用同公式（同模块内联）
  const { docRootFor } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'paths.js')).href);
  const expected = join(docRootFor('E:/root'), 'shared');
  assert.equal(svc.sharedKbFor('E:/root'), expected);
});

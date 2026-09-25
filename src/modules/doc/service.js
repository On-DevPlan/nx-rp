// doc 资源业务：上下文文档（Markdown 短文）的登记与查询。
//
// 一个 doc = { id, name, body, tags, source }
// 五条 CRUD：list / get / add / update / remove。
//
// body 是 Markdown 文本——agent 拿来当 prompt 上下文。故意存全文（不长）。
import { mutateStore } from '../../core/store.js';
import { assertSafeName, cwdScope } from '../../core/paths.js';
import { notFound, invalidInput } from '../../core/errors.js';

function makeId() {
  return 'd_' + Math.random().toString(36).slice(2, 10);
}

function normalize(input) {
  if (!input.name || typeof input.name !== 'string') throw invalidInput('文档必须有名');
  return {
    name: input.name,
    body: typeof input.body === 'string' ? input.body : '',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    source: typeof input.source === 'string' ? input.source : '',
    shared: !!input.shared, // 共享知识：跨项目（导出到 <docRoot>/shared/，不随项目丢失）
  };
}

function currentScope(store) {
  const k = cwdScope();
  if (!store.scopes[k]) store.scopes[k] = { docs: [], workflows: {} };
  return store.scopes[k];
}

export async function listDocs() {
  const { scope } = await (await import('../../core/store.js')).getCurrentScope();
  return scope.docs;
}

export async function getDoc(id) {
  assertSafeName(id, '文档 id');
  const { scope } = await (await import('../../core/store.js')).getCurrentScope();
  const hit = scope.docs.find((d) => d.id === id);
  if (!hit) throw notFound(`文档不存在: ${id}`);
  return hit;
}

export async function addDoc(input) {
  const def = normalize(input);
  return mutateStore((store) => {
    const scope = currentScope(store);
    const doc = { id: makeId(), ...def, createdAt: new Date().toISOString() };
    scope.docs.push(doc);
    return doc;
  });
}

export async function updateDoc(id, patch) {
  assertSafeName(id, '文档 id');
  return mutateStore((store) => {
    const scope = currentScope(store);
    const idx = scope.docs.findIndex((d) => d.id === id);
    if (idx < 0) throw notFound(`文档不存在: ${id}`);
    const merged = { ...scope.docs[idx], ...patch, id: scope.docs[idx].id };
    scope.docs[idx] = { ...scope.docs[idx], ...normalize(merged) };
    return scope.docs[idx];
  });
}

export async function removeDoc(id) {
  assertSafeName(id, '文档 id');
  return mutateStore((store) => {
    const scope = currentScope(store);
    const idx = scope.docs.findIndex((d) => d.id === id);
    if (idx < 0) throw notFound(`文档不存在: ${id}`);
    const [removed] = scope.docs.splice(idx, 1);
    return removed;
  });
}
// ─── 知识实例文件化：store 里的 doc → KB 目录的 .md 文件 ──────────
//
// 「所有知识都实例文件化」：doc 条目是登记态（人/agent 在面板与 CLI 维护），
// 实例化后成为 KB 目录里的 markdown（zg 可索引、可语义召回）。
// 同步语义是**镜像**：export 按 doc 条目全量重写文件（删除的条目移除文件），
// 文件名 = <id>-<safeName>.md，frontmatter 携带元数据供 zg breadcrumb。
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { cwdDir, docRootFor, workspaceKbFor } from '../../core/paths.js';

export function docFileName(doc) {
  const safe = String(doc.name || doc.id).replace(/[^A-Za-z0-9_\-\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || doc.id;
  return `${doc.id}-${safe}.md`;
}

function toMarkdown(doc, scopeKey) {
  // exportedAt 用 doc.createdAt（内容派生值）而非 Date.now()——
  // 同一条目两次导出必须产出逐字节相同的内容，镜像同步才能靠「内容不等才写」实现幂等。
  const fm = [
    '---',
    `title: ${JSON.stringify(doc.name)}`,
    `id: ${doc.id}`,
    `tags: [${(doc.tags || []).map((t) => JSON.stringify(t)).join(', ')}]`,
    doc.source ? `source: ${JSON.stringify(doc.source)}` : null,
    `scope: ${JSON.stringify(scopeKey)}`,
    `exportedAt: ${doc.createdAt || ''}`,
    '---',
    '',
    doc.body || '',
  ].filter((l) => l !== null).join('\n');
  return fm.endsWith('\n') ? fm : fm + '\n';
}

// 全量同步当前 scope 的 docs 到 KB 目录 + 同步 shared 桶。
// shared（共享知识库）：<docRoot>/shared/，跨项目共用——放「基本信息」（团队约定、
// 常用命令、环境说明等），防止只存在于某个项目而丢失。本地存储，无安全边界设计。
// 返回 { added, updated, removed, kbDir, shared: {...} }。
export async function exportDocs({ root } = {}) {
  const { getCurrentScope } = await import('../../core/store.js');
  const { store } = await getCurrentScope();
  const scopeKey = root ? root : cwdDir();
  const { normalizeScope } = await import('../../core/paths.js');
  const key = normalizeScope(scopeKey);
  const docRootSetting = store.settings?.docRoot;
  const kbDir = workspaceKbFor(scopeKey, docRootSetting);
  await fsp.mkdir(kbDir, { recursive: true });

  const wanted = new Map();
  for (const doc of store.scopes[key]?.docs || []) {
    if (doc.shared) continue; // 共享条目进 shared 桶，不进项目桶
    if (!doc.body || !doc.body.trim()) continue; // 空文档不实例化
    wanted.set(docFileName(doc), toMarkdown(doc, key));
  }

  const r = await mirrorDocs(kbDir, wanted);

  // shared 桶：从**全部 scope** 收集 shared 条目（共享知识不属于任何项目）
  const sharedWanted = new Map();
  for (const scopeDocs of Object.values(store.scopes || {})) {
    for (const doc of scopeDocs?.docs || []) {
      if (doc.shared && doc.body && doc.body.trim()) {
        sharedWanted.set(docFileName(doc), toMarkdown(doc, 'shared'));
      }
    }
  }
  const sharedDir = sharedKbFor(docRootSetting);
  await fsp.mkdir(sharedDir, { recursive: true });
  const sr = await mirrorDocs(sharedDir, sharedWanted);

  return {
    kbDir, total: wanted.size, added: r.added, updated: r.updated, removed: r.removed,
    shared: { kbDir: sharedDir, total: sr.total, added: sr.added, updated: sr.updated, removed: sr.removed },
  };
}

// 镜像写核心：wanted（文件名→内容）对齐目录内容；多余的本命名空间文件删除。
async function mirrorDocs(kbDir, wanted) {
  let added = 0;
  let updated = 0;
  for (const [name, content] of wanted) {
    const p = join(kbDir, name);
    try {
      const prev = await fsp.readFile(p, 'utf8');
      if (prev !== content) { await fsp.writeFile(p, content, 'utf8'); updated++; }
    } catch {
      await fsp.writeFile(p, content, 'utf8');
      added++;
    }
  }
  // 清理：目录里属于我们命名空间的文件，不在 wanted 里就删（条目被删/清空了 body）
  let removed = 0;
  for (const f of await fsp.readdir(kbDir)) {
    if (!f.endsWith('.md')) continue; // .zvec-grep 索引等其他文件不动
    if (!/^[dD]_[0-9a-z]+-/.test(f)) continue; // 不是 doc 导出的文件不碰
    if (!wanted.has(f)) {
      await fsp.rm(join(kbDir, f), { force: true });
      removed++;
    }
  }
  return { added, updated, removed, total: wanted.size };
}

// 共享知识库目录：<docRoot>/shared/（固定名，不按项目序列化）。
export function sharedKbFor(docRootSetting) {
  return join(docRootFor(docRootSetting), 'shared');
}

// 读取 docRoot（面板/CLI 查看当前全局配置值）
export async function getDocRoot() {
  const { getCurrentScope } = await import('../../core/store.js');
  const { store } = await getCurrentScope();
  return { docRoot: docRootFor(store.settings?.docRoot), isDefault: !store.settings?.docRoot };
}

// 设置 docRoot：写 settings + 迁移（全量复制旧 KB、清理旧根痕迹）。
// 顺序刻意为先写 settings 再迁移：迁移的 from 用「刚写入的新值之外」的旧值——
// 显式传入，避免迁移函数回读时序问题；oldRoot 未知时传 undefined 让迁移走默认，
// 但那时迁移只做 mkdir + 复制（from 不存在则 no-op），不会误伤真实默认根之外的东西。
export async function setDocRoot(newRoot) {
  if (!newRoot || typeof newRoot !== 'string') throw (await import('../../core/errors.js')).invalidInput('缺少 newRoot');
  const { mutateStore, getCurrentScope } = await import('../../core/store.js');
  const { store } = await getCurrentScope();
  const oldRoot = store.settings?.docRoot;
  const { migrateDocRoot } = await import('./zg.js');
  const migration = await migrateDocRoot({ newRoot, oldRoot });
  await mutateStore((s) => { s.settings.docRoot = newRoot; return s.settings.docRoot; });
  return { docRoot: docRootFor(newRoot), migration };
}

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
  };
}

function currentScope(store) {
  const k = cwdScope();
  if (!store.scopes[k]) store.scopes[k] = { links: [], docs: [], workflows: {} };
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
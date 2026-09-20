// link 资源业务：外部链接 / OpenAPI 入口 / 工具入口的登记与查询。
//
// 一个 link = { id, name, url, kind, tags, note }
// 五条 CRUD：list / get / add / update / remove。
//
// 故意只存「元信息」，不存抓取内容。link 的作用是「给 agent 当锚点」——
// agent 拿到 url 自己去看，不把内容灌进 store.json（store 会爆炸）。
import { mutateStore } from '../../core/store.js';
import { assertSafeName, cwdScope } from '../../core/paths.js';
import { notFound, conflict, invalidInput } from '../../core/errors.js';

const KINDS = new Set(['url', 'openapi', 'cli', 'doc', 'tool', 'other']);

function makeId() {
  return 'l_' + Math.random().toString(36).slice(2, 10);
}

function normalize(input) {
  const out = { ...input };
  if (!out.name || typeof out.name !== 'string') throw invalidInput('链接必须有名');
  if (!out.url || typeof out.url !== 'string') throw invalidInput('链接必须有 url');
  out.kind = KINDS.has(out.kind) ? out.kind : 'url';
  out.tags = Array.isArray(out.tags) ? out.tags.map(String) : [];
  out.note = typeof out.note === 'string' ? out.note : '';
  return out;
}

// 从 mutable store（mutateStore 的深拷贝回调内）拿当前 cwd scope。
// scope 在 normalize 时已被 getCurrentScope 路径建立过，这里直接拿。
function currentScope(store) {
  const k = cwdScope();
  if (!store.scopes[k]) store.scopes[k] = { links: [], docs: [], workflows: {} };
  return store.scopes[k];
}

export async function listLinks() {
  const { scope } = await (await import('../../core/store.js')).getCurrentScope();
  return scope.links;
}

export async function getLink(id) {
  assertSafeName(id, '链接 id');
  const { scope } = await (await import('../../core/store.js')).getCurrentScope();
  const hit = scope.links.find((l) => l.id === id);
  if (!hit) throw notFound(`链接不存在: ${id}`);
  return hit;
}

export async function addLink(input) {
  const def = normalize(input);
  return mutateStore((store) => {
    const scope = currentScope(store);
    if (scope.links.some((l) => l.url === def.url)) {
      throw conflict(`链接已登记（同一 cwd scope 内 url 唯一）: ${def.url}`);
    }
    const link = { id: makeId(), ...def, createdAt: new Date().toISOString() };
    scope.links.push(link);
    return link;
  });
}

export async function updateLink(id, patch) {
  assertSafeName(id, '链接 id');
  return mutateStore((store) => {
    const scope = currentScope(store);
    const idx = scope.links.findIndex((l) => l.id === id);
    if (idx < 0) throw notFound(`链接不存在: ${id}`);
    const next = normalize({ ...scope.links[idx], ...patch, id: scope.links[idx].id });
    scope.links[idx] = { ...scope.links[idx], ...next };
    return scope.links[idx];
  });
}

export async function removeLink(id) {
  assertSafeName(id, '链接 id');
  return mutateStore((store) => {
    const scope = currentScope(store);
    const idx = scope.links.findIndex((l) => l.id === id);
    if (idx < 0) throw notFound(`链接不存在: ${id}`);
    const [removed] = scope.links.splice(idx, 1);
    return removed;
  });
}
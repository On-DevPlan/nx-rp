// HTTP 路由表：由 action.http 编译而来，与 CLI 同源。
//
// 这里没有手写路由 —— 每条路由都来自某个模块的 action 声明，
// 所以「面板上有按钮、CLI 里没命令」在结构上不可能发生。
import { ACTIONS } from './registry.js';
import { compileRoute, applySpec } from './spec.js';
import { toErrorPayload, httpStatusOf } from '../core/errors.js';
import { scopeStorage } from '../core/als.js';

// 逐段比较两条模式，决定谁该先匹配：**字面量段优先于参数段**，段数多的优先。
//
// 为什么要排序而不是按声明顺序：`GET /api/workflows/foo` 与 `GET /api/workflows/:name`
// 都能匹配前者，谁先声明谁赢。一旦有人调整 actions 顺序，字面量那条就会被参数那条
// 抢走——这种 bug 只在运行时、且只在特定路径上出现，极难排查。
function routeSpecificity([, pattern]) {
  return pattern.split('/').filter(Boolean);
}

function compareRoutes(a, b) {
  const pa = routeSpecificity(a.action.http);
  const pb = routeSpecificity(b.action.http);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const litA = !pa[i].startsWith(':');
    const litB = !pb[i].startsWith(':');
    if (litA !== litB) return litA ? -1 : 1;
  }
  return pb.length - pa.length;
}

// 一个 action 可以声明多条 HTTP 路由。两种形态都支持：
//   http: ['GET', '/path']                              单条
//   http: ['GET', '/path', 'POST', '/path']             平铺多条（数组下标 0/2 是 method，1/3 是 path）
//   http: [['GET','/path'], ['POST','/path']]           二元组数组
// 全部拍平成单个路由条目，path 与 method 各算一次。
const ROUTES = ACTIONS.filter((a) => a.http)
  .flatMap((action) => {
    const http = action.http;
    let list;
    if (Array.isArray(http[0])) list = http;                              // 二元组数组
    else if (typeof http[0] === 'string' && http.length >= 4) list = [[http[0], http[1]], [http[2], http[3]]]; // 平铺
    else list = [http];                                                  // 单条
    return list.map((h) => ({ action, route: compileRoute({ http: h }) }));
  })
  .sort(compareRoutes);

export function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// 跨站防护。服务虽然只绑 127.0.0.1，但用户浏览器里的任意页面都能向它发起请求——
// 少了这道校验，一个恶意网页就能 POST /api/xxx 把本机数据抹掉。
// 浏览器发跨域请求必带 Origin，非浏览器客户端（curl / agent / 测试）不带，故放行。
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

// 流式响应：run 返回 { status, headers, stream }，直接把字节管道出去。
// 与 JSON 分支分开是因为它**不能**被 JSON.stringify 包一层。
async function pipeResponse(res, action, ctx) {
  const r = await action.run(ctx, { transport: 'http' });
  if (!r || !r.stream) throw new Error(`${action.id} 声明了 streamResponse，但 run 没返回 stream`);
  res.writeHead(r.status || 200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    ...(r.headers || {}),
  });
  r.stream.on('error', () => res.destroy());
  r.stream.pipe(res);
}

// 面板 scope 切换的入口：前端激活了某个最近目录时，所有请求带 x-nx-rp-scope 头
// （值为该目录的**原始大小写**路径）。这里把整个路由分发包进 AsyncLocalStorage，
// 让请求 async 链上的 cwdScope()/cwdDir() 都落到激活目录——业务代码零改动。
// 头的值只影响「读写哪个 scope 桶」，归一化在 cwdScope() 内部完成；伪造的头最坏
// 产生一个空桶，写操作另有 originAllowed 跨站防护。
export async function handleApi(req, res, url) {
  const scopeHeader = req.headers['x-nx-rp-scope'];
  if (typeof scopeHeader === 'string' && scopeHeader.trim()) {
    return scopeStorage.run({ scope: scopeHeader.trim(), dir: scopeHeader.trim() }, () => dispatch(req, res, url));
  }
  return dispatch(req, res, url);
}

async function dispatch(req, res, url) {
  const method = (req.method || 'GET').toUpperCase();

  for (const { action, route } of ROUTES) {
    if (route.method !== method) continue;
    const m = route.regex.exec(url.pathname);
    if (!m) continue;

    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（面板仅接受本机来源）', code: 'BLOCKED' });
      return;
    }

    try {
      const raw = {};
      route.keys.forEach((k, i) => {
        raw[k] = decodeURIComponent(m[i + 1]);
      });

      if (method === 'GET' || method === 'HEAD') {
        for (const [k, v] of url.searchParams) raw[k] = v;
      } else if (action.streamBody) {
        for (const [k, v] of url.searchParams) raw[k] = v;
        raw.body = req;
        raw.headers = req.headers || {};
      } else {
        Object.assign(raw, await readBody(req).catch(() => ({})));
      }

      const ctx = applySpec(action, raw);

      if (action.streamResponse) {
        await pipeResponse(res, action, ctx);
        return;
      }

      const data = await action.run(ctx, { transport: 'http' });
      sendJson(res, 200, { ok: true, data });
    } catch (err) {
      const p = toErrorPayload(err);
      const payload = { ok: false, error: p.message, code: p.code };
      if (p.details !== undefined) payload.details = p.details;
      sendJson(res, httpStatusOf(p.code), payload);
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: '接口不存在: ' + method + ' ' + url.pathname });
}
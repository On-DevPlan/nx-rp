// node:http：静态 + /api 委派。
//
// server.js 对构建工具零感知——它只服务 public/ 目录，不管是 dev 还是 prod。
// 这条让"发布产物"和"本地开发"共用同一个入口，不会出现"dev 能跑、打包后白屏"。
import http from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, '..', 'web', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
};

function serveStatic(urlPath, res) {
  // 去掉 query；SPA 走 history fallback，全部交给 index.html
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // 解析后做前缀校验，避免 ?file=../etc/passwd 绕过
  const file = resolve(PUBLIC_DIR, '.' + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback
    const idx = join(PUBLIC_DIR, 'index.html');
    if (existsSync(idx)) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      createReadStream(idx).pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

export async function startServer({ port, host = '127.0.0.1' } = {}) {
  const { handleApi } = await import('./api.js');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(url.pathname, res);
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, () => ok(server));
  });
}
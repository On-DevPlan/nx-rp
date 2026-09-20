// Vite 配置：dev 模式起 :5180 端口，把 /api 代理到后端 :7820。
//
// 「代理前缀与前端源码目录同名」的坑：前端代码顶层有 api/ 目录，浏览器拿到
// /api/client.js 时代理会把它误当成后端请求转发走。靠 shouldServeLocally
// 判断「是不是前端资源」，是前端资源就直接交回 Vite。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const FRONTEND_ASSET = /\.(jsx?|mjs|cjs|tsx?|css|map|svg|png|jpe?g|webp|ico|woff2?)$/i;

export function shouldServeLocally(url) {
  const path = String(url || '').split('?')[0];
  return FRONTEND_ASSET.test(path) ? path : undefined;
}

export default defineConfig({
  root: 'src/web/frontend',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7820',
        bypass: (req) => shouldServeLocally(req.url),
      },
    },
  },
});
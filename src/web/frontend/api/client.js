const DEFAULT_TIMEOUT_MS = 30000;

// 面板当前激活的 scope（最近目录快速切换）。null = 跟随服务进程目录。
// 模块级变量而不是 React state：api() 是纯 fetch 封装，不该依赖组件树；
// store.jsx 在切换时调用 setActiveScope，此后所有请求自动带上头。
let activeScopePath = null;

export function setActiveScope(path) {
  activeScopePath = path || null;
}

export function getActiveScope() {
  return activeScopePath;
}

export async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const headers = opts.body ? { 'content-type': 'application/json' } : undefined;
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: activeScopePath
        ? { ...headers, 'x-nx-rp-scope': activeScopePath }  // 原始大小写路径，服务端内部归一化
        : headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => { throw new Error(`HTTP ${res.status}`); });
    if (!json.ok) {
      const err = new Error(json.error || '请求失败');
      err.code = json.code;
      throw err;
    }
    return json.data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（本地服务无响应）');
    throw e;
  } finally { clearTimeout(timer); }
}
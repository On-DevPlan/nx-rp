const DEFAULT_TIMEOUT_MS = 30000;

export async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
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
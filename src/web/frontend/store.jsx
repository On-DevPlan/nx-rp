import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setActiveScope } from './api/client.js';

const LS_KEY = 'nx-rp-ui';
// activeScope: null = 跟随服务进程目录；否则为 recents 条目 { scope, path, lastUsedAt }。
// 持久化到 localStorage：刷新/重开面板后仍停留在上次激活的项目上。
const DEFAULT_UI = { view: '', activeScope: null };

function loadUi() {
  try {
    return { ...DEFAULT_UI, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_UI };
  }
}

const StoreCtx = createContext(null);

export function StoreProvider({ children }) {
  const [boot, setBoot] = useState(null);
  const [ui, setUi] = useState(loadUi);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(ui)); } catch { /* 隐私模式静默降级 */ }
  }, [ui]);

  const refreshBoot = useCallback(async () => {
    const b = await api('/api/bootstrap');
    setBoot(b);
    return b;
  }, []);

  useEffect(() => { refreshBoot().catch(() => {}); }, [refreshBoot]);

  // 启动时把持久化的激活 scope 恢复到 fetch 层（api() 读的是模块级变量）。
  useEffect(() => { setActiveScope(ui.activeScope?.path || null); }, [ui.activeScope]);

  const patchUi = useCallback((patch) => {
    setUi((u) => (typeof patch === 'function' ? { ...u, ...patch(u) } : { ...u, ...patch }));
  }, []);

  // 切换激活 scope：写 fetch 层 → touch recents（服务端置顶 + 记录）→ 重拉 bootstrap。
  // scopeTick 自增让视图重挂载重新拉数据（视图的 useEffect 只在挂载时请求）。
  const [scopeTick, setScopeTick] = useState(0);
  const switchScope = useCallback(async (entry) => {
    const next = entry || null;
    setActiveScope(next ? next.path : null);
    patchUi({ activeScope: next });
    if (next) await api('/api/recents', { method: 'POST', body: { path: next.path } }).catch(() => {});
    await refreshBoot().catch(() => {});
    setScopeTick((t) => t + 1);
  }, [patchUi, refreshBoot]);

  const value = useMemo(
    () => ({ boot, ui, patchUi, refreshBoot, switchScope, scopeTick }),
    [boot, ui, patchUi, refreshBoot, switchScope, scopeTick]
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
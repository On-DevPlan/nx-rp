import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api/client.js';

const LS_KEY = 'nx-rp-ui';
const DEFAULT_UI = { view: '' };

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

  const patchUi = useCallback((patch) => {
    setUi((u) => (typeof patch === 'function' ? { ...u, ...patch(u) } : { ...u, ...patch }));
  }, []);

  const value = useMemo(
    () => ({ boot, ui, patchUi, refreshBoot }),
    [boot, ui, patchUi, refreshBoot]
  );
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
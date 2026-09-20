import { Component, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [msgs, setMsgs] = useState([]);
  const idRef = useRef(0);
  const toast = useCallback((msg) => {
    const id = ++idRef.current;
    setMsgs((m) => [...m, { id, msg }]);
    setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-stack">
        {msgs.map((m) => <div key={m.id} className="toast show">{m.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx) || ((m) => console.log(m));
}

export function useGuard() {
  const toast = useToast();
  return useCallback(async (fn) => {
    try { return await fn(); } catch (e) { toast(String((e && e.message) || e)); }
  }, [toast]);
}

// ---- 点击即复制 ----
export function Copyable({ text, className = '', title, children }) {
  const toast = useToast();
  const copy = async () => {
    const v = String(text ?? '');
    try {
      await navigator.clipboard.writeText(v);
      toast('已复制: ' + (v.length > 60 ? v.slice(0, 57) + '...' : v));
    } catch {
      toast('复制失败（剪贴板不可用）');
    }
  };
  return (
    <span className={'copyable' + (className ? ' ' + className : '')} title={title || '点击复制'} onClick={copy}>
      {children !== undefined ? children : text}
    </span>
  );
}

// ---- 对话框 ----
export function useDialog() {
  const [state, setState] = useState(null);
  const inputRef = useRef(null);
  const close = useCallback((val) => {
    setState((s) => { if (s && s.resolve) s.resolve(val); return null; });
  }, []);
  const dialog = useCallback((opts = {}) => new Promise((resolve) => {
    setState({ ...opts, resolve });
  }), []);
  const node = state ? (
    <div className="dlg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div className="dlg-box">
        {state.title ? <div className="dlg-title">{state.title}</div> : null}
        {state.message ? <div className="dlg-msg">{state.message}</div> : null}
        {state.input ? (
          <input
            ref={inputRef} className="dlg-input" autoFocus spellCheck="false"
            placeholder={state.placeholder || ''} defaultValue={state.value || ''}
            onKeyDown={(e) => {
              if (e.key === 'Enter') close(e.currentTarget.value.trim());
              if (e.key === 'Escape') close(null);
            }}
          />
        ) : null}
        <div className="dlg-acts">
          <button className="btn ghost" onClick={() => close(null)}>取消</button>
          <button className={'btn' + (state.danger ? ' danger' : '')}
            onClick={() => close(state.input ? (inputRef.current?.value.trim() ?? null) : true)}>
            {state.okText || '确定'}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return { dialog, node };
}

// ---- 错误边界 ----
export class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[nx-rp] 视图渲染失败:', error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ padding: 16 }}>
        <div className="colhead"><h3>这个面板出错了</h3></div>
        <div className="dlg-msg">{String(this.state.error?.message || this.state.error)}</div>
        <button className="btn" onClick={() => this.setState({ error: null })}>重试</button>
      </div>
    );
  }
}

// ---- 弹窗 ----
export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-title">
          <span>{title}</span>
          <button className="btn small ghost" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
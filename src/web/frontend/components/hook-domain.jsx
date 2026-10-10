// hook 域共用层：提示词日志 / Skill 追踪 / 循环三个 hook 类模块视图的公共头部。
//
// 三个视图曾经各自复制同一套东西：顶部 toolbar（scope + 一句话说明）、加载失败卡、
// 「Hook 状态」卡（状态/配置文件行 + disableAllHooks / corrupt 警告段——corrupt 段
// 曾三处逐字相同）、启停按钮与确认弹窗。现在全部收进这一个 hook：数据与动作在
// hook 里，节点（toolbar / errorCard / statusCard）由 hook 生成、视图按自己的卡片
// 顺序摆放——与 useDialog 返回 node 的惯例一致。
//
// 差异点走 cfg 注入：静态文案直接传字符串（视图渲染期算好，hook 每次渲染都会用
// 最新 cfg 重建节点）；依赖 status 的差异走 (status) => … 回调（status 就绪后才会
// 被调用，回调里可放心取字段）。afterRefresh 在 refresh 的 try 内执行——视图自己的
// 数据（记录表/统计表/审计日志）跟着状态一起拉，失败落进同一张错误卡，重试一次
// 救全部。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useDialog, useGuard, useToast } from './ui.jsx';
import { useStore } from '../store.jsx';

export function useHookDomain(cfg) {
  const { boot } = useStore();
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const guard = useGuard();
  const toast = useToast();
  const { dialog, node: dialogNode } = useDialog();

  // cfg 存 ref、每渲染刷新：视图常在渲染期造出新闭包传进来（hook-prompt 的 note
  // 随目录锁定变化、afterRefresh 随 scope 变），若进 useCallback 依赖，每次渲染
  // 都会造出新的 refresh → 挂载 effect 重跑 → 请求循环。refresh 必须引用稳定。
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const st = await api(cfgRef.current.statusUrl);
      setStatus(st);
      await cfgRef.current.afterRefresh?.(st);
      return st;
    } catch (e) {
      // 失败要如实呈现——不能让「请求失败」伪装成「未启用」
      setLoadError(e.message || '加载失败');
      return null;
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const enable = useCallback(() => guard(async () => {
    const c = cfgRef.current;
    // onBody 可以是对象（恒定入参）或函数（点击时才求值——loop 的「作用域」
    // 是视图里的选择，必须读点击那一刻的值，而不是建 cfg 时的旧值）。
    const body = typeof c.onBody === 'function' ? c.onBody() : (c.onBody || {});
    const r = await api(c.onUrl, { method: 'POST', body });
    toast(c.onEnabled ? c.onEnabled(r) : '已启用');
    await refresh();
  }), [guard, toast, refresh]);

  const disable = useCallback(() => guard(async () => {
    const ok = await dialog({ danger: true, okText: '停用', ...cfgRef.current.offDialog });
    if (!ok) return;
    await api(cfgRef.current.offUrl, { method: 'POST', body: {} });
    toast('已停用');
    await refresh();
  }), [guard, toast, dialog, refresh]);

  // ─── 头部三件套（视图按自己的卡片顺序摆放） ────────────────────────

  // showScope=false：无目录维度的模块（hook-skill 全局统计）不显示 scope。
  const toolbar = (
    <div className="toolbar" style={{ marginBottom: 12 }}>
      {cfg.showScope !== false && (
        <span className="muted">scope: <code>{boot?.cwdScope || ''}</code></span>
      )}
      {cfg.note ? (
        <span className="muted" style={cfg.showScope !== false ? { marginLeft: 'auto' } : undefined}>{cfg.note}</span>
      ) : null}
    </div>
  );

  const errorCard = !loadError ? null : (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="tag bad">加载失败</span>
        <span className="muted">{loadError}</span>
        <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={refresh}>重试</button>
      </div>
    </div>
  );

  const statusCard = (
    <div className="card">
      <div className="colhead">
        <span>Hook 状态</span>
        <span className="muted">
          {!status ? (loadError ? '—' : '加载中…')
            : (cfg.summary ? cfg.summary(status)
              : (status.corrupt ? '配置文件异常' : (status.enabled ? '已启用' : '未启用')))}
        </span>
      </div>
      <div className="toolbar" style={{ padding: '8px 12px' }}>
        <button className="btn small" onClick={enable} disabled={!status || status.enabled || status.corrupt}>启用</button>
        <button className="btn small ghost" onClick={disable} disabled={!status || !status.enabled || status.corrupt}>停用</button>
        {/* 槽位拿到 refresh 与 status：视图自己决定多放什么（loop 的作用域选择器
            要按 status.enabled 决定禁用与否——它不能引用外层的 status 变量，
            那会撞上 TDZ：cfg 在 dom 赋值之前就求值了） */}
        {cfg.toolbarExtra ? cfg.toolbarExtra({ refresh, status }) : null}
        {cfg.toolbarNote ? <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>{cfg.toolbarNote}</span> : null}
      </div>
      {!status ? (
        <div className="empty">{loadError ? '无法读取 hook 状态' : '加载中…'}</div>
      ) : (
        <div style={{ padding: '10px 12px' }}>
          <dl className="kv">
            <div className="kv-row">
              <dt>状态</dt>
              <dd>
                <span className={'tag' + (status.enabled ? ' strong' : '')}>{status.enabled ? '已启用' : '未启用'}</span>
                {cfg.statusNote ? <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>{cfg.statusNote(status)}</span> : null}
                {status.disableAllHooks ? <span className="tag bad" style={{ marginLeft: 6 }}>disableAllHooks</span> : null}
                {status.corrupt ? <span className="tag bad" style={{ marginLeft: 6 }}>settings.json 损坏</span> : null}
              </dd>
            </div>
            <div className="kv-row">
              <dt>配置文件</dt>
              <dd className="mono nowrap" title={status.settingsPath}>{status.settingsPath}</dd>
            </div>
            {/* extraRows：[标签, 节点, title?]——各模块自己的目录行 / 作用域行 */}
            {(cfg.extraRows?.(status) || []).map(([dt, node, title]) => (
              <div className="kv-row" key={String(dt)}>
                <dt>{dt}</dt>
                <dd className="mono nowrap" title={title || undefined}>{node}</dd>
              </div>
            ))}
          </dl>
          {/* 警告段：模块特有的在前，两条公共的（disableAllHooks / corrupt）只写这一份 */}
          {(cfg.extraWarnings?.(status) || []).concat(sharedWarnings(status)).map((w, i) => (
            <p className="muted" style={{ marginTop: 8 }} key={i}>{w}</p>
          ))}
        </div>
      )}
    </div>
  );

  return { status, loadError, refresh, enable, disable, dialog, dialogNode, toolbar, errorCard, statusCard };
}

// 两条公共警告——原三视图各写一份（corrupt 段逐字相同），收进这里时一并瘦身。
function sharedWarnings(status) {
  const out = [];
  if (status.disableAllHooks) {
    out.push(<>全局 <code>disableAllHooks: true</code> 已关掉所有 hooks——上面的状态不生效。</>);
  }
  if (status.corrupt) {
    out.push(<>settings.json 无法解析——先修复再启停（防覆盖你的配置）。</>);
  }
  return out;
}

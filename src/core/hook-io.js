// hook 协议 IO 共享层（hook 域共用，从 teamai-cli 借鉴的容错技巧在此落地）。
//
// 三件事：
//   1. readStdin —— 读 STDIN 但与 EOF 竞速：宿主写了 payload 不关管道时
//      （teamai-cli 实测 CodeBuddy 会这样），不能挂到宿主超时才罢手；
//      deadline 到点就用已收到的内容继续（健康宿主毫秒级 EOF，竞速不触发）。
//   2. parseHookEvent —— 解析事件 JSON；坏 JSON 降级抢救结构字段
//      （session_id / cwd），不整体放弃。hook payload 可能是半截写入，
//      抢救回来的字段够日志类 hook 记账用。
//   3. deriveSessionId —— 会话 ID 派生统一顺序：
//      payload.session_id → payload.sessionId → CLAUDE_SESSION_ID env → pid+cwd 兜底。
//      两条 hook 共用，跨事件才能对上同一个会话。

const STDIN_DEADLINE_MS = 1000; // teamai-cli 同款 1s deadline（其 STDIN_READ_TIMEOUT_MS）

export function readStdin(deadlineMs = STDIN_DEADLINE_MS) {
  return new Promise((resolvePromise) => {
    if (process.stdin.isTTY) return resolvePromise('');
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => finish(chunks.join('')));
    process.stdin.on('error', () => finish(chunks.join(''))); // 管道异常：用已收内容，不挂
    // EOF 竞速：到点就用已收内容继续。unref 防止 timer 自身吊住事件循环。
    setTimeout(() => finish(chunks.join('')), deadlineMs).unref();
  });
}

// 从半截/坏 JSON 里抢救结构字段。只取已知键、只收字符串，
// 绝不 eval / 正则盲提——抢救的输出进日志，必须可靠。
export function salvageFields(raw) {
  const salvaged = {};
  if (typeof raw !== 'string' || !raw.trim()) return salvaged;
  for (const key of ['session_id', 'sessionId', 'cwd']) {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (m) {
      try {
        salvaged[key] = JSON.parse(`"${m[1]}"`);
      } catch { /* 抢救失败就当没有 */ }
    }
  }
  return salvaged;
}

export function parseHookEvent(raw) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    event = salvageFields(raw); // 坏 JSON：降级为字段抢救
  }
  // JSON.parse 对 null/数字/字符串/数组也会成功——非纯对象一律降级 {},
  // 否则下游 event.session_id 访问在 ESM 严格模式直接 TypeError。
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    event = salvageFields(raw);
  }
  return event;
}

export function deriveSessionId(event, cwd = process.cwd()) {
  if (typeof event?.session_id === 'string' && event.session_id) return event.session_id;
  if (typeof event?.sessionId === 'string' && event.sessionId) return event.sessionId;
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return `pid-${process.ppid ?? process.pid}-${cwd}`;
}

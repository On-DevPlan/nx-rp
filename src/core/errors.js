// 错误契约：AppError + code → HTTP 状态 / 退出码 的**唯一**映射。
//
// 这层是所有失败信息的「单一口径」：CLI 与 HTTP 都从这里拿 code↔status↔exit。
// 上层不允许自己对错误文本做 substring 匹配——必须用 err.code / err 分流。

export const CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',  // 400 / 参数非法
  NOT_FOUND: 'NOT_FOUND',          // 404 / 目标不存在
  CONFLICT: 'CONFLICT',            // 409 / 业务冲突，待用户决策
  BLOCKED: 'BLOCKED',              // 409 / 被前置规则挡住
  EXTERNAL: 'EXTERNAL',            // 502 / 外部命令失败
  INTERNAL: 'INTERNAL',            // 500 / 兜底
});

// HTTP 状态由错误码唯一确定。CONFLICT 与 BLOCKED 都 409 但语义不同（用户决策 vs 前置未达），
// 见 [[00-design-and-verify]] 第八节区分。
const HTTP_STATUS = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  BLOCKED: 409,
  EXTERNAL: 502,
  INTERNAL: 500,
};

// CLI 退出码统一为 1（agent 只区分 0 / 1）。业务结果（含冲突）也是 0，由 status 字段传达。
export function httpStatusOf(code) {
  return HTTP_STATUS[code] || HTTP_STATUS.INTERNAL;
}

// ---- AppError ----

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---- 构造快捷器 ----

export const invalidInput = (msg, details) => new AppError(CODES.INVALID_INPUT, msg, details);
export const notFound = (msg, details) => new AppError(CODES.NOT_FOUND, msg, details);
export const conflict = (msg, details) => new AppError(CODES.CONFLICT, msg, details);
export const blocked = (msg, details) => new AppError(CODES.BLOCKED, msg, details);
export const external = (msg, details) => new AppError(CODES.EXTERNAL, msg, details);

// 普通 Error → INTERNAL，但**不**把堆栈暴露给调用方（agent 不该看到）。
export function toErrorPayload(err) {
  if (err && err.code && HTTP_STATUS[err.code]) {
    const payload = { message: String(err.message || err), code: err.code };
    if (err.details !== undefined) payload.details = err.details;
    return payload;
  }
  return { message: err && err.message ? String(err.message) : 'INTERNAL', code: CODES.INTERNAL };
}
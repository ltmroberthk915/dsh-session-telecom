// 契约要求：任何 endpoint 的异常都必须被吞成 {ok:false,error:{code,message,details}}，
// 绝不让路由吐 500（500 会被浏览器控制台当网络错误刷屏，客户端也拿不到 code）。
//
// 所以错误在 host 内部统一用 ToolkitError 表达，由 index.js 的 dispatch 一层兜住。

import { SESSION_TELECOM_ERROR_CODES as CODES } from './api.js';

/** 带稳定 code 的 host 侧错误。 */
export class ToolkitError extends Error {
  /**
   * @param {string} code - SESSION_TELECOM_ERROR_CODES 里的值。
   * @param {string} message - 给人看的说明。
   * @param {object} [details] - 机器可读细节（sessionId 等），必须可 JSON 序列化。
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ToolkitError';
    this.code = code;
    this.details = details ?? {};
  }
}

/** bad-request 快捷构造。 */
export function badRequest(message, details) {
  return new ToolkitError(CODES.badRequest, message, details);
}

/** session/not-found 快捷构造。 */
export function sessionNotFound(sessionId) {
  return new ToolkitError(CODES.sessionNotFound, `session "${sessionId}" not found`, { sessionId });
}

/**
 * session/agent-busy：目标会话的身份归 subagent 路由所有。
 * 文案与 details 逐字对齐内核：api-session-controller/lib/types/agent.js:120-122。
 */
export function agentBusy(sessionId) {
  return new ToolkitError(
    CODES.agentBusy,
    `session "${sessionId}" is owned by subagent routing`,
    { sessionId, reason: 'use subagent delivery for this child session' },
  );
}

/** session/writer-held：同一个 session 已有活跃写句柄（内核语义见 types/agent.js:242-244）。 */
export function writerHeld(sessionId, message) {
  return new ToolkitError(
    CODES.writerHeld,
    typeof message === 'string' && message.length > 0 ? message : `session "${sessionId}" is held by another writer`,
    { sessionId },
  );
}

/** 取消：AbortSignal 抛出的 DOMException/自定义 reason 统一收敛到这个码。 */
export function cancelled(message) {
  return new ToolkitError(CODES.cancelled, typeof message === 'string' && message.length > 0 ? message : 'request was cancelled', {});
}

/** 把任意抛出物规整成 wire 上的 error 块。永不抛。 */
export function toWireError(error) {
  if (error instanceof ToolkitError) {
    return { code: error.code, message: error.message, details: safeDetails(error.details) };
  }
  if (error instanceof Error) {
    // AbortSignal 的 reason 是 DOMException('AbortError')：客户端要能认出"是取消，不是故障"。
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return { code: CODES.cancelled, message: error.message, details: safeDetails({ name: error.name }) };
    }
    // 上游内核错误带 code（RemoteError.code / SessionQueryError.code）：透传，客户端才能分支。
    const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : CODES.internal;
    // RemoteError 的 details 是声明过的结构化载荷（如 agent-busy 的 reason），能过 JSON 就带上。
    const details = safeDetails(error.details);
    return {
      code,
      message: error.message,
      details: Object.keys(details).length > 0 ? details : safeDetails({ name: error.name }),
    };
  }
  return { code: CODES.internal, message: String(error), details: {} };
}

/** 剥掉不可 JSON 序列化的细节，避免 stringify 时炸掉整条响应。 */
function safeDetails(details) {
  try {
    const round = JSON.parse(JSON.stringify(details ?? {}));
    return round !== null && typeof round === 'object' && !Array.isArray(round) ? round : {};
  } catch {
    return {};
  }
}

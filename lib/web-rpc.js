// RPC 传输层：把 ${channel} 挂到 webServer 上，或在无 webServer 时回退 connection.rpc.handle。
// 信封格式逐字段照抄 dsh-session-lock/lib/web-rpc.js（它是 dsh-client-connection 的
// /api 传输语义的复刻，浏览器端 ctx.connection.rpc.call 直接就能用）。
//
// 与 session-lock 版本的**唯一实质差异**：
//   session-lock 的 handler 抛错时返回 HTTP 500；契约要求本插件「任何 endpoint 的异常都
//   吞成 {ok:false,error}，绝不让路由返回 500」。所以这里 catch 后返回
//   **200 + server-response{result:{ok:false,error}}**，客户端永远拿到结构化错误。

import { SESSION_TELECOM_BODY_MAX, SESSION_TELECOM_RPC_CHANNEL } from './api.js';

/** endpoint 段字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** client-request 信封校验失败时的兜底 rpcId（与 dsh 内部 INVALID_REQUEST_RPC_ID 对齐）。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/** 从 `${channel}/<endpoint>` 路径里取出 endpoint，段非法时返回 undefined。 */
export function endpointFromPath(channel, pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_PATTERN.test(seg))) {
    return undefined;
  }
  return endpoint;
}

/** 构造 server-response JSON 串（与 dsh-client-connection 的 fullResponse 字段对齐）。 */
export function serverResponseJson(rpcId, result) {
  return JSON.stringify({ type: 'server-response', rpcId, result });
}

/** 400 也要走 server-response 信封（客户端按 rpcId 匹配，不能收到裸文本）。 */
function badRequest(rpcId, message) {
  return new Response(serverResponseJson(rpcId, {
    ok: false,
    error: { code: 'bad-request', message, details: { issues: [] } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * 旧版 dsh / 无 connection.requestRejection 时的最小信任栅栏：仅放行 loopback Host，
 * 拒 cross-site fetch 与 Origin 不匹配。
 */
export function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host;
  if (!host) return false;
  const hostName = host.split(':')[0];
  if (!LOOPBACK_HOSTNAMES.has(hostName)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 把 RPC handler 包装成 fetch-shaped handler。
 *
 * handler 的返回值就是 server-response 里的 `result`：
 *   - { ok: true, value } / { ok: false, error }（推荐，handler 自己吞异常）
 *   - 或者任何值 → 自动包成 { ok: true, value }（宽容处理，避免客户端拿不到东西）
 * handler 抛错 → 200 + { ok:false, error:{code,message,details} }（**不是 500**）。
 *
 * @param {string} channel - 通道前缀。
 * @param {(endpoint: string, payload: any, signal: AbortSignal) => Promise<any>} handler
 * @param {{error?: Function, warn?: Function}} [log]
 * @param {(error: unknown) => {code: string, message: string, details: object}} [toError]
 */
export function sessionTelecomFetchHandler(channel, handler, log, toError) {
  const normalize = typeof toError === 'function'
    ? toError
    : (error) => ({ code: 'gateway/internal', message: String(error), details: {} });
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 });
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('body is not JSON', { status: 400 });
      }
      const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID;
      const method = body && typeof body.method === 'string' ? body.method : null;
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return badRequest(INVALID_REQUEST_RPC_ID, 'invalid client-request message');
      }
      if (method !== endpoint) {
        return badRequest(rpcId, `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`);
      }
      try {
        const result = await handler(endpoint, body.payload, request.signal);
        return new Response(serverResponseJson(rpcId, normalizeResult(result)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } catch (error) {
        // 这里是 500 的入口，也是契约明令不许走到的地方。
        log?.error?.('dsh-session-telecom: rpc %s failed: %s', endpoint, error?.message ?? error);
        return new Response(serverResponseJson(rpcId, { ok: false, error: normalize(error) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    },
  };
}

/** handler 返回信封就直接用；返回裸值就包成 ok。 */
function normalizeResult(result) {
  if (result !== null && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  return { ok: true, value: result };
}

/**
 * node:http 请求 → fetch-shaped handler → node:http 响应的桥接。
 * 行为与 dsh-client-connection 的 bridge 一致（413 防无界缓冲、背压 drain、res.close 时 abort）。
 */
export async function sessionTelecomHttpBridge(req, res, fetchHandler, maxBodyBytes = SESSION_TELECOM_BODY_MAX) {
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  const declaredLen = req.headers['content-length'];
  if (declaredLen !== undefined && Number(declaredLen) > maxBodyBytes) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > maxBodyBytes) { tooLarge = true; break; }
    chunks.push(chunk);
  }
  if (tooLarge) {
    res.writeHead(413, { connection: 'close' });
    res.end();
    req.destroy();
    return;
  }

  const url = `http://${req.headers.host ?? '127.0.0.1'}${req.url}`;
  const init = {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === 'string')),
    signal: abort.signal,
  };
  if (chunks.length > 0) init.body = Buffer.concat(chunks);
  const request = new Request(url, init);

  const response = await fetchHandler.fetch(request);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (response.body === null) { res.end(); return; }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done);
        res.once('close', done);
      });
    }
    if (res.writableEnded) break;
  }
  res.end();
}

/**
 * 挂载通道。返回 disposer；返回 null 表示环境无 webServer 服务，调用方应回退
 * ctx.connection.rpc.handle(channel, handler, { authority: 'loopback' })。
 *
 * 认证分支与 dsh-client-connection 的 /api 路由 1:1 对齐：
 *   connection.requestRejection 可用 → 走它（必须以**方法形式**调用，抽成裸函数会丢 this）；
 *   不可用 → isTrustedLoopbackRequest 兜底，仅做 loopback 信任栅栏。
 *
 * @param {object} ctx
 * @param {{channel?: string, handler: Function, log?: object, toError?: Function}} options
 * @returns {(() => void)|null}
 */
export function mountSessionTelecomWebRoute(ctx, { channel = SESSION_TELECOM_RPC_CHANNEL, handler, log, toError } = {}) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') return null;
  const connection = ctx?.connection;
  const fetchHandler = sessionTelecomFetchHandler(channel, handler, log, toError);
  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      let rejection;
      if (typeof connection?.requestRejection === 'function') {
        try {
          rejection = connection.requestRejection.call(connection, req);
        } catch {
          rejection = 403;
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403;
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
        return;
      }
      await sessionTelecomHttpBridge(req, res, fetchHandler);
    },
  };
  const registered = webServer.register(route);
  // register 可能返回 disposer、Promise<disposer> 或 undefined（仅写入路由表）。
  return toDisposer(registered);
}

/** 把 register 的任意返回值规整成幂等 disposer。 */
export function toDisposer(registered) {
  if (typeof registered === 'function') {
    return () => {
      try {
        registered();
      } catch {
        /* 已清理 */
      }
    };
  }
  if (registered && typeof registered.then === 'function') {
    let done = false;
    return async () => {
      if (done) return;
      done = true;
      try {
        const disposer = await registered;
        if (typeof disposer === 'function') disposer();
      } catch {
        /* 已清理 */
      }
    };
  }
  return () => {};
}

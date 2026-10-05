// dsh-session-telecom host 半：会话清单 + 跨会话投递 RPC。
//
// 插件三件套形状（宿主 cordis loader / dsh-client-modules 读的就是这个）：
//   export const name   —— 插件名（= 包名）
//   export const inject —— 必需服务名数组（缺一个就等，不报错）
//   export function apply(ctx)
//
// 只 inject 真正必需的：sessions / agents 是投递与清单的地基，webServer / connection 是
// 路由挂载点（session-lock 的 web-rpc.js:201 说明：新版 dsh 必须自己 inject webServer，
// 否则 ctx.connection.rpc.handle 内部会抛 "cannot get property \"webServer\" without inject"）。
// 其余（sessionController / agentDefaultModel / agentPresets / sessionQuery / sessionPersistence /
// sessionProjections / workspaceRegistry / sessionProjectionCache / logger）全部**可选**，经
// tryGet() 取，缺了就降级 —— 特别是 sessionController：headless/SDK 精简组合里可能没有，
// 而 cordis 对「inject 里声明了但永远不出现的服务」是挂起等待，会让插件根本不挂载。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SESSION_TELECOM_ENDPOINTS,
  SESSION_TELECOM_ERROR_CODES,
  SESSION_TELECOM_NAME,
  SESSION_TELECOM_RPC_CHANNEL,
} from './api.js';
import { toWireError, ToolkitError } from './errors.js';
import { deliverToSession, hasSessionSubagentOwner, normalizeDeliveryStrategy, normalizeSendMode } from './deliver.js';
import {
  buildRelayMessage,
  messageFactorySource,
  relaySourceFor,
  resolveMessageFactory,
  useMessageFactory,
} from './message.js';
import { createSessionRegistry, envSelfSessionId, resolveSelfId, tryGet } from './session-registry.js';
import { createSessionReader } from './session-reader.js';
import { registerSessionTelecomTool } from './tool.js';
import { mountSessionTelecomWebRoute } from './web-rpc.js';

export const name = SESSION_TELECOM_NAME;

/**
 * 必需服务。webServer / connection 在 headless 部署里可能缺失，
 * cordis 对「inject 里的服务一直不出现」的行为是**挂起等待**（不崩），
 * 所以放这里是安全的；真缺 webServer 时 apply 内部会回退 connection.rpc.handle。
 */
export const inject = ['sessions', 'agents', 'webServer', 'connection'];

/** package.json 版本（自报家门用；exports 里没开 ./package.json，所以直接读文件）。 */
export const pluginVersion = readOwnVersion();

// 模块加载即探测内核 createUserMessage（安装到 profile 后能解析到 @deepseek-ai/dsh-llm，
// workspace 源码里解析不到 → 用等价兜底）。这样第一次 sessions/send 就已经是确定路径，
// 不依赖"探测 Promise 有没有先跑完"。
const messageFactoryReady = resolveMessageFactory();

/**
 * 组装 toolkit：所有 endpoint 的真实实现在这里，apply 只负责挂载与生命周期。
 *
 * 这个函数就是给 Lead 的 e2e 用的薄 API：`createSessionTelecom(ctx, options)` 之后
 * 直接 `toolkit.rpc(method, payload)` 或 `toolkit.dispatch(endpoint, payload)`，
 * 完全不需要起宿主、不需要 webServer。
 *
 * @param {object} ctx - cordis host 上下文（或测试 stub）。
 * @param {object} [options]
 * @param {string|null} [options.selfSessionId] - 已知的当前会话 id；没有就按 env 兜底，再没有就 null。
 * @param {Record<string, string|undefined>} [options.env] - 环境来源（默认 process.env）。
 *        **单测请显式传 `{}`**：否则会读到真实进程的 DSH_PROFILE / DSH_SESSION_ID，测试就不再确定。
 * @param {'web'|'desktop'} [options.profile] - 覆写 profile 判定。
 * @param {string} [options.version] - 覆写版本号。
 * @param {'auto'|'prompt'|'agents'} [options.delivery] - 投递策略（正式可选项，默认 'auto' = prompt 优先）。
 *        也可在单次 payload 里带 `delivery` 覆写本次调用；`self/info` 回的是**本 host 的生效值**。
 * @param {object} [options.sessionController] - 覆写 sessionController 服务（测试/e2e 注入）。
 * @param {(error: unknown, context: string) => void} [options.onWarn]
 * @param {number} [options.maxReadBytes] - 只读正文上限（默认 32KB，最低 256 字节）。
 * @returns {object} toolkit
 */
export function createSessionTelecom(ctx, options = {}) {
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};
  const log = resolveLogger(ctx, options);
  const env = options.env ?? process.env;
  const version = options.version ?? pluginVersion;
  const profile = options.profile ?? detectProfile(ctx, env);
  // 显式 selfSessionId 优先；其次 DSH_SESSION_ID（本机实测存在，但不保证）；最后老实 null。
  const selfSessionId = resolveSelfId(options.selfSessionId) ?? envSelfSessionId(env);
  /** 本 host 的生效投递策略（payload 里的 delivery 只覆写单次调用，不改这个值）。 */
  const delivery = normalizeDeliveryStrategy(options.delivery);
  const registry = createSessionRegistry(ctx, {
    onWarn,
    selfSessionId,
  });
  const reader = createSessionReader(ctx, { maxReadBytes: options.maxReadBytes });

  /**
   * 运行时解析 sessionController —— **故意不缓存**：它不在 inject 列表里，
   * 可能在本插件 apply 之后才由 dsh-api-session-controller 提供（cordis 无注入序保证）。
   */
  function resolveSessionController() {
    return options.sessionController ?? tryGet(ctx, 'sessionController');
  }

  /**
   * 这条链现在到底会不会走内核 prompt 路径。
   *
   * 判据与 deliver.js 的选路条件**逐字一致**（`lib/deliver.js:144`）：
   *   strategy !== 'agents' && typeof controller?.prompt === 'function'
   * 所以 `delivery:'agents'` 永远是 false；`delivery:'prompt'` 但没有 sessionController 时也是 false
   * （那一次投递会直接报 `gateway/internal: sessionController is unavailable`）。
   */
  function promptPathActive(strategy) {
    return strategy !== 'agents' && typeof resolveSessionController()?.prompt === 'function';
  }

  /** sessions/list */
  async function listSessions(payload, signal) {
    return registry.list(signal);
  }

  /** sessions/send */
  async function sendMessage(payload, signal, extra) {
    const senderSessionId = firstNonEmpty(
      payload?.senderSessionId,
      extra?.senderSessionId,
      selfSessionId,
    );
    return deliverToSession(ctx, {
      ...payload,
      senderSessionId,
      mode: normalizeSendMode(payload?.mode),
    }, {
      signal,
      delivery: normalizeDeliveryStrategy(payload?.delivery ?? options.delivery),
      sessionController: resolveSessionController(),
      messageFactory: options.messageFactory,
      flush: options.flush,
      resumeOptions: options.resumeOptions,
      agentOptions: options.agentOptions,
      setup: options.setup,
      requestId: options.requestId,
      senderSessionId,
    });
  }

  /**
   * self/info。`delivery` 是本 host 的生效策略；`promptPath` 是"下一次 sessions/send 是否真的
   * 会走 sessionController.prompt"（客户端与验证者据此判断这条链走的哪条路）。
   * 单次调用的真实路径以 sessions/send 回执里的 `delivery: 'session-controller' | 'agents'` 为准。
   */
  function selfInfo() {
    return {
      sessionId: selfSessionId,
      profile,
      pluginVersion: version,
      delivery,
      promptPath: promptPathActive(delivery),
    };
  }

  /**
   * 等消息工厂探测落定（安装环境里是内核实现）。宿主路径不必等，
   * e2e / 单测想断言"真的用了内核工厂"时可以 await 一下。
   * @returns {Promise<'kernel'|'fallback'>}
   */
  function ready() {
    return messageFactoryReady.then(() => messageFactorySource(), () => messageFactorySource());
  }

  /**
   * endpoint → value。**总是**返回 {ok:true,value} 或 {ok:false,error}，永不抛。
   * @param {string} endpoint - SESSION_TELECOM_ENDPOINTS 里的值。
   * @param {object} payload
   * @param {AbortSignal} [signal]
   * @param {object} [extra] - 传输层补充信息（当前只有 senderSessionId）。
   */
  async function dispatch(endpoint, payload = {}, signal, extra) {
    if (signal?.aborted) {
      return fail(new ToolkitError(SESSION_TELECOM_ERROR_CODES.cancelled, 'request was cancelled', {}));
    }
    try {
      switch (endpoint) {
        case SESSION_TELECOM_ENDPOINTS.list:
          return ok(await listSessions(payload, signal));
        case SESSION_TELECOM_ENDPOINTS.send:
          return ok(await sendMessage(payload, signal, extra));
        case SESSION_TELECOM_ENDPOINTS.read:
          return ok(await reader.read(payload, signal));
        case SESSION_TELECOM_ENDPOINTS.self:
          return ok(selfInfo());
        default:
          return fail(new ToolkitError(
            SESSION_TELECOM_ERROR_CODES.badRequest,
            `unknown endpoint: ${String(endpoint)}`,
            { endpoint: typeof endpoint === 'string' ? endpoint : null },
          ));
      }
    } catch (error) {
      return fail(error);
    }
  }

  /** 统一的错误出口：先记日志，再转成 wire 形状。 */
  function fail(error) {
    const wire = toWireError(error);
    if (!(error instanceof ToolkitError)) {
      log.error?.('dsh-session-telecom: endpoint failed: %s', error?.stack ?? String(error));
    } else if (wire.code !== SESSION_TELECOM_ERROR_CODES.badRequest) {
      log.warn?.('dsh-session-telecom: %s (%s)', wire.message, wire.code);
    }
    return { ok: false, error: wire };
  }

  /** 传输层用的 handler：返回值直接就是 server-response 的 result。 */
  function rpcHandler(endpoint, payload, signal, extra) {
    return dispatch(endpoint, payload, signal, extra);
  }

  /**
   * 一把梭：`await toolkit.rpc('sessions/send', {...})` → 完整 server-response 信封。
   * 给 e2e / 单测用，走的是与 HTTP 完全同一条 dispatch 路径。
   * @param {string} method - endpoint 名。
   * @param {object} [payload]
   * @param {object} [options] - { rpcId, signal, senderSessionId }
   */
  async function rpc(method, payload, rpcOptions = {}) {
    const result = await dispatch(method, payload, rpcOptions.signal, {
      senderSessionId: rpcOptions.senderSessionId,
    });
    return {
      type: 'server-response',
      rpcId: typeof rpcOptions.rpcId === 'string' ? rpcOptions.rpcId : 'test-rpc',
      result,
    };
  }

  return {
    ctx,
    profile,
    pluginVersion: version,
    selfSessionId,
    endpoints: SESSION_TELECOM_ENDPOINTS,
    dispatch,
    rpc,
    rpcHandler,
    ready,
    listSessions,
    readSession: reader.read,
    sendMessage,
    selfInfo,
    messageFactorySource,
    toWireError,
  };
}

/**
 * cordis 插件入口。
 * @param {object} ctx
 * @param {object} [options] - 见 createSessionTelecom（宿主不传，测试/e2e 可传）。
 * @returns {object} 与 createSessionTelecom 同形的 toolkit。
 */
export function apply(ctx, options = {}) {
  const toolkit = createSessionTelecom(ctx, options);
  const log = resolveLogger(ctx, options);

  // 内核 createUserMessage 的探测结果（模块加载时已启动）——失败不影响挂载。
  messageFactoryReady.then(
    (resolved) => log.info?.('dsh-session-telecom: user-message factory = %s', resolved.source),
    (error) => log.warn?.('dsh-session-telecom: message factory probe failed: %s', String(error)),
  );

  // 先挂 webServer 路由；没有 webServer 服务就回退 connection.rpc.handle（loopback only）。
  let disposeRpc;
  try {
    disposeRpc = mountSessionTelecomWebRoute(ctx, {
      channel: SESSION_TELECOM_RPC_CHANNEL,
      handler: (endpoint, payload, signal) => toolkit.rpcHandler(endpoint, payload, signal),
      log,
      toError: toWireError,
    });
  } catch (mountError) {
    log.warn?.('dsh-session-telecom: webServer route mount failed: %s', String(mountError));
  }
  if (!disposeRpc) {
    try {
      const connection = tryGet(ctx, 'connection');
      if (connection?.rpc !== undefined && typeof connection.rpc.handle === 'function') {
        disposeRpc = connection.rpc.handle(
          SESSION_TELECOM_RPC_CHANNEL,
          (endpoint, payload, signal) => toolkit.rpcHandler(endpoint, payload, signal),
          { authority: 'loopback' },
        );
        log.info?.('dsh-session-telecom: rpc channel via connection.rpc.handle (legacy path)');
      } else {
        log.warn?.('dsh-session-telecom: rpc channel unavailable on this runtime');
      }
    } catch (rpcError) {
      log.warn?.('dsh-session-telecom: rpc channel unavailable on this runtime: %s', String(rpcError));
    }
  } else {
    log.info?.(`dsh-session-telecom: rpc route mounted on webServer (${SESSION_TELECOM_RPC_CHANNEL})`);
  }

  // 等宿主 tools 服务就绪，再借用它的 schema helper；本包不安装、复制或打包内核。
  // 卸载会取消未完成的加载，接口不可用只停用模型工具，不影响 RPC 与 UI。
  if (options.registerTool !== false) {
    registerSessionTelecomTool(ctx, toolkit, undefined, {
      onWarn: (error) => log.warn?.('dsh-session-telecom: model tool disabled: %s', String(error)),
      ...(options.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
      ...(options.listLimit === undefined ? {} : { listLimit: options.listLimit }),
      ...(options.senderPrefix === undefined ? {} : { senderPrefix: options.senderPrefix }),
    });
  }

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      try {
        disposeRpc?.();
      } catch (error) {
        log.warn?.('dsh-session-telecom: rpc dispose failed: %s', String(error));
      }
    }, 'dsh-session-telecom: host');
  }

  return toolkit;
}

/** 取 logger：优先 cordis 的 ctx.logger(name)，退回 console。 */
export function resolveLogger(ctx, options = {}) {
  if (options.logger !== undefined) return options.logger;
  try {
    if (typeof ctx?.logger === 'function') {
      const logger = ctx.logger(SESSION_TELECOM_NAME);
      if (logger !== undefined && logger !== null) return logger;
    }
  } catch {
    /* 落到 console */
  }
  return console;
}

/**
 * profile 判定与 dsh-session-lock/lib/index.js:30 一致：桌面宿主提供 desktopProfiles。
 * 环境变量兜底只在宿主没给线索时启用（web profile 的 ctx 也没有 desktopProfiles，
 * 所以这是区分 web/desktop 的唯一线索）。env 可注入，单测因此能与真实环境解耦。
 *
 * @param {object} ctx
 * @param {Record<string, string|undefined>} [env] - 默认 process.env；测试传 `{}` 表示"环境无信号"。
 * @returns {'web'|'desktop'}
 */
export function detectProfile(ctx, env = process.env) {
  try {
    if (typeof ctx?.get === 'function' && ctx.get('desktopProfiles') !== undefined) return 'desktop';
    if (ctx?.desktopProfiles !== undefined) return 'desktop';
  } catch {
    /* 继续 */
  }
  const fromEnv = env?.DSH_PROFILE;
  if (fromEnv === 'desktop' || fromEnv === 'web') return fromEnv;
  return 'web';
}

/** 读自身 package.json 的 version；读不到就 '0.0.0'。 */
function readOwnVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 取第一个非空字符串。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function ok(value) {
  return { ok: true, value };
}

export { SESSION_TELECOM_ENDPOINTS, SESSION_TELECOM_RPC_CHANNEL, SESSION_TELECOM_ERROR_CODES, ToolkitError };
export { buildRelayMessage, messageFactorySource, resolveMessageFactory, useMessageFactory, relaySourceFor };
export { deliverToSession, hasSessionSubagentOwner, normalizeDeliveryStrategy, normalizeSendMode };
export { createSessionRegistry, envSelfSessionId, mountSessionTelecomWebRoute };
export { createSessionReader };
export default { name, inject, apply };

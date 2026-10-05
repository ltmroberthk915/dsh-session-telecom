// dsh-session-telecom: host/client 共享契约（单一真源）。
//
// 这个文件是冻结契约的一半：客户端 developer 按同一份常量写 UI，改名会同时废掉两边。
// 改动前先看 task-2 描述里的契约段落。

/**
 * RPC 通道。webServer 上按 prefix 路由挂载，路径就是它本身。
 *
 * ⚠ **必须只有一个路径段**（形如 `/dsh-session-telecom`）。客户端 `ctx.connection.rpc.call`
 * 在发请求之前会跑 `assertTarget`（dsh-client-connection/lib/client.js:1317-1320），
 * 而它的 `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/` **不允许 `/`** —— 写成 `/api/xxx`
 * 会在**浏览器侧直接抛** `connection: invalid RPC target "/api/xxx/sessions/list"`，
 * 请求根本发不出去，而宿主侧看起来一切正常（路由挂上了、别的通道也活着）。
 * 踩过一次：真机 UI 报"宿主未就绪"，实际是通道名多了个 `/api` 前缀。
 * `/api` 是内核共享通道的保留前缀（`registerInterceptor` 里显式 `channel !== "/api"` 就抛），
 * 插件自己的通道一律用单段路径，与 dsh-session-lock 的 `/dsh-session-lock` 一致。
 */
export const SESSION_TELECOM_RPC_CHANNEL = '/dsh-session-telecom';

/** endpoint 名（信封里的 method 字段，也是 URL 的最后一段）。 */
export const SESSION_TELECOM_ENDPOINTS = Object.freeze({
  /** sessions/list → { sessions: [...], selfSessionId: string|null } */
  list: 'sessions/list',
  /** sessions/send → { delivered: true, ... } */
  send: 'sessions/send',
  /** sessions/read → bounded transcript; does not wake a saved session */
  read: 'sessions/read',
  /** self/info → { sessionId: string|null, profile, pluginVersion } */
  self: 'self/info',
});

/** 插件身份（与 package.json 的 name 一致，客户端注册 id 也用它）。 */
export const SESSION_TELECOM_NAME = 'dsh-session-telecom';

/** RPC 请求体上限：4 MB（与 dsh-client-connection 的 /api 传输同量级）。 */
export const SESSION_TELECOM_BODY_MAX = 4 * 1024 * 1024;

/**
 * 投递模式。契约只有这两个值：
 *   - 'queue'（默认）：排到目标会话的**下一轮**（agent.followup → inbox 'next-turn'）。
 *   - 'steer'        ：插进目标会话的**下一步**（agent.steer → inbox 'next-step'）。
 * 未知值回退到 'queue'，不报错——客户端多发一个字段不该让投递失败。
 */
export const SESSION_TELECOM_SEND_MODES = Object.freeze(['queue', 'steer']);

/** 消息来源标记：目标会话日志里靠它认出这条跨会话消息。 */
export const SESSION_TELECOM_SOURCE_KIND = 'agent-message';

/**
 * 无发信方身份时用的**内核合法**来源（`MessageSourceMap.user` = `{ kind: 'user' }`，
 * dsh-llm/lib/typert.host.js:417）。这正是 `sessionController.prompt` 自己写的形状
 * （api-session-controller/lib/types/commands.js:303-307，带 rpcId 的版本）。
 * 绝不写 `{ kind:'agent-message', senderSessionId:'' }`：那会被格式校验器判非法
 * （dsh-session-format-v2-to-v3/lib/index.js:132）并让 GUI 降级成 opaque 渲染
 * （dsh-client-ui-chat/lib/client.js:741-744,860）。
 */
export const SESSION_TELECOM_OPAQUE_SOURCE = Object.freeze({ kind: 'user' });

/**
 * 稳定错误码（客户端按 code 分支，不要按 message 文案分支）。
 *
 * 后两个是内核 `sessionController` 的所有权/写锁拒绝码，逐字透传：
 *   - `session/agent-busy`   ← api-session-controller/lib/types/agent.js:120-122
 *                              （origin==='subagent' 或 live 子会话仍被父 agent 拥有）
 *   - `session/writer-held`  ← api-session-controller/lib/types/agent.js:242-244
 *                              （同一个 session 已有活跃写句柄）
 */
export const SESSION_TELECOM_ERROR_CODES = Object.freeze({
  badRequest: 'bad-request',
  sessionNotFound: 'session/not-found',
  agentBusy: 'session/agent-busy',
  writerHeld: 'session/writer-held',
  steerUnavailable: 'session/steer-unavailable',
  readUnavailable: 'session/read-unavailable',
  cancelled: 'cancelled',
  internal: 'gateway/internal',
});

/**
 * 投递策略（host 侧开关，不在客户端契约里）：
 *   - 'auto'（默认）：优先 `ctx.sessionController.prompt`，缺席才走自研 agents 路径；
 *   - 'prompt'       ：只走内核 RPC 路径，没有 sessionController 就报结构化错误；
 *   - 'agents'       ：只走自研路径（保留 `agent-message` relay 来源，供需要
 *                      "目标时间线显示成'另一个 agent 发来的消息'"的部署显式选择）。
 */
export const SESSION_TELECOM_DELIVERY_STRATEGIES = Object.freeze(['auto', 'prompt', 'agents']);

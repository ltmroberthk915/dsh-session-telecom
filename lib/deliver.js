// 跨会话投递：把一条消息投进目标会话，冷会话先唤醒。
//
// 两条投递路径，按 `delivery` 策略选：
//
//  ① sessionController.prompt（默认首选，'auto' / 'prompt'）
//     ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)
//       - 服务名注册处：api-session-controller/lib/types/index.js:208 `super(ctx, 'sessionController', …)`
//       - 公开方法：    api-session-controller/lib/types/index.js:476-479（signal.throwIfAborted() + commands.prompt）
//       - 实现：        api-session-controller/lib/types/commands.js:290-352
//           · :300 `const agent = await this.resolveAgent(request.sessionId)` ← 任意 sessionId，冷会话在这里被 resume
//           · :301 `hasPromptRequest(agent, request.requestId)` → `{accepted:true}` ← requestId 幂等
//           · :303-307 source = { kind:'user', rpcId: requestId } ← 内核合法来源，绝不伪造发信方
//           · :327-330 mode==='steer' ? agent.steer(msg) : agent.followup(msg)
//       一次拿到：preset 挂载、模型选择安装、requestId 幂等、三态错误码
//       （session/not-found | session/agent-busy | session/writer-held，见 types/agent.js:229-247）。
//       代价（有意接受）：目标端 source 是 `user`，不再显示成"另一个 agent 发来的消息"；
//       subagent 会话会被内核拒收（session/agent-busy）——这正是内核希望的行为。
//
//  ② 自研 agents 路径（sessionController 缺席时的降级，或 delivery:'agents' 显式选择）
//     保留 `agent-message` relay 来源，于是必须自己补齐内核 RPC 层做过的三件事：
//       R2 所有权判定：hasSessionSubagentOwner()，逐字对照 types/agent.js:106-114；
//          命中即抛 session/agent-busy（文案/reason 同 :120-122）——不这么做会打断 subagent 续聊，
//          并让 Team mailbox 的 ack 失效（mailbox 只认 source.kind==='team-message'）导致重复投递。
//       R3 resume 参数：照 types/agent.js:448-452 带上 agentOptions（部署默认 provider/model）
//          与 setup（挂 agent preset）；缺失会让冷会话丢掉 agent preset。
//       R1 来源：有非空 senderSessionId 才写 agent-message，否则退回 { kind:'user' }（见 message.js）。
//
// 真实 agent API（都核对过实现）：
//   - 唤醒冷会话： ctx.agents.resume({ resumeSessionId, agentOptions, setup })
//         dsh-agent/lib/types/index.js:192-198 → dsh-agent-loop/lib/index.js:1921-1978 resumeWith
//         （:1970 `setupAndPublish(ownerCtx, id, preparation, options.agentOptions ?? {}, options.setup, …)`）
//   - 排队（下一轮）： agent.followup(message)  → dsh-agent-loop/lib/index.js:806 → send(m,'next-turn',true)
//   - 插队（下一步）： agent.steer(message)     → dsh-agent-loop/lib/index.js:809 → send(m,'next-step',true)
//         InboxTarget 只有 'next-turn' | 'next-step'（dsh-api-session-controller/lib/typert.host.js:1821）
//   - 落盘： ctx.sessions.flush(session) → dsh-session/lib/index.js:1832（THE flush entry point）
//
// 一个必须说清的语义（否则「落盘验证」会误报）：
//   内核只在 step 真正开始时才把 inbox 里的消息 append 成 `user/message` 事件
//   （dsh-agent-loop/lib/index.js:1061）。所以目标在忙时消息仍在 inbox 排队，**此刻日志里本来就不会有它**；
//   回执因此给 `persisted`（读回确认）+ `queuedInInbox`（inbox 确认）两个独立事实。
//   `delivered:true` 的含义是「投递通道已接受这条消息」，与契约一致。
//
// 回执里 `live` 的语义（与客户端对齐，见 client/index.jsx:883）：
//   `live === false` 表示**投递前目标不是 live**（宿主/内核替你唤醒了它）——客户端据此提示"目标原本是冷的"。
//   `resumed` 额外说明"是不是本插件亲手 resume 的"。

import { randomUUID } from 'node:crypto';
import {
  SESSION_TELECOM_DELIVERY_STRATEGIES,
  SESSION_TELECOM_ERROR_CODES as CODES,
  SESSION_TELECOM_SEND_MODES,
  SESSION_TELECOM_SOURCE_KIND,
} from './api.js';
import { ToolkitError, agentBusy, cancelled } from './errors.js';
import { buildRelayMessage } from './message.js';
import { tryGet } from './session-registry.js';

/** 投递模式归一：未知值回退 queue（客户端多发字段不该让投递失败）。 */
export function normalizeSendMode(value) {
  return SESSION_TELECOM_SEND_MODES.includes(value) ? value : 'queue';
}

/** 投递策略归一：未知值回退 'auto'（= 优先内核 RPC 路径）。 */
export function normalizeDeliveryStrategy(value) {
  return SESSION_TELECOM_DELIVERY_STRATEGIES.includes(value) ? value : 'auto';
}

/**
 * 生成署名行（用户要求："发送方 session 默认带一段话，由 sessionxxx 发送"）。
 *
 * 认得出具体会话就写 id；认不出（桌面宿主拿不到"当前会话"这个事实）就写"未知会话"——
 * **不编造 id**，但也**不沉默**：接收方至少知道这条消息是被人/别的会话转投进来的。
 *
 * @param {string|null} senderSessionId
 * @returns {string} 以换行结尾的一行署名
 */
export function attributionLine(senderSessionId) {
  const who = typeof senderSessionId === 'string' && senderSessionId.length > 0 ? senderSessionId : '未知会话';
  return `[由 ${who} 发送]\n`;
}

/**
 * 内核的 subagent 所有权判定，逐字对照 dsh-api-session-controller/lib/types/agent.js:106-114：
 *
 *     export function hasApiSessionSubagentOwner(ctx, session, agent) {
 *         if (session.header.origin === 'subagent') return true;
 *         const parentId = session.header.parentSession;
 *         if (parentId === undefined || agent === undefined) return false;
 *         const parent = ctx.agents.get(parentId);
 *         return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent);
 *     }
 *
 * （`agents.isOwnedBy` 实现：dsh-agent/lib/types/index.js:360-362
 *   `return this.store.get(id)?.owner === owner;`）
 *
 * @param {object} ctx
 * @param {{header?: object}|undefined} session
 * @param {object|undefined} agent - live 目标才传；冷会话与内核一样传 undefined
 * @returns {boolean}
 */
export function hasSessionSubagentOwner(ctx, session, agent) {
  const header = session?.header;
  if (header?.origin === 'subagent') return true;
  const parentId = header?.parentSession;
  if (parentId === undefined || agent === undefined) return false;
  const agents = tryGet(ctx, 'agents');
  if (agents === undefined || typeof agents.get !== 'function' || typeof agents.isOwnedBy !== 'function') return false;
  const parent = agents.get(parentId);
  return parent !== undefined && agents.isOwnedBy(agent.id, parent) === true;
}

/**
 * 投递一条消息到目标会话。
 *
 * @param {object} ctx - cordis host 上下文（或测试 stub）。
 * @param {object} payload - 契约里的 sessions/send payload。
 * @param {string} payload.targetSessionId - 目标会话 id。
 * @param {string} payload.text - 消息正文（空白 → bad-request）。
 * @param {string|null} [payload.senderSessionId] - 发信会话 id；**拿不到就不要编**（见 message.js 的 source 规则）。
 * @param {'queue'|'steer'} [payload.mode] - 投递模式，默认 queue。
 * @param {boolean} [payload.expectReply] - 提问时附明确回信通道，要求发信方真实存在。
 * @param {string} [payload.requestId] - 幂等键（内核路径用；同一个 id 重投不会再产生一条消息）。
 * @param {'auto'|'prompt'|'agents'} [payload.delivery] - 可选策略覆写（契约外的附加字段）。
 * @param {object} [options] - 行为覆写（host / 测试）。
 * @param {'auto'|'prompt'|'agents'} [options.delivery] - 策略覆写。
 * @param {object} [options.sessionController] - 覆写 sessionController 服务（测试注入）。
 * @param {Function} [options.messageFactory] - 强制使用的 createUserMessage（自研路径）。
 * @param {(session: object) => Promise<void>} [options.flush] - 覆写 flush（测试用）。
 * @param {object} [options.resumeOptions] - 额外塞进 resume 的参数（自研路径，优先级最高）。
 * @param {object} [options.agentOptions] - 覆写 resume 的 agentOptions。
 * @param {Function} [options.setup] - 覆写 resume 的 setup。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @returns {Promise<object>} 契约里的 value。
 * @throws {ToolkitError} bad-request / session/not-found / session/agent-busy / session/writer-held / …
 */
export async function deliverToSession(ctx, payload, options = {}) {
  // 内核 prompt 的第一行就是 signal.throwIfAborted()：signal 必须是真信号，绝不能是 undefined。
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted?.();

  const targetSessionId = trimString(payload?.targetSessionId);
  if (targetSessionId.length === 0) {
    throw new ToolkitError(CODES.badRequest, 'targetSessionId is required', { field: 'targetSessionId' });
  }
  const rawText = trimString(payload?.text);
  if (rawText.length === 0) {
    throw new ToolkitError(CODES.badRequest, 'text must contain non-whitespace characters', { field: 'text' });
  }
  const requestedSender = firstNonEmpty(payload?.senderSessionId, options.senderSessionId);
  const mode = normalizeSendMode(payload?.mode);
  const strategy = normalizeDeliveryStrategy(payload?.delivery ?? options.delivery);
  // requestId 是内核路径的幂等键：调用方给了就照用（重试安全），没给就现生成一个。
  const requestId = firstNonEmpty(payload?.requestId, options.requestId) ?? `toolkit-${randomUUID()}`;

  // 发信方必须是**真实存在**的会话：客户端把 `self/info` 的 sessionId 原样传回来，而那个值
  // 来自宿主的 `DSH_SESSION_ID` 兜底——它可能是**别的**会话（甚至是被删掉的旧会话）。伪造发信方
  // 会让目标端时间线出现"来自某个陌生会话"的假标记，所以查不到就不带标记，并且如实告知调用方。
  // 语义选择：**降级而不是拒收**——消息本身是用户真实意图，不该因为一个装饰性字段丢掉。
  let senderSessionId = requestedSender;
  let senderRejected = null;
  if (typeof requestedSender === 'string' && requestedSender.length > 0) {
    const known = await senderSessionKnown(ctx, requestedSender, signal, payload?.expectReply === true);
    if (!known) {
      senderRejected = requestedSender;
      senderSessionId = null;
    }
  }

  // 发信人署名（用户要求："发送方 session 默认带一段话"）。
  // prompt 路径投出去的是一条普通用户消息，接收方只能看到正文；署名把"谁在跟我说话"留在
  // 目标会话的时间线上。**认不出具体会话时也署名**，但要如实写"未知会话"——留一行字比让
  // 接收方猜强，而且不会编造身份。
  // 只认调用方显式传入的 senderPrefix；没传就用 options（默认开）。
  const prefixMode = payload?.senderPrefix ?? options.senderPrefix;
  const senderPrefixEnabled = prefixMode !== false;
  let text = senderPrefixEnabled
    ? `${attributionLine(senderSessionId)}${rawText}`
    : rawText;
  // Explicit requests get a copyable return route. Ordinary notifications stay short.
  if (payload?.expectReply === true) {
    if (!senderSessionId) {
      throw new ToolkitError(CODES.badRequest, 'expectReply requires a known senderSessionId; use read to retrieve an answer', {});
    }
    text += `\n\n[需要实质答复：请使用 session_telecom action=send targetSessionId=${JSON.stringify(senderSessionId)} 回投结果。仅写在本会话里不会自动回传；只确认收到无需回投。]`;
  }

  const controller = strategy === 'agents'
    ? undefined
    : (options.sessionController ?? tryGet(ctx, 'sessionController'));

  if (strategy !== 'agents' && typeof controller?.prompt === 'function') {
    return deliverViaSessionController(ctx, {
      controller, requestId, targetSessionId, text, mode, senderSessionId, senderRejected, signal, options,
    });
  }
  if (strategy === 'prompt') {
    throw new ToolkitError(
      CODES.internal,
      'sessionController is unavailable in this deployment; cannot use the prompt delivery strategy',
      { targetSessionId, strategy },
    );
  }
  return deliverViaAgents(ctx, { targetSessionId, text, mode, senderSessionId, senderRejected, signal, options });
}

// ------------------------------------------------------------------ 路径 ① 内核 RPC

/**
 * 走 `ctx.sessionController.prompt`：内核自己负责 resume / 所有权 / preset / 幂等。
 * 本函数只负责入参形状、错误码收敛、以及"尽力而为"的落盘回读。
 */
async function deliverViaSessionController(ctx, input) {
  const { controller, requestId, targetSessionId, text, mode, senderSessionId, senderRejected, signal, options } = input;
  const agents = tryGet(ctx, 'agents');
  const wasLive = typeof agents?.get === 'function' ? agents.get(targetSessionId) !== undefined : false;
  const request = {
    requestId,
    sessionId: targetSessionId,
    mode,
    content: [{ type: 'text', text }],
  };

  let accepted;
  try {
    accepted = await controller.prompt(request, signal);
  } catch (error) {
    throw mapDeliveryError(error, targetSessionId);
  }
  if (accepted !== undefined && accepted !== null && accepted.accepted === false) {
    throw new ToolkitError(CODES.internal, `session "${targetSessionId}" rejected the prompt`, { targetSessionId });
  }

  const session = liveSessionOf(ctx, targetSessionId);
  const durability = await checkpointController(ctx, session, targetSessionId, requestId, options);
  const liveAgent = typeof agents?.get === 'function' ? agents.get(targetSessionId) : undefined;

  return {
    delivered: true,
    targetSessionId,
    mode,
    // 与客户端对齐：false = 投递前目标是冷的（内核刚把它唤醒）。
    live: wasLive,
    messageId: durability.messageId ?? requestId,
    ...durability.eventSeq === undefined ? {} : { seq: durability.eventSeq },
    senderSessionId,
    senderApplied: false, // prompt 路径的 source 是 { kind:'user' }，不承载发信方
    // 绝不给"值为 undefined 的可选键"（DSH 工具层会因为非 lossless JSON 直接拒收结果）：
    // 有内容才展开，没内容这个键根本不存在。
    ...senderRejected === null || senderRejected === undefined
      ? {}
      : { senderDropped: { requested: senderRejected, reason: 'unknown-session' } },
    sourceKind: 'user',
    delivery: 'session-controller',
    // 附加事实（契约允许，客户端可忽略）：
    requestId,
    resumed: !wasLive,
    liveNow: liveAgent !== undefined,
    persisted: durability.persisted,
    persistence: durability.persistence,
    ...durability.flushError === undefined ? {} : { flushError: durability.flushError },
    messageIdSource: durability.messageId === undefined ? 'request-id' : 'session-log',
    status: liveAgent?.status ?? null,
  };
}

/** 内核路径的落盘屏障 + 回读：flush 尽力、失败不推翻已接受的投递；回读用 requestId 认消息。 */
async function checkpointController(ctx, session, sessionId, requestId, options) {
  const flush = options.flush ?? defaultFlush(ctx);
  let flushError;
  if (session !== undefined && typeof flush === 'function') {
    try {
      await flush(session);
    } catch (error) {
      flushError = messageOf(error);
    }
  }
  const found = await readBack(ctx, sessionId, session, (event) => {
    const source = event?.data?.source;
    return source?.kind === 'user' && source?.rpcId === requestId;
  });
  if (found !== undefined) {
    return flushError === undefined ? found : { ...found, flushError };
  }
  return {
    persisted: false,
    // 目标在忙时消息还在 inbox 排队（见文件头），内核已接受但日志里还没有它。
    persistence: 'controller-accepted',
    ...flushError === undefined ? {} : { flushError },
  };
}

// ------------------------------------------------------------------ 路径 ② 自研 agents

async function deliverViaAgents(ctx, input) {
  const { targetSessionId, text, mode, senderSessionId, senderRejected, signal, options } = input;
  const agents = tryGet(ctx, 'agents');
  if (agents === undefined || typeof agents.get !== 'function') {
    throw new ToolkitError(CODES.internal, 'agent service is unavailable in this deployment', {});
  }

  // 1) 先看 live；没有就确认冷会话确实存在（含所有权判定），再唤醒。
  let agent = agents.get(targetSessionId);
  const wasLive = agent !== undefined;
  if (agent === undefined) {
    const observation = await inspectTargetSession(ctx, targetSessionId, signal);
    // R2（冷会话）：origin === 'subagent' 的会话归 subagent 路由，普通 resume 会打断它的续聊。
    if (hasSessionSubagentOwner(ctx, { header: observation?.header }, undefined)) {
      throw agentBusy(targetSessionId);
    }
    agent = await resumeAgent(ctx, targetSessionId, options, observation);
  } else if (hasSessionSubagentOwner(ctx, agent.session, agent)) {
    // R2（live 会话）：仍是某个活父 agent 的子会话（subagent / teammate）——内核 RPC 层同样拒收。
    throw agentBusy(targetSessionId);
  }
  signal?.throwIfAborted?.();

  const session = agent?.session;
  if (session === undefined || typeof session !== 'object') {
    throw new ToolkitError(CODES.internal, `agent for session "${targetSessionId}" exposes no session`, { targetSessionId });
  }
  if (typeof session.id === 'string' && session.id !== targetSessionId) {
    throw new ToolkitError(
      CODES.internal,
      `agent for session "${targetSessionId}" actually owns session "${session.id}"`,
      { targetSessionId, actualSessionId: session.id },
    );
  }

  // 2) 构造消息并投进 inbox。R1：没有发信方就退回内核合法的 { kind:'user' }，绝不写空 senderSessionId。
  const message = buildRelayMessage({ text, senderSessionId, factory: options.messageFactory });
  const sourceKind = message?.source?.kind ?? null;
  const accepted = enqueue(agent, message, mode);
  const queuedInInbox = accepted !== false;
  if (!queuedInInbox) {
    throw new ToolkitError(CODES.internal, `agent for session "${targetSessionId}" did not accept the message`, { targetSessionId });
  }

  // 3) 落盘 + 读回确认。
  const durability = await checkpoint(ctx, session, message.id, targetSessionId, options);

  return {
    delivered: true,
    targetSessionId,
    mode,
    // 与客户端对齐：false = 投递前目标是冷的（本插件刚把它唤醒）。
    live: wasLive,
    messageId: message.id,
    ...durability.eventSeq === undefined ? {} : { seq: durability.eventSeq },
    senderSessionId,
    senderApplied: senderSessionId !== null && sourceKind === SESSION_TELECOM_SOURCE_KIND,
    ...senderRejected === null || senderRejected === undefined
      ? {}
      : { senderDropped: { requested: senderRejected, reason: 'unknown-session' } },
    sourceKind,
    delivery: 'agents',
    // 下面几个是附加事实（契约允许，客户端可忽略）：
    resumed: !wasLive,
    persisted: durability.persisted,
    queuedInInbox,
    persistence: durability.persistence,
    status: agent?.status ?? null,
  };
}

/** 按模式调内核 agent 的真实投递方法。返回 false 表示 agent 没接。 */
function enqueue(agent, message, mode) {
  try {
    if (mode === 'steer') {
      if (typeof agent.steer !== 'function') return false;
      agent.steer(message);
      return true;
    }
    if (typeof agent.followup !== 'function') return false;
    agent.followup(message);
    return true;
  } catch (error) {
    throw new ToolkitError(
      CODES.steerUnavailable,
      `target session rejected ${mode} delivery: ${messageOf(error)}`,
      { mode, reason: error instanceof Error ? error.name : typeof error },
    );
  }
}

/**
 * 发信方是不是一个**已知会话**（修 bug：客户端可能把宿主环境的 DSH_SESSION_ID 当成"当前会话"）。
 *
 * 判定顺序与 inspectTargetSession 一致（sessionQuery → live 表 → persistence），但**只做存在性**：
 * "这个 id 是不是你当前打开的那个会话"宿主无法可靠知道，交给客户端保证。
 *
 * 判不出来（没有任何查询手段）时返回 true —— 宁可保留标记，也不要因为部署缺服务而砍掉语义。
 *
 * @param {object} ctx
 * @param {string} senderSessionId
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function senderSessionKnown(ctx, senderSessionId, signal, requireKnown = false) {
  try {
    if (requireKnown) {
      // A return route needs a proven identity. Live lookup/stat avoid reading
      // the requester's complete history merely to establish that it exists.
      signal?.throwIfAborted?.();
      if (tryGet(ctx, 'sessions')?.get?.(senderSessionId) !== undefined
        || tryGet(ctx, 'agents')?.get?.(senderSessionId)?.session !== undefined) return true;
      const persistence = tryGet(ctx, 'sessionPersistence');
      if (typeof persistence?.stat === 'function') {
        return await persistence.stat(senderSessionId, signal ? { signal } : undefined) !== undefined;
      }
    }
    await inspectTargetSession(ctx, senderSessionId, signal);
    return true;
  } catch (error) {
    signal?.throwIfAborted?.();
    if (requireKnown || (error instanceof ToolkitError && error.code === CODES.sessionNotFound)) return false;
    // 查询层自己坏了（权限、IO）不算"不存在"，保留标记并让调用方从日志里看出异常。
    return true;
  }
}

/**
 * 冷会话必须真实存在才 resume，否则会把一个不存在的 id 变成新会话。
 * 返回 `{header, agentPreset}`（R3 的 setup 需要 preset 身份），拿不到细节时为 undefined 字段。
 */
async function inspectTargetSession(ctx, sessionId, signal) {
  const query = tryGet(ctx, 'sessionQuery');
  if (query !== undefined && typeof query.observeSession === 'function') {
    let observation;
    try {
      observation = await query.observeSession(sessionId, signal === undefined ? {} : { signal });
    } catch (error) {
      if (isNotFound(error)) throw notFound(sessionId);
      throw error;
    }
    try {
      // 与内核 presetForObservation 同源：api-session-controller/lib/types/agent.js:525-530。
      return { header: observation?.header, agentPreset: observation?.projections?.values?.agentPreset };
    } finally {
      disposeQuietly(observation);
    }
  }
  if (query !== undefined && typeof query.load === 'function') {
    try {
      const loaded = await query.load(sessionId, signal);
      return { header: loaded?.header, agentPreset: loaded?.projections?.values?.agentPreset };
    } catch (error) {
      if (isNotFound(error)) throw notFound(sessionId);
      throw error;
    }
  }
  // 没有 sessionQuery（老 runtime / 精简部署）：只能用 live 表 + persistence 兜底。
  if (tryGet(ctx, 'sessions')?.get?.(sessionId) !== undefined) return { header: undefined };
  const persistence = tryGet(ctx, 'sessionPersistence');
  if (persistence !== undefined && typeof persistence.stat === 'function') {
    const snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal });
    if (snapshot === undefined) throw notFound(sessionId);
    return { header: snapshot?.header };
  }
  throw notFound(sessionId);
}

/**
 * 唤醒冷会话；失败按内核语义映射成稳定 code。
 * R3：照 types/agent.js:448-452，带上 agentOptions 与 setup，否则冷会话会丢 agent preset。
 */
async function resumeAgent(ctx, sessionId, options, observation) {
  const agents = tryGet(ctx, 'agents');
  const resume = agents?.resume;
  if (typeof resume !== 'function') {
    throw new ToolkitError(CODES.internal, 'agent service cannot resume sessions in this deployment', { sessionId });
  }
  const args = { resumeSessionId: sessionId };
  Object.assign(args, await composeResumeOptions(ctx, observation, options));
  const provided = options.resumeOptions;
  if (provided !== undefined && provided !== null && typeof provided === 'object') Object.assign(args, provided);
  try {
    const resumed = await resume.call(agents, args);
    const agent = resumed?.agent ?? resumed;
    if (agent === undefined || agent === null) {
      throw new ToolkitError(CODES.internal, `resume returned no agent for session "${sessionId}"`, { sessionId });
    }
    return agent;
  } catch (error) {
    if (error instanceof ToolkitError) throw error;
    if (isNotFound(error)) throw notFound(sessionId);
    throw mapDeliveryError(error, sessionId);
  }
}

/**
 * 组装 resume 的 agentOptions / setup（R3）。
 *
 * 内核的 composeAgent（api-session-controller/lib/types/agent.js:388-401）做两件事：
 *     this.installSelection(agent);            // 装 modelSelection 投影（内核私有：selectionFor()）
 *     await presets.mount(agentCtx, resolvedId) // 挂 agent preset
 * 插件上下文里只能复刻第二件（presets 是公开服务 `ctx.agentPresets`，注册处 dsh-agent-preset-registry/
 * lib/index.js:481；`resolve(id)` → `{id}` 见 :603-615，`mount(ctx, id)` 见 :693-702）。
 * 第一件（installSelection）没有对插件公开的入口，因此这里用 agentOptions 把部署默认路由交代清楚，
 * 让 agent loop 至少不会撞上 "has no provider/model"。
 */
async function composeResumeOptions(ctx, observation, options) {
  const out = {};
  const explicitAgentOptions = options.agentOptions;
  if (explicitAgentOptions !== undefined && explicitAgentOptions !== null && typeof explicitAgentOptions === 'object') {
    out.agentOptions = { ...explicitAgentOptions };
  } else {
    const defaults = tryGet(ctx, 'agentDefaultModel');
    if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
      try {
        // 内核同源：api-session-controller/lib/types/agent.js:513-516
        // `const { provider, model } = this.ctx.agentDefaultModel.currentSelection(); return { provider, model };`
        const selection = defaults.currentSelection();
        if (selection !== null && typeof selection === 'object') {
          out.agentOptions = { provider: selection.provider, model: selection.model };
        }
      } catch {
        /* 拿不到部署默认路由就不传，让循环用它自己的默认 */
      }
    }
  }

  if (typeof options.setup === 'function') {
    out.setup = options.setup;
    return out;
  }
  const presets = tryGet(ctx, 'agentPresets');
  if (presets !== undefined && typeof presets.mount === 'function') {
    const requested = observation?.agentPreset ?? observation?.projections?.values?.agentPreset;
    // setup 的调用形状由内核固定：dsh-agent-loop/lib/index.js:1888 `setup?.(prepared.agent.ctx, prepared.agent)`
    out.setup = async (agentCtx, agent) => {
      void agent;
      const resolved = typeof presets.resolve === 'function' ? await presets.resolve(requested) : undefined;
      const presetId = resolved?.id ?? requested;
      if (presetId !== undefined) await presets.mount(agentCtx, presetId);
    };
  }
  return out;
}

/**
 * 落盘屏障 + 读回确认（三层，逐级降级）。
 * @returns {Promise<{persisted: boolean, eventSeq?: number, persistence: string}>}
 */
async function checkpoint(ctx, session, messageId, sessionId, options) {
  const flush = options.flush ?? defaultFlush(ctx);
  let flushError;
  if (typeof flush === 'function') {
    try {
      await flush(session);
    } catch (error) {
      flushError = error;
    }
  }
  const found = await readBack(ctx, sessionId ?? session?.id, session, (event) => event?.data?.id === messageId);
  if (found !== undefined) return found;
  if (flushError !== undefined) {
    throw new ToolkitError(
      CODES.internal,
      `delivery could not be made durable: ${messageOf(flushError)}`,
      { messageId },
    );
  }
  // flush 成功但日志里还没有这条消息 = 目标在忙，消息正在 inbox 排队（见文件头说明）。
  return { persisted: false, persistence: 'queued-inbox' };
}

/** 默认落盘手段：ctx.sessions.flush(session)（dsh-session/lib/index.js:1832）。 */
function defaultFlush(ctx) {
  const sessions = tryGet(ctx, 'sessions');
  return sessions !== undefined && typeof sessions.flush === 'function'
    ? (session) => sessions.flush(session)
    : undefined;
}

/** 目标 live 时的 session 实例（prompt 路径回读用）。 */
function liveSessionOf(ctx, sessionId) {
  const sessions = tryGet(ctx, 'sessions');
  const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
  if (session !== undefined) return session;
  const agents = tryGet(ctx, 'agents');
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined;
  return agent?.session;
}

/**
 * 读回确认，从最权威的一层开始，**任何一层没找到都继续往下找**：
 *   1. persistence 冷读（真正证明"落盘了"）
 *   2. sessionQuery.readSession（对返回的日志副本找）
 *   3. session.snapshotEvents()（内存日志；flush 已成功 → 这条事件已被持久化监听器收走）
 *
 * 注意第 1 层「读到了盘但没这条」**不能直接判失败**：内核只在 step 开始时才把
 * inbox 消息 append 成 user/message 事件（见文件头），目标在忙时持久层里本来就没有它。
 * @param {(event: object) => boolean} match - 认消息的谓词（自研路径按 message.id，内核路径按 source.rpcId）
 * @returns {Promise<{persisted: boolean, eventSeq?: number, persistence: string, messageId?: string}|undefined>}
 */
async function readBack(ctx, sessionId, session, match) {
  let coldReadMiss = false;
  const persistence = tryGet(ctx, 'sessionPersistence');
  if (persistence !== undefined && typeof persistence.load === 'function' && typeof sessionId === 'string') {
    try {
      const loaded = await persistence.load(sessionId);
      const events = loaded?.events ?? loaded?.snapshot?.events;
      const hit = findMessage(events, match);
      if (hit !== undefined) return { ...hit, persisted: true, persistence: 'session-persistence' };
      coldReadMiss = true;
    } catch {
      /* 读不回不算失败，继续降级 */
    }
  }
  const query = tryGet(ctx, 'sessionQuery');
  if (query !== undefined && typeof query.readSession === 'function' && typeof sessionId === 'string') {
    try {
      const loaded = await query.readSession(sessionId);
      const hit = findMessage(loaded?.events, match);
      if (hit !== undefined) return { ...hit, persisted: true, persistence: 'session-query' };
    } catch {
      /* 同上 */
    }
  }
  if (session !== undefined && typeof session.snapshotEvents === 'function') {
    try {
      const hit = findMessage(session.snapshotEvents(), match);
      // 已进日志 + flush 已成功 → 算落盘。
      if (hit !== undefined) return { ...hit, persisted: true, persistence: 'session-log' };
    } catch {
      /* 同上 */
    }
  }
  if (coldReadMiss) return { persisted: false, persistence: 'flush-only' };
  return undefined;
}

/** 在一段事件流里找我们投的那条 user/message，返回 seq / 序号信息。 */
function findMessage(events, match) {
  if (!Array.isArray(events)) return undefined;
  for (const event of events) {
    if (event?.type !== 'user/message' || typeof match !== 'function' || match(event) !== true) continue;
    return {
      messageId: typeof event.data?.id === 'string' ? event.data.id : undefined,
      eventSeq: typeof event.seq === 'number' ? event.seq : undefined,
      sessionSeq: typeof event.data?.seq === 'number' ? event.data.seq : undefined,
      sourceKind: event.data?.source?.kind ?? null,
    };
  }
  return undefined;
}

/** 内核错误 → 稳定 ToolkitError（保留内核 code 与 details，补上 sessionId）。 */
function mapDeliveryError(error, sessionId) {
  if (error instanceof ToolkitError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return cancelled(messageOf(error));
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : '';
  const details = mergeDetails(error?.details, sessionId);
  if (code === CODES.sessionNotFound || code === 'SESSION_QUERY_SESSION_NOT_FOUND') return notFound(sessionId);
  if (code === CODES.agentBusy) {
    return new ToolkitError(
      CODES.agentBusy,
      messageOf(error),
      details.reason === undefined ? { ...details, reason: 'use subagent delivery for this child session' } : details,
    );
  }
  if (code === CODES.writerHeld) return new ToolkitError(CODES.writerHeld, messageOf(error), details);
  if (code === CODES.cancelled) return cancelled(messageOf(error));
  if (code.length > 0) return new ToolkitError(code, messageOf(error), details);
  return new ToolkitError(CODES.internal, messageOf(error), details);
}

/** 只挑 pick 里列出的字段（回执瘦身用）。 */
export function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key];
  return out;
}

/** 内核 sessionQuery 的「不存在」错误码。 */
function isNotFound(error) {
  return error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
    || error?.code === CODES.sessionNotFound
    || error?.name === 'SessionPersistenceNotFoundError';
}

function notFound(sessionId) {
  return new ToolkitError(CODES.sessionNotFound, `session "${sessionId}" not found`, { sessionId });
}

/** 安静释放 observation 租约（可能根本没有 [Symbol.dispose]）。 */
function disposeQuietly(value) {
  if (value === null || typeof value !== 'object') return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === 'function') {
    try {
      dispose.call(value);
    } catch {
      /* 释放失败不该影响投递结论 */
    }
  }
}

/** 取第一个非空字符串。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function mergeDetails(details, sessionId) {
  const out = {};
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    for (const [key, value] of Object.entries(details)) out[key] = value;
  }
  if (sessionId !== undefined) out.sessionId = sessionId;
  return out;
}

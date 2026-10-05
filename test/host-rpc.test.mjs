// host 半单测：不启动宿主、不联网、不起子进程。
//
// 跑法（DSH 沙箱里 `node --test` 会 spawn EPERM，必须直接跑文件）：
//     node test/host-rpc.test.mjs
// node:test 在进程内注册，直接跑输出一样，失败仍然非 0 退出。
//
// 覆盖：
//   1. sessions/list：排除 blank、按 updatedAt 倒序、live/running/isSelf/archived/workspaceId
//   2. sessions/send 两条路径：
//        ① sessionController.prompt（默认首选）：入参形状 / requestId 幂等 / 三态错误码透传 /
//           语义拒绝**不得**回退到自研路径
//        ② 自研 agents 路径（R1 来源规则 + R2 所有权判定 + R3 resume 的 agentOptions/setup）
//   3. 投递落盘：ctx.sessions.flush 被调用 + 回读确认；目标在忙时如实标 queued-inbox
//   4. wire 层：信封形状、404/415/400、loopback 信任栅栏、**handler 抛错不得出现 500**
//   5. apply：webServer.register 挂载（prefix 路由）+ ctx.effect 清理、
//      无 webServer 回退 connection.rpc.handle、register 抛错不崩
//   6. 环境解耦：profile / selfSessionId 的 env 兜底可注入（`{ env: {} }`），不读真实进程环境
//
// 环境铁律：DSH 沙箱里 `node --test` 会 spawn EPERM，**必须** `node test/host-rpc.test.mjs` 直接跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  apply,
  buildRelayMessage,
  createSessionTelecom,
  createSessionRegistry,
  deliverToSession,
  detectProfile,
  envSelfSessionId,
  hasSessionSubagentOwner,
  inject,
  messageFactorySource,
  name,
  normalizeDeliveryStrategy,
  relaySourceFor,
  SESSION_TELECOM_ENDPOINTS,
  SESSION_TELECOM_ERROR_CODES,
  SESSION_TELECOM_RPC_CHANNEL,
  useMessageFactory,
} from '../lib/index.js';
import { SESSION_TELECOM_OPAQUE_SOURCE } from '../lib/api.js';
import { attributionLine } from '../lib/deliver.js';
import { endpointFromPath, sessionTelecomFetchHandler, toDisposer } from '../lib/web-rpc.js';
import { fallbackCreateUserMessage } from '../lib/message.js';
import { toWireError } from '../lib/errors.js';

const CHANNEL = SESSION_TELECOM_RPC_CHANNEL;
const ENDPOINTS = SESSION_TELECOM_ENDPOINTS;
const CHANNEL_URL = `http://127.0.0.1:19387${CHANNEL}`;

/**
 * 建 toolkit 的统一入口：**默认 `env: {}`**。
 * 插件在宿主里要读 process.env 兜底（DSH_PROFILE / DSH_SESSION_ID），
 * 但测试进程本身就跑在一个 DSH 会话里（DSH_PROFILE=desktop、DSH_SESSION_ID=session-…），
 * 不隔离的话断言会随"在哪个会话里跑测试"漂移。
 */
function makeToolkit(ctx, options = {}) {
  return createSessionTelecom(ctx, { env: {}, ...options });
}

// ---------------------------------------------------------------- stub 世界

/** 造一个假 Session：只需要 index.js / deliver.js 会碰到的那些成员。
 *  注意 cwd 必须用 null 表示「没有 cwd」——用默认参数会把它变成默认值（踩过一次）。
 *  origin / parentSession 用来构造 subagent 所有权场景（内核 header 字段）。 */
function makeFakeSession({ id, createdAt, cwd = 'D:\\BuyKey\\ws', seq = 1, origin, parentSession }) {
  const header = { version: 4, id, createdAt, isSeeded: false };
  if (typeof cwd === 'string') header.cwd = cwd;
  if (origin !== undefined) header.origin = origin;
  if (parentSession !== undefined) header.parentSession = parentSession;
  return {
    id,
    header,
    seq,
    log: [],
    flushCount: 0,
    append(type, data, options) {
      const event = { seq: this.log.length, time: Date.now(), type, data, ...(options === undefined ? {} : { options }) };
      this.log.push(event);
      this.seq = this.log.length;
      return event;
    },
    snapshotEvents(fromSeq = 0) {
      return this.log.slice(fromSeq);
    },
  };
}

/** 造一个假 Agent：driveOnEnqueue=true 模拟「idle 会话立刻被驱动起来写日志」。 */
function makeFakeAgent(session, { status = 'idle', driveOnEnqueue = false } = {}) {
  const agent = {
    id: session.id,
    session,
    status,
    inbox: { nextTurn: [], nextStep: [] },
    calls: [],
    /**
     * 内核 Agent 接口里的真实方法（dsh-agent-loop/lib/index.js:800-814）：
     *   followup(m) → send(m, 'next-turn', true)
     *   steer(m)    → send(m, 'next-step', true)
     *   inject(m)   → send(m, 'next-step', false)
     * 所以只在 send 里记调用，跟着内核的调用链走，避免重复计数。
     */
    send(message, target, wakeup) {
      agent.calls.push({ method: 'send', target, wakeup, message });
      (target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn).push(message);
      if (wakeup && driveOnEnqueue) agent.commit(message);
    },
    followup(message) {
      agent.send(message, 'next-turn', true);
    },
    steer(message) {
      agent.send(message, 'next-step', true);
    },
    inject(message) {
      agent.send(message, 'next-step', false);
    },
    /** 模拟 agent loop 的 step：把 inbox 的消息 append 成 user/message 事件。 */
    commit(message) {
      session.append('user/message', message, { surfaceOp: 'append' });
    },
  };
  return agent;
}

/**
 * 造一个假 cordis ctx。effect 语义按 cordis 4 的真实行为：ctx.effect(setup) 注册，
 * fiber 卸载时调用 setup 返回的 disposer。
 *
 * 新增可选服务用于三条修复点的验证：
 *   - sessionController：内核投递路径（prompt）的 stub，不传就退回自研 agents 路径；
 *   - agentDefaultModel / agentPresets：R3 组装 resume 的 agentOptions / setup；
 *   - presets + ownedBy：会话的 agentPreset 投影 与 agents.isOwnedBy 所有权关系。
 */
function makeCtx({
  sessions = [],
  agents = [],
  records,
  workspaces = [],
  archived = [],
  titles = {},
  listMetadata = {},
  usage = {},
  pressure = {},
  /** 只用于"发信方存在性"判定的额外会话 id（不必是 live 会话）。 */
  knownSenderIds = [],
  projectionCache,
  desktop = false,
  webServer,
  connection,
  autoFlush = true,
  sessionController,
  agentDefaultModel,
  agentPresets,
  presets = {},
  ownedBy = [],
} = {}) {
  const liveById = new Map(sessions.map((session) => [session.id, session]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  // [childId, parentId] → 让 isOwnedBy(child, parentAgent) 返回 true（内核：store.get(id)?.owner === owner）
  const owners = new Map(ownedBy.map(([childId, parentId]) => [childId, agentById.get(parentId)]));
  const sessionQuery = {
    listCalls: 0,
    async listSessions() {
      sessionQuery.listCalls++;
      return (records ?? sessions.map((session) => ({ header: session.header, live: true, persisted: true })))
        // live 由 sessions 表真实决定，不信 records 里写死的值（stub 的自洽性）
        .map((record) => ({ header: record.header, live: liveById.has(record.header?.id), persisted: record.persisted }));
    },
    async observeSession(sessionId) {
      const known = liveById.get(sessionId)
        ?? (records ?? []).find((record) => record.header?.id === sessionId)
        ?? (knownSenderIds.includes(sessionId) ? { header: { version: 4, id: sessionId, createdAt: 1 } } : undefined);
      if (known === undefined) {
        const error = new Error(`session "${sessionId}" not found`);
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
        throw error;
      }
      const header = known.header ?? known.session?.header;
      // 与内核 presetForObservation 同源：observation.projections.values.agentPreset
      const values = presets[header?.id] === undefined ? {} : { agentPreset: presets[header?.id] };
      return { header, projections: { values } };
    },
    async load(sessionId) {
      return sessionQuery.observeSession(sessionId);
    },
  };

  const ctx = {
    sessions: {
      list: () => [...liveById.values()],
      get: (id) => liveById.get(id),
      async flush(session) {
        session.flushCount++;
        return autoFlush;
      },
      register(id, session) {
        liveById.set(id, session);
        return session;
      },
    },
    agents: {
      get: (id) => agentById.get(id),
      register(agent) {
        agentById.set(agent.id, agent);
        return agent;
      },
      /** 内核实现：dsh-agent/lib/types/index.js:360-362（store.get(id)?.owner === owner） */
      isOwnedBy: (id, owner) => owners.get(id) === owner && owner !== undefined,
      async resume(options) {
        ctx.agents.resumeCalls.push(options);
        const agent = ctx.agents.nextResume;
        if (agent === undefined) {
          const error = new Error(`session "${options.resumeSessionId}" not found`);
          error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
          throw error;
        }
        agentById.set(agent.id, agent);
        return { agent };
      },
      resumeCalls: [],
      nextResume: undefined,
    },
    sessionQuery,
    sessionProjections: {
      cachedSnapshot(session, keys) {
        const values = {};
        if (keys === undefined || keys.includes('title')) values.title = titles[session.id] ?? null;
        if (keys === undefined || keys.includes('sessionListMetadata')) {
          // 与真实投影一致：init 状态就是 blank:true（api-session-controller:1840），
          // 只有出现过 turn/start 才会翻成 false。没给 metadata 的会话＝从没跑过。
          values.sessionListMetadata = listMetadata[session.id] ?? { blank: true, lastPromptAt: null };
        }
        // token-meter 的两个投影（dsh-token-meter/lib/types/usage-projection.js:87 / :121）：
        // 只在调用方真的喂了数据时出现，模拟"token-meter 未装载"的场景。
        if (usage[session.id] !== undefined) values.tokenUsage = usage[session.id];
        if (pressure[session.id] !== undefined) values.contextPressure = pressure[session.id];
        return { asOfSeq: session.seq, values };
      },
    },
    get(name) {
      if (name === 'sessionQuery') return sessionQuery;
      if (name === 'sessionProjectionCache') return projectionCache;
      if (name === 'desktopProfiles') return desktop ? { profiles: [] } : undefined;
      if (name === 'sessionController') return sessionController;
      if (name === 'agentDefaultModel') return agentDefaultModel;
      if (name === 'agentPresets') return agentPresets;
      return undefined;
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effects: [],
    disposers: [],
    effect(callback) {
      ctx.effects.push(callback);
      const disposer = callback();
      ctx.disposers.push(typeof disposer === 'function' ? disposer : () => {});
      return () => {};
    },
  };
  if (webServer !== undefined) ctx.webServer = webServer;
  if (connection !== undefined) ctx.connection = connection;
  ctx.workspaceRegistry = {
    list: () => workspaces,
    archivedSessionIds: archived,
  };
  return ctx;
}

/** 假 sessionController：只记录 prompt 入参，可按需抛错。 */
function makeFakeSessionController({ onPrompt } = {}) {
  const controller = {
    calls: [],
    async prompt(request, signal) {
      controller.calls.push({ request, signal });
      if (typeof onPrompt === 'function') return onPrompt(request, signal);
      return { accepted: true };
    },
  };
  return controller;
}

/** 让 sessionController.prompt 抛一个带内核 code 的 RemoteError 形状错误。 */
function controllerThrowing(code, message) {
  return makeFakeSessionController({
    onPrompt() {
      const error = new Error(message ?? `kernel rejected: ${code}`);
      error.code = code;
      error.details = { reason: 'from-kernel' };
      throw error;
    },
  });
}

/** 直接调 fetch handler，省掉 node:http 桥。body 为 undefined 时不带请求体。 */
function post(handler, endpoint, body, { headers = {}, url } = {}) {
  const target = url ?? `${CHANNEL_URL}/${endpoint}`;
  const init = { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:19387', ...headers } };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return handler.fetch(new Request(target, init));
}

async function envelope(response) {
  assert.equal(response.status, 200, `期望 200，实际 ${response.status}`);
  return response.json();
}

function request(method, url, headers = {}) {
  return new Request(url, { method, headers: { host: '127.0.0.1:19387', ...headers } });
}

// ---------------------------------------------------------------- 契约形状

test('host 插件三件套 + 通道常量', () => {
  assert.equal(name, 'dsh-session-telecom');
  assert.ok(Array.isArray(inject));
  assert.ok(inject.every((item) => typeof item === 'string'));
  assert.ok(inject.includes('agents'));
  assert.ok(inject.includes('sessions'));
  assert.ok(inject.includes('webServer'));
  assert.equal(typeof apply, 'function');
  assert.equal(CHANNEL, '/dsh-session-telecom');
  // 通道名必须满足客户端 assertTarget 的 CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
  // （单段、不含 `/`）。写多段会在浏览器侧直接抛 invalid RPC target，请求发不出去。
  assert.match(CHANNEL, /^\/[A-Za-z0-9._~-]+$/, '通道只能是单段路径');
  assert.deepEqual(Object.values(ENDPOINTS).sort(), ['self/info', 'sessions/list', 'sessions/read', 'sessions/send']);
});

test('endpointFromPath 只认本通道下的合法段', () => {
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/sessions/list`), 'sessions/list');
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/sessions/send`), 'sessions/send');
  assert.equal(endpointFromPath(CHANNEL, CHANNEL), undefined);
  assert.equal(endpointFromPath(CHANNEL, '/api/other/sessions/list'), undefined);
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/../secret`), undefined);
  assert.equal(endpointFromPath(CHANNEL, `${CHANNEL}/a//b`), undefined);
});

test('契约：错误码含内核所有权三态，来源常量与投递策略冻结', () => {
  // 客户端按 code 分支：这两个是内核 RPC 层的所有权/写锁拒绝码，必须原样透传。
  assert.equal(SESSION_TELECOM_ERROR_CODES.agentBusy, 'session/agent-busy');
  assert.equal(SESSION_TELECOM_ERROR_CODES.writerHeld, 'session/writer-held');
  assert.equal(SESSION_TELECOM_ERROR_CODES.sessionNotFound, 'session/not-found');
  assert.equal(SESSION_TELECOM_ERROR_CODES.badRequest, 'bad-request');
  assert.equal(SESSION_TELECOM_ERROR_CODES.internal, 'gateway/internal');
  assert.ok(Object.isFrozen(SESSION_TELECOM_ERROR_CODES));
  assert.deepEqual(SESSION_TELECOM_OPAQUE_SOURCE, { kind: 'user' });
  assert.ok(Object.isFrozen(SESSION_TELECOM_OPAQUE_SOURCE));
  for (const value of ['auto', 'prompt', 'agents']) {
    assert.equal(normalizeDeliveryStrategy(value), value);
  }
  assert.equal(normalizeDeliveryStrategy('nonsense'), 'auto', '未知策略回退 auto');
  assert.equal(normalizeDeliveryStrategy(undefined), 'auto');
});

test('createUserMessage 兜底与内核同形（role/id/content/source 且冻结）', () => {
  const message = buildRelayMessage({ text: 'hi', senderSessionId: 's-sender', factory: fallbackCreateUserMessage });
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0);
  assert.deepEqual(message.content, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 's-sender' });
  assert.ok(Object.isFrozen(message));
  assert.ok(Object.isFrozen(message.source));
  assert.notEqual(buildRelayMessage({ text: 'a' }).id, buildRelayMessage({ text: 'a' }).id);
});

// ---------------------------------------------------------------- R1：来源不得伪造

test('R1：没有发信方时绝不写空 senderSessionId，退回内核合法的 { kind:"user" }', () => {
  // AgentMessageSource 声明 senderSessionId: SessionId（非空），格式校验器直接拒空串
  // （dsh-session-format-v2-to-v3/lib/index.js:132），GUI 的 relaySender() 对空串返回 null
  // 于是降级成 opaque 渲染（dsh-client-ui-chat/lib/client.js:741-744,860）。
  const bare = buildRelayMessage({ text: 'x', factory: fallbackCreateUserMessage });
  assert.deepEqual(bare.source, { kind: 'user' }, '无发信方 → 内核合法的 user 来源');
  assert.equal('senderSessionId' in bare.source, false, 'user 来源里不许出现 senderSessionId 键');
  assert.equal(bare.source.senderSessionId, undefined);

  for (const empty of ['', null, undefined, 0, {}]) {
    assert.deepEqual(
      buildRelayMessage({ text: 'x', senderSessionId: empty, factory: fallbackCreateUserMessage }).source,
      { kind: 'user' },
      `senderSessionId=${JSON.stringify(empty)} 也必须退回 user 来源`,
    );
  }

  const withSender = buildRelayMessage({ text: 'x', senderSessionId: 's-real', factory: fallbackCreateUserMessage });
  assert.deepEqual(withSender.source, { kind: 'agent-message', form: 'relay', senderSessionId: 's-real' });

  // relaySourceFor 是同一个判断的薄封装，逐值对照
  assert.deepEqual(relaySourceFor('s-real'), { kind: 'agent-message', form: 'relay', senderSessionId: 's-real' });
  assert.deepEqual(relaySourceFor(''), { kind: 'user' });
  assert.deepEqual(relaySourceFor(undefined), { kind: 'user' });
  assert.notEqual(relaySourceFor(''), SESSION_TELECOM_OPAQUE_SOURCE, '返回副本，调用方改不脏冻结常量');
});

test('R1：经 RPC 投递时无发信方 → 目标日志里是 { kind:"user" }，且回执如实标注', async () => {
  const target = makeFakeSession({ id: 's-r1', createdAt: 4 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent] });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-r1', text: '匿名投递' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.delivered, true);
  assert.equal(result.value.sourceKind, 'user');
  assert.equal(result.value.senderSessionId, null);
  assert.equal(result.value.senderApplied, false);

  const stored = target.snapshotEvents().find((event) => event.type === 'user/message');
  assert.deepEqual(stored.data.source, { kind: 'user' }, '落盘来源里不能有空 senderSessionId');
});

test('R1：有发信方（且该会话真实存在）时才是 agent-message relay', async () => {
  const target = makeFakeSession({ id: 's-r1b', createdAt: 4 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent], knownSenderIds: ['session-env-sender'] });
  const result = await makeToolkit(ctx, { env: { DSH_SESSION_ID: 'session-env-sender' } })
    .dispatch(ENDPOINTS.send, { targetSessionId: 's-r1b', text: '带身份' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.senderSessionId, 'session-env-sender', '没显式给 sender 时用 DSH_SESSION_ID 兜底');
  assert.equal(result.value.senderApplied, true);
  assert.equal(result.value.sourceKind, 'agent-message');
  const stored = target.snapshotEvents().find((event) => event.type === 'user/message');
  assert.deepEqual(stored.data.source, {
    kind: 'agent-message',
    form: 'relay',
    senderSessionId: 'session-env-sender',
  });
});

test('修 bug：发信方查不到时降级为 { kind:"user" } 并如实回报 senderDropped（消息仍要送达）', async () => {
  const target = makeFakeSession({ id: 's-phantom-sender', createdAt: 4 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  // 注意：这里**故意**不把 'session-ghost' 放进 knownSenderIds，模拟"客户端把宿主环境里的
  // DSH_SESSION_ID 当成当前会话传上来，而那个会话在当前 store 里根本不存在"。
  const ctx = makeCtx({ sessions: [target], agents: [agent] });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, {
    targetSessionId: 's-phantom-sender',
    text: '别把来源算到我头上',
    senderSessionId: 'session-ghost',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.delivered, true, '装饰性字段有问题不该把消息本身丢掉');
  assert.equal(result.value.senderSessionId, null);
  assert.equal(result.value.senderApplied, false);
  assert.equal(result.value.sourceKind, 'user');
  assert.deepEqual(result.value.senderDropped, { requested: 'session-ghost', reason: 'unknown-session' });
  const stored = target.snapshotEvents().find((event) => event.type === 'user/message');
  assert.deepEqual(stored.data.source, { kind: 'user' }, '目标端不许出现伪造的 relay 标记');
});

test('修 bug：senderDropped 只在真的发生降级时出现（不产生"值为 undefined 的键"）', async () => {
  const target = makeFakeSession({ id: 's-no-drop', createdAt: 4 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent] });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-no-drop', text: 'hi' });
  assert.equal(result.ok, true);
  assert.equal('senderDropped' in result.value, false);
  assert.equal(JSON.stringify(result).includes('undefined'), false, '回执必须是 lossless JSON');
});

test('toWireError 对任意抛出物都给出 {code,message,details}，且 details 永远可序列化', () => {
  assert.deepEqual(toWireError(new Error('boom')), {
    code: 'gateway/internal',
    message: 'boom',
    details: { name: 'Error' },
  });
  const coded = new Error('nope');
  coded.code = 'session/not-found';
  assert.equal(toWireError(coded).code, 'session/not-found');
  assert.deepEqual(toWireError('plain string'), { code: 'gateway/internal', message: 'plain string', details: {} });

  const circular = {};
  circular.self = circular;
  const withCircular = Object.assign(new Error('x'), { details: circular });
  const wire = toWireError(withCircular);
  assert.equal(wire.code, 'gateway/internal');
  assert.doesNotThrow(() => JSON.stringify(wire));
  assert.deepEqual(wire.details, { name: 'Error' }, '坏的 details 丢掉，但 name 兜底仍要在');
});

// ---------------------------------------------------------------- sessions/list

test('sessions/list：排除 blank、按 updatedAt 倒序、标 live/running/isSelf/archived/workspaceId', async () => {
  const blankSession = makeFakeSession({ id: 's-blank', createdAt: 5 });
  const older = makeFakeSession({ id: 's-older', createdAt: 100, cwd: 'D:\\BuyKey\\ws' });
  const newer = makeFakeSession({ id: 's-newer', createdAt: 200, cwd: 'D:\\BuyKey\\other' });
  const cold = makeFakeSession({ id: 's-cold', createdAt: 300, cwd: 'D:\\BuyKey\\ws' });
  const detached = makeFakeSession({ id: 's-detached', createdAt: 1, cwd: null });

  const ctx = makeCtx({
    sessions: [blankSession, older, newer],
    agents: [
      makeFakeAgent(blankSession),
      makeFakeAgent(older, { status: 'running' }),
      makeFakeAgent(newer, { status: 'idle' }),
    ],
    workspaces: [
      { id: 'ws-a', path: 'D:\\BuyKey\\ws' },
      { id: 'ws-b', path: 'D:\\BuyKey\\other' },
    ],
    archived: ['s-older'],
    titles: { 's-older': '旧会话', 's-newer': '新会话' },
    listMetadata: {
      's-blank': { blank: true, lastPromptAt: null },
      's-older': { blank: false, lastPromptAt: 50 },
      's-newer': { blank: false, lastPromptAt: 400 },
    },
    records: [
      { header: blankSession.header, live: true, persisted: true },
      { header: older.header, live: true, persisted: true },
      { header: newer.header, live: true, persisted: true },
      { header: cold.header, live: false, persisted: true },
      { header: detached.header, live: false, persisted: true },
    ],
  });
  const toolkit = makeToolkit(ctx, { selfSessionId: 's-newer' });
  const result = await toolkit.dispatch(ENDPOINTS.list, {});
  assert.equal(result.ok, true);

  const ids = result.value.sessions.map((row) => row.id);
  assert.ok(!ids.includes('s-blank'), 'blank 行必须被排除');
  assert.ok(!ids.includes('s-detached'), '没有 cwd 的**冷**行必须被排除（对齐内核 list）');
  assert.deepEqual(ids, ['s-newer', 's-cold', 's-older'], '必须按 updatedAt 倒序');
  assert.equal(result.value.selfSessionId, 's-newer');

  assert.deepEqual(result.value.sessions[0], {
    id: 's-newer',
    title: '新会话',
    updatedAt: 400,
    cwd: newer.header.cwd,
    lastEventAt: 0,
    lastAssistantAt: 0,
    lastUserAt: 0,
    lastAssistantPreview: '',
    workspaceId: 'ws-b',
    archived: false,
    blank: false,
    live: true,
    running: false,
    isSelf: true,
    // 花费字段是**恒定存在的增量字段**：token-meter 没数据时全为 null（客户端据此隐藏列）。
    tokens: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheHitRate: null,
    billableTokens: null,
    contextTokens: null,
    contextWindow: null,
    contextLoad: null,
  });

  const coldRow = result.value.sessions[1];
  assert.equal(coldRow.live, false, '不在 ctx.sessions 里的行 live=false');
  assert.equal(coldRow.running, false);
  assert.equal(coldRow.workspaceId, 'ws-a');
  assert.equal(coldRow.title, '', '没有 title 投影时给空串而不是 null');
  assert.equal(coldRow.updatedAt, 300);

  const olderRow = result.value.sessions[2];
  assert.equal(olderRow.archived, true);
  assert.equal(olderRow.running, true);
  assert.equal(olderRow.updatedAt, 100, 'lastPromptAt 比 createdAt 小时取 createdAt');
});

test('花费投影：tokenUsage / contextPressure → tokens/billableTokens/cacheHitRate/contextLoad', async () => {
  const rich = makeFakeSession({ id: 's-cost-rich', createdAt: 60 });
  const bare = makeFakeSession({ id: 's-cost-bare', createdAt: 50 });
  const ctx = makeCtx({
    sessions: [rich, bare],
    agents: [makeFakeAgent(rich), makeFakeAgent(bare)],
    listMetadata: {
      's-cost-rich': { blank: false, lastPromptAt: 60 },
      's-cost-bare': { blank: false, lastPromptAt: 50 },
    },
    // 照内核 schema：tokenUsage = { totals: {uncachedInput,output,cacheRead,cacheWrite}, last }
    usage: {
      's-cost-rich': {
        totals: { uncachedInputTokens: 1000, outputTokens: 400, cacheReadTokens: 3000, cacheWriteTokens: 100 },
        last: null,
      },
    },
    // contextPressure：压力优先于预测值
    pressure: {
      's-cost-rich': { pressureTokens: 50000, projectedTokens: 60000, contextWindow: 200000, surfaceTokens: 1, claim: undefined },
    },
  });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.list, {});
  assert.equal(result.ok, true);
  const row = result.value.sessions.find((item) => item.id === 's-cost-rich');
  assert.equal(row.tokens, 4500, '全部输入(1000+3000+100) + 输出(400)');
  assert.equal(row.inputTokens, 4100);
  assert.equal(row.outputTokens, 400);
  assert.equal(row.billableTokens, 1400, '只有非缓存输入 + 输出按全价计费');
  assert.equal(row.cacheHitRate, 0.75, '3000 cacheRead / (1000 uncached + 3000 cacheRead)');
  assert.equal(row.contextTokens, 50000, 'pressureTokens 优先于 projectedTokens');
  assert.equal(row.contextWindow, 200000);
  assert.equal(row.contextLoad, 0.25);

  // token-meter 缺席的会话：字段恒定存在但全为 null（客户端据此隐藏花费列）
  const missing = result.value.sessions.find((item) => item.id === 's-cost-bare');
  assert.equal(missing.tokens, null);
  assert.equal(missing.cacheHitRate, null);
  assert.equal(missing.contextLoad, null);

  // 汇总只统计"有花费数据"的行，缓存命中率按总量重算（不是各行平均）
  assert.equal(result.value.costTotals.tokens, 4500);
  assert.equal(result.value.costTotals.billableTokens, 1400);
  assert.equal(result.value.costTotals.cacheHitRate, 0.75);
  assert.equal(result.value.costTotals.sessionsWithUsage, 1);
});

test('花费投影：脏数据（负数 / NaN / 字符串）不会污染清单，也不抛', async () => {
  const dirty = makeFakeSession({ id: 's-cost-dirty', createdAt: 40 });
  const ctx = makeCtx({
    sessions: [dirty],
    agents: [makeFakeAgent(dirty)],
    listMetadata: { 's-cost-dirty': { blank: false, lastPromptAt: 40 } },
    usage: {
      's-cost-dirty': {
        totals: { uncachedInputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: '很多', cacheWriteTokens: 7 },
        last: null,
      },
    },
    pressure: { 's-cost-dirty': { pressureTokens: -1, projectedTokens: 123, contextWindow: 0 } },
  });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.list, {});
  assert.equal(result.ok, true);
  const row = result.value.sessions[0];
  assert.equal(row.tokens, 7, '非法值全被丢弃，只剩 cacheWrite=7（tokens 只统计输入+输出，不含上下文压力）');
  assert.equal(row.billableTokens, 0);
  assert.equal(row.cacheHitRate, null, '分母为 0 时不给比率，而不是 NaN');
  assert.equal(row.contextTokens, 123, 'pressureTokens 非法时退回 projectedTokens');
  assert.equal(row.contextWindow, null, 'contextWindow=0 视为未知');
  assert.equal(row.contextLoad, null);
});

test('署名：attributionLine 认得出就写 id，认不出就写"未知会话"（不编造也不沉默）', () => {
  assert.equal(attributionLine('session-abc'), '[由 session-abc 发送]\n');
  assert.equal(attributionLine(null), '[由 未知会话 发送]\n');
  assert.equal(attributionLine(''), '[由 未知会话 发送]\n');
});

test('署名：投递层默认给正文加一行署名，且 senderPrefix:false 时不加', async () => {
  const target = makeFakeSession({ id: 's-attr', createdAt: 12 });
  const ctx = makeCtx({ sessions: [target], agents: [makeFakeAgent(target, { driveOnEnqueue: true })], knownSenderIds: ['s-sender-x'] });

  // 默认（署名开）
  const withPrefix = await makeToolkit(ctx).dispatch(ENDPOINTS.send, {
    targetSessionId: 's-attr',
    text: '帮我看看这个',
    senderSessionId: 's-sender-x',
  });
  assert.equal(withPrefix.ok, true, JSON.stringify(withPrefix));
  const first = target.snapshotEvents().filter((event) => event.type === 'user/message').at(-1);
  assert.match(String(first.data.content?.[0]?.text ?? ''), /^\[由 s-sender-x 发送\]\n/, '署名必须在正文之前');
  assert.match(String(first.data.content?.[0]?.text ?? ''), /帮我看看这个/);

  // 显式关掉
  const withoutPrefix = await makeToolkit(ctx).dispatch(ENDPOINTS.send, {
    targetSessionId: 's-attr',
    text: '不带署名',
    senderSessionId: 's-sender-x',
    senderPrefix: false,
  });
  assert.equal(withoutPrefix.ok, true);
  const second = target.snapshotEvents().filter((event) => event.type === 'user/message').at(-1);
  assert.equal(second.data.content?.[0]?.text, '不带署名', 'senderPrefix:false 时必须原样投递');

  // 认不出发信方时也署名，但写"未知会话"
  const anonymous = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-attr', text: '我不知道我是谁' });
  assert.equal(anonymous.ok, true);
  const third = target.snapshotEvents().filter((event) => event.type === 'user/message').at(-1);
  assert.match(String(third.data.content?.[0]?.text ?? ''), /^\[由 未知会话 发送\]\n/);
});

test('sessions/list：没有 cwd 但 live 的行要留下（内核只丢冷行）', async () => {
  const liveNoCwd = makeFakeSession({ id: 's-live-nocwd', createdAt: 8, cwd: null });
  const ctx = makeCtx({
    sessions: [liveNoCwd],
    agents: [makeFakeAgent(liveNoCwd)],
    listMetadata: { 's-live-nocwd': { blank: false, lastPromptAt: null } },
  });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.list, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.sessions.map((row) => row.id), ['s-live-nocwd']);
  assert.equal(result.value.sessions[0].workspaceId, null);
});

test('sessions/list 的边界：sessionQuery 抛错时退回 live 列表；无 sessions 服务回空', async () => {
  const session = makeFakeSession({ id: 's-live', createdAt: 7 });
  const ctx = makeCtx({
    sessions: [session],
    agents: [makeFakeAgent(session)],
    listMetadata: { 's-live': { blank: false, lastPromptAt: null } },
  });
  ctx.sessionQuery.listSessions = async () => {
    throw new Error('persistence exploded');
  };
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.list, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.sessions.map((row) => row.id), ['s-live'], '降级后仍要给出 live 行');
  assert.equal(result.value.selfSessionId, null, '认不出当前会话就老实给 null');

  const bare = createSessionRegistry({}, {});
  // 没有 sessions 时：空清单 + 没有花费数据（`costTotals` 是恒定字段，token-meter 缺席时全 null）
  assert.deepEqual(await bare.list(), {
    sessions: [],
    selfSessionId: null,
    costTotals: {
      tokens: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cacheHitRate: null,
      billableTokens: null,
      contextTokens: null,
      contextWindow: null,
      contextLoad: null,
    },
  });
});

test('sessions/list 遇到坏记录不会整条通道炸掉', async () => {
  const good = makeFakeSession({ id: 's-good', createdAt: 9 });
  const ctx = makeCtx({
    sessions: [good],
    agents: [makeFakeAgent(good)],
    listMetadata: { 's-good': { blank: false, lastPromptAt: null } },
    records: [
      { header: null, live: false, persisted: true },
      { header: { id: '' }, live: false, persisted: true },
      { header: good.header, live: true, persisted: true },
    ],
  });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.list, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.sessions.map((row) => row.id), ['s-good']);
});

// ---------------------------------------------------------------- sessions/send

test('sessions/send：live 目标走 agent.followup，flush 落盘并回读确认 seq', async () => {
  const target = makeFakeSession({ id: 's-target', createdAt: 10 });
  const agent = makeFakeAgent(target, { status: 'idle', driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent], knownSenderIds: ['s-sender'] });
  const toolkit = makeToolkit(ctx, { selfSessionId: 's-self' });

  const result = await toolkit.dispatch(ENDPOINTS.send, {
    targetSessionId: 's-target',
    text: '  来自另一个会话  ',
    senderSessionId: 's-sender',
    mode: 'queue',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.delivered, true);
  assert.equal(result.value.targetSessionId, 's-target');
  assert.equal(result.value.mode, 'queue');
  assert.equal(result.value.live, true);
  assert.equal(typeof result.value.messageId, 'string');
  assert.equal(result.value.senderSessionId, 's-sender');
  assert.equal(result.value.persisted, true, '日志里回读到才能说落盘');
  assert.equal(typeof result.value.seq, 'number');
  assert.equal(result.value.persistence, 'session-log');

  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].method, 'send', 'queue 模式必须走内核 agent.followup → send');
  assert.equal(agent.calls[0].target, 'next-turn');
  assert.equal(agent.calls[0].wakeup, true);
  assert.equal(agent.inbox.nextTurn.length, 1);
  const message = agent.calls[0].message;
  assert.equal(message.id, result.value.messageId);
  // 文本先 trim，再由投递层加上署名行（署名在正文之前；发信方是 s-sender）
  assert.deepEqual(message.content, [{ type: 'text', text: '[由 s-sender 发送]\n来自另一个会话' }], 'trim 后加署名');
  assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 's-sender' });
  assert.equal(target.flushCount, 1, '必须调 ctx.sessions.flush 落盘');

  const stored = target.snapshotEvents().find((event) => event.type === 'user/message');
  assert.equal(stored.data.source.kind, 'agent-message');
  assert.equal(stored.data.source.senderSessionId, 's-sender');
});

test('sessions/send：认得到落盘层时以落盘层为准（persistence → session-persistence）', async () => {
  const target = makeFakeSession({ id: 's-persist', createdAt: 10 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent] });
  ctx.sessionPersistence = {
    async load(id) {
      return { header: target.header, events: target.snapshotEvents().map((event) => structuredClone(event)) };
    },
  };
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-persist', text: 'hi' });
  assert.equal(result.ok, true);
  assert.equal(result.value.persisted, true);
  assert.equal(result.value.persistence, 'session-persistence', '能读到盘就用盘上的证据');
});

test('sessions/send：mode=steer 走 agent.steer（进 next-step），默认 mode 是 queue', async () => {
  const target = makeFakeSession({ id: 's-busy', createdAt: 10 });
  const agent = makeFakeAgent(target, { status: 'running' });
  const ctx = makeCtx({ sessions: [target], agents: [agent] });
  const toolkit = makeToolkit(ctx);

  const steered = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-busy', text: '插队', mode: 'steer' });
  assert.equal(steered.ok, true, JSON.stringify(steered));
  assert.equal(steered.value.mode, 'steer');
  assert.equal(agent.calls[0].method, 'send');
  assert.equal(agent.calls[0].target, 'next-step', 'steer 必须走 next-step（内核 steer → send(m,"next-step",true)）');
  assert.equal(agent.calls[0].wakeup, true);
  // 目标在忙 → 消息还在 inbox 排队，此刻日志里本来就没有它（内核只在 step 开始时才 append）
  assert.equal(steered.value.persisted, false);
  assert.equal(steered.value.queuedInInbox, true);
  assert.equal(steered.value.persistence, 'queued-inbox');
  assert.equal(typeof steered.value.seq, 'undefined', '没进日志就不该编一个 seq');
  assert.equal(target.flushCount, 1, '即使还没进日志也要过一遍 flush 屏障');
  assert.equal(agent.inbox.nextStep.length, 1);

  const defaulted = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-busy', text: '默认模式' });
  assert.equal(defaulted.value.mode, 'queue');
  const weird = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-busy', text: '怪模式', mode: 'nonsense' });
  assert.equal(weird.value.mode, 'queue', '未知 mode 回退 queue 而不是报错');
});

test('sessions/send：冷会话走 ctx.agents.resume 唤醒后投递（R3：带 agentOptions 与 setup）', async () => {
  const cold = makeFakeSession({ id: 's-cold', createdAt: 20 });
  const mounted = [];
  // R3：冷会话的 preset 只能从 observation 投影里读（内核 presetForObservation 同源）
  const presets = { 's-cold': 'preset-cold' };
  const presetRegistry = {
    resolved: [],
    async resolve(id) {
      presetRegistry.resolved.push(id);
      return { id: id ?? 'preset-default' };
    },
    async mount(agentCtx, id) {
      mounted.push({ agentCtx, id });
      return { id };
    },
  };
  const ctx = makeCtx({
    sessions: [],
    agents: [],
    records: [{ header: cold.header, live: false, persisted: true }],
    presets,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'low' }) },
    agentPresets: presetRegistry,
  });
  const revived = makeFakeAgent(cold, { status: 'idle', driveOnEnqueue: true });
  ctx.agents.nextResume = revived;

  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-cold', text: '唤醒你' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.delivered, true);
  assert.equal(ctx.agents.resumeCalls.length, 1, '冷会话必须用 resume 唤醒');
  const resumeArgs = ctx.agents.resumeCalls[0];
  assert.equal(resumeArgs.resumeSessionId, 's-cold');
  assert.deepEqual(resumeArgs.agentOptions, { provider: 'deepseek', model: 'deepseek-flash' },
    'R3：agentOptions 必须带部署默认 provider/model（内核 types/agent.js:450）');
  assert.equal(typeof resumeArgs.setup, 'function', 'R3：setup 必须存在，否则冷会话丢 agent preset');
  // setup 的真实调用形状由内核固定：dsh-agent-loop/lib/index.js:1888 setup(prepared.agent.ctx, prepared.agent)
  const agentCtx = { name: 'fake-agent-ctx' };
  await resumeArgs.setup(agentCtx, revived);
  assert.deepEqual(mounted, [{ agentCtx, id: 'preset-cold' }], 'setup 必须挂上该会话自己的 preset');
  assert.deepEqual(presetRegistry.resolved, ['preset-cold']);

  assert.equal(revived.calls[0].method, 'send');
  assert.equal(revived.calls[0].target, 'next-turn');
  assert.equal(result.value.persisted, true);
  assert.equal(result.value.live, false, '投递前目标是冷的（客户端据此提示"已唤醒"，见 client/index.jsx:883）');
  assert.equal(result.value.resumed, true, 'resumed 才说明是本插件亲手唤醒的');
  assert.equal(cold.flushCount, 1);
});

test('R3：preset 解析不出来时 setup 退到默认 preset，而不是不传 setup', async () => {
  const cold = makeFakeSession({ id: 's-cold-nopreset', createdAt: 20 });
  const mounted = [];
  const ctx = makeCtx({
    sessions: [],
    agents: [],
    records: [{ header: cold.header, live: false, persisted: true }],
    agentPresets: {
      async resolve(id) {
        return { id: id ?? 'preset-default' };
      },
      async mount(_agentCtx, id) {
        mounted.push(id);
      },
    },
  });
  ctx.agents.nextResume = makeFakeAgent(cold, { driveOnEnqueue: true });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-cold-nopreset', text: 'hi' });
  assert.equal(result.ok, true, JSON.stringify(result));
  await ctx.agents.resumeCalls[0].setup({}, undefined);
  assert.deepEqual(mounted, ['preset-default']);
});

test('R3：没有 agentDefaultModel / agentPresets 服务时，resume 仍要能跑（不传不该传的）', async () => {
  const cold = makeFakeSession({ id: 's-cold-bare', createdAt: 20 });
  const ctx = makeCtx({
    sessions: [],
    agents: [],
    records: [{ header: cold.header, live: false, persisted: true }],
  });
  ctx.agents.nextResume = makeFakeAgent(cold, { driveOnEnqueue: true });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-cold-bare', text: 'hi' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const args = ctx.agents.resumeCalls[0];
  assert.deepEqual(Object.keys(args), ['resumeSessionId'], '没有可用线索就不伪造 agentOptions/setup');
  assert.equal(cold.flushCount, 1);
});

test('sessions/send：目标不存在 → ok:false + session/not-found，且绝不 resume 一个不存在的 id', async () => {
  const ctx = makeCtx({ sessions: [], agents: [], records: [] });
  ctx.agents.nextResume = makeFakeAgent(makeFakeSession({ id: 's-ghost', createdAt: 1 }));
  const toolkit = makeToolkit(ctx);

  const result = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-ghost', text: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'session/not-found');
  assert.match(result.error.message, /s-ghost/);
  assert.deepEqual(ctx.agents.resumeCalls, [], '不存在的会话不许 resume（会凭空造会话）');
});

test('sessions/send：空文本 / 缺 targetSessionId → bad-request；resume 失败如实上报', async () => {
  const target = makeFakeSession({ id: 's-t', createdAt: 1 });
  const ctx = makeCtx({ sessions: [target], agents: [makeFakeAgent(target)] });
  const toolkit = makeToolkit(ctx);

  for (const payload of [
    { targetSessionId: 's-t', text: '' },
    { targetSessionId: 's-t', text: '   \n\t ' },
    { targetSessionId: 's-t' },
    { targetSessionId: 's-t', text: 42 },
    { targetSessionId: '   ', text: 'hi' },
    { text: 'hi' },
  ]) {
    const result = await toolkit.dispatch(ENDPOINTS.send, payload);
    assert.equal(result.ok, false, `payload ${JSON.stringify(payload)} 应当被拒`);
    assert.equal(result.error.code, 'bad-request');
  }

  const coldCtx = makeCtx({
    sessions: [],
    agents: [],
    records: [{ header: makeFakeSession({ id: 's-locked', createdAt: 1 }).header, live: false, persisted: true }],
  });
  coldCtx.agents.resume = async () => {
    throw new Error('session is owned by another process');
  };
  const failed = await makeToolkit(coldCtx).dispatch(ENDPOINTS.send, { targetSessionId: 's-locked', text: 'hi' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'gateway/internal');
  assert.match(failed.error.message, /another process/);
});

test('sessions/send：flush 失败时如实报 gateway/internal，不假装成功', async () => {
  const target = makeFakeSession({ id: 's-fail-flush', createdAt: 1 });
  const ctx = makeCtx({ sessions: [target], agents: [makeFakeAgent(target)] });
  const toolkit = makeToolkit(ctx, {
    flush: async () => {
      throw new Error('disk full');
    },
  });
  const result = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-fail-flush', text: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'gateway/internal');
  assert.match(result.error.message, /disk full/);
});

test('sessions/send：没有 agent 服务时给结构化错误而不是崩', async () => {
  const ctx = { sessions: { get: () => undefined, list: () => [] }, get: () => undefined };
  const seen = [];
  const result = await makeToolkit(ctx, {
    logger: { info() {}, warn: (...args) => seen.push(args), error: (...args) => seen.push(args) },
  }).dispatch(ENDPOINTS.send, { targetSessionId: 's-x', text: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'gateway/internal');
  assert.equal(seen.length, 1, '降级路径要留一条日志，但不能用 console 噪声污染测试输出');
});

test('deliverToSession 的薄 API 直接可用（Lead e2e 走这条路）', async () => {
  const target = makeFakeSession({ id: 's-direct', createdAt: 3 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent] });
  const value = await deliverToSession(ctx, { targetSessionId: 's-direct', text: '直接调用', senderSessionId: 's-x' });
  assert.equal(value.delivered, true);
  assert.equal(value.persisted, true);
  assert.equal(agent.calls[0].method, 'send');
  assert.equal(agent.calls[0].target, 'next-turn');
});

// ---------------------------------------------------------------- R2：所有权策略 + 内核 RPC 路径

test('R2：有 sessionController 时首选 sessionController.prompt（不碰 agents 的 inbox）', async () => {
  const target = makeFakeSession({ id: 's-live', createdAt: 30 });
  const agent = makeFakeAgent(target, { status: 'running' });
  const controller = makeFakeSessionController({
    // 内核 prompt 的回读路径需要 session 在场：这里模拟内核"已接受"
    onPrompt() {
      return { accepted: true };
    },
  });
  const ctx = makeCtx({ sessions: [target], agents: [agent], sessionController: controller, knownSenderIds: ['s-sender'] });

  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, {
    targetSessionId: 's-live',
    text: '  走内核  ',
    senderSessionId: 's-sender',
    mode: 'steer',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.delivered, true);
  assert.equal(result.value.delivery, 'session-controller');
  assert.equal(result.value.mode, 'steer');
  assert.equal(result.value.targetSessionId, 's-live');
  assert.equal(result.value.live, true);
  assert.equal(result.value.resumed, false);

  assert.equal(controller.calls.length, 1);
  const { request, signal } = controller.calls[0];
  // 内核 SessionPromptRequest 形状：api-session-controller/lib/typert.host.js:2237
  assert.deepEqual(request, {
    requestId: request.requestId,
    sessionId: 's-live',
    mode: 'steer',
    content: [{ type: 'text', text: '[由 s-sender 发送]\n走内核' }],
  });
  assert.equal(typeof request.requestId, 'string');
  assert.ok(request.requestId.length > 0);
  assert.match(request.requestId, /^toolkit-/);
  assert.equal(typeof signal?.throwIfAborted, 'function', '内核 prompt 第一行就是 signal.throwIfAborted()');
  assert.equal(signal.aborted, false);

  // 关键：自研路径完全没被碰过（不是"投了两遍"）
  assert.deepEqual(agent.calls, []);
  assert.equal(agent.inbox.nextStep.length, 0);
  assert.deepEqual(ctx.agents.resumeCalls, []);

  // 回执形状仍满足冻结契约
  for (const key of ['delivered', 'targetSessionId', 'mode', 'live', 'messageId']) {
    assert.ok(key in result.value, `回执必须含 ${key}`);
  }
  assert.equal(typeof result.value.messageId, 'string');
});

test('R2：冷目标走 prompt 时由内核自己 resume（插件不自己调 agents.resume）', async () => {
  const cold = makeFakeSession({ id: 's-cold-ctl', createdAt: 31 });
  const controller = makeFakeSessionController();
  const ctx = makeCtx({
    sessions: [],
    agents: [],
    records: [{ header: cold.header, live: false, persisted: true }],
    sessionController: controller,
  });
  ctx.agents.nextResume = makeFakeAgent(cold, { driveOnEnqueue: true });

  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-cold-ctl', text: 'hi' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.live, false, '投递前是冷的');
  assert.equal(result.value.resumed, true);
  assert.deepEqual(ctx.agents.resumeCalls, [], '内核 prompt → resolveAgent 自己负责 resume');
  assert.equal(controller.calls[0].request.sessionId, 's-cold-ctl');
});

test('R2：内核三态错误码（agent-busy / writer-held / not-found）逐字透传，且不回退自研路径', async () => {
  for (const [code, assertion] of [
    ['session/agent-busy', (result) => {
      assert.equal(result.error.code, 'session/agent-busy');
      assert.equal(result.error.details.reason, 'from-kernel', 'RemoteError.details 要带过 wire');
    }],
    ['session/writer-held', (result) => {
      assert.equal(result.error.code, 'session/writer-held');
    }],
    ['session/not-found', (result) => {
      assert.equal(result.error.code, 'session/not-found');
      assert.match(result.error.message, /s-owned/);
    }],
  ]) {
    const target = makeFakeSession({ id: 's-owned', createdAt: 32 });
    const agent = makeFakeAgent(target, { driveOnEnqueue: true });
    const ctx = makeCtx({
      sessions: [target],
      agents: [agent],
      sessionController: controllerThrowing(code),
    });
    const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-owned', text: 'hi' });
    assert.equal(result.ok, false, `${code} 必须失败`);
    assertion(result);
    // 关键：语义拒绝绝不许"绕过去再投一次"——那正是审计 R2 要防的
    assert.deepEqual(agent.calls, [], `${code} 之后不许再走自研路径投递`);
    assert.equal(target.flushCount, 0);
  }
});

test('R2：prompt 抛 AbortError → cancelled（不是 gateway/internal）', async () => {
  const controller = makeFakeSessionController({
    onPrompt() {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  const target = makeFakeSession({ id: 's-abort', createdAt: 33 });
  const ctx = makeCtx({ sessions: [target], agents: [makeFakeAgent(target)], sessionController: controller });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-abort', text: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'cancelled');
});

test('R2：requestId 幂等键 —— 调用方给了就照用，没给就每次现生成', async () => {
  const target = makeFakeSession({ id: 's-idem', createdAt: 34 });
  const controller = makeFakeSessionController();
  const ctx = makeCtx({ sessions: [target], agents: [makeFakeAgent(target)], sessionController: controller });
  const toolkit = makeToolkit(ctx);

  await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-idem', text: 'first', requestId: 'rpc-fixed' });
  await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-idem', text: 'first', requestId: 'rpc-fixed' });
  await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-idem', text: 'second' });
  await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-idem', text: 'third' });

  const ids = controller.calls.map((call) => call.request.requestId);
  assert.deepEqual(ids.slice(0, 2), ['rpc-fixed', 'rpc-fixed'], '重试必须落在同一个幂等键上');
  assert.notEqual(ids[2], ids[3], '没给 requestId 时每次都要新生成');
  assert.equal(new Set(ids).size, 3);
});

test('投递策略：delivery:"agents" 强制自研路径；"prompt" 缺少 sessionController 时报结构化错误', async () => {
  const target = makeFakeSession({ id: 's-strategy', createdAt: 35 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const controller = makeFakeSessionController();
  const ctx = makeCtx({ sessions: [target], agents: [agent], sessionController: controller, knownSenderIds: ['s-x', 's-sender'] });
  const toolkit = makeToolkit(ctx, { delivery: 'agents' });

  const forced = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-strategy', text: 'relay 语义', senderSessionId: 's-x' });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.value.delivery, 'agents');
  assert.equal(forced.value.sourceKind, 'agent-message');
  assert.deepEqual(controller.calls, [], 'agents 策略下不该碰 sessionController');
  assert.equal(agent.calls[0].target, 'next-turn');

  const noController = await makeToolkit(makeCtx({ sessions: [target], agents: [agent] }), { delivery: 'prompt' })
    .dispatch(ENDPOINTS.send, { targetSessionId: 's-strategy', text: 'hi' });
  assert.equal(noController.ok, false);
  assert.equal(noController.error.code, 'gateway/internal');
  assert.match(noController.error.message, /sessionController is unavailable/);

  // payload 里的 delivery 也能覆写（契约外的附加字段，默认 auto）
  const viaPayload = await makeToolkit(ctx).dispatch(ENDPOINTS.send, {
    targetSessionId: 's-strategy', text: 'payload 覆写', delivery: 'agents',
  });
  assert.equal(viaPayload.value.delivery, 'agents');

  const auto = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-strategy', text: '默认 auto' });
  assert.equal(auto.value.delivery, 'session-controller', 'auto 在 sessionController 可用时走内核路径');
});

test('投递策略：sessionController 存在但没有 prompt 方法 → 自动降级自研路径', async () => {
  const target = makeFakeSession({ id: 's-noprompt', createdAt: 36 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent], sessionController: { notPrompt: true } });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, { targetSessionId: 's-noprompt', text: 'hi' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.delivery, 'agents');
  assert.equal(agent.calls.length, 1);
});

test('R2：自研路径对 subagent/teammate 会话必须拒收（session/agent-busy），不打断它的续聊', async () => {
  // ① live 的 subagent 子会话（header.origin === 'subagent'）——内核判定第一分支
  const child = makeFakeSession({ id: 's-child', createdAt: 40, origin: 'subagent', parentSession: 's-parent' });
  const childAgent = makeFakeAgent(child, { status: 'running' });
  const ctxLive = makeCtx({ sessions: [child], agents: [childAgent] });
  const liveResult = await makeToolkit(ctxLive).dispatch(ENDPOINTS.send, { targetSessionId: 's-child', text: 'hi' });
  assert.equal(liveResult.ok, false);
  assert.equal(liveResult.error.code, 'session/agent-busy');
  assert.equal(liveResult.error.details.reason, 'use subagent delivery for this child session');
  assert.deepEqual(childAgent.calls, [], '被拒的会话不许收到任何 inbox 消息');

  // ② live 子会话没有 origin 标记，但仍由活父 agent 拥有（agents.isOwnedBy 为真）
  const owned = makeFakeSession({ id: 's-owned-child', createdAt: 41, parentSession: 's-owner' });
  const parent = makeFakeSession({ id: 's-owner', createdAt: 1 });
  const ownedAgent = makeFakeAgent(owned);
  const parentAgent = makeFakeAgent(parent);
  const ctxOwned = makeCtx({
    sessions: [owned, parent],
    agents: [ownedAgent, parentAgent],
    ownedBy: [['s-owned-child', 's-owner']],
  });
  const ownedResult = await makeToolkit(ctxOwned).dispatch(ENDPOINTS.send, { targetSessionId: 's-owned-child', text: 'hi' });
  assert.equal(ownedResult.ok, false);
  assert.equal(ownedResult.error.code, 'session/agent-busy');
  assert.deepEqual(ownedAgent.calls, []);

  // ③ 同一个 header，但父 agent 不 live（内核判定返回 false）→ 允许投递
  const ctxOrphan = makeCtx({ sessions: [owned], agents: [ownedAgent] });
  const orphanResult = await makeToolkit(ctxOrphan).dispatch(ENDPOINTS.send, { targetSessionId: 's-owned-child', text: 'hi' });
  assert.equal(orphanResult.ok, true, '父不 live 时 isOwnedBy 判定为假（照抄内核语义）');

  // ④ 冷 subagent 会话：连 resume 都不许发生
  const coldChild = makeFakeSession({ id: 's-cold-child', createdAt: 42, origin: 'subagent', parentSession: 's-parent' });
  const ctxCold = makeCtx({
    sessions: [],
    agents: [],
    records: [{ header: coldChild.header, live: false, persisted: true }],
  });
  ctxCold.agents.nextResume = makeFakeAgent(coldChild, { driveOnEnqueue: true });
  const coldResult = await makeToolkit(ctxCold).dispatch(ENDPOINTS.send, { targetSessionId: 's-cold-child', text: 'hi' });
  assert.equal(coldResult.ok, false);
  assert.equal(coldResult.error.code, 'session/agent-busy');
  assert.deepEqual(ctxCold.agents.resumeCalls, [], '不许把 subagent 会话当普通根会话 resume（会撞 id 注册、打断续聊）');
});

test('R2 判据本身：hasSessionSubagentOwner 逐字对齐内核（types/agent.js:106-114）', () => {
  const parent = makeFakeSession({ id: 'p' });
  const child = makeFakeSession({ id: 'c', parentSession: 'p' });
  const parentAgent = makeFakeAgent(parent);
  const childAgent = makeFakeAgent(child);
  const ctx = makeCtx({ sessions: [parent, child], agents: [parentAgent, childAgent], ownedBy: [['c', 'p']] });

  assert.equal(hasSessionSubagentOwner(ctx, { header: { origin: 'subagent' } }, undefined), true);
  assert.equal(hasSessionSubagentOwner(ctx, { header: child.header }, childAgent), true, 'live 且被父拥有 → 拒');
  assert.equal(hasSessionSubagentOwner(ctx, { header: child.header }, undefined), false, '冷会话第三参为 undefined → 内核返回 false');
  assert.equal(hasSessionSubagentOwner(ctx, { header: { parentSession: 'p' } }, childAgent), true);
  assert.equal(hasSessionSubagentOwner(ctx, { header: { id: 'x' } }, childAgent), false);
  assert.equal(hasSessionSubagentOwner(ctx, undefined, childAgent), false, '没有 header 也不能炸');
  assert.equal(hasSessionSubagentOwner({}, { header: child.header }, childAgent), false, '没有 agents 服务也不能炸');
});

// ---------------------------------------------------------------- self/info

test('self/info：会话 id / profile / 版本号 / 生效投递策略', async () => {
  const web = await makeToolkit(makeCtx({})).dispatch(ENDPOINTS.self, {});
  assert.equal(web.ok, true);
  assert.deepEqual(Object.keys(web.value).sort(), ['delivery', 'pluginVersion', 'profile', 'promptPath', 'sessionId']);
  assert.equal(web.value.sessionId, null);
  assert.equal(web.value.profile, 'web');
  assert.match(web.value.pluginVersion, /^\d+\.\d+\.\d+/);
  assert.equal(web.value.delivery, 'auto', '默认策略是 auto（prompt 优先）');
  assert.equal(web.value.promptPath, false, '这个 stub ctx 没有 sessionController → 走的不是 prompt 路径');

  const desktopCtx = makeCtx({ desktop: true });
  const desktop = await makeToolkit(desktopCtx, { selfSessionId: 's-me' }).dispatch(ENDPOINTS.self, {});
  assert.equal(desktop.value.profile, 'desktop');
  assert.equal(desktop.value.sessionId, 's-me');
});

test('self/info 的 delivery / promptPath：判据与 deliver.js 的选路条件逐字一致', async () => {
  const target = makeFakeSession({ id: 's-info', createdAt: 50 });
  const bare = () => makeCtx({ sessions: [target], agents: [makeFakeAgent(target)] });
  const withController = () => makeCtx({
    sessions: [target], agents: [makeFakeAgent(target)], sessionController: makeFakeSessionController(),
  });
  const info = (ctx, options) => makeToolkit(ctx, options).dispatch(ENDPOINTS.self, {}).then((result) => result.value);

  // ① 有 sessionController（带 prompt）→ promptPath true
  const capable = await info(withController(), {});
  assert.equal(capable.delivery, 'auto');
  assert.equal(capable.promptPath, true);

  // ② 服务在但没 prompt 方法 → false
  const crippled = await info(makeCtx({
    sessions: [target], agents: [makeFakeAgent(target)], sessionController: { notPrompt: true },
  }), {});
  assert.equal(crippled.promptPath, false);

  // ③ delivery:'agents' 永远是 false（哪怕内核路径可用）
  const forcedAgents = await info(withController(), { delivery: 'agents' });
  assert.equal(forcedAgents.delivery, 'agents');
  assert.equal(forcedAgents.promptPath, false);

  // ④ delivery:'prompt' 但服务缺席 → 仍然 false（那次投递会报 gateway/internal）
  const forcedPrompt = await info(bare(), { delivery: 'prompt' });
  assert.equal(forcedPrompt.delivery, 'prompt');
  assert.equal(forcedPrompt.promptPath, false);

  // ⑤ 未知策略回退 auto
  assert.equal((await info(bare(), { delivery: 'nonsense' })).delivery, 'auto');

  // ⑥ 服务是**运行时**解析的：apply 之后才 provide 的 sessionController 也必须被认出来（不能缓存）
  const lateCtx = makeCtx({ sessions: [target], agents: [makeFakeAgent(target)] });
  const lateToolkit = makeToolkit(lateCtx);
  assert.equal((await lateToolkit.dispatch(ENDPOINTS.self, {})).value.promptPath, false);
  lateCtx.sessionController = makeFakeSessionController(); // cordis 里相当于稍后才 provide 的服务
  assert.equal((await lateToolkit.dispatch(ENDPOINTS.self, {})).value.promptPath, true, 'promptPath 必须按调用时刻解析');

  // ⑦ self/info 回的是 host 生效值；payload 里的 delivery 只覆写单次调用
  const controller = makeFakeSessionController();
  const ctx = makeCtx({ sessions: [target], agents: [makeFakeAgent(target)], sessionController: controller });
  const toolkit = makeToolkit(ctx);
  const forced = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-info', text: 'hi', delivery: 'agents' });
  assert.equal(forced.value.delivery, 'agents', '回执里的 delivery 是本次真实路径');
  const afterOverride = await toolkit.dispatch(ENDPOINTS.self, {});
  assert.equal(afterOverride.value.delivery, 'auto', 'payload 覆写不改 self/info 的 host 生效值');
  assert.equal(afterOverride.value.promptPath, true);

  // ⑧ 回执的 delivery 字段与 promptPath 的语义必须能对上：promptPath=true 时 auto 就必须走内核路径
  const auto = await toolkit.dispatch(ENDPOINTS.send, { targetSessionId: 's-info', text: 'hi' });
  assert.equal(auto.value.delivery, 'session-controller');
  assert.equal(controller.calls.at(-1).request.sessionId, 's-info');
});

test('环境解耦：profile 判定优先级 ctx > env，env 缺失时默认 web', () => {
  // ctx 有 desktopProfiles → 无论 env 说什么都是 desktop
  assert.equal(detectProfile(makeCtx({ desktop: true }), { DSH_PROFILE: 'web' }), 'desktop');
  // ctx 没线索（web profile 的 ctx 也没有 desktopProfiles）→ 才读 env
  assert.equal(detectProfile(makeCtx({}), { DSH_PROFILE: 'desktop' }), 'desktop');
  assert.equal(detectProfile(makeCtx({}), { DSH_PROFILE: 'web' }), 'web');
  assert.equal(detectProfile(makeCtx({}), {}), 'web');
  assert.equal(detectProfile(makeCtx({}), { DSH_PROFILE: 'nonsense' }), 'web');
  // 不传 env = 读 process.env（真实宿主行为）；本测试不假设它的值，只要求与 process.env 一致
  const real = process.env.DSH_PROFILE;
  const expected = real === 'desktop' || real === 'web' ? real : 'web';
  assert.equal(detectProfile({}), expected, '不传 env 时读 process.env，但绝不炸');
  // 服务的 get 抛错也不能让判定整条挂掉
  assert.equal(detectProfile({ get() { throw new Error('no service'); } }, { DSH_PROFILE: 'desktop' }), 'desktop');
});

test('环境解耦：selfSessionId 按 DSH_SESSION_ID 兜底（不保证存在，缺了就 null）', async () => {
  assert.equal(envSelfSessionId({ DSH_SESSION_ID: 'session-abc' }), 'session-abc');
  assert.equal(envSelfSessionId({ DSH_SESSION_ID: '  ' }), null);
  assert.equal(envSelfSessionId({}), null);
  assert.equal(envSelfSessionId(undefined), null, '传 undefined 表示读 process.env，读不到就 null');

  const fromEnv = await makeToolkit(makeCtx({}), { env: { DSH_SESSION_ID: 'session-env-1' } })
    .dispatch(ENDPOINTS.self, {});
  assert.equal(fromEnv.value.sessionId, 'session-env-1', 'DSH_SESSION_ID 比返回 null 有用得多');

  const explicit = await makeToolkit(makeCtx({}), { selfSessionId: 's-explicit', env: { DSH_SESSION_ID: 'session-env-1' } })
    .dispatch(ENDPOINTS.self, {});
  assert.equal(explicit.value.sessionId, 's-explicit', '显式传入必须压过环境兜底');

  const isolated = await makeToolkit(makeCtx({}), { env: {} }).dispatch(ENDPOINTS.self, {});
  assert.equal(isolated.value.sessionId, null, 'env:{} 明确表示"不读环境"，测试因此确定');
});

test('未知 endpoint → ok:false bad-request（不是 500，也不是静默成功）', async () => {
  const toolkit = makeToolkit(makeCtx({}));
  const result = await toolkit.dispatch('sessions/explode', {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'bad-request');
  assert.match(result.error.message, /unknown endpoint/);
});

// ---------------------------------------------------------------- wire 层

test('wire 信封：request → server-response{ok:true,value}，字段与契约逐字一致', async () => {
  const target = makeFakeSession({ id: 's-wire', createdAt: 11 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({
    sessions: [target],
    agents: [agent],
    listMetadata: { 's-wire': { blank: false, lastPromptAt: null } },
  });
  const toolkit = makeToolkit(ctx, { selfSessionId: 's-me' });
  const handler = sessionTelecomFetchHandler(CHANNEL, toolkit.rpcHandler, console, toWireError);

  const listEnvelope = await envelope(await post(handler, ENDPOINTS.list, {
    type: 'client-request',
    rpcId: 'rpc-1',
    method: ENDPOINTS.list,
    payload: {},
  }));
  assert.equal(listEnvelope.type, 'server-response');
  assert.equal(listEnvelope.rpcId, 'rpc-1');
  assert.equal(listEnvelope.result.ok, true);
  assert.deepEqual(Object.keys(listEnvelope.result.value).sort(), ['costTotals', 'selfSessionId', 'sessions']);
  assert.deepEqual(Object.keys(listEnvelope.result.value.sessions[0]).sort(), [
    'archived', 'billableTokens', 'blank', 'cacheHitRate', 'cacheReadTokens', 'cacheWriteTokens',
    'contextLoad', 'contextTokens', 'contextWindow', 'cwd', 'id', 'inputTokens', 'isSelf',
    'lastAssistantAt', 'lastAssistantPreview', 'lastEventAt', 'lastUserAt', 'live',
    'outputTokens', 'running', 'title', 'tokens', 'updatedAt', 'workspaceId',
  ]);

  const viaRpc = await toolkit.rpc(ENDPOINTS.send, { targetSessionId: 's-wire', text: 'hi' }, { rpcId: 'rpc-2' });
  assert.equal(viaRpc.type, 'server-response');
  assert.equal(viaRpc.rpcId, 'rpc-2');
  assert.equal(viaRpc.result.ok, true);
  assert.equal(viaRpc.result.value.delivered, true);
  for (const key of ['delivered', 'targetSessionId', 'mode', 'live', 'messageId']) {
    assert.ok(key in viaRpc.result.value, `回执必须含 ${key}`);
  }

  const direct = await toolkit.rpcHandler(ENDPOINTS.self, {}, undefined);
  assert.equal(direct.ok, true);
  assert.equal(direct.value.sessionId, 's-me');
  // 新增的两个自述字段也要能过 wire（客户端/验证者据此判断这条链走的哪条路）
  assert.equal(direct.value.delivery, 'auto');
  assert.equal(direct.value.promptPath, false, '这个 ctx 没有 sessionController');
});

test('wire 层：404 / 415 / 400 / rpcId 不匹配，绝不 500', async () => {
  const toolkit = makeToolkit(makeCtx({}));
  const handler = sessionTelecomFetchHandler(CHANNEL, toolkit.rpcHandler, console, toWireError);

  // 通道下「合法段但没这个 endpoint」→ 信封化的 bad-request（不是 404：
  // 客户端要能拿到 code，而不是一个裸 404 让 UI 无从判断）
  const unknownEndpoint = await envelope(await post(handler, 'unknown/thing', { rpcId: 'r', method: 'unknown/thing', payload: {} }));
  assert.equal(unknownEndpoint.rpcId, 'r');
  assert.equal(unknownEndpoint.result.ok, false);
  assert.equal(unknownEndpoint.result.error.code, 'bad-request');

  // 真正的 404：路径不在本通道下 / 段非法 / 非 POST
  const wrongPath = await post(handler, 'x', { rpcId: 'r', method: 'x', payload: {} }, { url: `${CHANNEL_URL}-other/x` });
  assert.equal(wrongPath.status, 404);
  const badSegment = await post(handler, 'a//b', { rpcId: 'r', method: 'a//b', payload: {} });
  assert.equal(badSegment.status, 404);

  const wrongMethod = await handler.fetch(request('GET', `${CHANNEL_URL}/${ENDPOINTS.list}`));
  assert.equal(wrongMethod.status, 404);

  const wrongType = await post(handler, ENDPOINTS.list, '{}', { headers: { 'content-type': 'text/plain' } });
  assert.equal(wrongType.status, 415);

  const notJson = await post(handler, ENDPOINTS.list, 'not json at all');
  assert.equal(notJson.status, 400);

  const noRpcId = await envelope(await post(handler, ENDPOINTS.list, { method: ENDPOINTS.list }));
  assert.equal(noRpcId.rpcId, 'invalid-request');
  assert.equal(noRpcId.result.ok, false);
  assert.equal(noRpcId.result.error.code, 'bad-request');

  const mismatch = await envelope(await post(handler, ENDPOINTS.list, {
    rpcId: 'rpc-x',
    method: ENDPOINTS.send,
    payload: {},
  }));
  assert.equal(mismatch.rpcId, 'rpc-x');
  assert.equal(mismatch.result.ok, false);
  assert.equal(mismatch.result.error.code, 'bad-request');
});

test('wire 层：handler 抛错 → 200 + {ok:false,gateway/internal}，任何情况都不出现 500', async () => {
  const handler = sessionTelecomFetchHandler(CHANNEL, async () => {
    throw new Error('kaboom');
  }, { error() {} }, toWireError);

  const response = await post(handler, ENDPOINTS.list, { rpcId: 'rpc-500', method: ENDPOINTS.list, payload: {} });
  assert.equal(response.status, 200, '契约硬性要求：不许 500');
  const body = await response.json();
  assert.equal(body.rpcId, 'rpc-500');
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error.code, 'gateway/internal');
  assert.match(body.result.error.message, /kaboom/);
  assert.equal(typeof body.result.error.details, 'object');

  for (const thrown of ['plain', undefined, null, 42]) {
    const weird = sessionTelecomFetchHandler(CHANNEL, async () => {
      throw thrown;
    }, undefined, toWireError);
    const res = await post(weird, ENDPOINTS.self, { rpcId: 'r', method: ENDPOINTS.self, payload: {} });
    assert.equal(res.status, 200);
    const parsed = await res.json();
    assert.equal(parsed.result.ok, false);
    assert.equal(parsed.result.error.code, 'gateway/internal');
  }

  const rawHandler = sessionTelecomFetchHandler(CHANNEL, async () => ({ hello: 'world' }));
  const rawBody = await (await post(rawHandler, ENDPOINTS.self, { rpcId: 'r2', method: ENDPOINTS.self, payload: {} })).json();
  assert.deepEqual(rawBody.result, { ok: true, value: { hello: 'world' } });
});

test('wire 层：endpoint 内部真实抛错（不是 handler 抛）也必须转成结构化错误', async () => {
  const ctx = makeCtx({});
  ctx.sessionQuery.listSessions = async () => {
    throw new Error('persistence down');
  };
  ctx.sessions.list = () => {
    throw new Error('store down');
  };
  const toolkit = makeToolkit(ctx);
  const handler = sessionTelecomFetchHandler(CHANNEL, toolkit.rpcHandler, console, toWireError);
  const body = await envelope(await post(handler, ENDPOINTS.list, { rpcId: 'r3', method: ENDPOINTS.list, payload: {} }));
  assert.equal(body.result.ok, false, '未捕获异常必须变成 ok:false');
  assert.equal(body.result.error.code, 'gateway/internal');
});

test('loopback 信任栅栏：requestRejection 可拦截，否则只放行 loopback Host', async () => {
  const toolkit = makeToolkit(makeCtx({}));
  const seen = [];
  const registered = (route) => {
    seen.push(route);
    return () => {};
  };
  const { mountSessionTelecomWebRoute } = await import('../lib/web-rpc.js');

  mountSessionTelecomWebRoute({
    webServer: { register: registered },
    connection: {
      requestRejection(req) {
        return req.headers['x-deny'] === '1' ? 403 : undefined;
      },
    },
  }, { handler: toolkit.rpcHandler, log: console, toError: toWireError });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'prefix');
  assert.equal(seen[0].path, CHANNEL);

  const denied = await respondOf(seen[0], { headers: { 'x-deny': '1' } });
  assert.equal(denied, 403);

  const bare = { webServer: { register: registered } };
  mountSessionTelecomWebRoute(bare, { handler: toolkit.rpcHandler });
  const forged = await respondOf(seen[1], { headers: { host: 'evil.example.com' } });
  assert.equal(forged, 403);
  const crossSite = await respondOf(seen[1], { headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite, 403);
  const badOrigin = await respondOf(seen[1], { headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' } });
  assert.equal(badOrigin, 403);
  const sameOrigin = await respondOf(seen[1], { headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } });
  // 放行后 bridge 把空体交给 fetchHandler，`{}` 不是合法 JSON → 400。
  // 重点是它**没有被信任栅栏挡住**（403），已经走到了通道内部。
  assert.equal(sameOrigin, 400, '同源 loopback 必须放行并进入通道（空体 JSON 解析失败 → 400）');
});

/** 造一个最小 node:http res 替身，跑一次 route.handler，返回写下的状态码。 */
async function respondOf(route, { headers }) {
  let status;
  const res = {
    writableEnded: false,
    writeHead(code) {
      status = code;
      return res;
    },
    write() {
      return true;
    },
    end() {
      res.writableEnded = true;
    },
    on() {
      return res;
    },
    off() {
      return res;
    },
    once() {
      return res;
    },
  };
  // 放行的分支会走 bridge：给它一个空的可迭代 body，bridge 内部会读成空体并交给 fetchHandler
  const req = {
    method: 'POST',
    url: `${CHANNEL}/${ENDPOINTS.self}`,
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {},
    destroy() {},
  };
  await route.handler(req, res);
  return status;
}

// ---------------------------------------------------------------- apply / 挂载

test('apply：把通道挂到 webServer（prefix 路由）并在 ctx.effect 里清理', async () => {
  const target = makeFakeSession({ id: 's-apply', createdAt: 1 });
  const agent = makeFakeAgent(target, { status: 'idle', driveOnEnqueue: true });
  const routes = [];
  let disposed = 0;
  const ctx = makeCtx({
    sessions: [target],
    agents: [agent],
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          disposed++;
        };
      },
    },
  });

  const toolkit = apply(ctx, { env: {} });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, CHANNEL);
  assert.equal(ctx.effects.length, 1, '必须注册一个清理 effect');
  assert.equal(toolkit.profile, 'web');

  // 挂载后的 handler 真的能跑通（假 node:http req/res + 真 bridge）
  const res = await bridgeRoundTrip(routes[0], {
    rpcId: 'rpc-mount',
    method: ENDPOINTS.send,
    payload: { targetSessionId: 's-apply', text: '经路由投递' },
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.rpcId, 'rpc-mount');
  assert.equal(body.result.ok, true);
  assert.equal(body.result.value.delivered, true);
  assert.equal(agent.calls[0].method, 'send');
  assert.equal(agent.calls[0].target, 'next-turn');

  // 清理（cordis 语义：effect 注册的 setup 返回 disposer，由 fiber 调用）
  assert.equal(disposed, 0);
  ctx.disposers[0]();
  assert.equal(disposed, 1);
});

test('apply：无 webServer 时回退 connection.rpc.handle(channel, handler, {authority:loopback})', () => {
  const calls = [];
  const ctx = makeCtx({
    connection: {
      rpc: {
        handle(channel, handler, options) {
          calls.push({ channel, handler, options });
          return () => {};
        },
      },
    },
  });
  apply(ctx, { env: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, CHANNEL);
  assert.equal(typeof calls[0].handler, 'function');
  assert.deepEqual(calls[0].options, { authority: 'loopback' });
});

test('apply：webServer.register 返回 Promise<disposer> 时清理仍然幂等可用', async () => {
  let disposed = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = makeCtx({
    webServer: {
      register() {
        return gate.then(() => () => {
          disposed++;
        });
      },
    },
  });
  apply(ctx, { env: {} });
  const disposer = ctx.disposers[0];
  const first = disposer();
  release();
  await first;
  await disposer();
  assert.equal(disposed, 1, '异步 disposer 只能释放一次');

  assert.equal(typeof toDisposer(undefined), 'function');
  assert.doesNotThrow(() => toDisposer(undefined)());
  assert.doesNotThrow(() => toDisposer(123)());
});

test('apply：register 抛错时不崩，effect 仍然注册（可清理）', () => {
  const ctx = makeCtx({
    webServer: {
      register() {
        throw new Error('route table full');
      },
    },
  });
  assert.doesNotThrow(() => apply(ctx, { env: {} }));
  assert.equal(ctx.effects.length, 1);
  assert.doesNotThrow(() => ctx.disposers[0]());
});

// 让 webServer 路由的 bridge 在没有真 socket 的情况下跑完一轮。
async function bridgeRoundTrip(route, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const req = {
    method: 'POST',
    url: `${CHANNEL}/${body.method}`,
    headers: {
      host: '127.0.0.1:19387',
      'content-type': 'application/json',
      'content-length': String(payload.length),
    },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
    destroy() {},
  };
  const chunks = [];
  const res = {
    writableEnded: false,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end() {
      res.writableEnded = true;
    },
    on() {
      return res;
    },
    off() {
      return res;
    },
    once() {
      return res;
    },
  };
  await route.handler(req, res);
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
}

test('消息工厂探测：workspace 源码里解析不到内核包 → 诚实报 fallback，且 ready() 可等待', async () => {
  const toolkit = makeToolkit(makeCtx({}));
  const source = await toolkit.ready();
  assert.ok(source === 'kernel' || source === 'fallback');
  // workspace 里 profiles/node_modules 不是祖先目录，实测解析不到 → fallback
  if (source === 'fallback') {
    assert.equal(messageFactorySource(), 'fallback');
  }
});

test('消息工厂可以被外部替换（e2e 强制走内核 createUserMessage 的钩子）', async () => {
  const target = makeFakeSession({ id: 's-factory', createdAt: 2 });
  const agent = makeFakeAgent(target, { driveOnEnqueue: true });
  const ctx = makeCtx({ sessions: [target], agents: [agent], knownSenderIds: ['s-y'] });
  let seen;
  useMessageFactory((input) => {
    seen = input;
    return fallbackCreateUserMessage(input);
  });
  const result = await makeToolkit(ctx).dispatch(ENDPOINTS.send, {
    targetSessionId: 's-factory',
    text: 'factory',
    senderSessionId: 's-y',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(seen, {
    content: [{ type: 'text', text: '[由 s-y 发送]\nfactory' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 's-y' },
  }, '注入的是 createUserMessage 的入参（含投递层加的署名），role 由工厂补');
  assert.equal(messageFactorySource(), 'kernel');
});

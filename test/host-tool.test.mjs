// 面向模型的 `session_telecom` 工具：单测（stub ctx + 真正的 defineTool 语义）。
//
// 覆盖三件最容易出错的事：
//   1) action 分发与参数校验（缺 targetSessionId / 缺 text / 超长文本）；
//   2) 发送方身份取自 **exec.agent**，并且永远不是伪造的（拿不到就不带）；
//   3) 失败一律是结构化 `{ok:false,error:{code,message}}`，**绝不抛异常**——
//      工具抛异常会打断整轮，而"目标不存在"是模型该读到并自行纠正的事实。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionTelecomTool } from '../lib/tool.js';
import { createSessionRegistry } from '../lib/session-registry.js';
import { ToolkitError } from '../lib/errors.js';

/**
 * 假 defineTool —— 但**强制模拟真实 DSL 的两条校验路径**。
 *
 * 为什么不能是"照单全收"的 stub：真机实测踩过一次 —— 我在 output.schema 里写了 `required`，
 * stub 一路绿灯、单测全绿，而真实 @deepseek-ai/dsh-tools 的 defineTool 直接抛
 *   JsonSchemaError: schema.required is not supported by the value schema DSL
 * 于是宿主里工具根本注册不上。教训：stub 必须复刻它替身对象的**拒绝行为**，
 * 否则它只会掩盖缺陷（"a guard that cannot fail is a bug"）。
 *
 * 两条路径不同（dsh-tools/lib/index.js:686-785）：
 *   parameters → parameterSchemaSpecToJsonSchema：根节点是**隐式属性表**，
 *                不写 `type`，属性级允许 `required`（compilePropertyMap）；
 *   output     → valueSchemaSpecToJsonSchema：根节点必须显式 `type`，且**禁止 `required`**。
 * 标量只认 type/enum/const；`type` 必须是单个字符串，不能是数组。
 */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

function assertValueSchema(node, path) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${path} must be a schema object`);
  }
  const type = node.type;
  if (typeof type !== 'string') {
    throw new Error(`${path}.type must be a single string (arrays are not supported by the DSL)`);
  }
  const allowed = (() => {
    switch (type) {
      case 'object': return [...ANNOTATION_KEYS, 'type', 'properties', 'additionalProperties'];
      case 'array': return [...ANNOTATION_KEYS, 'type', 'items'];
      case 'string': case 'number': case 'integer': case 'boolean': case 'null':
        return [...ANNOTATION_KEYS, 'type', 'enum', 'const'];
      case 'json': return [...ANNOTATION_KEYS, 'type'];
      default: throw new Error(`${path}.type ${JSON.stringify(type)} is not a DSL type`);
    }
  })();
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) throw new Error(`${path}.${key} is not supported by the value schema DSL`);
  }
  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') {
      throw new Error(`${path}.additionalProperties must be explicitly true or false`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      assertValueSchema(child, `${path}.properties.${key}`);
    }
  }
  if (type === 'array' && node.items !== undefined) {
    assertValueSchema(node.items, `${path}.items`);
  }
}

/** 参数表：根节点是隐式属性表，属性级允许 required。 */
function assertParameterSchema(parameters, path) {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error(`${path} must be a parameter map`);
  }
  if (parameters.type !== undefined) {
    throw new Error(`${path}.type must not be declared on the parameter map root`);
  }
  for (const key of Object.keys(parameters)) {
    if (key === 'required') {
      if (!Array.isArray(parameters.required)) throw new Error(`${path}.required must be an array`);
      continue;
    }
    assertValueSchema(parameters[key], `${path}.${key}`);
  }
  for (const name of parameters.required ?? []) {
    if (parameters[name] === undefined) throw new Error(`${path}.required names unknown parameter ${name}`);
  }
}

function fakeDefineTool(options) {
  assertParameterSchema(options.parameters, 'schema');
  assertValueSchema(options.output.schema, 'schema');
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    render: options.output.render,
    execute: options.execute,
  };
}

/**
 * render 的**契约是 ContentBlock[]**，不是字符串：内核把它当作 `result.content`
 * 交给 `tools/post-execute` 的消费者（dsh-spill-policy 会 `content.some(...)`），
 * 裸字符串会让整个工具调用崩成 `content.some is not a function`。
 * 所以断言前先把块数组拼回文本。
 */
function renderText(tool, args, value) {
  const blocks = tool.render(args, value);
  if (!Array.isArray(blocks)) throw new Error(`output.render 必须返回块数组，实际是 ${typeof blocks}`);
  return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('');
}

/** 造一个 ctx：会话清单走 createSessionRegistry 的真实代码路径。 */
function makeCtx({ sessions = [], titles = {}, listMetadata = {}, usage = {}, pressure = {} } = {}) {
  const liveById = new Map(sessions.map((session) => [session.id, session]));
  return {
    sessions: {
      list: () => [...liveById.values()],
      get: (id) => liveById.get(id),
      flush: async () => {},
    },
    agents: { get: () => undefined, resume: async () => { throw new Error('不该走到 resume'); } },
    sessionQuery: {
      async listSessions() {
        return sessions.map((session) => ({ header: session.header, live: true, persisted: true }));
      },
      async observeSession(sessionId) {
        const known = liveById.get(sessionId);
        if (known === undefined) {
          const error = new Error(`session "${sessionId}" not found`);
          error.code = 'SESSION_QUERY_SESSION_NOT_FOUND';
          throw error;
        }
        return { header: known.header, projections: { values: {} } };
      },
      async load(sessionId) {
        return this.observeSession(sessionId);
      },
    },
    sessionProjections: {
      cachedSnapshot(session, keys) {
        const values = {};
        if (keys === undefined || keys.includes('title')) values.title = titles[session.id] ?? null;
        if (keys === undefined || keys.includes('sessionListMetadata')) {
          values.sessionListMetadata = listMetadata[session.id] ?? { blank: false, lastPromptAt: 1 };
        }
        if (usage[session.id] !== undefined) values.tokenUsage = usage[session.id];
        if (pressure[session.id] !== undefined) values.contextPressure = pressure[session.id];
        return { asOfSeq: session.seq, values };
      },
    },
    get(name) {
      if (name === 'sessionQuery') return this.sessionQuery;
      if (name === 'sessionProjections') return this.sessionProjections;
      return undefined;
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: () => () => {},
  };
}

function makeSession(id, { cwd = 'D:\\BuyKey\\ws', createdAt = 1 } = {}) {
  return { id, header: { version: 4, id, createdAt, cwd }, seq: 2 };
}

/** 造工具：ctx 决定清单来源，deliver 决定投递行为。 */
function makeTool({ ctx, deliver, maxTextBytes, listLimit, senderPrefix } = {}) {
  const toolkit = { ctx: ctx ?? makeCtx() };
  return createSessionTelecomTool({
    toolkit,
    defineTool: fakeDefineTool,
    createRegistry: createSessionRegistry,
    deliver: deliver ?? (async () => ({ delivered: true, live: true })),
    ...(maxTextBytes === undefined ? {} : { maxTextBytes }),
    ...(listLimit === undefined ? {} : { listLimit }),
    ...(senderPrefix === undefined ? {} : { senderPrefix }),
  });
}

/** 工具执行上下文：只给 exec.agent（真实调用者）。 */
function execFor(sessionId) {
  return sessionId === undefined ? {} : { agent: { session: { header: { id: sessionId } } } };
}

test('工具定义：名字、参数枚举、render 都在', async () => {
  const tool = makeTool();
  assert.equal(tool.name, 'session_telecom');
  assert.deepEqual(tool.parameters.action.enum, ['list', 'send', 'read', 'peek']);
  assert.equal(typeof tool.render, 'function');
  assert.match(tool.description, /其他 DSH 会话|会话通信/);
  // 反"消息风暴"纪律必须在描述里：对端不必回执、不必翻日志核对身份
  assert.match(tool.description, /不要把回执再投回去|消息风暴/);
});

test('list：返回会话清单 + 花费汇总，isSelf 按 exec.agent 标出', async () => {
  const ctx = makeCtx({
    sessions: [makeSession('s-self', { createdAt: 10 }), makeSession('s-other', { createdAt: 20 })],
    titles: { 's-self': '本会话', 's-other': '别的会话' },
    usage: {
      's-other': {
        totals: { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 3000, cacheWriteTokens: 0 },
        last: null,
      },
    },
    pressure: { 's-other': { pressureTokens: 90000, contextWindow: 100000, surfaceTokens: 1 } },
  });
  const tool = makeTool({ ctx });
  const value = await tool.execute({ action: 'list' }, execFor('s-self'));

  assert.equal(value.ok, true);
  assert.equal(value.action, 'list');
  const ids = value.sessions.map((row) => row.id);
  assert.deepEqual(ids, ['s-other', 's-self'], '按 updatedAt 倒序');
  const self = value.sessions.find((row) => row.id === 's-self');
  const other = value.sessions.find((row) => row.id === 's-other');
  assert.equal(self.isSelf, true);
  assert.equal(other.isSelf, false);
  assert.equal(other.tokens, '4.5k', '4500 → 4.5k');
  assert.equal(other.cacheHitRate, 0.75);
  assert.equal(other.contextLoad, 0.9);
  assert.equal(value.totals.tokens, '4.5k');
  assert.equal(value.totals.sessionsWithUsage, 1);

  const rendered = renderText(tool, { action: 'list' }, value);
  assert.match(rendered, /s-other/);
  assert.match(rendered, /缓存75%/);
  assert.match(rendered, /合计计费 1\.5k tok/, '汇总只留"计费"这一个真正花钱的数字');
});

test('list：query 过滤（标题或 id）与 limit 生效', async () => {
  const ctx = makeCtx({
    sessions: [makeSession('s-a', { createdAt: 30 }), makeSession('s-b', { createdAt: 20 }), makeSession('s-c', { createdAt: 10 })],
    titles: { 's-a': '银行题库', 's-b': '笔记', 's-c': '银行笔试' },
  });
  const tool = makeTool({ ctx });
  const filtered = await tool.execute({ action: 'list', query: '银行' }, execFor('s-a'));
  assert.deepEqual(filtered.sessions.map((row) => row.id), ['s-a', 's-c']);
  const limited = await tool.execute({ action: 'list', limit: 1 }, execFor('s-a'));
  assert.deepEqual(limited.sessions.map((row) => row.id), ['s-a']);
  const byId = await tool.execute({ action: 'list', query: 's-b' }, execFor('s-a'));
  assert.deepEqual(byId.sessions.map((row) => row.id), ['s-b']);
});

test('send：发信方取自 exec.agent，投递参数逐字透传（含 mode 归一）', async () => {
  const seen = [];
  const tool = makeTool({
    deliver: async (ctx, payload) => {
      seen.push(payload);
      return { delivered: true, live: false };
    },
  });
  const value = await tool.execute(
    { action: 'send', targetSessionId: 's-target', text: '  你好  ', mode: 'steer' },
    execFor('s-caller'),
  );
  assert.equal(value.ok, true);
  assert.equal(value.delivered, true);
  assert.equal(value.resumed, true, 'live=false → resumed=true（目标原本是冷的）');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].senderSessionId, 's-caller', '发信方必须是真实调用者');
  assert.equal(seen[0].targetSessionId, 's-target');
  // 署名由**投递层**统一加，所以工具这一层交出去的是原始正文（去掉首尾空白），
  // 并且把署名开关透传给投递层 —— 避免两层各加一行署名。
  assert.equal(seen[0].text, '你好', '文本要去掉首尾空白，署名不在这一层加');
  assert.equal(seen[0].mode, 'steer');
  assert.equal(seen[0].senderPrefix, undefined, '默认不覆写开关（投递层默认开）');
  assert.match(renderText(tool, { action: 'send' }, value), /已投递给/, '回执要短：一行、不重复目标 id');
});

test('send：署名开关在工具层透传给投递层（senderPrefix:false）', async () => {
  const seen = [];
  const tool = makeTool({
    senderPrefix: false,
    deliver: async (ctx, payload) => {
      seen.push(payload);
      return { delivered: true, live: true };
    },
  });
  await tool.execute({ action: 'send', targetSessionId: 's-t', text: '你好' }, execFor('s-caller'));
  assert.equal(seen[0].senderPrefix, false, '配了就要透传，否则外面关了也不生效');
});

test('send：拿不到 exec.agent 时不带发信方（绝不猜一个）', async () => {
  const seen = [];
  const tool = makeTool({
    deliver: async (ctx, payload) => {
      seen.push(payload);
      return { delivered: true, live: true };
    },
  });
  const value = await tool.execute({ action: 'send', targetSessionId: 's-t', text: 'hi' }, {});
  assert.equal(value.ok, true);
  assert.equal(seen[0].senderSessionId, null);
  assert.equal('senderSessionId' in value, false, '工具输出里也不出现伪造身份');
});

test('成本上限可注入：maxTextBytes / listLimit 真的生效（不用改代码）', async () => {
  // 1) 收紧文本上限 → 原本能过的长度现在被拒，且错误里报的是**配置后的**数字
  const strict = makeTool({ maxTextBytes: 64 });
  const tooLong = await strict.execute({ action: 'send', targetSessionId: 's-x', text: 'x'.repeat(80) }, execFor('s-me'));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error.message, /exceeds 64 bytes/, '报错要给出实际生效的上限');

  // 关掉署名后 60 字节正文应当刚好过
  const justRight = makeTool({ maxTextBytes: 64, senderPrefix: false, deliver: async () => ({ delivered: true, live: true }) });
  const ok = await justRight.execute({ action: 'send', targetSessionId: 's-x', text: 'x'.repeat(60) }, execFor('s-me'));
  assert.equal(ok.ok, true);

  // 2) 收紧清单条数 → 默认返回条数变少（参数描述里也应反映新默认值）
  // 注意：stub 的 listMetadata 默认是 blank:true（= 从没跑过 turn 的会话），插件会照内核语义
  // 把 blank 行整条过滤掉，所以这里必须显式给 blank:false —— 否则拿到的是空清单，
  // 断言会误判成"limit 没生效"（这个坑踩过一次）。
  const sessions = [makeSession('s-1', { createdAt: 30 }), makeSession('s-2', { createdAt: 20 }), makeSession('s-3', { createdAt: 10 })];
  const ctx = makeCtx({
    sessions,
    listMetadata: {
      's-1': { blank: false, lastPromptAt: 30 },
      's-2': { blank: false, lastPromptAt: 20 },
      's-3': { blank: false, lastPromptAt: 10 },
    },
  });
  const limited = makeTool({ ctx, listLimit: 2 });
  const listed = await limited.execute({ action: 'list' }, execFor('s-1'));
  assert.equal(listed.sessions.length, 2, 'listLimit=2 时默认只回 2 条');
  assert.match(limited.parameters.limit.description, /默认 2/, '参数描述要反映配置后的默认值');

  // 3) 默认值没被改坏
  const normal = makeTool({ ctx });
  assert.equal((await normal.execute({ action: 'list' }, execFor('s-1'))).sessions.length, 3);
  assert.match(normal.parameters.limit.description, /默认 20/);
});

test('send：参数校验（缺目标 / 缺文本 / 超长）都是结构化错误，不是异常', async () => {
  const tool = makeTool();
  const missingTarget = await tool.execute({ action: 'send', text: 'hi' }, execFor('s-me'));
  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.error.code, 'bad-request');
  assert.match(missingTarget.error.message, /targetSessionId is required/);

  const missingText = await tool.execute({ action: 'send', targetSessionId: 's-x' }, execFor('s-me'));
  assert.equal(missingText.ok, false);
  assert.equal(missingText.error.code, 'bad-request');

  const tooLong = await tool.execute(
    { action: 'send', targetSessionId: 's-x', text: 'x'.repeat(33 * 1024) },
    execFor('s-me'),
  );
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error.message, /exceeds/);
});

test('send：投递失败（目标不存在）→ ok:false + 原始 code，且不抛', async () => {
  const tool = makeTool({
    deliver: async () => {
      throw new ToolkitError('session/not-found', 'session "s-ghost" not found', { sessionId: 's-ghost' });
    },
  });
  const value = await tool.execute({ action: 'send', targetSessionId: 's-ghost', text: 'hi' }, execFor('s-me'));
  assert.equal(value.ok, false);
  assert.equal(value.error.code, 'session/not-found');
  assert.match(renderText(tool, { action: 'send' }, value), /session\/not-found/);
});

test('send：投递时用 exec.agent 作为 self，因此目标行能正确标出 isSelf', async () => {
  const ctx = makeCtx({
    sessions: [makeSession('s-caller', { createdAt: 5 }), makeSession('s-target', { createdAt: 9 })],
    titles: { 's-target': '收件会话' },
  });
  const tool = makeTool({ ctx, deliver: async () => ({ delivered: true, live: true }) });
  const value = await tool.execute({ action: 'send', targetSessionId: 's-target', text: 'hi' }, execFor('s-caller'));
  assert.equal(value.targetTitle, '收件会话');
  assert.match(renderText(tool, { action: 'send' }, value), /收件会话/);
});

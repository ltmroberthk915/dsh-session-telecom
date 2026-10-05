import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTelecom } from '../lib/index.js';
import { createSessionReader } from '../lib/session-reader.js';
import { createSessionRegistry } from '../lib/session-registry.js';
import { createSessionTelecomTool } from '../lib/tool.js';
import { deliverToSession } from '../lib/deliver.js';

const header = { id: 'session-source', createdAt: 1, cwd: 'E:\\中文 项目' };
const events = [
  { seq: 0, time: 10, type: 'user/message', data: { content: [{ type: 'text', text: '继续尾巴工作' }] } },
  { seq: 1, time: 20, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '旧回答' }] } } },
  { seq: 2, time: 30, type: 'user/message', data: { content: [{ type: 'text', text: '给出交接清单' }] } },
  { seq: 3, time: 40, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '隐藏推理' }, { type: 'text', text: '修复已完成。' }, { type: 'text', text: '下一步：验收图片。' }] } } },
  { seq: 4, time: 50, type: 'turn/end', data: { reason: { kind: 'completed' } } },
];
const log = { header, events };
const quiet = { warn() {}, error() {} };

function liveContext(logEvents = events) {
  const session = { header, id: header.id, seq: logEvents.length, snapshotEvents: () => logEvents };
  return { sessions: { get: id => id === header.id ? session : undefined, list: () => [session] } };
}

test('read gets the source answer without messaging or awakening it; tail/raw preserve the latest events', async () => {
  const ctx = liveContext();
  ctx.agents = { resume() { assert.fail('read must not awaken an agent'); } };
  ctx.sessionQuery = { readSession() { assert.fail('live reads must not touch persistence'); } };
  const kit = createSessionTelecom(ctx, { env: {}, logger: quiet });
  const result = await kit.dispatch('sessions/read', { sessionId: header.id, last: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.value.source, 'live');
  assert.equal(result.value.cwd, header.cwd);
  assert.equal(result.value.lastAssistantAt, 40);
  assert.equal(result.value.lastUserAt, 30);
  assert.equal(result.value.lastSeq, 4);
  assert.match(result.value.text, /下一步：验收图片/);
  assert.match(result.value.text, /给出交接清单/);
  assert.doesNotMatch(result.value.text, /旧回答|继续尾巴工作|隐藏推理/);
  const tail = await kit.readSession({ sessionId: header.id, mode: 'tail', last: 2 });
  assert.match(tail.text, /seq=3/);
  assert.match(tail.text, /turn\/end/);
  const raw = await kit.readSession({ targetSessionId: header.id, mode: 'raw', last: 2 });
  assert.deepEqual(raw.text.split('\n').map(JSON.parse), events.slice(-2));
});

test('cold observations request no projections and release the lease, including cancellation', async () => {
  let closed = 0;
  const controller = new AbortController();
  const ctx = { sessionQuery: {
    async observeSession(id, options) {
      assert.equal(id, header.id);
      assert.equal(options.projectionMode, 'none');
      if (options.signal) controller.abort();
      return { ...log, [Symbol.dispose]() { closed++; } };
    },
  } };
  const reader = createSessionReader(ctx);
  assert.equal((await reader.read({ sessionId: header.id })).source, 'session-query');
  await assert.rejects(reader.read({ sessionId: header.id }, controller.signal), { name: 'AbortError' });
  assert.equal(closed, 2);
});

test('metadata-only observations fall back to the older readSession API and release their lease', async () => {
  let closed = false;
  const reader = createSessionReader({ sessionQuery: {
    observeSession: async () => ({ header, [Symbol.dispose]() { closed = true; } }),
    readSession: async () => { assert.equal(closed, true); return { session: header, events }; },
  } });
  assert.match((await reader.read({ sessionId: header.id })).text, /验收图片/);
});

test('persistence fallback opens only a read handle and closes it after success or failure', async () => {
  let closed = 0;
  let fail = false;
  const reader = createSessionReader({ sessionPersistence: {
    async open(id, access, options) {
      assert.equal(id, header.id);
      assert.equal(access, 'read');
      assert.equal(options, undefined);
      return { header, async read(offset, length) {
        assert.equal(offset, 0);
        assert.equal(length, undefined);
        if (fail) throw new Error('corrupt archive');
        return { events };
      }, async close() { closed++; } };
    },
  } });
  assert.equal((await reader.read({ sessionId: header.id })).source, 'session-persistence');
  fail = true;
  await assert.rejects(reader.read({ sessionId: header.id }), /corrupt archive/);
  assert.equal(closed, 2);
});

test('not-found and corruption propagate without a second read or directory search', async () => {
  let fallbackCalls = 0;
  const ctx = { sessionQuery: { observeSession: async () => { throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); } },
    sessionPersistence: { open() { fallbackCalls++; assert.fail('authoritative failure must not retry'); } } };
  const kit = createSessionTelecom(ctx, { env: {}, logger: quiet });
  assert.equal((await kit.dispatch('sessions/read', { sessionId: 'missing' })).error.code, 'session/not-found');
  ctx.sessionQuery.observeSession = async () => { throw Object.assign(new Error('corrupt'), { code: 'SESSION_QUERY_CORRUPT_SESSION' }); };
  assert.equal((await kit.dispatch('sessions/read', { sessionId: header.id })).error.code, 'SESSION_QUERY_CORRUPT_SESSION');
  assert.equal(fallbackCalls, 0);
});

test('read validates arguments before I/O and reports unavailable hosts without guessing paths', async () => {
  const kit = createSessionTelecom({}, { env: {}, logger: quiet });
  for (const payload of [{}, { sessionId: 's', last: 0 }, { sessionId: 's', last: 51 }, { sessionId: 's', last: 1.5 }, { sessionId: 's', mode: 'queue' }, { sessionId: 's', targetSessionId: 'other' }]) {
    assert.equal((await kit.dispatch('sessions/read', payload)).error.code, 'bad-request');
  }
  assert.equal((await kit.dispatch('sessions/read', { sessionId: 's' })).error.code, 'session/read-unavailable');
  const signal = AbortSignal.abort();
  assert.equal((await kit.dispatch('sessions/read', { sessionId: 's' }, signal)).error.code, 'cancelled');
  const mismatch = createSessionReader({ sessionQuery: { readSession: async () => ({ header: { id: 'wrong' }, events }) } });
  await assert.rejects(mismatch.read({ sessionId: header.id }), { code: 'gateway/internal' });
});

test('UTF-8 output bounds preserve characters and both summary sections; raw keeps complete records', async () => {
  const large = events.map(event => structuredClone(event));
  large[3].data.message.content = [{ type: 'text', text: '验收🧪'.repeat(1000) }];
  const reader = createSessionReader(liveContext(large), { maxReadBytes: 512 });
  for (const mode of ['summary', 'tail', 'raw']) {
    const result = await reader.read({ sessionId: header.id, mode, last: 5 });
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 512);
    assert.doesNotMatch(result.text, /\uFFFD/);
    if (mode === 'raw') assert.deepEqual(result.text.split('\n').map(JSON.parse), [large.at(-1)]);
    if (mode === 'summary') assert.match(result.text, /最近用户指令：[\s\S]*给出交接清单/);
    if (mode === 'tail') assert.match(result.text, /turn\/end/);
  }
});

test('list adds cwd/activity/preview using live memory, without reading cold histories', async () => {
  const ctx = liveContext();
  ctx.sessionQuery = { listSessions: async () => [{ header, live: true }, { header: { ...header, id: 'cold' }, live: false }],
    readSession() { assert.fail('list must not read cold logs'); } };
  const registry = createSessionRegistry(ctx);
  const rows = (await registry.list()).sessions;
  assert.equal(rows[0].cwd, header.cwd);
  assert.equal(rows[0].updatedAt, 50);
  assert.equal(rows[0].lastAssistantAt, 40);
  assert.equal(rows[0].lastAssistantPreview, '修复已完成。 下一步：验收图片。');
  assert.equal(rows[1].lastAssistantAt, 0);
  assert.equal(rows[1].lastAssistantPreview, '');
});

test('expectReply adds a copyable return route; notifications stay short; unknown senders cannot request reply', async () => {
  const sent = [];
  const sender = { header: { id: 'session-requester' } };
  const ctx = { sessions: { get: id => id === sender.header.id ? sender : undefined },
    sessionController: { async prompt(request) { sent.push(request); return { accepted: true }; } } };
  const payload = { senderSessionId: sender.header.id, targetSessionId: header.id, text: '请列出待办' };
  await deliverToSession(ctx, { ...payload, expectReply: true });
  assert.match(sent[0].content[0].text, /targetSessionId="session-requester"/);
  assert.match(sent[0].content[0].text, /不会自动回传/);
  await deliverToSession(ctx, payload);
  assert.equal(sent[1].content[0].text, '[由 session-requester 发送]\n请列出待办');
  await assert.rejects(deliverToSession(ctx, { ...payload, senderSessionId: 'unknown', expectReply: true }), { code: 'bad-request' });
  ctx.sessionQuery = { observeSession: async () => { throw new Error('storage unavailable'); } };
  await assert.rejects(deliverToSession(ctx, { ...payload, senderSessionId: 'uncertain', expectReply: true }), { code: 'bad-request' });
  assert.equal(sent.length, 2);
});

test('tool supports read/peek, cwd filtering and preserves the existing delivery IDs', async () => {
  const ctx = liveContext();
  const tool = createSessionTelecomTool({ toolkit: { ctx }, defineTool: definition => definition,
    deliver: async (_ctx, payload) => {
      assert.equal(payload.expectReply, true);
      return { delivered: true, live: true, messageId: 'message-123', requestId: 'rpc-456', senderSessionId: 'sender', persisted: false };
    } });
  for (const action of ['read', 'peek']) {
    const value = await tool.execute({ action, sessionId: header.id }, {});
    assert.equal(value.ok, true);
    assert.match(tool.output.render({ action }, value)[0].text, /验收图片/);
    assert.equal(JSON.stringify(value).includes('null'), false);
  }
  const listed = await tool.execute({ action: 'list', query: '中文 项目' }, {});
  assert.equal(listed.sessions[0].id, header.id);
  assert.match(tool.output.render({ action: 'list' }, listed)[0].text, /cwd=E:/);
  const result = await tool.execute({ action: 'send', targetSessionId: header.id, text: '请回复', expectReply: true }, {});
  assert.equal(result.messageId, 'message-123');
  assert.equal(result.requestId, 'rpc-456');
  assert.equal(result.persisted, false);
  assert.match(tool.output.render({ action: 'send', expectReply: true }, result)[0].text, /messageId=message-123/);
});

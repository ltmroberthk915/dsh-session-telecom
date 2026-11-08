// 工具级唤醒（wake:'tool'）的单元测试：登记表 + tools/execute 中间件 + inbox 生命周期。
//
// 语义（见 lib/wake.js 顶部注释）：
//   - 默认 wake:'none'：任何工具都不碰。
//   - wake:'tool'：目标正在运行、且消息确实还在它的 next-step inbox 里时，结束目标**当前正在执行**
//     的那次（几次）工具调用（abort 本地 controller → exec.signal 中止），让 step 尽快结束，
//     内核在下一个 step 领取消息。
//   - 只处理工具调用：不中止整轮、不伪造结果、拿不到 inbox 投影时绝不 abort。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWakeRegistry, normalizeWakeMode, DEFAULT_WAKE_TTL_MS } from '../lib/wake.js';
import { SESSION_TELECOM_WAKE_MODES } from '../lib/api.js';

// ---------------------------------------------------------------- stubs

/** 最小 cordis ctx：只提供 wake.js 用到的 get / on（on 返回 disposer）。 */
function makeCtx({ agents = [] } = {}) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const listeners = new Map();
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => byId.get(id) };
      return undefined;
    },
    on(event, handler) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
  };
  return {
    ctx,
    emit(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
    middleware() {
      const set = listeners.get('tools/execute');
      assert.ok(set && set.size === 1, 'wake 必须只装一个 tools/execute 中间件');
      return [...set][0];
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

function makeAgent(id, { status = 'running', nextStep = [], withInbox = true } = {}) {
  return {
    id,
    status,
    ...(withInbox ? { inbox: { nextStep } } : {}),
  };
}

function makeMessage({ id = 'm-1', rpcId } = {}) {
  return {
    id,
    source: rpcId === undefined ? { kind: 'agent-message', form: 'relay', senderSessionId: 's-sender' } : { kind: 'user', rpcId },
  };
}

/** 跑一次工具调用：body 在 exec.signal 中止时 reject（模拟真实工具对 signal 的响应）。 */
function runTool(mw, exec) {
  const outcome = Promise.withResolvers();
  const body = () => {
    const { signal } = exec;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('completed'), 60);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  };
  mw(exec, body).then(outcome.resolve, outcome.reject);
  return outcome.promise;
}

// ---------------------------------------------------------------- 归一化

test('normalizeWakeMode：只有 tool 会打断，未知值一律回退 none', () => {
  assert.deepEqual([...SESSION_TELECOM_WAKE_MODES], ['none', 'tool']);
  assert.equal(normalizeWakeMode('tool'), 'tool');
  assert.equal(normalizeWakeMode('none'), 'none');
  assert.equal(normalizeWakeMode('interrupt'), 'none', '未知值不许变成"打别人工具"');
  assert.equal(normalizeWakeMode(undefined), 'none');
  assert.equal(normalizeWakeMode(true), 'none');
});

// ---------------------------------------------------------------- 中间件

test('wake=tool：目标正在跑工具时被结束，别的 agent 的工具不受影响', async () => {
  const target = makeAgent('s-target', { nextStep: [makeMessage({ rpcId: 'rpc-1' })] });
  const other = makeAgent('s-other', { nextStep: [] });
  const { ctx, middleware } = makeCtx({ agents: [target, other] });
  const registry = createWakeRegistry(ctx, {});
  const dispose = registry.install();
  const mw = middleware();

  const targetExec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const otherExec = { agent: other, signal: new AbortController().signal, name: 'pwsh' };
  const targetRun = runTool(mw, targetExec);
  const otherRun = runTool(mw, otherExec);

  const outcome = registry.request({ targetSessionId: 's-target', requestId: 'rpc-1', senderSessionId: 's-sender' });
  assert.deepEqual(outcome, { armed: true, fired: true }, '目标在跑工具 → 当场唤醒');
  await assert.rejects(targetRun, /needs this step to end/, '目标当前工具必须被 abort');
  assert.equal(targetExec.signal.aborted, true);
  assert.equal(otherExec.signal.aborted, false, '别的会话的工具绝不能被殃及');
  await otherRun; // 让它自然完成
  assert.equal(registry.diagnostics.fired, 1);
  dispose();
});

test('wake=none（不调用 request）时中间件原样放行', async () => {
  const target = makeAgent('s-target', { nextStep: [makeMessage({ rpcId: 'rpc-1' })] });
  const { ctx, middleware } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  const exec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const run = runTool(mw, exec);
  assert.equal(exec.signal.aborted, false);
  await run; // 1s 后自然完成
  assert.equal(registry.diagnostics.fired, 0);
});

test('工具先起跑、消息后到：消息到达时 abort 正在跑的工具', async () => {
  const target = makeAgent('s-target', { nextStep: [] });
  const { ctx, middleware } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  const exec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const run = runTool(mw, exec);
  // 消息先通过 steer 进 inbox，再登记唤醒（与真实投递顺序一致）
  target.inbox.nextStep.push(makeMessage({ rpcId: 'rpc-late' }));
  const outcome = registry.request({ targetSessionId: 's-target', requestId: 'rpc-late' });
  assert.deepEqual(outcome, { armed: true, fired: true });
  await assert.rejects(run, /needs this step to end/);
});

test('消息后起跑的工具（step 已进入工具执行）：工具启动时立刻结束自己', async () => {
  const target = makeAgent('s-target', { nextStep: [makeMessage({ rpcId: 'rpc-pre' })] });
  const { ctx, middleware } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  // 先登记：此时没有在跑的工具 → armed 但未 fired
  assert.deepEqual(registry.request({ targetSessionId: 's-target', requestId: 'rpc-pre' }), { armed: true, fired: false });
  const exec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const run = runTool(mw, exec);
  await assert.rejects(run, /needs this step to end/, 'wake 登记的下一步工具启动时就要结束它');
  assert.equal(registry.diagnostics.fired, 1);
});

// ---------------------------------------------------------------- 边界

test('目标空闲 / 冷会话 / 自己发给自己：都不登记、不打断', async () => {
  const idle = makeAgent('s-idle', { status: 'idle', nextStep: [] });
  const { ctx, middleware } = makeCtx({ agents: [idle] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  assert.deepEqual(registry.request({ targetSessionId: 's-idle', requestId: 'r1' }), { armed: false, fired: false, reason: 'idle' });
  assert.deepEqual(registry.request({ targetSessionId: 's-absent', requestId: 'r1' }), { armed: false, fired: false, reason: 'cold' });
  assert.deepEqual(
    registry.request({ targetSessionId: 's-idle', senderSessionId: 's-idle', requestId: 'r1' }),
    { armed: false, fired: false, reason: 'self' },
  );
  // 没有身份（既没 requestId 也没 messageId）不登记
  assert.deepEqual(registry.request({ targetSessionId: 's-idle' }), { armed: false, fired: false, reason: 'no-identity' });
  assert.equal(registry.pendingCount(), 0);
  void middleware;
});

test('拿不到 inbox 投影时：只登记、绝不 abort（宁可晚到也不误杀）', async () => {
  const target = makeAgent('s-target', { withInbox: false });
  const { ctx, middleware } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  const exec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const run = runTool(mw, exec);
  assert.deepEqual(registry.request({ targetSessionId: 's-target', requestId: 'rpc-x' }), { armed: true, fired: false });
  assert.equal(exec.signal.aborted, false, '无法确认消息还在 inbox → 不许打断');
  await run;
});

test('消息已被领取（claim）后 want 失效：后续工具不再被 abort', async () => {
  const message = makeMessage({ rpcId: 'rpc-done' });
  const target = makeAgent('s-target', { nextStep: [message] });
  const { ctx, middleware, emit } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  registry.request({ targetSessionId: 's-target', requestId: 'rpc-done' });
  // 内核把消息从 next-step 领走：inbox 清空 + claimed 事件
  target.inbox.nextStep.length = 0;
  emit('agent/inbox/claimed', { agent: target, message });
  assert.equal(registry.pendingCount(), 0, 'claim 后必须清掉 want');
  const exec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const run = runTool(mw, exec);
  assert.equal(exec.signal.aborted, false);
  await run;
});

test('消息已不在 inbox（discarded）时，request 当场丢弃、不 abort', async () => {
  const target = makeAgent('s-target', { nextStep: [] });
  const { ctx, middleware } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  const exec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const run = runTool(mw, exec);
  assert.deepEqual(registry.request({ targetSessionId: 's-target', requestId: 'rpc-gone' }), { armed: true, fired: false });
  assert.equal(registry.pendingCount(), 0, 'inbox 里已经没有这条消息 → 立刻丢弃 want');
  assert.equal(exec.signal.aborted, false);
  await run;
});

test('messageId 匹配（自研 agents 路径）', async () => {
  const message = makeMessage({ id: 'msg-42' });
  const target = makeAgent('s-target', { nextStep: [message] });
  const { ctx, middleware } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  registry.install();
  const mw = middleware();
  const exec = { agent: target, signal: new AbortController().signal, name: 'pwsh' };
  const run = runTool(mw, exec);
  assert.deepEqual(registry.request({ targetSessionId: 's-target', messageId: 'msg-42' }), { armed: true, fired: true });
  await assert.rejects(run, /needs this step to end/);
});

test('agent 销毁时清掉登记；dispose 幂等且摘掉中间件', () => {
  const target = makeAgent('s-target', { nextStep: [makeMessage({ rpcId: 'rpc-d' })] });
  const { ctx, emit, listenerCount } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, {});
  const dispose = registry.install();
  assert.equal(listenerCount('tools/execute'), 1);
  registry.request({ targetSessionId: 's-target', requestId: 'rpc-d' });
  assert.equal(registry.pendingCount(), 1);
  emit('agent/disposed', { agent: target });
  assert.equal(registry.pendingCount(), 0);
  dispose();
  dispose();
  assert.equal(listenerCount('tools/execute'), 0);
  assert.equal(registry.isInstalled(), false);
});

test('enabled:false 时完全不动（profile 级禁用开关）', () => {
  const target = makeAgent('s-target', { nextStep: [makeMessage({ rpcId: 'rpc-off' })] });
  const { ctx } = makeCtx({ agents: [target] });
  const registry = createWakeRegistry(ctx, { enabled: false });
  assert.deepEqual(registry.request({ targetSessionId: 's-target', requestId: 'rpc-off' }), { armed: false, fired: false, reason: 'disabled' });
  assert.equal(registry.pendingCount(), 0);
  assert.equal(DEFAULT_WAKE_TTL_MS, 5 * 60 * 1000);
});

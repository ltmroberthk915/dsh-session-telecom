// 与内核真源的**行为对照**（可选测试）。
//
// 为什么单独一个文件：`dsh-session-telecom` 平时装在 `profiles/<profile>/node_modules` 下，
// workspace 源码里解析不到 `@deepseek-ai/*`（profiles/node_modules 不是它的祖先目录）。
// 所以这里用**绝对 file URL** 动态 import 内核实现；解析不到就 skip —— 别的机器上不该变红，
// 但本机（内核只读副本在场）必须真的跑起来，用它证明"逐字照抄"不是嘴上说说。
//
// 对照对象：
//   hasSessionSubagentOwner  ←→  dsh-api-session-controller/lib/types/agent.js:106-114
//   agentBusy 的 code/details ←→  apiSessionSubagentOwnershipError（同文件 :120-122）
//   插件产出的 source 形状     ←→  dsh-session-format-v2-to-v3 的真实 v2 事件校验器（R1）
//
// R1 的现场勘误（本次实测，比审计报告更准）：空串 senderSessionId 在**当前版本加载/写入**时
// 不会立刻炸（v3 侧 restoreReleasedV3Artifact 不校验 source），它真正立刻造成的后果是
// GUI 降级成 opaque 渲染（dsh-client-ui-chat/lib/client.js:741-744,860）；
// 而 v2→v3 迁移的事件校验器（lib/index.js:717 assertEvent(event,2) → :98-99/:123-133）会硬拒。
// 也就是说：今天丢的是渲染来源标记，将来丢的是整条日志的可迁移性。
//
// 跑法：node test/host-kernel-alignment.test.mjs（`node --test` 在 DSH 沙箱里 spawn EPERM）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildRelayMessage, hasSessionSubagentOwner } from '../lib/index.js';
import { fallbackCreateUserMessage } from '../lib/message.js';
import { agentBusy } from '../lib/errors.js';

/** 默认内核根；可用 DSH_KERNEL_ROOT 覆盖（例如指向另一个 profile 的 node_modules）。 */
const KERNEL_ROOT = process.env.DSH_KERNEL_ROOT ?? join(homedir(), '.dsh', 'profiles', 'node_modules');
const KERNEL_AGENT = `${KERNEL_ROOT}/@deepseek-ai/dsh-api-session-controller/lib/types/agent.js`;
const KERNEL_FORMAT = `${KERNEL_ROOT}/@deepseek-ai/dsh-session-format-v2-to-v3/lib/index.js`;

let kernel;
let kernelError;
try {
  kernel = await import(pathToFileURL(KERNEL_AGENT).href);
} catch (error) {
  kernelError = error;
}

let format;
let formatError;
try {
  format = await import(pathToFileURL(KERNEL_FORMAT).href);
} catch (error) {
  formatError = error;
}

const skip = typeof kernel?.hasApiSessionSubagentOwner !== 'function'
  ? `内核包不可用（${KERNEL_AGENT}: ${kernelError?.message ?? 'no export'}）`
  : false;
const skipFormat = typeof format?.sessionFormatV2ToV3?.createStage !== 'function'
  ? `内核格式包不可用（${KERNEL_FORMAT}: ${formatError?.message ?? 'no export'}）`
  : false;

/** 同时满足内核与插件两个实现的 stub ctx（内核只用 agents.get / agents.isOwnedBy）。 */
function stubCtx({ parentId = 'p', parentLive = true, ownership = 'owned' } = {}) {
  const parentAgent = { id: parentId };
  const childAgent = { id: 'c' };
  return {
    childAgent,
    parentAgent,
    agents: {
      get: (id) => (id === parentId && parentLive ? parentAgent : undefined),
      isOwnedBy: (id, owner) => ownership === 'owned' && id === 'c' && owner === parentAgent,
    },
  };
}

test('hasSessionSubagentOwner 与内核 hasApiSessionSubagentOwner 在同一组输入上逐例一致', { skip }, () => {
  const cases = [
    { label: 'origin=subagent（冷/热都一样拒）', ctx: stubCtx(), session: { header: { origin: 'subagent' } }, agent: undefined, expected: true },
    { label: 'origin=subagent + live agent', ctx: stubCtx(), session: { header: { origin: 'subagent' } }, agent: { id: 'c' }, expected: true },
    { label: 'live 子会话被活父拥有', ctx: stubCtx(), session: { header: { parentSession: 'p' } }, agent: { id: 'c' }, expected: true },
    { label: '冷会话（第三参 undefined）→ 内核返回 false', ctx: stubCtx(), session: { header: { parentSession: 'p' } }, agent: undefined, expected: false },
    { label: 'live 但父不承认所有权', ctx: stubCtx({ ownership: 'free' }), session: { header: { parentSession: 'p' } }, agent: { id: 'c' }, expected: false },
    { label: '父 agent 不 live', ctx: stubCtx({ parentLive: false }), session: { header: { parentSession: 'p' } }, agent: { id: 'c' }, expected: false },
    { label: '普通根会话', ctx: stubCtx(), session: { header: { id: 'x' } }, agent: { id: 'c' }, expected: false },
    { label: '有 parentSession 但 live 父子关系不成立', ctx: stubCtx(), session: { header: { parentSession: 'other' } }, agent: { id: 'c' }, expected: false },
  ];
  for (const item of cases) {
    const mine = hasSessionSubagentOwner(item.ctx, item.session, item.agent);
    const theirs = kernel.hasApiSessionSubagentOwner(item.ctx, item.session, item.agent);
    assert.equal(mine, theirs, `${item.label}：插件=${mine} 内核=${theirs}`);
    assert.equal(mine, item.expected, `${item.label}：期望 ${item.expected}`);
  }
});

test('session/agent-busy 的 code / message / reason 与内核 apiSessionSubagentOwnershipError 一致', { skip }, () => {
  const theirs = kernel.apiSessionSubagentOwnershipError('s-1');
  const mine = agentBusy('s-1');
  assert.equal(mine.code, theirs.code);
  assert.equal(mine.message, theirs.message);
  assert.equal(mine.details.reason, theirs.details.reason);
  assert.equal(mine.code, 'session/agent-busy');
  assert.equal(mine.details.reason, 'use subagent delivery for this child session');
  assert.equal(mine.details.sessionId, 's-1');
});

test('插件判定对畸形输入不抛（内核版假定 header 一定存在）', () => {
  // 内核实现直接读 session.header.origin；插件要能在 stub / 半成品 ctx 上活下来。
  for (const malformed of [undefined, null, {}, { header: null }, { header: {} }, 'string', 42]) {
    assert.doesNotThrow(() => hasSessionSubagentOwner({}, malformed, undefined));
    assert.equal(hasSessionSubagentOwner({}, malformed, undefined), false);
  }
});

/**
 * 把一条 user/message 丢进内核真实的 v2→v3 迁移事件校验器（lib/index.js:717 → :98-99）。
 * 返回 {ok} 或 {ok:false, name, message}；**只有 source 相关的失败**才与我们有关。
 */
function kernelV2SourceCheck(source) {
  const header = { version: 2, id: 's-probe', createdAt: 1, isSeeded: true, delegationDepth: 0 };
  const stage = format.sessionFormatV2ToV3.createStage({ sourceHeader: header });
  const data = { role: 'user', id: 'm-1', content: [{ type: 'text', text: 'hi' }], source };
  try {
    stage.transformEvent({ type: 'user/message', seq: 0, time: 1, data, surfaceOp: 'append' }, undefined);
    return { ok: true };
  } catch (error) {
    return { ok: false, name: error.name, message: String(error.message) };
  }
}

test('R1 现场证明：内核 v2 校验器硬拒空 senderSessionId，而插件两种产出都过关', { skip: skipFormat }, () => {
  const SOURCE_REJECTION = /agent-message source requires relay form and senderSessionId/;

  // ① 旧写法（空串）被内核直接拒 —— 这就是 R1 必须修的原因
  const bad = kernelV2SourceCheck({ kind: 'agent-message', form: 'relay', senderSessionId: '' });
  assert.equal(bad.ok, false, '空 senderSessionId 必须被内核拒收');
  assert.equal(bad.name, 'SessionFormatError');
  assert.match(bad.message, SOURCE_REJECTION);

  const badForm = kernelV2SourceCheck({ kind: 'agent-message', form: 'notice', senderSessionId: 's-x' });
  assert.equal(badForm.ok, false);
  assert.match(badForm.message, SOURCE_REJECTION, 'form 只能是 relay');

  // ② 插件"有发信方"的产出：过 source 校验（后面的失败属于时序问题，与 source 无关）
  const relay = kernelV2SourceCheck(
    buildRelayMessage({ text: 'hi', senderSessionId: 's-x', factory: fallbackCreateUserMessage }).source,
  );
  assert.ok(!SOURCE_REJECTION.test(relay.message ?? ''), `agent-message 产出必须过 source 校验：${relay.message ?? 'accepted'}`);

  // ③ 插件"无发信方"的产出（{kind:'user'}）：同样过 source 校验
  const opaque = kernelV2SourceCheck(buildRelayMessage({ text: 'hi', factory: fallbackCreateUserMessage }).source);
  assert.ok(!SOURCE_REJECTION.test(opaque.message ?? ''), `user 产出必须过 source 校验：${opaque.message ?? 'accepted'}`);
});

test('R1 边界：v3 侧校验器不查 source（所以空串的即时伤害是 GUI 降级，不是写盘失败）', { skip: skipFormat }, () => {
  // 这条断言是为了把"受伤程度"说准：审计说"将来会被判损坏"是对的，
  // 但**当前** v3 入口（restoreReleasedV3Artifact）根本不看 source —— 别把 R1 说成"今天就会炸"。
  const header = { version: 3, id: 's-probe', createdAt: 1, isSeeded: false, delegationDepth: 0 };
  const event = {
    type: 'user/message',
    seq: 0,
    time: 1,
    data: {
      role: 'user',
      id: 'm-1',
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: '' },
    },
    surfaceOp: 'append',
  };
  assert.doesNotThrow(() => format.restoreReleasedV3Artifact({ header, inheritedEventCount: 0, events: [event] }, new Set()));
});

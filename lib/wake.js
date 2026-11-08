// 工具级唤醒（wake:"tool"）：让"发送方主动决定打断"在宿主里真正生效。
//
// 背景：内核的 steer 只在 **step 边界** 被领取（dsh-agent-loop/lib/index.js:906 preStep → inbox.claim）。
// 目标正卡在一次长工具调用里（sleep/构建/脚本/等子代理）时，消息已经进了 next-step inbox，
// 但谁也领不到它 —— 实测卡过 4 分钟。用户 2026-11-08 的选择：
//   ① 不打断（默认，wake:'none'，现状）
//   ② 工具级唤醒（wake:'tool'，推荐）：结束目标**当前正在执行的那次工具调用**，
//      让 step 尽快结束，消息在下一个 step 立刻被领取。
//
// 为什么不用 sessionController.cancel（整轮中断）：
//   - cancel = agent.cancel({kind:'user'}, {keepInbox:true})（api-session-controller/lib/types/commands.js:448-458）
//     会结束整轮；UI 显示"已中止"，同 step 的其它工具一起死；
//   - cancel 之后内核**不会自动唤醒**留下的 inbox（agent-loop 的 wakeRequested 只在
//     maintenance / aborted 时置位，见 dsh-agent-loop/lib/index.js:800-869），
//     插件还得自己补一次唤醒，否则消息反而更卡。所以不做这个。
//
// 工具级唤醒的实现（与 dsh-team-flow-continuous 的 wait_agent 唤醒同一套机制）：
//   - 装一个 `tools/execute` 中间件（dsh-tools/lib/pipeline.js:492 的 waterfall），
//     给每次工具调用登记一个 trigger，并把 `exec.signal` 换成本地 controller 与调用方信号的
//     `AbortSignal.any([caller, controller.signal])`（team-flow 同款：wake-core.js:93-110）；
//   - 发送方请求 wake 时，如果目标 agent 正在运行，就把 want 登记进 wants，对目标当前
//     在跑的所有工具 trigger 一次（abort 本地 controller）；
//   - 工具收到 abort → dsh-tools 的 dispatchToolBody 把异常收敛成**工具错误结果**
//     （pipeline.js:459-475 + toolErrorResult :850-863），step 不会整体失败；
//   - step 结束 → 下一个 preStep 领取 next-step 里的消息。整轮不中止、其它工具不受影响、
//     inbox 不丢。
//
// 诚实失败：我们**不伪造工具结果**。工具照常收到 abort（模型看到 "Error: …"），
// 由目标模型自己决定下一步是否重试（与用户给 team-flow 写的 issue 里"诚实失败"原则一致）。
//
// 不打断谁都靠不住：无法确认消息仍在 inbox（拿不到 inbox 投影）时**绝不 abort**，宁可不唤醒。

import { SESSION_TELECOM_WAKE_MODES } from './api.js';
import { tryGet } from './session-registry.js';

/** want 的默认存活时间：超时后不再打断后续工具（防止几天后突然 abort 别人的工具）。 */
export const DEFAULT_WAKE_TTL_MS = 5 * 60 * 1000;

/**
 * wake 值归一：未知值回退 'none'（默认不打断）。
 * @param {unknown} value
 * @returns {'none'|'tool'}
 */
export function normalizeWakeMode(value) {
  return SESSION_TELECOM_WAKE_MODES.includes(value) ? value : 'none';
}

/**
 * 造一个唤醒登记表 + `tools/execute` 中间件。
 *
 * 语义：`request()` 只负责"登记 + 当前在跑的工具立刻 abort"；真正把消息交给目标仍然由
 * 内核的 steer/inbox 完成（本模块只负责让 step 边界早点到）。
 *
 * @param {object} ctx - cordis host 上下文（或测试 stub）。
 * @param {object} [options]
 * @param {(error: unknown) => void} [options.onWarn] - 安装/回调异常的统一出口。
 * @param {number} [options.ttlMs] - want 存活时间，默认 5 分钟。
 * @param {boolean} [options.enabled] - 关掉时 request() 一律不登记（用于 profile 级禁用）。
 * @returns {object} registry
 */
export function createWakeRegistry(ctx, options = {}) {
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_WAKE_TTL_MS;
  const enabled = options.enabled !== false;
  /** agentId → Set<want>；want = {agentId, requestId?, messageId?, timer?} */
  const wants = new Map();
  /** agentId → Set<trigger>；trigger(want) 会 abort 它所属的那次工具调用 */
  const triggers = new Map();
  const disposers = [];
  let installed = false;
  const diagnostics = { armed: 0, fired: 0, abortedTools: 0, cleared: 0, disabled: !enabled };

  function liveAgent(agentId) {
    try {
      return tryGet(ctx, 'agents')?.get?.(agentId);
    } catch {
      return undefined;
    }
  }

  /** want 与 inbox 里的消息是否是同一条（prompt 路径按 rpcId，自研路径按 messageId）。 */
  function matches(want, message) {
    if (message === null || typeof message !== 'object') return false;
    if (typeof want.messageId === 'string' && want.messageId.length > 0 && message.id === want.messageId) return true;
    if (typeof want.requestId === 'string' && want.requestId.length > 0) {
      const source = message.source;
      return source !== null && typeof source === 'object' && source.kind === 'user' && source.rpcId === want.requestId;
    }
    return false;
  }

  /**
   * 消息是否还在 next-step inbox 里。
   * @returns {boolean|undefined} true/false；拿不到 inbox 投影时 undefined（**绝不**据此 abort）。
   */
  function stillPending(agent, want) {
    const inbox = agent?.inbox;
    if (inbox === null || typeof inbox !== 'object' || !Array.isArray(inbox.nextStep)) return undefined;
    return inbox.nextStep.some((message) => matches(want, message));
  }

  function drop(want) {
    const set = wants.get(want.agentId);
    if (set === undefined) return false;
    const removed = set.delete(want);
    if (set.size === 0) wants.delete(want.agentId);
    if (want.timer !== undefined) {
      clearTimeout(want.timer);
      want.timer = undefined;
    }
    if (removed) diagnostics.cleared += 1;
    return removed;
  }

  /** 对某个 agent 的所有在跑工具触发一次唤醒；返回是否真的 abort 了。 */
  function fire(agentId) {
    const set = wants.get(agentId);
    const group = triggers.get(agentId);
    if (set === undefined || set.size === 0 || group === undefined || group.size === 0) return false;
    const agent = liveAgent(agentId);
    if (agent === undefined) return false;
    let fired = false;
    for (const want of [...set]) {
      // 严格模式：消息必须确认还在 inbox 里才打断，拿不到投影就不动。
      const pending = stillPending(agent, want);
      if (pending === false) {
        drop(want);
        continue;
      }
      if (pending !== true) continue;
      for (const trigger of [...group]) if (trigger(want) === true) fired = true;
    }
    return fired;
  }

  /**
   * 给一次工具调用登记 trigger（并替换成可被本地 abort 的 exec.signal）。
   * 只对带 agent 的工具调用生效；没有 agent 的工具（纯宿主工具）不动。
   */
  function wrapExec(exec) {
    const agent = exec?.agent;
    if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') return undefined;
    const caller = exec.signal;
    if (caller === null || caller === undefined || typeof caller.addEventListener !== 'function') return undefined;
    const agentId = agent.id;
    const controller = new AbortController();
    let fused;
    try {
      fused = AbortSignal.any([caller, controller.signal]);
    } catch {
      return undefined;
    }
    exec.signal = fused;
    const trigger = (want) => {
      if (controller.signal.aborted || caller.aborted) return false;
      const live = liveAgent(agentId);
      if (live === undefined || live.status !== 'running') return false;
      const pending = stillPending(live, want);
      if (pending === false) {
        drop(want);
        return false;
      }
      if (pending !== true) return false;
      diagnostics.fired += 1;
      diagnostics.abortedTools += 1;
      controller.abort(new Error('dsh-session-telecom: a peer message needs this step to end'));
      return true;
    };
    let group = triggers.get(agentId);
    if (group === undefined) {
      group = new Set();
      triggers.set(agentId, group);
    }
    group.add(trigger);
    return {
      trigger,
      remove() {
        group.delete(trigger);
        if (group.size === 0) triggers.delete(agentId);
      },
    };
  }

  /** `tools/execute` 中间件（dsh-tools/lib/pipeline.js:492 的 waterfall）。 */
  async function middleware(exec, next) {
    const wrapped = wrapExec(exec);
    if (wrapped === undefined) return await next();
    try {
      // 消息可能在本次工具启动**之前**就到了（例如 step 已进入工具执行），先试一次。
      fire(exec.agent.id);
      return await next();
    } finally {
      wrapped.remove();
    }
  }

  function onSettled(payload) {
    const agent = payload?.agent;
    const message = payload?.message;
    if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') return;
    const set = wants.get(agent.id);
    if (set === undefined) return;
    for (const want of [...set]) if (matches(want, message)) drop(want);
  }

  function onDisposed(payload) {
    const agent = payload?.agent;
    if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string') return;
    wants.delete(agent.id);
    triggers.delete(agent.id);
  }

  /**
   * 登记一次"工具级唤醒"。
   *
   * @param {object} request
   * @param {string} request.targetSessionId - 目标会话 id。
   * @param {string} [request.senderSessionId] - 发信会话 id（自身投递不打断）。
   * @param {string} [request.requestId] - prompt 路径的幂等键（消息 source.rpcId）。
   * @param {string} [request.messageId] - 自研路径的消息 id。
   * @returns {{armed: boolean, fired: boolean, reason?: string}} armed=目标在运行且已登记；fired=已 abort 在跑的工具
   */
  function request(input = {}) {
    if (!enabled) return { armed: false, fired: false, reason: 'disabled' };
    const targetSessionId = input.targetSessionId;
    if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) {
      return { armed: false, fired: false, reason: 'bad-target' };
    }
    if (typeof input.senderSessionId === 'string' && input.senderSessionId === targetSessionId) {
      // 自发自收：打断自己正在执行的这次 send 没有意义，也危险。
      return { armed: false, fired: false, reason: 'self' };
    }
    const requestId = typeof input.requestId === 'string' && input.requestId.length > 0 ? input.requestId : undefined;
    const messageId = typeof input.messageId === 'string' && input.messageId.length > 0 ? input.messageId : undefined;
    if (requestId === undefined && messageId === undefined) {
      return { armed: false, fired: false, reason: 'no-identity' };
    }
    const agent = liveAgent(targetSessionId);
    if (agent === undefined) return { armed: false, fired: false, reason: 'cold' };
    if (agent.status !== 'running') return { armed: false, fired: false, reason: 'idle' };

    const want = { agentId: targetSessionId, ...(requestId === undefined ? {} : { requestId }), ...(messageId === undefined ? {} : { messageId }), timer: undefined };
    let set = wants.get(targetSessionId);
    if (set === undefined) {
      set = new Set();
      wants.set(targetSessionId, set);
    }
    set.add(want);
    diagnostics.armed += 1;
    want.timer = setTimeout(() => { drop(want); }, ttlMs);
    want.timer.unref?.();
    const fired = fire(targetSessionId);
    return { armed: true, fired };
  }

  /**
   * 安装中间件与 inbox 生命周期监听。
   * @returns {() => void} disposer（幂等）
   */
  function install() {
    if (installed) return () => {};
    installed = true;
    const listen = (event, handler) => {
      try {
        if (typeof ctx?.on !== 'function') return;
        const dispose = ctx.on(event, handler);
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        onWarn(error);
      }
    };
    listen('tools/execute', middleware);
    // 消息被领取/丢弃 → 对应 want 立刻失效，避免后续步骤再被 abort。
    listen('agent/inbox/claimed', onSettled);
    listen('agent/inbox/discarded', onSettled);
    listen('agent/disposed', onDisposed);
    return dispose;
  }

  function dispose() {
    for (const disposer of disposers.splice(0)) {
      try {
        disposer();
      } catch {
        /* 卸载失败不影响插件卸载 */
      }
    }
    for (const set of wants.values()) for (const want of set) if (want.timer !== undefined) clearTimeout(want.timer);
    wants.clear();
    triggers.clear();
    installed = false;
  }

  return {
    request,
    install,
    dispose,
    diagnostics,
    /** 测试/诊断用：当前登记的 want 数。 */
    pendingCount() {
      let count = 0;
      for (const set of wants.values()) count += set.size;
      return count;
    },
    /** 测试/诊断用。 */
    isInstalled() {
      return installed;
    },
  };
}

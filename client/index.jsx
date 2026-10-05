/**
 * dsh-session-telecom · Client 半（浏览器侧）
 *
 * 职责：
 *   1. 在会话行的右键「⋯」菜单里加一行「复制会话 ID」（order 250，落在
 *      重命名 200 与分叉 300 之间），点击后写剪贴板并给出可见反馈。
 *   2. 加一行「发送消息到会话…」（order 260）：打开一个模态，用 sessions/list
 *      选出目标会话、输入文本，经 sessions/send 投递到对方的收件箱。
 *
 * 依据的真实宿主契约（均已核对源码，不是猜的）：
 *   - 槽位：`sidebar.workspaces.session.menu.item`，由
 *     @deepseek-ai/dsh-client-ui-workspace 的 `sidebar.workspaces` Factory 声明
 *     （kind=list / scope=root），宿主自己注册 pin=100 / rename=200 / fork=300 /
 *     archive=400。
 *     见 …/dsh-client-ui-workspace/lib/client.js:4306（声明）、4331-4360（宿主注册）。
 *   - 该行收到的 owner props：`{ sessionId, displayTitle }`
 *     （renderSlot 调用点在同文件 1661-1664 行）。
 *   - 槽位自带注入 `{ hooks: { menuOpenState: menuOpenStateFactory } }`，
 *     渲染器把 hooks 转成 `useXxx` 形式的 prop，故组件拿到 `useMenuOpenState`：
 *     调用它返回 `[menuOpen, setMenuOpen]`（宿主 1580 行的 useMemo 对）。
 *     hookContext 由行组件在 renderSlot 第三参传入（同文件 1664 行）。
 *     —— 见 dsh-client-ui-renderer/lib/client.js 的 renderEntry/ContextualEntry。
 *   - 注册 API：`ctx.slots.inject(key, cb)` + `ctx.slots.register({name, id, order,
 *     locale, registrant}, Component)`；回调只在槽位被声明后执行，卸载时自动回收。
 *   - i18n：`ctx.locale.register(ns, { zh, en })` 返回 disposer；
 *     `entry.locale = ns` 会让渲染器给组件注入 `t` 座位（kit.t），
 *     缺失时 `t(key)` 原样返回 key —— 所以本文件另备中英内联兜底。
 *   - RPC：`ctx.connection.rpc.call(channel, endpoint, payload, signal)`
 *     （信封由框架处理），通道 `/dsh-session-telecom`（单段！见下方常量处说明）。
 *   - 模态挂 `shell.overlay`（由 dsh-client-ui-layout 的 AppFrame 声明为
 *     kind=list / scope=root，见 dsh-client-ui-layout/lib/client.js:617、312）。
 *     菜单行选中后会随菜单一起卸载，所以模态状态必须放模块级 store，
 *     由 overlay 槽位里的常驻组件订阅渲染。
 *
 * 约束：只 import `react`（external），不碰宿主包的深路径，也不 import
 * ui-primitives —— 菜单行/提示/模态全部用原生 DOM + 宿主 CSS 变量自绘，
 * 避免打包期内联失败。
 */

import * as React from 'react';

export const name = 'dsh-session-telecom';

/** 需要的客户端服务：slots（槽位）与 connection（Host RPC）。 */
export const inject = ['slots', 'connection'];

// ---------------------------------------------------------------- 常量

/**
 * RPC 通道（必须与 lib/api.js 的 SESSION_TELECOM_RPC_CHANNEL 逐字一致）。
 *
 * ⚠ **只能有一个路径段**：客户端 `ctx.connection.rpc.call` 在发请求前跑 `assertTarget`
 * （dsh-client-connection/lib/client.js:1317-1320），其 `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`
 * 不允许 `/`。曾经写成 `/api/dsh-session-telecom`，于是浏览器侧直接抛
 * `connection: invalid RPC target ...`、请求根本没出门，UI 显示"宿主未就绪"——
 * 而宿主侧是好的（路由已挂、别的通道也活着），排查方向很容易跑偏。
 */
const RPC_CHANNEL = '/dsh-session-telecom';
const LOCALE_NS = 'dsh-session-telecom';
const REGISTRANT = 'dsh-session-telecom';

const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
const OVERLAY_SLOT = 'shell.overlay';
const COPY_ENTRY_ID = 'session-toolkit-copy-id';
const COPY_ENTRY_ORDER = 250;
const SEND_ENTRY_ID = 'session-toolkit-send-message';
const SEND_ENTRY_ORDER = 260;

const STYLE_TAG_ID = 'dsh-session-telecom/client.css';
const TOAST_LAYER_ID = 'dsh-session-telecom-toasts';

/** 复制成功的轻提示停留时长（需求：1.8s 自动消失）。 */
const TOAST_HOLD_SUCCESS_MS = 1800;
/** 失败提示要能读完原因，给更长时间。 */
const TOAST_HOLD_ERROR_MS = 4200;

// ---------------------------------------------------------------- i18n

const ZH = {
  'menu.copySessionId': '复制会话 ID',
  'menu.sendMessage': '发送消息到会话…',
  'toast.copied': '已复制会话 ID',
  'toast.copyFailed': '复制会话 ID 失败',
  'toast.openFailed': '打开发送消息窗口失败',
  'toast.sent': '已投递到 {title}',
  'toast.woken': '目标会话原本是冷的，宿主已自动唤醒它',
  'dialog.title': '发送消息到会话',
  'dialog.close': '关闭',
  'dialog.search': '搜索会话',
  'dialog.searchPlaceholder': '按标题、会话 ID 或工作区过滤…',
  'dialog.target': '目标会话',
  'dialog.text': '消息内容',
  'dialog.mode': '投递方式',
  'dialog.mode.queue': '排队投递',
  'dialog.mode.steer': '立即引导',
  'dialog.placeholder': '输入要投递的消息…（Enter 发送，Shift+Enter 换行）',
  'dialog.send': '发送',
  'dialog.cancel': '取消',
  'dialog.sending': '投递中…',
  'dialog.loading': '正在读取会话列表…',
  'dialog.hostNotReady': '宿主未就绪',
  'dialog.empty': '没有匹配的会话',
  'dialog.untitled': '（无标题会话）',
  'dialog.self': '本会话',
  'dialog.running': '运行中',
  'dialog.live': '在线',
  'dialog.archived': '已归档',
  'dialog.retry': '重试',
  'dialog.semantics': '这条消息会以「用户消息」的形式出现在目标会话的时间线上（对方看到的是有人发来消息，而不是它自己的输入），排队等它的下一回合处理；目标会话是冷会话时宿主会自动唤醒它。',
  'dialog.channel': '投递通道',
  'dialog.channel.direct': '（非 prompt 路径）',
  'dialog.costTip': '「计费」= 非缓存输入 + 输出（真正按全价计费的 token）；「缓存」= 输入里走缓存的比例，越高越省',
  'dialog.costTotal': '这些会话累计计费',
  'dialog.costCache': '缓存命中',
  'error.emptyText': '请先输入消息内容',
  'error.noTarget': '请先选择目标会话',
  'error.gateway': '宿主网关错误',
};

const EN = {
  'menu.copySessionId': 'Copy session ID',
  'menu.sendMessage': 'Send message to session…',
  'toast.copied': 'Session ID copied',
  'toast.copyFailed': 'Failed to copy the session ID',
  'toast.openFailed': 'Could not open the send-message dialog',
  'toast.sent': 'Delivered to {title}',
  'toast.woken': 'The target session was cold; the host woke it up',
  'dialog.title': 'Send a message to a session',
  'dialog.close': 'Close',
  'dialog.search': 'Search sessions',
  'dialog.searchPlaceholder': 'Filter by title, session ID or workspace…',
  'dialog.target': 'Target session',
  'dialog.text': 'Message',
  'dialog.mode': 'Delivery',
  'dialog.mode.queue': 'Queue',
  'dialog.mode.steer': 'Steer now',
  'dialog.placeholder': 'Type the message… (Enter sends, Shift+Enter adds a line)',
  'dialog.send': 'Send',
  'dialog.cancel': 'Cancel',
  'dialog.sending': 'Delivering…',
  'dialog.loading': 'Loading sessions…',
  'dialog.hostNotReady': 'Host not ready',
  'dialog.empty': 'No session matches',
  'dialog.untitled': '(untitled session)',
  'dialog.self': 'this session',
  'dialog.running': 'running',
  'dialog.live': 'live',
  'dialog.archived': 'archived',
  'dialog.retry': 'Retry',
  'dialog.semantics': 'The message lands on the target timeline as a user message (the target sees an incoming message, not its own input) and waits in the queue for its next turn; a cold target is woken up by the host.',
  'dialog.channel': 'Delivery channel',
  'dialog.channel.direct': ' (not the prompt path)',
  'dialog.costTip': '"billed" = uncached input + output (the tokens actually charged at full price); "cache" = share of input served from cache, higher is cheaper',
  'dialog.costTotal': 'Billed across these sessions',
  'dialog.costCache': 'cache hit',
  'error.emptyText': 'Type a message first',
  'error.noTarget': 'Pick a target session first',
  'error.gateway': 'Host gateway error',
  'error.session/not-found': 'The target session does not exist or was deleted',
  'error.session/archived': 'The target session is archived; cannot deliver',
  'error.session/busy': 'The target session is busy, try again later',
  'error.session/agent-busy': 'The target session is held by its parent session or a subagent; cannot insert a message right now',
  'error.session/writer-held': 'Another DSH instance is writing to the target session; close it there first',
  'error.session/steer-unavailable': 'The target session does not accept steer delivery; use queue instead',
  'error.cancelled': 'Delivery was cancelled',
  'error.bad-request': 'Invalid request: check the target session and the message body',
  'error.unauthorized': 'Not allowed to deliver to that session',
  'error.forbidden': 'Not allowed to deliver to that session',
  'error.gateway/unavailable': 'Host not ready: the RPC gateway is unavailable',
  'error.gateway/timeout': 'The host timed out, try again later',
  'error.gateway/not-found': 'The host has no such RPC endpoint (the host half may not be installed)',
  'error.gateway/internal': 'Internal host error',
  'error.gateway/error': 'Internal host error',
};

/**
 * 取本地化文案，取不到就回退到内联文案。
 * `t` 不存在（未声明 locale，或 locale 插件缺席）时同样走回退，
 * 保证中文永远显示得出来。
 * @param t - 渲染器注入的翻译座位（可能不存在）。
 * @param key - 命名空间内的键。
 * @param fallback - 内联兜底（中文）。
 * @returns 展示文案。
 */
function pickLabel(t, key, fallback) {
  if (typeof t !== 'function') return fallback;
  try {
    const value = t(key);
    if (typeof value === 'string' && value.length > 0 && value !== key) return value;
  } catch {
    /* 翻译失败不致命，用兜底 */
  }
  return fallback;
}

/** 把任意抛出物摘成可读的一行原因。 */
function describeError(error) {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  try {
    if (error instanceof Error) {
      return error.name ? `${error.name}: ${error.message}` : String(error.message ?? error);
    }
    const code = error.code === undefined ? '' : String(error.code);
    const message = error.message === undefined ? '' : String(error.message);
    if (code !== '' || message !== '') return code !== '' && message !== '' ? `${code}: ${message}` : code || message;
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ---------------------------------------------------------------- 样式

const CSS = `
.dstk-menu-row { position: relative; }
.dstk-menu-item {
  display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px;
  padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md, 8px);
  background: transparent; cursor: pointer; font-family: inherit; font-size: 13px;
  line-height: 20px; color: var(--dsw-alias-label-primary, #111827); text-align: left;
}
.dstk-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.dstk-menu-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); outline: none; }
.dstk-menu-item:disabled { opacity: .4; cursor: not-allowed; }
.dstk-menu-icon {
  display: inline-flex; flex: none; width: 14px; height: 14px;
  align-items: center; justify-content: center; color: var(--dsw-alias-menu-icon, #6b7280);
}
.dstk-menu-icon svg { display: block; width: 14px; height: 14px; }
.dstk-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dstk-toast-layer {
  position: fixed; top: 40px; left: 50%; transform: translateX(-50%); z-index: 1200;
  display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
}
.dstk-toast {
  display: flex; align-items: center; gap: 10px; width: max-content;
  max-width: min(640px, calc(100vw - 48px)); padding: 12px 16px;
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-toast-bg, #1f2937); color: var(--dsw-alias-toast-label, #f9fafb);
  font-size: 14px; line-height: 22px; box-shadow: var(--dsw-shadow-lv3, 0 10px 30px rgba(0,0,0,.25));
  pointer-events: auto;
  animation: dstk-toast-in 160ms ease-out, dstk-toast-fade 320ms ease var(--dstk-toast-hold, 1800ms) forwards;
}
.dstk-toast-glyph {
  display: grid; place-items: center; flex: none; width: 16px; height: 16px;
  font-size: 12px; font-weight: 700; color: var(--dsw-alias-state-success-primary, #34d399);
}
.dstk-toast-error .dstk-toast-glyph { color: var(--dsw-alias-state-error-primary, #f87171); }
.dstk-toast-text { min-width: 0; overflow-wrap: anywhere; }
@keyframes dstk-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes dstk-toast-fade { to { opacity: 0; visibility: hidden; } }
@media (prefers-reduced-motion: reduce) {
  .dstk-toast { animation: dstk-toast-fade 320ms ease var(--dstk-toast-hold, 1800ms) forwards; }
}

.dstk-overlay {
  position: fixed; inset: 0; z-index: 1090; display: grid; place-items: center;
  padding: 24px; background: rgba(0, 0, 0, .45);
}
.dstk-dialog {
  width: min(560px, 100%); max-height: min(82vh, 720px); display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111827);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); border-radius: var(--dsw-radius-lg, 14px);
  box-shadow: var(--dsw-shadow-lv3, 0 20px 60px rgba(0, 0, 0, .25)); overflow: hidden;
}
.dstk-dialog-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 13px 16px; border-bottom: .5px solid var(--dsw-alias-border-l2, #e5e7eb);
  font-size: 15px; font-weight: 600;
}
.dstk-dialog-body {
  display: flex; flex-direction: column; gap: 8px; padding: 14px 16px;
  min-height: 0; overflow: auto;
}
.dstk-dialog-foot {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 16px;
  border-top: .5px solid var(--dsw-alias-border-l2, #e5e7eb);
}
.dstk-channel {
  margin-right: auto; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-caption, #9ca3af); overflow-wrap: anywhere;
}
.dstk-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #4b5563); }
.dstk-row-between { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dstk-input, .dstk-textarea {
  box-sizing: border-box; width: 100%; font: inherit; font-size: 13px; color: inherit;
  padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2, transparent);
}
.dstk-textarea { min-height: 96px; resize: vertical; line-height: 1.6; }
.dstk-input:focus-visible, .dstk-textarea:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4f6ef7); outline-offset: -1px;
}
.dstk-session-list {
  max-height: 208px; overflow: auto; border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: var(--dsw-radius-md, 8px);
}
.dstk-list-note { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; padding: 10px; }
.dstk-session-row {
  display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 10px;
  border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px;
  text-align: left; cursor: pointer;
}
.dstk-session-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .14)); }
.dstk-session-row[aria-selected="true"] { background: var(--dsw-alias-interactive-bg-selected, rgba(79, 110, 247, .16)); }
.dstk-session-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dstk-session-cwd { display: block; overflow: hidden; text-overflow: ellipsis; font-size: 11px; opacity: .7; }
.dstk-session-time { flex: none; font-size: 11px; color: var(--dsw-alias-label-caption, #9ca3af); }
.dstk-badge {
  flex: none; font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .16));
  color: var(--dsw-alias-label-secondary, #4b5563);
}
.dstk-badge-self { background: rgba(79, 110, 247, .18); color: var(--dsw-alias-brand-primary, #4f6ef7); }
.dstk-badge-running { background: rgba(16, 185, 129, .18); color: #059669; }
.dstk-muted { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #4b5563); }
.dstk-error { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-error-primary, #dc2626); }
.dstk-seg {
  display: inline-flex; gap: 4px; padding: 2px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, .12));
}
.dstk-seg button {
  font: inherit; font-size: 12px; height: 24px; padding: 0 10px; border: 0; border-radius: 6px;
  background: transparent; color: inherit; cursor: pointer;
}
.dstk-seg button[aria-pressed="true"] {
  background: var(--dsw-alias-bg-layer-1, #fff);
  box-shadow: var(--dsw-shadow-lv1, 0 1px 2px rgba(0, 0, 0, .12));
}
.dstk-btn {
  font: inherit; font-size: 13px; height: 32px; padding: 0 14px; cursor: pointer;
  border: 1px solid transparent; border-radius: var(--dsw-radius-md, 8px);
}
/*
 * ⚠ 选择器必须比宿主自己的按钮规则更具体。
 * 客户端 bundle 是按需加载的，宿主的组件 CSS 在本插件之后注入，同特异性（0,1,0）时
 * 后写入者胜出 —— 实测症状：主按钮被宿主画成白底，而标签仍是白色，看起来是"一个空白按钮"。
 * 所以这里统一用两级选择器（.dstk-overlay 加具体类名，特异性 0,2,0）把配色钉住，
 * 并显式声明标签色，不依赖宿主是否提供 button-primary-label 这个 token。
 */
.dstk-overlay .dstk-btn-primary {
  background: var(--dsw-alias-button-primary-fill, #4f6ef7);
  color: var(--dsw-alias-button-primary-label, #fff);
}
.dstk-overlay .dstk-btn-primary:disabled { opacity: .55; cursor: not-allowed; }
.dstk-overlay .dstk-btn-ghost {
  background: transparent; color: var(--dsw-alias-label-primary, #111827);
  border-color: var(--dsw-alias-border-l2, #e5e7eb);
}
.dstk-overlay .dstk-btn-ghost:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .14)); }
.dstk-icon-btn {
  display: grid; place-items: center; width: 26px; height: 26px; padding: 0; cursor: pointer;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563); font-size: 13px; line-height: 1;
}
.dstk-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .14)); }
/* 花费徽标：默认低调；上下文占用 >=80% 时转成警示色（提示这条会话快到窗口上限） */
.dstk-badge-cost { font-variant-numeric: tabular-nums; }
.dstk-badge-hot { background: rgba(245, 158, 11, .18); color: #b45309; }
`;

/** 幂等地把本插件的样式塞进 document.head。任何失败都不外抛。 */
function ensureStyles() {
  try {
    if (typeof document === 'undefined') return;
    if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
    const style = document.createElement('style');
    style.setAttribute('data-plugin-css', STYLE_TAG_ID);
    style.textContent = CSS;
    (document.head ?? document.documentElement)?.appendChild(style);
  } catch (error) {
    console.warn('[dsh-session-telecom] 注入样式失败：', error);
  }
}

// ---------------------------------------------------------------- 自绘轻提示

/**
 * 弹一条会自动消失的提示。纯 DOM 实现（不依赖 react-dom 的 portal），
 * 所以菜单行/模态卸载后提示照样能显示完。
 * @param kind - 'success' | 'error'。
 * @param text - 已本地化的正文。
 * @param holdMs - 停留时长，省略时按 kind 取默认值。
 */
function notify(kind, text, holdMs) {
  try {
    if (typeof document === 'undefined' || document.body === null) return;
    ensureStyles();
    let layer = document.getElementById(TOAST_LAYER_ID);
    if (layer === null) {
      layer = document.createElement('div');
      layer.id = TOAST_LAYER_ID;
      layer.className = 'dstk-toast-layer';
      layer.setAttribute('role', 'status');
      layer.setAttribute('aria-live', 'polite');
      document.body.appendChild(layer);
    }
    const failed = kind === 'error';
    const hold = typeof holdMs === 'number' && holdMs > 0 ? holdMs : failed ? TOAST_HOLD_ERROR_MS : TOAST_HOLD_SUCCESS_MS;

    const node = document.createElement('div');
    node.className = failed ? 'dstk-toast dstk-toast-error' : 'dstk-toast dstk-toast-success';
    node.style.setProperty('--dstk-toast-hold', `${String(hold)}ms`);

    const glyph = document.createElement('span');
    glyph.className = 'dstk-toast-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = failed ? '!' : '✓';

    const label = document.createElement('span');
    label.className = 'dstk-toast-text';
    label.textContent = String(text ?? '');

    node.appendChild(glyph);
    node.appendChild(label);
    layer.appendChild(node);

    let timer = 0;
    const remove = () => {
      try {
        if (timer !== 0) clearTimeout(timer);
        node.remove();
        if (layer.childElementCount === 0) layer.remove();
      } catch {
        /* 移除失败无所谓 */
      }
    };
    timer = setTimeout(remove, hold + 420);
    node.addEventListener('click', remove);

    // 最多同时显示 3 条，防刷屏（先掐最旧的）。
    while (layer.childElementCount > 3 && layer.firstElementChild !== null) {
      layer.removeChild(layer.firstElementChild);
    }
  } catch (error) {
    console.warn('[dsh-session-telecom] 弹提示失败：', error);
  }
}

// ---------------------------------------------------------------- 剪贴板

/**
 * 把文本写进剪贴板：优先 navigator.clipboard.writeText，
 * 被拒/不可用则回退 document.execCommand('copy') + 隐藏 textarea。
 * 两条路都失败时返回第一条错误（更能说明真实原因）。
 * @param text - 要复制的文本。
 * @returns `{ ok, method?, error? }`，永不抛出。
 */
async function copyText(text) {
  const value = String(text ?? '');
  if (value.length === 0) return { ok: false, error: new Error('empty text') };

  let firstError = null;
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard !== undefined && clipboard !== null && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return { ok: true, method: 'navigator.clipboard.writeText' };
    } catch (error) {
      firstError = error;
    }
  }

  try {
    if (typeof document === 'undefined' || document.body === null) throw new Error('document unavailable');
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.setAttribute('tabindex', '-1');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.left = '-1000px';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.opacity = '0';
    document.body.appendChild(area);

    let copied = false;
    try {
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      copied = document.execCommand('copy') === true;
    } finally {
      area.parentNode?.removeChild(area);
    }
    if (copied) return { ok: true, method: 'document.execCommand("copy")' };
    return {
      ok: false,
      method: 'document.execCommand("copy")',
      error: firstError ?? new Error('document.execCommand("copy") 返回 false'),
    };
  } catch (error) {
    return { ok: false, error: firstError ?? error };
  }
}

// ---------------------------------------------------------------- 图标（自绘，避免依赖 primitives）

/** 复制图标：与宿主 IconCopyOutline 同几何，16 视窗 / 1px 描边。 */
function IconCopy({ size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor" />
      <path
        d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z"
        fill="currentColor"
      />
    </svg>
  );
}

// ---------------------------------------------------------------- 菜单行：复制会话 ID

/** 槽位未提供 hookContext 时的兜底：保持 hook 调用次数恒定。 */
const NO_MENU_STATE = [false, () => {}];
function useNoMenuOpenState() {
  return NO_MENU_STATE;
}

/**
 * 会话「⋯」菜单里的一行：复制该会话的 ID。
 * @param props - owner 给的 `sessionId`/`displayTitle`、渲染器给的 `t` 座位，
 *                以及槽位注入的 `useMenuOpenState`。
 * @returns 菜单行。
 */
function CopySessionIdMenuItem(props) {
  const { sessionId, t } = props ?? {};
  // 槽位注入的 menuOpenState 工厂 → `useMenuOpenState()` 返回 [open, setOpen]。
  // 用"引用选择"而不是条件调用，保证 hook 调用序列稳定。
  const menuStateHook = typeof props?.useMenuOpenState === 'function' ? props.useMenuOpenState : useNoMenuOpenState;
  const menuState = menuStateHook();
  const setMenuOpen = Array.isArray(menuState) && typeof menuState[1] === 'function' ? menuState[1] : null;

  const label = pickLabel(t, 'menu.copySessionId', '复制会话 ID');
  const disabled = typeof sessionId !== 'string' || sessionId.length === 0;

  const onSelect = (event) => {
    try {
      if (disabled) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      // 宿主行都是先关菜单再干活（选中后菜单会连同本行一起卸载）。
      if (setMenuOpen !== null) {
        try {
          setMenuOpen(false);
        } catch (error) {
          console.warn('[dsh-session-telecom] 关闭菜单失败：', error);
        }
      }
      // copyText 永不抛出；这里再兜一层，保证异步链里也不漏异常。
      void copyText(sessionId)
        .then((result) => {
          if (result?.ok === true) {
            notify('success', pickLabel(t, 'toast.copied', '已复制会话 ID'));
            return;
          }
          notify('error', `${pickLabel(t, 'toast.copyFailed', '复制会话 ID 失败')}：${describeError(result?.error)}`);
        })
        .catch((error) => {
          notify('error', `${pickLabel(t, 'toast.copyFailed', '复制会话 ID 失败')}：${describeError(error)}`);
        });
    } catch (error) {
      notify('error', `${pickLabel(t, 'toast.copyFailed', '复制会话 ID 失败')}：${describeError(error)}`);
    }
  };

  return (
    <div className="dstk-menu-row">
      <button
        type="button"
        role="menuitem"
        className="dstk-menu-item"
        disabled={disabled}
        title={disabled ? label : `${label}: ${sessionId}`}
        aria-label={label}
        onClick={onSelect}
      >
        <span className="dstk-menu-icon" aria-hidden="true">
          <IconCopy size={14} />
        </span>
        <span className="dstk-menu-label">{label}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Host RPC

/**
 * 把任意抛出物 / 宿主错误体归一成带 code 的 Error。
 * @param raw - 抛出的异常或 `{code,message,details}`。
 * @returns Error（尽量保留 code）。
 */
function asRpcError(raw) {
  if (raw instanceof Error) return raw;
  const message = raw !== null && typeof raw === 'object' && typeof raw.message === 'string' && raw.message.length > 0
    ? raw.message
    : describeError(raw);
  const error = new Error(message);
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.code === 'string') error.code = raw.code;
    if (raw.details !== undefined) error.details = raw.details;
  }
  return error;
}

/**
 * 调一次 Host RPC。信封由框架处理；这里只做两件事：
 * 把 `{ok:false,error}` 也变成异常（上层只需处理 catch），并解出 value。
 * @param rpc - 由 apply() 封好的调用器（已绑定通道）。
 * @param endpoint - sessions/list | sessions/send | self/info。
 * @param payload - 请求体。
 * @returns 响应里的 value。
 */
async function callRpc(rpc, endpoint, payload) {
  let envelope;
  try {
    envelope = await rpc(endpoint, payload);
  } catch (error) {
    throw asRpcError(error);
  }
  if (envelope !== null && typeof envelope === 'object' && 'ok' in envelope) {
    if (envelope.ok === true) return envelope.value ?? {};
    throw asRpcError(envelope.error);
  }
  return envelope ?? {};
}

/** 按 error.code 给出的中文兜底说明（EN 走词典里的 `error.<code>` 键）。 */
const RPC_ERROR_TEXT = {
  'session/not-found': '目标会话不存在或已被删除',
  'session/archived': '目标会话已归档，无法投递',
  'session/busy': '目标会话正忙，请稍后重试',
  'session/agent-busy': '目标会话正被它的父会话或子代理占用，暂时不能插入消息',
  'session/writer-held': '目标会话正被另一个 DSH 实例写入，请先在那里关掉它',
  'session/steer-unavailable': '目标会话不支持插队引导（steer），请改用排队投递',
  cancelled: '投递已取消',
  'bad-request': '请求不合法：请检查目标会话与消息内容',
  unauthorized: '没有权限向该会话投递消息',
  forbidden: '没有权限向该会话投递消息',
  'gateway/unavailable': '宿主未就绪：RPC 网关不可用',
  'gateway/timeout': '宿主响应超时，请稍后重试',
  'gateway/not-found': '宿主上没有这个 RPC 端点（Host 半可能未安装）',
  'gateway/internal': '宿主内部错误',
  'gateway/error': '宿主内部错误',
};

/**
 * 把错误渲染成一句可读文案：已知码查表（英文走词典，中文走兜底表），
 * 其余 gateway/* 兜底，再不行退回原始消息。
 * @param error - 任意错误。
 * @param t - 可选翻译座位。
 * @returns 展示文本。
 */
function explainRpcError(error, t) {
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  if (code !== '' && Object.prototype.hasOwnProperty.call(RPC_ERROR_TEXT, code)) {
    return `${pickLabel(t, `error.${code}`, RPC_ERROR_TEXT[code])}（${code}）`;
  }
  if (code.startsWith('gateway/')) return `${pickLabel(t, 'error.gateway', '宿主网关错误')}：${code}`;
  return describeError(error);
}

/** 把 updatedAt 渲染成短时间；解析不出来就返回空串。 */
function formatUpdatedAt(value) {
  try {
    const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    if (Number.isFinite(time) !== true) return '';
    const date = new Date(time);
    const pad = (number) => String(number).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return '';
  }
}

/** 把 token 数压缩成 1.2k / 34k / 1.5M 这种人眼能比大小的短串。 */
function formatTokens(value) {
  if (typeof value !== 'number' || Number.isFinite(value) !== true || value < 0) return '';
  if (value < 1000) return String(Math.round(value));
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [scale, suffix] of units) {
    if (value >= scale) {
      const scaled = value / scale;
      return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/**
 * 一行的花费标签。
 *
 * 为什么显示 `billable` 而不是总量：真实数据里缓存读能占到输入 token 的 99%（实测六条会话
 * cacheHitRate 83%–99.7%），而缓存读**不按全价计费**。把 1.2 亿的缓存读显示成"1.2 亿 tok"
 * 只会吓人，看不出真正花钱的地方。所以主数字用 `billableTokens = 非缓存输入 + 输出`，
 * 再补一个缓存命中率说明"剩下的都走了缓存"。
 *
 * token-meter 没数据（全 null）时返回空串 —— 不显示"0 tok"这种会误导人的东西。
 */
function costLabel(row) {
  const billable = formatTokens(row?.billableTokens);
  if (billable === '') return '';
  const rate = typeof row?.cacheHitRate === 'number' && Number.isFinite(row.cacheHitRate) ? row.cacheHitRate : null;
  return rate === null || rate <= 0
    ? `${billable} tok`
    : `计费${billable} · 缓存${Math.round(rate * 100)}%`;
}

/** 上下文占用是否值得警告（>=80% 说明这条会话快到窗口上限）。 */
function isContextHot(row) {
  return typeof row?.contextLoad === 'number' && Number.isFinite(row.contextLoad) && row.contextLoad >= 0.8;
}

/**
 * 校验 RPC 通道名满足内核客户端 `assertTarget` 的约束。
 *
 * 内核规则（dsh-client-connection/lib/client.js:1201、1317-1320）：
 *   `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/` —— **只允许一个路径段**，字符集里没有 `/`。
 * 违反它时 `ctx.connection.rpc.call` 会在**发请求之前**抛
 *   `connection: invalid RPC target "/api/xxx/sessions/list"`
 * 于是 UI 只能显示"宿主未就绪"，让人误以为是宿主/插件没挂上。
 *
 * @param {string} channel
 * @throws {Error} 通道名不合法
 */
export function assertChannelShape(channel) {
  if (typeof channel !== 'string' || !/^\/[A-Za-z0-9._~-]+$/.test(channel)) {
    throw new Error(
      `RPC channel ${JSON.stringify(channel)} violates the client CHANNEL_PATTERN /^\\/[A-Za-z0-9._~-]+$/ (exactly one path segment)`,
    );
  }
  return channel;
}

/**
 * 一行会话在列表里**实际会显示成什么**（纯函数）。
 *
 * 抽出来的理由是可验证性：徽标文案是"算对了但没画出来"这类 bug 的高发区，
 * 而模态内部要在异步 RPC 之后才渲染出行——纯函数可以直接测，也能被 e2e 复用。
 *
 * @param {object} row - sessions/list 返回的一行。
 * @param {{untitled?: string}} [labels] - 兜底文案（无标题会话）。
 * @returns {{id: string, title: string, costText: string, hot: boolean, badges: string[]}}
 */
export function describeSessionRow(row, labels = {}) {
  const untitled = typeof labels.untitled === 'string' && labels.untitled.length > 0 ? labels.untitled : '（无标题会话）';
  const id = String(row?.id ?? '');
  const title = typeof row?.title === 'string' && row.title.length > 0 ? row.title : untitled;
  const badges = [];
  if (row?.running === true) badges.push('running');
  else if (row?.live === true) badges.push('live');
  if (row?.archived === true) badges.push('archived');
  return { id, title, costText: costLabel(row), hot: isContextHot(row), badges };
}

// ---------------------------------------------------------------- 发送模态：全局状态

/**
 * 模态状态放模块级 store：菜单行选中后会随菜单一起卸载，而模态挂在
 * `shell.overlay` 这个常驻槽位里 —— 两处渲染位置靠这个 store 通信。
 * uSES 要求 getSnapshot 在无变化时返回同一引用，所以每次变更整体换对象。
 */
let dialogSnapshot = { open: false, sessionId: null, displayTitle: '', seed: 0 };
const dialogListeners = new Set();

function subscribeDialog(listener) {
  dialogListeners.add(listener);
  return () => {
    dialogListeners.delete(listener);
  };
}

function getDialogSnapshot() {
  return dialogSnapshot;
}

function emitDialog() {
  for (const listener of [...dialogListeners]) {
    try {
      listener();
    } catch (error) {
      console.warn('[dsh-session-telecom] 模态订阅者抛错：', error);
    }
  }
}

/** 打开模态；seed 变化会让模态以全新状态挂载（每次打开都重新拉列表）。 */
function openSendDialog(sessionId, displayTitle) {
  dialogSnapshot = {
    open: true,
    // 被右键的那一行 = 目标会话。
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    // 发信方署名用哪个 id：宿主拿不到"客户端当前打开的是哪个会话"，但**用户是在某个会话那一行
    // 右键的**，这就是他此刻所在的会话。用它当发信方，比写「未知会话」有用得多；
    // 宿主侧还会再做一次存在性校验（查不到就降级成"未知会话"），所以不会编造身份。
    selfSessionId: typeof sessionId === 'string' ? sessionId : null,
    displayTitle: typeof displayTitle === 'string' ? displayTitle : '',
    seed: dialogSnapshot.seed + 1,
  };
  emitDialog();
}

function closeSendDialog() {
  if (dialogSnapshot.open !== true) return;
  dialogSnapshot = { ...dialogSnapshot, open: false, seed: dialogSnapshot.seed + 1 };
  emitDialog();
}

// ---------------------------------------------------------------- 图标：发送

/** 纸飞机图标（16 视窗 / 1px 描边，与宿主图标同一套几何风格）。 */
function IconSend({ size = 14 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.6 1.4 1.6 6.9l5 2 2 5z" stroke="currentColor" />
      <path d="M14.6 1.4 6.6 8.9" stroke="currentColor" />
    </svg>
  );
}

// ---------------------------------------------------------------- 菜单行：发送消息到会话…

/**
 * 会话「⋯」菜单里的一行：打开发送消息模态。
 * @param props - owner 给的 `sessionId`/`displayTitle`、渲染器给的 `t` 座位，
 *                以及槽位注入的 `useMenuOpenState`。
 * @returns 菜单行。
 */
function SendMessageMenuItem(props) {
  const { sessionId, displayTitle, t } = props ?? {};
  const menuStateHook = typeof props?.useMenuOpenState === 'function' ? props.useMenuOpenState : useNoMenuOpenState;
  const menuState = menuStateHook();
  const setMenuOpen = Array.isArray(menuState) && typeof menuState[1] === 'function' ? menuState[1] : null;

  const label = pickLabel(t, 'menu.sendMessage', '发送消息到会话…');
  const disabled = typeof sessionId !== 'string' || sessionId.length === 0;

  const onSelect = (event) => {
    try {
      if (disabled) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (setMenuOpen !== null) {
        try {
          setMenuOpen(false);
        } catch (error) {
          console.warn('[dsh-session-telecom] 关闭菜单失败：', error);
        }
      }
      openSendDialog(sessionId, displayTitle);
    } catch (error) {
      notify('error', `${pickLabel(t, 'toast.openFailed', '打开发送消息窗口失败')}：${describeError(error)}`);
    }
  };

  return (
    <div className="dstk-menu-row">
      <button
        type="button"
        role="menuitem"
        className="dstk-menu-item"
        disabled={disabled}
        title={disabled ? label : `${label} — ${typeof displayTitle === 'string' && displayTitle.length > 0 ? displayTitle : sessionId}`}
        aria-label={label}
        onClick={onSelect}
      >
        <span className="dstk-menu-icon" aria-hidden="true">
          <IconSend size={14} />
        </span>
        <span className="dstk-menu-label">{label}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- 模态宿主（常驻 shell.overlay）

/**
 * shell.overlay 里的常驻组件：只在 store 说"打开"时渲染模态。
 * @param props - `rpc`（由注册时的 inject 传入）与 `t` 座位。
 * @returns 模态，或 null。
 */
function SendMessageHost(props) {
  const snapshot = React.useSyncExternalStore(subscribeDialog, getDialogSnapshot, getDialogSnapshot);
  if (snapshot.open !== true) return null;
  return (
    <SendMessageDialog
      key={`dstk-send-${String(snapshot.seed)}`}
      rpc={props.rpc}
      t={props.t}
      initialTargetId={snapshot.sessionId}
      initialTargetTitle={snapshot.displayTitle}
      initialSenderId={snapshot.selfSessionId}
    />
  );
}

/**
 * 发送消息模态：目标会话选择器（搜索 + 列表）+ 多行输入 + 发送/取消。
 * @param props - `rpc`、`t`、打开时那一行的会话 ID/标题，以及**发信方候选 id**（同一行）。
 * @returns 模态。
 */
function SendMessageDialog(props) {
  const { rpc, t, initialTargetId, initialTargetTitle, initialSenderId } = props;
  const [phase, setPhase] = React.useState('loading'); // loading | ready | failed
  const [sessions, setSessions] = React.useState([]);
  // 发信方候选：先用"右键那一行"的 id，等 self/info 回来若给了 id 就优先用宿主的。
  const [selfSessionId, setSelfSessionId] = React.useState(
    typeof initialSenderId === 'string' && initialSenderId.length > 0 ? initialSenderId : null,
  );
  const [costTotals, setCostTotals] = React.useState(null);
  const [listError, setListError] = React.useState('');
  const [reloadSeq, setReloadSeq] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [targetId, setTargetId] = React.useState(typeof initialTargetId === 'string' && initialTargetId.length > 0 ? initialTargetId : null);
  const [text, setText] = React.useState('');
  const [mode, setMode] = React.useState('queue');
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState('');
  const [channel, setChannel] = React.useState(null);
  const textareaRef = React.useRef(null);

  // 拉会话列表；宿主 ok:false 或连接异常都落到「宿主未就绪」错误态。
  React.useEffect(() => {
    let cancelled = false;
    setPhase('loading');
    setListError('');
    Promise.resolve()
      .then(() => callRpc(rpc, 'sessions/list', {}))
      .then((value) => {
        if (cancelled) return;
        setSessions(Array.isArray(value?.sessions) ? value.sessions : []);
        // 宿主给的 selfSessionId 只有在**确实是现存会话**时才采用（宿主环境里的 DSH_SESSION_ID
        // 可能是别的会话）；否则保留"右键那一行"的 id —— 那才是用户此刻所在的会话。
        const fromHost = typeof value?.selfSessionId === 'string' ? value.selfSessionId : null;
        const known = Array.isArray(value?.sessions) ? value.sessions : [];
        setSelfSessionId((current) => {
          if (fromHost !== null && known.some((row) => row?.id === fromHost)) return fromHost;
          if (typeof current === 'string' && current.length > 0 && known.some((row) => row?.id === current)) return current;
          return fromHost;
        });
        setCostTotals(value?.costTotals !== null && typeof value?.costTotals === 'object' ? value.costTotals : null);
        setPhase('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        setSessions([]);
        setListError(explainRpcError(error, t));
        setPhase('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [reloadSeq, rpc]);

  // 排障用：问一下宿主当前生效的投递通道（self/info 还没落地时静默，不影响主流程）。
  React.useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => callRpc(rpc, 'self/info', {}))
      .then((value) => {
        if (!cancelled) setChannel(value !== null && typeof value === 'object' ? value : null);
      })
      .catch(() => {
        if (!cancelled) setChannel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadSeq, rpc]);

  // 列表就绪后把焦点送进输入框（需求：模态打开时焦点进输入框）。
  React.useEffect(() => {
    if (phase !== 'ready') return;
    const node = textareaRef.current;
    if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus();
  }, [phase]);

  // Esc 关闭：挂在 document 上（capture），焦点在哪都能关。
  React.useEffect(() => {
    if (typeof document === 'undefined') return () => {};
    const onKeyDown = (event) => {
      try {
        if (event.key === 'Escape') {
          event.stopPropagation();
          closeSendDialog();
        }
      } catch (error) {
        console.warn('[dsh-session-telecom] Esc 关闭模态失败：', error);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return sessions;
    return sessions.filter((row) => String(row?.title ?? '').toLowerCase().includes(needle) || String(row?.id ?? '').toLowerCase().includes(needle) || String(row?.cwd ?? '').toLowerCase().includes(needle));
  }, [sessions, query]);

  const targetRow = sessions.find((row) => row?.id === targetId) ?? null;
  const targetTitle = targetRow !== null && typeof targetRow.title === 'string' && targetRow.title.length > 0
    ? targetRow.title
    : (typeof initialTargetTitle === 'string' && initialTargetTitle.length > 0 ? initialTargetTitle : '');
  const delivery = channel !== null && typeof channel.delivery === 'string' ? channel.delivery : '';
  const channelText = delivery === ''
    ? ''
    : `${pickLabel(t, 'dialog.channel', '投递通道')}：${delivery}${channel.promptPath === false ? pickLabel(t, 'dialog.channel.direct', '（非 prompt 路径）') : ''}`;

  // 成本控制用的一眼汇总：这批会话真正计费了多少、缓存省掉了多少。
  const costText = (() => {
    try {
      const billable = formatTokens(costTotals?.billableTokens);
      if (billable === '') return '';
      const rate = typeof costTotals?.cacheHitRate === 'number' && Number.isFinite(costTotals.cacheHitRate)
        ? Math.round(costTotals.cacheHitRate * 100)
        : null;
      const base = `${pickLabel(t, 'dialog.costTotal', '这些会话累计计费')} ${billable} tok`;
      return rate === null || rate <= 0 ? base : `${base} · ${pickLabel(t, 'dialog.costCache', '缓存命中')}${rate}%`;
    } catch {
      return '';
    }
  })();

  const submit = () => {
    try {
      if (sending) return;
      const body = text.trim();
      if (body.length === 0) {
        setSendError(pickLabel(t, 'error.emptyText', '请先输入消息内容'));
        return;
      }
      if (typeof targetId !== 'string' || targetId.length === 0) {
        setSendError(pickLabel(t, 'error.noTarget', '请先选择目标会话'));
        return;
      }
      setSending(true);
      setSendError('');
      const title = targetTitle !== '' ? targetTitle : targetId;
      // 修 bug：`self/info` 的 sessionId 来自宿主环境的 DSH_SESSION_ID 兜底，它不保证就是
      // 「当前这个会话」。只有当这个 id 确实在会话清单里出现时才拿它当发信方，否则宁可
      // 不带 relay 标记（宿主侧还有第二道校验，两边都不许造出"来自陌生会话"的假来源）。
      const senderCandidate = typeof selfSessionId === 'string' && sessions.some((row) => row?.id === selfSessionId)
        ? selfSessionId
        : null;
      void callRpc(rpc, 'sessions/send', {
        targetSessionId: targetId,
        text: body,
        senderSessionId: senderCandidate,
        mode,
      })
        .then((value) => {
          try {
            closeSendDialog();
            notify('success', pickLabel(t, 'toast.sent', '已投递到 {title}').replace('{title}', title));
            if (value !== null && typeof value === 'object' && value.live === false) {
              notify('success', pickLabel(t, 'toast.woken', '目标会话原本是冷的，宿主已自动唤醒它'));
            }
          } catch (error) {
            console.warn('[dsh-session-telecom] 投递成功后的收尾失败：', error);
          }
        })
        .catch((error) => {
          try {
            setSending(false);
            setSendError(explainRpcError(error, t));
          } catch (inner) {
            console.warn('[dsh-session-telecom] 展示失败原因时又出错：', inner);
          }
        });
    } catch (error) {
      try {
        setSending(false);
        setSendError(explainRpcError(error, t));
      } catch {
        /* 兜底：连错误渲染都失败就静默，绝不外泄 */
      }
    }
  };

  const onTextKeyDown = (event) => {
    try {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeSendDialog();
        return;
      }
      if (event.key === 'Enter' && event.shiftKey !== true) {
        // 中文输入法组字中的 Enter 是"上屏"，不能当发送（keyCode 229 是 IME 的经典信号）。
        const composing = event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;
        if (composing) return;
        event.preventDefault();
        submit();
      }
    } catch (error) {
      try {
        setSendError(explainRpcError(error, t));
      } catch {
        /* 兜底 */
      }
    }
  };

  const close = () => {
    try {
      closeSendDialog();
    } catch (error) {
      console.warn('[dsh-session-telecom] 关闭模态失败：', error);
    }
  };

  return (
    <div
      className="dstk-overlay"
      role="presentation"
      onMouseDown={(event) => {
        try {
          if (event.target === event.currentTarget) close();
        } catch {
          /* 兜底 */
        }
      }}
    >
      <div className="dstk-dialog" role="dialog" aria-modal="true" aria-label={pickLabel(t, 'dialog.title', '发送消息到会话')}>
        <div className="dstk-dialog-head">
          <span>{pickLabel(t, 'dialog.title', '发送消息到会话')}</span>
          <button type="button" className="dstk-icon-btn" aria-label={pickLabel(t, 'dialog.close', '关闭')} onClick={close}>
            ✕
          </button>
        </div>

        <div className="dstk-dialog-body">
          <label className="dstk-field-label" htmlFor="dstk-send-search">
            {pickLabel(t, 'dialog.search', '搜索会话')}
          </label>
          <input
            id="dstk-send-search"
            className="dstk-input"
            type="text"
            value={query}
            placeholder={pickLabel(t, 'dialog.searchPlaceholder', '按标题、会话 ID 或工作区过滤…')}
            onChange={(event) => setQuery(event.target.value)}
          />

          <div className="dstk-field-label">
            {pickLabel(t, 'dialog.target', '目标会话')}
            {targetTitle !== '' ? `：${targetTitle}` : ''}
          </div>
          <div className="dstk-session-list" role="listbox" aria-label={pickLabel(t, 'dialog.target', '目标会话')}>
            {phase === 'loading' && <div className="dstk-list-note dstk-muted">{pickLabel(t, 'dialog.loading', '正在读取会话列表…')}</div>}
            {phase === 'failed' && (
              <div className="dstk-list-note">
                <div className="dstk-error" role="alert">
                  {pickLabel(t, 'dialog.hostNotReady', '宿主未就绪')}
                </div>
                {listError !== '' && <div className="dstk-muted">{listError}</div>}
                <button type="button" className="dstk-btn dstk-btn-ghost" onClick={() => setReloadSeq((value) => value + 1)}>
                  {pickLabel(t, 'dialog.retry', '重试')}
                </button>
              </div>
            )}
            {phase === 'ready' && filtered.length === 0 && (
              <div className="dstk-list-note dstk-muted">{pickLabel(t, 'dialog.empty', '没有匹配的会话')}</div>
            )}
            {phase === 'ready' && filtered.map((row) => {
              // 行内容统一由 describeSessionRow 决定（纯函数、可单测），组件只负责画。
              const described = describeSessionRow(row, { untitled: pickLabel(t, 'dialog.untitled', '（无标题会话）') });
              const { id, title, costText, hot } = described;
              const isSelf = row?.isSelf === true || (selfSessionId !== null && id === selfSessionId);
              const time = formatUpdatedAt(row?.updatedAt);
              return (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={id === targetId}
                  className="dstk-session-row"
                  title={`${title}\n${id}${row?.cwd ? `\n${row.cwd}` : ''}`}
                  onClick={() => {
                    try {
                      setTargetId(id);
                      setSendError('');
                    } catch (error) {
                      console.warn('[dsh-session-telecom] 选择目标会话失败：', error);
                    }
                  }}
                >
                  <span className="dstk-session-title">{title}{row?.cwd && <span className="dstk-session-cwd">{row.cwd}</span>}</span>
                  {isSelf && <span className="dstk-badge dstk-badge-self">{pickLabel(t, 'dialog.self', '本会话')}</span>}
                  {described.badges.includes('running') && <span className="dstk-badge dstk-badge-running">{pickLabel(t, 'dialog.running', '运行中')}</span>}
                  {described.badges.includes('live') && <span className="dstk-badge">{pickLabel(t, 'dialog.live', '在线')}</span>}
                  {described.badges.includes('archived') && <span className="dstk-badge">{pickLabel(t, 'dialog.archived', '已归档')}</span>}
                  {costText !== '' && (
                    <span
                      className={`dstk-badge dstk-badge-cost${hot ? ' dstk-badge-hot' : ''}`}
                      title={pickLabel(t, 'dialog.costTip', '「计费」= 非缓存输入 + 输出（真正按全价计费的 token）；「缓存」= 输入里走缓存的比例，越高越省')}
                    >
                      {costText}
                      {hot ? ' ⚠' : ''}
                    </span>
                  )}
                  {time !== '' && <span className="dstk-session-time">{time}</span>}
                </button>
              );
            })}
          </div>

          <div className="dstk-row-between">
            <span className="dstk-field-label">{pickLabel(t, 'dialog.text', '消息内容')}</span>
            <span className="dstk-seg" role="group" aria-label={pickLabel(t, 'dialog.mode', '投递方式')}>
              <button
                type="button"
                aria-pressed={mode === 'queue'}
                onClick={() => {
                  try {
                    setMode('queue');
                  } catch (error) {
                    console.warn('[dsh-session-telecom] 切换投递方式失败：', error);
                  }
                }}
              >
                {pickLabel(t, 'dialog.mode.queue', '排队投递')}
              </button>
              <button
                type="button"
                aria-pressed={mode === 'steer'}
                onClick={() => {
                  try {
                    setMode('steer');
                  } catch (error) {
                    console.warn('[dsh-session-telecom] 切换投递方式失败：', error);
                  }
                }}
              >
                {pickLabel(t, 'dialog.mode.steer', '立即引导')}
              </button>
            </span>
          </div>

          <textarea
            ref={textareaRef}
            className="dstk-textarea"
            value={text}
            placeholder={pickLabel(t, 'dialog.placeholder', '输入要投递的消息…（Enter 发送，Shift+Enter 换行）')}
            onChange={(event) => {
              setText(event.target.value);
              if (sendError !== '') setSendError('');
            }}
            onKeyDown={onTextKeyDown}
          />

          <div className="dstk-muted">
            {pickLabel(t, 'dialog.semantics', '这条消息会以「用户消息」的形式出现在目标会话的时间线上（对方看到的是有人发来消息，而不是它自己的输入），排队等它的下一回合处理；目标会话是冷会话时宿主会自动唤醒它。')}
          </div>
          {sendError !== '' && (
            <div className="dstk-error" role="alert">
              {sendError}
            </div>
          )}
        </div>

        <div className="dstk-dialog-foot">
          {channelText !== '' && <span className="dstk-channel">{channelText}</span>}
          {costText !== '' && <span className="dstk-channel">{costText}</span>}
          <button type="button" className="dstk-btn dstk-btn-ghost" onClick={close}>
            {pickLabel(t, 'dialog.cancel', '取消')}
          </button>
          <button type="button" className="dstk-btn dstk-btn-primary" disabled={sending} onClick={submit}>
            {sending ? pickLabel(t, 'dialog.sending', '投递中…') : pickLabel(t, 'dialog.send', '发送')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 插件入口

/**
 * 挂载 Client 半：注册语言字典，往会话菜单槽位加两行（复制 ID / 发送消息），
 * 并把发送模态挂到常驻的 shell.overlay 上。
 * 全流程 best-effort：任何注册失败只记日志，绝不把异常抛回宿主启动链。
 * @param ctx - 客户端插件上下文（已注入 slots / connection）。
 */
export function apply(ctx) {
  ensureStyles();

  // 自检：通道名必须满足内核客户端的 assertTarget 约束（单段、形状 /x）。
  // 这条不查的话，错误会以"宿主未就绪"的形式在用户面前出现，而宿主其实是好的 —— 排查极贵。
  try {
    assertChannelShape(RPC_CHANNEL);
  } catch (error) {
    console.error('[dsh-session-telecom] RPC 通道名不合法：', error);
  }

  try {
    if (ctx?.locale !== undefined && typeof ctx.locale.register === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => {
        try {
          return ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN });
        } catch (error) {
          console.warn('[dsh-session-telecom] 语言字典注册失败：', error);
          return () => {};
        }
      }, 'dsh-session-telecom: locale dictionaries');
    }
  } catch (error) {
    console.warn('[dsh-session-telecom] 语言字典接入失败：', error);
  }

  if (ctx?.slots === undefined || typeof ctx.slots.inject !== 'function') {
    console.warn('[dsh-session-telecom] 没有 slots 服务，菜单行未注册');
    return;
  }

  /** 往槽位里注册一个条目：注入失败/重复注册只记日志，绝不让宿主启动链炸掉。 */
  const registerEntry = (slotKey, options, Component, what) => {
    try {
      ctx.slots.inject(slotKey, () => {
        try {
          return ctx.slots.register({ name: slotKey, ...options }, Component);
        } catch (error) {
          console.error(`[dsh-session-telecom] 注册失败（${what}）：`, error);
          return () => {};
        }
      });
    } catch (error) {
      console.error(`[dsh-session-telecom] 注入槽位失败（${what}）：`, error);
    }
  };

  // 菜单行 1：复制会话 ID。
  registerEntry(
    MENU_SLOT,
    { id: COPY_ENTRY_ID, order: COPY_ENTRY_ORDER, locale: LOCALE_NS, registrant: REGISTRANT },
    CopySessionIdMenuItem,
    'copy session id',
  );

  // 菜单行 2：发送消息到会话…（打开模态）。
  registerEntry(
    MENU_SLOT,
    { id: SEND_ENTRY_ID, order: SEND_ENTRY_ORDER, locale: LOCALE_NS, registrant: REGISTRANT },
    SendMessageMenuItem,
    'send message',
  );

  // 模态挂在常驻的 shell.overlay 上（菜单行选中后会随菜单卸载，模态不能跟着走）。
  const rpc = (endpoint, payload) => {
    const connection = ctx?.connection;
    if (connection === undefined || connection === null || typeof connection.rpc?.call !== 'function') {
      const error = new Error('连接服务不可用：宿主未就绪');
      error.code = 'gateway/unavailable';
      return Promise.reject(error);
    }
    return connection.rpc.call(RPC_CHANNEL, endpoint, payload);
  };

  registerEntry(
    OVERLAY_SLOT,
    {
      id: SEND_ENTRY_ID,
      order: SEND_ENTRY_ORDER,
      locale: LOCALE_NS,
      registrant: REGISTRANT,
      inject: () => ({ rpc }),
    },
    SendMessageHost,
    'send message dialog',
  );
}

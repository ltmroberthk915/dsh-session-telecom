window.__ModuleLoader__.load({
  id: "dsh-session-telecom",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  assertChannelShape: () => assertChannelShape,
  describeSessionRow: () => describeSessionRow,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);
var React = __toESM(require("react"), 1);
var name = "dsh-session-telecom";
var inject = ["slots", "connection"];
var RPC_CHANNEL = "/dsh-session-telecom";
var LOCALE_NS = "dsh-session-telecom";
var REGISTRANT = "dsh-session-telecom";
var MENU_SLOT = "sidebar.workspaces.session.menu.item";
var OVERLAY_SLOT = "shell.overlay";
var COPY_ENTRY_ID = "session-toolkit-copy-id";
var COPY_ENTRY_ORDER = 250;
var SEND_ENTRY_ID = "session-toolkit-send-message";
var SEND_ENTRY_ORDER = 260;
var STYLE_TAG_ID = "dsh-session-telecom/client.css";
var TOAST_LAYER_ID = "dsh-session-telecom-toasts";
var TOAST_HOLD_SUCCESS_MS = 1800;
var TOAST_HOLD_ERROR_MS = 4200;
var ZH = {
  "menu.copySessionId": "复制会话 ID",
  "menu.sendMessage": "发送消息到会话…",
  "toast.copied": "已复制会话 ID",
  "toast.copyFailed": "复制会话 ID 失败",
  "toast.openFailed": "打开发送消息窗口失败",
  "toast.sent": "已投递到 {title}",
  "toast.woken": "目标会话原本是冷的，宿主已自动唤醒它",
  "dialog.title": "发送消息到会话",
  "dialog.close": "关闭",
  "dialog.search": "搜索会话",
  "dialog.searchPlaceholder": "按标题或会话 ID 过滤…",
  "dialog.target": "目标会话",
  "dialog.text": "消息内容",
  "dialog.mode": "投递方式",
  "dialog.mode.queue": "排队投递",
  "dialog.mode.steer": "立即引导",
  "dialog.placeholder": "输入要投递的消息…（Enter 发送，Shift+Enter 换行）",
  "dialog.send": "发送",
  "dialog.cancel": "取消",
  "dialog.sending": "投递中…",
  "dialog.loading": "正在读取会话列表…",
  "dialog.hostNotReady": "宿主未就绪",
  "dialog.empty": "没有匹配的会话",
  "dialog.untitled": "（无标题会话）",
  "dialog.self": "本会话",
  "dialog.running": "运行中",
  "dialog.live": "在线",
  "dialog.archived": "已归档",
  "dialog.retry": "重试",
  "dialog.semantics": "这条消息会以「用户消息」的形式出现在目标会话的时间线上（对方看到的是有人发来消息，而不是它自己的输入），排队等它的下一回合处理；目标会话是冷会话时宿主会自动唤醒它。",
  "dialog.channel": "投递通道",
  "dialog.channel.direct": "（非 prompt 路径）",
  "dialog.costTip": "「计费」= 非缓存输入 + 输出（真正按全价计费的 token）；「缓存」= 输入里走缓存的比例，越高越省",
  "dialog.costTotal": "这些会话累计计费",
  "dialog.costCache": "缓存命中",
  "error.emptyText": "请先输入消息内容",
  "error.noTarget": "请先选择目标会话",
  "error.gateway": "宿主网关错误"
};
var EN = {
  "menu.copySessionId": "Copy session ID",
  "menu.sendMessage": "Send message to session…",
  "toast.copied": "Session ID copied",
  "toast.copyFailed": "Failed to copy the session ID",
  "toast.openFailed": "Could not open the send-message dialog",
  "toast.sent": "Delivered to {title}",
  "toast.woken": "The target session was cold; the host woke it up",
  "dialog.title": "Send a message to a session",
  "dialog.close": "Close",
  "dialog.search": "Search sessions",
  "dialog.searchPlaceholder": "Filter by title or session ID…",
  "dialog.target": "Target session",
  "dialog.text": "Message",
  "dialog.mode": "Delivery",
  "dialog.mode.queue": "Queue",
  "dialog.mode.steer": "Steer now",
  "dialog.placeholder": "Type the message… (Enter sends, Shift+Enter adds a line)",
  "dialog.send": "Send",
  "dialog.cancel": "Cancel",
  "dialog.sending": "Delivering…",
  "dialog.loading": "Loading sessions…",
  "dialog.hostNotReady": "Host not ready",
  "dialog.empty": "No session matches",
  "dialog.untitled": "(untitled session)",
  "dialog.self": "this session",
  "dialog.running": "running",
  "dialog.live": "live",
  "dialog.archived": "archived",
  "dialog.retry": "Retry",
  "dialog.semantics": "The message lands on the target timeline as a user message (the target sees an incoming message, not its own input) and waits in the queue for its next turn; a cold target is woken up by the host.",
  "dialog.channel": "Delivery channel",
  "dialog.channel.direct": " (not the prompt path)",
  "dialog.costTip": '"billed" = uncached input + output (the tokens actually charged at full price); "cache" = share of input served from cache, higher is cheaper',
  "dialog.costTotal": "Billed across these sessions",
  "dialog.costCache": "cache hit",
  "error.emptyText": "Type a message first",
  "error.noTarget": "Pick a target session first",
  "error.gateway": "Host gateway error",
  "error.session/not-found": "The target session does not exist or was deleted",
  "error.session/archived": "The target session is archived; cannot deliver",
  "error.session/busy": "The target session is busy, try again later",
  "error.session/agent-busy": "The target session is held by its parent session or a subagent; cannot insert a message right now",
  "error.session/writer-held": "Another DSH instance is writing to the target session; close it there first",
  "error.session/steer-unavailable": "The target session does not accept steer delivery; use queue instead",
  "error.cancelled": "Delivery was cancelled",
  "error.bad-request": "Invalid request: check the target session and the message body",
  "error.unauthorized": "Not allowed to deliver to that session",
  "error.forbidden": "Not allowed to deliver to that session",
  "error.gateway/unavailable": "Host not ready: the RPC gateway is unavailable",
  "error.gateway/timeout": "The host timed out, try again later",
  "error.gateway/not-found": "The host has no such RPC endpoint (the host half may not be installed)",
  "error.gateway/internal": "Internal host error",
  "error.gateway/error": "Internal host error"
};
function pickLabel(t, key, fallback) {
  if (typeof t !== "function") return fallback;
  try {
    const value = t(key);
    if (typeof value === "string" && value.length > 0 && value !== key) return value;
  } catch {
  }
  return fallback;
}
function describeError(error) {
  if (error === void 0 || error === null) return "unknown error";
  if (typeof error === "string") return error;
  try {
    if (error instanceof Error) {
      return error.name ? `${error.name}: ${error.message}` : String(error.message ?? error);
    }
    const code = error.code === void 0 ? "" : String(error.code);
    const message = error.message === void 0 ? "" : String(error.message);
    if (code !== "" || message !== "") return code !== "" && message !== "" ? `${code}: ${message}` : code || message;
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
var CSS = `
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
function ensureStyles() {
  try {
    if (typeof document === "undefined") return;
    if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
    const style = document.createElement("style");
    style.setAttribute("data-plugin-css", STYLE_TAG_ID);
    style.textContent = CSS;
    (document.head ?? document.documentElement)?.appendChild(style);
  } catch (error) {
    console.warn("[dsh-session-telecom] 注入样式失败：", error);
  }
}
function notify(kind, text, holdMs) {
  try {
    if (typeof document === "undefined" || document.body === null) return;
    ensureStyles();
    let layer = document.getElementById(TOAST_LAYER_ID);
    if (layer === null) {
      layer = document.createElement("div");
      layer.id = TOAST_LAYER_ID;
      layer.className = "dstk-toast-layer";
      layer.setAttribute("role", "status");
      layer.setAttribute("aria-live", "polite");
      document.body.appendChild(layer);
    }
    const failed = kind === "error";
    const hold = typeof holdMs === "number" && holdMs > 0 ? holdMs : failed ? TOAST_HOLD_ERROR_MS : TOAST_HOLD_SUCCESS_MS;
    const node = document.createElement("div");
    node.className = failed ? "dstk-toast dstk-toast-error" : "dstk-toast dstk-toast-success";
    node.style.setProperty("--dstk-toast-hold", `${String(hold)}ms`);
    const glyph = document.createElement("span");
    glyph.className = "dstk-toast-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = failed ? "!" : "✓";
    const label = document.createElement("span");
    label.className = "dstk-toast-text";
    label.textContent = String(text ?? "");
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
      }
    };
    timer = setTimeout(remove, hold + 420);
    node.addEventListener("click", remove);
    while (layer.childElementCount > 3 && layer.firstElementChild !== null) {
      layer.removeChild(layer.firstElementChild);
    }
  } catch (error) {
    console.warn("[dsh-session-telecom] 弹提示失败：", error);
  }
}
async function copyText(text) {
  const value = String(text ?? "");
  if (value.length === 0) return { ok: false, error: new Error("empty text") };
  let firstError = null;
  const clipboard = typeof navigator === "undefined" ? void 0 : navigator.clipboard;
  if (clipboard !== void 0 && clipboard !== null && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(value);
      return { ok: true, method: "navigator.clipboard.writeText" };
    } catch (error) {
      firstError = error;
    }
  }
  try {
    if (typeof document === "undefined" || document.body === null) throw new Error("document unavailable");
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.setAttribute("tabindex", "-1");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    area.style.width = "1px";
    area.style.height = "1px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    let copied = false;
    try {
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      copied = document.execCommand("copy") === true;
    } finally {
      area.parentNode?.removeChild(area);
    }
    if (copied) return { ok: true, method: 'document.execCommand("copy")' };
    return {
      ok: false,
      method: 'document.execCommand("copy")',
      error: firstError ?? new Error('document.execCommand("copy") 返回 false')
    };
  } catch (error) {
    return { ok: false, error: firstError ?? error };
  }
}
function IconCopy({ size = 14 }) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": "true",
      strokeWidth: 1
    },
    /* @__PURE__ */ React.createElement("rect", { x: "1.52075", y: "4.07373", width: "10.3932", height: "10.3932", rx: "2", stroke: "currentColor" }),
    /* @__PURE__ */ React.createElement(
      "path",
      {
        d: "M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z",
        fill: "currentColor"
      }
    )
  );
}
var NO_MENU_STATE = [false, () => {
}];
function useNoMenuOpenState() {
  return NO_MENU_STATE;
}
function CopySessionIdMenuItem(props) {
  const { sessionId, t } = props ?? {};
  const menuStateHook = typeof props?.useMenuOpenState === "function" ? props.useMenuOpenState : useNoMenuOpenState;
  const menuState = menuStateHook();
  const setMenuOpen = Array.isArray(menuState) && typeof menuState[1] === "function" ? menuState[1] : null;
  const label = pickLabel(t, "menu.copySessionId", "复制会话 ID");
  const disabled = typeof sessionId !== "string" || sessionId.length === 0;
  const onSelect = (event) => {
    try {
      if (disabled) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (setMenuOpen !== null) {
        try {
          setMenuOpen(false);
        } catch (error) {
          console.warn("[dsh-session-telecom] 关闭菜单失败：", error);
        }
      }
      void copyText(sessionId).then((result) => {
        if (result?.ok === true) {
          notify("success", pickLabel(t, "toast.copied", "已复制会话 ID"));
          return;
        }
        notify("error", `${pickLabel(t, "toast.copyFailed", "复制会话 ID 失败")}：${describeError(result?.error)}`);
      }).catch((error) => {
        notify("error", `${pickLabel(t, "toast.copyFailed", "复制会话 ID 失败")}：${describeError(error)}`);
      });
    } catch (error) {
      notify("error", `${pickLabel(t, "toast.copyFailed", "复制会话 ID 失败")}：${describeError(error)}`);
    }
  };
  return /* @__PURE__ */ React.createElement("div", { className: "dstk-menu-row" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      role: "menuitem",
      className: "dstk-menu-item",
      disabled,
      title: disabled ? label : `${label}: ${sessionId}`,
      "aria-label": label,
      onClick: onSelect
    },
    /* @__PURE__ */ React.createElement("span", { className: "dstk-menu-icon", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement(IconCopy, { size: 14 })),
    /* @__PURE__ */ React.createElement("span", { className: "dstk-menu-label" }, label)
  ));
}
function asRpcError(raw) {
  if (raw instanceof Error) return raw;
  const message = raw !== null && typeof raw === "object" && typeof raw.message === "string" && raw.message.length > 0 ? raw.message : describeError(raw);
  const error = new Error(message);
  if (raw !== null && typeof raw === "object") {
    if (typeof raw.code === "string") error.code = raw.code;
    if (raw.details !== void 0) error.details = raw.details;
  }
  return error;
}
async function callRpc(rpc, endpoint, payload) {
  let envelope;
  try {
    envelope = await rpc(endpoint, payload);
  } catch (error) {
    throw asRpcError(error);
  }
  if (envelope !== null && typeof envelope === "object" && "ok" in envelope) {
    if (envelope.ok === true) return envelope.value ?? {};
    throw asRpcError(envelope.error);
  }
  return envelope ?? {};
}
var RPC_ERROR_TEXT = {
  "session/not-found": "目标会话不存在或已被删除",
  "session/archived": "目标会话已归档，无法投递",
  "session/busy": "目标会话正忙，请稍后重试",
  "session/agent-busy": "目标会话正被它的父会话或子代理占用，暂时不能插入消息",
  "session/writer-held": "目标会话正被另一个 DSH 实例写入，请先在那里关掉它",
  "session/steer-unavailable": "目标会话不支持插队引导（steer），请改用排队投递",
  cancelled: "投递已取消",
  "bad-request": "请求不合法：请检查目标会话与消息内容",
  unauthorized: "没有权限向该会话投递消息",
  forbidden: "没有权限向该会话投递消息",
  "gateway/unavailable": "宿主未就绪：RPC 网关不可用",
  "gateway/timeout": "宿主响应超时，请稍后重试",
  "gateway/not-found": "宿主上没有这个 RPC 端点（Host 半可能未安装）",
  "gateway/internal": "宿主内部错误",
  "gateway/error": "宿主内部错误"
};
function explainRpcError(error, t) {
  const code = error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  if (code !== "" && Object.prototype.hasOwnProperty.call(RPC_ERROR_TEXT, code)) {
    return `${pickLabel(t, `error.${code}`, RPC_ERROR_TEXT[code])}（${code}）`;
  }
  if (code.startsWith("gateway/")) return `${pickLabel(t, "error.gateway", "宿主网关错误")}：${code}`;
  return describeError(error);
}
function formatUpdatedAt(value) {
  try {
    const time = typeof value === "number" ? value : Date.parse(String(value ?? ""));
    if (Number.isFinite(time) !== true) return "";
    const date = new Date(time);
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return "";
  }
}
function formatTokens(value) {
  if (typeof value !== "number" || Number.isFinite(value) !== true || value < 0) return "";
  if (value < 1e3) return String(Math.round(value));
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [scale, suffix] of units) {
    if (value >= scale) {
      const scaled = value / scale;
      return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${suffix}`;
    }
  }
  return String(Math.round(value));
}
function costLabel(row) {
  const billable = formatTokens(row?.billableTokens);
  if (billable === "") return "";
  const rate = typeof row?.cacheHitRate === "number" && Number.isFinite(row.cacheHitRate) ? row.cacheHitRate : null;
  return rate === null || rate <= 0 ? `${billable} tok` : `计费${billable} · 缓存${Math.round(rate * 100)}%`;
}
function isContextHot(row) {
  return typeof row?.contextLoad === "number" && Number.isFinite(row.contextLoad) && row.contextLoad >= 0.8;
}
function assertChannelShape(channel) {
  if (typeof channel !== "string" || !/^\/[A-Za-z0-9._~-]+$/.test(channel)) {
    throw new Error(
      `RPC channel ${JSON.stringify(channel)} violates the client CHANNEL_PATTERN /^\\/[A-Za-z0-9._~-]+$/ (exactly one path segment)`
    );
  }
  return channel;
}
function describeSessionRow(row, labels = {}) {
  const untitled = typeof labels.untitled === "string" && labels.untitled.length > 0 ? labels.untitled : "（无标题会话）";
  const id = String(row?.id ?? "");
  const title = typeof row?.title === "string" && row.title.length > 0 ? row.title : untitled;
  const badges = [];
  if (row?.running === true) badges.push("running");
  else if (row?.live === true) badges.push("live");
  if (row?.archived === true) badges.push("archived");
  return { id, title, costText: costLabel(row), hot: isContextHot(row), badges };
}
var dialogSnapshot = { open: false, sessionId: null, displayTitle: "", seed: 0 };
var dialogListeners = /* @__PURE__ */ new Set();
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
      console.warn("[dsh-session-telecom] 模态订阅者抛错：", error);
    }
  }
}
function openSendDialog(sessionId, displayTitle) {
  dialogSnapshot = {
    open: true,
    // 被右键的那一行 = 目标会话。
    sessionId: typeof sessionId === "string" ? sessionId : null,
    // 发信方署名用哪个 id：宿主拿不到"客户端当前打开的是哪个会话"，但**用户是在某个会话那一行
    // 右键的**，这就是他此刻所在的会话。用它当发信方，比写「未知会话」有用得多；
    // 宿主侧还会再做一次存在性校验（查不到就降级成"未知会话"），所以不会编造身份。
    selfSessionId: typeof sessionId === "string" ? sessionId : null,
    displayTitle: typeof displayTitle === "string" ? displayTitle : "",
    seed: dialogSnapshot.seed + 1
  };
  emitDialog();
}
function closeSendDialog() {
  if (dialogSnapshot.open !== true) return;
  dialogSnapshot = { ...dialogSnapshot, open: false, seed: dialogSnapshot.seed + 1 };
  emitDialog();
}
function IconSend({ size = 14 }) {
  return /* @__PURE__ */ React.createElement(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "aria-hidden": "true",
      strokeWidth: 1,
      strokeLinecap: "round",
      strokeLinejoin: "round"
    },
    /* @__PURE__ */ React.createElement("path", { d: "M14.6 1.4 1.6 6.9l5 2 2 5z", stroke: "currentColor" }),
    /* @__PURE__ */ React.createElement("path", { d: "M14.6 1.4 6.6 8.9", stroke: "currentColor" })
  );
}
function SendMessageMenuItem(props) {
  const { sessionId, displayTitle, t } = props ?? {};
  const menuStateHook = typeof props?.useMenuOpenState === "function" ? props.useMenuOpenState : useNoMenuOpenState;
  const menuState = menuStateHook();
  const setMenuOpen = Array.isArray(menuState) && typeof menuState[1] === "function" ? menuState[1] : null;
  const label = pickLabel(t, "menu.sendMessage", "发送消息到会话…");
  const disabled = typeof sessionId !== "string" || sessionId.length === 0;
  const onSelect = (event) => {
    try {
      if (disabled) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (setMenuOpen !== null) {
        try {
          setMenuOpen(false);
        } catch (error) {
          console.warn("[dsh-session-telecom] 关闭菜单失败：", error);
        }
      }
      openSendDialog(sessionId, displayTitle);
    } catch (error) {
      notify("error", `${pickLabel(t, "toast.openFailed", "打开发送消息窗口失败")}：${describeError(error)}`);
    }
  };
  return /* @__PURE__ */ React.createElement("div", { className: "dstk-menu-row" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      role: "menuitem",
      className: "dstk-menu-item",
      disabled,
      title: disabled ? label : `${label} — ${typeof displayTitle === "string" && displayTitle.length > 0 ? displayTitle : sessionId}`,
      "aria-label": label,
      onClick: onSelect
    },
    /* @__PURE__ */ React.createElement("span", { className: "dstk-menu-icon", "aria-hidden": "true" }, /* @__PURE__ */ React.createElement(IconSend, { size: 14 })),
    /* @__PURE__ */ React.createElement("span", { className: "dstk-menu-label" }, label)
  ));
}
function SendMessageHost(props) {
  const snapshot = React.useSyncExternalStore(subscribeDialog, getDialogSnapshot, getDialogSnapshot);
  if (snapshot.open !== true) return null;
  return /* @__PURE__ */ React.createElement(
    SendMessageDialog,
    {
      key: `dstk-send-${String(snapshot.seed)}`,
      rpc: props.rpc,
      t: props.t,
      initialTargetId: snapshot.sessionId,
      initialTargetTitle: snapshot.displayTitle,
      initialSenderId: snapshot.selfSessionId
    }
  );
}
function SendMessageDialog(props) {
  const { rpc, t, initialTargetId, initialTargetTitle, initialSenderId } = props;
  const [phase, setPhase] = React.useState("loading");
  const [sessions, setSessions] = React.useState([]);
  const [selfSessionId, setSelfSessionId] = React.useState(
    typeof initialSenderId === "string" && initialSenderId.length > 0 ? initialSenderId : null
  );
  const [costTotals, setCostTotals] = React.useState(null);
  const [listError, setListError] = React.useState("");
  const [reloadSeq, setReloadSeq] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const [targetId, setTargetId] = React.useState(typeof initialTargetId === "string" && initialTargetId.length > 0 ? initialTargetId : null);
  const [text, setText] = React.useState("");
  const [mode, setMode] = React.useState("queue");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState("");
  const [channel, setChannel] = React.useState(null);
  const textareaRef = React.useRef(null);
  React.useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setListError("");
    Promise.resolve().then(() => callRpc(rpc, "sessions/list", {})).then((value) => {
      if (cancelled) return;
      setSessions(Array.isArray(value?.sessions) ? value.sessions : []);
      const fromHost = typeof value?.selfSessionId === "string" ? value.selfSessionId : null;
      const known = Array.isArray(value?.sessions) ? value.sessions : [];
      setSelfSessionId((current) => {
        if (fromHost !== null && known.some((row) => row?.id === fromHost)) return fromHost;
        if (typeof current === "string" && current.length > 0 && known.some((row) => row?.id === current)) return current;
        return fromHost;
      });
      setCostTotals(value?.costTotals !== null && typeof value?.costTotals === "object" ? value.costTotals : null);
      setPhase("ready");
    }).catch((error) => {
      if (cancelled) return;
      setSessions([]);
      setListError(explainRpcError(error, t));
      setPhase("failed");
    });
    return () => {
      cancelled = true;
    };
  }, [reloadSeq, rpc]);
  React.useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => callRpc(rpc, "self/info", {})).then((value) => {
      if (!cancelled) setChannel(value !== null && typeof value === "object" ? value : null);
    }).catch(() => {
      if (!cancelled) setChannel(null);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadSeq, rpc]);
  React.useEffect(() => {
    if (phase !== "ready") return;
    const node = textareaRef.current;
    if (node !== null && node !== void 0 && typeof node.focus === "function") node.focus();
  }, [phase]);
  React.useEffect(() => {
    if (typeof document === "undefined") return () => {
    };
    const onKeyDown = (event) => {
      try {
        if (event.key === "Escape") {
          event.stopPropagation();
          closeSendDialog();
        }
      } catch (error) {
        console.warn("[dsh-session-telecom] Esc 关闭模态失败：", error);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return sessions;
    return sessions.filter((row) => String(row?.title ?? "").toLowerCase().includes(needle) || String(row?.id ?? "").toLowerCase().includes(needle));
  }, [sessions, query]);
  const targetRow = sessions.find((row) => row?.id === targetId) ?? null;
  const targetTitle = targetRow !== null && typeof targetRow.title === "string" && targetRow.title.length > 0 ? targetRow.title : typeof initialTargetTitle === "string" && initialTargetTitle.length > 0 ? initialTargetTitle : "";
  const delivery = channel !== null && typeof channel.delivery === "string" ? channel.delivery : "";
  const channelText = delivery === "" ? "" : `${pickLabel(t, "dialog.channel", "投递通道")}：${delivery}${channel.promptPath === false ? pickLabel(t, "dialog.channel.direct", "（非 prompt 路径）") : ""}`;
  const costText = (() => {
    try {
      const billable = formatTokens(costTotals?.billableTokens);
      if (billable === "") return "";
      const rate = typeof costTotals?.cacheHitRate === "number" && Number.isFinite(costTotals.cacheHitRate) ? Math.round(costTotals.cacheHitRate * 100) : null;
      const base = `${pickLabel(t, "dialog.costTotal", "这些会话累计计费")} ${billable} tok`;
      return rate === null || rate <= 0 ? base : `${base} · ${pickLabel(t, "dialog.costCache", "缓存命中")}${rate}%`;
    } catch {
      return "";
    }
  })();
  const submit = () => {
    try {
      if (sending) return;
      const body = text.trim();
      if (body.length === 0) {
        setSendError(pickLabel(t, "error.emptyText", "请先输入消息内容"));
        return;
      }
      if (typeof targetId !== "string" || targetId.length === 0) {
        setSendError(pickLabel(t, "error.noTarget", "请先选择目标会话"));
        return;
      }
      setSending(true);
      setSendError("");
      const title = targetTitle !== "" ? targetTitle : targetId;
      const senderCandidate = typeof selfSessionId === "string" && sessions.some((row) => row?.id === selfSessionId) ? selfSessionId : null;
      void callRpc(rpc, "sessions/send", {
        targetSessionId: targetId,
        text: body,
        senderSessionId: senderCandidate,
        mode
      }).then((value) => {
        try {
          closeSendDialog();
          notify("success", pickLabel(t, "toast.sent", "已投递到 {title}").replace("{title}", title));
          if (value !== null && typeof value === "object" && value.live === false) {
            notify("success", pickLabel(t, "toast.woken", "目标会话原本是冷的，宿主已自动唤醒它"));
          }
        } catch (error) {
          console.warn("[dsh-session-telecom] 投递成功后的收尾失败：", error);
        }
      }).catch((error) => {
        try {
          setSending(false);
          setSendError(explainRpcError(error, t));
        } catch (inner) {
          console.warn("[dsh-session-telecom] 展示失败原因时又出错：", inner);
        }
      });
    } catch (error) {
      try {
        setSending(false);
        setSendError(explainRpcError(error, t));
      } catch {
      }
    }
  };
  const onTextKeyDown = (event) => {
    try {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeSendDialog();
        return;
      }
      if (event.key === "Enter" && event.shiftKey !== true) {
        const composing = event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;
        if (composing) return;
        event.preventDefault();
        submit();
      }
    } catch (error) {
      try {
        setSendError(explainRpcError(error, t));
      } catch {
      }
    }
  };
  const close = () => {
    try {
      closeSendDialog();
    } catch (error) {
      console.warn("[dsh-session-telecom] 关闭模态失败：", error);
    }
  };
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: "dstk-overlay",
      role: "presentation",
      onMouseDown: (event) => {
        try {
          if (event.target === event.currentTarget) close();
        } catch {
        }
      }
    },
    /* @__PURE__ */ React.createElement("div", { className: "dstk-dialog", role: "dialog", "aria-modal": "true", "aria-label": pickLabel(t, "dialog.title", "发送消息到会话") }, /* @__PURE__ */ React.createElement("div", { className: "dstk-dialog-head" }, /* @__PURE__ */ React.createElement("span", null, pickLabel(t, "dialog.title", "发送消息到会话")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "dstk-icon-btn", "aria-label": pickLabel(t, "dialog.close", "关闭"), onClick: close }, "✕")), /* @__PURE__ */ React.createElement("div", { className: "dstk-dialog-body" }, /* @__PURE__ */ React.createElement("label", { className: "dstk-field-label", htmlFor: "dstk-send-search" }, pickLabel(t, "dialog.search", "搜索会话")), /* @__PURE__ */ React.createElement(
      "input",
      {
        id: "dstk-send-search",
        className: "dstk-input",
        type: "text",
        value: query,
        placeholder: pickLabel(t, "dialog.searchPlaceholder", "按标题或会话 ID 过滤…"),
        onChange: (event) => setQuery(event.target.value)
      }
    ), /* @__PURE__ */ React.createElement("div", { className: "dstk-field-label" }, pickLabel(t, "dialog.target", "目标会话"), targetTitle !== "" ? `：${targetTitle}` : ""), /* @__PURE__ */ React.createElement("div", { className: "dstk-session-list", role: "listbox", "aria-label": pickLabel(t, "dialog.target", "目标会话") }, phase === "loading" && /* @__PURE__ */ React.createElement("div", { className: "dstk-list-note dstk-muted" }, pickLabel(t, "dialog.loading", "正在读取会话列表…")), phase === "failed" && /* @__PURE__ */ React.createElement("div", { className: "dstk-list-note" }, /* @__PURE__ */ React.createElement("div", { className: "dstk-error", role: "alert" }, pickLabel(t, "dialog.hostNotReady", "宿主未就绪")), listError !== "" && /* @__PURE__ */ React.createElement("div", { className: "dstk-muted" }, listError), /* @__PURE__ */ React.createElement("button", { type: "button", className: "dstk-btn dstk-btn-ghost", onClick: () => setReloadSeq((value) => value + 1) }, pickLabel(t, "dialog.retry", "重试"))), phase === "ready" && filtered.length === 0 && /* @__PURE__ */ React.createElement("div", { className: "dstk-list-note dstk-muted" }, pickLabel(t, "dialog.empty", "没有匹配的会话")), phase === "ready" && filtered.map((row) => {
      const described = describeSessionRow(row, { untitled: pickLabel(t, "dialog.untitled", "（无标题会话）") });
      const { id, title, costText: costText2, hot } = described;
      const isSelf = row?.isSelf === true || selfSessionId !== null && id === selfSessionId;
      const time = formatUpdatedAt(row?.updatedAt);
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          key: id,
          type: "button",
          role: "option",
          "aria-selected": id === targetId,
          className: "dstk-session-row",
          onClick: () => {
            try {
              setTargetId(id);
              setSendError("");
            } catch (error) {
              console.warn("[dsh-session-telecom] 选择目标会话失败：", error);
            }
          }
        },
        /* @__PURE__ */ React.createElement("span", { className: "dstk-session-title" }, title),
        isSelf && /* @__PURE__ */ React.createElement("span", { className: "dstk-badge dstk-badge-self" }, pickLabel(t, "dialog.self", "本会话")),
        described.badges.includes("running") && /* @__PURE__ */ React.createElement("span", { className: "dstk-badge dstk-badge-running" }, pickLabel(t, "dialog.running", "运行中")),
        described.badges.includes("live") && /* @__PURE__ */ React.createElement("span", { className: "dstk-badge" }, pickLabel(t, "dialog.live", "在线")),
        described.badges.includes("archived") && /* @__PURE__ */ React.createElement("span", { className: "dstk-badge" }, pickLabel(t, "dialog.archived", "已归档")),
        costText2 !== "" && /* @__PURE__ */ React.createElement(
          "span",
          {
            className: `dstk-badge dstk-badge-cost${hot ? " dstk-badge-hot" : ""}`,
            title: pickLabel(t, "dialog.costTip", "「计费」= 非缓存输入 + 输出（真正按全价计费的 token）；「缓存」= 输入里走缓存的比例，越高越省")
          },
          costText2,
          hot ? " ⚠" : ""
        ),
        time !== "" && /* @__PURE__ */ React.createElement("span", { className: "dstk-session-time" }, time)
      );
    })), /* @__PURE__ */ React.createElement("div", { className: "dstk-row-between" }, /* @__PURE__ */ React.createElement("span", { className: "dstk-field-label" }, pickLabel(t, "dialog.text", "消息内容")), /* @__PURE__ */ React.createElement("span", { className: "dstk-seg", role: "group", "aria-label": pickLabel(t, "dialog.mode", "投递方式") }, /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        "aria-pressed": mode === "queue",
        onClick: () => {
          try {
            setMode("queue");
          } catch (error) {
            console.warn("[dsh-session-telecom] 切换投递方式失败：", error);
          }
        }
      },
      pickLabel(t, "dialog.mode.queue", "排队投递")
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        "aria-pressed": mode === "steer",
        onClick: () => {
          try {
            setMode("steer");
          } catch (error) {
            console.warn("[dsh-session-telecom] 切换投递方式失败：", error);
          }
        }
      },
      pickLabel(t, "dialog.mode.steer", "立即引导")
    ))), /* @__PURE__ */ React.createElement(
      "textarea",
      {
        ref: textareaRef,
        className: "dstk-textarea",
        value: text,
        placeholder: pickLabel(t, "dialog.placeholder", "输入要投递的消息…（Enter 发送，Shift+Enter 换行）"),
        onChange: (event) => {
          setText(event.target.value);
          if (sendError !== "") setSendError("");
        },
        onKeyDown: onTextKeyDown
      }
    ), /* @__PURE__ */ React.createElement("div", { className: "dstk-muted" }, pickLabel(t, "dialog.semantics", "这条消息会以「用户消息」的形式出现在目标会话的时间线上（对方看到的是有人发来消息，而不是它自己的输入），排队等它的下一回合处理；目标会话是冷会话时宿主会自动唤醒它。")), sendError !== "" && /* @__PURE__ */ React.createElement("div", { className: "dstk-error", role: "alert" }, sendError)), /* @__PURE__ */ React.createElement("div", { className: "dstk-dialog-foot" }, channelText !== "" && /* @__PURE__ */ React.createElement("span", { className: "dstk-channel" }, channelText), costText !== "" && /* @__PURE__ */ React.createElement("span", { className: "dstk-channel" }, costText), /* @__PURE__ */ React.createElement("button", { type: "button", className: "dstk-btn dstk-btn-ghost", onClick: close }, pickLabel(t, "dialog.cancel", "取消")), /* @__PURE__ */ React.createElement("button", { type: "button", className: "dstk-btn dstk-btn-primary", disabled: sending, onClick: submit }, sending ? pickLabel(t, "dialog.sending", "投递中…") : pickLabel(t, "dialog.send", "发送"))))
  );
}
function apply(ctx) {
  ensureStyles();
  try {
    assertChannelShape(RPC_CHANNEL);
  } catch (error) {
    console.error("[dsh-session-telecom] RPC 通道名不合法：", error);
  }
  try {
    if (ctx?.locale !== void 0 && typeof ctx.locale.register === "function" && typeof ctx.effect === "function") {
      ctx.effect(() => {
        try {
          return ctx.locale.register(LOCALE_NS, { zh: ZH, en: EN });
        } catch (error) {
          console.warn("[dsh-session-telecom] 语言字典注册失败：", error);
          return () => {
          };
        }
      }, "dsh-session-telecom: locale dictionaries");
    }
  } catch (error) {
    console.warn("[dsh-session-telecom] 语言字典接入失败：", error);
  }
  if (ctx?.slots === void 0 || typeof ctx.slots.inject !== "function") {
    console.warn("[dsh-session-telecom] 没有 slots 服务，菜单行未注册");
    return;
  }
  const registerEntry = (slotKey, options, Component, what) => {
    try {
      ctx.slots.inject(slotKey, () => {
        try {
          return ctx.slots.register({ name: slotKey, ...options }, Component);
        } catch (error) {
          console.error(`[dsh-session-telecom] 注册失败（${what}）：`, error);
          return () => {
          };
        }
      });
    } catch (error) {
      console.error(`[dsh-session-telecom] 注入槽位失败（${what}）：`, error);
    }
  };
  registerEntry(
    MENU_SLOT,
    { id: COPY_ENTRY_ID, order: COPY_ENTRY_ORDER, locale: LOCALE_NS, registrant: REGISTRANT },
    CopySessionIdMenuItem,
    "copy session id"
  );
  registerEntry(
    MENU_SLOT,
    { id: SEND_ENTRY_ID, order: SEND_ENTRY_ORDER, locale: LOCALE_NS, registrant: REGISTRANT },
    SendMessageMenuItem,
    "send message"
  );
  const rpc = (endpoint, payload) => {
    const connection = ctx?.connection;
    if (connection === void 0 || connection === null || typeof connection.rpc?.call !== "function") {
      const error = new Error("连接服务不可用：宿主未就绪");
      error.code = "gateway/unavailable";
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
      inject: () => ({ rpc })
    },
    SendMessageHost,
    "send message dialog"
  );
}

    return module.exports;
  }
});

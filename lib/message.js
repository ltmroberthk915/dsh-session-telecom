// 构造投递给目标会话的 UserMessage。
//
// 为什么要这个文件：真源是 `createUserMessage`（@deepseek-ai/dsh-llm，lib/types/message.js:53）:
//
//     export function createUserMessage(input) {
//         return createMessage({ ...input, role: 'user' });
//     }
//
// 而 createMessage 就是「浅拷贝 + 注入 id + structuredClone 深冻结」（同文件 :34）：
//
//     deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
//
// 但 DSH 插件目录（profiles/<profile>/node_modules/<plugin>）能解析到 @deepseek-ai/dsh-llm，
// **workspace 里的源码副本解析不到**（profiles/node_modules 不是它的祖先目录，实测
// ERR_MODULE_NOT_FOUND）。所以这里做「先探真源、探不到就有等价兜底」：
//   - 真源可用  → 用它，行为与内核逐字段一致；
//   - 真源不可用 → 本地复刻（node:crypto 的 randomUUID，与 dsh-util-crypto 同源）。
// 两条路的产物在 JSON 上完全同形，且都是 deepFreeze 过的（内核多处 assert 冻结）。

import { randomUUID } from 'node:crypto';
import { SESSION_TELECOM_OPAQUE_SOURCE, SESSION_TELECOM_SOURCE_KIND } from './api.js';

/** 内核包的 module specifier。故意用变量拼接，避免打包器/静态解析器提前报错。 */
const LLM_SPECIFIER = ['@deepseek-ai', 'dsh-llm'].join('/');

let realCreateUserMessage;
let resolveAttempted = false;
let resolution = 'pending';

/**
 * 尝试取到内核真正的 createUserMessage。惰性 + 只试一次 + 永不抛。
 * @returns {Promise<{factory: Function|undefined, source: 'kernel'|'fallback'}>}
 */
export async function resolveMessageFactory() {
  if (!resolveAttempted) {
    resolveAttempted = true;
    try {
      const mod = await import(LLM_SPECIFIER);
      if (typeof mod?.createUserMessage === 'function') {
        realCreateUserMessage = mod.createUserMessage;
        resolution = 'kernel';
      } else {
        resolution = 'fallback';
      }
    } catch {
      resolution = 'fallback';
    }
  }
  return { factory: realCreateUserMessage, source: resolution === 'kernel' ? 'kernel' : 'fallback' };
}

/** 同步报告当前解析结果，供 self/info 与 e2e 断言用。 */
export function messageFactorySource() {
  return resolution === 'kernel' ? 'kernel' : 'fallback';
}

/** 注入一个现成的工厂（测试 / e2e 想强制走内核路径时用）。 */
export function useMessageFactory(factory) {
  if (typeof factory !== 'function') throw new TypeError('message factory must be a function');
  realCreateUserMessage = factory;
  resolveAttempted = true;
  resolution = 'kernel';
}

/** 本地复刻：深冻结 + 结构化克隆 + 新 id（与 dsh-llm 的 createMessage 同形）。 */
function fallbackCreateMessage(input) {
  return deepFreeze(structuredClone({ ...input, id: randomUUID() }));
}

/** 深冻结普通 JSON 值（原生 structuredClone 结果不会带着循环引用回来）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/** 兜底版 createUserMessage：与内核同形。 */
export function fallbackCreateUserMessage(input) {
  return fallbackCreateMessage({ ...input, role: 'user' });
}

/**
 * 按发信方身份选 source：有非空 senderSessionId 才用 `agent-message`，否则退回 `{ kind:'user' }`。
 *
 * 为什么不能写空串（R1）：`AgentMessageSource` 声明 `senderSessionId: SessionId`（品牌化非空），
 * 格式校验器直接拒空串（dsh-session-format-v2-to-v3/lib/index.js:132、
 * dsh-session-format-v0-to-v1/lib/index.js:881-882），GUI 的 relaySender() 对空串返回 null
 * （dsh-client-ui-chat/lib/client.js:741-744）于是走 opaque 分支。
 * 所以「拿不到发送方」的合法表达是 `{ kind:'user' }`（= prompt RPC 自己的写法），
 * 而不是伪造一个空的 agent-message。
 *
 * @param {string|null|undefined} senderSessionId
 * @returns {{kind: 'agent-message', form: 'relay', senderSessionId: string}|{kind: 'user'}}
 */
export function relaySourceFor(senderSessionId) {
  if (typeof senderSessionId === 'string' && senderSessionId.length > 0) {
    return { kind: SESSION_TELECOM_SOURCE_KIND, form: 'relay', senderSessionId };
  }
  return { ...SESSION_TELECOM_OPAQUE_SOURCE };
}

/**
 * 构造「跨会话投递」的 user 消息。
 *
 * source 形状取自内核类型声明（dsh-llm/lib/typert.host.js:233 与 :417）：
 *     有发信方： interface AgentMessageSource { kind:'agent-message'; form:'relay'; senderSessionId: SessionId }
 *     无发信方： MessageSourceMap.user = { kind: 'user' }
 *
 * @param {object} input - 目标文本与来源会话身份。
 * @param {string} input.text - 已经 trim 过的非空文本。
 * @param {string|null} [input.senderSessionId] - 发信会话 id；没有就给内核合法的 { kind:'user' }。
 * @param {Function} [input.factory] - 强制使用的 createUserMessage。
 * @returns {object} 冻结的 UserMessage。
 */
export function buildRelayMessage({ text, senderSessionId, factory } = {}) {
  const input = {
    content: [{ type: 'text', text }],
    source: relaySourceFor(senderSessionId),
  };
  const create = typeof factory === 'function'
    ? factory
    : (realCreateUserMessage ?? fallbackCreateUserMessage);
  return create(input);
}

/**
 * 在一条消息上读出「是不是我们投的、谁投的」。
 * @param {object} message - 候选 UserMessage。
 * @returns {{relay: boolean, senderSessionId: string|null}}
 */
export function readRelaySource(message) {
  const source = message?.source;
  const relay = source?.kind === SESSION_TELECOM_SOURCE_KIND;
  return {
    relay,
    senderSessionId: relay && typeof source.senderSessionId === 'string' && source.senderSessionId.length > 0
      ? source.senderSessionId
      : null,
  };
}

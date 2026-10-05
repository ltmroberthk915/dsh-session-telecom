// 面向模型的会话间通道：把「会话 ↔ 会话」这件事补成内核本来没有的工具入口。
//
// 为什么需要（研究结论，见 RESEARCH-session-dialogue.md §5）：内核里"把消息投进另一个会话"
// 的机制存在，但只在两个受限坐标系里成立（subagent 父子 lineage、Agent Teams 同队名册）；
// 面向模型**没有任何按 sessionId 寻址的跨会话工具**，模型甚至看不见无关会话的 id。
// 本文件补的正是这个缺口：一个工具、两个动作。
//
//   session_telecom { action: "list" }                     → 列出现存会话（id/标题/时间/花费/冷热）
//   session_telecom { action: "send", targetSessionId, text } → 把消息投进目标会话（冷会话自动唤醒）
//
// 发送方身份取自 `exec.agent.session.header.id`——这是**真实调用者**，不是猜的：
// 工具执行上下文里 `exec.agent` 就是发起这次调用的 Agent（dsh-tools/lib/index.js:1201、:3137）。
// 拿到它之后仍会走 deliver.js 的存在性校验，所以不可能造出"来自陌生会话"的假来源。
//
// 成本控制：`list` 的返回里带每个会话的 token 累计与缓存命中率，以及一份总计；
// 模型据此判断"该不该把上下文搬进这个已经烧了很多的会话"。
//
// 失败语义：任何失败都返回 `{ ok:false, error:{code,message} }` 这样的**结构化结果**，
// 不抛异常——工具抛异常会把整轮打断，而"目标会话不存在"这类事实是模型应该读到并自行纠正的信息。

import { createSessionRegistry, tryGet } from './session-registry.js';
import { deliverToSession, normalizeSendMode } from './deliver.js';
import { toWireError } from './errors.js';

/** 工具名（与 package.json 的前缀风格一致，避免和内核工具重名）。 */
export const SESSION_TELECOM_TOOL_NAME = 'session_telecom';

/**
 * 单次投递的文本上限（默认 32 KB）。
 *
 * 这是**成本控制参数**，不是安全参数：投进别人的上下文等于替对方付这笔 prefill，
 * 塞一整篇文档会让目标会话的下一次请求直接暴涨。需要更严的 profile 可以调小它
 * （`createSessionTelecom(ctx, { maxTextBytes })`），而不是去改代码。
 */
export const DEFAULT_MAX_TEXT_BYTES = 32 * 1024;

/** `list` 默认返回多少条（按最近活动倒序）——给模型看的清单要短。 */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * 把一段文本包成内核要的 ContentBlock 数组。
 *
 * ⚠ 契约（真机踩过：`Error: content.some is not a function`）：
 * `output.render` 的返回值**就是** `result.content`（dsh-tools/lib/index.js:3548-3552），
 * 而内核在 `finalizeContent` **之前**就把它交给 `tools/post-execute` 的消费者读取
 * （dsh-tools/lib/index.js:3504 / spill-policy/lib/index.js:240-241 的 `content.some(...)`）。
 * 所以 render 返回裸字符串 = 那些消费者拿到字符串后当场 `.some is not a function`，
 * 而我们的 finalizeContent 跑在 post-execute **之后**，救不了这一步。
 * 参照 dsh-free-search/lib/index.js:3104-3106 的同一处置：render 直接返回块数组。
 */
function textBlock(text) {
  return [{ type: 'text', text }];
}

/** 把 token 数压成短串。 */
function shortTokens(value) {
  if (typeof value !== 'number' || Number.isFinite(value) !== true || value <= 0) return null;
  if (value < 1000) return String(Math.round(value));
  for (const [scale, suffix] of [[1e6, 'M'], [1e3, 'k']]) {
    if (value >= scale) {
      const scaled = value / scale;
      return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/**
 * 一条会话在工具输出里的摘要行。
 *
 * 形状受 DSL 约束：输出的 schema 只允许单类型、不允许 required，所以
 * **没有数据的字段用空串 / 0 / 省略键**，绝不用 null（additionally 会过不了 additionalProperties:false
 * 的类型校验）。`hasUsage` 用来区分"真的 0"与"没有数据"。
 */
function toRow(row, selfId) {
  const tokens = shortTokens(row.tokens);
  const billable = shortTokens(row.billableTokens);
  const summary = {
    id: String(row.id),
    title: typeof row.title === 'string' ? row.title : '',
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    live: row.live === true,
    running: row.running === true,
    archived: row.archived === true,
    isSelf: row.id === selfId,
    tokens: tokens ?? '',
    billableTokens: billable ?? '',
    cacheHitRate: typeof row.cacheHitRate === 'number' && Number.isFinite(row.cacheHitRate) ? row.cacheHitRate : 0,
    contextLoad: typeof row.contextLoad === 'number' && Number.isFinite(row.contextLoad) ? row.contextLoad : 0,
    hasUsage: tokens !== null,
  };
  return summary;
}

/**
 * 造工具定义。可注入点全部走 options，便于单测不进宿主。
 *
 * @param {object} deps
 * @param {object} deps.toolkit - createSessionTelecom(...) 的返回（要 dispatch / registry）。
 * @param {Function} deps.defineTool - `@deepseek-ai/dsh-tools` 的 defineTool。
 * @param {Function} [deps.createRegistry] - 会话清单读取器工厂（默认 createSessionRegistry）。
 * @param {Function} [deps.deliver] - 投递实现（默认 deliverToSession）。
 * @returns {object} 可直接 `ctx.tools.register(...)` 的工具定义。
 */
export function createSessionTelecomTool(deps) {
  const { toolkit, defineTool } = deps;
  const createRegistry = typeof deps.createRegistry === 'function' ? deps.createRegistry : createSessionRegistry;
  const deliver = typeof deps.deliver === 'function' ? deps.deliver : deliverToSession;
  // 成本上限可注入：profile 想更严就传更小的值（默认见 DEFAULT_MAX_TEXT_BYTES）。
  const maxTextBytes = Number.isFinite(deps.maxTextBytes) && deps.maxTextBytes > 0
    ? Math.floor(deps.maxTextBytes)
    : DEFAULT_MAX_TEXT_BYTES;
  const defaultListLimit = Number.isFinite(deps.listLimit) && deps.listLimit > 0
    ? Math.floor(deps.listLimit)
    : DEFAULT_LIST_LIMIT;
  // 署名开关不在这一层处理：署名由投递层（lib/deliver.js）统一加，UI 与工具路径共用同一段文案。
  // 这里只把开关**透传**给投递层。
  const senderPrefix = deps.senderPrefix;

  return defineTool({
    name: SESSION_TELECOM_TOOL_NAME,
    description: [
      '与其他 DSH 会话通信：list 列出会话，send 把一条消息投给指定会话（冷会话自动唤醒，排队到它下一回合）。',
      '用途：把结论/请示/待办交给另一个会话，省掉用户手工复制粘贴。',
      '会话范围：仅支持当前 DSH 宿主可见的 DSH 会话，不支持查找、读取或接管 zcode 等外部平台会话。',
      '查找纪律：带 query 的 list 没有匹配，或 send 返回 session/not-found 时，必须停止这次查找并向用户报告。',
      '不得重复查询、改词扩大搜索、扫描会话日志或磁盘，也不得自行启动、委派或询问 agent 继续找；不得创建会话来替代缺失的目标。',
      '用户补充或更正 ID、提供外部会话内容或另行完成导入后，才可继续处理该目标；当前对话可以继续。',
      '纪律（重要，避免消息风暴）：投递成功后**不要把回执再投回去**——只有对方需要继续做事时才再发一条；',
      '对方不必为"确认收到"回投，也不要在收到消息时去翻会话日志核对身份（署名行里的 id 就是全部事实）。',
      'list 带 token 与缓存命中率，可据此判断该复用哪条会话。',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        description: 'list = 列出现存会话（含花费/冷热）；send = 投递一条消息给目标会话。',
        enum: ['list', 'send'],
      },
      query: {
        type: 'string',
        description: 'action=list 时的过滤词（匹配标题或会话 id，大小写不敏感）。无匹配就向用户报告并停止这次查找，不得调用 agent 或其他工具兜底搜索。',
      },
      limit: {
        type: 'number',
        description: `action=list 时最多返回多少条（默认 ${String(defaultListLimit)}，按最近活动倒序）。`,
      },
      targetSessionId: {
        type: 'string',
        description: 'action=send 必填：当前 DSH 宿主的目标会话 id（先用 action=list 取）；zcode 等外部平台的 ID 不适用。',
      },
      text: {
        type: 'string',
        description: 'action=send 必填：要投递的消息正文。宿主会自动在正文前加一行「[由 <发送方会话> 发送]」署名，你不用自己写。',
      },
      mode: {
        type: 'string',
        description: 'action=send 时的投递方式：queue=排到下一回合（默认），steer=插到下一步（仅对方在运行时有效）。',
        enum: ['queue', 'steer'],
      },
    },
    output: {
      // ⚠ 这份 schema 必须只用 DSH value schema DSL 认识的键。
      // 实测（用真实 @deepseek-ai/dsh-tools 的 defineTool 注册）：
      //   · 输出 schema **不允许 `required`** → `JsonSchemaError: schema.required is not supported`
      //   · `type` 只能是**单个**字符串，不能写 `['string','null']`
      //     （dsh-tools/lib/index.js:693-752：object 只认 type/properties/additionalProperties，
      //       primitive 只认 type/enum/const）
      // 所以"缺席"一律用**空串 / 0 / 省略键**表达，不用 null。
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', description: '这次调用是否成功' },
          action: { type: 'string', enum: ['list', 'send'], description: '实际执行的动作' },
          sessions: {
            type: 'array',
            description: 'action=list 时的 DSH 会话清单（按最近活动倒序，已按 query/limit 过滤）；带 query 的空列表表示无匹配，停止查找，不得委派 agent 继续搜索',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                title: { type: 'string', description: '标题；没有标题时为空串' },
                updatedAt: { type: 'number', description: '最近活动时间（epoch ms）' },
                live: { type: 'boolean' },
                running: { type: 'boolean' },
                archived: { type: 'boolean' },
                isSelf: { type: 'boolean' },
                tokens: { type: 'string', description: '累计输入+输出，已压缩成 1.2k/34M 形式；无数据显示空串' },
                billableTokens: { type: 'string', description: '其中按全价计费的部分（非缓存输入+输出）；无数据显示空串' },
                cacheHitRate: { type: 'number', description: '输入里走缓存的比例 0..1；无数据为 0' },
                contextLoad: { type: 'number', description: '上下文占用比例 0..1；无数据为 0' },
                hasUsage: { type: 'boolean', description: '这条会话是否有 token 用量数据（false 时上面的花费字段都不可信）' },
              },
            },
          },
          totals: {
            type: 'object',
            description: 'action=list 时的汇总（只统计有用量数据的会话）',
            additionalProperties: false,
            properties: {
              tokens: { type: 'string', description: '合计 token（压缩形式）；无数据为空串' },
              billableTokens: { type: 'string', description: '合计计费 token（非缓存输入+输出）' },
              cacheHitRate: { type: 'number', description: '总体缓存命中率 0..1' },
              sessionsWithUsage: { type: 'number', description: '有用量数据的会话条数' },
            },
          },
          delivered: { type: 'boolean', description: 'action=send 时：投递通道是否已接受' },
          targetSessionId: { type: 'string' },
          targetTitle: { type: 'string', description: '目标标题；取不到时为空串' },
          resumed: { type: 'boolean', description: 'action=send 时：目标原本是冷会话、已被唤醒' },
          error: {
            type: 'object',
            description: '失败时的结构化原因（code 供程序判断，message 供人读）',
            additionalProperties: false,
            properties: { code: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
      render(args, value) {
        if (value.ok !== true) {
          const stop = value.error?.code === 'session/not-found'
            ? '\n当前 DSH 宿主找不到目标会话。请向用户报告并停止这次查找；不得重试、扩大搜索、扫描日志/磁盘或自行调用 agent 继续找。zcode 等外部会话需要用户提供内容或另行导入；当前对话可以继续。'
            : '';
          return textBlock(`${String(args.action)} 失败：${value.error?.code ?? 'error'} — ${value.error?.message ?? ''}${stop}`);
        }
        if (value.action === 'send') {
          // 回执要短：一行、不重复目标 id（调用方刚给过），冷唤醒这种"意外"才额外提一句。
          const title = typeof value.targetTitle === 'string' && value.targetTitle.length > 0 ? value.targetTitle : '';
          const who = title.length > 0 ? `「${title}」` : '目标会话';
          return textBlock(`已投递给${who}${value.resumed === true ? '（原本是冷会话，已唤醒）' : ''}`);
        }
        if ((value.sessions ?? []).length === 0 && typeof args.query === 'string' && args.query.trim().length > 0) {
          return textBlock('当前 DSH 宿主没有匹配的会话。请向用户报告并停止这次查找；不得重复查询、改词扩大搜索、扫描日志/磁盘或自行调用 agent 继续找。zcode 等外部会话需要用户提供内容或另行导入；用户补充或更正信息后可继续处理，当前对话可以继续。');
        }
        const lines = (value.sessions ?? []).map((row) => {
          const marks = [
            row.isSelf ? '本会话' : null,
            row.running ? '运行中' : (row.live ? '在线' : '冷'),
            row.archived ? '已归档' : null,
            typeof row.tokens === 'string' && row.tokens.length > 0 ? `${row.tokens} tok` : null,
            typeof row.cacheHitRate === 'number' && row.cacheHitRate > 0 ? `缓存${String(Math.round(row.cacheHitRate * 100))}%` : null,
            typeof row.contextLoad === 'number' && row.contextLoad > 0 ? `上下文${String(Math.round(row.contextLoad * 100))}%` : null,
          ].filter((item) => item !== null);
          const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : '(无标题)';
          return `- ${row.id}  ${title}  [${marks.join(' · ')}]`;
        });
        // 汇总只留"计费"这一个真正决定花钱的数字，省掉一部分噪声。
        const totals = typeof value.totals?.billableTokens !== 'string' || value.totals.billableTokens.length === 0
          ? ''
          : `\n合计计费 ${value.totals.billableTokens} tok（${String(value.totals.sessionsWithUsage ?? 0)} 条有用量）`;
        return textBlock(`会话清单（${String((value.sessions ?? []).length)} 条）:\n${lines.join('\n')}${totals}`);
      },
    },
    async execute(args, exec) {
      const action = args.action === 'send' ? 'send' : 'list';
      const ctx = toolkit?.ctx;
      // 真实调用者：工具执行上下文里的 agent（拿不到就不带 relay 标记，绝不猜）。
      const senderSessionId = typeof exec?.agent?.session?.header?.id === 'string' ? exec.agent.session.header.id : null;

      if (action === 'list') {
        try {
          const registry = createRegistry(ctx, { selfSessionId: senderSessionId });
          const listed = await registry.list();
          const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
          const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : defaultListLimit;
          const rows = listed.sessions
            .filter((row) => query.length === 0
              || String(row.title ?? '').toLowerCase().includes(query)
              || String(row.id).toLowerCase().includes(query))
            .slice(0, limit)
            .map((row) => toRow(row, senderSessionId));
          const totals = listed.costTotals ?? {};
          // 同样受 DSL 约束：没有数据就给空串/0，不给 null。
          return {
            ok: true,
            action: 'list',
            sessions: rows,
            totals: {
              tokens: shortTokens(totals.tokens) ?? '',
              billableTokens: shortTokens(totals.billableTokens) ?? '',
              cacheHitRate: typeof totals.cacheHitRate === 'number' && Number.isFinite(totals.cacheHitRate)
                ? Math.round(totals.cacheHitRate * 1000) / 1000
                : 0,
              sessionsWithUsage: typeof totals.sessionsWithUsage === 'number' ? totals.sessionsWithUsage : 0,
            },
          };
        } catch (error) {
          const wire = toWireError(error);
          return { ok: false, action: 'list', error: { code: wire.code, message: wire.message } };
        }
      }

      const targetSessionId = typeof args.targetSessionId === 'string' ? args.targetSessionId.trim() : '';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (targetSessionId.length === 0) {
        return { ok: false, action: 'send', error: { code: 'bad-request', message: 'targetSessionId is required for action="send"' } };
      }
      if (text.length === 0) {
        return { ok: false, action: 'send', error: { code: 'bad-request', message: 'text is required for action="send"' } };
      }
      // 发信人署名由 **投递层** 统一加（lib/deliver.js 的 attributionLine），UI 路径与工具路径
      // 共用同一段文案。工具这一层只管把原文交出去，避免出现两行署名。
      const body = text;
      if (Buffer.byteLength(body, 'utf8') > maxTextBytes) {
        return {
          ok: false,
          action: 'send',
          error: {
            code: 'bad-request',
            message: `text exceeds ${String(maxTextBytes)} bytes; send a summary or a file path instead of pasting a large document`,
          },
        };
      }

      try {
        const value = await deliver(ctx, {
          targetSessionId,
          text: body,
          mode: normalizeSendMode(args.mode),
          senderSessionId,
          // 署名开关透传给投递层（默认开）；正文长短的上限在这一层已经查过。
          ...(senderPrefix === undefined ? {} : { senderPrefix }),
        });
        // 标题只是给人看的；取不到就给空串（DSL 不允许 null）。
        let targetTitle = '';
        try {
          const registry = createRegistry(ctx, { selfSessionId: senderSessionId });
          const listed = await registry.list();
          const row = listed.sessions.find((item) => item.id === targetSessionId);
          if (row !== undefined && typeof row.title === 'string' && row.title.length > 0) targetTitle = row.title;
        } catch {
          /* 标题取不到不影响投递结果 */
        }
        return {
          ok: true,
          action: 'send',
          delivered: value.delivered === true,
          targetSessionId,
          targetTitle,
          resumed: value.live === false,
        };
      } catch (error) {
        const wire = toWireError(error);
        return { ok: false, action: 'send', error: { code: wire.code, message: wire.message } };
      }
    },
    finalizeContent(exec, result) {
      // render 已直接返回块数组（见 textBlock 的注释）；这里只做**旧路径兜底**，幂等：
      // 万一某个调用方仍把字符串塞进 content，就在 post-execute 之后把它转正。
      const text = result?.content;
      return typeof text === 'string' && text.length > 0 ? textBlock(text) : undefined;
    },
  });
}

/**
 * 把工具注册进宿主。`ctx.inject(['tools'], …)` 会在 tools 服务就绪时回调，
 * 卸载时 dispose 自动摘掉工具。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} toolkit - createSessionTelecom(...) 返回。
 * @param {Function|undefined} defineTool - 测试注入；正式运行时从宿主惰性加载。
 * @param {{onWarn?: Function, maxTextBytes?: number, listLimit?: number}} [options]
 *        成本上限等插件配置要**从这一层透传下去**，否则外面配了也不生效（踩过：只加在工厂里）。
 * @returns {boolean} 是否成功排上注册。
 */
export function registerSessionTelecomTool(ctx, toolkit, defineTool, options = {}) {
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};
  try {
    if (typeof ctx?.inject !== 'function') return false;
    ctx.inject(['tools'], (sctx) => {
      try {
        const tools = tryGet(sctx, 'tools');
        if (typeof tools?.register !== 'function') {
          onWarn(new Error('Host tools.register is unavailable'));
          return;
        }
        sctx.effect(() => {
          let stopped = false;
          let dispose;
          const install = (factory) => {
            if (stopped) return;
            if (typeof factory !== 'function') throw new Error('Host defineTool is unavailable');
            const tool = createSessionTelecomTool({
              toolkit,
              defineTool: factory,
              ...(options.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
              ...(options.listLimit === undefined ? {} : { listLimit: options.listLimit }),
              ...(options.senderPrefix === undefined ? {} : { senderPrefix: options.senderPrefix }),
            });
            dispose = tools.register(tool);
          };
          if (typeof defineTool === 'function') install(defineTool);
          else {
            const load = options.loadTools ?? (() => import('@deepseek-ai/dsh-tools'));
            Promise.resolve().then(load).then((mod) => install(mod?.defineTool)).catch((error) => {
              if (!stopped) onWarn(error);
            });
          }
          return () => {
            stopped = true;
            try {
              if (typeof dispose === 'function') dispose();
            } catch (error) {
              onWarn(error);
            }
          };
        }, 'dsh-session-telecom: session_telecom tool');
      } catch (error) {
        onWarn(error);
      }
    });
    return true;
  } catch (error) {
    onWarn(error);
    return false;
  }
}

export { tryGet };

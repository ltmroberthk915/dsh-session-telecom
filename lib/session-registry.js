// 会话清单：把内核里散在三个服务里的字段拼成客户端要的一行。
//
// 数据来源（都读过真实现，不是猜的）：
//   - ctx.sessionQuery.listSessions(signal)  → 全量（live + 落盘的）记录
//         dsh-session-query/lib/index.js:95，每条 { header, live, persisted }
//   - 标题 / blank / lastPromptAt：sessionListMetadata 投影
//         （api-session-controller/lib/index.js:1807）与 title 投影
//         （dsh-session-title/lib/index.js:172）
//   - 归档：ctx.workspaceRegistry.archivedSessionIds（dsh-workspace/lib/index.js:504）
//
// 语义坑（已按内核行为对齐）：
//   1. sessionQuery 回的是 **header**，里面**没有 workspaceId**（header 只有 version/id/
//      createdAt/cwd/parentSession/isSeeded/origin/delegationDepth/agentPreset）。
//      所以 workspaceId 只能靠 workspaceRegistry 的 { id, path } 与 cwd 比出来，比不到就 null。
//   2. live 会话读内存投影（cachedSnapshot 不 fold，快）；冷会话读 projectionCache。
//      两条路都可能不存在（headless / 测试 stub）→ 逐级降级，绝不抛。
//   3. api-session.list 会把 header.cwd === undefined 的冷会话整行丢掉（:1900），这里照抄，
//      否则客户端会看到自己点不开的行。
//   4. blank 的行直接不返回（契约要求）。内核语义：blank 表示「还没有过 turn/start」。

/** 投影 key（与 api-session-controller 注册的 key 逐字一致）。 */
const LIST_METADATA_KEY = 'sessionListMetadata';
const TITLE_KEY = 'title';
/** token-meter 注册的两个投影 key（dsh-token-meter/lib/types/usage-projection.js:87 / :121）。 */
const TOKEN_USAGE_KEY = 'tokenUsage';
const CONTEXT_PRESSURE_KEY = 'contextPressure';

/** 一次 cachedSnapshot 要读的全部 key（投影插件不在时多读几个 key 也无害）。 */
const PROJECTION_KEYS = [TITLE_KEY, LIST_METADATA_KEY, TOKEN_USAGE_KEY, CONTEXT_PRESSURE_KEY];
// Only short metadata is retained; weak keys release it with the live Session.
const TRANSCRIPT_METADATA_CACHE = new WeakMap();

/**
 * 无异常地取服务。
 *
 * cordis 4 里 `ctx.missingService` **会抛**（reflect handler:676 `cannot get property
 * "x" without inject`），只有 `ctx.get(name)` 才安全返回 undefined（cordis/lib/index.js:763）。
 * 所以可选服务一律走这里：先 `ctx.get`，再退回属性访问（测试 stub / 老 runtime）。
 *
 * @param {object} ctx
 * @param {string} name
 * @returns {any|undefined}
 */
export function tryGet(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    }
  } catch {
    /* 落到属性访问 */
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 建一个会话清单读取器。
 * @param {object} ctx - cordis host 上下文（或测试 stub）。
 * @param {object} [options] - 覆写点。
 * @param {(error: unknown, context: string) => void} [options.onWarn] - 降级告警。
 * @param {string|(() => (string|null))} [options.selfSessionId] - 已知的当前会话 id。
 * @returns {{list: (signal?: AbortSignal) => Promise<{sessions: object[], selfSessionId: string|null}>}}
 */
export function createSessionRegistry(ctx, options = {}) {
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : () => {};
  const selfId = resolveSelfId(options.selfSessionId);

  function liveMetadata(session) {
    if (typeof session?.snapshotEvents !== 'function') return transcriptMetadata([]);
    const cached = TRANSCRIPT_METADATA_CACHE.get(session);
    if (cached && Number.isSafeInteger(session.seq) && cached.seq === session.seq) return cached.value;
    try {
      const events = session.snapshotEvents();
      const value = transcriptMetadata(Array.isArray(events) ? events : []);
      TRANSCRIPT_METADATA_CACHE.set(session, { seq: session.seq, value });
      return value;
    } catch (error) {
      onWarn(error, 'session.snapshotEvents');
      return transcriptMetadata([]);
    }
  }

  /** 一次性把 workspaceId 查找表建好：canonical path → id（Windows 大小写不敏感）。 */
  function workspaceTable() {
    const table = new Map();
    try {
      const registry = tryGet(ctx, 'workspaceRegistry');
      if (registry === undefined || typeof registry.list !== 'function') return table;
      for (const entity of registry.list() ?? []) {
        if (typeof entity?.path !== 'string' || entity.path.length === 0) continue;
        if (typeof entity.id !== 'string') continue;
        table.set(normalizePath(entity.path), entity.id);
      }
    } catch (error) {
      onWarn(error, 'workspaceRegistry.list');
    }
    return table;
  }

  /** 归档集合：注册表不可用时返回空集合（不抛）。 */
  function archivedIds() {
    try {
      const registry = tryGet(ctx, 'workspaceRegistry');
      const ids = registry?.archivedSessionIds;
      return Array.isArray(ids) ? new Set(ids) : new Set();
    } catch (error) {
      onWarn(error, 'workspaceRegistry.archivedSessionIds');
      return new Set();
    }
  }

  /**
   * 读取一行会话的投影值（title / blank / lastPromptAt / 花费）。
   *
   * 四个投影都是**同一个 cachedSnapshot 调用**读出来的（内核契约：一次给多个 key）。
   * `tokenUsage` 与 `contextPressure` 由 dsh-token-meter 注册，未装载时 values 里就没有这两个 key，
   * 于是 cost 全为 null —— 客户端据此隐藏花费列，不当成错误。
   */
  function projectionValues(entry) {
    const empty = { title: null, blank: undefined, lastPromptAt: undefined, cost: emptyCost() };
    try {
      const projections = tryGet(ctx, 'sessionProjections');
      if (projections === undefined) return empty;
      const session = entry.session;
      if (session !== undefined && typeof projections.cachedSnapshot === 'function') {
        return readBlock(projections.cachedSnapshot(session, PROJECTION_KEYS), empty);
      }
      const cache = tryGet(ctx, 'sessionProjectionCache');
      if (cache !== undefined && entry.header !== undefined) {
        const block = typeof cache.cachedSnapshot === 'function'
          ? cache.cachedSnapshot(entry.header, PROJECTION_KEYS)
          : (typeof cache.cachedPredecessorTitle === 'function' ? cache.cachedPredecessorTitle(entry.header) : undefined);
        return readBlock(block, empty);
      }
    } catch (error) {
      onWarn(error, 'sessionProjections');
    }
    return empty;
  }

  /** 枚举：优先 sessionQuery（含冷会话），不可用时退回 ctx.sessions.list()（仅 live）。 */
  async function enumerate(signal) {
    signal?.throwIfAborted?.();
    const query = tryGet(ctx, 'sessionQuery');
    const sessions = tryGet(ctx, 'sessions');
    if (query !== undefined && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions(signal);
        signal?.throwIfAborted?.();
        return (records ?? []).map((record) => {
          const id = record?.header?.id;
          const live = typeof sessions?.get === 'function' ? sessions.get(id) : undefined;
          return {
            header: record?.header ?? { id },
            session: live,
            live: record?.live === true || live !== undefined,
          };
        });
      } catch (error) {
        signal?.throwIfAborted?.();
        onWarn(error, 'sessionQuery.listSessions');
      }
    }
    if (sessions === undefined || typeof sessions.list !== 'function') return [];
    return (sessions.list() ?? []).map((session) => ({ header: session.header, session, live: true }));
  }

  /**
   * 组装客户端要的清单：排除 blank、按 updatedAt 倒序、标出 live / running / isSelf。
   * @param {AbortSignal} [signal] - 取消信号（透传给 persistence 读取）。
   * @returns {Promise<{sessions: object[], selfSessionId: string|null}>}
   */
  async function list(signal) {
    const entries = await enumerate(signal);
    const workspaces = workspaceTable();
    const archived = archivedIds();
    const rows = [];
    for (const entry of entries) {
      const header = entry.header;
      const id = typeof header?.id === 'string' ? header.id : undefined;
      if (id === undefined || id.length === 0) continue;
      const { title, blank, lastPromptAt, cost } = projectionValues(entry);
      // blank 判定与内核 summaryFor 一致：投影优先，没有投影就退化成「一个事件都没有」。
      const isBlank = typeof blank === 'boolean' ? blank : entry.session !== undefined && entry.session.seq === 0;
      if (isBlank) continue;
      // 内核把没有 cwd 的冷会话整行丢掉（api-session-controller/lib/index.js:1900）；live 不受限。
      if (header?.cwd === undefined && entry.live !== true) continue;
      const agent = typeof ctx?.agents?.get === 'function' ? ctx.agents.get(id) : undefined;
      const transcript = liveMetadata(entry.session);
      rows.push({
        id,
        title: title ?? '',
        cwd: typeof header?.cwd === 'string' ? header.cwd : '',
        updatedAt: Math.max(updatedAtOf(header, lastPromptAt), transcript.lastEventAt),
        ...transcript,
        workspaceId: header?.cwd === undefined ? null : (workspaces.get(normalizePath(header.cwd)) ?? null),
        archived: archived.has(id),
        blank: false,
        live: entry.live === true && entry.session !== undefined,
        running: agent?.status === 'running',
        isSelf: id === selfId,
        // 花费/上下文：纯增量字段，客户端可选择忽略（老客户端不受影响）。
        ...cost,
      });
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt);
    return { sessions: rows, selfSessionId: selfId, costTotals: sumCost(rows) };
  }

  return { list };
}

/**
 * 当前会话 id：宿主没有把这个信息交给插件（插件 ctx 是全宿主共享的），
 * 认不出来就老实回 null，绝不猜一个塞给 UI。
 * @param {string|Function|undefined} source
 * @returns {string|null}
 */
export function resolveSelfId(source) {
  try {
    const value = typeof source === 'function' ? source() : source;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * 环境兜底：`DSH_SESSION_ID`（本机实测存在，宿主/CLI 启动会话时会设，
 * 但**不保证**一定存在，也不保证就是"客户端当前打开的那个会话"）。
 *
 * 调用方必须显式把 env 传进来（`options.env`），这样单测能与真实环境解耦：
 *   - 不传 env / 传 undefined → 读 process.env（生产默认）
 *   - 传 `{}`                → 明确表示"不许读环境"，测试用
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function envSelfSessionId(env) {
  try {
    const value = env?.DSH_SESSION_ID;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

function readBlock(block, empty) {
  const values = block?.values;
  if (values === null || typeof values !== 'object') return empty;
  const metadata = values[LIST_METADATA_KEY];
  return {
    title: typeof values[TITLE_KEY] === 'string' && values[TITLE_KEY].length > 0 ? values[TITLE_KEY] : null,
    blank: typeof metadata?.blank === 'boolean' ? metadata.blank : undefined,
    lastPromptAt: typeof metadata?.lastPromptAt === 'number' ? metadata.lastPromptAt : undefined,
    cost: readCost(values),
  };
}

/** 花费字段的"无数据"形状：全部 null，客户端据此隐藏列。 */
function emptyCost() {
  return {
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
  };
}

/** 非负有限整数才收；其余（undefined / NaN / 负数）算作"没数据"。 */
function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * 从投影 values 里折出花费与上下文压力。
 *
 * 数据来源（逐字段对过内核 schema，见 dsh-token-meter/lib/types/usage-projection.js:30-78）：
 *   - `tokenUsage`       = { totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last }
 *   - `contextPressure`  = { pressureTokens?, projectedTokens?, contextWindow?, surfaceTokens, claim? }
 *
 * 两个派生量（都是为了"一眼看出哪条会话在烧钱"）：
 *   - `billableTokens` = uncachedInputTokens + outputTokens
 *        只算真正按全价计费的部分；缓存读/写不计入，避免"缓存命中高=看着很贵"的误判。
 *   - `cacheHitRate`   = cacheReadTokens / (uncachedInputTokens + cacheReadTokens)
 *        分母是"全部输入 token"，也就是缓存带来的折扣有多深。
 * 上下文占用优先取 pressureTokens（真实压力），退回 projectedTokens（预测值）。
 */
function readCost(values) {
  const cost = emptyCost();
  const usage = values[TOKEN_USAGE_KEY];
  const totals = usage?.totals ?? usage;
  if (totals !== null && typeof totals === 'object') {
    const uncachedInput = nonNegative(totals.uncachedInputTokens);
    const output = nonNegative(totals.outputTokens);
    const cacheRead = nonNegative(totals.cacheReadTokens);
    const cacheWrite = nonNegative(totals.cacheWriteTokens);
    const input = uncachedInput === null && cacheRead === null && cacheWrite === null
      ? null
      : (uncachedInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    if (input !== null || output !== null) {
      cost.inputTokens = input;
      cost.outputTokens = output;
      cost.cacheReadTokens = cacheRead;
      cost.cacheWriteTokens = cacheWrite;
      cost.tokens = (input ?? 0) + (output ?? 0);
      cost.billableTokens = (uncachedInput ?? 0) + (output ?? 0);
      const cacheDenominator = (uncachedInput ?? 0) + (cacheRead ?? 0);
      cost.cacheHitRate = cacheDenominator > 0 ? (cacheRead ?? 0) / cacheDenominator : null;
    }
  }
  const pressure = values[CONTEXT_PRESSURE_KEY];
  if (pressure !== null && typeof pressure === 'object') {
    const contextTokens = nonNegative(pressure.pressureTokens) ?? nonNegative(pressure.projectedTokens);
    const contextWindow = typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
      ? Math.floor(pressure.contextWindow)
      : null;
    cost.contextTokens = contextTokens;
    cost.contextWindow = contextWindow;
    // 预留给客户端的 0..1 比例；窗口未知时不给（不猜）。
    cost.contextLoad = contextTokens !== null && contextWindow !== null && contextWindow > 0
      ? Math.min(1, contextTokens / contextWindow)
      : null;
  }
  return cost;
}

/** 把多行花费加成一份总量（给模态底部的"这次会话群花了多少"）。 */
export function sumCost(rows) {
  const total = emptyCost();
  let tokens = 0;
  let billable = 0;
  let cacheRead = 0;
  let uncachedInput = 0;
  let seen = 0;
  for (const row of rows ?? []) {
    if (typeof row?.tokens !== 'number') continue;
    seen += 1;
    tokens += row.tokens;
    billable += row.billableTokens ?? 0;
    cacheRead += row.cacheReadTokens ?? 0;
    uncachedInput += (row.inputTokens ?? 0) - (row.cacheReadTokens ?? 0) - (row.cacheWriteTokens ?? 0);
  }
  if (seen === 0) return total;
  total.tokens = tokens;
  total.billableTokens = billable;
  total.cacheReadTokens = cacheRead;
  total.inputTokens = uncachedInput + cacheRead;
  total.cacheHitRate = uncachedInput + cacheRead > 0 ? cacheRead / (uncachedInput + cacheRead) : null;
  total.sessionsWithUsage = seen;
  return total;
}

/** 与 api-session-controller 的 updatedAt 一致：createdAt 与 lastPromptAt 取大。 */
function updatedAtOf(header, lastPromptAt) {
  const created = typeof header?.createdAt === 'number' ? header.createdAt : 0;
  const prompt = typeof lastPromptAt === 'number' ? lastPromptAt : 0;
  return Math.max(created, prompt);
}

/** 路径比较用的规范化（Windows 大小写不敏感 + 统一分隔符 + 去尾斜杠）。 */
function normalizePath(value) {
  if (typeof value !== 'string') return '';
  let normalized = value.replace(/\//g, '\\').replace(/\\+$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

/** Read only semantic text blocks; tool calls and reasoning are not assistant answers. */
export function eventText(event) {
  const message = event?.data?.message ?? event?.data;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

/** Live metadata only: list never performs a cold transcript read for a preview. */
export function transcriptMetadata(events) {
  let assistant;
  let user;
  for (let i = events.length - 1; i >= 0 && (!assistant || !user); i--) {
    const event = events[i];
    if (!assistant && event?.type === 'assistant/message') assistant = event;
    if (!user && event?.type === 'user/message') user = event;
  }
  const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    lastEventAt: time(events.at(-1)?.time),
    lastAssistantAt: time(assistant?.time),
    lastUserAt: time(user?.time),
    lastAssistantPreview: Array.from(eventText(assistant).replace(/\s+/g, ' ').trim()).slice(0, 100).join(''),
  };
}

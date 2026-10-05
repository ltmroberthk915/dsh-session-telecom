// Read through the host's logical session store. The host owns discovery,
// format validation and multi-frame decompression; this plugin never scans files.
import { SESSION_TELECOM_ERROR_CODES as CODES } from './api.js';
import { ToolkitError, sessionNotFound } from './errors.js';
import { eventText, transcriptMetadata, tryGet } from './session-registry.js';

export const DEFAULT_READ_LAST = 5;
export const MAX_READ_LAST = 50;
export const DEFAULT_MAX_READ_BYTES = 32 * 1024;
export const READ_MODES = Object.freeze(['summary', 'tail', 'raw']);

export function createSessionReader(ctx, options = {}) {
  const maxBytes = Number.isSafeInteger(options.maxReadBytes) && options.maxReadBytes >= 256
    ? options.maxReadBytes : DEFAULT_MAX_READ_BYTES;

  async function read(payload = {}, signal) {
    const sessionId = string(payload.sessionId) || string(payload.targetSessionId);
    if (!sessionId) throw new ToolkitError(CODES.badRequest, 'sessionId is required for read');
    if (string(payload.sessionId) && string(payload.targetSessionId) && payload.sessionId.trim() !== payload.targetSessionId.trim()) {
      throw new ToolkitError(CODES.badRequest, 'sessionId and targetSessionId must identify the same session');
    }
    const mode = payload.mode ?? 'summary';
    if (!READ_MODES.includes(mode)) throw new ToolkitError(CODES.badRequest, 'read mode must be summary, tail or raw');
    const last = payload.last ?? DEFAULT_READ_LAST;
    if (!Number.isSafeInteger(last) || last < 1 || last > MAX_READ_LAST) {
      throw new ToolkitError(CODES.badRequest, `last must be an integer from 1 to ${MAX_READ_LAST}`);
    }
    const snapshot = await readSessionSnapshot(ctx, sessionId, signal);
    const { events, header, source } = snapshot;
    const metadata = transcriptMetadata(events);
    let text;
    let truncated = false;
    if (mode === 'raw') {
      // Keep complete JSONL records. Never turn a size limit into invalid JSON.
      const lines = [];
      let bytes = 0;
      const tail = events.slice(-last);
      for (let i = tail.length - 1; i >= 0; i--) {
        const line = JSON.stringify(tail[i]);
        const size = Buffer.byteLength(line, 'utf8') + (lines.length ? 1 : 0);
        if (bytes + size > maxBytes) { truncated = true; break; }
        bytes += size;
        lines.unshift(line);
      }
      text = lines.join('\n');
    } else if (mode === 'tail') {
      const lines = events.slice(-last).map(event => {
        const content = eventText(event) || JSON.stringify(event.data ?? {});
        const clipped = clip(content, maxBytes);
        truncated ||= clipped.truncated;
        return `[seq=${event.seq ?? -1} ${event.type ?? 'unknown'} time=${timestamp(event.time)}]\n${clipped.text}`;
      });
      const clipped = clip(lines.join('\n\n'), maxBytes, true);
      text = clipped.text;
      truncated ||= clipped.truncated;
    } else {
      const assistant = events.findLast(event => event.type === 'assistant/message');
      const prompts = [];
      for (let i = events.length - 1; i >= 0 && prompts.length < last; i--) {
        if (events[i].type === 'user/message') {
          const prompt = clip(eventText(events[i]), 512);
          truncated ||= prompt.truncated;
          prompts.unshift(`[seq=${events[i].seq ?? -1}] ${prompt.text}`);
        }
      }
      const answer = assistant ? eventText(assistant) : '';
      const promptText = clip(prompts.join('\n') || '（无）', Math.floor(maxBytes / 4), true);
      const intro = `最后一条助手回答${assistant ? `（seq=${assistant.seq ?? -1}）` : ''}：\n`;
      const promptSection = `\n\n最近用户指令：\n${promptText.text}`;
      const result = clip(answer || '（无文本回答）', maxBytes - Buffer.byteLength(intro + promptSection, 'utf8'));
      text = intro + result.text + promptSection;
      truncated ||= result.truncated || promptText.truncated;
    }
    signal?.throwIfAborted?.();
    return {
      sessionId,
      cwd: string(header.cwd),
      source,
      mode,
      lastSeq: Number.isSafeInteger(events.at(-1)?.seq) ? events.at(-1).seq : -1,
      ...metadata,
      text,
      truncated,
    };
  }
  return { read };
}

/** Reads never resume an agent, flush a writer or take write ownership. */
export async function readSessionSnapshot(ctx, sessionId, signal) {
  signal?.throwIfAborted?.();
  try {
    const live = tryGet(ctx, 'sessions')?.get?.(sessionId) ?? tryGet(ctx, 'agents')?.get?.(sessionId)?.session;
    if (typeof live?.snapshotEvents === 'function') {
      return snapshot(live.header, live.snapshotEvents(), 'live', sessionId);
    }
    const query = tryGet(ctx, 'sessionQuery');
    if (typeof query?.observeSession === 'function') {
      const lease = await query.observeSession(sessionId, { signal, projectionMode: 'none' });
      try {
        signal?.throwIfAborted?.();
        // Some older hosts expose metadata-only observations. Use their read API below.
        if (Array.isArray(lease?.events)) return snapshot(lease.header, lease.events, 'session-query', sessionId);
      } finally {
        if (typeof lease?.[Symbol.dispose] === 'function') lease[Symbol.dispose]();
        else if (typeof lease?.dispose === 'function') await lease.dispose();
      }
    }
    if (typeof query?.readSession === 'function') {
      const loaded = await query.readSession(sessionId);
      signal?.throwIfAborted?.();
      return snapshot(loaded?.header ?? loaded?.session, loaded?.events, 'session-query', sessionId);
    }
    const persistence = tryGet(ctx, 'sessionPersistence');
    if (typeof persistence?.open === 'function') {
      const readOptions = signal ? { signal } : undefined;
      const handle = await persistence.open(sessionId, 'read', readOptions);
      try {
        const loaded = await handle.read(0, undefined, readOptions);
        signal?.throwIfAborted?.();
        return snapshot(handle.header, loaded?.events, 'session-persistence', sessionId);
      } finally {
        await handle.close();
      }
    }
    if (typeof persistence?.load === 'function') {
      const loaded = await persistence.load(sessionId, signal ? { signal } : undefined);
      signal?.throwIfAborted?.();
      if (!loaded) throw sessionNotFound(sessionId);
      return snapshot(loaded.header ?? loaded.snapshot?.header, loaded.events ?? loaded.snapshot?.events, 'session-persistence', sessionId);
    }
    throw new ToolkitError(CODES.readUnavailable, 'host session reading is unavailable; no agent was awakened', { sessionId });
  } catch (error) {
    signal?.throwIfAborted?.();
    if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error?.name === 'SessionPersistenceNotFoundError') throw sessionNotFound(sessionId);
    throw error;
  }
}

function snapshot(header, events, source, sessionId) {
  if (!Array.isArray(events)) throw new ToolkitError(CODES.readUnavailable, 'host returned no session events', { sessionId });
  if (header?.id && header.id !== sessionId) throw new ToolkitError(CODES.internal, 'host returned a different session identity', { sessionId, actualSessionId: header.id });
  return { header: header ?? {}, events: events.slice(), source };
}

function timestamp(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0; }
function string(value) { return typeof value === 'string' ? value.trim() : ''; }

/** UTF-8 bounds without splitting a character; tail output keeps the newest text. */
function clip(value, maxBytes, fromEnd = false) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return { text: value, truncated: false };
  const marker = '…';
  const budget = maxBytes - Buffer.byteLength(marker);
  let start = fromEnd ? buffer.length - budget : 0;
  let end = fromEnd ? buffer.length : budget;
  if (fromEnd) while ((buffer[start] & 0xc0) === 0x80) start++;
  else while ((buffer[end] & 0xc0) === 0x80) end--;
  const text = buffer.subarray(start, end).toString('utf8');
  return { text: fromEnd ? marker + text : text + marker, truncated: true };
}

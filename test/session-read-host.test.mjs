// Optional real-backend regression. Uses only a disposable fixture directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
import { createSessionReader } from '../lib/session-reader.js';

const kernelRoot = process.env.DSH_KERNEL_ROOT ?? join(homedir(), '.dsh', 'profiles', 'node_modules');
const backendPath = join(kernelRoot, '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js');

test('real host backend reads every zstd frame from its configured root', async t => {
  if (!existsSync(backendPath) || typeof zlib.zstdCompressSync !== 'function') {
    t.skip('Optional host JSONL backend or native zstd unavailable');
    return;
  }
  const load = pkg => import(pathToFileURL(join(kernelRoot, '@deepseek-ai', pkg, 'lib', 'index.js')).href);
  const [{ Context }, { default: Persistence }, { sessionFormatCatalog }] = await Promise.all([
    load('cordis'), load('dsh-session-persistence-jsonl'), load('dsh-session-format-catalog'),
  ]);
  const root = await mkdtemp(join(tmpdir(), 'dsh-telecom-read-'));
  const ctx = new Context();
  try {
    const backend = new Persistence(ctx, { root, compression: 'zstd' });
    const header = { version: 4, id: 'session-multi-frame', createdAt: 1, cwd: root, isSeeded: false, delegationDepth: 0 };
    // Ignorable extension events exercise physical decoding without a model turn.
    const events = [0, 1].map(seq => ({ type: 'telecom/read-fixture', seq, time: seq + 1, ignorable: true, data: { marker: `frame-${seq + 2}` } }));
    const records = [sessionFormatCatalog.encodeCurrentHeader(header, 0), ...events.map(event => sessionFormatCatalog.encodeCurrentEvent(event))];
    const frames = records.map(record => zlib.zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n')));
    const path = backend.locate(header).path;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.concat(frames));
    const reader = createSessionReader({ sessionPersistence: backend });
    const result = await reader.read({ sessionId: header.id, mode: 'raw', last: 2 });
    assert.deepEqual(result.text.split('\n').map(JSON.parse), events);
    assert.equal(result.lastSeq, 1);
    assert.equal(result.source, 'session-persistence');
  } finally {
    await ctx.scope?.dispose?.();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('dsh-telecom-read-'));
    await rm(root, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSessionTelecomTool } from '../lib/tool.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function context() {
  const registrations = [];
  const cleanups = [];
  const warnings = [];
  let removed = 0;
  const tools = { register(tool) { registrations.push(tool); return () => removed++; } };
  const ctx = {
    get: key => key === 'tools' ? tools : undefined,
    effect: fn => { const release = fn(); cleanups.push(release); },
    inject: (_names, fn) => fn(ctx),
  };
  return { ctx, registrations, warnings, get removed() { return removed; }, stop: () => cleanups.forEach(fn => fn()), warn: error => warnings.push(error) };
}
test('helper import is lazy and missing host API does not throw from registration', async () => {
  const c = context();
  assert.equal(registerSessionTelecomTool(c.ctx, { ctx: c.ctx }, undefined, {
    loadTools: async () => { throw new Error('host API unavailable'); }, onWarn: c.warn,
  }), true);
  await flush();
  assert.equal(c.registrations.length, 0);
  assert.match(c.warnings[0].message, /host API unavailable/);
  c.stop();
});
test('disposing while the helper loads prevents late registration', async () => {
  const c = context();
  const deferred = Promise.withResolvers();
  registerSessionTelecomTool(c.ctx, { ctx: c.ctx }, undefined, { loadTools: () => deferred.promise, onWarn: c.warn });
  c.stop();
  deferred.resolve({ defineTool: options => options });
  await flush();
  assert.equal(c.registrations.length, 0);
  assert.equal(c.warnings.length, 0);
});
test('available helper registers the new tool and disposal removes it', async () => {
  const c = context();
  registerSessionTelecomTool(c.ctx, { ctx: c.ctx }, undefined, { loadTools: async () => ({ defineTool: options => options }), onWarn: c.warn });
  await flush();
  assert.equal(c.registrations.length, 1);
  assert.equal(c.registrations[0].name, 'session_telecom');
  c.stop();
  assert.equal(c.removed, 1);
});
test('incompatible host helper disables only the model tool', async () => {
  const c = context();
  registerSessionTelecomTool(c.ctx, { ctx: c.ctx }, undefined, { loadTools: async () => ({}), onWarn: c.warn });
  await flush();
  assert.equal(c.registrations.length, 0);
  assert.match(c.warnings[0].message, /defineTool/);
});

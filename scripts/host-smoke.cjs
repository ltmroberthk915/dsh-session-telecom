// Run with the real DSH runtime in an isolated, npm-installed test profile.
// Electron distributions: ELECTRON_RUN_AS_NODE=1 <Electron> --expose-internals this-file.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

async function main() {
  const runtime = process.env.DSH_TEST_RUNTIME;
  const profileDir = process.env.DSH_TEST_PROFILE;
  const testHome = process.env.DSH_TEST_HOME;
  assert.ok(runtime && profileDir && testHome, 'Set DSH_TEST_RUNTIME, DSH_TEST_PROFILE and DSH_TEST_HOME');
  assert.notEqual(path.resolve(testHome).toLowerCase(), path.join(require('node:os').homedir(), '.dsh').toLowerCase(), 'Never test in the user home');
  process.env.DSH_HOME = testHome;
  process.env.DSH_TELEMETRY_DISABLED = '1';
  const load = pkg => import(pathToFileURL(path.join(runtime, 'node_modules', '@deepseek-ai', pkg, 'lib', 'index.js')).href);
  const boot = await load('dsh-app-boot');
  const { runProfile } = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/dsh/lib/profile-boot.js')).href);
  const installAnchor = path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
  const profile = boot.loadProfileDirectory('dsh', profileDir, installAnchor);
  assert.deepEqual(profile.skippedBundles, [], 'Every profile bundle must load');
  const { ctx, shutdown } = await runProfile({ environment: boot.loadLayeredEnv('dsh'), profile: 'probe', resolvedProfile: { profile, installAnchor }, patchFiles: [], args: ['--no-open', '--port', '0'] });
  try {
    const core = await load('dsh-tools');
    assert.equal(typeof ctx.tools[core.TOOL_RUNTIME_SCHEDULER]?.prepare, 'function', 'Tool registry and agent loop must share the same module instance');
    for (let retry = 0; retry < 100 && !ctx.tools.get('session_telecom'); retry++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(ctx.tools.get('session_telecom'), 'Model tool must be registered');
    assert.equal(ctx.tools.get('inbox_check'), undefined, 'No mandatory inbox tool from the colliding package');
    const { LlmAdapter, createUserMessage } = await load('dsh-llm');
    class Fixture extends LlmAdapter {
      async *stream(options) {
        const afterTool = options.messages.some(message => message.role === 'tool');
        const block = afterTool
          ? { type: 'text', text: 'test reply ok' }
          : { type: 'tool-call', id: `probe-${randomUUID()}`, name: 'session_telecom', arguments: '{"action":"list"}' };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['telecom-regression'], new Fixture());
    const reports = [];
    for (let n = 0; n < 2; n++) {
      const sessionId = `telecom-regression-${randomUUID()}`;
      const events = [];
      const release = ctx.on('session/event', (session, event) => { if (session.id === sessionId) events.push(event); });
      const handle = await ctx.agents.create({ sessionId, meta: { cwd: testHome }, agentOptions: { provider: 'telecom-regression', model: 'fixture' } });
      try {
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'test reply ok' }] }));
        await handle.agent.whenIdle();
        const calls = events.filter(event => event.type === 'tool/call');
        const results = events.filter(event => event.type === 'tool/result');
        const end = events.findLast(event => event.type === 'turn/end');
        assert.equal(calls.length, 1, JSON.stringify(events.map(e => ({ type: e.type, ...(e.type === 'turn/end' ? { data: e.data } : {}) }))));
        assert.equal(calls[0].data.name, 'session_telecom');
        assert.equal(results.length, 1);
        assert.equal(results[0].data.message.isError, false, JSON.stringify(results[0]));
        assert.equal(end.data.reason.kind, 'completed', JSON.stringify(end));
        assert.ok(events.some(event => event.type === 'assistant/message' && event.data.message?.content?.some(block => block.text === 'test reply ok')), 'Final assistant reply must be durable');
        reports.push({ sessionId, tool: calls[0].data.name, resultIsError: false, turnEnd: end.data.reason.kind });
      } finally { release(); await handle.dispose(); }
    }
    const report = { passed: true, runtime, package: 'dsh-session-telecom', sessions: reports, externalModelCalls: 0 };
    console.log('HOST_SMOKE_PASSED', JSON.stringify(report));
    if (process.env.DSH_TEST_REPORT) fs.writeFileSync(process.env.DSH_TEST_REPORT, JSON.stringify(report, null, 2));
  } finally { await shutdown.shutdown(0); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

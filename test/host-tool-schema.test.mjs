// 工具 schema 对**内核真源**的核对：用真实 @deepseek-ai/dsh-tools 的 defineTool 注册一次
// session_telecom，证明宿主启动时不会因为 schema 被 DSL 拒绝而静默丢工具。
//
// 为什么必须有这个文件：`test/host-tool.test.mjs` 用的是 stub defineTool，而真机实测踩过一次
//   JsonSchemaError: schema.required is not supported by the value schema DSL
// —— stub 全绿、真机注册失败。所以这里做的是 stub 做不到的事：让**真源**来判。
//
// 内核包在工作区里解析不到（profiles/node_modules 不是 workspace 的祖先目录），
// 因此从插件在 profile 里的真实落点 createRequire 解析；解析不到就 skip（CI 无内核时不算失败）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PLUGIN_DIR = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PROFILE_ANCHORS = [
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-session-telecom', 'package.json'),
  join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-session-telecom', 'package.json'),
];

/** 解析真实 dsh-tools；都拿不到就返回 undefined（调用方 skip）。 */
function resolveRealTools() {
  for (const anchor of PROFILE_ANCHORS) {
    if (!existsSync(anchor)) continue;
    try {
      const req = createRequire(pathToFileURL(anchor));
      return req.resolve('@deepseek-ai/dsh-tools');
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

const realToolsPath = resolveRealTools();

test('真实 defineTool 接受 session_telecom 的参数与输出 schema', async (t) => {
  if (realToolsPath === undefined) {
    t.skip('本机解析不到 @deepseek-ai/dsh-tools（未安装到任何 profile）→ 跳过真源核对');
    return;
  }
  const { defineTool } = await import(pathToFileURL(realToolsPath).href);
  assert.equal(typeof defineTool, 'function', 'dsh-tools 必须导出 defineTool');

  const { createSessionTelecomTool } = await import(new URL('../lib/tool.js', import.meta.url).href);
  const tool = createSessionTelecomTool({
    toolkit: { ctx: { sessions: { get: id => id === 's-read' ? {
      header: { id, cwd: 'fixture-workspace' },
      snapshotEvents: () => [{ type: 'assistant/message', seq: 0, time: 1, data: { message: { content: [{ type: 'text', text: 'handoff fixture' }] } } }],
    } : undefined } } },
    defineTool,
    createRegistry: () => ({ list: async () => ({ sessions: [], costTotals: {} }) }),
    deliver: async () => ({ delivered: true, live: true }),
  });

  assert.equal(tool.name, 'session_telecom');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output?.render, 'function');
  // defineTool 已经把作者 schema 编译成 JSON Schema；能建出来就说明 DSL 认可
  assert.equal(typeof tool.parameters, 'object');
  assert.equal(typeof tool.output?.schema, 'object');

  // 真跑一次 list：走 defineTool 包装后的 execute（含参数校验），确认不回 null / 不抛
  const value = await tool.execute({ action: 'list' }, {});
  assert.equal(value.ok, true);
  assert.equal(value.action, 'list');
  assert.equal(JSON.stringify(value).includes('null'), false, '回执里不许出现 null（DSL 输出类型不允许）');
  const read = await tool.execute({ action: 'read', sessionId: 's-read' }, {});
  assert.equal(read.ok, true);
  assert.match(read.transcript.text, /handoff fixture/);
  assert.equal(JSON.stringify(read).includes('null'), false);
  assert.equal(Array.isArray(tool.output.render({ action: 'read' }, read)), true);

  // 参数越界要被内核 DSL 拦下（enum 之外的值）
  await assert.rejects(() => tool.execute({ action: 'nope' }, {}), 'action 不在 enum 里必须被拒');
});

test('真实 defineTool：list 的 render 产物满足内核 content 组装路径（不许是裸字符串）', async (t) => {
  // 真机事故：`Error: content.some is not a function`。
  // 根因链（内核次序，dsh-tools/lib/index.js）：
  //   createSuccessResult:3548-3552  content === output.render(...)   ← content 就是 render 的返回值
  //   postExecute:3504               tools/post-execute 的消费者先读 result.content
  //                                  （dsh-spill-policy/lib/index.js:240-241 原文 `content.some(...)`）
  //   finishScheduledExecution:3391  applyFinalContent → finalizeContent  ← 跑到这里已经太晚
  //   ptc commit:1384                result.content.some((block) => block.type === "image")
  // 所以 render 必须直接回块数组；这里按上面四步的**真实形状与次序**核一遍。
  if (realToolsPath === undefined) {
    t.skip('本机解析不到 @deepseek-ai/dsh-tools → 跳过真源核对');
    return;
  }
  const { defineTool } = await import(pathToFileURL(realToolsPath).href);
  const { createSessionTelecomTool } = await import(new URL('../lib/tool.js', import.meta.url).href);
  const tool = createSessionTelecomTool({
    toolkit: { ctx: {} },
    defineTool,
    createRegistry: () => ({
      list: async () => ({
        sessions: [{ id: 's-self', title: '本会话', updatedAt: 2, live: true, running: false, archived: false, tokens: 4500, billableTokens: 1000, cacheHitRate: 0.75, contextLoad: 0.2 }],
        costTotals: { tokens: 4500, billableTokens: 1000, cacheHitRate: 0.75, sessionsWithUsage: 1 },
      }),
    }),
  });

  const exec = { name: 'session_telecom', callId: 'c-contract', agent: { session: { header: { id: 's-self' } } } };
  const args = { action: 'list' };
  const value = await tool.execute(args, exec);
  assert.equal(value.ok, true);

  // ①② 内核 createSuccessResult:3548-3552：content === render 的返回值
  const content = tool.output.render(args, value);
  assert.equal(Array.isArray(content), true, 'output.render 必须返回 ContentBlock[]，不能是裸字符串（否则 post-execute 消费者崩）');
  assert.equal(content.length > 0, true);
  for (const block of content) {
    assert.equal(block.type, 'text');
    assert.equal(typeof block.text, 'string');
  }
  assert.match(content.map((block) => block.text).join(''), /s-self/);

  // ③ 内核 postExecute:3504 —— 消费者原文（spill-policy:240-241）：必须不抛
  const decision = { kind: 'accept' };
  const consumerContent = decision.content ?? content;
  assert.doesNotThrow(() => consumerContent.some((block) => block.type === 'image'), '内容必须能被消费者 .some() 消费');

  // ④ 内核 applyFinalContent:3399-3407 —— finalizeContent 是幂等兜底，不能把块数组打回字符串
  const result = { isError: false, value, content };
  const finalized = tool.finalizeContent === undefined ? undefined : tool.finalizeContent(exec, result);
  const applied = finalized === undefined ? result : { ...result, content: finalized };
  assert.equal(Array.isArray(applied.content), true, 'finalizeContent 之后仍必须是块数组');

  // ⑤ 内核 ptc commit:1384 —— 真机抛错的那一行
  assert.doesNotThrow(() => {
    if (!applied.isError && applied.content.some((block) => block.type === 'image')) return;
  }, '内核 ptc commit 的 result.content.some(...) 必须不抛');
});

test('注册路径透传成本上限（外面配了必须真的生效）', async (t) => {
  if (realToolsPath === undefined) {
    t.skip('本机解析不到 @deepseek-ai/dsh-tools → 跳过');
    return;
  }
  const { defineTool } = await import(pathToFileURL(realToolsPath).href);
  const { registerSessionTelecomTool } = await import(new URL('../lib/tool.js', import.meta.url).href);

  let captured;
  const ctx = {
    inject: (_names, callback) => callback({
      effect: (fn) => {
        fn();
        return () => {};
      },
      tools: {
        register: (tool) => {
          captured = tool;
          return () => {};
        },
      },
    }),
  };
  const registered = registerSessionTelecomTool(ctx, { ctx: {} }, defineTool, { maxTextBytes: 128, listLimit: 3 });
  assert.equal(registered, true);
  assert.equal(captured?.name, 'session_telecom', '工具必须真的注册进 tools 服务');
  // defineTool 已把作者参数表**编译**成 JSON Schema：{type:'object',properties:{...},additionalProperties:false}
  assert.equal(captured.parameters.type, 'object');
  assert.match(captured.parameters.properties.limit.description, /默认 3/, 'listLimit 要反映到参数描述');

  // 配的 128 字节上限必须真的拦住 200 字节的正文（而不是仍用默认 32KB）
  const value = await captured.execute({ action: 'send', targetSessionId: 's-x', text: 'x'.repeat(200) }, {});
  assert.equal(value.ok, false);
  assert.match(value.error.message, /exceeds 128 bytes/);
});

test('真实 defineTool：参数与输出都禁止 required（DSL 统一禁用），可选参数走运行时校验', async (t) => {
  if (realToolsPath === undefined) {
    t.skip('本机解析不到 @deepseek-ai/dsh-tools → 跳过');
    return;
  }
  const { defineTool } = await import(pathToFileURL(realToolsPath).href);
  // 实测结论（两条都验过）：`required` 在**参数表**与**输出 schema**里都被 DSL 拒绝
  //   parameters.required must be a value schema object / schema.required is not supported
  // 所以"哪些参数必填"只能靠工具自己在 execute 里判断（本插件的 session_telecom 正是这么做的：
  // action=send 时才要求 targetSessionId/text，并且返回结构化 bad-request 而不是抛异常）。
  const parameterSchema = { name: { type: 'string', description: '要回显的名字' } };
  const probe = defineTool({
    name: 'dsh_session_telecom_schema_probe',
    description: 'schema probe',
    parameters: parameterSchema,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { echo: { type: 'string' } } },
      render: () => 'ok',
    },
    async execute(args) {
      return { echo: String(args.name ?? '') };
    },
  });
  assert.equal(probe.name, 'dsh_session_telecom_schema_probe');
  // 缺参数不会被 DSL 拦（因为没有 required 概念），由工具自己决定行为
  const missing = await probe.execute({}, {});
  assert.equal(missing.echo, '', '缺参数时工具照常返回结构化结果');
  const value = await probe.execute({ name: 'x' }, {});
  assert.equal(value.echo, 'x');

  // 反证：把 required 写进参数表会被真源拒绝（这正是我踩过的坑，锁成断言防回归）
  assert.throws(
    () => defineTool({
      name: 'dsh_session_telecom_schema_probe_required',
      description: 'should be rejected',
      parameters: { name: { type: 'string' }, required: ['name'] },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { echo: { type: 'string' } } },
        render: () => 'ok',
      },
      async execute() {
        return { echo: '' };
      },
    }),
    /required/,
    '参数表里的 required 必须被真源拒绝',
  );
});

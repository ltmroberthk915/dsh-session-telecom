// 花费显示：把**真实**投影值喂给会话行的纯渲染函数，断言文案与规则。
//
// 数字取自 tools/audit-cost-fields.mjs 对本机会话日志的实测：
//   session-840ff53f…  tokens=1.23 亿（其中 1.18 亿是缓存读）→ 真正计费只有 172 万，缓存命中 98.7%
//   session-7e8fb36c…  tokens=12419 / billable=2051 / 缓存 83.5% / 上下文 1.2%
//   session-840ff53f…  上下文 49.9%
// 断言的核心是：徽标主数字必须是**计费**量，不能被缓存读灌水成"1.2 亿 tok"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  Fragment: Symbol('fragment'),
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
};
const jsxRuntimeStub = { jsx: ReactStub.createElement, jsxs: ReactStub.createElement, Fragment: ReactStub.Fragment };

/** 只取 bundle 的导出面：不需要 DOM，因为被测的是纯函数。 */
async function loadExports() {
  const source = await readFile(join(root, 'client/client.js'), 'utf8');
  const registrations = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    document: { querySelector: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    console, setTimeout, clearTimeout, queueMicrotask, Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'client/client.js' }).runInContext(sandbox);
  const factoryRequire = (specifier) => {
    if (specifier === 'react') return ReactStub;
    if (specifier === 'react/jsx-runtime') return jsxRuntimeStub;
    throw new Error(`unexpected require: ${specifier}`);
  };
  return registrations[0].factory(factoryRequire);
}

test('RPC 通道名满足内核客户端约束（多段路径会在浏览器侧直接抛 invalid RPC target）', async () => {
  const mod = await loadExports();
  assert.equal(typeof mod.assertChannelShape, 'function', 'assertChannelShape 必须导出（可单测）');

  // 内核规则：dsh-client-connection/lib/client.js:1201
  //   CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/  —— 只允许**一个**路径段
  const kernelPattern = /^\/[A-Za-z0-9._~-]+$/;

  assert.equal(mod.assertChannelShape('/dsh-session-telecom'), '/dsh-session-telecom');

  // 踩过的坑：写成 /api/xxx 会在 ctx.connection.rpc.call 里被 assertTarget 拒掉，
  // 请求根本发不出去 —— UI 只显示"宿主未就绪"，让人误判成宿主没挂上。
  assert.throws(() => mod.assertChannelShape('/api/dsh-session-telecom'), /CHANNEL_PATTERN/, '/api 前缀必须被拒');
  assert.throws(() => mod.assertChannelShape('dsh-session-telecom'), /CHANNEL_PATTERN/, '缺前导斜杠必须被拒');
  assert.throws(() => mod.assertChannelShape('/a/b'), /CHANNEL_PATTERN/, '两段路径必须被拒');

  // 交叉核对：我们的校验与内核正则对同一组输入必须给出同样的判定
  for (const sample of ['/dsh-session-telecom', '/api/x', '/a/b', 'x', '/x?y', '/ok-1._~']) {
    const kernelAccepts = kernelPattern.test(sample);
    const ours = (() => {
      try {
        mod.assertChannelShape(sample);
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(ours, kernelAccepts, `判定必须与内核一致: ${sample}`);
  }
});

test('产物里的通道常量是单段路径（bundle 层复核，防止改了 lib 忘了 client）', async () => {
  const source = await readFile(join(root, 'client/client.js'), 'utf8');
  assert.match(source, /"\/dsh-session-telecom"/, 'bundle 里必须使用单段通道名');
  assert.doesNotMatch(source, /"\/api\/dsh-session-telecom"/, 'bundle 里不许再出现多段的旧通道名');
});

test('真实会话数字 → 徽标显示"计费"量，而不是被缓存读灌水的总量', async () => {
  const mod = await loadExports();
  assert.equal(typeof mod.describeSessionRow, 'function', 'describeSessionRow 必须导出（可单测）');

  // 1) 本会话（实测）：总量 1.23 亿、计费 172 万、缓存 98.7%
  const heavy = mod.describeSessionRow({
    id: 'session-840ff53f-7108-49cd-897b-99b33295948b',
    title: 'dsh插件复制会话ID与对话',
    tokens: 123244802,
    billableTokens: 1725570,
    cacheReadTokens: 118542080,
    cacheHitRate: 0.987,
    contextTokens: 499046,
    contextWindow: 1000000,
    contextLoad: 0.499,
    live: true,
    running: false,
    archived: false,
  });
  assert.match(heavy.costText, /计费/, '必须标出这是计费量');
  assert.match(heavy.costText, /1\.7M/, '172 万应显示成 1.7M 量级');
  assert.match(heavy.costText, /缓存99%|缓存98%/, '缓存命中率要一并显示');
  assert.doesNotMatch(heavy.costText, /123M|123244802/, '绝不能把 1.23 亿总量当成花费显示');
  assert.equal(heavy.hot, false, '上下文 49.9% 不该告警');

  // 2) 小会话（实测）：12419 / 2051 / 缓存 83.5%
  const small = mod.describeSessionRow({
    id: 'session-7e8fb36c-4c7e-4f18-9ecb-9d53a474bb14',
    title: 'Test 2 reply ok',
    tokens: 12419,
    billableTokens: 2051,
    cacheHitRate: 0.835,
    contextLoad: 0.012,
    live: true,
    running: false,
    archived: false,
  });
  assert.equal(small.costText, '计费2.1k · 缓存84%');

  // 3) 上下文接近上限 → 标黄告警；徽标仍按计费量
  const hot = mod.describeSessionRow({
    id: 'session-hot',
    title: '快满了',
    tokens: 5000000,
    billableTokens: 40000,
    cacheHitRate: 0.5,
    contextTokens: 900000,
    contextWindow: 1000000,
    contextLoad: 0.9,
  });
  assert.equal(hot.hot, true, 'contextLoad >= 0.8 必须告警');
  assert.match(hot.costText, /计费40k/);

  // 4) token-meter 缺席（全 null）→ 不显示任何花费文案（不显示误导性的 0）
  const bare = mod.describeSessionRow({ id: 's-bare', title: '没有用量', live: false });
  assert.equal(bare.costText, '');
  assert.equal(bare.hot, false);
  assert.equal(bare.title, '没有用量');

  // 5) 无标题兜底 + 徽标分类
  const untitled = mod.describeSessionRow({ id: 's-u', title: '', running: true, archived: true }, { untitled: '（无标题会话）' });
  assert.equal(untitled.title, '（无标题会话）');
  // 注意：bundle 跑在 vm 沙箱里，它返回的数组来自另一个 realm，
  // assert.deepEqual 会因原型不同而失败 —— 比较结构化内容而不是对象身份。
  assert.equal(JSON.stringify([...untitled.badges]), JSON.stringify(['running', 'archived']), 'running 优先于 live，archived 并列');
});

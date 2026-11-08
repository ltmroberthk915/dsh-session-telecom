// Lead 侧冒烟：把构建产物 client/client.js 放进一个最小化的"假浏览器"里执行，
// 断言它确实注册进了模块系统，并驱动「发送消息到会话」菜单行验证"点击 → 关菜单 → 开模态"。
//
// 为什么值得单独做：产物是"经典脚本 + __ModuleLoader__.load"格式，语法错误、
// 误用 ESM、误内联 react 这三类问题在静态 grep 里看不出来，而真机验证成本高。
//
// 注意：本机没有任何 node_modules 提供 react，因此这里自带一个**最小 react 替身**
// （createElement / useState / useRef / useEffect / jsx-runtime），只覆盖插件用到的那几个
// hook。它不参与生产，只服务于这个冒烟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(root, 'client/client.js');

// ---------------------------------------------------------------- 最小 react 替身

let hookSlots = [];
let hookIndex = 0;

function createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  return { $$typeof: 'element', type, props: { ...(props ?? {}), ...(flat === undefined ? {} : { children: flat }) }, key: null };
}

const ReactStub = {
  createElement,
  Fragment: Symbol('react.fragment'),
  useState(initial) {
    const index = hookIndex++;
    if (hookSlots[index] === undefined) hookSlots[index] = typeof initial === 'function' ? initial() : initial;
    return [hookSlots[index], (next) => {
      hookSlots[index] = typeof next === 'function' ? next(hookSlots[index]) : next;
    }];
  },
  useRef(initial) {
    const index = hookIndex++;
    if (hookSlots[index] === undefined) hookSlots[index] = { current: initial };
    return hookSlots[index];
  },
  useEffect() {
    hookIndex += 1;
  },
  useMemo(factory) {
    hookIndex += 1;
    return factory();
  },
  useCallback(fn) {
    hookIndex += 1;
    return fn;
  },
};

const jsxRuntimeStub = {
  jsx: (type, props, key) => createElement(type, props, ...(props?.children === undefined ? [] : [props.children])),
  jsxs: (type, props, key) => createElement(type, props, ...(props?.children === undefined ? [] : [props.children])),
  Fragment: ReactStub.Fragment,
};

/** 每次调用组件前重置 hook 槽位（等价于"挂载一个新组件实例"）。 */
function renderComponent(component, props) {
  hookSlots = [];
  hookIndex = 0;
  return component(props);
}

// ---------------------------------------------------------------- 假浏览器

function makeFakeDom() {
  const makeElement = (tag) => {
    const style = {
      setProperty() {},
      removeProperty() {},
      getPropertyValue() {
        return '';
      },
    };
    return {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      style,
      dataset: {},
      attributes: {},
      childNodes: [],
      parentNode: null,
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name];
      },
      appendChild(child) {
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      },
      removeChild(child) {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove() {
        this.parentNode?.removeChild(this);
      },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      select() {},
      setSelectionRange() {},
    };
  };
  const document = {
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: makeElement,
    querySelector: () => null,
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    execCommand: () => true,
  };
  return { document };
}

/** 执行产物，返回模块系统收到的注册项 + 沙箱里的 navigator（供测试注入剪贴板）。 */
async function loadBundle() {
  const source = await readFile(bundlePath, 'utf8');
  const registrations = [];
  const { document } = makeFakeDom();
  const navigatorStub = { clipboard: { writeText: async () => {} } };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration);
        },
      },
    },
    document,
    navigator: navigatorStub,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
  };
  sandbox.window.document = document;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'client/client.js' }).runInContext(sandbox);
  return { registrations, navigator: navigatorStub };
}

function factoryRequire(specifier) {
  if (specifier === 'react') return ReactStub;
  if (specifier === 'react/jsx-runtime') return jsxRuntimeStub;
  throw new Error(`unexpected require: ${specifier}`);
}

/** 假 ctx：记录槽位注入与注册。 */
function makeCtx(registered, injected) {
  return {
    locale: { register: () => () => {} },
    effect: (fn) => {
      const disposer = fn();
      return () => disposer?.();
    },
    slots: {
      inject(key, callback) {
        injected.push(key);
        callback();
        return () => {};
      },
      register(entry, component) {
        registered.push({ entry, component });
        return () => {};
      },
    },
    connection: { rpc: { call: async () => ({ ok: false, error: { code: 'stub', message: 'stub' } }) } },
  };
}

// ---------------------------------------------------------------- 断言

test('client.js 向模块系统注册了与包名一致的 id', async () => {
  const { registrations } = await loadBundle();
  assert.equal(registrations.length, 1, '应当恰好注册一次');
  assert.equal(registrations[0].id, 'dsh-session-telecom');
  assert.equal(typeof registrations[0].factory, 'function');
});

test('factory 产出的模块面满足客户端插件契约，apply 只注册不抛错', async () => {
  const { registrations } = await loadBundle();
  const moduleExports = registrations[0].factory(factoryRequire);
  assert.equal(typeof moduleExports.apply, 'function', '必须导出 apply');
  assert.equal(moduleExports.name, 'dsh-session-telecom');

  const injected = [];
  const registered = [];
  assert.doesNotThrow(() => moduleExports.apply(makeCtx(registered, injected)));
  assert.ok(injected.includes('sidebar.workspaces.session.menu.item'), '必须注入会话菜单槽位');
  const sendEntry = registered.find((row) => row.entry.id === 'session-toolkit-send-message');
  assert.ok(sendEntry !== undefined, '必须注册「发送消息到会话」菜单行');
  assert.equal(sendEntry.entry.order, 260);
  assert.equal(typeof sendEntry.component, 'function');
  // 2026-11-08：宿主官方菜单已自带「复制 Session ID」（dsh-client-ui-workspace 的
  // SessionIdMenuItem → menu.sessionId → actions.copySessionId），插件不再重复注册，
  // 免得右键菜单变长。这里锁住"不许回来"。
  assert.equal(
    registered.find((row) => row.entry.id === 'session-toolkit-copy-id'),
    undefined,
    '不许再注册「复制会话 ID」行（官方宿主已提供）',
  );
});

test('菜单行：发送消息到会话…点击后关闭菜单并打开模态', async () => {
  const { registrations } = await loadBundle();
  const moduleExports = registrations[0].factory(factoryRequire);
  const registered = [];
  moduleExports.apply(makeCtx(registered, []));
  const sendRow = registered.find((row) => row.entry.id === 'session-toolkit-send-message');
  assert.ok(sendRow !== undefined);

  const closed = [];
  const tree = renderComponent(sendRow.component, {
    sessionId: 'session-abc-123',
    displayTitle: '示例会话',
    t: undefined,
    useMenuOpenState: () => [false, (value) => closed.push(value)],
  });
  assert.equal(tree.type, 'div');
  const button = tree.props.children;
  assert.equal(button.props.role, 'menuitem');
  assert.equal(button.props.disabled, false);
  // 图标（svg）+ 文案（span）
  const children = Array.isArray(button.props.children) ? button.props.children : [button.props.children];
  assert.equal(children.length, 2, '一行 = 图标 + 文案');
  const labelSpan = children.find((child) => child?.type === 'span' && typeof child.props.children === 'string');
  assert.ok(labelSpan !== undefined, '文案要用 span 渲染');
  assert.match(labelSpan.props.children, /发送消息到会话/);

  assert.doesNotThrow(() => button.props.onClick({ preventDefault() {}, stopPropagation() {} }));
  assert.deepEqual(closed, [false], '应当先关闭菜单，再打开模态');
});

test('菜单行：sessionId 缺失时置灰', async () => {
  const { registrations } = await loadBundle();
  const moduleExports = registrations[0].factory(factoryRequire);
  const registered = [];
  moduleExports.apply(makeCtx(registered, []));
  const sendRow = registered.find((row) => row.entry.id === 'session-toolkit-send-message');
  assert.ok(sendRow !== undefined);

  const tree = renderComponent(sendRow.component, { sessionId: undefined, t: undefined });
  const button = tree.props.children;
  assert.equal(button.props.disabled, true, '拿不到 sessionId 必须置灰');
  assert.doesNotThrow(() => button.props.onClick({ preventDefault() {}, stopPropagation() {} }));
});

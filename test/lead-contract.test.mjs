// Lead 侧契约测试：插件的"能不能被宿主认出来"这一层。
// 这里不启动宿主、不 import 内核包，只核对 dsh-client-modules 与 cordis loader
// 实际读取的那些字段，避免"插件写完了但宿主根本加载不到"这类低级失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(relative) {
  return JSON.parse(await readFile(join(root, relative), 'utf8'));
}

async function exists(relative) {
  try {
    await stat(join(root, relative));
    return true;
  } catch {
    return false;
  }
}

test('package.json 满足 dsh.client / loader 的硬性字段', async () => {
  const pkg = await readJson('package.json');
  assert.equal(pkg.name, 'dsh-session-telecom');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');

  // clientExportOf(): exports["./client"] 必须是字符串，或带字符串 default 的对象
  const client = pkg.exports?.['./client'];
  const clientRel = typeof client === 'string' ? client : client?.default;
  assert.equal(typeof clientRel, 'string', 'exports["./client"] 必须是字符串或 {default: string}');
  assert.equal(clientRel, './client/client.js', '客户端 bundle 路径必须与 build.mjs 的产物一致');

  // 宿主入口
  const main = pkg.exports?.['.'];
  const mainRel = typeof main === 'string' ? main : main?.default;
  assert.equal(mainRel, './lib/index.js');

  // dsh.client 声明（parseDshClient 的校验规则）
  const decl = pkg.dsh?.client;
  assert.equal(typeof decl, 'object');
  assert.equal(decl.platform, 'web', 'client-modules 只处理 platform === "web" 的行');
  assert.ok(Array.isArray(decl.inject), 'dsh.client.inject 必须存在且为字符串数组');
  assert.ok(decl.inject.every((item) => typeof item === 'string'));

  // bundle patch 声明
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/cordis'], '^4.0.1');
});

test('cordis.patch.yml 用与其它插件同构的 insert 行挂载自己', async () => {
  const text = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
  assert.match(text, /-\s*insert:/, 'bundle patch 必须含 insert 列表');
  assert.match(text, /id:\s*dsh-session-telecom/);
  assert.match(text, /name:\s*dsh-session-telecom/);
});

test('lib/index.js 暴露 host 插件三件套（name / inject / apply）', async () => {
  assert.ok(await exists('lib/index.js'), 'lib/index.js 缺失：host 半还没写完？');
  const mod = await import(new URL('../lib/index.js', import.meta.url));
  assert.equal(typeof mod.name, 'string');
  assert.ok(Array.isArray(mod.inject), 'inject 必须是服务名数组（cordis 用它等待依赖就绪）');
  assert.ok(mod.inject.every((item) => typeof item === 'string'));
  assert.equal(typeof mod.apply, 'function');
});

test('client/client.js 是模块系统要求的 __ModuleLoader__.load 包装', async (t) => {
  if (!(await exists('client/client.js'))) {
    t.diagnostic('client/client.js 尚未构建（先跑 node client/build.mjs），本项跳过');
    return;
  }
  const text = await readFile(join(root, 'client/client.js'), 'utf8');
  assert.match(text, /window\.__ModuleLoader__\.load\(\{/, '必须是经典脚本形式的注册包装');
  assert.match(text, /id:\s*"dsh-session-telecom"/, '注册 id 必须与包名一致，否则 loader 认不到');
  assert.match(text, /factory:\s*\(require\)\s*=>/, 'factory 必须接收 require');
  assert.match(text, /require\("react"\)/, 'react 必须是 external，由宿主平台种子表提供');
  assert.ok(!/from\s+"react"/.test(text), '不应残留 ESM import 语法');
});

test('客户端 bundle 不得内联 react（重复实例会让 hooks 直接崩）', async (t) => {
  if (!(await exists('client/client.js'))) {
    t.diagnostic('client/client.js 尚未构建，本项跳过');
    return;
  }
  const text = await readFile(join(root, 'client/client.js'), 'utf8');
  // React 内部特征串：内联的话一定会出现
  assert.ok(!text.includes('react.development.js'), '疑似把 react 开发版内联进了 bundle');
  assert.ok(!text.includes('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'), '疑似把 react 内联进了 bundle');
});

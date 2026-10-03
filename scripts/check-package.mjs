import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
export function assertDependencyIsolation(pkg) {
  assert.equal(pkg.name, 'dsh-session-telecom');
  for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
    assert.equal(Object.keys(pkg[field] ?? {}).length, 0, `${field} must remain empty; use optional host peers`);
  }
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} must not be auto-installed`);
  }
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    assert.ok(!name.startsWith('@deepseek-ai/'), `Do not vendor a DSH core for builds: ${name}`);
    assert.ok(!/^(file:|link:|workspace:)/.test(version), 'Builds must not depend on a local checkout');
  }
  assert.ok(!pkg.scripts?.install && !pkg.scripts?.postinstall && !pkg.scripts?.preinstall,
    'Installing the plugin must not mutate the host');
}

const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assertDependencyIsolation(pkg);
for (const dir of ['lib/', 'client/']) {
  for (const file of await readdir(new URL(dir, root))) {
    if (!/\.(js|jsx|mjs)$/.test(file)) continue;
    const text = await readFile(new URL(dir + file, root), 'utf8');
    assert.ok(!text.includes('dsh-session-toolkit'), `Old package identity in ${dir + file}`);
    assert.ok(!text.includes('session_toolkit'), `Old tool identity in ${dir + file}`);
    assert.ok(!/['"](?:[CD]:[\\/](?:Users|BuyKey))/.test(text), `Machine-specific runtime path in ${dir + file}`);
  }
}
const client = await readFile(new URL('client/client.js', root), 'utf8');
assert.match(client, /id:\s*"dsh-session-telecom"/);
assert.ok(!client.includes('react.development.js'));
assert.ok(!client.includes('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'));
console.log('Package isolation and identity checks passed.');

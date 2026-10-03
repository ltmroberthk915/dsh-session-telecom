import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertDependencyIsolation } from '../scripts/check-package.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
test('release has no automatic host dependencies', () => assertDependencyIsolation(pkg));
test('regression: direct and optional DSH runtime copies are rejected', () => {
  for (const field of ['dependencies', 'optionalDependencies']) {
    assert.throws(() => assertDependencyIsolation({ ...pkg, [field]: { '@deepseek-ai/dsh-tools': '^0.2.0-rc.1' } }));
  }
});
test('regression: non-optional peers would allow automatic installation', () => {
  assert.throws(() => assertDependencyIsolation({ ...pkg, peerDependenciesMeta: {} }));
});

import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['client/index.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  packages: 'external',
  charset: 'utf8',
  write: false,
  legalComments: 'none',
  metafile: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !['react', 'react/jsx-runtime'].includes(dependency.path)) {
      throw new Error(`Unexpected browser dependency: ${dependency.path}`);
    }
  }
}
const bundled = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
${bundled}
    return module.exports;
  }
});
`;
await writeFile(new URL('client/client.js', root), wrapped, 'utf8');
console.log(`${pkg.name}: built client (${Buffer.byteLength(wrapped)} bytes)`);
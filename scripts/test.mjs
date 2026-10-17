// Bundles each tests/*.test.ts with esbuild (so bare "./foo" imports resolve
// the way Vite resolves them) and runs it in Node.
import { build } from 'esbuild';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const outDir = resolve('node_modules/.test-build');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const tests = readdirSync('tests').filter((f) => f.endsWith('.test.ts'));
if (tests.length === 0) {
  console.log('no tests found');
  process.exit(0);
}

/** CSS imports are a Vite concern; in Node they resolve to nothing. */
const cssStub = {
  name: 'css-stub',
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '', loader: 'js' }));
  },
};

await build({
  plugins: [cssStub],
  entryPoints: tests.map((f) => `tests/${f}`),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: outDir,
  packages: 'external',
  logLevel: 'error',
});

let failed = 0;
for (const file of tests) {
  const url = pathToFileURL(resolve(outDir, file.replace(/\.ts$/, '.js'))).href;
  try {
    await import(url);
  } catch (err) {
    failed++;
    console.error(`\n✗ ${file}\n${err?.stack ?? err}`);
  }
}
process.exit(failed === 0 && !process.exitCode ? 0 : 1);

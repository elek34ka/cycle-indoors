// Bundles scripts/catalog/main.ts with esbuild (so src/ imports resolve the
// way Vite resolves them, as scripts/test.mjs does for tests) and runs it.
//   node scripts/catalog.mjs build
//   node scripts/catalog.mjs sync [--dry-run]
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const outfile = resolve('node_modules/.catalog-build/main.mjs');

await build({
  entryPoints: ['scripts/catalog/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  packages: 'external',
  logLevel: 'error',
});

await import(pathToFileURL(outfile).href);

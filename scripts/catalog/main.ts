// `npm run catalog:build` and `npm run catalog:sync`. Bundled and run by
// scripts/catalog.mjs so that src/ imports resolve exactly as under Vite.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { buildCatalog, type CatalogBuild, type SourceFile } from '../../src/catalog/build';
import { runSync, type BucketRunner } from '../../src/catalog/sync';

const CONTENT = resolve('content');
const OUT = resolve('.catalog');
const BUCKET = process.env.CATALOG_BUCKET || 'cycle-indoors-catalog';
const WRANGLER = resolve('node_modules/.bin/wrangler');

// The app's parsers use the browser's DOMParser; jsdom's is the same API.
(globalThis as Record<string, unknown>).DOMParser = new JSDOM('').window.DOMParser;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function readContent(): SourceFile[] {
  try {
    statSync(CONTENT);
  } catch {
    throw new Error('No content/ folder. Create content/workouts, content/routes and content/plans first.');
  }
  return walk(CONTENT).map((path) => ({
    path: relative(CONTENT, path).split('\\').join('/'),
    bytes: new Uint8Array(readFileSync(path)),
  }));
}

/** Builds and writes `.catalog/`, replacing whatever was there. */
async function build(): Promise<CatalogBuild> {
  const result = await buildCatalog(readContent());
  const { index, files, problems, errors } = result;

  for (const p of problems) console.log(`  ${p.kind === 'failed' ? 'failed ' : 'skipped'}  ${p.path}: ${p.reason}`);
  for (const e of errors) console.log(`  error    ${e}`);
  if (errors.length > 0) {
    console.log(`\nCatalog build failed: ${plural(errors.length, 'error')}. Nothing was written.`);
    return result;
  }

  rmSync(OUT, { recursive: true, force: true });
  for (const file of files) {
    mkdirSync(dirname(join(OUT, file.key)), { recursive: true });
    writeFileSync(join(OUT, file.key), file.bytes);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));

  const size = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  console.log(`\nCatalog built into .catalog/`);
  console.log(`  ${plural(index.workouts.length, 'workout')}, ${plural(index.routes.length, 'route')}, ${plural(index.plans.length, 'plan')}`);
  console.log(`  ${plural(files.length, 'file')} (${kb(size)})`);
  if (problems.length > 0) console.log(`  ${plural(problems.length, 'file')} left out (listed above)`);
  return result;
}

function wrangler(args: string[], stdin?: Uint8Array): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(WRANGLER, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(stdin ? Buffer.from(stdin) : undefined);
  });
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Wrangler's error line, without its decoration, plus what to do about it. */
function reason(stderr: string, stdout: Buffer): string {
  const text = (stderr + stdout.toString()).replace(ANSI, '');
  const line = text.split('\n').map((l) => l.replace(/^\s*✘\s*\[ERROR\]\s*/, '').trim())
    .find((l) => l && !l.startsWith('🪵') && !l.startsWith('⛅')) ?? 'wrangler failed';
  if (/\b403\b|Forbidden/.test(text)) {
    return `${line}\n  Either the bucket "${BUCKET}" does not exist yet, or Wrangler's login has no R2 access.`
      + '\n  Check with: npx wrangler r2 bucket list   (docs/catalog.md: Publishing the catalog)';
  }
  if (/not logged in|wrangler login/i.test(text)) return `${line}\n  Run: npx wrangler login`;
  return line;
}

const r2: BucketRunner = {
  async get(key) {
    const { code, stdout, stderr } = await wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--pipe']);
    if (code === 0) return stdout.toString('utf8');
    if (/The specified key does not exist/.test(stderr + stdout)) return undefined;
    throw new Error(`Could not read ${BUCKET}/${key}: ${reason(stderr, stdout)}`);
  },
  async put(key, bytes, contentType, cacheControl) {
    const { code, stdout, stderr } = await wrangler([
      'r2', 'object', 'put', `${BUCKET}/${key}`, '--remote', '--pipe',
      '--content-type', contentType, '--cache-control', cacheControl,
    ], bytes);
    if (code !== 0) throw new Error(`Could not upload ${key}: ${reason(stderr, stdout)}`);
  },
  async delete(key) {
    const { code, stdout, stderr } = await wrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']);
    if (code !== 0) throw new Error(reason(stderr, stdout));
  },
};

async function main(): Promise<number> {
  const [command, ...flags] = process.argv.slice(2);
  if (command !== 'build' && command !== 'sync') {
    console.log('usage: catalog build | catalog sync [--dry-run]');
    return 2;
  }
  const result = await build();
  if (result.errors.length > 0) return 1;
  if (command === 'build') return 0;

  const dryRun = flags.includes('--dry-run');
  console.log(`\n${dryRun ? 'Dry run against' : 'Syncing to'} R2 bucket "${BUCKET}"`);
  await runSync(result, r2, { dryRun, log: (line) => console.log(`  ${line}`) });
  console.log(dryRun ? '\nDry run: nothing was changed.' : '\nCatalog published.');
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  console.log(`\n${(err as Error).message}`);
  process.exitCode = 1;
});

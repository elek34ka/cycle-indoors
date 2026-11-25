// With the Route 3D preview off, nothing of the 3D view may be loaded: not
// three.js, not the scene modules, not the window. They are reachable only
// through `import()`. One stray static import pulls them into what every
// rider downloads and parses at startup, and nothing else would notice.
import { build } from 'esbuild';
import { resolve } from 'node:path';

const { check, report, suite } = await import('./harness');

const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  outdir: resolve('node_modules/.startup-bundle'),
  write: false,
  metafile: true,
  logLevel: 'silent',
  loader: { '.css': 'empty' },
});

const outputs = result.metafile.outputs;
const entry = Object.keys(outputs).find((name) => outputs[name].entryPoint === 'src/main.ts');

/** The entry chunk and every chunk it imports statically: what startup loads. */
const startup = new Set<string>();
const visit = (name: string) => {
  if (startup.has(name) || !outputs[name]) return;
  startup.add(name);
  for (const dep of outputs[name].imports) if (dep.kind === 'import-statement') visit(dep.path);
};
if (entry) visit(entry);
const inputs = [...startup].flatMap((name) => Object.keys(outputs[name].inputs));
const threeD = inputs.filter((path) => /src\/scene\/|route-scene-view|node_modules\/three\//.test(path));

suite('startup loads nothing of the 3D view', () => {
  check('the app entry was bundled', entry !== undefined && inputs.some((path) => path.endsWith('src/ui/app.ts')));
  check('no 3D module is in what startup loads', threeD.length === 0, threeD.slice(0, 5).join(', '));
  const lazy = Object.keys(outputs).filter((name) => !startup.has(name))
    .flatMap((name) => Object.keys(outputs[name].inputs));
  check('the 3D view is still there, behind import()',
    lazy.some((path) => path.endsWith('src/ui/route-scene-view.ts'))
      && lazy.some((path) => path.includes('node_modules/three/')));
});

report();

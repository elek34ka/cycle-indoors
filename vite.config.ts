import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * GitHub Pages serves a project site from https://<user>.github.io/<repo>/, so
 * every asset URL has to be prefixed with the repo name. The deploy workflow
 * sets BASE_PATH; locally it stays at the root.
 */
const base = process.env.BASE_PATH ?? '/';

const CATALOG_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.zwo': 'application/xml',
  '.gpx': 'application/gpx+xml',
  '.fit': 'application/vnd.ant.fit',
};

/**
 * Dev server only: serves the locally built catalog (`npm run catalog:build`
 * writes `.catalog/`) at `/catalog/`, so `npm run dev:catalog` can try a
 * catalog before it is synced to R2. Never part of a production build.
 */
function localCatalog(): Plugin {
  const root = resolve('.catalog');
  return {
    name: 'local-catalog',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/catalog', (req, res, next) => {
        const path = normalize(join(root, decodeURIComponent((req.url ?? '/').split('?')[0])));
        if (!path.startsWith(root + '/')) { next(); return; }
        try {
          if (!statSync(path).isFile()) { next(); return; }
        } catch {
          res.statusCode = 404;
          res.end('Not in .catalog/ — run npm run catalog:build');
          return;
        }
        res.setHeader('Content-Type', CATALOG_TYPES[extname(path)] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(path).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base,
  plugins: [localCatalog()],
  server: { host: '127.0.0.1', port: 5173, open: false },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});

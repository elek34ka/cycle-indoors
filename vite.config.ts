import { defineConfig } from 'vite';

/**
 * GitHub Pages serves a project site from https://<user>.github.io/<repo>/, so
 * every asset URL has to be prefixed with the repo name. The deploy workflow
 * sets BASE_PATH; locally it stays at the root.
 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  server: { host: '127.0.0.1', port: 5173, open: false },
  preview: { host: '127.0.0.1', port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});

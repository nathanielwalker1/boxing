import { defineConfig } from 'vite';

// Root is the repo; `legacy/` and `spike/` are served by their own npm scripts
// with their own roots (see package.json) and are never reachable from here.
export default defineConfig({
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', sourcemap: true },
});

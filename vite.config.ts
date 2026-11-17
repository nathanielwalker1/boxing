import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Root is the repo; `legacy/` and `spike/` are served by their own npm scripts
// with their own roots (see package.json) and are never reachable from here.
// human.html is the standalone realistic-body proof page (src/human), not the game.
export default defineConfig({
  server: { port: 5173, strictPort: false },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), human: resolve(__dirname, 'human.html') } },
  },
});

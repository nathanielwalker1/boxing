/**
 * load.mjs — import TypeScript source into a Node test without a build step.
 *
 * Uses Vite's SSR module loader (already a dependency; no tsx, no ts-node).
 * A behavioural test does:
 *
 *   const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
 *
 * and gets live ESM namespaces. Startup is ~200 ms. Because the sim and core
 * contain no DOM or three.js, they run under plain Node — that is the whole
 * point of CONTRACT addition "behavioural tests run in Node".
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function load(...paths) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await Promise.all(paths.map(p => server.ssrLoadModule(p)));
  } finally {
    await server.close();
  }
}

/**
 * devUrl.js — the dev-server URL every browser script points at. Defaults to
 * 5173; honours PORT so a worktree on a second port can run the same suite.
 *
 * It also loads gpu_preload.mjs, so EVERY browser script draws on the real GPU
 * whether or not it was started with `node --import scripts/gpu_preload.mjs`
 * (2026-11-24: a session ran an hour of hand-started probes and films in
 * software GL at 2 fps because the flag was forgotten). GPU=0 turns it off.
 */
import './gpu_preload.mjs';

// Every browser script: a loud line if it is still running after 2 minutes (and every 2 after), so a slow run is
// noticed and stopped instead of waited on. The timer never keeps a finished script alive. SLOW_OK=1 silences it.
// (the test runner itself is exempt: the full suite is meant to take minutes)
if (process.env.SLOW_OK !== '1' && !/run_tests\.mjs$/.test(process.argv[1] ?? '')) {
  const t0 = Date.now();
  setInterval(() => console.error(`SLOW RUN: ${Math.round((Date.now() - t0) / 60000)} min so far (GPU ${process.env.GPU === '0' ? 'OFF' : 'on'}). CLAUDE.md rule 12: stop it and find out why before running another.`), 120_000).unref();
}

export const DEV_PORT = Number(process.env.PORT) || 5173;
export const DEV_URL  = `http://localhost:${DEV_PORT}`;

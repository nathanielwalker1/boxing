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

export const DEV_PORT = Number(process.env.PORT) || 5173;
export const DEV_URL  = `http://localhost:${DEV_PORT}`;

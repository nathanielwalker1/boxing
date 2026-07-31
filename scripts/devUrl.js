/**
 * devUrl.js — the dev-server URL every verification script points at.
 *
 * Defaults to 5173 (what `npm run dev` grabs in a clean checkout) but honours
 * PORT so a git worktree running its own Vite on a second port can run the same
 * suite without colliding with the primary checkout's server:
 *
 *   PORT=5176 node scripts/punch_test.mjs
 */
export const DEV_PORT = Number(process.env.PORT) || 5173;
export const DEV_URL  = `http://localhost:${DEV_PORT}`;

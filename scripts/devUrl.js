/**
 * devUrl.js — the dev-server URL every browser script points at. Defaults to
 * 5173; honours PORT so a worktree on a second port can run the same suite.
 */
export const DEV_PORT = Number(process.env.PORT) || 5173;
export const DEV_URL  = `http://localhost:${DEV_PORT}`;

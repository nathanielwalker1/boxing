#!/usr/bin/env node
/**
 * run_tests.mjs — the one entry point for the whole suite.
 *
 *   npm test                      # everything
 *   npm run test:quick rng math   # a named subset
 *
 * Two kinds of script:
 *   node:    true  → pure Node (sim/core behavioural tests via load.mjs). No
 *                    server, no browser, milliseconds each. This is where every
 *                    ported legacy assertion lives (CONTRACT 2026-09-02).
 *   browser: (default) → Playwright against a Vite dev server, for render
 *                    verification only.
 *
 * The server is started only if a browser script is selected. Env:
 *   TEST_CONCURRENCY  parallel scripts (default 4)
 *   PORT              use an already-running dev server
 *   TEST_KEEP_SERVER  leave the spawned Vite running
 *   TEST_NO_REUSE     don't reuse a server already on 5173
 */
import { spawn } from 'child_process';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT        = dirname(SCRIPTS_DIR);

// The suite is discovered by filename convention so parallel workstreams never
// edit this file:
//   *_test.mjs   → Node (sim/core behavioural tests via load.mjs)
//   *_check.mjs  → browser (Playwright against the dev server)
// Everything else in scripts/ is a helper or a hand-run capture tool.
const onDisk = readdirSync(SCRIPTS_DIR).sort();
const SUITE = [
  ...onDisk.filter(f => f.endsWith('_test.mjs') && !f.startsWith('_')).map(f => ({ name: f.replace(/_test\.mjs$/, ''), file: f, node: true })),
  ...onDisk.filter(f => f.endsWith('_check.mjs') && !f.startsWith('_')).map(f => ({ name: f.replace(/_check\.mjs$/, ''), file: f })),
];
const KNOWN_NON_TESTS = new Set(['run_tests.mjs', 'devUrl.js', 'waits.js', 'check.js', 'load.mjs', 'greyscale.js', '_debug.mjs', 'pose_grid.mjs', 'lookbook.mjs', 'filmstrip.mjs', 'arena_look.mjs', 'bot_table.mjs', 'flow_look.mjs', 'audio_render.mjs', 'combo_probe.mjs', 'feel_probe.mjs', 'fight_film.mjs', 'flash_probe.mjs', 'hurt_table.mjs', 'stamina_probe.mjs', 'skel_probe.mjs']);
const stray = onDisk.filter(f => (f.endsWith('.mjs') || f.endsWith('.js')) && !KNOWN_NON_TESTS.has(f) && !SUITE.some(s => s.file === f));
if (stray.length) console.error(`\n  ⚠  Not a test by convention (rename to *_test.mjs or *_check.mjs, or list in KNOWN_NON_TESTS): ${stray.join(', ')}\n`);

// ── Args ─────────────────────────────────────────────────────────────────────
const requested = process.argv.slice(2).filter(a => !a.startsWith('-'));
let selected = SUITE;
if (requested.length) {
  const unknown = requested.filter(r => !SUITE.some(s => s.name === r || s.file === r));
  if (unknown.length) {
    console.error(`Unknown test(s): ${unknown.join(', ')}\nAvailable: ${SUITE.map(s => s.name).join(' ')}`);
    process.exit(2);
  }
  selected = SUITE.filter(s => requested.includes(s.name) || requested.includes(s.file));
}
const CONCURRENCY = Math.max(1, Number(process.env.TEST_CONCURRENCY) || 4);

// ── Dev server (browser scripts only) ────────────────────────────────────────
async function portResponds(port) {
  try { return (await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
}
async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portResponds(port)) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}
let viteProc = null;
async function startServer() {
  if (process.env.PORT) {
    const port = Number(process.env.PORT);
    if (await portResponds(port)) return port;
    console.error(`PORT=${port} was set but nothing is answering there.`);
    process.exit(2);
  }
  if (!process.env.TEST_NO_REUSE && await portResponds(5173)) return 5173;
  let port = 5190;
  while (port < 5230 && await portResponds(port)) port++;
  viteProc = spawn(join(ROOT, 'node_modules/.bin/vite'), ['--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  viteProc.stdout.on('data', d => { log += d; });
  viteProc.stderr.on('data', d => { log += d; });
  viteProc.on('error', e => { log += `spawn error: ${e.message}\n`; });
  if (!(await waitForPort(port))) {
    console.error(`Vite did not come up on ${port} within 30s:\n${log}`);
    stopServer();
    process.exit(2);
  }
  return port;
}
function stopServer() {
  if (viteProc && !viteProc.killed && !process.env.TEST_KEEP_SERVER) { viteProc.kill('SIGTERM'); viteProc = null; }
}
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

// ── Running one script ───────────────────────────────────────────────────────
function runScript(test, port) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, test.file)], {
      cwd: ROOT, env: { ...process.env, PORT: String(port ?? '') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => { out += `\nspawn error: ${e.message}`; });
    child.on('close', code => resolve({ ...test, code, out, ms: Date.now() - started, counts: parseCounts(out) }));
  });
}
function parseCounts(out) {
  const m = out.match(/(\d+)\/(\d+)\s+checks passed/);
  if (m) return { passed: Number(m[1]), total: Number(m[2]) };
  const pass = (out.match(/\bPASS\b/g) || []).length;
  const fail = (out.match(/\bFAIL(?:ED|URES)?\b/g) || []).length;
  return pass + fail > 0 ? { passed: pass, total: pass + fail } : null;
}
async function runPool(tests, port, concurrency) {
  const queue = [...tests], results = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) { const r = await runScript(queue.shift(), port); results.push(r); report(r); }
  });
  await Promise.all(workers);
  return results;
}

// ── Reporting ────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';
function report(r) {
  const ok = r.code === 0;
  const count = r.counts ? `${r.counts.passed}/${r.counts.total}` : 'ok';
  const mark = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
  console.log(`${mark} ${r.name.padEnd(14)} ${DIM}·${OFF} ${count.padEnd(7)} ${DIM}·${OFF} ${((r.ms) / 1000).toFixed(1).padStart(5)}s`);
  if (!ok) {
    console.log(`${RED}${'─'.repeat(72)}\nFAILED: ${r.name} (${r.file}, exit ${r.code}) — full output:${OFF}`);
    console.log(r.out.trimEnd());
    console.log(`${RED}${'─'.repeat(72)}${OFF}`);
  }
}

// ── Go ───────────────────────────────────────────────────────────────────────
const suiteStart = Date.now();
const nodeTests = selected.filter(t => t.node);
const browserTests = selected.filter(t => !t.node);
const results = [];
if (nodeTests.length) {
  console.log(`\nNode: ${nodeTests.length} script(s), ${CONCURRENCY} at a time`);
  results.push(...await runPool(nodeTests, null, CONCURRENCY));
}
if (browserTests.length) {
  const port = await startServer();
  console.log(`\nBrowser: ${browserTests.length} script(s) against :${port}, ${CONCURRENCY} at a time`);
  results.push(...await runPool(browserTests, port, CONCURRENCY));
  stopServer();
}
const failed = results.filter(r => r.code !== 0);
const wall = ((Date.now() - suiteStart) / 1000).toFixed(1);
console.log(`\n${results.length - failed.length}/${results.length} scripts passed ${DIM}·${OFF} ${wall}s wall`);
if (failed.length) { console.error(`${RED}FAILED: ${failed.map(f => f.name).join(', ')}${OFF}`); process.exit(1); }

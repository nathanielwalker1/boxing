#!/usr/bin/env node
/**
 * run_tests.mjs — the one entry point for the whole verification suite.
 *
 *   npm test                                  # everything
 *   npm run test:quick punch reach vulnerability   # a named subset
 *
 * Why this exists: running the suite by hand was 18 shell invocations, ~250
 * lines of pass output, and no single exit code. This runs them with bounded
 * parallelism, prints ONE line per script when it passes, and dumps the full
 * output only for the ones that fail.
 *
 * Env:
 *   TEST_CONCURRENCY   how many scripts run at once (default 3)
 *   PORT               use an already-running dev server on this port instead
 *                      of starting one
 *   TEST_KEEP_SERVER   set to 1 to leave the spawned Vite running after the run
 *
 * The runner starts its own Vite on a free port and shuts it down at the end,
 * so nothing has to be running first. Set PORT to point it at an existing
 * server instead (that path is also what the individual scripts still honour if
 * you run one directly).
 *
 * No test framework, no new dependencies — the scripts are already standalone
 * Node programs that exit non-zero on failure. This only schedules them.
 */
import { spawn } from 'child_process';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT        = dirname(SCRIPTS_DIR);

// ── Suite definition ─────────────────────────────────────────────────────────
// Every permanent verification script. `serial: true` pins a script to run
// alone (nothing else concurrent) — for checks whose assertions are sensitive
// to how much CPU the machine has left. Prefer fixing the test over marking it
// serial; a serial script costs its full wall time with no overlap.
const SUITE = [
  { name: 'verify',        file: 'verify.js' },
  { name: 'punch',         file: 'punch_test.mjs' },
  { name: 'reach',         file: 'reach_test.mjs' },
  { name: 'vulnerability', file: 'vulnerability_test.mjs' },
  { name: 'counter',       file: 'counter_test.mjs' },
  { name: 'health',        file: 'health_test.mjs' },
  { name: 'block',         file: 'block_test.mjs' },
  { name: 'slip',          file: 'slip_test.mjs' },
  { name: 'stance',        file: 'stance_test.mjs' },
  { name: 'facing',        file: 'facing_test.mjs' },
  { name: 'boundary',      file: 'boundary_test.mjs' },
  { name: 'separation',    file: 'separation_test.mjs' },
  { name: 'camera',        file: 'camera_test.mjs' },
  { name: 'shadow',        file: 'shadow_test.mjs' },
  { name: 'glove',         file: 'glove_test.mjs' },
  { name: 'audio',         file: 'audio_test.mjs' },
  { name: 'dummy_ai',      file: 'dummy_ai_test.mjs' },
  { name: 'dummy_attack',  file: 'dummy_attack_test.mjs' },
];

// Guard against a script being added to /scripts and silently never run.
const KNOWN_NON_TESTS = new Set(['run_tests.mjs', 'devUrl.js', 'waits.js', '_debug.mjs']);
const onDisk = readdirSync(SCRIPTS_DIR)
  .filter(f => (f.endsWith('.mjs') || f.endsWith('.js')) && !KNOWN_NON_TESTS.has(f));
const missing = onDisk.filter(f => !SUITE.some(s => s.file === f));
if (missing.length) {
  console.error(`\n  ⚠  Not in the suite (add to SUITE in run_tests.mjs): ${missing.join(', ')}\n`);
}

// ── Args ─────────────────────────────────────────────────────────────────────
const requested = process.argv.slice(2).filter(a => !a.startsWith('-'));
let selected = SUITE;
if (requested.length) {
  const unknown = requested.filter(r => !SUITE.some(s => s.name === r || s.file === r));
  if (unknown.length) {
    console.error(`Unknown test(s): ${unknown.join(', ')}`);
    console.error(`Available: ${SUITE.map(s => s.name).join(' ')}`);
    process.exit(2);
  }
  selected = SUITE.filter(s => requested.includes(s.name) || requested.includes(s.file));
}

const CONCURRENCY = Math.max(1, Number(process.env.TEST_CONCURRENCY) || 3);

// ── Dev server ───────────────────────────────────────────────────────────────
async function portResponds(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch { return false; }
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
  // An explicit PORT means "use the server I already have running".
  if (process.env.PORT) {
    const port = Number(process.env.PORT);
    if (await portResponds(port)) return port;
    console.error(`PORT=${port} was set but nothing is answering there.`);
    process.exit(2);
  }
  // Reuse a dev server on the default port if one is already up, so running the
  // suite next to `npm run dev` doesn't fight over 5173. TEST_NO_REUSE=1 forces
  // the spawn path (which is what CI and a clean checkout take).
  if (!process.env.TEST_NO_REUSE && await portResponds(5173)) return 5173;

  // Pick a port nothing is already answering on, so a worktree running its own
  // Vite (see devUrl.js) doesn't collide with this one.
  let port = 5190;
  while (port < 5230 && await portResponds(port)) port++;

  viteProc = spawn(
    join(ROOT, 'node_modules/.bin/vite'),
    ['--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let viteLog = '';
  viteProc.stdout.on('data', d => { viteLog += d; });
  viteProc.stderr.on('data', d => { viteLog += d; });
  viteProc.on('error', e => { viteLog += `spawn error: ${e.message}\n`; });

  if (!(await waitForPort(port))) {
    console.error(`Vite did not come up on ${port} within 30s:\n${viteLog}`);
    stopServer();
    process.exit(2);
  }
  return port;
}

function stopServer() {
  if (viteProc && !viteProc.killed && !process.env.TEST_KEEP_SERVER) {
    viteProc.kill('SIGTERM');
    viteProc = null;
  }
}
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

// ── Running one script ───────────────────────────────────────────────────────
function runScript(test, port) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(SCRIPTS_DIR, test.file)], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => { out += `\nspawn error: ${e.message}`; });
    child.on('close', code => {
      resolve({ ...test, code, out, ms: Date.now() - started, counts: parseCounts(out) });
    });
  });
}

// Scripts don't share one output format. Prefer an explicit "N/N checks
// passed" line; fall back to counting PASS/FAIL markers; otherwise report no
// count and let the exit code speak.
function parseCounts(out) {
  const m = out.match(/(\d+)\/(\d+)\s+checks passed/);
  if (m) return { passed: Number(m[1]), total: Number(m[2]) };
  const pass = (out.match(/\bPASS\b/g) || []).length;
  const fail = (out.match(/\bFAIL(?:ED|URES)?\b/g) || []).length;
  if (pass + fail > 0) return { passed: pass, total: pass + fail };
  return null;
}

async function runPool(tests, port, concurrency) {
  const queue   = [...tests];
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const t = queue.shift();
      const r = await runScript(t, port);
      results.push(r);
      report(r);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Reporting ────────────────────────────────────────────────────────────────
const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', OFF = '\x1b[0m';

function report(r) {
  const ok    = r.code === 0;
  const count = r.counts ? `${r.counts.passed}/${r.counts.total}` : 'ok';
  const secs  = `${(r.ms / 1000).toFixed(1)}s`;
  const mark  = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`;
  console.log(`${mark} ${r.name.padEnd(15)} ${DIM}·${OFF} ${count.padEnd(7)} ${DIM}·${OFF} ${secs.padStart(6)}`);
  if (!ok) {
    console.log(`${RED}${'─'.repeat(72)}${OFF}`);
    console.log(`${RED}FAILED: ${r.name} (${r.file}, exit ${r.code}) — full output:${OFF}`);
    console.log(r.out.trimEnd());
    console.log(`${RED}${'─'.repeat(72)}${OFF}`);
  }
}

// ── Go ───────────────────────────────────────────────────────────────────────
const suiteStart = Date.now();
const port = await startServer();
console.log(`\nRunning ${selected.length} script(s) against :${port}, ${CONCURRENCY} at a time\n`);

const parallelTests = selected.filter(t => !t.serial);
const serialTests   = selected.filter(t =>  t.serial);

const results = [];
results.push(...await runPool(parallelTests, port, CONCURRENCY));
if (serialTests.length) results.push(...await runPool(serialTests, port, 1));

stopServer();

const failed    = results.filter(r => r.code !== 0);
const wall      = ((Date.now() - suiteStart) / 1000).toFixed(1);
const cpuSecs   = (results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1);
const slowest   = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3)
  .map(r => `${r.name} ${(r.ms / 1000).toFixed(1)}s`).join(', ');

console.log(`\n${results.length - failed.length}/${results.length} scripts passed ${DIM}·${OFF} ` +
            `${wall}s wall ${DIM}(${cpuSecs}s serial-equivalent)${OFF}`);
console.log(`${DIM}slowest: ${slowest}${OFF}`);
if (failed.length) {
  console.error(`${RED}FAILED: ${failed.map(f => f.name).join(', ')}${OFF}`);
  process.exit(1);
}

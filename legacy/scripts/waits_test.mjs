/**
 * waits_test.mjs — the suite's wait vocabulary tests itself.
 *
 * Every assertion in every other script now sits behind one of these helpers, so
 * a helper that returns quietly when its condition never arrives is a test that
 * passes without its precondition — the exact bug class 18a part 3 removed from
 * the five silent scripts. This pins the contract:
 *
 *   throws on timeout   until, bootReady, gameTime, frames, settled, punchIdle
 *   returns false       soft, resolved   (and warns loudly while doing it)
 *
 * Each timeout case is given a deliberately impossible condition and a short
 * ceiling, so the whole script costs a few seconds rather than 15s per case.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, soft, resolved, gameTime, frames, settled, punchIdle } from './waits.js';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });

const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Run `fn`, reporting whether it threw and what the message was. */
async function threw(fn) {
  try { await fn(); return { threw: false, msg: '' }; }
  catch (e) { return { threw: true, msg: e.message }; }
}

// ── bootReady: resolves on a live page ───────────────────────────────────────
console.log('\n=== bootReady ===');
{
  const r = await threw(() => bootReady(page));
  check('bootReady resolves on a booted page', !r.threw, r.msg);
}

// ── until: throws on timeout, and the message names what was waited on ───────
console.log('\n=== until (fail-closed) ===');
{
  const r = await threw(() => until(page, () => false, undefined,
    { label: 'a condition that never comes true', timeout: 600 }));
  check('until THROWS when its condition never arrives', r.threw, r.msg);
  check('the throw names the label, so the failure is diagnosable',
    r.msg.includes('a condition that never comes true'), r.msg);
  const ok = await threw(() => until(page, () => true, undefined, { timeout: 2000 }));
  check('until resolves when the condition is already true', !ok.threw, ok.msg);
}

// ── soft / resolved: return false, but never silently ────────────────────────
console.log('\n=== soft / resolved (fail-soft, but loud) ===');
{
  // Capture the warning this is contractually required to emit.
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warned.push(a.join(' ')); };

  const missed = await soft(page, () => false, undefined,
    { timeout: 500, label: 'a condition that never comes true' });
  const hit    = await soft(page, () => true,  undefined, { timeout: 2000 });

  await page.evaluate(() => { window.__waitsProbe = []; });
  const noneYet = await resolved(page, '__waitsProbe', 1, { timeout: 500 });
  await page.evaluate(() => { window.__waitsProbe.push('x'); });
  const arrived = await resolved(page, '__waitsProbe', 1, { timeout: 2000 });

  console.warn = realWarn;

  check('soft returns FALSE on timeout rather than throwing', missed === false);
  check('soft returns true when the condition arrives',        hit === true);
  check('resolved returns FALSE while the array is empty',     noneYet === false);
  check('resolved returns true once the array fills',          arrived === true);
  check('a soft timeout WARNS, so it is never invisible in the output',
    warned.length === 2 && warned.every(w => w.includes('waits.soft timed out')),
    `${warned.length} warning(s): ${warned.map(w => w.slice(0, 60)).join(' | ')}`);
  check('the resolved() warning names the array it was watching',
    warned.some(w => w.includes('window.__waitsProbe')),
    warned.join(' | ').slice(0, 120));
}

// ── gameTime: waits on the SIM clock, not the wall clock ─────────────────────
console.log('\n=== gameTime ===');
{
  const before = await page.evaluate(() => window.__tick.gameTime);
  const wall0  = Date.now();
  await gameTime(page, 0.5);
  const after  = await page.evaluate(() => window.__tick.gameTime);
  check('gameTime returns only once the sim has advanced by the requested amount',
    after - before >= 0.5,
    `advanced ${(after - before).toFixed(3)}s of game time in ${Date.now() - wall0}ms wall`);

  // Freeze the sim and confirm the helper refuses to return early. This is the
  // case a raw waitForTimeout gets wrong: wall clock keeps running, game time
  // does not, and a sleeping test proceeds as if the sim had advanced.
  await page.evaluate(() => {
    window.__waitsFrozenFrom = window.__tick.gameTime;
    window.__tickFreeze = Object.getOwnPropertyDescriptor(window.__tick, 'gameTime');
    // Needs a no-op setter as well as the getter: main.js does `__tick.gameTime
    // += dt` from strict-mode module code every frame, and assigning to a
    // getter-only property there throws a TypeError per frame.
    Object.defineProperty(window.__tick, 'gameTime', {
      configurable: true,
      get: () => window.__waitsFrozenFrom,
      set: () => {},
    });
  });
  const r = await threw(async () => {
    // gameTime()'s own ceiling scales with the request; 0.05s keeps it short.
    await gameTime(page, 0.05);
  });
  await page.evaluate(() => {
    delete window.__tick.gameTime;
    if (window.__tickFreeze) Object.defineProperty(window.__tick, 'gameTime', window.__tickFreeze);
  });
  check('gameTime THROWS rather than returning when the sim clock is stopped',
    r.threw, r.msg);
}

// ── frames: counts rendered ticks ────────────────────────────────────────────
console.log('\n=== frames ===');
{
  const before = await page.evaluate(() => window.__tick.frames);
  await frames(page, 4);
  const after  = await page.evaluate(() => window.__tick.frames);
  check('frames returns only after the requested tick count',
    after - before >= 4, `${after - before} frames elapsed`);
}

// ── settled: throws when the value never stops moving ────────────────────────
console.log('\n=== settled ===');
{
  const still = await threw(async () => {
    const v = await settled(page, () => 42, { timeout: 4000, stableFrames: 3 });
    if (v !== 42) throw new Error(`settled returned ${v}, expected 42`);
  });
  check('settled resolves (and returns the value) for a constant', !still.threw, still.msg);

  // The frame counter increments forever, so it can never settle.
  const moving = await threw(() => settled(page, () => window.__tick.frames,
    { timeout: 1500, label: 'a monotonically increasing counter' }));
  check('settled THROWS when the value never stops changing', moving.threw, moving.msg);
}

// ── punchIdle: throws when the punch never unwinds ───────────────────────────
console.log('\n=== punchIdle ===');
{
  await bootReady(page);
  const idle = await threw(() => punchIdle(page));
  check('punchIdle resolves for a fighter that is not punching', !idle.threw, idle.msg);

  // punchIdle delegates to until(), which has no caller-facing timeout here, so
  // this case is proved through until()'s contract above rather than by burning
  // 15s of wall clock on a pinned punchTimer.
  check('punchIdle is built on until(), i.e. inherits fail-closed behaviour',
    punchIdle.toString().includes('until('), 'source check');
}

// ── Report ───────────────────────────────────────────────────────────────────
await browser.close();
const failed = results.filter(r => !r.pass);
console.log('\nPage errors:', errors.length ? errors : 'none');
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.label}`));
  process.exit(1);
}

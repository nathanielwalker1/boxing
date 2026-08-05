/**
 * waits.js — the vocabulary the verification scripts use instead of sleeping.
 *
 * Every flake diagnosed in Stage 17 Phase 0 was the same bug: a fixed
 * `waitForTimeout(N)` standing in for "the simulation advanced N ms". Those two
 * are not the same thing. Wall clock and game time diverge whenever the machine
 * is loaded (headless Chromium drops frames), and they diverge by design during
 * hit-stop, which deliberately spends real time running the sim at near-zero
 * dt. A test that sleeps 500 ms and assumes 500 ms of game happened is racing
 * the renderer, and it loses that race more often the busier the box gets —
 * which is exactly what running the suite in parallel does.
 *
 * So:
 *   - waiting for the sim to advance      → gameTime()
 *   - waiting for a specific state        → until()
 *   - waiting for motion to stop          → settled()
 *   - waiting for the page to be playable → bootReady()
 *
 * A raw waitForTimeout is only correct when what is being waited on has no
 * observable state at all — a purely visual transition. Those are commented
 * individually where they survive.
 */

/** Default ceiling for every conditional wait. Generous: it only ever costs
 *  wall clock when something is genuinely wrong. */
const TIMEOUT = 15000;

/**
 * Wait until `fn` (evaluated in the page) returns truthy.
 * `label` is only used to make the timeout message say what was being waited on.
 */
export async function until(page, fn, arg = undefined, { label = 'condition', timeout = TIMEOUT } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 'raf' });
  } catch (e) {
    throw new Error(`waits.until timed out after ${timeout}ms waiting for: ${label}`);
  }
}

/**
 * Same as `until`, but returns false on timeout instead of throwing.
 *
 * Use this when the thing being waited on is the thing under test: if a punch
 * never resolves, the check should report FAIL with its own message, not die
 * with a wait error and take the rest of the script's cases down with it.
 */
export async function soft(page, fn, arg = undefined, { timeout = 4000 } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 'raf' });
    return true;
  } catch { return false; }
}

/**
 * Wait until at least `n` entries have landed in a recording array the script
 * installed on `window` (the `window.__out` / `window.__res` pattern most of
 * these checks use to capture resolver outcomes).
 *
 * This replaces "press, sleep 200–400 ms, read the array". A punch resolves at
 * peak extension, some number of GAME-time seconds after the press — so the
 * old sleep was betting that enough frames rendered in that wall-clock window.
 * Under parallel load they don't, and the array reads back empty.
 * Returns false rather than throwing: an empty read is a legitimate FAIL.
 */
export async function resolved(page, arrayName = '__out', n = 1, opts = {}) {
  return soft(page, ({ a, k }) => (window[a]?.length ?? 0) >= k, { a: arrayName, k: n }, opts);
}

/**
 * Wait until the game has been ticking and everything the checks poke at
 * exists. Replaces the 1200–1500 ms "let it boot" sleeps: those were sized for
 * a cold Vite transform on a loaded machine, so they were both too long in the
 * common case and too short in the bad one.
 */
export async function bootReady(page, { frames = 5 } = {}) {
  await until(page, n => {
    const g = window.__game;
    const s = g?.scene?.keys?.RingScene;
    return !!(s && s.fighter && s.dummy && s.scene.isActive() && window.__tick.frames >= n);
  }, frames, { label: 'game booted and ticking' });
}

/**
 * Wait until the simulation has advanced `seconds` of GAME time — the
 * hit-stop-scaled dt the systems under test actually run on.
 *
 * This is the drop-in replacement for a sleep that meant "let N ms of game
 * happen". Under CPU load it waits longer in wall clock and the same amount in
 * game time, which is the whole point. During hit-stop it correctly waits out
 * the stop instead of having the window eaten by it.
 */
export async function gameTime(page, seconds) {
  const from = await page.evaluate(() => window.__tick.gameTime);
  // The ceiling has to scale with the request. Headless Chromium runs the sim
  // at roughly half wall speed on an idle machine and nearer a third with three
  // scripts sharing the CPU, so a flat 15 s cap made every wait longer than
  // ~4 s of game time fail under load — which is the exact opposite of what
  // this helper is for. 10x plus a floor covers a 3x slowdown with margin.
  await until(page, t => window.__tick.gameTime >= t, from + seconds,
    { label: `${seconds}s of game time`, timeout: Math.max(TIMEOUT, seconds * 10000) });
}

/** Wait for `n` rendered frames. For "let the next tick observe this" waits,
 *  where the count of ticks matters and their duration does not. */
export async function frames(page, n = 2) {
  const from = await page.evaluate(() => window.__tick.frames);
  await until(page, f => window.__tick.frames >= f, from + n,
    { label: `${n} frames`, timeout: Math.max(TIMEOUT, n * 500) });
}

/**
 * Wait until a numeric getter stops changing — motion has damped out, a clamp
 * has been reached, a spring has settled. Replaces "hold a direction for 4
 * seconds and assume we're pinned against the rope by now".
 *
 * `getter` is a page function returning a number. Settled means `stableFrames`
 * consecutive samples within `epsilon` of each other.
 */
export async function settled(page, getter, { epsilon = 0.05, stableFrames = 6, timeout = TIMEOUT, label = 'value to settle' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null, stable = 0;
  while (Date.now() < deadline) {
    await frames(page, 2);
    const v = await page.evaluate(getter);
    if (last !== null && Math.abs(v - last) <= epsilon) stable += 1;
    else stable = 0;
    last = v;
    if (stable >= stableFrames) return v;
  }
  throw new Error(`waits.settled timed out after ${timeout}ms waiting for: ${label}`);
}

/**
 * Wait until a fighter's punch has fully unwound, so the next case starts from
 * a clean idle. Replaces the "let the animation finish" sleeps that were sized
 * against punchDuration by hand.
 */
export async function punchIdle(page, who = 'fighter') {
  await until(page, w => window.__game.scene.keys.RingScene[w].punchTimer <= 0,
    who, { label: `${who} punch to unwind` });
}

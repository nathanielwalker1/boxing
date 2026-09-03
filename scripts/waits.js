/**
 * waits.js — the vocabulary browser scripts use instead of sleeping.
 *
 * A fixed `waitForTimeout(N)` standing in for "the sim advanced N ms" was the
 * cause of every flake in v1's suite. Wall clock and game time diverge under
 * load and by design during hit-stop. So:
 *   - the sim to advance                → gameTime()
 *   - a specific state                  → until()
 *   - motion to stop                    → settled()
 *   - the page to be playable           → bootReady()
 *   - N rendered frames                 → frames()
 * A raw waitForTimeout is only correct for a purely visual transition with no
 * observable state, and is commented where it survives.
 */
const TIMEOUT = 15000;

export async function until(page, fn, arg = undefined, { label = 'condition', timeout = TIMEOUT } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 'raf' });
  } catch {
    throw new Error(`waits.until timed out after ${timeout}ms waiting for: ${label}`);
  }
}

/** Like `until` but returns false on timeout and warns, so the assertion after it reports. */
export async function soft(page, fn, arg = undefined, { timeout = 4000, label = 'condition' } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 'raf' });
    return true;
  } catch {
    console.warn(`  ⚠  waits.soft timed out after ${timeout}ms waiting for: ${label} — the assertion below ran WITHOUT its precondition`);
    return false;
  }
}

/** Wait for ≥ n entries in a recording array on window (the __out pattern). */
export async function resolved(page, arrayName = '__out', n = 1, opts = {}) {
  return soft(page, ({ a, k }) => (window[a]?.length ?? 0) >= k, { a: arrayName, k: n },
    { label: `${n} entr${n === 1 ? 'y' : 'ies'} in window.${arrayName}`, ...opts });
}

/** The app is ticking and its window hooks exist. */
export async function bootReady(page, { frames = 5 } = {}) {
  await until(page, n => !!(window.__tick && window.__tick.ready && window.__tick.frames >= n && window.__cfg),
    frames, { label: 'app booted and ticking' });
}

/** Advance `seconds` of GAME time (hit-stop-scaled), however long that takes in wall clock. */
export async function gameTime(page, seconds) {
  const from = await page.evaluate(() => window.__tick.gameTime);
  await until(page, t => window.__tick.gameTime >= t, from + seconds,
    { label: `${seconds}s of game time`, timeout: Math.max(TIMEOUT, seconds * 10000) });
}

/** Wait for `n` rendered frames. */
export async function frames(page, n = 2) {
  const from = await page.evaluate(() => window.__tick.frames);
  await until(page, f => window.__tick.frames >= f, from + n,
    { label: `${n} frames`, timeout: Math.max(TIMEOUT, n * 500) });
}

/** Wait until a numeric page getter stops changing. Returns the settled value. */
export async function settled(page, getter, { epsilon = 0.005, stableFrames = 6, timeout = TIMEOUT, label = 'value to settle' } = {}) {
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

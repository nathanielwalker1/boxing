import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime, until, soft } from './waits.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output/dummy_attack', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

async function freshLoad() {
  await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await bootReady(page);
}

/**
 * Capture a burst of frames spanning a full windup→impact→stagger cycle.
 *
 * The 60 ms interval here is a SAMPLING RATE, not a wait for a condition — it
 * is what makes the output a usable flipbook. What changed is the stop
 * condition: it used to run a flat 4.3 s of wall clock chosen to outlast the
 * randomised 1.5–3.5 s attack cadence, capturing ~70 screenshots whether or not
 * an attack ever happened. Now it stops a few frames after the attack has
 * actually landed, which usually ends the burst early and always guarantees the
 * cycle is in there.
 */
async function burstUntilStagger(prefix, maxMs, intervalMs) {
  const start = Date.now();
  let i = 0, seenImpact = 0;
  while (Date.now() - start < maxMs) {
    await page.screenshot({ path: `scripts/output/dummy_attack/${prefix}_${String(i).padStart(3, '0')}.png` });
    i++;
    const landed = await page.evaluate(() => {
      const sc = window.__game.scene.keys.RingScene;
      // The player has been rocked (or their guard has), so the dummy's punch
      // has resolved — the thing this burst exists to have captured.
      return sc.fighter.staggerVx !== 0 || sc.fighter.staggerX !== 0 ||
             sc.fighter.reaction?.active === true;
    });
    if (landed) seenImpact++;
    if (seenImpact >= 8) break;   // a few frames of the reaction, then stop
    await page.waitForTimeout(intervalMs);   // sampling cadence, not a state wait
  }
}

// Fighters start ~340px apart, far outside the dummy's engage distance — close
// some of the gap first so it reaches its standoff (and so a punch of its own
// has a chance to land) inside the capture window below. The dummy's own
// movement AI covers the rest, exactly as it would in a real fight.
async function closeDistance() {
  await page.keyboard.down('ArrowRight');
  await gameTime(page, 0.9);
  await page.keyboard.up('ArrowRight');
  await gameTime(page, 0.2);
}

// ── A. Unblocked dummy attack — windup, impact, stagger ─────────────────────
await freshLoad();
await closeDistance();
await burstUntilStagger('unblocked', 4300, 60);

// ── B. Blocked dummy attack — player holds Shift throughout ────────────────
await freshLoad();
await closeDistance();
await page.keyboard.down('ShiftLeft');
await gameTime(page, 0.15);   // let block fully engage before the attack fires
await burstUntilStagger('blocked', 4300, 60);
await page.keyboard.up('ShiftLeft');

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Dummy attack screenshots saved to scripts/output/dummy_attack/');

// A non-empty `errors` array is a FAILURE, not a log line. This script pushed
// page errors into it and then exited 0 regardless — so the dummy attack path had never
// actually been checked for console errors, in any run, ever.
if (errors.length) {
  console.error(`FAILED — ${errors.length} page error(s).`);
  process.exit(1);
}

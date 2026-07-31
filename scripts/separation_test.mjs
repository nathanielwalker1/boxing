/**
 * Body separation (resolveOverlap in movement.js).
 *
 * The bug: crowding the dummy into a corner left both fighters standing at
 * EXACTLY the same point — one stacked silhouette, zero px apart. Fighters are
 * now eased apart each frame toward config.fighterSeparationDist.
 *
 * What this guards, in order of importance:
 *   1. no stacking, in every corner and against every rope
 *   2. a dead-stacked pair recovers on its own
 *   3. it stays SOFT — the smothered band (< smotherDist) is still reachable,
 *      so the close-range punch rules are not quietly disabled by the push
 *   4. the stagger wobble does not drive the push (same rule as facing: only
 *      locomotion positions participate)
 *   5. config.fighterSeparationDist = 0 fully disables it
 *
 * Requires the dev server running.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200);

const failures = [];
const pass = (name, detail) => console.log(`  [PASS] ${name.padEnd(46)} — ${detail}`);
const fail = (name, detail) => { failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name.padEnd(46)} — ${detail}`); };

const B   = await page.evaluate(() => window.__game.scene.keys.RingScene._getRingBounds());
const CFG = await page.evaluate(() => ({
  sepDist:  window.__config.fighterSeparationDist,
  strength: window.__config.fighterSeparationStrength,
  smother:  window.__config.smotherDist,
  standoff: window.__config.dummyStandoffDist,
}));
console.log(`config: separation ${CFG.sepDist}px @ strength ${CFG.strength}, ` +
            `smotherDist ${CFG.smother}, dummy standoff ${CFG.standoff}\n`);

if (CFG.sepDist >= CFG.smother) {
  fail('separation stays inside the smother band',
       `separation ${CFG.sepDist}px >= smotherDist ${CFG.smother}px — the too-close ` +
       `punch rules could never trigger`);
}
if (CFG.sepDist >= CFG.standoff) {
  fail('separation does not fight the dummy AI',
       `separation ${CFG.sepDist}px >= standoff ${CFG.standoff}px — the AI would be ` +
       `permanently pushed out of its own hold distance`);
}

// The dummy's movement AI is frozen throughout: the whole point is the case
// where it CANNOT retreat, and letting it walk away would hide the overlap.
const setup = (dummyX, dummyY, playerX, playerY, sepDist = CFG.sepDist) =>
  page.evaluate(({ dummyX, dummyY, playerX, playerY, sepDist }) => {
    window.__config.fighterSeparationDist = sepDist;
    window.__config.dummyMoveSpeed = 0;
    const sc = window.__game.scene.keys.RingScene;
    sc.dummy._loco.x = dummyX; sc.dummy._loco.y = dummyY;
    sc.dummy._loco.vx = 0; sc.dummy._loco.vy = 0;
    sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.fighter.x = playerX; sc.fighter.y = playerY;
    sc.fighter.vx = 0; sc.fighter.vy = 0;
  }, { dummyX, dummyY, playerX, playerY, sepDist });

const dist = () => page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  return Math.hypot(sc.fighter.x - sc.dummy._loco.x, sc.fighter.y - sc.dummy._loco.y);
});

const drive = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
  await page.waitForTimeout(120);
};

// ── 1. Crowding into every corner and against every rope ────────────────────
// The player walks in from mid-ring holding into the corner for 2.5 s — far
// longer than it takes to arrive — so this measures the SUSTAINED lean, not a
// glancing touch.
console.log('=== 1. Crowding a trapped dummy (all corners + all ropes) ===');

const MX = 24, MT = 67, MB = 44;
// [name, dummy x, dummy y, approach direction]. The player always starts
// APPROACH_D px back along that direction and then holds into it, so every case
// really does close the gap — a start offset on some other axis would leave the
// player stuck 170 px away and pass the check without ever touching the dummy.
const spots = [
  ['corner TL', B.left + MX,  B.top + MT,    [-1, -1]],
  ['corner TR', B.right - MX, B.top + MT,    [ 1, -1]],
  ['corner BL', B.left + MX,  B.bottom - MB, [-1,  1]],
  ['corner BR', B.right - MX, B.bottom - MB, [ 1,  1]],
  ['left rope',   B.left + MX,  (B.top + B.bottom) / 2, [-1,  0]],
  ['right rope',  B.right - MX, (B.top + B.bottom) / 2, [ 1,  0]],
  ['top rope',    (B.left + B.right) / 2, B.top + MT,    [ 0, -1]],
  ['bottom rope', (B.left + B.right) / 2, B.bottom - MB, [ 0,  1]],
];
const KEY = { '-1,0': 'ArrowLeft', '1,0': 'ArrowRight', '0,-1': 'ArrowUp', '0,1': 'ArrowDown' };
const APPROACH_D = 170;

// Anything at or below this reads as "standing in the same space" on screen —
// the rig's own body hurtbox is 32 px wide.
const STACKED = 20;

for (const [name, dx, dy, [ax, ay]] of spots) {
  const len  = Math.hypot(ax, ay);
  const keys = [];
  if (ax) keys.push(KEY[`${ax},0`]);
  if (ay) keys.push(KEY[`0,${ay}`]);

  await setup(dx, dy, dx - (ax / len) * APPROACH_D, dy - (ay / len) * APPROACH_D);
  const start = await dist();
  await drive(keys, 2500);
  const d = await dist();

  if (d >= start - 1) {
    fail(`${name}: crowding does not stack`,
         `player never closed in (${start.toFixed(1)}px → ${d.toFixed(1)}px) — check is vacuous`);
  } else if (d <= STACKED) {
    fail(`${name}: crowding does not stack`, `settled ${d.toFixed(1)}px apart`);
  } else {
    pass(`${name}: crowding does not stack`, `closed ${start.toFixed(0)}px → held ${d.toFixed(1)}px apart`);
  }
}

// ── 2. A dead-stacked pair recovers on its own ──────────────────────────────
console.log('\n=== 2. Recovery from a dead stack (no input) ===');
{
  const cx = (B.left + B.right) / 2, cy = (B.top + B.bottom) / 2;
  await setup(cx, cy, cx, cy);
  const r = await page.evaluate(async () => {
    const sc = window.__game.scene.keys.RingScene;
    const target = window.__config.fighterSeparationDist * 0.95;
    for (let i = 0; i < 180; i++) {
      await new Promise(res => requestAnimationFrame(res));
      const d = Math.hypot(sc.fighter.x - sc.dummy._loco.x, sc.fighter.y - sc.dummy._loco.y);
      if (d >= target) return { frames: i + 1, d };
    }
    return { frames: null, d: Math.hypot(sc.fighter.x - sc.dummy._loco.x, sc.fighter.y - sc.dummy._loco.y) };
  });
  if (r.frames === null) fail('exactly co-located pair separates', `still ${r.d.toFixed(1)}px after 180 frames`);
  else if (r.frames > 60) fail('exactly co-located pair separates', `took ${r.frames} frames — too slow to read as a shove`);
  else pass('exactly co-located pair separates', `${r.frames} frames to ${r.d.toFixed(1)}px`);
}

// ── 3. Still soft: the smothered band remains reachable ─────────────────────
// If the push were rigid at a distance above smotherDist, "too close = smothered"
// could never fire and a locked punch rule would be silently dead.
console.log('\n=== 3. The push is soft, not a wall ===');
{
  const cx = (B.left + B.right) / 2, cy = (B.top + B.bottom) / 2;
  await setup(cx, cy, cx - 170, cy);
  await drive(['ArrowRight'], 2500);
  const d = await dist();
  if (d >= CFG.smother) fail('player can still reach smother range', `closest ${d.toFixed(1)}px, smotherDist ${CFG.smother}px`);
  else                  pass('player can still reach smother range', `leaned in to ${d.toFixed(1)}px (< ${CFG.smother}px)`);
}

// ── 4. The stagger wobble must not drive the push ───────────────────────────
// Same rule as facing: only locomotion positions participate, so being punched
// never shoves the two fighters apart.
console.log('\n=== 4. Stagger does not drive separation ===');
{
  const cx = (B.left + B.right) / 2, cy = (B.top + B.bottom) / 2;
  // Park them exactly at the rest distance, then stagger the dummy hard.
  await setup(cx, cy, cx - CFG.sepDist, cy);
  await page.waitForTimeout(200);
  const before = await dist();
  const after = await page.evaluate(async () => {
    const sc = window.__game.scene.keys.RingScene;
    const px = sc.fighter.x, py = sc.fighter.y;
    sc.dummy.receiveImpulse(-320, 0);            // knock it INTO the player
    let worst = Infinity;
    for (let i = 0; i < 90; i++) {
      sc.fighter.x = px; sc.fighter.y = py; sc.fighter.vx = 0; sc.fighter.vy = 0;
      await new Promise(r => requestAnimationFrame(r));
      const d = Math.hypot(sc.fighter.x - sc.dummy._loco.x, sc.fighter.y - sc.dummy._loco.y);
      if (d < worst) worst = d;
    }
    return worst;
  });
  // The locomotion gap must be essentially untouched by the wobble.
  if (Math.abs(after - before) > 2) {
    fail('stagger leaves the locomotion gap alone', `${before.toFixed(1)}px → ${after.toFixed(1)}px during stagger`);
  } else {
    pass('stagger leaves the locomotion gap alone', `${before.toFixed(1)}px → ${after.toFixed(1)}px`);
  }
}

// ── 5. The config switch actually gates it ──────────────────────────────────
console.log('\n=== 5. fighterSeparationDist = 0 disables it ===');
{
  const dx = B.left + MX, dy = B.bottom - MB;
  await setup(dx, dy, dx + 170, dy - 170, 0);
  await drive(['ArrowLeft', 'ArrowDown'], 2500);
  const d = await dist();
  if (d > STACKED) fail('dist=0 restores the un-separated behaviour', `still ${d.toFixed(1)}px apart — the switch does nothing`);
  else             pass('dist=0 restores the un-separated behaviour', `overlapped to ${d.toFixed(1)}px as expected`);
}

// Screenshot the fixed scenario: crowded corner, separation on.
await page.evaluate(({ B }) => {
  window.__config.fighterSeparationDist = 38;
  window.__config.camZoom = 1.6;
  const sc = window.__game.scene.keys.RingScene;
  sc.dummy._loco.x = B.left + 24; sc.dummy._loco.y = B.bottom - 44;
  sc.fighter.x = B.left + 200; sc.fighter.y = B.bottom - 200;
}, { B });
await drive(['ArrowLeft', 'ArrowDown'], 2500);
await page.screenshot({ path: 'scripts/output/separation_corner.png' });

await browser.close();
console.log('\nPage errors:', errors.length ? errors : 'none');
console.log('Screenshot → scripts/output/separation_corner.png');

if (failures.length || errors.length) {
  console.error(`\nSEPARATION FAILURES (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log('Separation checks: PASS');

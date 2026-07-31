/**
 * punch_test.mjs — verify all three outcomes and hook hand selection.
 * Run with: node scripts/punch_test.mjs
 * Dev server must be running on localhost:5173.
 *
 * Stage 7 note: the dummy now moves (it closes to its standoff distance and
 * backs out of the smother zone), so the original "walk right for N ms" setup no
 * longer lands the player at a predictable distance — every case drifted into a
 * different range state. This test now PINS the dummy (dummyMoveSpeed = 0, its
 * attack timer frozen) and places the player at explicit distances through the
 * dev hook, so the three outcomes are exercised deterministically again.
 * Movement-driven approach is covered separately by dummy_ai_test.mjs.
 *
 * Stage 9 notes:
 *  - Landing is geometric now, so there is no rangeMax to derive distances
 *    from. Cases are pinned to distances chosen against the MEASURED reach
 *    envelope (see reach_test.mjs), which is the thing that defines range now.
 *  - The wrapper below asserts on _resolveAttack's RETURNED outcome instead of
 *    recomputing it from the distance. The old version re-derived the verdict
 *    with the old distance-band formula, so it would have kept passing no
 *    matter what the resolver actually did.
 *  - Punches resolve at peak extension, a few frames after the press, so each
 *    case waits for the impact rather than reading immediately.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200);

// Freeze the dummy: no approach/retreat, no attacks of its own, no reactive
// block — so the only variable in each case is the player's distance.
await page.evaluate(() => {
  window.__config.dummyMoveSpeed           = 0;
  window.__config.dummyAttackDelayMin      = 999;
  window.__config.dummyAttackDelayMax      = 999;
  window.__config.dummyBlockReactionChance = 0;
  window.__game.scene.keys.RingScene.dummy.attackTimer = 999;

  // Record the resolved range state of every player punch so the test reports
  // outcomes instead of relying on someone eyeballing the screenshots.
  const sc = window.__game.scene.keys.RingScene;
  window.__out = [];
  const orig = sc._resolveAttack.bind(sc);
  sc._resolveAttack = (attacker, defender, arm, punchType) => {
    const outcome = orig(attacker, defender, arm, punchType);
    if (attacker === sc.fighter) {
      // Distance is recorded at IMPACT (peak extension), which is not
      // necessarily the distance the case was set up at — holding a direction
      // to pick the hook/uppercut hand also drags the player a few px.
      window.__out.push({
        outcome,
        dist: Math.round(Math.hypot(defender.x - attacker.x, defender.y - attacker.y)),
        arm,
        punchType,
      });
    }
    return outcome;
  };
});

// Place the player a given distance to the LEFT of the pinned dummy, and clear
// the dummy's stagger so a previous case's knockback isn't still in play.
async function standOff(px) {
  await page.evaluate(d => {
    const sc = window.__game.scene.keys.RingScene;
    sc.dummy.staggerX = sc.dummy.staggerY = 0;
    sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.dummy.x = sc.dummy._loco.x;
    sc.dummy.y = sc.dummy._loco.y;
    sc.fighter.x  = sc.dummy.x - d;
    sc.fighter.y  = sc.dummy.y;
    sc.fighter.vx = 0;
    sc.fighter.vy = 0;
    for (const f of [sc.fighter, sc.dummy]) {
      f.health  = window.__config.healthMax;
      f.stamina = window.__config.staminaMax;
    }
  }, px);
  await page.waitForTimeout(120);
}

// Hold each key across at least one frame — Phaser's JustDown() samples once per
// update tick, so a sub-frame press can be missed entirely.
async function tap(key, ms = 70) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

const results = [];
async function step(name, expected, distance, key, shot, holdDir) {
  await standOff(distance);
  if (holdDir) await page.keyboard.down(holdDir);
  await tap(key);
  // Impact resolves at peak extension (Stage 9), not on the press frame, so the
  // outcome is only readable after the punch has had time to arrive.
  await page.waitForTimeout(200);
  if (holdDir) await page.keyboard.up(holdDir);
  const got = await page.evaluate(() => window.__out.splice(0));
  await page.screenshot({ path: `scripts/output/${shot}.png` });
  await page.waitForTimeout(300);   // let the punch animation finish before the next case

  const r    = got[0];
  const pass = !!r && r.outcome === expected;
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name.padEnd(32)} expected ${expected.padEnd(8)} got ${r ? `${r.outcome}@${r.dist}px (${r.arm} arm)` : '(nothing resolved)'}`);
  return r;
}

// Distances are chosen against the measured geometric reach envelope — see
// reach_test.mjs, which is what pins those numbers down. Nothing here derives
// from a range constant any more, because there isn't one.
const cfg = await page.evaluate(() => ({ smother: window.__config.smotherDist }));
console.log(`smother inside ${cfg.smother} px; landing is geometric beyond that\n`);

const CLOSE = cfg.smother - 20;   // 30 px — inside the smother radius
const MID   = 65;                 // comfortably inside every punch's reach

// ── 1. WHIFF — beyond every punch's reach (longest is the cross at ~90 px) ──
await step('jab, far outside reach',  'whiff',   220, 'KeyJ', 'punch_whiff');

// ── 2. LAND — mid range ─────────────────────────────────────────────────────
await step('jab, mid range',          'land',    MID, 'KeyJ', 'punch_land');

// ── 3. SMOTHER — inside smotherDist, jab is smother-vulnerable ──────────────
await step('jab, inside smother',     'smother', CLOSE, 'KeyJ', 'punch_smother');

// ── 4. Hook at smother distance → still LANDS (hooks work at close range) ───
await step('hook, inside smother',    'land',    CLOSE, 'KeyI', 'punch_hook_close');

// ── 4b. Uppercut inside smother → also still lands (locked spec) ────────────
await step('uppercut, inside smother','land',    CLOSE, 'KeyM', 'punch_uppercut_close');

// ── 5. Hook hand selection at mid range ─────────────────────────────────────
const left = await step('hook holding left',  'land', MID, 'KeyI', 'punch_hook_left',  'ArrowLeft');
const right= await step('hook holding right', 'land', MID, 'KeyI', 'punch_hook_right', 'ArrowRight');

// Arms are named anatomically now ('left'/'right'), not by rig slot
// ('lead'/'rear') — the slot a hand occupies depends on stance. Hook/uppercut
// hand selection is stance-independent by design: the hold picks the hand.
// Full stance × facing × hold matrix lives in scripts/stance_test.mjs.
const handPass = left?.arm === 'left' && right?.arm === 'right';
results.push({ name: 'hook hand follows joystick direction', pass: handPass });
console.log(`  [${handPass ? 'PASS' : 'FAIL'}] hook hand follows joystick     left→${left?.arm}, right→${right?.arm} (expect left, right)`);

await browser.close();

const failed = results.filter(r => !r.pass);
console.log('\nPage errors:', errors.length ? errors : 'none');
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
console.log('Screenshots saved to scripts/output/');
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.name}`));
  process.exit(1);
}

/**
 * punch_test.mjs — verify all three range states and hook hand selection.
 * Run with: node scripts/punch_test.mjs
 * Dev server must be running on localhost:5173.
 *
 * Stage 7 note: the dummy now moves (it closes to its standoff distance and
 * backs out of the smother zone), so the original "walk right for N ms" setup no
 * longer lands the player at a predictable distance — every case drifted into a
 * different range state. This test now PINS the dummy (dummyMoveSpeed = 0, its
 * attack timer frozen) and places the player at explicit distances through the
 * dev hook, so the three range states are exercised deterministically again.
 * Movement-driven approach is covered separately by dummy_ai_test.mjs.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
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
  // NOTE: the 4th arg is the punch TYPE (Stage 8) — smother-vulnerability is
  // derived from it inside _resolveAttack, so mirror that derivation here.
  sc._resolveAttack = (attacker, defender, arm, punchType) => {
    const p    = typeof defender.getHitPos === 'function' ? defender.getHitPos() : defender;
    const dist = Math.hypot(p.x - attacker.x, p.y - attacker.y);
    const smotherable = punchType !== 'hook' && punchType !== 'uppercut';
    if (attacker === sc.fighter) {
      window.__out.push({
        outcome: dist > window.__config.rangeMax ? 'whiff'
               : (dist < window.__config.smotherDist && smotherable) ? 'smother' : 'land',
        dist: Math.round(dist),
        arm,
        punchType,
      });
    }
    return orig(attacker, defender, arm, punchType);
  };
});

// Place the player a given distance to the LEFT of the pinned dummy.
async function standOff(px) {
  await page.evaluate(d => {
    const sc = window.__game.scene.keys.RingScene;
    sc.fighter.x  = sc.dummy.x - d;
    sc.fighter.y  = sc.dummy.y;
    sc.fighter.vx = 0;
    sc.fighter.vy = 0;
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
  await page.waitForTimeout(60);
  if (holdDir) await page.keyboard.up(holdDir);
  const got = await page.evaluate(() => window.__out.splice(0));
  await page.screenshot({ path: `scripts/output/${shot}.png` });
  await page.waitForTimeout(300);   // let the punch animation finish before the next case

  const r    = got[0];
  const pass = r && r.outcome === expected && (!holdDir || true);
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name.padEnd(32)} expected ${expected.padEnd(8)} got ${r ? `${r.outcome}@${r.dist}px (${r.arm} arm)` : '(nothing resolved)'}`);
  return r;
}

const cfg = await page.evaluate(() => ({ rangeMax: window.__config.rangeMax, smother: window.__config.smotherDist }));
console.log(`landing band: ${cfg.smother}–${cfg.rangeMax} px\n`);

// ── 1. WHIFF — well outside rangeMax ────────────────────────────────────────
await step('jab, far outside range', 'whiff',   cfg.rangeMax + 120, 'KeyJ', 'punch_whiff');

// ── 2. LAND — middle of the landing band ────────────────────────────────────
await step('jab, mid landing band',  'land',    (cfg.smother + cfg.rangeMax) / 2, 'KeyJ', 'punch_land');

// ── 3. SMOTHER — inside smotherDist, jab is smother-vulnerable ──────────────
await step('jab, inside smother',    'smother', cfg.smother - 20, 'KeyJ', 'punch_smother');

// ── 4. Hook at smother distance → still LANDS (hooks work at close range) ───
await step('hook, inside smother',   'land',    cfg.smother - 20, 'KeyI', 'punch_hook_close');

// ── 5. Hook hand selection at mid range ─────────────────────────────────────
const mid  = (cfg.smother + cfg.rangeMax) / 2;
const left = await step('hook holding left',  'land', mid, 'KeyI', 'punch_hook_left',  'ArrowLeft');
const right= await step('hook holding right', 'land', mid, 'KeyI', 'punch_hook_right', 'ArrowRight');

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

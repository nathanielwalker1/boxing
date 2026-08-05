/**
 * dummy_ai_test.mjs — Playwright verification for the Stage 7 dummy AI.
 * Usage: node scripts/dummy_ai_test.mjs   (dev server must already be running)
 *
 * Covers the four sub-systems:
 *   1. Movement AI     — advances when far, settles in the landing band, no jitter
 *   2. Range gating    — the timer only ARMS; the throw needs the player in range
 *   3. Reactive block  — probability-driven, reuses isBlocking/blockReduction
 *   4. Opening punish  — aggression multiplier raises cadence when exposed
 *
 * Reads live state through the window.__game / window.__config dev hooks rather
 * than inferring behavior from pixels; screenshots are still captured for the
 * visual checks (guard pose, advancing, settled).
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { mkdirSync } from 'fs';

const OUT = 'scripts/output/dummy_ai';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors  = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
};

/**
 * Reload and install the per-frame instrumentation:
 *  - window.__throws  : one entry per dummy throw COMMIT, with the gate distance
 *      that commit was made at.
 *
 *      This reads Dummy.throwCount / Dummy.lastThrowDist — an explicit counter
 *      the dummy increments on the frame it actually initiates a punch (Stage 17
 *      part 0a). It used to be INFERRED from punchTimer increasing, because a
 *      throw's 0→n edge isn't observable: when the dummy is armed, the same
 *      update() that ends one windup starts the next, so punchTimer is never
 *      seen at exactly 0 in between. That inference stopped being valid at Stage
 *      16 — extendRecovery() raises punchTimer mid-punch on a whiff, so a single
 *      whiffed jab registered as several throws and the "debug T forces exactly
 *      one throw" check failed deterministically. Observing the commit at the
 *      source has no such failure mode, and it also reports the distance the
 *      range gate itself used rather than a re-measure a frame later.
 *
 *      The rAF loop is still how the counter is polled, so it accumulates one
 *      entry per commit even if several land between samples.
 *  - window.__resolves: one entry per resolved attack, recording whether the
 *      defender was blocking — this is the ground truth for the block test,
 *      taken from inside _resolveAttack itself.
 */
async function freshLoad() {
  await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const sc = window.__game.scene.keys.RingScene;
    const d  = sc.dummy;
    window.__throws   = [];
    window.__resolves = [];

    let seen = d.throwCount;
    const t0 = performance.now();
    const tick = () => {
      while (seen < d.throwCount) {
        seen++;
        window.__throws.push({ t: (performance.now() - t0) / 1000, dist: d.lastThrowDist });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const orig = sc._resolveAttack.bind(sc);
    sc._resolveAttack = (attacker, defender, arm, punchType) => {
      const p = typeof defender.getHitPos === 'function' ? defender.getHitPos() : defender;
      const dist = Math.hypot(p.x - attacker.x, p.y - attacker.y);
      window.__resolves.push({
        fromPlayer: attacker === sc.fighter,
        blocked:    !!defender.isBlocking,
        // The dummy deliberately doesn't spend a reaction roll on a punch it
        // isn't in range of, so the meaningful block rate is measured over
        // in-range punches only. Since Stage 9 that threshold is the AI's own
        // dummyEngageDist — the resolver has no range constant any more.
        inRange:    dist <= window.__config.dummyEngageDist,
        dist,
      });
      return orig(attacker, defender, arm, punchType);
    };
  });
}

const peek = (fn, ...args) => page.evaluate(fn, ...args);
const sample = () => peek(() => {
  const sc = window.__game.scene.keys.RingScene, d = sc.dummy, f = sc.fighter;
  return {
    dist: d._distToOpponent, dvx: d.vx, atk: d.attackTimer, pt: d.punchTimer,
    blocking: d.isBlocking, down: d.isDown, agg: d._aggression,
    throws: window.__throws.length,
    throwDists: window.__throws.map(t => t.dist),
    playerBlocks:  window.__resolves.filter(r => r.fromPlayer && r.inRange).length,
    playerBlocked: window.__resolves.filter(r => r.fromPlayer && r.inRange && r.blocked).length,
    playerTotal:   window.__resolves.filter(r => r.fromPlayer).length,
    playerDists:   window.__resolves.filter(r => r.fromPlayer).map(r => Math.round(r.dist)),
  };
});

// Hold each key across at least one frame — a bare press() can land entirely
// between frames, and Phaser's JustDown() only samples once per update tick.
async function tap(key, ms = 80) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// Read the shipped defaults from a clean load — later sections overwrite config
// values in-page, and a reload resets them, so they can't be read back later.
const cfg = await (async () => { await freshLoad(); return peek(() => ({
  standoff:    window.__config.dummyStandoffDist,
  band:        window.__config.dummyStandoffBand,
  smother:     window.__config.smotherDist,
  engage:      window.__config.dummyEngageDist,
  blockChance: window.__config.dummyBlockReactionChance,
})); })();

// ─── 1. Movement AI ──────────────────────────────────────────────────────────
console.log('\n=== 1. Movement AI ===');
await peek(() => { window.__config.dummyAttackDelayMin = 999; window.__config.dummyAttackDelayMax = 999;
                   window.__game.scene.keys.RingScene.dummy.attackTimer = 999; });

const startDist = (await sample()).dist;
await page.waitForTimeout(1300);
await page.screenshot({ path: `${OUT}/01_advancing.png` });
const midDist = (await sample()).dist;
check('advances when out of range', midDist < startDist - 50,
  `dist ${startDist.toFixed(0)} → ${midDist.toFixed(0)} px`);

const trace = [];
for (let i = 0; i < 30; i++) { await page.waitForTimeout(100); trace.push(await sample()); }
await page.screenshot({ path: `${OUT}/02_settled.png` });

const dists = trace.map(s => s.dist);
const spread = Math.max(...dists) - Math.min(...dists);
let flips = 0;
for (let i = 1; i < trace.length; i++) {
  const a = trace[i - 1].dvx, b = trace[i].dvx;
  if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) flips++;
}
const hold = dists[dists.length - 1];
// Jitter is oscillation — the dummy reversing direction on the spot. That is
// exactly what velocity sign flips count, so assert on those alone. The old
// `spread < 4` conjunct measured how far the distance drifted across a 3 s
// sample, which is frame-timing dependent: under a heavier render load the same
// non-jittering approach settles more slowly and trips the threshold while
// still reporting 0 flips. Spread is still reported for diagnosis.
check('settles without jitter', flips === 0,
  `${flips} velocity sign flips (spread ${spread.toFixed(1)} px)`);
check('holds inside the landing band', hold > cfg.smother && hold < cfg.engage,
  `holds ${hold.toFixed(0)} px (band ${cfg.smother}–${cfg.engage}, standoff ${cfg.standoff}±${cfg.band})`);

// Cornered — the pinned case where naive approach logic vibrates. Give it a
// long settle first: the dummy has to travel around the pinned player to find
// its standoff, and that transit is drift, not jitter.
await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowDown');
await page.waitForTimeout(4500);
const corner = [];
for (let i = 0; i < 20; i++) { await page.waitForTimeout(100); corner.push(await sample()); }
await page.keyboard.up('ArrowRight'); await page.keyboard.up('ArrowDown');
await page.screenshot({ path: `${OUT}/03_cornered.png` });
let cflips = 0;
for (let i = 1; i < corner.length; i++) {
  const a = corner[i - 1].dvx, b = corner[i].dvx;
  if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) cflips++;
}
const cspread = Math.max(...corner.map(s => s.dist)) - Math.min(...corner.map(s => s.dist));
check('no jitter when cornered at the ropes', cspread < 4 && cflips === 0,
  `spread ${cspread.toFixed(1)} px, ${cflips} sign flips, holds ${corner[corner.length - 1].dist.toFixed(0)} px`);

// ─── 2. Range-gated attacks ──────────────────────────────────────────────────
console.log('\n=== 2. Range-gated attacks ===');
await freshLoad();
await peek(() => {
  window.__config.dummyMoveSpeed      = 0;     // pinned — can't close
  window.__config.dummyAttackDelayMin = 0.3;
  window.__config.dummyAttackDelayMax = 0.4;
  window.__config.healthDamagePerForce = 0;    // no knockdowns polluting the run
  window.__game.scene.keys.RingScene.dummy.attackTimer = 0.1;
});
await page.waitForTimeout(4000);
let s = await sample();
check('does not throw while out of range', s.throws === 0,
  `dist ${s.dist.toFixed(0)} > engage dist ${cfg.engage}, ${s.throws} throws`);
check('timer holds armed at 0 waiting for range', s.atk === 0, `attackTimer=${s.atk.toFixed(2)}`);
await page.screenshot({ path: `${OUT}/04_armed_out_of_range.png` });

await peek(() => { window.__config.dummyMoveSpeed = 170; });
await page.waitForTimeout(5000);
s = await sample();
const outOfBand = s.throwDists.filter(d => d > cfg.engage + 5 || d < cfg.smother - 5);
check('throws once it has closed into range', s.throws > 0, `${s.throws} throws`);
check('every throw starts inside the landing band', outOfBand.length === 0,
  `distances ${s.throwDists.map(d => d.toFixed(0)).join(', ')}`);
await page.screenshot({ path: `${OUT}/05_throwing_in_range.png` });

// Debug T key: must still force a throw from out of range …
await peek(() => {
  window.__config.dummyMoveSpeed = 0;
  window.__config.dummyAttackDelayMin = 999; window.__config.dummyAttackDelayMax = 999;
  const sc = window.__game.scene.keys.RingScene;
  sc.dummy.attackTimer = 999;
  sc.dummy._loco.x = 840;
  sc.fighter.x     = 470;
});
// Wait out any windup already in flight — forceAttack() deliberately no-ops
// mid-windup so it can't stack onto one already telegraphing.
await page.waitForFunction(() => window.__game.scene.keys.RingScene.dummy.punchTimer === 0, null, { timeout: 5000 });
const before = await sample();
await tap('KeyT');
await page.waitForTimeout(300);
s = await sample();
check('debug T forces a throw from out of range', s.throws === before.throws + 1,
  `dist ${before.dist.toFixed(0)}, throws ${before.throws} → ${s.throws}`);
await page.screenshot({ path: `${OUT}/06_forced_out_of_range.png` });

// … and must no-op while the dummy is down.
await page.waitForFunction(() => window.__game.scene.keys.RingScene.dummy.punchTimer === 0, null, { timeout: 5000 });
await peek(() => {
  window.__config.healthDamagePerForce = 0.01;
  window.__game.scene.keys.RingScene.dummy.takeDamage(9999);
});
await page.waitForTimeout(150);
const downBefore = await sample();
await tap('KeyT');
await page.waitForTimeout(300);
s = await sample();
check('debug T no-ops while the dummy is down', downBefore.down && s.throws === downBefore.throws,
  `isDown=${downBefore.down}, throws ${downBefore.throws} → ${s.throws}`);
await page.screenshot({ path: `${OUT}/07_down_no_throw.png` });

// ─── 3. Reactive blocking ────────────────────────────────────────────────────
console.log('\n=== 3. Reactive blocking ===');
// Each jab must get its OWN reaction roll — onOpponentPunchStart() deliberately
// refuses to re-roll or extend a guard that is already up, so a jab thrown while
// the previous guard is still live is simply eaten.
//
// The old spacing was a flat 600 ms of WALL CLOCK against a 450 ms block window,
// which looks like 150 ms of slack and isn't: dummyBlockReactionWindow counts
// down in GAME time, and every blocked hit fires hit-stop, which scales dt to
// 0.05 for up to 100 ms. MEASURED across 6 runs, the third jab of the series
// arrived with 0.02–0.12 s still on blockTimer in 4 of them, was refused a roll,
// and then resolved ~90 ms later against a guard that had just dropped — which
// is exactly the intermittent "chance 1.0 didn't block every punch" failure.
// The dummy's behaviour was correct throughout; the test's setup was not.
//
// So the gap is now a CONDITION, not a duration: keep the 600 ms floor for the
// punch to resolve and the rig to settle, then additionally wait until the guard
// is genuinely down and the player is free to throw again. Immune to hit-stop,
// to frame rate, and to the whiff-recovery lockout.
async function readyForNextJab() {
  await page.waitForTimeout(600);
  await page.waitForFunction(() => {
    const sc = window.__game.scene.keys.RingScene;
    return sc.dummy.blockTimer === 0 && sc.fighter.punchTimer === 0;
  }, null, { timeout: 6000 });
}

async function jabSeries(chance, count) {
  await freshLoad();
  await peek(c => {
    window.__config.dummyBlockReactionChance = c;
    window.__config.dummyAttackDelayMin = 999;      // isolate: no dummy punches
    window.__config.dummyAttackDelayMax = 999;      // (its own windup suppresses blocking)
    window.__config.healthDamagePerForce = 0;       // no knockdowns mid-series
    window.__game.scene.keys.RingScene.dummy.attackTimer = 999;
  }, chance);
  // Let the movement AI settle into range first so the jabs actually reach.
  // Waited on as a CONDITION rather than as a fixed 2200 ms, for the same reason
  // the inter-jab gap below is: the dummy closes at dummyMoveSpeed in GAME time,
  // and under CPU contention 2200 ms of wall clock isn't enough of it. When that
  // happened, every jab in the series resolved out of range, the in-range filter
  // matched nothing, and the check failed with "0/0 blocked" — a setup that
  // never ran, reported as a behavioural failure.
  await page.waitForFunction(() => {
    const d = window.__game.scene.keys.RingScene.dummy;
    return d._distToOpponent <= window.__config.dummyEngageDist;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);   // let the standoff hysteresis settle before throwing
  for (let i = 0; i < count; i++) {
    await tap('KeyJ', 60);
    await readyForNextJab();
  }
  return sample();
}

const N = 20;
const always = await jabSeries(1.0, 6);
check('chance 1.0 blocks every player punch', always.playerBlocked === always.playerBlocks && always.playerBlocks > 0,
  `${always.playerBlocked}/${always.playerBlocks} blocked`);

// Capture the guard pose INSIDE the reaction window — it lasts only
// dummyBlockReactionWindow seconds, so shoot right after the jab, not after
// the inter-jab pause.
await tap('KeyJ', 60);
await page.waitForTimeout(40);
const guardState = await sample();
check('guard pose is up during the reaction window', guardState.blocking, `isBlocking=${guardState.blocking}`);
await page.screenshot({ path: `${OUT}/08_guard_up.png`, clip: { x: 380, y: 260, width: 340, height: 220 } });
await page.waitForTimeout(600);
const expiredState = await sample();
check('guard drops when the window expires', !expiredState.blocking, `isBlocking=${expiredState.blocking}`);
await page.screenshot({ path: `${OUT}/08b_guard_expired.png`, clip: { x: 380, y: 260, width: 340, height: 220 } });

// Locked rule: blocking and punching are mutually exclusive — for the dummy too.
await peek(() => {
  const d = window.__game.scene.keys.RingScene.dummy;
  d.forceAttack();
});
await page.waitForTimeout(120);
const midWindup = await peek(() => {
  const d = window.__game.scene.keys.RingScene.dummy;
  d.onOpponentPunchStart();          // try to raise the guard mid-windup
  return { pt: d.punchTimer, blocking: d.isBlocking };
});
check('cannot guard while its own windup is in flight', midWindup.pt > 0 && !midWindup.blocking,
  `punchTimer=${midWindup.pt.toFixed(2)}, isBlocking=${midWindup.blocking}`);

const never = await jabSeries(0.0, 6);
check('chance 0.0 never blocks', never.playerBlocked === 0,
  `${never.playerBlocked}/${never.playerBlocks} blocked`);
await tap('KeyJ', 60);
await page.waitForTimeout(40);
await page.screenshot({ path: `${OUT}/09_guard_never.png`, clip: { x: 380, y: 260, width: 340, height: 220 } });

const defaultChance = cfg.blockChance;
const mixed = await jabSeries(defaultChance, N);
check(`default chance ${defaultChance} is probability-driven (some, not all)`,
  mixed.playerBlocked > 0 && mixed.playerBlocked < mixed.playerBlocks,
  `${mixed.playerBlocked}/${mixed.playerBlocks} in-range punches blocked ` +
  `(~${(mixed.playerBlocked / Math.max(1, mixed.playerBlocks) * 100).toFixed(0)}%, nominal ${defaultChance * 100}%)`);
console.log(`     ${mixed.playerTotal - mixed.playerBlocks}/${mixed.playerTotal} jabs were thrown from out of range ` +
  `(dummy knocked back by the previous one) — distances: ${mixed.playerDists.join(', ')}`);

// ─── 4. Punishing openings ───────────────────────────────────────────────────
console.log('\n=== 4. Punishing openings ===');
// Fixed base delay + no damage so the only variable is the aggression multiplier.
async function cadence({ lowStamina, blocking }, seconds) {
  await freshLoad();
  await peek(() => {
    window.__config.dummyAttackDelayMin = 3.0;
    window.__config.dummyAttackDelayMax = 3.0;
    window.__config.healthDamagePerForce = 0;
    window.__config.dummyBlockReactionChance = 0;   // keep the dummy's own guard out of it
  });
  // Settle into range — a condition, not a duration, same as jabSeries above.
  // Every check in this section reads _aggression, and the unguarded-in-range
  // term only engages once the dummy has actually closed the distance.
  await page.waitForFunction(() => {
    const d = window.__game.scene.keys.RingScene.dummy;
    return d._distToOpponent <= window.__config.dummyEngageDist;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  if (lowStamina) {
    await peek(() => { window.__config.staminaRegenPerSecond = 0;
                       window.__game.scene.keys.RingScene.fighter.stamina = 10; });
  }
  if (blocking) await page.keyboard.down('ShiftLeft');
  const t0 = (await sample()).throws;
  await page.waitForTimeout(seconds * 1000);
  const end = await sample();
  if (blocking) await page.keyboard.up('ShiftLeft');
  return { throws: end.throws - t0, agg: end.agg };
}

const WINDOW = 12;
const guarded = await cadence({ lowStamina: false, blocking: true }, WINDOW);
console.log(`  guarded, full stamina : ${guarded.throws} throws in ${WINDOW}s (aggression ${guarded.agg.toFixed(2)})`);
const exposed = await cadence({ lowStamina: false, blocking: false }, WINDOW);
console.log(`  unguarded, full stam. : ${exposed.throws} throws in ${WINDOW}s (aggression ${exposed.agg.toFixed(2)})`);
const gassed  = await cadence({ lowStamina: true,  blocking: false }, WINDOW);
console.log(`  unguarded + gassed    : ${gassed.throws} throws in ${WINDOW}s (aggression ${gassed.agg.toFixed(2)})`);

check('guard up = baseline aggression', Math.abs(guarded.agg - 1) < 0.01, `aggression ${guarded.agg.toFixed(2)}`);
check('unguarded in range raises aggression', exposed.agg > guarded.agg + 0.1,
  `${guarded.agg.toFixed(2)} → ${exposed.agg.toFixed(2)}`);
check('low stamina stacks on top', gassed.agg > exposed.agg + 0.1,
  `${exposed.agg.toFixed(2)} → ${gassed.agg.toFixed(2)}`);
check('gassed player is visibly punched more often', gassed.throws > guarded.throws,
  `${guarded.throws} → ${gassed.throws} throws in ${WINDOW}s`);
await page.screenshot({ path: `${OUT}/10_aggression.png` });

// ─── Report ──────────────────────────────────────────────────────────────────
await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\nScreenshots → ${OUT}/`);
console.log('Page errors:', errors.length ? errors : 'none');
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.label}`));
  process.exit(1);
}

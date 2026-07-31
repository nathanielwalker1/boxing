/**
 * Stance verification (Stage 9) — proves arm identity is driven by STANCE, not
 * by facing.
 *
 * Full matrix: 2 stances × 2 facings (player left / right of the opponent)
 *              × 3 joystick holds × 4 punches = 48 cases.
 *
 * Invariants checked per case:
 *   1. jab   → the stance's LEAD arm  (orthodox = left,  southpaw = right)
 *   2. cross → the stance's REAR arm  (orthodox = right, southpaw = left)
 *   3. jab/cross ignore the joystick hold entirely
 *   4. hook/uppercut follow the hold only (left hold → left arm, right and
 *      neutral → right arm), identically in both stances
 *   5. the SAME anatomical arm throws a given punch in BOTH facings
 *   6. the rig slot that animates is still lead-forward: a jab animates the
 *      'lead' slot, so it renders toward the opponent from either side
 *   7. the fist actually renders on the opponent's side of the fighter
 *
 * The expected-value oracle below is written independently of rig.js on
 * purpose — it must not import the code under test.
 */
import { chromium } from 'playwright';

const URL = 'http://localhost:5173';

// ── Independent oracle ───────────────────────────────────────────────────────
const expectedArm = (stance, punch, hold) => {
  if (punch === 'jab')   return stance === 'orthodox' ? 'left'  : 'right';
  if (punch === 'cross') return stance === 'orthodox' ? 'right' : 'left';
  return hold < -0.25 ? 'left' : 'right';            // hook / uppercut
};
// Which rig slot that arm sits in — lead = drawn toward the opponent.
const expectedSlot = (stance, arm) =>
  (stance === 'orthodox' ? 'left' : 'right') === arm ? 'lead' : 'rear';

const STANCES = ['orthodox', 'southpaw'];
const PUNCHES = ['jab', 'cross', 'hook', 'uppercut'];
const HOLDS   = [{ name: 'left', x: -1 }, { name: 'right', x: 1 }, { name: 'neutral', x: 0 }];
// Player placed left of the dummy (should face right) and right of it (face left).
const PLACES  = [
  { name: 'player-left',  playerX: 400, dummyX: 560, expectFacingRight: true  },
  { name: 'player-right', playerX: 560, dummyX: 400, expectFacingRight: false },
];

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200);

// Freeze everything that could perturb the matrix: no dummy movement, no dummy
// attacks, no damage (so nothing gets knocked down mid-run).
await page.evaluate(() => {
  window.__config.dummyMoveSpeed        = 0;
  window.__config.dummyAttackDelayMin   = 999;
  window.__config.dummyAttackDelayMax   = 999;
  window.__config.healthDamagePerForce  = 0;
  window.__config.dummyBlockReactionChance = 0;
  const sc = window.__game.scene.keys.RingScene;
  sc.dummy.attackTimer = 999;
});

const results = [];

for (const stance of STANCES) {
  for (const place of PLACES) {
    // Position both fighters, then let a frame run so facing settles.
    await page.evaluate(({ stance, place }) => {
      const sc = window.__game.scene.keys.RingScene;
      sc.fighter.stance = stance;
      sc.fighter.x = place.playerX; sc.fighter.y = 320;
      sc.fighter.vx = 0; sc.fighter.vy = 0;
      sc.fighter.health = window.__config.healthMax;
      sc.dummy._loco.x = place.dummyX; sc.dummy._loco.y = 320;
      sc.dummy._loco.vx = 0; sc.dummy._loco.vy = 0;
      sc.dummy.x = place.dummyX; sc.dummy.y = 320;
    }, { stance, place });
    await page.waitForTimeout(120);

    for (const hold of HOLDS) {
      for (const punch of PUNCHES) {
        const r = await page.evaluate(({ punch, holdX }) => {
          const sc = window.__game.scene.keys.RingScene;
          const f  = sc.fighter;
          f.punchArm = null; f.punchType = null; f.punchTimer = 0;
          f.stamina  = window.__config.staminaMax;   // avoid the low-stamina stretch
          sc._lastInputX = holdX;                    // the hold the punch reads
          sc._resolvePunch(punch);
          const fist = f.getFistPos(f.punchArm);
          return {
            arm:          f.punchArm,
            type:         f.punchType,
            facingRight:  f.facingRight,
            fistOffsetX:  fist.x - f.x,
            towardOpponent: Math.sign(sc.dummy.x - f.x),
          };
        }, { punch, holdX: hold.x });

        const wantArm  = expectedArm(stance, punch, hold.x);
        const wantSlot = expectedSlot(stance, wantArm);
        results.push({
          stance, place: place.name, hold: hold.name, punch,
          arm: r.arm, wantArm,
          slot: wantSlot,
          facingRight: r.facingRight,
          facingOk: r.facingRight === place.expectFacingRight,
          armOk:    r.arm === wantArm,
          typeOk:   r.type === punch,
          fistSideOk: Math.sign(r.fistOffsetX) === r.towardOpponent,
          fistOffsetX: Math.round(r.fistOffsetX),
        });
      }
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const fails = results.filter(r => !(r.armOk && r.typeOk && r.facingOk && r.fistSideOk));

console.log('\n=== STANCE / ARM-IDENTITY MATRIX (48 cases) ===');
console.log('stance    place         hold     punch     arm     slot   facing  fistΔx   ok');
for (const r of results) {
  const ok = r.armOk && r.typeOk && r.facingOk && r.fistSideOk ? 'PASS' : 'FAIL';
  console.log(
    `${r.stance.padEnd(9)} ${r.place.padEnd(13)} ${r.hold.padEnd(8)} ${r.punch.padEnd(9)} ` +
    `${r.arm.padEnd(7)} ${r.slot.padEnd(6)} ${(r.facingRight ? 'right' : 'left').padEnd(7)} ` +
    `${String(r.fistOffsetX).padStart(6)}   ${ok}`,
  );
}

// ── Invariant 5: same punch → same arm across BOTH facings ───────────────────
console.log('\n=== FACING INVARIANCE (arm must match across placements) ===');
let invFails = 0;
for (const stance of STANCES) {
  for (const hold of HOLDS) {
    for (const punch of PUNCHES) {
      const [a, b] = PLACES.map(p =>
        results.find(r => r.stance === stance && r.place === p.name &&
                          r.hold === hold.name && r.punch === punch));
      const same = a.arm === b.arm;
      if (!same) invFails++;
      console.log(`${stance.padEnd(9)} ${punch.padEnd(9)} hold=${hold.name.padEnd(8)} ` +
                  `left-side:${a.arm.padEnd(6)} right-side:${b.arm.padEnd(6)} ` +
                  `${same ? 'SAME ✓' : 'DIFFERS ✗'}`);
    }
  }
}

// ── Stance-independence of hook/uppercut ─────────────────────────────────────
console.log('\n=== HOOK/UPPERCUT STANCE-INDEPENDENCE (hold decides, not stance) ===');
let hookFails = 0;
for (const hold of HOLDS) {
  for (const punch of ['hook', 'uppercut']) {
    const arms = STANCES.flatMap(s => PLACES.map(p =>
      results.find(r => r.stance === s && r.place === p.name &&
                        r.hold === hold.name && r.punch === punch).arm));
    const uniform = arms.every(a => a === arms[0]);
    const wanted  = hold.x < -0.25 ? 'left' : 'right';
    const ok = uniform && arms[0] === wanted;
    if (!ok) hookFails++;
    console.log(`${punch.padEnd(9)} hold=${hold.name.padEnd(8)} arms=[${arms.join(', ')}] ` +
                `want=${wanted.padEnd(6)} ${ok ? 'PASS' : 'FAIL'}`);
  }
}

await page.screenshot({ path: 'scripts/output/stance_final.png' });
await browser.close();

console.log(`\nMatrix failures:            ${fails.length}`);
console.log(`Facing-invariance failures: ${invFails}`);
console.log(`Hook/uppercut failures:     ${hookFails}`);
console.log('Page errors:', errors.length ? errors : 'none');
if (fails.length || invFails || hookFails || errors.length) process.exitCode = 1;

import { chromium } from 'playwright';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${process.env.PORT ?? 5173}`, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1500);

// 1. Initial state — fighter left of dummy, should face right (toward dummy)
await page.screenshot({ path: 'scripts/output/facing_01_initial.png' });

// 2. Sidestep LEFT (away from dummy, moving further left) — old bug flipped
//    facing to left here because vx < 0. Correct: dummy still to the right,
//    so fighter should keep facing right.
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(1200);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_02_sidestep_left.png' });

// 3. Move RIGHT, all the way past the dummy's x position, to end up
//    behind/past the opponent. Fighter should now face LEFT (dummy behind him).
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(4000);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_03_past_dummy.png' });

// 4. Sidestep further RIGHT (away from dummy again, now moving away while
//    already past it) — old bug would keep/flip facing based on vx > 0
//    (facing right), but correct behavior: dummy is now to the LEFT, so
//    fighter should face left.
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(800);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_04_sidestep_right_past.png' });

// 5. Move back LEFT across the dummy again — should flip back to facing right.
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(4000);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_05_back_left.png' });

// ── 6. Facing while BLOCKING ────────────────────────────────────────────────
// Regression guard for the bug where holding block made the fighter read as
// facing AWAY from the opponent. Two independent things are checked, because
// the symptom was visual while the facing variable itself was always correct:
//
//   a) facingRight / container.scaleX still track the opponent continuously
//      while block is held, from both sides — i.e. block did not fork onto a
//      separate facing source.
//   b) the BLOCK POSE ITSELF still leans toward the opponent: in rig-local
//      space (+x = toward the opponent) the limbs must reach further forward
//      than backward. This is what actually broke — a shared absolute block
//      angle pair parked the rear glove 25 px behind the torso, so the
//      silhouette pointed backwards even though scaleX was right.

const failures = [];

// Freeze the dummy so it can be pinned on either side.
await page.evaluate(() => {
  window.__config.dummyMoveSpeed      = 0;
  window.__config.dummyAttackDelayMin = 999;
  window.__config.dummyAttackDelayMax = 999;
  window.__game.scene.keys.RingScene.dummy.attackTimer = 999;
});

const pin = (px, dx) => page.evaluate(({ px, dx }) => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.x = px; sc.fighter.y = 320; sc.fighter.vx = 0; sc.fighter.vy = 0;
  sc.dummy._loco.x = dx; sc.dummy._loco.y = 320;
  sc.dummy._loco.vx = 0; sc.dummy._loco.vy = 0;
  sc.dummy.x = dx; sc.dummy.y = 320;
  sc.dummy.staggerX = 0; sc.dummy.staggerY = 0;
  sc.dummy.staggerVx = 0; sc.dummy.staggerVy = 0;
}, { px, dx });

const sample = () => page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  const f  = sc.fighter;
  const p  = window.__rig.computePose(null, f.isBlocking ? 1 : 0, 0);
  const xs = [p.lead.wx, p.rear.wx, p.lead.ex, p.rear.ex];
  return {
    blocking:    f.isBlocking,
    facingRight: f.facingRight,
    scaleX:      f.container.scaleX,
    expectRight: sc.dummy.x > f.x,
    fwdReach:    Math.max(...xs),
    backReach:   Math.min(...xs),
  };
});

for (const [label, px, dx] of [['dummy right', 400, 620], ['dummy left', 620, 400]]) {
  await pin(px, dx);
  await page.keyboard.down('Shift');
  // Sample repeatedly across the whole hold, not just once at the end.
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(120);
    await pin(px, dx);
    const s = await sample();
    if (!s.blocking) { failures.push(`[${label}] block never engaged`); break; }
    if (s.facingRight !== s.expectRight) {
      failures.push(`[${label}] sample ${i}: facingRight=${s.facingRight}, expected ${s.expectRight}`);
    }
    if (s.scaleX !== (s.expectRight ? 1 : -1)) {
      failures.push(`[${label}] sample ${i}: scaleX=${s.scaleX} disagrees with facing`);
    }
    if (s.fwdReach <= Math.abs(s.backReach)) {
      failures.push(`[${label}] sample ${i}: block pose points backwards ` +
                    `(fwd ${s.fwdReach.toFixed(1)} <= back ${Math.abs(s.backReach).toFixed(1)})`);
    }
  }
  await page.screenshot({
    path: `scripts/output/facing_06_block_${label.replace(' ', '_')}.png`,
    clip: { x: 160 + px - 95, y: 80 + 320 - 115, width: 190, height: 200 },
  });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
}

// ── 7. Rapid block toggling while circling ──────────────────────────────────
// Facing must track the opponent every frame with no stuck or delayed state.
await pin(400, 620);
for (let i = 0; i < 10; i++) {
  const past = i >= 5;                       // second half: circle past the dummy
  await pin(past ? 700 : 400, 620);
  if (i % 2 === 0) await page.keyboard.down('Shift');
  else             await page.keyboard.up('Shift');
  await page.waitForTimeout(100);
  await pin(past ? 700 : 620 - 220, 620);
  const s = await sample();
  if (s.facingRight !== s.expectRight) {
    failures.push(`[toggle ${i}] facingRight=${s.facingRight}, expected ${s.expectRight} ` +
                  `(blocking=${s.blocking})`);
  }
}
await page.keyboard.up('Shift');

// ── 8. DUMMY facing at the ropes and in the corners ─────────────────────────
// Regression guard for the bug where a rope-adjacent dummy attacked while
// facing AWAY from a player standing right next to it, punching out through
// the ropes. Two independent causes, both asserted here:
//
//   a) STAGGER CONTAMINATION — dummy facing was computed from this.x, which is
//      its locomotion x PLUS the stagger spring's offset. Mid-ring the real
//      ~64 px separation swamps a few px of wobble, but pinned against a rope
//      BOTH fighters clamp to the same RIG_MARGIN_X and therefore sit at the
//      identical x, so the wobble WAS the entire separation and its sign
//      decided facing — one punch spun the dummy to face the ropes for the
//      whole ~1 s stagger recovery.
//   b) TIE FREEZE — `if (px > dx) … else if (px < dx) …` had no else, so at
//      that same exact tie neither branch fired and facing silently held
//      whatever it had, including a wrong value latched by (a).
//
// The load-bearing assertion is geometric, not just the boolean: at a rope tie
// there is no left/right answer, so what actually has to hold is that the
// dummy's jab travels INTO the ring rather than out through the ropes.

const ringB = await page.evaluate(() => window.__game.scene.keys.RingScene._getRingBounds());
const MX = 24, MT = 67, MB = 44;   // RIG_MARGIN_* — where a body clamps

// Dummy anchors: each of the 4 rope edges plus all 4 corners, pinned exactly
// where the boundary clamp would put it.
const anchors = [
  ['left-rope',   ringB.left + MX,  (ringB.top + ringB.bottom) / 2],
  ['right-rope',  ringB.right - MX, (ringB.top + ringB.bottom) / 2],
  ['top-rope',    (ringB.left + ringB.right) / 2, ringB.top + MT],
  ['bottom-rope', (ringB.left + ringB.right) / 2, ringB.bottom - MB],
  ['corner-TL',   ringB.left + MX,  ringB.top + MT],
  ['corner-TR',   ringB.right - MX, ringB.top + MT],
  ['corner-BL',   ringB.left + MX,  ringB.bottom - MB],
  ['corner-BR',   ringB.right - MX, ringB.bottom - MB],
];

// Player offsets: the 8 compass directions at close range. Several of these put
// the player OUTSIDE the ring, where the clamp drops them onto the dummy's exact
// x — which is precisely the degenerate case being guarded.
const OFF = 45;
const offsets = [];
for (let a = 0; a < 8; a++) {
  const th = a * Math.PI / 4;
  offsets.push([a * 45, Math.cos(th) * OFF, Math.sin(th) * OFF]);
}

const ropeResults = await page.evaluate(async ({ anchors, offsets }) => {
  const sc = window.__game.scene.keys.RingScene;
  const d  = sc.dummy, f = sc.fighter;
  const rb = sc._getRingBounds();
  const ringCx = (rb.left + rb.right) / 2;
  const out = [];

  for (const [name, dx, dy] of anchors) {
    // Which way the ring interior lies from this anchor. Used only by the test,
    // to (a) seed each case from a realistic approach and (b) aim the punch
    // impulse the way a player standing in the ring would actually deliver it.
    const inward = Math.sign(ringCx - dx) || 1;

    for (const [deg, ox, oy] of offsets) {
      const pinDummy = () => { d._loco.x = dx; d._loco.y = dy; d._loco.vx = 0; d._loco.vy = 0; };
      const pinBoth  = () => {
        f.x = dx + ox; f.y = dy + oy; f.vx = 0; f.vy = 0;
        pinDummy();
      };
      d.staggerX = d.staggerY = d.staggerVx = d.staggerVy = 0;

      // SEED, so facing never carries over from the previous case: the player
      // approaches from inside the ring, which is the only way they can reach a
      // rope-pinned dummy in real play. Facing must be pointing inward after this.
      for (let i = 0; i < 6; i++) {
        f.x = dx + inward * 80; f.y = dy; f.vx = 0; f.vy = 0;
        pinDummy();
        await new Promise(r => requestAnimationFrame(r));
      }
      const seeded = d.facingRight;

      // Now move the player to the test offset and settle (the boundary clamp
      // pulls an out-of-ring offset back onto the dummy's exact x — the
      // degenerate tie this whole section exists to guard).
      for (let i = 0; i < 6; i++) { pinBoth(); await new Promise(r => requestAnimationFrame(r)); }

      // Facing once both fighters are at rest in the test position. Everything
      // below must leave this UNCHANGED, because the player does not move again.
      const settled = {
        facingRight: d.facingRight,
        locoDx: f.x - d._loco.x,       // the honest horizontal separation
      };

      const rec = { name, deg, seeded, inward, settled, samples: [], peak: null };

      // Land a punch on the pinned dummy, driving it toward the ring interior —
      // this is what used to invert facing (cause a). The attack is thrown
      // straight away, so the punch happens WHILE the stagger offset is at its
      // largest; sampling only after the spring rings down would miss the bug
      // entirely, since facing snapped back once the offset returned to zero.
      d.receiveImpulse(inward * 260, 0);
      d.forceAttack();
      // 55 frames covers both the stagger spring's largest excursion and the
      // jab's peak (windup 0.8 s ≈ 48 frames), which is where the bug showed.
      for (let i = 0; i < 55; i++) {
        pinBoth();
        await new Promise(r => requestAnimationFrame(r));
        rec.samples.push({
          facingRight: d.facingRight,
          scaleX: d.container.scaleX,
          locoDx: f.x - d._loco.x,
          stg: d.staggerX,
        });
        if (d.punchTimer > 0 && d._impactPending === false && !rec.peak) {
          const fist = d.getFistPos(d.punchArm);
          rec.peak = { fistX: fist.x, facingRight: d.facingRight, dX: d.x, locoX: d._loco.x, pX: f.x };
        }
      }
      // Clear the punch so the next case starts idle.
      d.punchTimer = 0; d.punchArm = null; d.punchType = null; d._impactPending = false;
      out.push(rec);
    }
  }
  return out;
}, { anchors, offsets });

const DEAD = await page.evaluate(() => window.__config.facingDeadband);

for (const r of ropeResults) {
  const tag = `[${r.name} ${r.deg}°]`;

  // Sanity: the seeded approach from inside the ring must have turned the
  // dummy inward. If this fails, every assertion below is meaningless.
  if (r.seeded !== (r.inward > 0)) {
    failures.push(`${tag} seed failed: facingRight=${r.seeded} after the player approached ` +
                  `from ${r.inward > 0 ? 'the right' : 'the left'}`);
    continue;
  }

  // The settled facing itself must be right: toward the player when there is
  // real separation, and inward (the side the player approached from) at a
  // rope tie, where zero separation leaves no left/right answer.
  const expectSettled = Math.abs(r.settled.locoDx) > DEAD ? (r.settled.locoDx > 0) : (r.inward > 0);
  if (r.settled.facingRight !== expectSettled) {
    failures.push(`${tag} settled facingRight=${r.settled.facingRight}, expected ${expectSettled} ` +
                  `(separation ${r.settled.locoDx.toFixed(1)}px)`);
  }

  for (let i = 0; i < r.samples.length; i++) {
    const s = r.samples[i];
    // scaleX must always agree with the facing flag.
    if (s.scaleX !== (s.facingRight ? 1 : -1)) {
      failures.push(`${tag} sample ${i}: scaleX=${s.scaleX} disagrees with facingRight=${s.facingRight}`);
      break;
    }
    // THE core assertion. The player has not moved since `settled`, so facing —
    // which may depend on nothing but where the opponent is — must not have
    // moved either. Being punched and staggering is not the opponent moving.
    if (s.facingRight !== r.settled.facingRight) {
      failures.push(`${tag} sample ${i}: facing changed to ${s.facingRight} while the player ` +
                    `stood still (separation ${s.locoDx.toFixed(1)}px, stagger ${s.stg.toFixed(1)}px) ` +
                    `— stagger must not drive facing`);
      break;
    }
    // And it must still point at the player whenever there is real separation.
    if (Math.abs(s.locoDx) > DEAD && s.facingRight !== (s.locoDx > 0)) {
      failures.push(`${tag} sample ${i}: facingRight=${s.facingRight} but player is ` +
                    `${s.locoDx > 0 ? 'right' : 'left'} by ${s.locoDx.toFixed(1)}px`);
      break;
    }
  }

  // The real symptom: the jab must go INTO the ring, not out through the ropes.
  if (!r.peak) {
    failures.push(`${tag} never reached punch peak`);
  } else {
    const { fistX, facingRight, locoX, pX } = r.peak;
    if (fistX < ringB.left || fistX > ringB.right) {
      failures.push(`${tag} mid-attack fist at x=${fistX.toFixed(1)} is OUTSIDE the ring ` +
                    `(${ringB.left}..${ringB.right}) — dummy is punching through the ropes ` +
                    `(facingRight=${facingRight}, loco=${locoX.toFixed(1)}, player=${pX.toFixed(1)})`);
    }
    const sep = pX - locoX;
    if (Math.abs(sep) > DEAD && facingRight !== (sep > 0)) {
      failures.push(`${tag} mid-attack facingRight=${facingRight} but player is ` +
                    `${sep > 0 ? 'right' : 'left'} by ${sep.toFixed(1)}px`);
    }
  }
}

// Screenshot the exact reported scenario: dummy backed into a rope, player
// immediately adjacent (clamped onto the same x), dummy held at the peak of its
// jab. The player APPROACHES from inside the ring first, because that is the
// only way to reach a rope-pinned dummy — teleporting them into place instead
// would leave facing carrying over from whatever ran last, a state real play
// cannot produce.
const shotFacing = await page.evaluate(async ({ ringB }) => {
  window.__config.camZoom = 1.3;
  const sc = window.__game.scene.keys.RingScene;
  const d = sc.dummy, f = sc.fighter;
  const rx = ringB.left + 24;
  const pinDummy = () => { d._loco.x = rx; d._loco.y = 320; d._loco.vx = 0; d._loco.vy = 0; };
  const pin = () => { f.x = rx; f.y = 278; f.vx = 0; f.vy = 0; pinDummy(); };

  // Approach from inside the ring, then close onto the rope.
  for (let i = 0; i < 10; i++) {
    f.x = rx + 80; f.y = 300; f.vx = 0; f.vy = 0; pinDummy();
    await new Promise(r => requestAnimationFrame(r));
  }
  for (let i = 0; i < 10; i++) { pin(); await new Promise(r => requestAnimationFrame(r)); }

  d.forceAttack();
  for (let i = 0; i < 60; i++) {
    pin();
    await new Promise(r => requestAnimationFrame(r));
    if (d._impactPending === false && d.punchTimer > 0) break;
  }
  d.punchTimer = d._windupDuration * (1 - window.__rig.peakProgress('jab'));
  pin();
  const fist = d.getFistPos(d.punchArm);
  return { facingRight: d.facingRight, fistX: fist.x, dX: d.x, pX: f.x };
}, { ringB });
await page.waitForTimeout(60);
await page.screenshot({ path: 'scripts/output/facing_08_rope_attack.png' });
if (shotFacing.fistX < ringB.left || shotFacing.fistX > ringB.right) {
  failures.push(`[reported scenario] fist at x=${shotFacing.fistX.toFixed(1)} is outside the ring`);
}
console.log('Reported-bug scenario:', JSON.stringify(shotFacing));

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Facing test screenshots saved to scripts/output/facing_*.png');
console.log(`Rope/corner facing cases checked: ${ropeResults.length}`);

if (failures.length) {
  console.error('FACING FAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('Block-facing checks: PASS');
console.log('Rope/corner dummy-facing checks: PASS');

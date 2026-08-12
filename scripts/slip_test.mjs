/**
 * slip_test.mjs — verify flick-vs-hold detection and slip whiff behavior.
 * Run with: node scripts/slip_test.mjs
 * Dev server must be running on localhost:5173.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime, until, soft } from './waits.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await bootReady(page);

// The dummy's FIRST attack timer is randomly drawn once at construction time,
// using the default 1.5-3.5s config bounds — before this script ever touches
// the tuning panel. Overriding the sliders can't cancel that already-picked
// number (it only affects the *next* draw, which happens after an attack
// resolves), so we push the bounds out now (via the existing tuning panel,
// same as a human dragging the slider — no source changes) so every
// *subsequent* draw is safely out of the way, then wait out the worst case
// for that first draw (3.5s delay + 0.8s windup) before the deterministic
// part of the test that relies on the T debug key being the only attack.
async function setGuiNumber(label, value) {
  const input = page.locator('.controller', { hasText: label }).locator('input[type=text]');
  await input.fill(String(value));
  await input.press('Enter');
}
await setGuiNumber('Attack Delay Min', 999);
await setGuiNumber('Attack Delay Max', 999);

// Filling the GUI's text input leaves keyboard focus there — click back onto
// the canvas so subsequent keyboard events reach Phaser, not the input.
await page.mouse.click(575, 400);

// Wait out the unavoidable first natural attack (worst case ~4.3s from page
// load); ~700ms has already elapsed above, so this tops it up with margin.
await gameTime(page, 4.2);

// ── (a) FLICK — quick tap (<180ms) should trigger a visible slip/lean ───────
// Note: page.keyboard.press() sends keydown+keyup fast enough to sometimes
// race Phaser's per-frame JustDown check and get missed entirely (confirmed
// during development with the T key below) — down/wait/up is used
// throughout this script instead for reliability.
await page.keyboard.down('ArrowUp');
await gameTime(page, 0.08);           // well under slipFlickMaxDurationMs (180ms)
await page.keyboard.up('ArrowUp');
await gameTime(page, 0.09);           // mid-window (slipInvincibilityDuration 250ms) — lean visible
await page.screenshot({ path: 'scripts/output/slip_flick.png' });
await gameTime(page, 0.4);          // let the slip window fully resolve back to idle

// ── (b) HOLD — sustained press (>180ms) should produce normal footwork, no slip ─
await page.keyboard.down('ArrowLeft');
await gameTime(page, 0.5);          // well past the flick window — confirmed hold
await page.screenshot({ path: 'scripts/output/slip_hold_footwork.png' });
await page.keyboard.up('ArrowLeft');
await gameTime(page, 0.2);

// ── (c) Debug test-punch whiffing during an active slip window ─────────────
// Pin the fighters at a distance where the dummy's jab would COMFORTABLY land
// (its measured reach is ~85 px, smother radius is 50) so the only reason the
// punch misses is the slip. This used to be a timed walk, but both fighters
// close on each other now, so it overshot into the smother zone — where the
// punch fails for an unrelated reason and the test proves nothing.
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__config.dummyMoveSpeed = 0;
  sc.fighter.x  = sc.dummy.x - 65;
  sc.fighter.y  = sc.dummy.y;
  sc.fighter.vx = sc.fighter.vy = 0;
});
await gameTime(page, 0.2);

// Force an immediate dummy attack (T = temporary debug key). The dummy's own
// timer is now parked at 6-8s (clamped from 999 by the slider's max), so this
// is the only attack that can fire during this window.
await page.keyboard.down('T');
await gameTime(page, 0.05);
await page.keyboard.up('T');
// dummyWindupDuration=0.8s; impact fires at the jab trajectory's own peak
// (peakAt 0.42 → ~0.34s), not at a flat half-windup. Flick partway through the
// windup so the 0.25s slip window covers the impact moment.
await gameTime(page, 0.2);
await page.keyboard.down('ArrowDown');
await gameTime(page, 0.08);           // flick (<180ms)
await page.keyboard.up('ArrowDown');
await gameTime(page, 0.15);          // land right around the 400ms impact mark
await page.screenshot({ path: 'scripts/output/slip_whiff_vs_dummy_punch.png' });
await gameTime(page, 0.6);          // let windup/flash fully resolve

// ── (d) Slip CLASSIFICATION and the punish window (Stage 19 parts 1 + 2) ─────
// Sections (a)–(c) prove a slip fires and that a punch misses because of it.
// This section proves the game can TELL that miss apart from an ordinary
// out-of-range one, and that only the first opens a punish window — which is
// the whole point of the stage. Without this, standing at the wrong distance
// would earn the same reward as reading the punch.
console.log('\n=== (d) Slip classification vs. an ordinary whiff ===');

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
};

// Record every resolution together with the classification the scene made, so
// the assertions read the resolver's own verdict rather than re-deriving it.
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  // Park the dummy's OWN attack clock properly. Sections (a)–(c) push the delay
  // out through the tuning panel, where the slider's max clamps 999 down to
  // 6–8 s — long enough for those sections, but this one runs past that point,
  // and a natural attack landing mid-case resolves into __res and is read as if
  // it were the forced one. Config + attackTimer directly has no such clamp.
  window.__config.dummyAttackDelayMin = 999;
  window.__config.dummyAttackDelayMax = 999;
  sc.dummy.attackTimer = 999;

  // ── Timing accommodations for headless, applied to this whole section ──────
  // What is under test here is the CLASSIFICATION — which of two misses opens a
  // punish window. None of these change that; they only widen the runway the
  // test has to hit its inputs in, and each is restored at the end.
  //
  // The shipped numbers are unhittable in this environment. A dummy jab
  // resolves ~0.43 s after it arms and the slip window is 0.25 s, while ONE
  // rendered frame is ~16 ms on an idle machine and ~150 ms with three scripts
  // sharing the CPU. That 10x spread means no fixed frame count or delay can
  // satisfy both "release before slipFlickMaxDurationMs" and "the window is
  // still open at impact" — which is exactly how this section failed under
  // parallel load while passing when run alone.
  //
  // A 3 s windup gives the flick ~1.6 s of runway, and the wider flick/window
  // bounds absorb a single slow frame at either end.
  window.__config.dummyWindupDuration       = 3.0;   // shipped 0.8
  window.__config.slipFlickMaxDurationMs    = 400;   // shipped 180
  window.__config.slipInvincibilityDuration = 0.60;  // shipped 0.25

  window.__res = [];
  const orig = sc._resolveAttack.bind(sc);
  sc._resolveAttack = (a, d, arm, type) => {
    const before  = sc._slipCount;
    const outcome = orig(a, d, arm, type);
    window.__res.push({
      outcome, type,
      slipped:     sc._slipCount > before,
      defSlipping: d.slipTimer > 0,
      attPunish:   a._punishTimer,
      attPunishV:  a._punishVuln,
      // Recorded so a positioning failure reports as a positioning failure
      // rather than as a mysterious 'land' — the gap at the instant the
      // resolver read it, and who was actually throwing.
      gap:         Math.hypot(d.x - a.x, d.y - a.y),
      fromPlayer:  a === sc.fighter,
    });
    return outcome;
  };
});

/**
 * Run one dummy jab at the player from `dist`. Returns the recorded resolution
 * plus the attacker's vulnerability sampled at a FIXED punch progress
 * afterwards, which is what makes the slipped and out-of-range runs comparable:
 * both are read at the same point on the same curve, so any difference between
 * them is the punish spike and nothing else.
 *
 * `slip` is 'flick' (the real input path — down/up inside the flick window),
 * 'forced' (slipTimer written directly), or false. 'forced' exists for the
 * out-of-range case below, where the point is to guarantee a slip is ACTIVE at
 * the moment of resolution so the classification's second condition — "would
 * this have landed against the un-slipped anchor?" — is the only thing that can
 * reject it. Headless runs the sim at ~13 fps, so the 0.25 s slip window is
 * about three frames wide and a real flick can't be aimed that precisely.
 */
async function dummyJab({ dist, slip }) {
  // Wait the dummy out to genuinely IDLE before doing anything else. Section (c)
  // ends 0.6 s into an 0.8 s windup, so its punch is still in flight when this
  // section starts; without this the first case here reads that stale punch's
  // resolution and every position this function just set is irrelevant to it.
  await soft(page, () => {
    const d = window.__game.scene.keys.RingScene.dummy;
    return d.punchTimer === 0 && !d._impactPending;
  }, undefined, { timeout: 8000, label: 'the dummy to go idle' });

  await page.evaluate((d) => {
    const sc = window.__game.scene.keys.RingScene;
    window.__res.length = 0;
    window.__config.dummyMoveSpeed = 0;
    sc.dummy.attackTimer  = 999;
    sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.dummy._punishTimer = 0;
    sc.dummy._punishVuln  = 0;
    sc.fighter.slipTimer = 0;

    // Straddle the RING CENTRE rather than placing the player relative to
    // wherever the dummy happens to have drifted. Sections (a)–(c) leave both
    // fighters near the left rope, so "dummy.x − 220" is outside the ring: the
    // boundary clamp pulled the player straight back to the rope and every
    // out-of-range case silently ran at ~66 px instead. That reads as a
    // mysterious 'land', not as a positioning failure, which is why the gap is
    // now recorded on every resolution above.
    const b  = sc._getRingBounds();
    const cx = (b.left + b.right) / 2;
    const cy = (b.top + b.bottom) / 2;
    sc.dummy._loco.x  = cx + d / 2;
    sc.dummy._loco.y  = cy;
    sc.dummy._loco.vx = sc.dummy._loco.vy = 0;
    sc.dummy.x = sc.dummy._loco.x;
    sc.dummy.y = sc.dummy._loco.y;
    sc.fighter.x  = cx - d / 2;
    sc.fighter.y  = cy;
    sc.fighter.vx = sc.fighter.vy = 0;
    window.__pin  = { x: sc.fighter.x, y: sc.fighter.y };
  }, dist);
  await frames(page, 3);

  await page.keyboard.down('T');
  await frames(page, 3);
  await page.keyboard.up('T');
  // …and confirm the forced attack actually armed, so what resolves below is
  // THIS punch rather than whatever the previous case left running.
  await soft(page, () => window.__game.scene.keys.RingScene.dummy._impactPending,
    undefined, { timeout: 8000, label: 'the forced attack to arm' });

  if (slip) {
    // Aim off the dummy's own impact countdown rather than a delay: with the
    // stretched windup above there is ~1.6 s of runway, and this puts the slip
    // in the last 0.4 s of it whatever the frame rate.
    await soft(page, () => {
      const d = window.__game.scene.keys.RingScene.dummy;
      return d._impactPending && d._impactTimer < 0.40;
    }, undefined, { timeout: 12000, label: 'dummy impact imminent' });

    if (slip === 'forced') {
      await page.evaluate(() => {
        const f = window.__game.scene.keys.RingScene.fighter;
        f.slipTimer = window.__config.slipInvincibilityDuration;
        f.slipDirX  = 0;
        f.slipDirY  = 1;
      });
    } else {
      // The real input path. One frame of hold is under the widened flick bound
      // at any frame rate, and the slip fires on RELEASE.
      await page.keyboard.down('ArrowDown');
      await frames(page, 1);
      await page.keyboard.up('ArrowDown');
      // Confirm the flick actually opened a window. Without this, a missed
      // flick reports as "classification broken" rather than "the slip never
      // fired", which is what sent this section chasing the wrong bug.
      await soft(page, () => window.__game.scene.keys.RingScene.fighter.slipTimer > 0,
        undefined, { timeout: 5000, label: 'the flick to open a slip window' });

      // Undo the FOOTWORK the flick also produced, while keeping the slip it
      // opened. A flick is a movement input as well as a slip trigger, so the
      // player slides ~35 px in the direction thrown — which at 65 px takes the
      // body out of the dummy's jab reach on its own and makes the punch miss
      // for the wrong reason. That reads as "the slip wasn't classified",
      // because the un-offset re-test correctly says the punch would have
      // missed anyway. Snapping back isolates the slip's HEAD OFFSET, which is
      // the mechanism under test; velocity is zeroed too, so with no key held
      // the fighter now stays put for the rest of the windup.
      await page.evaluate(() => {
        const f = window.__game.scene.keys.RingScene.fighter;
        f.x = window.__pin.x;
        f.y = window.__pin.y;
        f.vx = f.vy = 0;
      });
    }
  }

  await soft(page, () => window.__res.length > 0, undefined,
    { timeout: 8000, label: 'the dummy jab to resolve' });
  const r = (await page.evaluate(() => window.__res.slice()))[0] ?? null;

  // Sample the attacker's exposure just past peak, on the decaying side of its
  // own curve. Progress rather than wall clock, and the same progress in both
  // runs — same punch type, same timings — so the curve term is identical and
  // the only thing that can differ is the punish floor underneath it.
  const sampled = await soft(page, () => {
    const d = window.__game.scene.keys.RingScene.dummy;
    return d.punchTimer > 0 && d.punchProgress() >= 0.6;
  }, undefined, { timeout: 8000, label: 'attacker punch progress 0.6' });
  const mid = await page.evaluate(() => {
    const d = window.__game.scene.keys.RingScene.dummy;
    return { v: d.vulnerability, p: d.punchProgress(), punish: d._punishTimer };
  });
  return { ...r, mid, sampled };
}

// 65 px: comfortably inside the dummy jab's ~85 px reach and outside the 50 px
// smother radius, so the ONLY thing that can make this miss is the slip.
const slipped  = await dummyJab({ dist: 65,  slip: 'flick' });
await gameTime(page, 1.2);   // let the punish spike expire before the next case
const farWhiff = await dummyJab({ dist: 220, slip: false });
await gameTime(page, 1.2);
// The inverted case: a slip is genuinely active, but the punch was never going
// to land anyway. This must NOT be classified as a slip — it is the "standing
// out of range earns the same reward as reading the punch" failure the
// classification exists to prevent.
const farSlip  = await dummyJab({ dist: 220, slip: 'forced' });

const fmt = r => `outcome ${r?.outcome}, slipped=${r?.slipped}, ` +
  `defender slipping=${r?.defSlipping}, attacker punish ${r?.attPunish?.toFixed?.(2)}s, ` +
  `gap ${r?.gap?.toFixed?.(0)}px, fromPlayer=${r?.fromPlayer}`;
console.log(`     close + slip : ${fmt(slipped)}`);
console.log(`     far, no slip : ${fmt(farWhiff)}`);
console.log(`     far + slip   : ${fmt(farSlip)}`);

check('a punch taken away by a slip is classified as SLIPPED',
  slipped.outcome === 'whiff' && slipped.slipped === true,
  `outcome ${slipped.outcome}, defender was slipping=${slipped.defSlipping}`);
check('a slipped punch still counts as a miss (whiff, not a new outcome)',
  slipped.outcome === 'whiff', `resolver returned '${slipped.outcome}'`);
check('a punch missing from OUT OF RANGE is NOT classified as slipped',
  farWhiff.outcome === 'whiff' && farWhiff.slipped === false,
  `outcome ${farWhiff.outcome}, slipped=${farWhiff.slipped}`);
check('an out-of-range punch is NOT slipped even while a slip is active',
  farSlip.outcome === 'whiff' && farSlip.slipped === false && farSlip.defSlipping === true,
  `defender WAS slipping at resolution, but the punch would have missed anyway`);

check('a slip opens a punish window on the ATTACKER',
  slipped.attPunish > 0, `punish timer ${slipped.attPunish?.toFixed(2)}s, ` +
  `pinned at ${slipped.attPunishV?.toFixed(2)}`);
check('an out-of-range whiff opens NO punish window',
  farWhiff.attPunish === 0, `punish timer ${farWhiff.attPunish}`);

console.log(`     attacker vulnerability just past peak: ` +
            `slipped ${slipped.mid.v.toFixed(3)} (p=${slipped.mid.p.toFixed(2)}) vs ` +
            `out-of-range ${farWhiff.mid.v.toFixed(3)} (p=${farWhiff.mid.p.toFixed(2)})`);
check('the attacker is MORE exposed after a slip than after an equivalent whiff',
  slipped.sampled && farWhiff.sampled && slipped.mid.v > farWhiff.mid.v + 0.1,
  `${slipped.mid.v.toFixed(3)} vs ${farWhiff.mid.v.toFixed(3)} at the same progress ` +
  `(${slipped.mid.p.toFixed(2)} vs ${farWhiff.mid.p.toFixed(2)})`);

// ── The failure mode worth naming on its own ────────────────────────────────
// The punish spike must OUTLIVE the attacker's stretched whiff recovery rather
// than being reset when the punch animation's own timer expires. At the shipped
// 0.70 s the spike and the stretched recovery end at roughly the same moment, so
// there is no frame where the spike alone is observable — exactly the problem
// counter_test.mjs hit with the perfect-block punish. Same fix: one extra run
// with the duration stretched purely for observability.
await gameTime(page, 1.5);
await page.evaluate(() => {
  window.__config.slipPunishDuration = 3.0;
  // Back to the shipped windup for THIS run only. The 3 s stretch the rest of
  // the section uses to give the flick runway also stretches the punch itself
  // to ~6 s once the whiff recovery is applied — longer than the 3 s spike, so
  // the spike would expire before punchTimer reaches 0 and the check would read
  // its own accommodation as a failure. This run forces the slip directly, so
  // it needs no runway.
  window.__config.dummyWindupDuration = 0.8;
});
// 'forced' rather than a flick: what this run is observing is the SPIKE's
// lifetime, and a real flick only adds an input race that has nothing to do
// with it. The flick path is what the first case above tests.
const held = await dummyJab({ dist: 65, slip: 'forced' });
const after = await soft(page, () => {
  const d = window.__game.scene.keys.RingScene.dummy;
  return d.punchTimer === 0;
}, undefined, { timeout: 8000, label: 'attacker punch to fully unwind' });
const post = await page.evaluate(() => {
  const d = window.__game.scene.keys.RingScene.dummy;
  return { v: d.vulnerability, punish: d._punishTimer, pt: d.punchTimer };
});
const punishV = await page.evaluate(() => window.__config.slipPunishVulnerability);
check('the punish spike survives the attacker\'s stretched whiff recovery',
  held.slipped && after && post.pt === 0 && post.punish > 0 &&
  Math.abs(post.v - punishV) < 0.01,
  `with the punish stretched to 3.0s for observability: at punchTimer=0 the ` +
  `attacker still reads v=${post.v.toFixed(2)} (pinned at ${punishV}) with ` +
  `${post.punish.toFixed(2)}s of spike left — the expiring punch timer does not clobber it`);
// Restore everything this section widened, so nothing here can leak into a
// later addition to the script.
await page.evaluate(() => {
  window.__config.slipPunishDuration        = 0.70;
  window.__config.dummyWindupDuration       = 0.8;
  window.__config.slipFlickMaxDurationMs    = 180;
  window.__config.slipInvincibilityDuration = 0.25;
});

await browser.close();

console.log('Page errors:', errors.length ? errors : 'none');
console.log('Screenshots saved to scripts/output/');

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

// A non-empty `errors` array is a FAILURE, not a log line. This script pushed
// page errors into it and then exited 0 regardless — so the slip system had never
// actually been checked for console errors, in any run, ever.
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.label}`));
  if (errors.length) console.error(`FAILED — ${errors.length} page error(s).`);
  process.exit(1);
}

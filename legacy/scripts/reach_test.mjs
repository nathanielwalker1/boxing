/**
 * reach_test.mjs — Stage 9 geometric hit detection.
 * Run with: node scripts/reach_test.mjs   (dev server must be running)
 *
 * Covers the behavior change that punch_test.mjs can't: landing is no longer a
 * distance band, it's "did the fist overlap a hurtbox on the frame it reached
 * full extension". The two things that follow from that, and that this file
 * exists to pin down:
 *
 *   1. REACH IS PER-PUNCH. It falls out of the rig trajectories rather than
 *      being declared, so each punch/hand combination has its own edge. The
 *      table below is MEASURED against the live resolver (binary search), and
 *      is the source of the numbers quoted in config.js.
 *   2. RESOLUTION IS AT IMPACT, NOT AT PRESS. Distance at the moment the button
 *      goes down no longer decides anything, so a punch thrown from beyond the
 *      old 100 px Range Max can land if the gap closes during the windup, and
 *      one thrown well inside it can miss if the target isn't there any more.
 *
 * OLD_RANGE_MAX is the retired config.rangeMax, kept here as a literal so the
 * before/after cases stay anchored to what the old rule would have said.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime, punchIdle, resolved, soft } from './waits.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const OLD_RANGE_MAX = 100;

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await bootReady(page);

await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  // Silence the dummy's own offence/defence — this file is about the player's
  // punches reaching (or not), nothing else.
  window.__config.dummyAttackDelayMin      = 999;
  window.__config.dummyAttackDelayMax      = 999;
  window.__config.dummyBlockReactionChance = 0;
  window.__config.healthDamagePerForce     = 0;   // no knockdowns mid-suite
  sc.dummy.attackTimer = 999;

  window.__out = [];
  const orig = sc._resolveAttack.bind(sc);
  sc._resolveAttack = (attacker, defender, arm, punchType) => {
    const outcome = orig(attacker, defender, arm, punchType);
    window.__out.push({
      outcome, arm, punchType,
      byPlayer: attacker === sc.fighter,
      dist: +Math.hypot(defender.x - attacker.x, defender.y - attacker.y).toFixed(1),
    });
    return outcome;
  };
});

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name.padEnd(46)} ${detail}`);
}

/**
 * Place the fighters and throw one punch through the scene's real entry point.
 *
 * Two things this has to get right, both of which silently corrupt results:
 *  - The pair is placed SYMMETRICALLY about the ring center. Placing them from
 *    a fixed origin instead runs the far one into the rope clamp, which pins it
 *    at a constant x and makes every requested distance come out the same.
 *  - Hand selection is set by writing _lastInputX rather than holding a key,
 *    because holding a direction also drags the player several px during the
 *    windup, which would contaminate the reach measurements.
 *
 * @param {object} o
 * @param {string} o.type            punch type
 * @param {number} o.dx              player→dummy separation along x
 * @param {number} [o.dy]            separation along y instead (dummy above)
 * @param {number} [o.inputX]        -1 picks the left hand for hook/uppercut
 * @param {number} [o.playerVx]      player velocity at the press
 * @param {number} [o.dummyVx]       dummy locomotion velocity at the press
 * @param {boolean} [o.pinDummy]     freeze the dummy's steering (default true)
 * @param {string} [o.holdKey]       arrow key held across the whole throw, so
 *                                   the velocity above is sustained rather than
 *                                   decaying through friction mid-windup
 * @param {number} [o.teleportDx]    jump the dummy to this separation one frame
 *                                   after the press
 * @param {number} [o.teleportDy]    same, vertically — used to simulate a
 *                                   separation shove landing mid-punch
 * @param {boolean} [o.mirror]       put the player on the RIGHT instead, so the
 *                                   identical geometry is thrown facing left
 * @param {number} [o.settleMs]      how long to wait for the impact
 */
async function fire(o) {
  const opts = { dy: 0, inputX: 1, playerVx: 0, dummyVx: 0, pinDummy: true, settleMs: 250, mirror: false, ...o };

  const setup = () => page.evaluate(p => {
    const sc = window.__game.scene.keys.RingScene;
    window.__config.dummyMoveSpeed = p.pinDummy ? 0 : 170;
    const b  = sc._getRingBounds();
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
    // Mirroring flips only the horizontal placement: the vertical offset is
    // deliberately left alone, so the two facings are handed geometry that is
    // identical in the fighter's own local frame and must produce identical
    // results. (y is never mirrored by the rig either — that asymmetry is
    // exactly where a facing sign error would show up.)
    const s  = p.mirror ? -1 : 1;
    // Split the gap either side of center so neither fighter hits a rope.
    sc.fighter.x = cx - s * p.dx / 2; sc.fighter.y = cy - p.dy / 2;
    sc.fighter.vx = p.playerVx;   sc.fighter.vy = 0;
    sc.fighter.health  = window.__config.healthMax;
    sc.fighter.stamina = window.__config.staminaMax;
    sc.dummy._loco.x  = cx + s * p.dx / 2; sc.dummy._loco.y = cy + p.dy / 2;
    sc.dummy._loco.vx = p.dummyVx;     sc.dummy._loco.vy = 0;
    sc.dummy.x = sc.dummy._loco.x;     sc.dummy.y = sc.dummy._loco.y;
    sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.dummy.health  = window.__config.healthMax;
    sc.dummy.stamina = window.__config.staminaMax;
    window.__out.length = 0;
  }, opts);

  await setup();
  if (opts.holdKey) await page.keyboard.down(opts.holdKey);
  // Long enough to reach top speed — in GAME time, so a loaded page doesn't
  // press the punch before the fighter has accelerated.
  await gameTime(page, opts.holdKey ? 0.26 : 0.06);

  // Re-assert the geometry on the press frame — the settle above will have
  // moved the player if a key is held, and bled velocity off if one isn't.
  await setup();
  await page.evaluate(p => {
    const sc = window.__game.scene.keys.RingScene;
    sc._lastInputX = p.inputX;
    window.__out.length = 0;
    sc._resolvePunch(p.type);
  }, opts);

  // The aim angle the punch locked in, read back on the press frame — the
  // Stage 13 cases assert on this directly rather than inferring it from where
  // the fist ended up.
  const aim = await page.evaluate(() => {
    const sc = window.__game.scene.keys.RingScene;
    return { deg: +(sc.fighter.punchAim * 180 / Math.PI).toFixed(2), raw: sc.fighter.punchAim };
  });

  if (opts.teleportDx !== undefined || opts.teleportDy !== undefined) {
    // Done IN THE PAGE, gated on the punch's own progress, because "mid-windup"
    // is a position on the punch timeline and nothing else. Driving it from
    // Node meant the shove landed wherever two Playwright round trips plus a
    // 40 ms sleep happened to put it — and once punchDuration is stretched to
    // 0.6 s for these cases, that could be either side of peak extension. Past
    // peak the punch has already resolved against the OLD position and lands,
    // which is precisely the outcome the case exists to rule out.
    await page.evaluate(async p => {
      const sc = window.__game.scene.keys.RingScene;
      const f  = sc.fighter;
      const step = () => new Promise(r => requestAnimationFrame(r));
      const total = f._punchDuration || window.__config.punchDuration;
      // 20% in: after the aim has locked at the press, comfortably before the
      // earliest peak (jab peaks at 0.42).
      while (f.punchTimer > 0 && 1 - f.punchTimer / total < 0.2) await step();
      if (p.teleportDx !== undefined) sc.dummy._loco.x = f.x + p.teleportDx;
      if (p.teleportDy !== undefined) sc.dummy._loco.y = f.y + p.teleportDy;
      sc.dummy.x = sc.dummy._loco.x;
      sc.dummy.y = sc.dummy._loco.y;
    }, opts);
  }

  // Wait for the punch to RESOLVE, not for a hand-tuned settle budget. This is
  // the fix for 'shrinking hurtboxes turns a landed jab into a whiff' failing
  // under CPU load: a whiff still records an outcome, but only once peak
  // extension is reached, and 250 ms of wall clock stopped containing that once
  // the suite began running scripts in parallel. The case then read back an
  // empty array and reported outcome 'none', which is not 'whiff'.
  await resolved(page, '__out', 1, { timeout: Math.max(6000, opts.settleMs * 8) });
  if (opts.holdKey) await page.keyboard.up(opts.holdKey);
  const got = await page.evaluate(() => window.__out.splice(0));
  // Let the punch fully unwind before the next case. This has to be the real
  // condition, not a fixed budget: several sections raise punchDuration to
  // 0.6 s, and a 200 ms unwind left the previous punch still in flight — its
  // late resolution then landed in __out and the NEXT case read it as its own.
  await punchIdle(page);
  return { aim, ...(got.find(g => g.byPlayer) ?? { outcome: 'none' }) };
}

// Smother is a separate proximity rule that would mask geometry at close range;
// switch it off for the pure-reach sweep and restore it afterwards.
const setSmother = v => page.evaluate(x => { window.__config.smotherDist = x; }, v);

// ── 1. Measured reach envelope ──────────────────────────────────────────────
console.log('\n1. Reach envelope (binary search against the live resolver)\n');
await setSmother(0);

async function maxReach(type, inputX) {
  let lo = 10, hi = 170;
  while (hi - lo > 1) {
    const mid = Math.round((lo + hi) / 2);
    const r = await fire({ type, dx: mid, inputX });
    if (r.outcome === 'land') lo = mid; else hi = mid;
  }
  return lo;
}

const COMBOS = [
  { label: 'jab (lead)',        type: 'jab',      inputX:  1 },
  { label: 'cross (rear)',      type: 'cross',    inputX:  1 },
  { label: 'hook left (lead)',  type: 'hook',     inputX: -1 },
  { label: 'hook right (rear)', type: 'hook',     inputX:  1 },
  { label: 'uppercut left',     type: 'uppercut', inputX: -1 },
  { label: 'uppercut right',    type: 'uppercut', inputX:  1 },
];

const reach = {};
for (const c of COMBOS) {
  reach[c.label] = await maxReach(c.type, c.inputX);
  console.log(`     ${c.label.padEnd(20)} lands out to ${reach[c.label]} px`);
}

const values = COMBOS.map(c => reach[c.label]);
// The whole point of driving reach off the rig: the four punches must NOT all
// stop at the same distance the way a shared range band made them.
check('punch types have distinct reach', new Set(values).size >= 4,
  `${Math.min(...values)}–${Math.max(...values)} px across ${new Set(values).size} distinct edges`);
check('every punch reaches less than the old flat band',
  Math.max(...values) < OLD_RANGE_MAX,
  `longest reach ${Math.max(...values)} px vs old Range Max ${OLD_RANGE_MAX}`);

// A punch-type differential the old band could not express: at one fixed
// distance, a long punch connects and a short one does not.
const DIFF = 80;
const jabAt80  = await fire({ type: 'jab',      dx: DIFF, inputX:  1 });
const uppAt80  = await fire({ type: 'uppercut', dx: DIFF, inputX:  1 });
check('same distance, different punch, different result',
  jabAt80.outcome === 'land' && uppAt80.outcome === 'whiff',
  `at ${DIFF} px: jab=${jabAt80.outcome}, rear uppercut=${uppAt80.outcome}`);

await setSmother(50);

// ── 2. Geometry beats raw distance ──────────────────────────────────────────
console.log('\n2. Aim vs. distance (old rule: anything ≤ 100 px lands)\n');

// Dummy directly ABOVE the player at a distance the old band called a clean
// land. The fist travels horizontally at head height; there is nothing there.
const OFFAXIS = 70;
const offAxis = await fire({ type: 'jab', dx: 0, dy: -OFFAXIS });
check('inside old Range Max but off-axis → whiff',
  offAxis.outcome === 'whiff',
  `dummy ${OFFAXIS} px straight up, dist ${offAxis.dist} ≤ ${OLD_RANGE_MAX} → ${offAxis.outcome}`);

// Same distance, on-axis: lands. Isolates aim as the only variable.
const onAxis = await fire({ type: 'jab', dx: OFFAXIS, dy: 0 });
check('same distance, on-axis → lands',
  onAxis.outcome === 'land',
  `dummy ${OFFAXIS} px in front, dist ${onAxis.dist} → ${onAxis.outcome}`);

// ── 3. Resolution happens at impact, not at the press ───────────────────────
console.log('\n3. Impact-frame resolution (old rule: press-frame distance)\n');

// Thrown from BEYOND the old Range Max, with both fighters closing. The press
// distance would have been an automatic whiff under the old rule; the fist
// arrives after the gap has closed, so it connects. The key is held throughout
// so the approach is still happening at the impact frame — friction would
// otherwise eat most of an injected velocity within two frames.
const CLOSE_FROM = OLD_RANGE_MAX + 5;
const closing = await fire({
  type: 'cross', dx: CLOSE_FROM, playerVx: 200, dummyVx: -170,
  pinDummy: false, holdKey: 'ArrowRight',
});
check('outside old Range Max, closing → lands',
  closing.outcome === 'land',
  `pressed at ${CLOSE_FROM} px, impact at ${closing.dist} px → ${closing.outcome}`);

// The mirror: pressed INSIDE the old band while backing out, so the fist
// arrives short. Old rule: guaranteed land.
const RETREAT_FROM = 85;
const retreating = await fire({
  type: 'jab', dx: RETREAT_FROM, playerVx: -200, holdKey: 'ArrowLeft',
});
check('inside old Range Max, retreating → whiffs',
  retreating.outcome === 'whiff',
  `pressed at ${RETREAT_FROM} px, impact at ${retreating.dist} px → ${retreating.outcome}`);

// Strongest form: the target is nowhere near the fist at press time and moves
// into range mid-windup. Only a live position lookup can land this. The punch
// is slowed right down so the teleport lands comfortably inside the window.
await page.evaluate(() => { window.__config.punchDuration = 0.6; });
const movedIn = await fire({ type: 'jab', dx: 220, teleportDx: 70, settleMs: 500 });
check('target moves INTO range mid-windup → lands',
  movedIn.outcome === 'land',
  `pressed at 220 px, impact at ${movedIn.dist} px → ${movedIn.outcome}`);

const movedOut = await fire({ type: 'jab', dx: 70, teleportDx: 220, settleMs: 500 });
check('target moves OUT of range mid-windup → whiffs',
  movedOut.outcome === 'whiff',
  `pressed at 70 px, impact at ${movedOut.dist} px → ${movedOut.outcome}`);
await page.evaluate(() => { window.__config.punchDuration = 0.15; });

// ── 4. Hurtbox sliders are live ─────────────────────────────────────────────
console.log('\n4. Hurtboxes are tunable at runtime\n');

// Same shot as the DIFF case above, which lands at default sizes — the only
// thing changed is the slider values, so this proves the sliders actually feed
// the resolver rather than only the debug overlay.
const restore = await page.evaluate(() => {
  const c = window.__config;
  const before = { headHurtboxRadius: c.headHurtboxRadius, bodyHurtboxWidth: c.bodyHurtboxWidth,
                   bodyHurtboxHeight: c.bodyHurtboxHeight, fistRadius: c.fistRadius };
  Object.assign(c, { headHurtboxRadius: 4, bodyHurtboxWidth: 10, bodyHurtboxHeight: 10, fistRadius: 2 });
  return before;
});
const shrunk = await fire({ type: 'jab', dx: DIFF, inputX: 1 });
await page.evaluate(b => Object.assign(window.__config, b), restore);
check('shrinking hurtboxes turns a landed jab into a whiff',
  shrunk.outcome === 'whiff',
  `jab at ${DIFF} px: default=${jabAt80.outcome}, tiny hurtboxes=${shrunk.outcome}`);

await page.evaluate(() => { window.__config.showHurtboxes = true; });
await gameTime(page, 0.3);
await page.screenshot({ path: 'scripts/output/reach_hurtboxes.png' });
await page.evaluate(() => { window.__config.showHurtboxes = false; });

// ── 5. Aim cone (Stage 13) ──────────────────────────────────────────────────
// The rig has no anatomical rotation, so before this stage every punch travelled
// along one fixed rig-local trajectory and sailed past a target that was merely
// a bit above or below. The cone bends the throwing arm about its own shoulder
// by an angle sampled once, on the input frame, and then locked.
//
// The reference for "would this have whiffed before?" is maxAimAngle = 0, fired
// through the same live resolver — not a remembered number, so these cases stay
// honest if the rig or the hurtboxes move.
console.log('\n5. Aim cone — bending toward an off-axis target\n');

const setAim = v => page.evaluate(x => { window.__config.maxAimAngle = x; }, v);
const DEFAULT_AIM = await page.evaluate(() => window.__config.maxAimAngle);

/** Same shot with the cone off, then on. */
async function coneOffOn(o) {
  await setAim(0);
  const off = await fire(o);
  await setAim(DEFAULT_AIM);
  const on  = await fire(o);
  return { off, on };
}

// ── 5a. Incidental vertical offset stops causing whiffs ─────────────────────
// Moderately above and below, at several horizontal distances. These are the
// offsets that show up just from circling, which is the whole reason the cone
// exists.
// NOTE on the ABOVE cases: the pre-cone rig was not symmetric about the fist's
// travel height. The fist crosses at roughly head height (y ~ -44 rig-local),
// and the defender's body hurtbox is a tall box reaching up to -42, so a target
// somewhat ABOVE already got caught by its body while an equally-offset target
// BELOW was a clean miss. The offsets below are therefore deliberately larger
// on the up side — that is where the old geometry stopped reaching, not an
// arbitrary choice.
// These offsets are calibrated to the SHIPPED cap (see config.maxAimAngle) —
// they sit in the band the cone rescues at that setting, and widening or
// narrowing the cap is expected to move them.
const OFFSETS = [
  { type: 'jab',      dx: 50, dy:  35, inputX:  1 },
  { type: 'jab',      dx: 60, dy: -60, inputX:  1 },
  { type: 'cross',    dx: 70, dy:  35, inputX:  1 },
  { type: 'cross',    dx: 60, dy: -60, inputX:  1 },
  { type: 'hook',     dx: 50, dy:  35, inputX:  1 },
  { type: 'uppercut', dx: 50, dy:  30, inputX: -1 },
];
let rescued = 0, regressed = 0;
for (const o of OFFSETS) {
  const { off, on } = await coneOffOn(o);
  if (off.outcome === 'whiff' && on.outcome === 'land') rescued++;
  if (off.outcome === 'land'  && on.outcome !== 'land') regressed++;
  console.log(`     ${o.type.padEnd(9)} dx=${String(o.dx).padStart(3)} dy=${String(o.dy).padStart(4)}  ` +
              `cone off → ${off.outcome.padEnd(6)}  cone on → ${on.outcome.padEnd(6)} (bend ${on.aim.deg}deg)`);
}
check('off-axis shots that used to whiff now land', rescued === OFFSETS.length && regressed === 0,
  `${rescued}/${OFFSETS.length} rescued, ${regressed} regressed`);

// ── 5b. Beyond the cap, the punch still falls short ─────────────────────────
// Chosen so DISTANCE is not the binding constraint — 78 px is inside the jab's
// straight-on reach. The only reason it misses is that the target is ~50 deg
// off the facing axis and the cone stops at 30. Proven by re-firing the exact
// same shot with the cap opened right up, which lands: a real height advantage
// someone earned by outmaneuvering you is not erased.
const STEEP = { type: 'jab', dx: 50, dy: 60, inputX: 1 };
const steepCapped = await fire(STEEP);
await setAim(90);
const steepOpen = await fire(STEEP);
await setAim(DEFAULT_AIM);
check('target beyond the cone still whiffs', steepCapped.outcome === 'whiff',
  `50/60 px (dist ${steepCapped.dist}, needs ~50deg) at cap ${DEFAULT_AIM}deg → ${steepCapped.outcome} (bend ${steepCapped.aim.deg}deg)`);
check('...and it is the CLAMP that stopped it, not distance', steepOpen.outcome === 'land',
  `same shot with the cap at 90deg → ${steepOpen.outcome} (bend ${steepOpen.aim.deg}deg)`);

// ── 5c. Reach is preserved along the bent path ──────────────────────────────
// The silent regression this stage could have shipped: if reach were measured
// horizontally, bending would shorten it (~13% at 30deg) and a punch that lands
// at max range straight-on would start whiffing once bent.
//
// The exact invariant first — the bend is a rigid rotation of the arm chain
// about the shoulder, so the wrist's distance FROM that shoulder cannot change.
// Asserted to floating-point equality, so a future change that rotates the
// trajectory some other way fails here rather than silently costing reach.
const extension = await page.evaluate(() => {
  const { computePose, peakProgress, punchGeometry } = window.__rig;
  const combos = [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead'],
                  ['hook', 'rear'], ['uppercut', 'lead'], ['uppercut', 'rear']];
  return combos.map(([type, slot]) => {
    const base = punchGeometry(type, slot).reach;
    const worst = Math.max(...[-0.6, -0.35, -0.1, 0, 0.1, 0.35, 0.6].map(aim => {
      const pose = computePose({ type, arm: slot, p: peakProgress(type), aim }, 0, 0);
      const h = slot === 'lead' ? pose.lead : pose.rear;
      return Math.abs(Math.hypot(h.wx - h.sx, h.wy - h.sy) - base);
    }));
    return { k: `${type}:${slot}`, base: +base.toFixed(3), worst };
  });
});
check('extension is identical at every bend angle',
  extension.every(e => e.worst < 1e-9),
  `max drift ${Math.max(...extension.map(e => e.worst)).toExponential(1)} px across 6 punches x 7 angles`);

// And the behavioural form of the same claim, through the live resolver: a
// punch fired at (near) its straight-on maximum range still lands when that
// same distance is taken up at an angle inside the cone.
async function maxReachAt(type, inputX, deg) {
  const r = deg * Math.PI / 180;
  let lo = 10, hi = 170;
  while (hi - lo > 1) {
    const mid = Math.round((lo + hi) / 2);
    const res = await fire({ type, dx: Math.round(mid * Math.cos(r)), dy: Math.round(mid * Math.sin(r)), inputX });
    if (res.outcome === 'land') lo = mid; else hi = mid;
  }
  return lo;
}
await setSmother(0);
// Measured at the cone's own edge, so this stays meaningful if the cap is
// re-tuned rather than silently testing an angle the cone no longer reaches.
const RAY = DEFAULT_AIM;
const BENT_TOL = 0.10;   // fraction of straight-on reach a bent punch may lose
let bentOk = true;
for (const c of [{ type: 'jab', inputX: 1 }, { type: 'hook', inputX: -1 }, { type: 'uppercut', inputX: -1 }]) {
  const straight = await maxReachAt(c.type, c.inputX, 0);
  const down     = await maxReachAt(c.type, c.inputX,  RAY);
  const up       = await maxReachAt(c.type, c.inputX, -RAY);
  const loss     = (straight - Math.min(down, up)) / straight;
  if (loss > BENT_TOL) bentOk = false;
  console.log(`     ${c.type.padEnd(9)} max reach: straight ${straight} px, +${RAY}deg ${down} px, -${RAY}deg ${up} px  (loss ${(loss * 100).toFixed(1)}%)`);
}
check('max range holds up when bent', bentOk,
  `every punch keeps >=${((1 - BENT_TOL) * 100).toFixed(0)}% of its straight-on reach at +/-${RAY}deg`);

// The literal case: fire at 95% of the measured straight-on maximum, but with
// that distance taken up on a 20deg ray. Both must land.
const jabStraightMax = await maxReachAt('jab', 1, 0);
const R  = Math.round(jabStraightMax * 0.95);
const at0   = await fire({ type: 'jab', dx: R, dy: 0, inputX: 1 });
const atRay = await fire({ type: 'jab', dx: Math.round(R * Math.cos(RAY * Math.PI / 180)),
                           dy: Math.round(R * Math.sin(RAY * Math.PI / 180)), inputX: 1 });
check('max-range straight AND max-range bent both land',
  at0.outcome === 'land' && atRay.outcome === 'land',
  `at ${R} px: straight=${at0.outcome}, ${RAY}deg bent=${atRay.outcome} (bend ${atRay.aim.deg}deg)`);
await setSmother(50);

// ── 5d. Smother still fires at max bend ─────────────────────────────────────
// Smother is a proximity rule, deliberately upstream of the geometry, so the
// cone must not be able to sneak a straight punch through it at an angle.
// Same close, steeply-offset geometry for both, so the punch type is the only
// variable: the jab is smothered, the hook — which the locked spec exempts —
// still gets to land, and the cone changes neither.
// Inside smotherDist (50) but outside fighterSeparationDist (38), so the pair
// is not being actively shoved apart while the punch resolves.
const CLOSE = { dx: 40, dy: 20 };
const smotherBent = await fire({ type: 'jab',  ...CLOSE, inputX:  1 });
const hookBent    = await fire({ type: 'hook', ...CLOSE, inputX: -1 });
const smotherDist = await page.evaluate(() => window.__config.smotherDist);
check('smother still triggers at full bend', smotherBent.outcome === 'smother',
  `jab at dist ${smotherBent.dist} (< ${smotherDist}), bend ${smotherBent.aim.deg}deg → ${smotherBent.outcome}`);
check('...and hook is still exempt from it at full bend', hookBent.outcome === 'land',
  `hook at the same dist ${hookBent.dist}, bend ${hookBent.aim.deg}deg → ${hookBent.outcome}`);

// ── 5e. Both facings, identical local geometry ──────────────────────────────
// The classic bug in a cone measured off a mirrored facing axis: it works one
// way round and inverts the other. The cone is measured in rig-local space, in
// which x is mirrored and y never is, so the SAME local geometry must produce
// the same bend and the same outcome from either side of the ring.
let mirrorOk = true;
for (const o of [
  { type: 'jab',      dx: 65, dy:  35, inputX:  1 },
  { type: 'jab',      dx: 65, dy: -35, inputX:  1 },
  { type: 'cross',    dx: 70, dy:  40, inputX:  1 },
  { type: 'uppercut', dx: 45, dy: -30, inputX: -1 },
]) {
  const right = await fire({ ...o, mirror: false });
  const left  = await fire({ ...o, mirror: true  });
  const same  = right.outcome === left.outcome && Math.abs(right.aim.deg - left.aim.deg) < 0.5;
  if (!same) mirrorOk = false;
  console.log(`     ${o.type.padEnd(9)} dx=${o.dx} dy=${String(o.dy).padStart(4)}  ` +
              `facing right: ${right.outcome} @${right.aim.deg}deg   facing left: ${left.outcome} @${left.aim.deg}deg`);
}
check('both facings bend identically', mirrorOk,
  'same local geometry → same bend and same outcome from either side');

// ── 5f. The angle is LOCKED, not tracked ────────────────────────────────────
// The single most important property of this stage, asserted directly so a
// future change cannot quietly turn tracking back on: a punch that keeps
// re-aiming is a homing missile, it contradicts the momentum-commitment
// philosophy, and it would make the slip/duck stage cosmetic.
await page.evaluate(() => { window.__config.punchDuration = 0.6; });
const locked = await page.evaluate(async () => {
  const sc = window.__game.scene.keys.RingScene;
  const b  = sc._getRingBounds();
  const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
  sc.fighter.x = cx - 35; sc.fighter.y = cy; sc.fighter.vx = sc.fighter.vy = 0;
  sc.dummy._loco.x = cx + 35; sc.dummy._loco.y = cy;
  sc.dummy.x = sc.dummy._loco.x; sc.dummy.y = sc.dummy._loco.y;
  // Frames, not wall clock — the setup only needs the sim to observe the new
  // positions, and one slow frame can exceed an 80 ms sleep entirely.
  for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r));

  sc._lastInputX = 1;
  sc._resolvePunch('jab');
  const samples = [];
  // Drag the target hard up and down through the whole punch. Anything that
  // re-sampled the angle would move; a locked one cannot.
  for (let i = 0; i < 18; i++) {
    sc.dummy._loco.y = cy + (i % 2 ? 70 : -70);
    sc.dummy.y = sc.dummy._loco.y;
    await new Promise(r => requestAnimationFrame(r));
    if (sc.fighter.punchArm) samples.push(sc.fighter.punchAim);
  }
  return samples;
});
check('aim angle never changes across the punch',
  locked.length >= 5 && locked.every(v => v === locked[0]),
  `${locked.length} in-flight samples, all ${(locked[0] * 180 / Math.PI).toFixed(2)}deg`);

// A shove landing mid-punch therefore makes it MISS — which reads as impact and
// timing, not as a bug. The control underneath is the same offset present at
// the press, which lands: the difference is purely when the target moved.
const shoved  = await fire({ type: 'jab', dx: 60, dy: 0,  teleportDy: 35, settleMs: 700 });
const present = await fire({ type: 'jab', dx: 60, dy: 35,                 settleMs: 700 });
await page.evaluate(() => { window.__config.punchDuration = 0.15; });
check('target shoved mid-punch → miss, no re-aim',
  shoved.outcome === 'whiff' && present.outcome === 'land',
  `shoved after the press → ${shoved.outcome} (bend ${shoved.aim.deg}deg); same offset at the press → ${present.outcome} (bend ${present.aim.deg}deg)`);

// ── 5g. Degenerate geometry ─────────────────────────────────────────────────
// Target directly above/below (no horizontal run at all), behind the shoulder,
// stacked inside the separation slack, and exactly on the cone boundary. None
// may produce NaN, a flipped punch, or a snap past the cap.
const degenerate = await page.evaluate(() => {
  const { aimAngle, maxAimAngleRad } = window.__rig;
  const max = maxAimAngleRad() + 1e-9;
  const cases = {
    'directly below':      aimAngle('jab', 'lead', 0, 90),
    'directly above':      aimAngle('jab', 'lead', 0, -90),
    'exactly stacked':     aimAngle('jab', 'lead', 0, 0),
    'behind the shoulder': aimAngle('jab', 'lead', -60, 40),
    'inside separation':   aimAngle('hook', 'rear', 4, 6),
    'far beyond the cone': aimAngle('cross', 'rear', 30, 400),
    'unknown punch type':  aimAngle('bolo', 'lead', 70, 30),
    'NaN input':           aimAngle('jab', 'lead', NaN, 30),
    'Infinity input':      aimAngle('jab', 'lead', 70, Infinity),
  };
  const bad = Object.entries(cases)
    .filter(([, v]) => !Number.isFinite(v) || Math.abs(v) > max)
    .map(([k, v]) => `${k}=${v}`);
  // The boundary itself must clamp to exactly the cap, never overshoot it.
  const boundary = aimAngle('jab', 'lead', 60, 1e6);
  return { bad, boundary, max, cases };
});
check('degenerate geometry stays finite and inside the cone',
  degenerate.bad.length === 0,
  degenerate.bad.length ? degenerate.bad.join(', ') : '9 cases: all finite, none past the cap');
check('the cone boundary clamps exactly',
  Math.abs(degenerate.boundary - degenerate.max) < 1e-6,
  `extreme offset → ${(degenerate.boundary * 180 / Math.PI).toFixed(4)}deg, cap ${(degenerate.max * 180 / Math.PI).toFixed(4)}deg`);

// A degenerate case fired through the LIVE game, not just the solve — an
// overlapping pair, where the separation system is actively pushing.
const stacked = await fire({ type: 'hook', dx: 2, dy: 4, inputX: -1 });
const finite  = await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  return [sc.fighter.x, sc.fighter.y, sc.fighter.punchAim, sc.dummy.x, sc.dummy.y].every(Number.isFinite);
});
check('overlapping fighters produce no NaN', finite,
  `stacked pair, hook thrown → ${stacked.outcome}, all positions/aim finite`);

// ── 5h. Screenshots — is a bent arm actually readable? ──────────────────────
console.log('\n6. Aim-cone screenshots\n');
await page.evaluate(() => {
  window.__config.showAimCone  = true;
  window.__config.showHurtboxes = true;
  window.__config.punchDuration = 1.2;   // hold near peak long enough to capture
});
const SHOTS = [
  { name: 'jab_below',        type: 'jab',      dx: 60, dy:  40, inputX:  1 },
  { name: 'cross_above',      type: 'cross',    dx: 70, dy: -50, inputX:  1 },
  { name: 'hook_below',       type: 'hook',     dx: 55, dy:  40, inputX: -1 },
  { name: 'uppercut_above',   type: 'uppercut', dx: 45, dy: -35, inputX: -1 },
  { name: 'cone_boundary',    type: 'jab',      dx: 45, dy:  70, inputX:  1 },
];
for (const s of SHOTS) {
  await page.evaluate(p => {
    const sc = window.__game.scene.keys.RingScene;
    const b  = sc._getRingBounds();
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
    sc.fighter.x = cx - p.dx / 2; sc.fighter.y = cy - p.dy / 2;
    sc.fighter.vx = sc.fighter.vy = 0;
    sc.dummy._loco.x = cx + p.dx / 2; sc.dummy._loco.y = cy + p.dy / 2;
    sc.dummy.x = sc.dummy._loco.x; sc.dummy.y = sc.dummy._loco.y;
  }, s);
  await gameTime(page, 0.12);
  await page.evaluate(p => {
    const sc = window.__game.scene.keys.RingScene;
    sc._lastInputX = p.inputX;
    sc._resolvePunch(p.type);
  }, s);
  // peakAt is 0.42-0.62 of the duration depending on the punch; land in that band.
  await gameTime(page, 0.62);
  await page.screenshot({ path: `scripts/output/aim_${s.name}.png` });
  console.log(`     scripts/output/aim_${s.name}.png`);
  await gameTime(page, 0.7);
}
await page.evaluate(() => {
  window.__config.showAimCone   = false;
  window.__config.showHurtboxes = false;
  window.__config.punchDuration = 0.15;
});

await browser.close();

const failed = results.filter(r => !r.pass);
console.log('\nPage errors:', errors.length ? errors : 'none');
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.name}`));
  process.exit(1);
}

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
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const OLD_RANGE_MAX = 100;

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200);

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
 * @param {number} [o.settleMs]      how long to wait for the impact
 */
async function fire(o) {
  const opts = { dy: 0, inputX: 1, playerVx: 0, dummyVx: 0, pinDummy: true, settleMs: 250, ...o };

  const setup = () => page.evaluate(p => {
    const sc = window.__game.scene.keys.RingScene;
    window.__config.dummyMoveSpeed = p.pinDummy ? 0 : 170;
    const b  = sc._getRingBounds();
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
    // Split the gap either side of center so neither fighter hits a rope.
    sc.fighter.x = cx - p.dx / 2; sc.fighter.y = cy - p.dy / 2;
    sc.fighter.vx = p.playerVx;   sc.fighter.vy = 0;
    sc.fighter.health  = window.__config.healthMax;
    sc.fighter.stamina = window.__config.staminaMax;
    sc.dummy._loco.x  = cx + p.dx / 2; sc.dummy._loco.y = cy + p.dy / 2;
    sc.dummy._loco.vx = p.dummyVx;     sc.dummy._loco.vy = 0;
    sc.dummy.x = sc.dummy._loco.x;     sc.dummy.y = sc.dummy._loco.y;
    sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.dummy.health  = window.__config.healthMax;
    sc.dummy.stamina = window.__config.staminaMax;
    window.__out.length = 0;
  }, opts);

  await setup();
  if (opts.holdKey) await page.keyboard.down(opts.holdKey);
  await page.waitForTimeout(opts.holdKey ? 260 : 60);   // long enough to reach top speed

  // Re-assert the geometry on the press frame — the settle above will have
  // moved the player if a key is held, and bled velocity off if one isn't.
  await setup();
  await page.evaluate(p => {
    const sc = window.__game.scene.keys.RingScene;
    sc._lastInputX = p.inputX;
    window.__out.length = 0;
    sc._resolvePunch(p.type);
  }, opts);

  if (opts.teleportDx !== undefined) {
    await page.waitForTimeout(40);
    await page.evaluate(p => {
      const sc = window.__game.scene.keys.RingScene;
      sc.dummy._loco.x = sc.fighter.x + p.teleportDx;
      sc.dummy.x = sc.dummy._loco.x;
    }, opts);
  }

  await page.waitForTimeout(opts.settleMs);
  if (opts.holdKey) await page.keyboard.up(opts.holdKey);
  const got = await page.evaluate(() => window.__out.splice(0));
  await page.waitForTimeout(200);   // let the animation unwind before the next case
  return got.find(g => g.byPlayer) ?? { outcome: 'none' };
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
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/reach_hurtboxes.png' });
await page.evaluate(() => { window.__config.showHurtboxes = false; });

await browser.close();

const failed = results.filter(r => !r.pass);
console.log('\nPage errors:', errors.length ? errors : 'none');
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.name}`));
  process.exit(1);
}

/**
 * slip_test.mjs — flick-vs-hold detection, the slip window, and the slipped-vs-
 * out-of-range whiff classification (port of legacy slip_test sections a–d,
 * minus the punish window, which waits for vulnerability/counter).
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, frameOf, worldToLocal } = core;
// jabHealthFloor 0 (overhaul 2026-11-11): one case here uses a jab as its knockdown blow; by default a jab can no longer empty the bar (attrition_test pins that).
// ratingsOn / stylesOn off (overhaul phase 2): this file pins the reference fighters' numbers and margins as they were before
// ratings and guard shapes did anything — both un-rated, both in the high guard. ratings_test / styles_test cover those.
const cfg = { ...({ ...createConfig(), ratingsOn: false, stylesOn: false }), jabHealthFloor: 0 };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;
const T = s => Math.round(s / SIM_DT);   // seconds → ticks

function fresh(dist = MID, sp = specs, c = cfg) {
  let s = sim.createState(sp, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
function run(s, n, inputs, onTick, c = cfg) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, inputs(i), c);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (onTick) onTick(s, i, r.events);
  }
  return { s, evs };
}
/** side 0 pushes the stick for `ticks` ticks from tick 0, then lets go. */
const push = (ticks, x, y = 0) => i => [inp({ move: { x: i < ticks ? x : 0, y: i < ticks ? y : 0 } }), NONE];
const slips = evs => evs.filter(e => e.type === 'slip' && !e.dodged);
const headLat = f => worldToLocal(f.pos, frameOf(f.yaw), f.headBox).lateral;

const FLICK = 5;                       // 0.083 s, well inside slipFlickMax (0.18)
const HOLD = T(cfg.slipFlickMax) + 4;  // past the flick window

// ── 1. A flick slips; the head, not the feet, is what moves ─────────────────
{
  const trace = [];
  const { s, evs } = run(fresh(), 60, push(FLICK, 1), (st, i) => trace.push({ i, f: st.fighters[0], lat: headLat(st.fighters[0]) }));
  const ev = slips(evs);
  check('a short lateral push fires exactly one slip event, on the release tick', ev.length === 1 && ev[0].tick === FLICK && ev[0].side === 0, `${ev.length} events, tick ${ev[0]?.tick}`);
  check('orthodox, stick right → dir +1 (toward the rear side)', ev[0]?.dir === 1, `dir ${ev[0]?.dir}`);
  const mid = trace[FLICK + T(cfg.slipRise) + 2];
  check('slip is active inside the window', mid.f.slip.active && mid.f.slip.dir === 1);
  check('the head sits slipHeadOffset to the fighter\'s right at full offset', near(mid.lat, cfg.slipHeadOffset, 1e-6), `lateral ${mid.lat.toFixed(3)} vs ${cfg.slipHeadOffset}`);
  check('the head radius is untouched', near(mid.f.headBox.r, mid.f.body.headR, 1e-9));
  const rising = trace[FLICK];
  check('the offset ramps in rather than teleporting (t = dt on the release tick)', rising.f.slip.offset > 0 && rising.f.slip.offset < cfg.slipHeadOffset && near(rising.f.slip.t, SIM_DT, 1e-9), `offset ${rising.f.slip.offset.toFixed(3)}, t ${rising.f.slip.t}`);
  const closed = trace[FLICK + T(cfg.slipDuration) + 1];
  check('the window closes after slipDuration', !closed.f.slip.active, `t ${closed.f.slip.t.toFixed(3)}`);
  check('…and the head is on its way home, not snapped', closed.f.slip.offset > 0 && closed.f.slip.offset < cfg.slipHeadOffset, `offset ${closed.f.slip.offset.toFixed(3)}`);
  const home = trace[FLICK + T(cfg.slipDuration + cfg.slipReturn) + 1];
  check('after slipDuration + slipReturn the head is home and the slip idle', home.f.slip.dir === 0 && home.f.slip.offset === 0 && near(home.lat, 0, 1e-9), `dir ${home.f.slip.dir}, lateral ${home.lat.toFixed(4)}`);
  check('the shoulders lean slipShoulderFrac of the way with the head', near(worldToLocal(mid.f.pos, frameOf(mid.f.yaw), mid.f.bodyBox.b).lateral, cfg.slipHeadOffset * cfg.slipShoulderFrac, 1e-9));
  check('the hips stay put', near(worldToLocal(mid.f.pos, frameOf(mid.f.yaw), mid.f.bodyBox.a).lateral, 0, 1e-9));
  // The guard rides the shoulders: compare the glove target's lateral to a rest run at the same tick.
  const restRun = run(fresh(), 60, () => [NONE, NONE], null);
  const restLat = i => worldToLocal(restRun.s.fighters[0].pos, frameOf(restRun.s.fighters[0].yaw), restRun.s.fighters[0].gloves[i].target).lateral;
  const slipLat = i => worldToLocal(s.fighters[0].pos, frameOf(s.fighters[0].yaw), s.fighters[0].gloves[i].target).lateral;
  check('after the slip the glove targets are back at rest', near(slipLat(0), restLat(0), 1e-6) && near(slipLat(1), restLat(1), 1e-6));
  const midLat = i => worldToLocal(mid.f.pos, frameOf(mid.f.yaw), mid.f.gloves[i].target).lateral;
  check('mid-slip the guard rides the shoulders sideways', near(midLat(0) - restLat(0), cfg.slipHeadOffset * cfg.slipShoulderFrac, 1e-6) && near(midLat(1) - restLat(1), cfg.slipHeadOffset * cfg.slipShoulderFrac, 1e-6), `${(midLat(0) - restLat(0)).toFixed(3)}, ${(midLat(1) - restLat(1)).toFixed(3)}`);
  check('the flick still moved the feet a little (footwork is not gated by the detector)', Math.hypot(s.fighters[0].pos.x + MID / 2, s.fighters[0].pos.z) > 0.005);
}

// ── 2. A hold is footwork: no slip, not even on release ─────────────────────
{
  let anyOffset = false;
  const { evs } = run(fresh(), HOLD + 30, push(HOLD, 1), st => { if (st.fighters[0].slip.offset !== 0) anyOffset = true; });
  check('a push held past slipFlickMax never slips', slips(evs).length === 0 && !anyOffset, `${slips(evs).length} events`);
  const edge = Math.floor(cfg.slipFlickMax / SIM_DT);   // the last whole tick count inside the bound (v1: strictly greater = hold)
  check('released on the last tick inside the bound is still a flick', slips(run(fresh(), 40, push(edge, 1)).evs).length === 1);
  check('one tick past the bound is a hold', slips(run(fresh(), 40, push(edge + 1, 1)).evs).length === 0);
}

// ── 3. What counts as a push ────────────────────────────────────────────────
{
  check('under slipInputThreshold the detector sees nothing', slips(run(fresh(), 40, push(FLICK, cfg.slipInputThreshold - 0.05)).evs).length === 0);
  check('at the threshold it is a push', slips(run(fresh(), 40, push(FLICK, cfg.slipInputThreshold)).evs).length === 1);
  check('a forward flick is not a slip (no duck on the depth axis)', slips(run(fresh(), 40, push(FLICK, 0, 1)).evs).length === 0);
  // The pull (2026-09-16): a back flick takes the head straight back.
  {
    const trace = [];
    const { evs } = run(fresh(), 40, push(FLICK, 0, -1), (st, i) => trace.push(st.fighters[0]));
    const ev = slips(evs);
    check('a back flick is a PULL: one slip event with dir 2', ev.length === 1 && ev[0].dir === 2, `${ev.length} events, dir ${ev[0]?.dir}`);
    const mid = trace[FLICK + T(cfg.slipRise) + 2];
    const headFwd = worldToLocal(mid.pos, frameOf(mid.yaw), mid.headBox).forward;
    const shFwd = worldToLocal(mid.pos, frameOf(mid.yaw), mid.bodyBox.b).forward;
    const hipFwd = worldToLocal(mid.pos, frameOf(mid.yaw), mid.bodyBox.a).forward;
    check('the head goes back by slipBackOffset, not sideways', near(headFwd, -cfg.slipBackOffset, 1e-6) && near(headLat(mid), 0, 1e-9), `forward ${headFwd.toFixed(3)}, lateral ${headLat(mid).toFixed(3)}`);
    check('the shoulders wind back slipShoulderFrac of it; the hips stay', near(shFwd, -cfg.slipBackOffset * cfg.slipShoulderFrac, 1e-6) && near(hipFwd, 0, 1e-9), `shoulders ${shFwd.toFixed(3)}, hips ${hipFwd.toFixed(3)}`);
    const homeF = trace[FLICK + T(cfg.slipDuration + cfg.slipReturn) + 1];
    check('…and it comes home', homeF.slip.dir === 0 && near(worldToLocal(homeF.pos, frameOf(homeF.yaw), homeF.headBox).forward, 0, 1e-9));
    // It dodges a straight near the edge of range: a jab that lands on a
    // standing head misses a pulled one, and is classified as slipped. (0.9,
    // not the very edge: the flick itself walks the fighter back ~12 cm, and
    // at 1.0 m that alone takes the jab out of range — correctly not a dodge.)
    const EDGE = 0.9;
    const stand = run(fresh(EDGE), 40, i => [NONE, inp({ jab: i === 8 })]).evs;
    const pulled = run(fresh(EDGE), 40, i => [inp({ move: { x: 0, y: i < FLICK ? -1 : 0 } }), inp({ jab: i === 8 })]).evs;
    check('a jab at the edge of range lands on a standing head', stand.some(e => e.type === 'punchLand'));
    check('…and is pulled away from by a back flick, classified as dodged', pulled.some(e => e.type === 'punchWhiff') && pulled.some(e => e.type === 'slip' && e.dodged && e.dir === 2), pulled.filter(e => e.type !== 'punchStart').map(e => e.type + (e.dodged ? '(dodged)' : '')).join(', '));
  }
  // A lateral slip dips.
  {
    const trace = [];
    run(fresh(), 40, push(FLICK, 1), (st, i) => trace.push(st.fighters[0]));
    const mid = trace[FLICK + T(cfg.slipRise) + 2];
    check('a lateral slip dips the head by slipDip and takes the whole body down slipCrouch', near(mid.headBox.y, mid.body.headY - cfg.slipDip - cfg.slipCrouch, 1e-6), `${mid.headBox.y.toFixed(3)} vs ${(mid.body.headY - cfg.slipDip - cfg.slipCrouch).toFixed(3)}`);
  }
  check('a diagonal flick that is more forward than sideways is not a slip', slips(run(fresh(), 40, push(FLICK, 0.5, 0.8)).evs).length === 0);
  check('a diagonal flick that is more sideways than forward slips', slips(run(fresh(), 40, push(FLICK, 0.8, 0.5)).evs).length === 1);
  // Direction is captured when the push begins, not at release.
  const wobble = i => [inp({ move: { x: i < 2 ? 1 : i < FLICK ? -1 : 0, y: 0 } }), NONE];
  const w = slips(run(fresh(), 40, wobble).evs);
  check('the direction is the one the push started with, not the one it ended with', w.length === 1 && w[0].dir === 1, `dir ${w[0]?.dir}`);
}

// ── 3b. A stick nudge that picks a punch's hand is not a flick ──────────────
{
  const nudge = i => [inp({ hook: i === 0, move: { x: i === 0 ? -1 : 0, y: 0 } }), NONE];
  const n = run(fresh(), 40, nudge);
  check('a one-tick stick nudge on the hook press picks the hand and does NOT slip', slips(n.evs).length === 0 && n.evs.some(e => e.type === 'punchStart' && e.hand === 'lead'));
  const during = i => [inp({ hook: i === 2, move: { x: i < FLICK ? -1 : 0, y: 0 } }), NONE];
  check('a punch pressed while the stick is pushed spends the push: no slip on release', slips(run(fresh(), 40, during).evs).length === 0);
  const after = i => [inp({ hook: i === FLICK + 2, move: { x: i < FLICK ? -1 : 0, y: 0 } }), NONE];
  check('a flick completed before the press still slips (slip, then hook)', slips(run(fresh(), 40, after).evs).length === 1);
}

// ── 4. Direction: lead/rear in the event, right/left in the world ───────────
{
  const left = run(fresh(), 20, push(FLICK, -1));
  const ev = slips(left.evs)[0];
  check('orthodox, stick left → dir -1 (toward the lead side)', ev?.dir === -1, `dir ${ev?.dir}`);
  check('…and the head is to the fighter\'s left', headLat(left.s.fighters[0]) < -cfg.slipHeadOffset + 1e-6, `${headLat(left.s.fighters[0]).toFixed(3)}`);
  const southpaw = [{ ...ROSTER[0], stance: 'southpaw' }, ROSTER[1]];
  const sp = run(fresh(MID, southpaw), 20, push(FLICK, 1));
  const se = slips(sp.evs)[0];
  check('southpaw, stick right → dir -1 (the lead side is the right)', se?.dir === -1, `dir ${se?.dir}`);
  check('…but the head still goes to the fighter\'s right: the stick is the world, dir is the stance', headLat(sp.s.fighters[0]) > cfg.slipHeadOffset - 1e-6, `${headLat(sp.s.fighters[0]).toFixed(3)}`);
}

// ── 5. One at a time ────────────────────────────────────────────────────────
{
  // Two flicks inside one window: the second is swallowed.
  const two = i => [inp({ move: { x: (i < FLICK || (i >= FLICK + 3 && i < FLICK + 3 + FLICK)) ? 1 : 0, y: 0 } }), NONE];
  check('a second flick inside the window is ignored', slips(run(fresh(), 40, two).evs).length === 1);
  // A flick while the head is still coming home is ignored too.
  const gap = FLICK + T(cfg.slipDuration) + 2;   // window closed, still returning
  const ret = i => [inp({ move: { x: (i < FLICK || (i >= gap && i < gap + FLICK)) ? 1 : 0, y: 0 } }), NONE];
  check('a flick during the return is ignored (no new slip until the head is home)', slips(run(fresh(), 60, ret).evs).length === 1);
  // Once home, the next flick fires.
  const later = FLICK + T(cfg.slipDuration + cfg.slipReturn) + 3;
  const again = i => [inp({ move: { x: (i < FLICK || (i >= later && i < later + FLICK)) ? 1 : 0, y: 0 } }), NONE];
  const ev = slips(run(fresh(), 80, again).evs);
  check('after the head is home a new flick slips again', ev.length === 2 && ev[1].tick === later + FLICK, `${ev.length} events`);
}

// ── 6. Slip and block are mutually exclusive ────────────────────────────────
{
  const blocked = i => [inp({ block: true, move: { x: i < FLICK ? 1 : 0, y: 0 } }), NONE];
  check('a flick under a held block does not slip', slips(run(fresh(), 30, blocked).evs).length === 0);
  let blockOn = null, closedAt = null;
  run(fresh(), 60, i => [inp({ block: i > FLICK, move: { x: i < FLICK ? 1 : 0, y: 0 } }), NONE], (st, i) => {
    const f = st.fighters[0];
    if (closedAt === null && i > FLICK && !f.slip.active) closedAt = i;
    if (blockOn === null && f.block) blockOn = i;
  });
  check('the block cannot come up inside the slip window', blockOn !== null && closedAt !== null && blockOn >= closedAt, `block on ${blockOn}, window closed ${closedAt}`);
  check('…and engages the very tick the window closes', blockOn === closedAt, `block on ${blockOn}, window closed ${closedAt}`);
}

// ── 7. The canvas ───────────────────────────────────────────────────────────
{
  let s = fresh();
  s.fighters[0].down = true;
  check('a downed fighter cannot slip', slips(run(s, 30, push(FLICK, 1)).evs).length === 0);
  // A knockdown wipes a slip in progress.
  s = fresh();
  s.fighters[1].health = 0.001;
  s.fighters[1].slip = { active: false, dir: 1, t: cfg.slipDuration + 0.01, offset: cfg.slipHeadOffset * 0.5 };
  const { s: kd, evs } = run(s, 40, i => [inp({ jab: i === 0 }), NONE]);
  check('the jab put them down', evs.some(e => e.type === 'knockdown'));
  check('the knockdown resets the slip', kd.fighters[1].slip.dir === 0 && kd.fighters[1].slip.offset === 0 && !kd.fighters[1].slip.active);
}

// ── 8. Classification: slipped vs out of range ──────────────────────────────
// Side 0 jabs side 1. The control run finds the land tick; the slip run has
// side 1 flick so the window covers it, then snaps side 1's feet back to where
// the control had them (a flick is footwork too, and even a few cm of it
// would let the punch miss for the wrong reason — legacy slip_test does the
// same). The only difference left is the head offset.
//
// Which way matters. The jab is the attacker's lead (left) hand and arrives
// on the defender's RIGHT, 5 cm off their centreline, so the defender slips
// to their LEFT (stick -1), away from it — the outside slip. Slipping into it
// is tested below: the head clears, the shoulder does not.
{
  const ctrlPos = [];
  const control = run(fresh(), 40, i => [inp({ jab: i === 0 }), NONE], st => ctrlPos.push({ x: st.fighters[1].pos.x, z: st.fighters[1].pos.z }));
  const land = control.evs.find(e => e.type === 'punchLand');
  check('control: the jab lands on the head', land?.part === 'head', `${land?.type} ${land?.part}`);
  const L = land.tick;
  const start = L - 8, release = start + 3;
  function slipRun(dist, stickX) {
    let s = fresh(dist);
    const evs = [];
    let atLand = null;
    for (let i = 0; i < 40; i++) {
      const r = sim.step(s, [inp({ jab: i === 0 }), inp({ move: { x: i >= start && i < release ? stickX : 0, y: 0 } })], cfg);
      s = r.state;
      for (const e of r.events) evs.push({ ...e, tick: i });
      if (dist === MID && i >= start && i <= release + 1) { s.fighters[1].pos = { ...ctrlPos[i] }; s.fighters[1].vel = { x: 0, z: 0 }; }
      if (i === L) atLand = s.fighters[1];
    }
    return { evs, atLand };
  }
  const { evs, atLand } = slipRun(MID, -1);
  const dodged = evs.filter(e => e.type === 'slip' && e.dodged);
  check('side 1 was slipping at the resolve tick', atLand.slip.active && near(Math.abs(atLand.slip.offset), cfg.slipHeadOffset, 1e-6), `active ${atLand?.slip.active}, offset ${atLand?.slip.offset}`);
  check('the same jab now whiffs', evs.some(e => e.type === 'punchWhiff' && e.tick === L) && !evs.some(e => e.type === 'punchLand'), evs.filter(e => e.tick === L).map(e => e.type + (e.part ? ':' + e.part : '')).join(','));
  check('…and is classified as SLIPPED: one slip event with dodged: true, on the defender', dodged.length === 1 && dodged[0].side === 1 && dodged[0].tick === L && dodged[0].dir === -1, `${dodged.length} dodged events`);
  check('the whiff itself still fires (a slipped punch is still a miss for recovery and stamina)', evs.filter(e => e.type === 'punchWhiff').length === 1);
  check('no hurt event: the slip took the punch away entirely', !evs.some(e => e.type === 'hurt'));
  {
    // The read (2026-09-18): a slipped punch adds slipDodgeHitStop — the beat as the fist passes the ear.
    let stopAt = 0, stopBefore = 0, s = fresh(MID);
    for (let i = 0; i <= L; i++) {
      const r = sim.step(s, [inp({ jab: i === 0 }), inp({ move: { x: i >= L - 7 && i < L - 2 ? -1 : 0, y: 0 } })], cfg);
      s = r.state;
      if (i === L - 1) stopBefore = s.hitStop;
      if (r.events.some(ev => ev.type === 'slip' && ev.dodged)) stopAt = s.hitStop;
    }
    check('a slipped punch adds slipDodgeHitStop at the dodge (the read)', stopAt >= cfg.slipDodgeHitStop - SIM_DT - 1e-9 && stopBefore === 0, `hit-stop ${stopAt.toFixed(3)} at the dodge (before: ${stopBefore})`);
  }
  const inside = slipRun(MID, 1);
  const il = inside.evs.find(e => e.type === 'punchLand');
  check('slipping INTO the jab hand: the head clears but the shoulder catches it — a body shot, not a dodge', il?.part === 'body' && !inside.evs.some(e => e.type === 'slip' && e.dodged), `${il?.type} ${il?.part}`);

  // Out of range, inside rangeMax so the geometry test runs: plain whiff.
  const far = run(fresh(1.1), 40, i => [inp({ jab: i === 0 }), NONE]);
  check('a jab from 1.1 m whiffs on geometry', far.evs.some(e => e.type === 'punchWhiff') && !far.evs.some(e => e.type === 'punchLand'));
  check('an out-of-range whiff is NOT classified as slipped', !far.evs.some(e => e.type === 'slip'));
  // Out of range with a slip genuinely active: still not slipped — the punch
  // was never going to land. Standing at the wrong distance must not earn
  // what reading the punch earns.
  const farSlip = slipRun(1.1, -1);
  const fs = farSlip.evs.filter(e => e.type === 'slip');
  check('far + a real slip: the flick fires but nothing is dodged', fs.length === 1 && !fs[0].dodged && farSlip.atLand.slip.active && farSlip.evs.some(e => e.type === 'punchWhiff'), `${fs.length} slip events, dodged ${fs.map(e => e.dodged)}, active at resolve ${farSlip.atLand?.slip.active}`);
  // Beyond rangeMax the hit test never runs, so neither does the classification.
  const beyond = slipRun(cfg.rangeMax + 0.1, -1);
  check('beyond rangeMax: whiff, nothing dodged', beyond.evs.some(e => e.type === 'punchWhiff') && !beyond.evs.some(e => e.type === 'slip' && e.dodged));
}

// ── 9. Determinism through the slip path ────────────────────────────────────
{
  const a = run(fresh(), 60, i => [inp({ jab: i === 0, move: { x: i > 20 && i < 24 ? -1 : 0, y: 0 } }), inp({ move: { x: i >= 6 && i < 9 ? 1 : 0, y: 0 } })]);
  const b = run(fresh(), 60, i => [inp({ jab: i === 0, move: { x: i > 20 && i < 24 ? -1 : 0, y: 0 } }), inp({ move: { x: i >= 6 && i < 9 ? 1 : 0, y: 0 } })]);
  check('two runs with slips on both sides are identical', JSON.stringify(a.s) === JSON.stringify(b.s) && JSON.stringify(a.evs) === JSON.stringify(b.evs));
  const hasNaN = v => typeof v === 'number' ? Number.isNaN(v) : v && typeof v === 'object' ? Object.values(v).some(hasNaN) : false;
  check('no NaN anywhere in the state', !hasNaN(a.s));
  check('side 1 can slip from input too', a.evs.some(e => e.type === 'slip' && e.side === 1));
}

done();

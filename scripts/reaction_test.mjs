/** reaction_test.mjs — hit reaction springs, derived boxes, stagger, hit-stop (port of legacy reaction assertions for jab/cross). */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, frameOf, localToWorld } = core;
const cfg = createConfig();
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;

function fresh(dist = MID) {
  let s = sim.createState(specs, cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], cfg).state;
  return s;
}
/** Throw `type`; returns per-tick snapshots from the press onward and the land tick. */
function throwAndWatch(type, n = 120) {
  let s = fresh();
  const snaps = [];
  let landTick = null, land = null;
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, [inp({ [type]: i === 0 }), NONE], cfg);
    s = r.state;
    const l = r.events.find(e => e.type === 'punchLand');
    if (l) { landTick = i; land = l; }
    snaps.push({ tick: i, time: s.time, clock: s.round.clock, hitStop: s.hitStop, d: s.fighters[1], a: s.fighters[0] });
  }
  return { snaps, landTick, land, final: s };
}

// ── 1. Head spring: displaced along the impulse, settles back ───────────────
{
  const { snaps, landTick, final } = throwAndWatch('jab');
  check('jab lands', landTick !== null);
  const atLand = snaps[landTick].d;
  check('on the land tick the head spring has velocity along the impulse (+x)', atLand.reaction.head.vx > 0, `${atLand.reaction.head.vx.toFixed(3)}`);
  check('…and an upward lift component', atLand.reaction.head.vy > 0);
  let peak = 0, peakTick = 0;
  for (const s of snaps) if (s.d.reaction.head.x > peak) { peak = s.d.reaction.head.x; peakTick = s.tick; }
  check('the head is displaced away from the attacker (+x) by a visible amount', peak > 0.02 && peak < cfg.reactionMaxOffset, `peak ${peak.toFixed(3)} m at tick ${peakTick}`);
  check('the displacement never crosses the clamp', snaps.every(s => Math.abs(s.d.reaction.head.x) <= cfg.reactionMaxOffset && Math.abs(s.d.reaction.head.y) <= cfg.reactionMaxOffset));
  const h = final.fighters[1];
  check('the head spring settles back within 1.5 s', Math.abs(h.reaction.head.x) < 0.003 && Math.abs(h.reaction.head.vx) < 0.05, `x ${h.reaction.head.x.toFixed(4)} vx ${h.reaction.head.vx.toFixed(3)}`);
  check('the jab barely moves the torso (jabReactTorso)', Math.max(...snaps.map(s => s.d.reaction.torso.x)) < peak * 0.2);
  check('the torso tilt is nonzero and clamped', snaps.some(s => s.d.reaction.tilt.x !== 0) && snaps.every(s => Math.abs(s.d.reaction.tilt.x) <= cfg.reactionMaxTilt));
}
{
  const jab = throwAndWatch('jab'), cross = throwAndWatch('cross');
  const peak = w => Math.max(...w.snaps.map(s => s.d.reaction.head.x));
  const peakT = w => Math.max(...w.snaps.map(s => s.d.reaction.torso.x));
  check('a cross snaps the head further than a jab', peak(cross) > peak(jab), `${peak(cross).toFixed(3)} vs ${peak(jab).toFixed(3)}`);
  check('a cross carries the torso with it, far more than a jab', peakT(cross) > peakT(jab) * 3, `${peakT(cross).toFixed(3)} vs ${peakT(jab).toFixed(3)}`);
  check('the jab\'s snap multiplier makes it settle sooner', settleTick(jab) < settleTick(cross), `${settleTick(jab)} vs ${settleTick(cross)}`);
  function settleTick(w) {
    let last = 0;
    for (const s of w.snaps) if (Math.abs(s.d.reaction.head.x) > 0.005) last = s.tick;
    return last;
  }
}

// ── 2. Derived boxes follow the reaction ────────────────────────────────────
{
  const { snaps, landTick } = throwAndWatch('cross');
  let ok = true, worst = 0;
  for (const s of snaps) {
    const d = s.d, fr = frameOf(d.yaw), r = d.reaction;
    const head = localToWorld(d.pos, fr, 0, d.body.headY, 0);
    const ex = head.x + r.torso.x + r.head.x, ey = head.y + r.torso.y + r.head.y, ez = head.z + r.torso.z + r.head.z;
    const err = Math.abs(d.headBox.x - ex) + Math.abs(d.headBox.y - ey) + Math.abs(d.headBox.z - ez);
    worst = Math.max(worst, err);
    if (err > 1e-9 || d.headBox.r !== d.body.headR) ok = false;
    const hip = localToWorld(d.pos, fr, 0, d.body.hipY, 0), sh = localToWorld(d.pos, fr, 0, d.body.shoulderY, 0);
    if (Math.abs(d.bodyBox.a.x - hip.x - r.torso.x) > 1e-9 || Math.abs(d.bodyBox.b.y - sh.y - r.torso.y) > 1e-9 || d.bodyBox.r !== d.body.bodyR) ok = false;
  }
  check('headBox = head rest + torso + head offsets, every tick', ok, `worst ${worst}`);
  const before = snaps[landTick - 1].d, after = snaps[landTick + 3].d;
  check('the head box visibly moves after the land', after.headBox.x - after.pos.x > before.headBox.x - before.pos.x + 0.01);
  check('the head stays on top of the body (box x within reach of the shoulders)', snaps.every(s => Math.abs(s.d.headBox.x - s.d.bodyBox.b.x) < 0.5));
}

// ── 3. Stagger: floor velocity, decays, moves the body ──────────────────────
{
  const { snaps, landTick, final } = throwAndWatch('cross');
  const at = snaps[landTick].d;
  check('the defender gains stagger velocity away from the attacker on the land tick', at.stagger.x > 0.5, `${at.stagger.x.toFixed(3)} m/s`);
  check('stagger decays monotonically after the hit', snaps.slice(landTick + 1).every((s, i, a) => i === 0 || s.d.stagger.x <= a[i - 1].d.stagger.x + 1e-12));
  check('stagger is gone within 2 s', final.fighters[1].stagger.x === 0 && final.fighters[1].stagger.z === 0);
  check('the defender ends up further away than it started', final.fighters[1].pos.x > MID / 2 + 0.05, `${final.fighters[1].pos.x.toFixed(3)}`);
  check('stagger does not become locomotion velocity', final.fighters[1].vel.x === 0);
}

// ── 4. Hit-stop slows the whole sim ─────────────────────────────────────────
{
  const { snaps, landTick, land } = throwAndWatch('jab');
  const l = snaps[landTick], n1 = snaps[landTick + 1], prev = snaps[landTick - 1];
  check('hitStop is set on the land tick', l.hitStop > 0 && l.hitStop <= cfg.hitStopMax, `${l.hitStop}`);
  check('hitStop = min(hitStopMax, hitStopBase × power)', near(l.hitStop, Math.min(cfg.hitStopMax, cfg.hitStopBase * land.power), 1e-12), `${l.hitStop} vs power ${land.power}`);
  check('the land tick itself ran at full rate', near(l.time - prev.time, SIM_DT, 1e-12));
  check('the next tick advances time by hitStopScale × SIM_DT', near(n1.time - l.time, SIM_DT * cfg.hitStopScale, 1e-12), `${(n1.time - l.time).toFixed(6)}`);
  check('the round clock slows by the same factor', near(l.clock - n1.clock, SIM_DT * cfg.hitStopScale, 1e-12));
  const stopTicks = Math.ceil(l.hitStop / SIM_DT);
  const afterStop = snaps[landTick + stopTicks + 1], lastStop = snaps[landTick + stopTicks];
  check('hit-stop counts down in real ticks and ends', lastStop.hitStop === 0 && near(afterStop.time - lastStop.time, SIM_DT, 1e-12), `${stopTicks} ticks`);
  const punchDuringStop = snaps[landTick + 1].d;
  check('the defender\'s reaction spring still advances during hit-stop (slowly)', punchDuringStop.reaction.head.x > 0);
  const total = cfg.jabCock + cfg.jabExtend + cfg.jabRecover;
  check('the attacker\'s punch clock is slowed too', near(snaps[landTick + 1].a.punch.progress - l.a.punch.progress, SIM_DT * cfg.hitStopScale / total, 1e-9), `${(snaps[landTick + 1].a.punch.progress - l.a.punch.progress).toFixed(6)}`);
}
{
  // A punch started during hit-stop still starts (inputs are sampled every tick).
  let s = fresh();
  s = sim.step(s, [NONE, NONE], cfg).state;
  s.hitStop = 0.05;
  const r = sim.step(s, [inp({ cross: true }), NONE], cfg);
  check('inputs are sampled during hit-stop: a cross starts while the sim is slowed', r.events.some(e => e.type === 'punchStart') && r.state.fighters[0].punch.type === 'cross');
  check('…and its progress advanced at the scaled rate', near(r.state.fighters[0].punch.progress, SIM_DT * cfg.hitStopScale / (cfg.crossCock + cfg.crossExtend + cfg.crossRecover), 1e-12), `${r.state.fighters[0].punch.progress}`);
}

// ── 5. The gloves are alive: idle bob, never frozen ────────────────────────
{
  let s = fresh();
  const ys = [];
  for (let i = 0; i < 120; i++) { s = sim.step(s, [NONE, NONE], cfg).state; ys.push(s.fighters[1].gloves[0].pos.y); }
  const range = Math.max(...ys) - Math.min(...ys);
  check('the resting dummy\'s glove bobs (never freezes)', range > cfg.chainBobAmp * 0.5 && range < cfg.chainBobAmp * 4, `range ${range.toFixed(4)}`);
  check('lead and rear gloves do not twin', Math.abs(s.fighters[1].gloves[0].pos.y - s.fighters[1].gloves[0].target.y) !== Math.abs(s.fighters[1].gloves[1].pos.y - s.fighters[1].gloves[1].target.y));
  check('the glove target is world-space near the head height', s.fighters[1].gloves[0].target.y > s.fighters[1].body.shoulderY && s.fighters[1].gloves[0].target.y < s.fighters[1].body.heightM);
}

done();

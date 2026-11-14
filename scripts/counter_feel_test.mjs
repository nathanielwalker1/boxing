/**
 * counter_feel_test.mjs — the counter's definition pinned in ticks, the land
 * flag the presentation reads, the impulse / head-reaction difference between
 * a counter and the same cross landed cold, and counterFeelV2 being
 * presentation-only (sim identical with it off). docs/FEEL.md "Counters".
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, v3len } = core;
const cfg = createConfig();
const QUIET = { ...cfg, staminaBlockDrain: 0, staminaRegen: 0 };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;
const T = s => Math.round(s / SIM_DT);

function fresh(c) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -MID / 2, z: 0 }; s.fighters[1].pos = { x: MID / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
// Fighter 0 jabs, fighter 1 slips it (flick back) and crosses at `counterAt`; pass counterAt null for no counter.
// Mirrors counter_test §5: the slipper is pinned to the control path so the slip is real.
function slipScenario(c, counterAt) {
  const ctrlPos = [];
  { let s = fresh(c); for (let i = 0; i < 40; i++) { s = sim.step(s, [inp({ jab: i === 0 }), NONE], c).state; ctrlPos.push({ ...s.fighters[1].pos }); } }
  let L = null;
  { let s = fresh(c); for (let i = 0; i < 40; i++) { const r = sim.step(s, [inp({ jab: i === 0 }), NONE], c); s = r.state; if (L === null && r.events.some(e => e.type === 'punchLand')) L = i; } }
  const start = L - 8, release = start + 3;
  let s = fresh(c);
  const evs = [], trace = [];
  for (let i = 0; i < 90; i++) {
    const r = sim.step(s, [inp({ jab: i === 0 }), inp({ cross: i === counterAt, move: { x: i >= start && i < release ? -1 : 0, y: 0 } })], c);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (i >= start && i <= release + 1) { s.fighters[1].pos = { ...ctrlPos[i] }; s.fighters[1].vel = { x: 0, z: 0 }; }
    trace.push({ w0: s.fighters[0].counterWindow, headX: s.fighters[0].reaction.head.x, headZ: s.fighters[0].reaction.head.z, torso: { ...s.fighters[0].reaction.torso }, head: { ...s.fighters[0].reaction.head } });
  }
  return { evs, trace, L, s };
}

const base = slipScenario(QUIET, null);
const slip = base.evs.find(e => e.type === 'slip' && e.dodged);
check('the jab was slipped', !!slip);
const L = base.L;

// ── 1. The window: opens at the slip, lasts slipPunishDuration, then closes ──
const window = T(cfg.slipPunishDuration);
check('slip window = slipPunishDuration in ticks', near(base.trace[L].w0, cfg.slipPunishDuration, 1e-9), `${base.trace[L].w0}`);
const closeTick = base.trace.findIndex((t, i) => i > L && t.w0 === 0);
// The window is SIM time: it does not drain during the slip's own hit-stop (slipDodgeHitStop at hitStopScale), so wall ticks run a little over.
const stopTicks = Math.ceil(cfg.slipDodgeHitStop / SIM_DT);
check(`the window closes slipPunishDuration (${window} ticks) of sim time after the slip, plus ≤ ${stopTicks} ticks of hit-stop`, closeTick - L >= window - 1 && closeTick - L <= window + stopTicks + 1, `closed ${closeTick - L} ticks after`);

const inside = L + 3;
const lateAt = closeTick + 1;
const hot = slipScenario(QUIET, inside);
const hotLand = hot.evs.find(e => e.type === 'punchLand' && e.side === 1);
check('a cross inside the window is a counter: land carries counter:true, counter event fires', hotLand?.counter === true && hot.evs.some(e => e.type === 'counter' && e.tick === hotLand.tick));
const late = slipScenario(QUIET, lateAt);
const lateLand = late.evs.find(e => e.type === 'punchLand' && e.side === 1);
check('a cross after the window closes is NOT a counter', !late.evs.some(e => e.type === 'counter') && !late.evs.some(e => e.type === 'punchLand' && e.side === 1 && e.counter), `${late.evs.filter(e => e.tick >= lateAt).map(e => e.type + '@' + e.tick).join(',')}`);

// ── 2. Plain land: no flag ──
let cold = fresh(QUIET); const coldEvs = []; let coldTrace = [];
for (let i = 0; i < 90; i++) {
  const r = sim.step(cold, [NONE, inp({ cross: i === inside })], QUIET); cold = r.state;
  for (const e of r.events) coldEvs.push({ ...e, tick: i });
  coldTrace.push({ head: { ...cold.fighters[0].reaction.head }, torso: { ...cold.fighters[0].reaction.torso } });
}
const coldLand = coldEvs.find(e => e.type === 'punchLand' && e.side === 1);
check('the same cross cold is not flagged and fires no counter event', coldLand?.counter === false && !coldEvs.some(e => e.type === 'counter'));

// ── 3. Impulse ratio and body reaction ──
const ratio = v3len(hotLand.impulse) / v3len(coldLand.impulse);
const lo = 1 + 0.5 * cfg.counterImpulseBonus, hi = 1 + cfg.counterImpulseBonus;
check(`counter impulse / plain impulse within [1 + 0.5 × bonus, 1 + bonus] = [${lo.toFixed(2)}, ${hi.toFixed(2)}]`, ratio >= lo - 1e-6 && ratio <= hi + 1e-6, `${ratio.toFixed(3)}x`);
const peak = (tr, k) => Math.max(...tr.map(t => Math.hypot(t[k].x, t[k].y ?? 0, t[k].z ?? 0)));
const hHot = peak(hot.trace, 'head'), hCold = peak(coldTrace, 'head');
const tHot = peak(hot.trace, 'torso'), tCold = peak(coldTrace, 'torso');
console.log(`     peak head reaction: counter ${hHot.toFixed(4)} vs plain ${hCold.toFixed(4)} (${(hHot / hCold).toFixed(2)}x); torso ${tHot.toFixed(4)} vs ${tCold.toFixed(4)} (${(tHot / tCold).toFixed(2)}x); impulse ${v3len(hotLand.impulse).toFixed(1)} vs ${v3len(coldLand.impulse).toFixed(1)} (${ratio.toFixed(2)}x)`);
check('the counter moves the head and torso further than the plain land', hHot > hCold && tHot >= tCold);

// ── 4. counterFeelV2 is presentation only: sim identical either way ──
const off = slipScenario({ ...QUIET, counterFeelV2: false }, inside);
const on = slipScenario({ ...QUIET, counterFeelV2: true }, inside);
check('counterFeelV2 off reproduces an identical fight (events JSON-equal)', JSON.stringify(off.evs) === JSON.stringify(on.evs) && JSON.stringify(off.s) === JSON.stringify(on.s));
check('counterFeelV2 defaults to true', cfg.counterFeelV2 === true);

done();

/**
 * stun_test.mjs — ROCKED (sim/stun.ts), in Node against the sim.
 *   - the threshold formula: chin, health and stamina each lower it as documented
 *   - a fresh chin-62 fighter is not rocked by a standing cross; at low health he is
 *   - the jab never rocks, however hard; a body shot never rocks
 *   - rocked: movement halves, the block absorbs less, exposure is held, the
 *     guard sags, no punch starts for stunPunchLock, the state clears on time
 *     and a longer hurt for a shot that clears the bar by more
 *   - the finish: a second cross while rocked floors him with health left; a
 *     jab while rocked does not
 *   - the flash: one shot at stunFlashFrac × T floors a fresh fighter
 *   - the canvas clears the hurt state; off switch stunBase 0
 *   - determinism: two runs through a rock and a finish are identical
 * The player (side 0) punches the frozen-guard dummy (side 1) from MID, as
 * health_test does; impulse multipliers are set per case so the case is the
 * formula, not the punch table.
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT } = core;
// ratingsOn / stylesOn off (overhaul phase 2): this file pins the reference fighters' numbers and margins as they were before
// ratings and guard shapes did anything — both un-rated, both in the high guard. ratings_test / styles_test cover those.
const base = ({ ...createConfig(), ratingsOn: false, stylesOn: false });
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;
const LOW = 0.05;   // a bar low enough that a standing cross (~272 N·s) clears the threshold (≈ 258 N·s for chin 62)
const T = s => Math.round(s / SIM_DT);

function fresh(c = base, dist = MID) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
function run(s, n, inputs = () => [NONE, NONE], c = base, onTick) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, inputs(i), c); s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (onTick?.(s, i, r.events) === true) break;
  }
  return { s, evs };
}
const of = (evs, type) => evs.filter(e => e.type === type);
// Light damage so the bar never empties by itself in these cases, and no regen to muddy the threshold.
const soft = { ...base, healthDamagePerImpulse: 0.00002, healthRegen: 0 };
/** One cross from the player, run `n` ticks; the dummy holds `dummy` input. */
const cross = (s, c, n = 40, dummy = NONE) => run(s, n, i => [inp({ cross: i === 0 }), dummy], c);

// ── 1. The formula ──────────────────────────────────────────────────────────
{
  const s = fresh(soft);
  const d = s.fighters[1];
  const chin = d.ratings.chin / 100;
  const expect = soft.stunBase * (soft.stunChinFloor + soft.stunChinSpan * chin);
  check(`fresh chin ${d.ratings.chin}: T = stunBase × (floor + span × chin) = ${expect.toFixed(0)} N·s`, near(sim.stunThreshold(d, soft), expect, 1e-6), `${sim.stunThreshold(d, soft)}`);
  const half = { ...d, health: 0.5 };
  check('half health lowers it by the health factor', near(sim.stunThreshold(half, soft), expect * (soft.stunHealthFloor + (1 - soft.stunHealthFloor) * 0.5), 1e-6));
  const tired = { ...d, stamina: 0 };
  check('empty stamina lowers it to the stamina floor', near(sim.stunThreshold(tired, soft), expect * soft.stunStaminaFloor, 1e-6));
  const glass = { ...d, ratings: { ...d.ratings, chin: 0 } }, iron = { ...d, ratings: { ...d.ratings, chin: 100 } };
  check('a glass chin carries less than an iron one', sim.stunThreshold(glass, soft) < sim.stunThreshold(iron, soft));
}

// ── 2. Who gets rocked ──────────────────────────────────────────────────────
{
  const { s, evs } = cross(fresh(soft), soft);
  const land = of(evs, 'punchLand')[0];
  check(`a standing cross lands (${land ? Math.hypot(land.impulse.x, land.impulse.z).toFixed(0) : '-'} N·s) under a fresh fighter's bar (${sim.stunThreshold(s.fighters[1], soft).toFixed(0)}) — no rock`, land && of(evs, 'rocked').length === 0 && s.fighters[1].hurt === 0);
}
{
  const s0 = fresh(soft); s0.fighters[1].health = LOW;
  const { s, evs } = cross(s0, soft);
  const r = of(evs, 'rocked')[0];
  check(`the same cross on a fighter at ${LOW * 100}% health rocks him (impulse ${r?.impulse.toFixed(0)} ≥ T ${r?.threshold.toFixed(0)})`, r && r.side === 1 && r.by === 0 && r.punch === 'cross' && r.impulse >= r.threshold && s.fighters[1].hurt > 0);
  check(`…for stunSeconds + stunSecondsPerOver × over (${r?.seconds.toFixed(2)} s)`, r && r.seconds >= soft.stunSeconds && r.seconds <= soft.stunMaxSeconds);
}
{
  const hard = { ...soft, jabImpulseMult: 4 };
  const s0 = fresh(hard); s0.fighters[1].health = 0.1;
  const { evs } = run(s0, 40, i => [inp({ jab: i === 0 }), NONE], hard);
  const land = of(evs, 'punchLand')[0];
  check(`a jab never rocks, even at ${land ? Math.hypot(land.impulse.x, land.impulse.z).toFixed(0) : '-'} N·s on a 10% fighter`, land && of(evs, 'rocked').length === 0);
}
{
  const big = { ...soft, crossImpulseMult: 2.3 };   // well over the bar (~660 N·s), under the flash (~710)
  const s0 = fresh(big);
  const { s, evs } = cross(s0, big);
  const r = of(evs, 'rocked')[0], r0 = (() => { const t = fresh(soft); t.fighters[1].health = LOW; return of(cross(t, soft).evs, 'rocked')[0]; })();
  check(`a shot that clears the bar by more rocks for longer (${r?.seconds.toFixed(2)} s vs ${r0?.seconds.toFixed(2)} s)`, r && r0 && r.seconds > r0.seconds + 0.2 && s.fighters[1].hurt > 0);
}

// ── 3. What rocked does ─────────────────────────────────────────────────────
// The rocking shot sends the dummy stumbling back out of range; put him back at MID, still rocked, so the follow-up can reach.
const closeIn = s => { const d = s.fighters[1]; d.pos = { x: s.fighters[0].pos.x + MID, z: s.fighters[0].pos.z }; d.vel = { x: 0, z: 0 }; d.stagger = { x: 0, z: 0 }; return s; };
// The dummy is rocked and the player's cross is home and chainable again (the rock's hit-stop stretches the wall-tick count, so 70 ticks).
const rockedState = () => { const s0 = fresh(soft); s0.fighters[1].health = LOW; return closeIn(cross(s0, soft, 70).s); };
{
  const s = rockedState();
  check('setup: the dummy is rocked with the bar not empty, and the player can punch again', s.fighters[1].hurt > 0 && s.fighters[1].health > 0 && !s.fighters[1].down && sim.canStartPunch(s.fighters[0], soft));
  // Movement: the dummy walks back for 20 ticks, rocked vs fresh.
  const walk = st => { const r = run(st, 20, () => [NONE, inp({ move: { x: 0, y: -1 } })], soft); return Math.hypot(r.s.fighters[1].vel.x, r.s.fighters[1].vel.z); };
  const vRocked = walk(s), vFresh = walk(fresh(soft));
  check(`rocked he moves at ~stunMoveScale of fresh (${vRocked.toFixed(2)} vs ${vFresh.toFixed(2)} m/s)`, vRocked < vFresh * (soft.stunMoveScale + 0.1) && vRocked > 0);
  // Exposure held.
  check(`exposure is held at stunVuln while rocked (vuln ${s.fighters[1].vuln.toFixed(2)})`, s.fighters[1].vuln >= soft.stunVuln - 1e-9);
  // The guard sags: compare the resting lead glove height, rocked vs fresh, after the gloves settle.
  const settle = st => run(st, 15, () => [NONE, NONE], soft).s.fighters[1].gloves[0].pos.y;
  const gyRocked = settle(s), gyFresh = settle(fresh(soft));
  check(`the resting guard sags (lead glove ${gyRocked.toFixed(3)} m vs ${gyFresh.toFixed(3)} m fresh)`, gyRocked < gyFresh - 0.03);
  // The block absorbs less: a blocked cross while rocked vs fresh, health lost.
  const blockedLoss = st => { const h0 = st.fighters[1].health; const r = cross(st, soft, 40, inp({ block: true })); return { loss: h0 - r.s.fighters[1].health, blocked: of(r.evs, 'punchBlock').length }; };
  const bR = blockedLoss(s), bF = blockedLoss(fresh(soft));
  check(`a blocked cross costs more while rocked (${(bR.loss * 100).toFixed(2)}% vs ${(bF.loss * 100).toFixed(2)}%; both blocked)`, bR.blocked === 1 && bF.blocked === 1 && bR.loss > bF.loss * 2);
}
{
  // Punch lock: once rocked (the player's cross lands at tick ~11) the dummy presses cross every other tick; nothing starts for stunPunchLock, then it does.
  const s0 = fresh(soft); s0.fighters[1].health = LOW;
  const trace = [];
  const { evs } = run(s0, 220, i => [inp({ cross: i === 0 }), inp({ cross: i >= 14 && i % 2 === 0 })], soft, st => { trace.push(st.fighters[1].hurt); });
  const r = of(evs, 'rocked')[0];
  const dummyStarts = of(evs, 'punchStart').filter(e => e.side === 1);
  const first = dummyStarts[0];
  check(`rocked: no punch starts for stunPunchLock (${soft.stunPunchLock} s); the first comes ${first ? ((first.tick - r.tick) * SIM_DT).toFixed(2) : '-'} s after the rock`, r && first && first.tick - r.tick >= T(soft.stunPunchLock) - 1 && first.tick - r.tick <= T(soft.stunPunchLock) + 12);
  // Clears on time.
  const clearAt = trace.findIndex((h, i) => i > r.tick && h === 0);
  check(`the hurt state clears after ${r?.seconds.toFixed(2)} s (cleared at tick ${clearAt}, rocked at ${r?.tick})`, clearAt > 0 && Math.abs((clearAt - r.tick) * SIM_DT - r.seconds) < 0.2);
}

// ── 4. The finish ───────────────────────────────────────────────────────────
{
  const s = rockedState();
  const { s: out, evs } = cross(s, soft, 40);
  const kd = of(evs, 'knockdown')[0];
  check(`a second cross while rocked is a knockdown with health left (cause ${kd?.cause}, health ${out.fighters[1].health.toFixed(2)})`, kd && kd.cause === 'finish' && kd.side === 1 && out.fighters[1].down && out.fighters[1].health > 0);
  check('…and the canvas clears the hurt state', out.fighters[1].hurt === 0 && out.fighters[1].hurtMax === 0);
}
{
  const s = rockedState();
  const { s: out, evs } = run(s, 40, i => [inp({ jab: i === 0 }), NONE], soft);
  check('a jab while rocked lands but does not finish', of(evs, 'punchLand').length === 1 && of(evs, 'knockdown').length === 0 && !out.fighters[1].down);
}
{
  const weak = { ...soft, crossImpulseMult: 0.17 };   // ~117 N·s after the held-exposure bonus and the FLUSH grade a rocked target gives (overhaul 2026-11-11; was 0.2), under stunFinishFrac × T (~126)
  const s = rockedState();
  const { evs } = cross(s, weak, 40);
  const land = of(evs, 'punchLand')[0];
  check(`a cross under stunFinishFrac × T does not finish (${land ? Math.hypot(land.impulse.x, land.impulse.z).toFixed(0) : '-'} N·s)`, land && of(evs, 'knockdown').length === 0);
}

// ── 5. The flash ────────────────────────────────────────────────────────────
{
  const huge = { ...soft, crossImpulseMult: 3.5 };
  const { s, evs } = cross(fresh(huge), huge);
  const kd = of(evs, 'knockdown')[0], land = of(evs, 'punchLand')[0];
  const Tf = sim.stunThreshold({ ...fresh(huge).fighters[1] }, huge);
  check(`one shot at ≥ stunFlashFrac × T (${land ? Math.hypot(land.impulse.x, land.impulse.z).toFixed(0) : '-'} vs ${(huge.stunFlashFrac * Tf).toFixed(0)}) floors a fresh fighter (cause ${kd?.cause})`, kd && kd.cause === 'flash' && s.fighters[1].down && s.fighters[1].health > 0);
}

// ── 6. Off switch, determinism ──────────────────────────────────────────────
{
  const off = { ...soft, stunBase: 0 };
  const s0 = fresh(off); s0.fighters[1].health = LOW;
  const { evs } = cross(s0, off);
  check('stunBase 0: nothing rocks', of(evs, 'punchLand').length === 1 && of(evs, 'rocked').length === 0);
}
{
  const play = () => { const s0 = fresh(soft); s0.fighters[1].health = LOW; return run(s0, 140, i => [inp({ cross: i === 0 || i === 70 }), NONE], soft, (st, i) => { if (i === 60) closeIn(st); }); };
  const a = play(), b = play();
  check('two runs through a rock and a finish are identical', JSON.stringify(a.evs) === JSON.stringify(b.evs) && JSON.stringify(a.s) === JSON.stringify(b.s));
  check('…and that run ended on the canvas by the finish', of(a.evs, 'rocked').length === 1 && of(a.evs, 'knockdown')[0]?.cause === 'finish');
}

done();

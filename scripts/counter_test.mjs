/**
 * counter_test.mjs — vulnerability curve, whiff cost, counters, perfect block
 * and the slip punish (port of legacy vulnerability_test + counter_test, and
 * slip_test §d's punish half).
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim, ai] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, v3len } = core;
// jabHealthFloor 0 (overhaul 2026-11-11): §6 uses a jab as its knockdown blow; by default a jab can no longer empty the bar (attrition_test pins that).
// ratingsOn / stylesOn off (overhaul phase 2): this file pins the reference fighters' numbers and margins as they were before
// ratings and guard shapes did anything — both un-rated, both in the high guard. ratings_test / styles_test cover those.
const cfg = { ...({ ...createConfig(), ratingsOn: false, stylesOn: false }), jabHealthFloor: 0, guardHolesV2: false };   // (guardHolesV2 off: this file pins the perfect block's own window; a block raised late would now also open a slip-type window — guard_holes_test)
cfg.hitStopV2 = false;   // anim 2.4: this file asserts the old seconds-based freezes / 5% clock, so it pins hitStopV2 off (hitstop_test.mjs covers V2)
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79, CLOSE = 0.5, FAR = 1.3;
const TYPES = ['jab', 'cross', 'hook', 'uppercut'];
const T = s => Math.round(s / SIM_DT);

function fresh(dist = MID, c = cfg) {
  let s = sim.createState(specs, c, 1);
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
const tap = type => i => [inp({ [type]: i === 0 }), NONE];
const phases = (type, c = cfg) => {
  const k = { jab: 'jab', cross: 'cross', hook: 'hook', uppercut: 'uppercut' }[type];
  return { cock: c[`${k}Cock`], extend: c[`${k}Extend`], recover: c[`${k}Recover`] };
};
const NO_STRETCH = { ...cfg, whiffRecoveryMult: 1 };
// a hook can ROCK the dummy; its hit-stop would count as recovery ticks. Overhaul 2026-11-11: the grade tiers have
// their own hit-stop (a smothered jab at CLOSE is glancing), and at CLOSE a hook / uppercut would be thrown as the
// faster inside variant — this section measures the BASE punches' whiff stretch, so variants are off for it.
const NO_HITSTOP = { ...cfg, hitStopBase: 0, stunHitStop: 0, hitStopGlancing: 0, hitStopFlush: 0, variantsOn: false };
const isNaNDeep = v => typeof v === 'number' ? Number.isNaN(v) : v && typeof v === 'object' ? Object.values(v).some(isNaNDeep) : false;

// ── 1. The curve: 0 at rest, ~0 through the early cock, peak at full extension, 0 after ──
for (const type of TYPES) {
  const trace = [];
  const { evs } = run(fresh(FAR, NO_STRETCH), 60, tap(type), st => trace.push({ p: st.fighters[0].punch.progress, v: st.fighters[0].vuln, live: st.fighters[0].punch.type !== null }), NO_STRETCH);
  const resolve = evs.find(e => e.type === 'punchWhiff')?.tick;
  let arg = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i].v > trace[arg].v) arg = i;
  const ph = phases(type);
  const cockEnd = ph.cock / (ph.cock + ph.extend + ph.recover);
  // The peak sits at peakAt exactly, between two 60 Hz samples: the higher sample is the resolve tick or the one before it.
  check(`${type}: maximum lands at full extension (the resolve tick, within a sample)`, Math.abs(arg - resolve) <= 1 && trace[arg].v >= 0.75 * cfg.vulnerabilityPeak * (type === 'jab' ? cfg.vulnerabilityJab : 1) /* phase 4: a jab exposes vulnerabilityJab of the peak */, `max ${trace[arg].v.toFixed(3)} at tick ${arg}, resolved at ${resolve}`);
  check(`${type}: effectively 0 through the early cock`, trace.filter((t, i) => t.live && t.p <= cockEnd / 2).every(t => t.v <= 0.05), trace.filter(t => t.live && t.p <= cockEnd / 2).map(t => t.v.toFixed(3)).join(','));
  const rise = trace.slice(0, arg + 1).every((t, i, a) => i === 0 || t.v >= a[i - 1].v - 1e-9);
  const end = trace.findIndex((t, i) => i > arg && !t.live);
  const fall = trace.slice(arg, end).every((t, i, a) => i === 0 || t.v <= a[i - 1].v + 1e-9);
  check(`${type}: rises monotonically into the peak, decays monotonically out of it`, rise && fall);
  check(`${type}: 0 at rest before and after`, trace[0].v < 0.02 && end > 0 && trace.slice(end).every(t => t.v === 0), `end tick ${end}`);
}

// ── 2. Whiff cost: a miss retracts slower, by the type's own weight ─────────
{
  const dur = (type, dist, c) => {
    let start = null, end = null;
    run(fresh(dist, c), 80, tap(type), (st, i) => {
      const live = st.fighters[0].punch.type !== null;
      if (live && start === null) start = i;
      if (!live && start !== null && end === null) end = i;
    }, c);
    return end - start;
  };
  const extra = {};
  for (const type of TYPES) {
    const ph = phases(type);
    const clean = dur(type, CLOSE, NO_HITSTOP);   // everything lands at CLOSE, hooks and uppercuts included
    const whiff = dur(type, FAR, NO_HITSTOP);
    const mult = 1 + (cfg.whiffRecoveryMult - 1) * cfg[`${type}WhiffScale`];
    const expected = ph.recover * (mult - 1) / SIM_DT;
    extra[type] = whiff - clean;
    check(`${type}: a landed punch leaves the recovery unstretched`, Math.abs(clean - (ph.cock + ph.extend + ph.recover) / SIM_DT) <= 1.5, `${clean} ticks`);
    check(`${type}: a whiff stretches the recovery by 1 + (${cfg.whiffRecoveryMult} − 1) × ${cfg[`${type}WhiffScale`]} = ${mult.toFixed(2)}`, Math.abs(extra[type] - expected) <= 1.5, `extra ${extra[type]} ticks vs ${expected.toFixed(1)} expected`);
  }
  check('missing a jab is the cheapest miss, missing an uppercut the most expensive', extra.jab < extra.cross && extra.cross < extra.hook && extra.hook < extra.uppercut, JSON.stringify(extra));
  check('the spread is a real tactical difference (≥ 6 ticks between jab and uppercut)', extra.uppercut - extra.jab >= 6);
  check('whiffRecoveryMult 1 disables the cost everywhere', dur('uppercut', FAR, { ...NO_HITSTOP, whiffRecoveryMult: 1 }) === dur('uppercut', CLOSE, NO_HITSTOP));

  // The exposed window grows with it: the last tick with any exposure comes later.
  const lastExposed = (dist, c) => { let last = -1; run(fresh(dist, c), 80, tap('jab'), (st, i) => { if (st.fighters[0].vuln > 0.05) last = i; }, c); return last; };
  // (Margins were 3 ticks at whiffRecoveryMult 3.5; at 2.2 a jab's 6-tick recovery stretches by 4.)
  check('the EXPOSED window itself grows by the stretch', lastExposed(FAR, NO_HITSTOP) > lastExposed(CLOSE, NO_HITSTOP) + 1, `${lastExposed(FAR, NO_HITSTOP)} vs ${lastExposed(CLOSE, NO_HITSTOP)}`);

  // Throwing is locked out for the stretched recovery: the chained cross comes later after a miss.
  const chainTick = (dist, c) => run(fresh(dist, c), 80, i => [inp({ jab: i === 0, cross: i === 3 }), NONE], null, c).evs.filter(e => e.type === 'punchStart')[1]?.tick;
  check('the next punch waits for the stretched recovery', chainTick(FAR, NO_HITSTOP) > chainTick(CLOSE, NO_HITSTOP) + 1, `${chainTick(FAR, NO_HITSTOP)} vs ${chainTick(CLOSE, NO_HITSTOP)}`);
  // v2 rule, unlike v1: the guard waits for the punch to end too (block_test), so a whiff locks the guard out for the same stretch.
  let blockOn = null, punchEnd = null;
  run(fresh(FAR, NO_HITSTOP), 80, i => [inp({ jab: i === 0, block: i >= 3 }), NONE], (st, i) => { if (blockOn === null && st.fighters[0].block) blockOn = i; if (punchEnd === null && i > 0 && st.fighters[0].punch.type === null) punchEnd = i; }, NO_HITSTOP);
  check('the guard comes up on the tick after the stretched recovery ends (v2: block waits for the punch — flagged)', blockOn === punchEnd + 1, `block on ${blockOn}, punch ended ${punchEnd}`);
}

// ── 3. Perfect block ────────────────────────────────────────────────────────
const QUIET = { ...cfg, staminaBlockDrain: 0, staminaRegen: 0 };   // isolate the hit's own costs
const control = run(fresh(MID, QUIET), 40, tap('jab'), null, QUIET);
const L = control.evs.find(e => e.type === 'punchLand').tick;
check('control: the jab lands', L !== undefined);
{
  const ph = phases('jab');
  const lateBound = Math.min(cfg.perfectBlockWindow, cfg.perfectBlockLateFrac * (ph.cock + ph.extend));
  // Late guard: raised one tick before the impact, so it is dt old when the resolver reads it.
  const trace = [];
  const late = run(fresh(MID, QUIET), 70, i => [inp({ jab: i === 0, block: i >= 24 && i < 28 }), inp({ block: i >= L - 1 })], (st, i) => trace.push({ i, v0: st.fighters[0].vuln, w0: st.fighters[0].counterWindow, b0: st.fighters[0].block, p0: st.fighters[0].punch.type, hs: st.hitStop }), QUIET);
  const pb = late.evs.find(e => e.type === 'perfectBlock');
  check('a guard raised inside the window is a PERFECT block', pb && pb.tick === L && pb.side === 0 && pb.target === 1 && pb.punch === 'jab', late.evs.filter(e => e.tick === L).map(e => e.type).join(','));
  check('…not an ordinary block, and not a land', !late.evs.some(e => e.type === 'punchBlock' || e.type === 'punchLand'));
  check('perfect block takes ZERO health', late.s.fighters[1].health === 1, `${late.s.fighters[1].health}`);
  check('perfect block costs ZERO stamina (the hit chip is waived)', late.s.fighters[1].stamina === 1, `${late.s.fighters[1].stamina}`);
  check('…but it still absorbs the punch: the defender is staggered', late.evs.some(e => e.type === 'hurt' && e.side === 1) && late.s.fighters[1].pos.x > MID / 2 + 1e-4);
  check('hit-stop on a perfect block = perfectBlockHitStop', near(trace[L].hs, cfg.perfectBlockHitStop, 1e-9), `${trace[L].hs}`);
  check('the ATTACKER is pinned exposed: counterWindow opens at perfectBlockPunishDuration', near(trace[L].w0, cfg.perfectBlockPunishDuration, 1e-9) && trace[L + 1].v0 >= cfg.perfectBlockPunishVuln - 1e-9, `window ${trace[L].w0}, v ${trace[L + 1].v0.toFixed(3)}`);
  const after = trace.find(t => t.i > L && t.p0 === null);
  check('the spike HOLDS the attacker exposed after its punch has finished', after && after.w0 > 0 && near(after.v0, cfg.perfectBlockPunishVuln, 1e-9), `at tick ${after?.i}: v ${after?.v0.toFixed(3)}, ${after?.w0.toFixed(3)} s left`);
  check('blocking forces vulnerability to 0, even over the spike', trace[25].b0 && trace[25].v0 === 0 && trace[25].w0 > 0);
  check('…and it is back the tick the guard drops', !trace[28].b0 && near(trace[28].v0, cfg.perfectBlockPunishVuln, 1e-9), `${trace[28].v0}`);
  const expire = trace.find(t => t.i > L && t.w0 === 0);
  check('the spike expires on its own clock and exposure returns to 0', expire && expire.v0 === 0 && expire.i > L + T(cfg.perfectBlockPunishDuration) - 2, `at tick ${expire?.i}`);
  // A landing inside the perfect block's window hits harder (the exposure) but is NOT a counter: only a slip's window is (2026-09-22).
  const pbCounter = run(fresh(MID, QUIET), 70, i => [inp({ jab: i === 0 }), inp({ block: i >= L - 1 && i < L + 2, cross: i === L + 4 })], null, QUIET);
  const pbLand = pbCounter.evs.find(e => e.type === 'punchLand' && e.side === 1);
  const pbCold = run(fresh(MID, QUIET), 70, i => [NONE, inp({ cross: i === L + 4 })], null, QUIET).evs.find(e => e.type === 'punchLand' && e.side === 1);
  check('a cross into the perfect block\'s window lands harder than a cold one…', pbLand && pbCold && pbLand.power > pbCold.power * 1.3, `${pbLand?.power.toFixed(3)} vs ${pbCold?.power.toFixed(3)}`);
  check('…but is NOT flagged a counter and fires no counter event (only a slip\'s window counts)', pbLand && pbLand.counter === false && !pbCounter.evs.some(e => e.type === 'counter'));
  // Nor is a hit into the attacker's own exposure mid-punch.
  const mid = run(fresh(MID, QUIET), 40, i => [inp({ hook: i === 0 }), inp({ jab: i === 0 })], null, QUIET);
  const midLand = mid.evs.find(e => e.type === 'punchLand' && e.side === 1);
  check('a jab into a hook\'s wind-up is not a counter either', midLand && midLand.counter === false && !mid.evs.some(e => e.type === 'counter'), `${midLand?.counter}`);

  // Early guard: up since before the punch, older than the window at the impact.
  const early = run(fresh(MID, QUIET), 40, i => [inp({ jab: i === 0 }), inp({ block: true })], null, QUIET);
  check('a guard older than the window is an ordinary block', early.evs.some(e => e.type === 'punchBlock' && e.tick === L) && !early.evs.some(e => e.type === 'perfectBlock'));
  // Overhaul 2026-11-11 (chip is for HEAVY shots): a blocked jab costs guard and wind, not health; a blocked cross still chips.
  check('an ordinary blocked jab takes no health (light shot) but wears the guard meter', early.s.fighters[1].health === 1 && early.s.fighters[1].guardHp < 1, `health ${early.s.fighters[1].health}, guard ${early.s.fighters[1].guardHp}`);
  const earlyCross = run(fresh(MID, QUIET), 40, i => [inp({ cross: i === 0 }), inp({ block: true })], null, QUIET);
  check('an ordinary blocked cross still takes chip health', earlyCross.evs.some(e => e.type === 'punchBlock' && e.chip > 0) && earlyCross.s.fighters[1].health < 1);
  check('an ordinary block does NOT spike the attacker', early.s.fighters[0].counterWindow === 0);
  // The late bound is the tighter of the two for a jab.
  check(`for a jab the bound is the late fraction (${lateBound.toFixed(3)} s), under the flat window`, lateBound < cfg.perfectBlockWindow);
  const edge = Math.floor(lateBound / SIM_DT);   // guard age in ticks at the impact
  const at = age => run(fresh(MID, QUIET), 40, i => [inp({ jab: i === 0 }), inp({ block: i >= L - age })], null, QUIET).evs;
  check('a guard exactly as old as the bound is still perfect', at(edge).some(e => e.type === 'perfectBlock'));
  check('one tick older is ordinary', at(edge + 1).some(e => e.type === 'punchBlock'));
}

// ── 4. The AI's zero-latency reactive block is NOT a perfect block ──────────
// (aiReactionTime 0 = the tick-after block this section is about; with the
// 2026-09-16 default of 0.2 s the guard comes up after a jab has landed.)
{
  const c = { ...QUIET, aiBlockChance: 1, aiReactionTime: 0 };
  let s = fresh(MID, c);
  let a = ai.createAi(1, 7, c);
  const evs = [];
  let age = null;
  for (let i = 0; i < 40; i++) {
    const d = ai.aiStep(a, s, c); a = d.ai;
    const r = sim.step(s, [inp({ jab: i === 0 }), d.input], c);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (r.events.some(e => e.type === 'punchBlock' || e.type === 'perfectBlock')) age = s.fighters[1].blockT;
  }
  const first = evs.find(e => e.type === 'punchBlock' || e.type === 'perfectBlock' || e.type === 'punchLand');
  check('the AI raised its guard against the jab', first && first.type !== 'punchLand', first?.type);
  check('…and that reaction-to-the-start is an ORDINARY block, not a perfect one (v1 finding fixed by perfectBlockLateFrac)', first?.type === 'punchBlock', `${first?.type}, guard age ${age?.toFixed(3)} s`);
}

// ── 5. Slip punish, and a post-slip counter vs a cold one ───────────────────
{
  // skelOn false (anim Phase 1.1): on the rigid skeleton the whiffed jab is held at reach in line, and the counter cross brushes the rear guard glove — "through the guard", clean not flush (LOG_SKELETON.md, behavioural shifts).
  const Q5 = { ...QUIET, skelOn: false };
  const ctrlPos = [];
  run(fresh(MID, Q5), 40, tap('jab'), st => ctrlPos.push({ x: st.fighters[1].pos.x, z: st.fighters[1].pos.z }), Q5);
  const start = L - 8, release = start + 3;
  const trace = [];
  let s = fresh(MID, Q5);
  const evs = [];
  const COUNTER_AT = L + 3;
  for (let i = 0; i < 70; i++) {
    // The counter is a CROSS (2026-09-19): with soft arms a counter jab met the
    // attacker's rear guard glove resting on its cheek and was absorbed as a
    // block; the cross comes to the lead side, which the whiffed jab left open.
    const r = sim.step(s, [inp({ jab: i === 0 }), inp({ cross: i === COUNTER_AT, move: { x: i >= start && i < release ? -1 : 0, y: 0 } })], Q5);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (i >= start && i <= release + 1) { s.fighters[1].pos = { ...ctrlPos[i] }; s.fighters[1].vel = { x: 0, z: 0 }; }
    trace.push({ i, v0: s.fighters[0].vuln, w0: s.fighters[0].counterWindow, p0: s.fighters[0].punch.type, hs: s.hitStop });
  }
  check('the jab was slipped', evs.some(e => e.type === 'slip' && e.dodged && e.tick === L));
  check('a slip opens a punish window on the ATTACKER at slipPunishDuration', near(trace[L].w0, cfg.slipPunishDuration, 1e-9), `${trace[L].w0}`);
  const after = trace.find(t => t.i > L && t.p0 === null);
  check('the spike survives the attacker\'s stretched whiff recovery', after && after.w0 > 0 && near(after.v0, cfg.slipPunishVuln, 1e-9), `punch ended tick ${after?.i}: v ${after?.v0}, ${after?.w0.toFixed(2)} s left`);
  const hot = evs.find(e => e.type === 'punchLand' && e.side === 1);
  const hotHurt = evs.find(e => e.type === 'hurt' && e.side === 0);
  const cold = run(fresh(MID, Q5), 70, i => [NONE, inp({ cross: i === COUNTER_AT })], null, Q5);
  const coldHurt = cold.evs.find(e => e.type === 'hurt' && e.side === 0);
  const vAtHit = trace[hot?.tick]?.v0;
  const ratio = v3len(hotHurt.impulse) / v3len(coldHurt.impulse);
  check('the post-slip counter lands on a target at full exposure', hot && near(vAtHit, cfg.slipPunishVuln, 1e-9), `v ${vAtHit}`);
  // Overhaul 2026-11-11: a square counter on a fully exposed target is FLUSH, which multiplies on top (gradeFlushPower) and sets its own hit-stop tier.
  check('the counter is graded FLUSH (a square shot on a fully exposed target)', hot.grade === 'flush', hot.grade);
  check('its impulse is (1 + vulnerability × counterImpulseBonus) × gradeFlushPower times a cold one', near(ratio, (1 + vAtHit * cfg.counterImpulseBonus) * cfg.gradeFlushPower, 1e-6), `${ratio.toFixed(3)}x`);
  check('the land is flagged as a counter and a counter event fires', hot.counter === true && evs.some(e => e.type === 'counter' && e.side === 1 && e.target === 0 && e.tick === hot.tick));
  check('a cold hit is not a counter', cold.evs.find(e => e.type === 'punchLand').counter === false && !cold.evs.some(e => e.type === 'counter'));
  const coldStop = cold.evs.find(e => e.type === 'punchLand').tick;
  let coldHs = null; run(fresh(MID, Q5), coldStop + 1, i => [NONE, inp({ jab: i === COUNTER_AT })], (st, i) => { if (i === coldStop) coldHs = st.hitStop; }, Q5);
  // (The rock the counter causes can raise the hit-stop to stunHitStop; the counter's own is the flush tier + the bonus.)
  check('the counter adds counterHitStopBonus × vulnerability of hit-stop on top of the flush tier', trace[hot.tick].hs > coldHs && near(trace[hot.tick].hs, Math.max(cfg.stunHitStop, cfg.hitStopFlush + vAtHit * cfg.counterHitStopBonus), 1e-6), `${trace[hot.tick].hs.toFixed(3)} vs cold ${coldHs?.toFixed(3)}`);
  // An out-of-range whiff opens NO punish window.
  const far = run(fresh(1.1, QUIET), 40, tap('jab'), null, QUIET);
  check('an out-of-range whiff opens NO punish window', far.evs.some(e => e.type === 'punchWhiff') && far.s.fighters[0].counterWindow === 0);
}

// ── 6. A knockdown clears the spike ─────────────────────────────────────────
{
  let s = fresh(MID, QUIET);
  s.fighters[0].health = 0.001;
  const { s: kd, evs } = run(s, 60, i => [inp({ jab: i === 0 }), inp({ block: i >= L - 1 && i < L + 4, jab: i === L + 6 })], null, QUIET);
  check('perfect block, then the counter floors the attacker', evs.some(e => e.type === 'perfectBlock') && evs.some(e => e.type === 'knockdown' && e.side === 0));
  check('the knockdown clears the punish window and the exposure', kd.fighters[0].counterWindow === 0 && kd.fighters[0].vuln === 0);
}

// ── 7. The ceiling: no single punch can take a full bar ─────────────────────
{
  const mass = ROSTER[0].massKg;
  const base = cfg.punchImpulseBase + mass * cfg.moveSpeed * cfg.punchMomentumScale;
  const lean = 1 + cfg.punchLean * 0.4 * cfg.punchLeanScale;   // uppercut lean 0.4
  const max = base * lean * cfg.uppercutImpulseMult * (1 + cfg.vulnerabilityPeak * cfg.counterImpulseBonus);
  const dmg = max * cfg.healthDamagePerImpulse;
  console.log(`     ceiling: a full-speed uppercut countering at v=1 ≈ ${max.toFixed(0)} N·s → ${(dmg * 100).toFixed(0)}% of the bar (${Math.ceil(1 / dmg)} such hits to a knockdown)`);
  check('a maximum-force counter cannot one-shot from full health', dmg < 1, `${(dmg * 100).toFixed(0)}%`);
}

// ── 8. Determinism ──────────────────────────────────────────────────────────
{
  const script = i => [inp({ jab: i === 0 || i === 30, move: { x: i > 18 && i < 21 ? -1 : 0, y: 0 } }), inp({ block: i >= L - 1 && i < L + 3, cross: i === 22 })];
  const a = run(fresh(), 80, script), b = run(fresh(), 80, script);
  check('two runs through perfect block, slip and counter are identical', JSON.stringify(a.s) === JSON.stringify(b.s) && JSON.stringify(a.evs) === JSON.stringify(b.evs));
  check('no NaN anywhere in the state', !isNaNDeep(a.s));
}

done();

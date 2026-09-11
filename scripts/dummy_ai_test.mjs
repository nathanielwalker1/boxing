/**
 * dummy_ai_test.mjs — the opponent AI (port of legacy dummy_ai_test, in Node
 * against the sim + src/ai, no browser). Covers the four heuristics:
 *   1. Standoff steer  — advances when far, settles in the landing band, no jitter
 *                        (asserted as velocity sign flips, not drift — legacy 4bb4f4e)
 *   2. Range gating    — the timer only ARMS; the throw needs the opponent in range
 *   3. Reactive block  — probability-driven, mutually exclusive with punching
 *   4. Opening punish  — the aggression multiplier raises the cadence when exposed
 * plus determinism: same seed + same inputs = identical AI and sim state.
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim, ai] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT } = core;
// No knockdowns: a knockdown freezes the fight for the count, which would
// stall the long series below (v1 did the same with healthDamagePerForce = 0).
const base = { ...createConfig(), healthDamagePerImpulse: 0 };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const ticks = sec => Math.round(sec / SIM_DT);

/** A fresh fight (fighters 2.4 m apart) and a fresh AI on side 1. */
function fresh(cfg, seed = 1) {
  return { s: sim.createState(specs, cfg, seed), a: ai.createAi(1, seed, cfg), cfg, evs: [], throws: [], last: NONE };
}
/** Step n ticks: AI decides side 1, `player(i)` is side 0. Records events (with tick), throw commits, the last AI input. */
function run(w, n, player = () => NONE, onTick) {
  for (let i = 0; i < n; i++) {
    const d = ai.aiStep(w.a, w.s, w.cfg);
    if (d.ai.throwCount > w.a.throwCount) w.throws.push({ tick: w.s.tick, dist: d.ai.lastThrowDist });
    w.a = d.ai; w.last = d.input;
    const r = sim.step(w.s, [player(i), d.input], w.cfg);
    w.s = r.state;
    for (const e of r.events) w.evs.push({ ...e, tick: w.s.tick });
    if (onTick?.(w, i) === true) break;
  }
  return w;
}
/** Run until pred(w) or `limit` seconds. */
const runUntil = (w, pred, limit, player) => { run(w, ticks(limit), player, x => pred(x)); return w; };
const me = w => w.s.fighters[1];
const you = w => w.s.fighters[0];
const dist = w => Math.hypot(me(w).pos.x - you(w).pos.x, me(w).pos.z - you(w).pos.z);
/** Velocity component along the line to the opponent (the approach axis), signed. */
const approachVel = w => {
  const d = dist(w); if (d < 1e-6) return 0;
  const ux = (you(w).pos.x - me(w).pos.x) / d, uz = (you(w).pos.z - me(w).pos.z) / d;
  return me(w).vel.x * ux + me(w).vel.z * uz;
};
const signFlips = vs => { let n = 0; for (let i = 1; i < vs.length; i++) if (vs[i - 1] !== 0 && vs[i] !== 0 && Math.sign(vs[i - 1]) !== Math.sign(vs[i])) n++; return n; };
const sample = (w, count, every, fn) => { const out = []; for (let i = 0; i < count; i++) { run(w, ticks(every)); out.push(fn(w)); } return out; };

// ─── 1. Standoff steer ────────────────────────────────────────────────────────
console.log('\n=== 1. Standoff steer ===');
{
  const cfg = { ...base, aiAttackDelayMin: 999, aiAttackDelayMax: 999 };
  const w = fresh(cfg);
  const d0 = dist(w);
  run(w, ticks(1.3));
  const d1 = dist(w);
  check('advances when out of range', d1 < d0 - 0.5, `${d0.toFixed(2)} → ${d1.toFixed(2)} m`);

  const trace = sample(w, 30, 0.1, x => ({ d: dist(x), v: approachVel(x) }));
  const ds = trace.map(t => t.d), flips = signFlips(trace.map(t => t.v));
  const spread = Math.max(...ds) - Math.min(...ds), hold = ds[ds.length - 1];
  check('settles without jitter (no approach-velocity sign flips)', flips === 0, `${flips} flips, spread ${(spread * 100).toFixed(1)} cm`);
  check('holds inside the landing band', hold > cfg.smotherDist && hold < cfg.aiEngageDist,
    `holds ${hold.toFixed(2)} m (band ${cfg.smotherDist}–${cfg.aiEngageDist}, standoff ${cfg.aiStandoffDist} ± ${cfg.aiStandoffBand})`);
  check('…and no farther than standoff + band', hold <= cfg.aiStandoffDist + cfg.aiStandoffBand + 0.02, `${hold.toFixed(3)} m`);

  // Cornered: the player walks straight into it until it is pinned at the
  // ropes — the case where naive steering vibrates. Straight, not diagonal:
  // the stick is yaw-relative, so a diagonal push has the pair circling the
  // ring instead. A long settle first (the transit is drift, not jitter).
  const push = () => inp({ move: { x: 0, y: 1 } });
  run(w, ticks(4.5), push);
  const corner = sample(w, 20, 0.1, x => ({ d: dist(x), v: approachVel(x), p: { ...me(x).pos } }));
  // Advance one tick between samples under the same push so the last sample matches.
  const cflips = signFlips(corner.map(t => t.v));
  const cds = corner.map(t => t.d), cspread = Math.max(...cds) - Math.min(...cds);
  const b = core.RING_HALF - cfg.ringInset, p = corner[corner.length - 1].p;
  check('is actually pinned at the ropes', Math.abs(p.x) > b - 0.02 || Math.abs(p.z) > b - 0.02, `at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}), bound ±${b.toFixed(2)}`);
  check('no jitter when cornered', cflips === 0 && cspread < 0.05, `${cflips} flips, spread ${(cspread * 100).toFixed(1)} cm, holds ${cds[cds.length - 1].toFixed(2)} m`);
}

// ─── 2. Range-gated attacks ───────────────────────────────────────────────────
console.log('\n=== 2. Range-gated attacks ===');
{
  // Pinned (no walking) with a quick cadence: it arms and then waits.
  const pinned = { ...base, aiSpeedScale: 0, aiAttackDelayMin: 0.3, aiAttackDelayMax: 0.4 };
  const w = fresh(pinned);
  w.a = { ...w.a, attackTimer: 0.1 };
  run(w, ticks(4));
  check('does not throw while out of range', w.throws.length === 0, `dist ${dist(w).toFixed(2)} > engage ${pinned.aiEngageDist}, ${w.throws.length} throws`);
  check('timer holds armed at 0 waiting for range', w.a.attackTimer === 0, `attackTimer=${w.a.attackTimer.toFixed(2)}`);

  // Let it walk: every throw starts inside ITS punch's landing band, and each commit is a real punchStart.
  w.cfg = { ...pinned, aiSpeedScale: base.aiSpeedScale };
  run(w, ticks(20));
  const starts = w.evs.filter(e => e.type === 'punchStart' && e.side === 1);
  const band = t => [ai.nearDist(t, w.cfg), ai.engageDist(t, w.cfg)];
  const outOfBand = w.throws.filter((t, i) => { const [lo, hi] = band(starts[i]?.punch ?? 'jab'); return t.dist > hi + 0.005 || t.dist < lo - 0.005; });
  const types = new Set(starts.map(e => e.punch));
  check('throws once it has closed into range', w.throws.length > 0, `${w.throws.length} throws`);
  check('every commit fires a punchStart on side 1 (the one-tick edge works)', starts.length === w.throws.length, `${starts.length} starts vs ${w.throws.length} commits`);
  check('every throw starts inside its own punch\'s landing band', outOfBand.length === 0,
    starts.map((e, i) => `${e.punch}@${w.throws[i].dist.toFixed(2)}`).join(', '));
  check('it throws all four punches', types.size === 4, `${[...types].join(', ')} over ${starts.length} throws`);
  const hooks = starts.filter(e => e.punch === 'hook' || e.punch === 'uppercut');
  check('hooks and uppercuts come from both hands', new Set(hooks.map(e => e.hand)).size === 2, hooks.map(e => `${e.punch}:${e.hand}`).join(', '));

  // Weights: jab only → only jabs.
  const jo = fresh({ ...pinned, aiSpeedScale: base.aiSpeedScale, aiCrossWeight: 0, aiHookWeight: 0, aiUppercutWeight: 0 });
  run(jo, ticks(10));
  const joStarts = jo.evs.filter(e => e.type === 'punchStart' && e.side === 1);
  check('weights: jab-only throws only jabs', joStarts.length > 3 && joStarts.every(e => e.punch === 'jab'), `${joStarts.length} throws`);

  // A short punch steps in: armed with an uppercut from the resting standoff
  // (out of uppercut range) it closes to uppercut range and throws it.
  const up = fresh({ ...base, aiAttackDelayMin: 999, aiAttackDelayMax: 999, aiJabWeight: 0, aiCrossWeight: 0, aiHookWeight: 0, aiUppercutWeight: 1 });
  runUntil(up, x => dist(x) <= x.cfg.aiEngageDist, 15); run(up, ticks(1));
  const restD = dist(up);
  up.a = { ...up.a, attackTimer: 0 };
  runUntil(up, x => x.throws.length > 0, 4);
  const upStart = up.evs.find(e => e.type === 'punchStart' && e.side === 1);
  check('armed with an uppercut it steps in from the standoff and throws it', restD > up.cfg.aiUppercutEngageDist && upStart?.punch === 'uppercut' && up.throws[0]?.dist <= up.cfg.aiUppercutEngageDist,
    `rested at ${restD.toFixed(2)} m, threw ${upStart?.punch ?? 'nothing'} at ${up.throws[0]?.dist.toFixed(2) ?? '-'} m`);
  run(up, ticks(3));
  check('…then drifts back out toward the standoff', dist(up) > up.cfg.aiUppercutEngageDist, `${dist(up).toFixed(2)} m`);

  // Down: no intent at all.
  const dn = fresh(base);
  dn.s.fighters[0].pos = { x: -0.4, z: 0 }; dn.s.fighters[1].pos = { x: 0.4, z: 0 };
  dn.s.fighters[1].down = true;
  dn.a = { ...dn.a, attackTimer: 0 };
  run(dn, 30, () => inp({ jab: true }), x => { x.s.fighters[1].down = true; });
  const idle = i => !i.jab && !i.block && i.move.x === 0 && i.move.y === 0;
  check('down: no throw, no block, no steer', dn.throws.length === 0 && idle(dn.last), JSON.stringify(dn.last));
}

// ─── 3. Reactive block ────────────────────────────────────────────────────────
console.log('\n=== 3. Reactive block ===');
const settle = w => {
  runUntil(w, x => dist(x) <= x.cfg.aiEngageDist, 15);
  run(w, ticks(0.3));
  return w;
};
// One jab, then wait for the punch to resolve AND the guard to be genuinely
// down again — a condition, not a duration (legacy: hit-stop made a fixed gap flaky).
function jabSeries(chance, count) {
  const cfg = { ...base, aiBlockChance: chance, aiAttackDelayMin: 999, aiAttackDelayMax: 999 };
  const w = settle(fresh(cfg));
  w.a = { ...w.a, attackTimer: 999, armed: null };   // it may have armed during the walk-in
  w.evs.length = 0;
  for (let i = 0; i < count; i++) {
    run(w, 1, () => inp({ jab: true }));
    run(w, ticks(0.6));
    runUntil(w, x => x.a.blockTimer === 0 && you(x).punch.type === null, 6);
  }
  const mine = w.evs.filter(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchBlock' || e.type === 'punchWhiff'));
  const inRange = mine.filter(e => e.type !== 'punchWhiff').length;
  const blocked = mine.filter(e => e.type === 'punchBlock').length;
  return { w, inRange, blocked, total: mine.length };
}
{
  const always = jabSeries(1.0, 6);
  check('chance 1.0 blocks every in-range punch', always.blocked === always.inRange && always.inRange > 0, `${always.blocked}/${always.inRange} blocked (${always.total} thrown)`);

  // Guard timing: up the tick after the punch starts, down once the window expires.
  const w = always.w;
  run(w, 1, () => inp({ jab: true }));
  run(w, 1);
  check('guard is up the tick after the opponent\'s punch starts', w.last.block && me(w).block, `input.block=${w.last.block}, state.block=${me(w).block}`);
  run(w, ticks(0.6));
  check('guard drops when the window expires', !w.last.block && !me(w).block && w.a.blockTimer === 0);

  // Locked rule: blocking and punching are mutually exclusive — for the AI too.
  // Arm it (with a straight, so it throws from where it stands), let it throw,
  // and jab into its wind-up: it must not guard.
  runUntil(w, x => you(x).punch.type === null && me(x).punch.type === null, 3);
  w.a = { ...w.a, attackTimer: 0, armed: 'jab' };
  runUntil(w, x => me(x).punch.type !== null, 2);
  const threw = me(w).punch.type !== null;
  let guarded = false, inFlight = 0;
  run(w, 20, i => inp({ jab: i === 0 }), x => { if (me(x).punch.type !== null) { inFlight++; if (x.last.block || me(x).block) guarded = true; } });
  check('cannot guard while its own punch is in flight', threw && inFlight > 3 && !guarded, `threw=${threw}, ${inFlight} ticks in flight, guarded=${guarded}`);

  const never = jabSeries(0.0, 6);
  check('chance 0.0 never blocks', never.blocked === 0 && never.inRange > 0, `${never.blocked}/${never.inRange} blocked`);

  const N = 20;
  const mixed = jabSeries(base.aiBlockChance, N);
  check(`default chance ${base.aiBlockChance} is probability-driven (some, not all)`, mixed.blocked > 0 && mixed.blocked < mixed.inRange,
    `${mixed.blocked}/${mixed.inRange} in-range punches blocked (~${(mixed.blocked / Math.max(1, mixed.inRange) * 100).toFixed(0)}%, nominal ${base.aiBlockChance * 100}%)`);
  console.log(`     ${mixed.total - mixed.inRange}/${mixed.total} jabs whiffed (thrown from out of range after the previous one knocked it back)`);
}

// ─── 4. Punishing openings ────────────────────────────────────────────────────
console.log('\n=== 4. Punishing openings ===');
// Fixed base delay, no reactive guard, so the only variable is the aggression multiplier.
function cadence({ lowStamina, blocking }, seconds) {
  // staminaBlockDrain 0: 12 s of held guard would otherwise gas the player and
  // trip the low-stamina term in the very case that is meant to be baseline.
  const cfg = { ...base, aiAttackDelayMin: 3, aiAttackDelayMax: 3, aiBlockChance: 0, staminaBlockDrain: 0 };
  const w = settle(fresh(cfg));
  const before = w.throws.length;
  const player = blocking ? () => inp({ block: true }) : () => NONE;
  run(w, ticks(seconds), player, x => { if (lowStamina) x.s.fighters[0].stamina = 0.1; });
  return { throws: w.throws.length - before, agg: w.a.aggression };
}
{
  const WINDOW = 12;
  const guarded = cadence({ lowStamina: false, blocking: true }, WINDOW);
  const exposed = cadence({ lowStamina: false, blocking: false }, WINDOW);
  const gassed = cadence({ lowStamina: true, blocking: false }, WINDOW);
  console.log(`     guarded ${guarded.throws} throws (aggression ${guarded.agg.toFixed(2)}) · unguarded ${exposed.throws} (${exposed.agg.toFixed(2)}) · unguarded + gassed ${gassed.throws} (${gassed.agg.toFixed(2)}) in ${WINDOW} s`);
  check('guard up = baseline aggression', near(guarded.agg, 1, 0.01), `${guarded.agg.toFixed(2)}`);
  check('unguarded in range raises aggression', near(exposed.agg, base.aiAggressionMult, 1e-9), `${exposed.agg.toFixed(2)}`);
  check('low stamina stacks on top', near(gassed.agg, base.aiAggressionMult ** 2, 1e-9), `${gassed.agg.toFixed(2)}`);
  check('a gassed opponent is visibly punched more often', gassed.throws > guarded.throws, `${guarded.throws} → ${gassed.throws} throws`);
}

// ─── 5. Determinism ───────────────────────────────────────────────────────────
console.log('\n=== 5. Determinism ===');
{
  const fight = seed => { const w = fresh(base, seed); run(w, ticks(10), i => inp({ jab: i % 90 === 0, move: { x: 0, y: i % 200 < 60 ? 1 : 0 } })); return w; };
  const a = fight(3), b = fight(3), c = fight(4);
  check('same seed, same inputs → identical AI state', JSON.stringify(a.a) === JSON.stringify(b.a));
  check('…and identical sim state', JSON.stringify(a.s) === JSON.stringify(b.s));
  check('…with the same throw ticks', JSON.stringify(a.throws) === JSON.stringify(b.throws), `${a.throws.length} throws`);
  check('a different seed changes the cadence', JSON.stringify(a.throws) !== JSON.stringify(c.throws));
  check('AI state survives a JSON round trip (serialisable, no methods)', JSON.stringify(JSON.parse(JSON.stringify(a.a))) === JSON.stringify(a.a));
  const s0 = fresh(base, 5), snap = JSON.stringify(s0.s) + JSON.stringify(s0.a);
  ai.aiStep(s0.a, s0.s, base);
  check('aiStep mutates neither its AI state nor the sim state', JSON.stringify(s0.s) + JSON.stringify(s0.a) === snap);
}

done();

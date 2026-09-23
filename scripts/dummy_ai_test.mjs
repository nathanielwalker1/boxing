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
// Press-only footwork (2026-09-16): §1–5 pin the four v1 heuristics, which
// the footwork modes sit on top of; §6 covers the modes with the defaults.
const defaults = { ...createConfig(), healthDamagePerImpulse: 0 };
// …and no reaction lag, rush response, chase delay or bursts either (§7 covers those).
// …nor the hit-state reads (§8): the stumble multiplier would otherwise stack onto §4's aggression numbers.
const base = { ...defaults, aiProbeWeight: 0, aiCircleWeight: 0, aiHoldWeight: 0, aiResetChance: 0, aiHitResetChance: 0, aiReactionTime: 0, aiPressureSpeed: 999, aiChaseDelay: 0, aiComboChance: 0, aiCounterChance: 0, aiCoverChance: 0, aiStumbleSpeed: 999 };
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
  // The peak aggression over the run: a stumble (2026-09-16) can leave the player out of range on the last tick.
  let agg = 0;
  // (skip the first ticks: the AI reads the player's guard from the previous tick, before the held block is applied)
  run(w, ticks(seconds), player, (x, i) => { if (lowStamina) x.s.fighters[0].stamina = 0.1; if (i > 2) agg = Math.max(agg, x.a.aggression); });
  return { throws: w.throws.length - before, agg };
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

// ─── 6. Footwork modes (2026-09-16) ───────────────────────────────────────────
console.log('\n=== 6. Footwork modes ===');
{
  // A long spar with the defaults against a player who stands still: it must
  // spend real time out of range (the space Nate asked for), circle, and reset.
  const w = fresh(defaults, 2);
  const trace = [];
  run(w, ticks(40), () => NONE, x => { trace.push({ mode: x.a.mode, d: dist(x), lat: x.last.move.x, tick: x.s.tick }); });
  const modes = new Set(trace.map(t => t.mode));
  const far = trace.filter(t => t.d > defaults.aiEngageDist + 0.05).length / trace.length;
  const circling = trace.filter(t => t.mode === 'circle');
  const meanLat = circling.reduce((s, t) => s + Math.abs(t.lat), 0) / Math.max(1, circling.length);
  const share = m => (trace.filter(t => t.mode === m).length / trace.length * 100).toFixed(0);
  console.log(`     press ${share('press')}% · probe ${share('probe')}% · circle ${share('circle')}% · hold ${share('hold')}% · reset ${share('reset')}% · ${w.throws.length} throws in 40 s`);
  check('uses at least four of the five modes in 40 s', modes.size >= 4, [...modes].join(', '));
  check('spends at least 20% of the time out of its own range (gives space)', far >= 0.2, `${(far * 100).toFixed(0)}% beyond ${(defaults.aiEngageDist + 0.05).toFixed(2)} m`);
  check('…but still fights: throws punches', w.throws.length >= 6, `${w.throws.length}`);
  check('circling pushes the stick sideways', circling.length > 0 && meanLat > 0.3, `mean |x| ${meanLat.toFixed(2)} over ${circling.length} ticks`);
  const resets = trace.filter((t, i) => t.mode === 'reset' && i > 0 && trace[i - 1].mode !== 'reset');
  check('resets happen (after a throw or a hit)', resets.length >= 1, `${resets.length}`);
  // Each reset actually opens the distance: from its start, within aiResetTime it is out past aiEngageDist.
  const opened = resets.filter(r => { const end = trace.find(t => t.tick >= r.tick + ticks(defaults.aiResetTime) - 1); return end && end.d > defaults.aiEngageDist; });
  check('a reset steps out beyond engage range', resets.length > 0 && opened.length >= Math.ceil(resets.length * 0.6), `${opened.length}/${resets.length} opened`);

  // Probe: parked out of range, it steps in to throw and drifts back out.
  const pr = fresh({ ...defaults, aiPressWeight: 0, aiCircleWeight: 0, aiHoldWeight: 0, aiResetChance: 0, aiAttackDelayMin: 999, aiAttackDelayMax: 999 }, 3);
  runUntil(pr, x => x.a.mode === 'probe', 5); run(pr, ticks(6));
  const restD = dist(pr);
  check('probe rests outside its jab range', pr.a.mode === 'probe' && restD > defaults.aiEngageDist, `${restD.toFixed(2)} m vs engage ${defaults.aiEngageDist}`);
  pr.a = { ...pr.a, attackTimer: 0, armed: 'jab' };
  runUntil(pr, x => x.throws.length > 0, 4);
  check('…steps in to throw', pr.throws.length === 1 && pr.throws[0].dist <= defaults.aiEngageDist, `threw at ${pr.throws[0]?.dist.toFixed(2) ?? '-'} m`);
  run(pr, ticks(2.5));
  check('…and drifts back out', dist(pr) > defaults.aiEngageDist, `${dist(pr).toFixed(2)} m`);

  // Hold: no steering, however far the player is.
  const hd = fresh({ ...defaults, aiPressWeight: 0, aiProbeWeight: 0, aiCircleWeight: 0, aiResetChance: 0, aiAttackDelayMin: 999, aiAttackDelayMax: 999 }, 4);
  runUntil(hd, x => x.a.mode === 'hold', 5);
  let steered = false; run(hd, 10, () => NONE, x => { if (x.last.move.x !== 0 || x.last.move.y !== 0) steered = true; });
  check('hold: the stick is centred', hd.a.mode === 'hold' && !steered);

  // Momentum: with the glide of the new friction it still arrives inside the band, not through it.
  const pw = fresh(base, 5);
  runUntil(pw, x => dist(x) <= x.cfg.aiStandoffDist + x.cfg.aiStandoffBand, 10);
  let minD = Infinity; run(pw, ticks(1.5), () => NONE, x => { minD = Math.min(minD, dist(x)); });
  check('press: the walk-in settles inside the band without gliding through it', minD >= base.aiStandoffDist - base.aiStandoffBand - 0.03, `min ${minD.toFixed(2)} m, band ${(base.aiStandoffDist - base.aiStandoffBand).toFixed(2)}–${(base.aiStandoffDist + base.aiStandoffBand).toFixed(2)}`);

  // Determinism with the modes on.
  const spar = seed => { const x = fresh(defaults, seed); run(x, ticks(15), i => inp({ jab: i % 120 === 0 })); return x; };
  const a = spar(9), b = spar(9);
  check('modes are seeded: same seed → same modes and throws', JSON.stringify(a.a) === JSON.stringify(b.a) && JSON.stringify(a.throws) === JSON.stringify(b.throws));
}

// ─── 7. Reading the opponent (2026-09-16) ─────────────────────────────────────
console.log('\n=== 7. Reaction time, rush, retreat, bursts ===');
{
  // Reaction time: with aiReactionTime 0.2 and chance 1 the guard comes up
  // ~12 ticks after the punch starts, not the tick after.
  const guardDelay = rt => {
    const w = settle(fresh({ ...base, aiBlockChance: 1, aiReactionTime: rt, aiAttackDelayMin: 999, aiAttackDelayMax: 999 }));
    w.a = { ...w.a, attackTimer: 999, armed: null };
    run(w, 1, () => inp({ jab: true }));
    let n = 0; run(w, 30, () => NONE, x => { n++; return me(x).block; });
    return me(w).block ? n : -1;
  };
  const late = guardDelay(0.2), instant = guardDelay(0);
  // 12 ticks of reaction on the sim clock, plus the hit-stop of the jab landing meanwhile (~3 ticks near-frozen).
  check('aiReactionTime 0.2: the guard comes up ~12 ticks (plus the jab\'s hit-stop) after the punch starts', late >= 11 && late <= 18, `${late} ticks`);
  check('aiReactionTime 0: the tick after, as before', instant === 1, `${instant} ticks`);

  // Perception lag: the player is teleported deep inside the standoff; the
  // old AI backed off on the next tick, the lagged one takes a beat to notice.
  const noticeDelay = rt => {
    const w = settle(fresh({ ...base, aiReactionTime: rt, aiAttackDelayMin: 999, aiAttackDelayMax: 999 }));
    const d = dist(w); const ux = (you(w).pos.x - me(w).pos.x) / d, uz = (you(w).pos.z - me(w).pos.z) / d;
    w.s.fighters[0].pos = { x: me(w).pos.x + ux * 0.45, z: me(w).pos.z + uz * 0.45 };
    let n = 0; run(w, 30, () => NONE, x => { n++; return x.last.move.y < -0.05; });
    return n;
  };
  const lagN = noticeDelay(0.2), fastN = noticeDelay(0);
  check('a lagged AI takes a beat to notice the player is suddenly close', lagN > fastN + 2, `${lagN} vs ${fastN} ticks before it backs off`);

  // Rush: the player charges from ~1.8 m at an AI that was pinned there.
  // Give-ground 1 → it retreats while still well outside its normal band
  // (its standoff has stepped out by aiGiveGround); give-ground 0 → it fires
  // a jab at them instead.
  const rush = giveChance => {
    const cfg = { ...base, aiPressureSpeed: defaults.aiPressureSpeed, aiGiveGroundChance: giveChance, aiGiveGround: 0.6, aiAttackDelayMin: 999, aiAttackDelayMax: 999 };
    const w = settle(fresh(cfg));
    w.a = { ...w.a, attackTimer: 999, armed: null };
    // back the player out to ~1.8 m with the AI pinned, then charge
    w.cfg = { ...cfg, aiSpeedScale: 0 };
    runUntil(w, x => dist(x) > 1.7, 6, () => inp({ move: { x: 0, y: -1 } }));
    run(w, ticks(1.0));
    w.cfg = cfg;
    w.evs.length = 0;
    let retreatedWhileFar = false, jab = false;
    run(w, ticks(1.2), () => inp({ move: { x: 0, y: 1 } }), x => {
      if (x.last.move.y < -0.05 && dist(x) > cfg.aiStandoffDist + cfg.aiStandoffBand + 0.05) retreatedWhileFar = true;
      if (x.evs.some(e => e.type === 'punchStart' && e.side === 1 && e.punch === 'jab')) jab = true;
    });
    return { retreatedWhileFar, jab, giveGround: w.a.giveGround, cooldown: w.a.pressureCooldown };
  };
  const give = rush(1), fire = rush(0);
  check('rushed with give-ground: it backs off while still outside its band', give.retreatedWhileFar, `giveGround ${give.giveGround.toFixed(2)} s left`);
  // (It may still back off a step as the charge arrives — that is the lookahead, not give-ground.)
  check('rushed without: it stands and fires a jab into the rush', fire.jab && fire.giveGround === 0, `jab=${fire.jab}, giveGround=${fire.giveGround}`);

  // Retreat: the player backs off at speed; for aiChaseDelay the AI does not close.
  {
    const cfg = { ...base, aiPressureSpeed: defaults.aiPressureSpeed, aiChaseDelay: 0.4, aiAttackDelayMin: 999, aiAttackDelayMax: 999 };
    const w = settle(fresh(cfg));
    // The player needs ~4 ticks to pass aiPressureSpeed; from then until the
    // delay has run the AI must not close, after it it must.
    let chasedEarly = false, chasedLater = false;
    run(w, ticks(1.2), i => inp({ move: { x: 0, y: -1 } }), (x, i) => { if (x.last.move.y > 0.05) { if (i >= 6 && i < ticks(0.4) + 4) chasedEarly = true; else if (i >= ticks(0.4) + 4) chasedLater = true; } });
    check('the player backs off fast: no chasing for aiChaseDelay…', !chasedEarly);
    check('…then it follows, even though they are still retreating', chasedLater);
  }

  // Bursts: every throw opens a 3-punch burst → throws come in tight groups.
  {
    const cfg = { ...base, aiComboChance: 1, aiComboMax: 3, aiAttackDelayMin: 2, aiAttackDelayMax: 2, aiAggressionMult: 1, aiJabWeight: 1, aiCrossWeight: 1, aiHookWeight: 0, aiUppercutWeight: 0 };
    const w = settle(fresh(cfg));
    w.a = { ...w.a, attackTimer: 0.1, armed: null };
    run(w, ticks(6));
    const gaps = w.throws.slice(1).map((t, i) => (t.tick - w.throws[i].tick) * SIM_DT);
    const tight = gaps.filter(g => g < 0.5).length, loose = gaps.filter(g => g >= 1.5).length;
    check('bursts: throws come in tight groups (gaps under 0.5 s)…', tight >= 2, `${w.throws.length} throws, gaps ${gaps.map(g => g.toFixed(2)).join(' ')}`);
    check('…separated by the usual wait', loose >= 1, `${loose} long gaps`);
    check('a burst chains through the sim\'s combo window (a gap shorter than a whole punch)', Math.min(...gaps) < cfg.crossCock + cfg.crossExtend + cfg.crossRecover, `min gap ${Math.min(...gaps).toFixed(3)} s`);
    const single = settle(fresh({ ...cfg, aiComboChance: 0 })); single.a = { ...single.a, attackTimer: 0.1, armed: null }; run(single, ticks(6));
    check('aiComboChance 0: single shots', single.throws.length < w.throws.length, `${single.throws.length} vs ${w.throws.length}`);
  }

  // Determinism with everything on.
  const spar = seed => { const x = fresh(defaults, seed); run(x, ticks(15), i => inp({ jab: i % 120 === 0, move: { x: 0, y: i % 300 < 60 ? 1 : i % 300 < 120 ? -1 : 0 } })); return x; };
  const a = spar(11), b = spar(11);
  check('reaction, rush and bursts are seeded: same seed → identical', JSON.stringify(a.a) === JSON.stringify(b.a) && JSON.stringify(a.throws) === JSON.stringify(b.throws));
}

// ─── 8. Reading the hit states (2026-09-22): counter, cover, follow-up ───────
console.log('\n=== 8. Counter, cover, follow-up ===');
// §1–7 run with the reads off, so nothing above changes; here they are on one at a time.
const quiet = base;
// Straights from 0.75 m are often absorbed by the other's resting guard glove
// on the cheek (a plain block, no interrupt), so these run at 0.85 m, where a
// jab still lands (to 0.97) and a hook is let off the leash with a wider gate.
{
  // The counter: pinned, never arming by itself. The player, 0.85 m off,
  // throws an uppercut that whiffs (reach 0.65) and hangs exposed through its
  // stretched recovery; the AI's jab reaches 0.97 m.
  const counterRun = (chance, rt) => {
    const cfg = { ...quiet, aiCounterChance: chance, aiReactionTime: rt, aiSpeedScale: 0, aiAttackDelayMin: 999, aiAttackDelayMax: 999, aiBlockChance: 0 };
    const w = fresh(cfg);
    w.s.fighters[0].pos = { x: -0.425, z: 0 }; w.s.fighters[1].pos = { x: 0.425, z: 0 };
    run(w, ticks(0.5));
    w.a = { ...w.a, attackTimer: 999, armed: null };
    w.evs.length = 0;
    let openedAt = -1;
    // (sim ticks throughout, as the events are tagged)
    run(w, ticks(1.5), i => inp({ uppercut: i === 0 }), x => { if (openedAt < 0 && you(x).vuln >= cfg.aiCounterVuln) openedAt = x.s.tick; });
    const whiff = w.evs.find(e => e.type === 'punchWhiff' && e.side === 0);
    const start = w.evs.find(e => e.type === 'punchStart' && e.side === 1);
    const land = w.evs.find(e => e.type === 'punchLand' && e.side === 1);
    return { whiff, start, land, openedAt, counters: w.a.counterCount };
  };
  const c = counterRun(1, 0);
  check('the player\'s uppercut whiffs from 0.85 m and leaves them exposed', c.whiff && c.openedAt >= 0, `whiff=${!!c.whiff}, opened @${c.openedAt}`);
  check('aiCounterChance 1, no reaction lag: it fires the tick after the opening appears', c.start && c.start.tick === c.openedAt + 1, `opening @${c.openedAt}, punchStart @${c.start?.tick}, counters ${c.counters}`);
  check('…a straight that lands as a COUNTER (the target was still exposed)', c.land && c.land.counter === true, `land ${JSON.stringify(c.land && { punch: c.land.punch, counter: c.land.counter })}`);
  const slow = counterRun(1, 0.2);
  check('aiReactionTime 0.2: the counter comes ~12 ticks after the opening, not the tick after', slow.start && slow.start.tick - slow.openedAt >= 12 && slow.start.tick - slow.openedAt <= 15, `${slow.start ? slow.start.tick - slow.openedAt : '-'} ticks`);
  const never = counterRun(0, 0);
  check('aiCounterChance 0: nothing is thrown at the opening', !never.start && never.counters === 0);
  // A fast jab's exposure is over before a human reaction: no counter is armed off it.
  {
    const cfg = { ...quiet, aiCounterChance: 1, aiReactionTime: 0.2, aiSpeedScale: 0, aiAttackDelayMin: 999, aiAttackDelayMax: 999, aiBlockChance: 0 };
    const w = fresh(cfg);
    w.s.fighters[0].pos = { x: -0.5, z: 0 }; w.s.fighters[1].pos = { x: 0.5, z: 0 };   // 1.0 m: the player's jab whiffs, cheaply
    run(w, ticks(0.5));
    w.a = { ...w.a, attackTimer: 999, armed: null };
    w.evs.length = 0;
    run(w, ticks(1.0), i => inp({ jab: i === 0 }));
    check('a whiffed JAB\'s exposure is gone before a 0.2 s reaction lands: no counter armed', w.a.counterCount === 0 && !w.evs.some(e => e.type === 'punchStart' && e.side === 1), `counters ${w.a.counterCount}`);
  }
}
{
  // The cover after a stuff: the AI, hook-only, throws from 0.75 m; the player
  // jabs into its wind-up (the sim stuffs it), and with aiCoverChance 1 the
  // guard comes up as soon as the rewound arm is home, the armed burst dropped.
  const coverRun = chance => {
    const cfg = { ...quiet, aiCoverChance: chance, aiSpeedScale: 0, aiBlockChance: 0, aiJabWeight: 0, aiCrossWeight: 0, aiHookWeight: 1, aiUppercutWeight: 0, aiHookEngageDist: 0.95, aiAttackDelayMin: 999, aiAttackDelayMax: 999, aiComboChance: 1, aiComboMax: 3, aiReactionTime: 0 };
    const w = fresh(cfg);
    w.s.fighters[0].pos = { x: -0.425, z: 0 }; w.s.fighters[1].pos = { x: 0.425, z: 0 };
    run(w, ticks(0.5));
    w.a = { ...w.a, attackTimer: 0.05, armed: null };   // the hook starts AFTER the settle, so the jab meets its wind-up
    w.evs.length = 0;
    let jabbed = false, stuffTick = -1, blockTick = -1, clearTick = -1;
    run(w, ticks(2), (i) => { const go = !jabbed && me(w).punch.type === 'hook' && me(w).punch.progress > 0.05; if (go) jabbed = true; return inp({ jab: go }); },
      (x, i) => {
        if (stuffTick < 0 && x.evs.some(e => e.type === 'punchStuffed' && e.side === 1)) stuffTick = i;
        if (stuffTick >= 0 && clearTick < 0 && me(x).punch.type === null) clearTick = i;
        if (stuffTick >= 0 && blockTick < 0 && me(x).block) blockTick = i;
      });
    const outcome = w.evs.filter(e => e.side === 0 && e.type !== 'punchStart' && e.type !== 'hurt').map(e => `${e.type}@${e.tick}`).join(',');
    return { stuffTick, clearTick, blockTick, armed: w.a.armed, burst: w.a.burst, outcome, throwsAfter: w.evs.filter(e => e.type === 'punchStart' && e.side === 1 && e.tick > (stuffTick >= 0 ? w.evs.find(e2 => e2.type === 'punchStuffed').tick : 1e9)).length };
  };
  const cov = coverRun(1);
  check('the player\'s jab stuffs the AI\'s hook (punchStuffed on side 1)', cov.stuffTick >= 0, `stuff @${cov.stuffTick}; the jab: ${cov.outcome}`);
  check('aiCoverChance 1: the guard is up the tick after the rewound arm is home', cov.blockTick >= 0 && cov.blockTick === cov.clearTick + 1, `stuffed @${cov.stuffTick}, home @${cov.clearTick}, guard @${cov.blockTick}`);
  check('…and the burst it was in is dropped (nothing thrown for the cover)', cov.burst === 0 && cov.throwsAfter === 0, `burst ${cov.burst}, thrown after ${cov.throwsAfter}`);
  const no = coverRun(0);
  check('aiCoverChance 0: stuffed, but no cover', no.stuffTick >= 0 && no.blockTick < 0, `guard @${no.blockTick}`);
}
{
  // The follow-up: the AI lands a cross on the idle player and, with the
  // stumble read on, its aggression jumps to mult² (unguarded × stumbling)
  // on the tick after; with it off it stays at mult.
  const followRun = stumbleSpeed => {
    const cfg = { ...quiet, aiStumbleSpeed: stumbleSpeed, aiSpeedScale: 0, aiBlockChance: 0, aiJabWeight: 0, aiCrossWeight: 1, aiHookWeight: 0, aiUppercutWeight: 0, aiAttackDelayMin: 999, aiAttackDelayMax: 999, aiComboChance: 0 };
    const w = fresh(cfg);
    w.s.fighters[0].pos = { x: -0.425, z: 0 }; w.s.fighters[1].pos = { x: 0.425, z: 0 };
    run(w, ticks(0.5));
    w.a = { ...w.a, attackTimer: 0, armed: 'cross' };
    w.evs.length = 0;
    let peak = 0, landTick = -1, stumbleSpeedSeen = 0;
    run(w, ticks(1.0), () => NONE, (x, i) => {
      if (landTick < 0 && x.evs.some(e => e.type === 'punchLand' && e.side === 1)) landTick = i;
      if (landTick >= 0) { peak = Math.max(peak, x.a.aggression); stumbleSpeedSeen = Math.max(stumbleSpeedSeen, Math.hypot(you(x).stagger.x, you(x).stagger.z)); }
    });
    return { peak, landTick, stumbleSpeedSeen };
  };
  const on = followRun(defaults.aiStumbleSpeed), off = followRun(999);
  check(`its cross lands and the player stumbles at up to ${on.stumbleSpeedSeen.toFixed(2)} m/s (threshold ${defaults.aiStumbleSpeed})`, on.landTick >= 0 && on.stumbleSpeedSeen > defaults.aiStumbleSpeed);
  check('stumble read on: aggression reaches mult² (unguarded × stumbling) after the land', near(on.peak, base.aiAggressionMult ** 2, 1e-9), `${on.peak.toFixed(2)}`);
  check('stumble read off: it stays at mult', near(off.peak, base.aiAggressionMult, 1e-9), `${off.peak.toFixed(2)}`);
  // Its own stumble: hit by a cross, it throws nothing until its feet are
  // back — then walks back into range (the stumble carried it out) and fires the jab it had armed.
  {
    const cfg = { ...quiet, aiStumbleSpeed: defaults.aiStumbleSpeed, aiBlockChance: 0, aiAttackDelayMin: 999, aiAttackDelayMax: 999 };
    const w = fresh(cfg);
    w.s.fighters[0].pos = { x: -0.425, z: 0 }; w.s.fighters[1].pos = { x: 0.425, z: 0 };
    run(w, ticks(0.5));
    w.evs.length = 0;
    let landTick = -1, threwWhileStumbling = false, stumbledTicks = 0, threwAfter = false;
    run(w, ticks(1.5), i => inp({ cross: i === 0 }), (x, i) => {
      if (landTick < 0 && x.evs.some(e => e.type === 'punchLand' && e.side === 0)) { landTick = i; x.a = { ...x.a, attackTimer: 0, armed: 'jab' }; }
      if (landTick >= 0) {
        const stumbling = Math.hypot(me(x).stagger.x, me(x).stagger.z) > cfg.aiStumbleSpeed;
        if (stumbling) { stumbledTicks++; if (x.last.jab) threwWhileStumbling = true; }
        else if (x.last.jab) threwAfter = true;
      }
    });
    check(`hit by a cross it throws nothing through its ${stumbledTicks} stumbling ticks, then fires the jab it had armed`, landTick >= 0 && stumbledTicks > 0 && !threwWhileStumbling && threwAfter, `stumbled ${stumbledTicks}, threw during=${threwWhileStumbling}, after=${threwAfter}`);
  }
}
{
  // Determinism with the reads on.
  const spar = seed => { const x = fresh(defaults, seed); run(x, ticks(15), i => inp({ jab: i % 120 === 0, hook: i % 200 === 50, move: { x: 0, y: i % 300 < 60 ? 1 : i % 300 < 120 ? -1 : 0 } })); return x; };
  const a = spar(23), b = spar(23);
  check('counter, cover and follow-up are seeded: same seed → identical', JSON.stringify(a.a) === JSON.stringify(b.a) && JSON.stringify(a.throws) === JSON.stringify(b.throws));
  console.log(`     15 s spar with everything on: ${a.throws.length} throws, ${a.a.counterCount} counters armed`);
}

done();

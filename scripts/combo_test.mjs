/**
 * combo_test.mjs — punch input buffer + chain window (2026-09-11, Nate: jab-cross
 * spam was dropping every other press and reading as "cross… cross…").
 *   - a press during a punch is buffered and fires at the chain window
 *   - the newest press replaces an older one; the buffer expires; block clears it
 *   - a buffered hook keeps the stick sign from the press, not the fire tick
 *   - alternating jab/cross spam at 150 ms produces an alternating combo at the
 *     rig's own max rate, no dropped types, never two punches in flight
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT } = core;
// No knockdowns (a 3 s spam would floor the dummy and freeze the fight), no
// stamina cost (a gassed wind-up would change the chain timing under test) and
// no whiff cost (the FAR cases miss on purpose; a stretched recovery would move
// the chain window this suite measures — counter_test covers the stretch).
const cfg = { ...createConfig(), healthDamagePerImpulse: 0, staminaPunchCost: 0, whiffRecoveryMult: 1 };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;
const ticks = s => Math.round(s / SIM_DT);

function fresh(c = cfg, dist = MID) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
/** Step n ticks with side-0 input `player(i)`; returns starts (punch, tick) and whether two were ever in flight. */
function run(s, n, player, c = cfg, onTick) {
  const starts = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, [player(i), NONE], c); s = r.state;
    for (const e of r.events) if (e.type === 'punchStart' && e.side === 0) starts.push({ punch: e.punch, hand: e.hand, tick: i });
    onTick?.(s, i);
  }
  return { s, starts };
}
const jabPh = { cock: cfg.jabCock, extend: cfg.jabExtend, recover: cfg.jabRecover };
const jabChainTick = Math.ceil((jabPh.cock + jabPh.extend + cfg.punchChainAt * jabPh.recover) / SIM_DT);
// Tick-exact timing is checked out of range: a landed punch fires hit-stop,
// which slows the sim clock and stretches the punch by a few real ticks.
const FAR = 1.5;

// ── 1. Buffer + chain window ────────────────────────────────────────────────
{
  const { starts } = run(fresh(cfg, FAR), 60, i => inp({ jab: i === 0, cross: i === 3 }));
  check('a cross pressed in the jab\'s cock fires at the jab\'s chain window', starts.length === 2 && starts[1].punch === 'cross' && Math.abs(starts[1].tick - jabChainTick) <= 1,
    `starts ${starts.map(s => `${s.punch}@${s.tick}`).join(', ')}, chain tick ${jabChainTick}`);
}
{
  const { starts } = run(fresh(cfg, FAR), 60, i => inp({ jab: i === 0, cross: i === jabChainTick + 2 }));
  check('a press inside the chain window fires that tick', starts.length === 2 && starts[1].tick === jabChainTick + 2, starts.map(s => `${s.punch}@${s.tick}`).join(', '));
}
{
  const { starts } = run(fresh(), 60, i => inp({ jab: i === 0, cross: i === 2, hook: i === 5 }));
  check('a second press queues behind the first (punchBufferDepth 2)', starts.map(s => s.punch).join(',') === 'jab,cross,hook', starts.map(s => s.punch).join(','));
}
{
  const short = { ...cfg, punchBuffer: 0.05 };   // 3 ticks; the jab's chain window is ~10 ticks out
  const { starts } = run(fresh(short), 60, i => inp({ jab: i === 0, cross: i === 2 }), short);
  check('the buffer expires: a press remembered for less than the wait is dropped', starts.length === 1, starts.map(s => s.punch).join(','));
}
{
  const { starts } = run(fresh(), 60, i => inp({ jab: i === 0, cross: i === 2, block: i >= 4 && i < 8 }));
  check('holding block forgets the buffered punch', starts.length === 1, starts.map(s => s.punch).join(','));
}
{
  let jabResolved = false;
  const { s } = run(fresh(cfg, FAR), jabChainTick + 1, i => inp({ jab: i === 0, cross: i === 3 }), cfg, st => { const p = st.fighters[0].punch; if (p.type === 'jab' && p.resolved) jabResolved = true; });
  const p = s.fighters[0].punch;
  check('the chained cross replaces the jab (one punch state, at its own start)', p.type === 'cross' && p.phase === 'cock' && p.progress < 0.1 && !p.resolved, `${p.type} ${p.phase} ${p.progress.toFixed(2)}`);
  check('the jab had already resolved (hit test ran) before it was cut', jabResolved);
}
{
  // Hand from the stick at the PRESS: hook pressed with the stick left during a jab, stick right by the time it fires.
  const { starts } = run(fresh(), 60, i => inp({ jab: i === 0, hook: i === 2, move: { x: i === 2 ? -1 : (i > 2 ? 1 : 0), y: 0 } }));
  check('a buffered hook keeps the hand the stick chose at the press', starts[1]?.punch === 'hook' && starts[1]?.hand === 'lead', `${starts[1]?.punch} ${starts[1]?.hand}`);
}

// ── 1b. The hit confirm, the chained wind-up and the two-deep queue (2026-09-17) ─
// Nate: "I attempt a 1-2, there's a delay after the jab where my cross doesn't
// come out even after I've clicked". Measured before: cross pressed at tick 3
// started at tick 13 and landed at 24.
{
  const events = [];
  const { starts } = run(fresh(), 60, i => inp({ jab: i === 0, cross: i === 3 }), cfg, (s, i) => {});
  let landTick = -1;
  let s = fresh();
  for (let i = 0; i < 60; i++) { const r = sim.step(s, [inp({ jab: i === 0, cross: i === 3 }), NONE], cfg); s = r.state; for (const e of r.events) { if (e.type === 'punchLand' && e.side === 0 && e.punch === 'jab') landTick = i; if (e.type === 'punchLand' && e.side === 0) events.push(`${e.punch}@${i}`); } }
  check('hit confirm: a cross pressed in a LANDED jab starts the tick after the jab lands', starts.length === 2 && starts[1].punch === 'cross' && starts[1].tick === landTick + 1,
    `starts ${starts.map(s => `${s.punch}@${s.tick}`).join(', ')}, jab landed @${landTick}`);
  const crossLand = events.find(e => e.startsWith('cross'));
  check('…and the 1-2 lands inside 0.3 s of the first press (was 0.4)', crossLand && Number(crossLand.split('@')[1]) * SIM_DT <= 0.3, `${events.join(', ')}`);
}
{
  // The chained cross winds up comboCockScale as long: compare its cock in ticks alone vs after a jab (out of range, no hit-stop, whiff cost off).
  const cockTicks = (script) => { let s = fresh(cfg, FAR), t0 = -1, t1 = -1; for (let i = 0; i < 60; i++) { s = sim.step(s, [inp(script(i)), NONE], cfg).state; const p = s.fighters[0].punch; if (p.type === 'cross' && t0 < 0) t0 = i; if (p.type === 'cross' && p.phase !== 'cock' && t1 < 0) t1 = i; } return t1 - t0; };
  const alone = cockTicks(i => ({ cross: i === 0 }));
  const chained = cockTicks(i => ({ jab: i === 0, cross: i === 3 }));
  check('a chained cross winds up ~comboCockScale as long as one thrown cold', Math.abs(chained - Math.round(alone * cfg.comboCockScale)) <= 1, `alone ${alone} ticks, chained ${chained}, scale ${cfg.comboCockScale}`);
  const cold = { ...cfg, comboCockScale: 1 };
  let s = fresh(cold, FAR), t0 = -1, t1 = -1;
  for (let i = 0; i < 60; i++) { s = sim.step(s, [inp({ jab: i === 0, cross: i === 3 }), NONE], cold).state; const p = s.fighters[0].punch; if (p.type === 'cross' && t0 < 0) t0 = i; if (p.type === 'cross' && p.phase !== 'cock' && t1 < 0) t1 = i; }
  check('comboCockScale 1: every punch winds up from scratch', t1 - t0 === alone, `${t1 - t0} vs ${alone}`);
}
{
  const { starts } = run(fresh(), 80, i => inp({ jab: i === 0, cross: i === 3, hook: i === 6, move: { x: i === 6 ? -1 : 0, y: 0 } }));
  check('a fast 1-2-3 (presses at 0, 50, 100 ms) comes out as jab, cross, hook', starts.map(s => s.punch).join(',') === 'jab,cross,hook', starts.map(s => `${s.punch}@${s.tick}`).join(', '));
  check('…the queued hook keeps its hand from the press', starts[2]?.hand === 'lead', `${starts[2]?.hand}`);
  const four = run(fresh(), 80, i => inp({ jab: i === 0, cross: i === 2, hook: i === 4, uppercut: i === 6, move: { x: i >= 4 ? -1 : 0, y: 0 } })).starts;
  check('a fourth press beyond the queue replaces the last queued one', four.map(s => s.punch).join(',') === 'jab,cross,uppercut', four.map(s => s.punch).join(','));
  const one = { ...cfg, punchBufferDepth: 1 };
  const { starts: old } = run(fresh(one), 80, i => inp({ jab: i === 0, cross: i === 3, hook: i === 6, move: { x: i === 6 ? -1 : 0, y: 0 } }), one);
  check('punchBufferDepth 1: the newest press replaces the older (the 2 is lost)', old.map(s => s.punch).join(',') === 'jab,hook', old.map(s => s.punch).join(','));
}
{
  // A miss keeps the later window: out of range the cross waits for punchChainAt of the jab's recovery.
  const { starts } = run(fresh(cfg, FAR), 60, i => inp({ jab: i === 0, cross: i === 3 }));
  check('off a whiff the follow-up still waits for punchChainAt', starts[1] && Math.abs(starts[1].tick - jabChainTick) <= 1, `cross @${starts[1]?.tick}, whiff chain tick ${jabChainTick}`);
}

// ── 2. Spam: alternating jab / cross, landing on the dummy (hit-stop and all) ─
// Every press is a 3-tick tap. The buffer keeps the NEWEST press, so at a
// cadence faster than the punches themselves the combo still runs at the
// rig's max rate but can skip a type; at a human 1-2 cadence every press is
// its own punch, in order.
const spam = (periodS, seconds, c = cfg) => {
  const period = ticks(periodS), hold = 3, total = ticks(seconds);
  const player = i => { const n = Math.floor(i / period), down = i % period < hold; return inp({ jab: down && n % 2 === 0, cross: down && n % 2 === 1 }); };
  const { starts } = run(fresh(c), total, player, c);
  let alternating = 0;
  for (let i = 1; i < starts.length; i++) if (starts[i].punch !== starts[i - 1].punch) alternating++;
  const gaps = starts.slice(1).map((s, i) => s.tick - starts[i].tick);
  return { starts, presses: Math.ceil(total / period), alternating, minGapS: Math.min(...gaps) * SIM_DT, seq: starts.map(s => s.punch[0]).join('') };
};
{
  const human = spam(0.25, 3);
  check('a 4/s jab-cross-jab-cross lands every press as its own punch', human.starts.length === human.presses, `${human.starts.length} punches from ${human.presses} presses`);
  check('…in order, alternating', human.alternating === human.starts.length - 1, `${human.alternating}/${human.starts.length - 1}: ${human.seq}`);

  const fast = spam(0.15, 3);
  // Everything lands here, so the chain opens at punchChainOnHit and every
  // punch after the first winds up comboCockScale as long.
  const jabMin = jabPh.cock * cfg.comboCockScale + jabPh.extend + cfg.punchChainOnHit * jabPh.recover;
  // The ceiling is the timing table: at most 3 s / (a chained cross's cock +
  // extend + chainOnHit × recover) punches fit, less what hit-stop eats
  // (every land freezes the clock for a few ticks). Within a fifth of that.
  const crossMin = cfg.crossCock * cfg.comboCockScale + cfg.crossExtend + cfg.punchChainOnHit * cfg.crossRecover;
  const ceiling = Math.floor(3 / crossMin);
  check('mashing faster than the fighter can punch lands as many as the chain window allows', fast.starts.length >= ceiling * 0.8 && fast.starts.length <= ceiling, `${fast.starts.length} punches from ${fast.presses} presses (ceiling ${ceiling}): ${fast.seq}`);
  check('…never faster than the chain window allows', fast.minGapS >= jabMin - 1e-9, `min gap ${(fast.minGapS * 1000).toFixed(0)} ms vs ${(jabMin * 1000).toFixed(0)} ms`);

  const noBuf = { ...cfg, punchBuffer: 0, punchChainAt: 1 };
  const old = spam(0.25, 3, noBuf);
  check('the old settings (no buffer, no chain) drop presses — the bug being fixed', old.starts.length < human.starts.length, `${old.starts.length} vs ${human.starts.length}: ${old.seq}`);
  console.log(`     combo rate when mashing: ${(fast.starts.length / 3).toFixed(1)} punches/s (v1-style at 4/s presses: ${(old.starts.length / 3).toFixed(1)}/s)`);
}

done();

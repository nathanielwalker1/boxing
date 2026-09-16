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
  check('the newest press replaces the buffered one', starts.map(s => s.punch).join(',') === 'jab,hook', starts.map(s => s.punch).join(','));
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
  const jabMin = jabPh.cock + jabPh.extend + cfg.punchChainAt * jabPh.recover;
  // The ceiling is the timing table: the buffer keeps the newest press, and a
  // cross can start again only at its chain window, so at most 3 s / (cross
  // cock + extend + chainAt × recover) punches fit. Within one of that.
  const crossMin = cfg.crossCock + cfg.crossExtend + cfg.punchChainAt * cfg.crossRecover;
  const ceiling = Math.floor(3 / crossMin);
  check('mashing faster than the fighter can punch lands as many as the chain window allows', fast.starts.length >= ceiling - 1, `${fast.starts.length} punches from ${fast.presses} presses (ceiling ${ceiling}): ${fast.seq}`);
  check('…never faster than the chain window allows', fast.minGapS >= jabMin - 1e-9, `min gap ${(fast.minGapS * 1000).toFixed(0)} ms vs ${(jabMin * 1000).toFixed(0)} ms`);

  const noBuf = { ...cfg, punchBuffer: 0, punchChainAt: 1 };
  const old = spam(0.25, 3, noBuf);
  check('the old settings (no buffer, no chain) drop presses — the bug being fixed', old.starts.length < human.starts.length, `${old.starts.length} vs ${human.starts.length}: ${old.seq}`);
  console.log(`     combo rate when mashing: ${(fast.starts.length / 3).toFixed(1)} punches/s (v1-style at 4/s presses: ${(old.starts.length / 3).toFixed(1)}/s)`);
}

done();

/**
 * repeat_test.mjs — "repetition read" (audit P4, 2026-11-24). The same punch (type + hand + level) again inside
 * repeatWindow of the last one's start is a repeat: the first jab repeat is free, every other counted repeat costs
 * 1 + repeatStaminaCost x n of the throw, loses the fast chained wind-up, and widens the defender's perfect-block
 * window by 1 + repeatReadBonus x n. repeatMax 0 = the old sim.
 */
import { check, done } from './check.js';
import { kit } from './bots/kit.mjs';

const k = await kit();
const base = { ...k.cfg, healthDamagePerImpulse: 0, staminaRegen: 0 };
const OFF = { ...base, repeatMax: 0 };
const press = (type, x = 0) => ({ [type]: true, move: { x, y: 0 } });
const T = s => k.T(s);

/** Throw `seq` = [[seconds, type, stickX?]] from side 0; return each start's stamina cost and tell. */
function throwSeq(cfg, seq, dist = 1.4, total = 0) {
  let s = k.fresh(cfg, dist);
  const end = total || seq[seq.length - 1][0] + 1;
  const starts = [];
  let prev = s.fighters[0].stamina;
  const ticksAt = seq.map(([t]) => T(t));
  k.run(s, T(end), i => {
    const j = ticksAt.indexOf(i);
    return [j >= 0 ? k.inp(press(seq[j][1], seq[j][2] ?? 0)) : k.NONE, k.NONE];
  }, cfg, (st, i, evs) => {
    const f = st.fighters[0];
    for (const e of evs) if (e.type === 'punchStart' && e.side === 0) starts.push({ punch: e.punch, hand: e.hand, cost: prev - f.stamina, tell: f.punch.tell });
    prev = f.stamina;
  });
  return starts;
}
const r3 = x => x.toFixed(4);
const ratio = (a, b) => a / b;

// jab, jab: the double jab is free
{
  const on = throwSeq(base, [[0, 'jab'], [1, 'jab']]), off = throwSeq(OFF, [[0, 'jab'], [1, 'jab']]);
  check(`jab, jab: costs ${r3(on[0].cost)} then ${r3(on[1].cost)} (equal), wind-up ${r3(on[1].tell)} s = un-ruled ${r3(off[1].tell)} s`,
    on.length === 2 && Math.abs(on[0].cost - on[1].cost) < 1e-9 && Math.abs(on[1].tell - off[1].tell) < 1e-9);
}
// jab x4
{
  const on = throwSeq(base, [[0, 'jab'], [0.8, 'jab'], [1.6, 'jab'], [2.4, 'jab']], 1.4, 3);
  const c = on.map(x => x.cost);
  check(`jab x4: costs ${c.map(r3).join(' ')}; the 3rd (${ratio(c[2], c[0]).toFixed(2)}x) and 4th (${ratio(c[3], c[0]).toFixed(2)}x) cost more than the 1st, the 2nd the same`,
    on.length === 4 && Math.abs(c[1] - c[0]) < 1e-9 && c[2] > c[0] * 1.4 && c[3] > c[2]);
}
// cross x3
{
  const on = throwSeq(base, [[0, 'cross'], [1, 'cross'], [2, 'cross']], 1.4, 3);
  const c = on.map(x => x.cost);
  check(`cross x3: 2nd ${ratio(c[1], c[0]).toFixed(3)}x, 3rd ${ratio(c[2], c[0]).toFixed(3)}x the 1st (expect 1.5, 2.0)`,
    on.length === 3 && Math.abs(ratio(c[1], c[0]) - 1.5) < 0.01 && Math.abs(ratio(c[2], c[0]) - 2) < 0.01);
}
// hook, other punch, hook
{
  const on = throwSeq(base, [[0, 'hook', -1], [1, 'cross'], [2, 'hook', -1]], 1.4, 3);
  const c = on.map(x => x.cost);
  check(`hook, cross, hook: 3rd hook costs ${r3(c[2])} = 1st ${r3(c[0])} (count reset)`, on.length === 3 && Math.abs(c[2] - c[0]) < 1e-9);
}
// lapse
{
  const on = throwSeq(base, [[0, 'cross'], [3.6, 'cross']], 1.4, 4.5);
  check(`cross, 3.6 s later cross (window ${base.repeatWindow} s): costs ${r3(on[0].cost)} and ${r3(on[1].cost)} (equal)`, on.length === 2 && Math.abs(on[0].cost - on[1].cost) < 1e-9);
}
// chained off a clean land: a repeated cross vs a cross after a jab
{
  const at = 0.79, go = (cfg, first) => throwSeq({ ...cfg, staminaPunchCost: 0 }, [[0, first], [0.15, 'cross']], at, 1.5);
  const rep = go(base, 'cross'), mix = go(base, 'jab'), repOff = go(OFF, 'cross');
  check(`cross chained off a clean land: after a cross (repeat) wind-up ${r3(rep[1]?.tell)} s > after a jab ${r3(mix[1]?.tell)} s; repeatMax 0 gives ${r3(repOff[1]?.tell)} s (= after a jab)`,
    rep.length === 2 && mix.length === 2 && rep[1].tell > mix[1].tell + 1e-9 && Math.abs(repOff[1].tell - mix[1].tell) < 1e-9);
}
// repeatMax 0 = identical numbers (stamina ratios 1, no loss of the chain)
{
  const on = throwSeq(OFF, [[0, 'cross'], [1, 'cross'], [2, 'cross']], 1.4, 3);
  const c = on.map(x => x.cost);
  check(`repeatMax 0: cross x3 costs ${c.map(r3).join(' ')} all equal`, on.length === 3 && Math.abs(c[1] - c[0]) < 1e-9 && Math.abs(c[2] - c[0]) < 1e-9);
}

done();

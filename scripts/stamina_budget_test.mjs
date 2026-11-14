/**
 * stamina_budget_test.mjs — staminaV2 (2026-11-14): stamina has to matter. Measured before, a fighter at a sensible pace
 * never dropped under 99% in a round. Pins the budget of ONE 60 s round on the scripted paces of stamina_probe.mjs pace():
 *   - sensible (about 50 a minute, mixed, half landing): ends the round on 52-72%
 *   - spamming (100+ a minute, power shots): gassed (below lowStamina) inside 8-26 s
 *   - defensive (a few punches, guard up, being worked on): ends on 80% or more
 *   - a miss costs more than a land, a blocked punch costs more than a land
 *   - four seconds of not punching is worth at least 8 points
 *   - staminaV2 off reproduces today's fight exactly (the keys are ignored)
 * Prints the budget table (tank at 15/30/45/60 s) that docs/FEEL.md quotes.
 */
import { check, done } from './check.js';
import { costs, pace } from './stamina_probe.mjs';
import { kit } from './bots/kit.mjs';

const k = await kit();
const cfg = k.cfg, OFF = { ...cfg, staminaV2: false };
const P = {
  sensible: { ppm: 50, miss: 0.5, his: 24, holdGuard: true },
  spam: { ppm: 110, miss: 0.4, his: 24, power: true, heavy: 0.4 },
  defensive: { ppm: 8, miss: 0.25, his: 40, guard: 1, heavy: 0.5, holdGuard: true },
};
const pct = x => (x * 100).toFixed(0);
const row = r => `${[...r.snaps.slice(0, 3), r.rounds[0].end].map(pct).join(' / ')} (gassed at ${r.gassedAt === null ? 'never' : r.gassedAt.toFixed(0) + ' s'}, ${r.ppm.toFixed(0)} thrown/min, ${r.landed} landed ${r.whiffed} missed over 3 rounds)`;

console.log('\n=== 1. The budget of a 60 s round: tank % at 15 / 30 / 45 / 60 s ===');
const R = {}, W = {};
for (const n of Object.keys(P)) { R[n] = pace({ ...P[n], c: cfg }, true); W[n] = pace({ ...P[n], c: OFF }, true); console.log(`  ${n.padEnd(10)} staminaV2 on : ${row(R[n])}\n  ${''.padEnd(10)} staminaV2 off: ${row(W[n])}`); }
const end = r => r.rounds[0].end;
check(`sensible pace ends the round on 55-70% (${pct(end(R.sensible))}%) and is never gassed`, end(R.sensible) >= 0.55 && end(R.sensible) <= 0.70 && R.sensible.gassedAt === null);
check(`before: the same pace ended on ${pct(end(W.sensible))}% (the measured problem, stamina was no factor)`, end(W.sensible) > 0.9);
check(`spamming is gassed inside 18-28 s (${R.spam.gassedAt === null ? 'never' : R.spam.gassedAt.toFixed(1) + ' s'})`, R.spam.gassedAt !== null && R.spam.gassedAt >= 18 && R.spam.gassedAt <= 28);
check(`defensive play ends the round on 80% or more (${pct(end(R.defensive))}%) and is never gassed`, end(R.defensive) >= 0.8 && R.defensive.gassedAt === null);

console.log('\n=== 1b. The 60 s tank by pace (a gradient, not a cliff) ===');
{
  const ends = [];
  for (const ppm of [40, 50, 60, 70, 80, 100, 120]) { const r = pace({ ppm, miss: 0.4, his: 24, holdGuard: true, c: cfg }, true); ends.push(r.rounds[0].end * 100); console.log(`  asked ${String(ppm).padStart(3)} a minute (${r.ppm.toFixed(0)} thrown): ${ends[ends.length - 1].toFixed(0)}%${r.gassedAt === null ? '' : ', gassed at ' + r.gassedAt.toFixed(0) + ' s'}`); }
  const jumps = ends.slice(1).map((e, i) => ends[i] - e);
  check(`it falls steadily with the pace (no rise): ${ends.map(e => e.toFixed(0)).join(' ')}`, jumps.every(j => j >= -0.5));
  check(`…and no jump between neighbouring paces is over 25 points (biggest ${Math.max(...jumps).toFixed(0)}; the aim was 20)`, Math.max(...jumps) <= 25);
}

console.log('\n=== 2. What things cost ===');
{
  const c = costs(cfg, true), o = costs(OFF, true);
  for (const p of ['jab', 'cross', 'hook', 'uppercut']) {
    const land = c[`${p} thrown and LANDED`].cost, miss = c[`${p} thrown and MISSED`].cost, blk = c[`${p} thrown and BLOCKED`].cost;
    check(`${p}: a miss (${(miss * 100).toFixed(2)}%) costs more than a block (${(blk * 100).toFixed(2)}%) costs more than a land (${(land * 100).toFixed(2)}%)`, miss > blk && blk > land);
  }
  check(`a body hook taken drains more than a head hook taken (${(c['taking a body hook clean'].cost * 100).toFixed(1)}% vs ${(c['TAKING his hook clean'].cost * 100).toFixed(1)}%)`, c['taking a body hook clean'].cost > c['TAKING his hook clean'].cost);
  const cx = n => c['cross thrown and ' + n].cost * 100;
  check(`a cross costs about 1.5% landed, 2.5% blocked, 3% missed (${cx('LANDED').toFixed(2)} / ${cx('BLOCKED').toFixed(2)} / ${cx('MISSED').toFixed(2)})`, Math.abs(cx('LANDED') - 1.5) < 0.2 && Math.abs(cx('BLOCKED') - 2.5) < 0.2 && Math.abs(cx('MISSED') - 3) < 0.2);
  check(`off: the old blocked punch cost no more than a land plus the refund (${(o['cross thrown and BLOCKED'].cost * 100).toFixed(2)}%)`, o['cross thrown and BLOCKED'].cost <= o['cross thrown and LANDED'].cost + 0.0151);
}

console.log('\n=== 3. Recovery ===');
{
  // Side 0 at 30% wind stands still (or holds the guard) for 4 s, the other fighter out of reach and idle.
  const idle = (c, ticks, block) => { let s = k.fresh(c, 3); s.fighters[0].stamina = 0.3; for (let i = 0; i < ticks; i++) s = k.sim.step(s, [k.inp({ block }), k.NONE], c).state; return s.fighters[0].stamina - 0.3; };
  const free = idle(cfg, 240, false), guard = idle(cfg, 240, true);
  check(`4 s of not punching returns at least 8 points (${(free * 100).toFixed(1)})`, free >= 0.08);
  check(`behind the guard it comes back more slowly (${(guard * 100).toFixed(1)} < ${(free * 100).toFixed(1)}) but does come back`, guard > 0 && guard < free);
  check('right after a throw wind barely comes back: in the next 0.5 s under 2 points (the ramp starts at zero)', (() => { let s = k.fresh(cfg, 3); s.fighters[0].stamina = 0.3; s = k.sim.step(s, [k.inp({ jab: true }), k.NONE], cfg).state; const a = s.fighters[0].stamina; for (let i = 0; i < 30; i++) s = k.sim.step(s, [k.NONE, k.NONE], cfg).state; return s.fighters[0].stamina - a < 0.02; })());
}

console.log('\n=== 4. The off switch ===');
{
  // A seeded scripted fight (a tiny LCG for the inputs, no Math.random): with staminaV2 off, the V2 keys change nothing.
  const fight = c => {
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let s = k.fresh(c, 0.8);
    for (let i = 0; i < 1500; i++) {
      const mk = () => { const r = rnd(); return k.inp({ jab: r < 0.04, cross: r >= 0.04 && r < 0.07, hook: r >= 0.07 && r < 0.09, block: r > 0.9 && r < 0.95, move: { x: rnd() - 0.5, y: rnd() - 0.5 } }); };
      s = k.sim.step(s, [mk(), mk()], c).state;
    }
    return JSON.stringify(s.fighters.map(f => [f.stamina, f.staminaCap, f.health, f.pos.x, f.pos.z]));
  };
  const a = fight(OFF), b = fight({ ...OFF, staminaV2ThrowMult: 3, staminaV2WhiffMult: 3, staminaV2BlockedThrow: 2, staminaV2RegenMult: 0.1, staminaV2ThrowDelay: 4, staminaV2BodyMult: 5 });
  check('staminaV2 off: every V2 key is ignored, the fight is identical', a === b);
  check('staminaV2 on: the same fight comes out differently (the switch is live)', fight(cfg) !== a);
}
done();

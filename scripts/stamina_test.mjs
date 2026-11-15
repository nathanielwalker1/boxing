/**
 * stamina_test.mjs — the polish phase's stamina targets (2026-11-11, item 6; Nate: "drains a bit too much, and
 * blocking shouldn't drain it so bad"). Pins, on the scripted paces of scripts/stamina_probe.mjs:
 *   - a fighter lasts three 60 s rounds at a sensible pace without gassing — including the way people actually
 *     play, with the guard up between combinations (which is what emptied the tank before)
 *   - blocking light punches is nearly free; heavy shots on the guard cost something
 *   - missing is what costs: a miss is several times a land, by the punch's weight, and wears the ceiling
 *   - the off switch restores the old costs
 */
import { check, done } from './check.js';
import { costs, pace } from './stamina_probe.mjs';
import { kit } from './bots/kit.mjs';

const k = await kit();
const cfg = { ...k.cfg, staminaV2: false }, OLD = { ...cfg, staminaPolishOn: false };   // the polish-phase economy; staminaV2 has its own test (stamina_budget_test.mjs)
const pct = x => `${(x * 100).toFixed(1)}%`;

// ── 1. Three rounds at a sensible pace ───────────────────────────────────────
console.log('\n=== 1. Three rounds at a sensible pace ===');
{
  const sensible = [
    ['25 a minute, rests between', { ppm: 25, his: 18 }],
    ['32 a minute, rests between', { ppm: 32, his: 24 }],
    ['40 a minute, rests between', { ppm: 40, his: 30 }],
    ['32 a minute, guard up between combinations', { ppm: 32, his: 24, holdGuard: true }],
    ['60 a minute, guard up between combinations', { ppm: 60, his: 40, holdGuard: true }],
  ];
  for (const [name, o] of sensible) {
    const r = pace({ ...o, c: cfg }, true);
    check(`${name}: never gassed, tired ${pct(r.tired)} of the time (< 10%), average tank ${pct(r.avg)} (≥ 75%), every round ends on ≥ 60% (${r.rounds.map(x => pct(x.end)).join(' ')})`,
      r.gassed === 0 && r.tired < 0.1 && r.avg >= 0.75 && r.rounds.length === 3 && r.rounds.every(x => x.end >= 0.6));
  }
  const was = pace({ ppm: 32, his: 24, holdGuard: true, c: OLD }, true);
  check(`the measured cause: with the old costs the same fighter with his guard up between combinations was gassed ${pct(was.gassed)} of the fight (average tank ${pct(was.avg)})`, was.gassed > 0.5 && was.avg < 0.3);
}

// ── 2. What things cost ─────────────────────────────────────────────────────
console.log('\n=== 2. Costs ===');
{
  const c = costs(cfg, true), o = costs(OLD, true);
  const v = (t, key) => t[key].cost;
  check(`holding the guard: ${pct(v(c, 'holding the guard up, per second'))} a second (it was ${pct(v(o, 'holding the guard up, per second'))})`, v(c, 'holding the guard up, per second') <= 0.01 && v(o, 'holding the guard up, per second') >= 0.07);
  check(`blocking a jab is nearly free: ${pct(v(c, 'BLOCKING his jab (the shot itself)'))} (it was ${pct(v(o, 'BLOCKING his jab (the shot itself)'))})`, v(c, 'BLOCKING his jab (the shot itself)') <= 0.003);
  check(`a heavy shot on the guard costs something: cross ${pct(v(c, 'BLOCKING his cross (the shot itself)'))}, hook ${pct(v(c, 'BLOCKING his hook (the shot itself)'))} — at least 5× the jab`,
    v(c, 'BLOCKING his cross (the shot itself)') >= 0.012 && v(c, 'BLOCKING his hook (the shot itself)') >= 5 * v(c, 'BLOCKING his jab (the shot itself)'));
  check('…and still less than taking it clean', ['cross', 'hook'].every(p => v(c, `BLOCKING his ${p} (the shot itself)`) < v(c, `TAKING his ${p} clean`)));
  for (const p of ['jab', 'cross', 'hook', 'uppercut']) {
    const land = v(c, `${p} thrown and LANDED`), miss = v(c, `${p} thrown and MISSED`), blk = v(c, `${p} thrown and BLOCKED`);
    check(`${p}: landed ${pct(land)} < blocked ${pct(blk)} < missed ${pct(miss)} (a miss ≥ 2.5× a land, and it wears the ceiling by ${pct(c[`${p} thrown and MISSED`].cap)})`, land <= blk + 1e-9 && blk < miss && miss >= 2.5 * Math.max(land, 0.001) && c[`${p} thrown and MISSED`].cap > 0);
  }
  check(`a punch costs by its weight: a missed jab ${pct(v(c, 'jab thrown and MISSED'))} < cross ${pct(v(c, 'cross thrown and MISSED'))} < hook ${pct(v(c, 'hook thrown and MISSED'))} < uppercut ${pct(v(c, 'uppercut thrown and MISSED'))} (they were all ${pct(v(o, 'jab thrown and MISSED'))})`,
    v(c, 'jab thrown and MISSED') < v(c, 'cross thrown and MISSED') && v(c, 'cross thrown and MISSED') < v(c, 'hook thrown and MISSED') && v(c, 'hook thrown and MISSED') < v(c, 'uppercut thrown and MISSED')
    && Math.abs(v(o, 'jab thrown and MISSED') - v(o, 'uppercut thrown and MISSED')) < 1e-9);
  check('staminaPolishOn off: a thrown punch costs staminaPunchCost + the whiff cost, whatever it is', Math.abs(v(o, 'hook thrown and MISSED') - (cfg.staminaPunchCost + cfg.staminaWhiffCost)) < 1e-9);
}

// ── 3. Missing and throwing wildly drain ────────────────────────────────────
console.log('\n=== 3. Wild ===');
{
  const tidy = pace({ ppm: 60, his: 40, holdGuard: true, c: cfg }, true), wild = pace({ ppm: 70, his: 24, miss: 0.7, holdGuard: true, c: cfg }, true);
  check(`throwing wild (most of ${wild.thrown} missed) leaves less in the tank than a harder, tidier pace: average ${pct(wild.avg)} vs ${pct(tidy.avg)}, lowest ${pct(wild.min)} vs ${pct(tidy.min)}`, wild.avg < tidy.avg - 0.05 && wild.min < tidy.min - 0.05);
  check(`…and wears the ceiling for the fight: ${pct(wild.rounds[2].cap)} at the end against ${pct(tidy.rounds[2].cap)}`, wild.rounds[2].cap < tidy.rounds[2].cap - 0.08);
  // The far end of wild: a punch a quarter of a second, nothing landing, for 30 s.
  const c = { ...cfg, roundSeconds: 60 };
  let s = k.fresh(c, 2.2), tired = 0, gassed = 0;
  for (let i = 0; i < 1800; i++) { s = k.sim.step(s, [k.inp({ [['cross', 'hook'][Math.floor(i / 15) % 2]]: i % 15 === 0 }), k.NONE], c).state; if (s.fighters[0].fatigue > 0) tired++; if (s.fighters[0].stamina < c.lowStamina) gassed++; }
  check(`thirty seconds of nothing but missed power punches: tired ${pct(tired / 1800)} of it, gassed ${pct(gassed / 1800)}, ceiling down to ${pct(s.fighters[0].staminaCap)}`, tired / 1800 > 0.6 && gassed / 1800 > 0.3 && s.fighters[0].staminaCap < 0.8);
}

done();

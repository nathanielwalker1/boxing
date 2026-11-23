/**
 * closeness_test.mjs — the closeness measure (sim/outcome.ts Outcome.margin / evadeAge / evadeLeft, events' margin / ramp).
 *   npm run test:quick closeness
 * Margin sign conventions on scripted punches at known distances, the dodge timing fields, and determinism. The fields
 * are measured only: nothing may read them (the bit-identity of fights is checked in the slice's before / after run).
 */
import { load } from './load.mjs';
import { check, done } from './check.js';
import { loadMocapLib } from './lib/mocap_load.mjs';

const [core, sim, AI, mocap] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts', '/src/core/mocap.ts');
loadMocapLib(mocap);
const cfg = core.createConfig();
cfg.humanBody = true; cfg.mocapGeo = true; cfg.mocapOutcome = true;
core.applyHumanMode(cfg);
const inp = (o = {}) => ({ ...core.cloneInput(core.NULL_INPUT), ...o });

/** One throw by side 0 from `dist`, side 1 idle (or `opp(i)`); the first outcome events of side 0, with the hit-tick distance. */
function throwAt(dist, btn, opp = () => inp()) {
  const specs = [core.ROSTER[0], { ...core.ROSTER[1], heightM: core.ROSTER[0].heightM, stance: core.ROSTER[0].stance }];
  let s = sim.createState(specs, cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  s.fighters[0].yaw = 0; s.fighters[1].yaw = Math.PI;
  for (let i = 0; i < 40; i++) s = sim.step(s, [inp(), inp()], cfg).state;
  const slips = [];
  for (let i = 0; i < 90; i++) {
    const r = sim.step(s, [inp({ [btn]: i === 0 }), opp(i)], cfg);
    s = r.state;
    for (const e of r.events) if (e.type === 'slip' && e.dodged && e.side === 1) slips.push(e);
    const e = r.events.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock'));
    if (e) return { ...e, slips, hit: Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z) };
  }
  return { type: 'none', slips, hit: dist };
}

// ── 1. margin signs and size ──
for (const btn of ['jab', 'cross', 'hook']) {
  const far1 = throwAt(2.2, btn), far2 = throwAt(1.9, btn), near = throwAt(1.0, btn);
  check(`${btn}: a throw from well out is a whiff with margin > 0 (${far1.type}, ${far1.margin?.toFixed(3)})`, far1.type === 'punchWhiff' && !far1.dodged && far1.margin > 0);
  check(`${btn}: a throw from close lands with margin >= 0 (${near.type}, ${near.margin?.toFixed(3)})`, near.type === 'punchLand' && near.margin >= 0);
  // the same punch has the same far end: whiff margin + the distance gives it back, from two distances and from a land
  const farA = far1.hit - far1.margin, farB = far2.hit - far2.margin, farC = near.hit + near.margin;
  check(`${btn}: the reach implied by the margin (${farA.toFixed(3)} m) agrees from two whiffs and a land`, Math.abs(farA - farB) < 1e-6 && Math.abs(farA - farC) < 1e-6,
    `whiff1 ${farA.toFixed(4)}, whiff2 ${farB.toFixed(4)}, land ${farC.toFixed(4)}`);
}
{
  // the close-range ramp: a straight thrown from body contact lands at a fraction of full power; from range, 1; a hook never ramps
  const close = throwAt(cfg.mocapSeparation, 'jab'), far = throwAt(1.1, 'jab');
  check(`ramp: a jab from contact lands with ramp < 1 (${close.ramp?.toFixed(3)}), from range with ramp 1 (${far.ramp})`, close.type === 'punchLand' && close.ramp < 1 && close.ramp >= cfg.smotherPowerFloor - 1e-9 && far.ramp === 1);
}

// ── 2. a dodge: margin is far − d (>= 0) and carries the evade's age and what was left of its window ──
{
  const pull = throwAt(1.0, 'cross', i => inp({ move: { x: 0, y: i >= 12 && i < 14 ? -1 : 0 } }));
  const ev = pull.slips[0];
  check(`dodge: a timed pull dodges the cross: a whiff event marked dodged, margin >= 0 (${pull.type}, dodged ${pull.dodged}, margin ${pull.margin?.toFixed(3)})`, pull.type === 'punchWhiff' && pull.dodged === true && pull.margin >= 0);
  check(`dodge: age ${pull.evadeAge?.toFixed(3)} s + left ${pull.evadeLeft?.toFixed(3)} s = the evade window (${cfg.evadeWindow} s), age >= 0, on the slip event too`,
    pull.evadeAge >= 0 && pull.evadeLeft >= 0 && Math.abs(pull.evadeAge + pull.evadeLeft - cfg.evadeWindow) < 1e-9 && ev && ev.evadeAge === pull.evadeAge && ev.margin === pull.margin);
}

// ── 3. determinism: the same seeded fight twice gives the same final state ──
{
  const fight = seed => {
    const specs = [core.ROSTER[0], core.ROSTER[1]];
    let s = sim.createState(specs, cfg, seed);
    let a = AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), b = AI.createAi(1, seed, cfg, AI.styleFor(specs[1], cfg));
    let n = 0;
    for (let i = 0; i < 1800; i++) {
      const da = AI.aiStep(a, s, cfg), db = AI.aiStep(b, s, cfg); a = da.ai; b = db.ai;
      const r = sim.step(s, [da.input, db.input], cfg); s = r.state;
      for (const e of r.events) if (e.margin !== undefined) n++;
    }
    return { json: JSON.stringify(s), n };
  };
  const x = fight(9), y = fight(9), z = fight(10);
  check(`determinism: a seeded 30 s AI fight run twice ends in an identical state (${x.n} closeness events)`, x.json === y.json && x.n === y.n && x.n > 0);
  check('determinism: a different seed ends differently', x.json !== z.json);
}
done();

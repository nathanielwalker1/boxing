/**
 * ai_walk_test.mjs — the AI's footwork is not an evade (audit 2026-11-24, FrameInput.walk).
 * Human mode starts an evade on the PUSH, so an AI that began to back up or circle fired a lean back or a slip each time:
 * 92 evades in one fight against the 2 its AI chose, a quarter of them dodging and opening the counter window.
 *   1. a back push with `walk` set starts nothing; the same push without it is still the lean back (the human's tap)
 *   2. a side push the same
 *   3. in a human-mode AI fight the sim starts no more evades than the AIs chose (their macros)
 * Node, no browser. `node scripts/ai_walk_test.mjs`
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';

const k = await kit({ rated: true });
const cfg = k.core.createConfig();
cfg.humanBody = true; cfg.mocapGeo = true; cfg.mocapOutcome = true;
k.core.applyHumanMode(cfg);

const slipsFrom = (move, walk) => {
  const s = k.fresh(cfg, 1.4, 30);
  const { evs } = k.run(s, 30, i => [k.inp({ move: i < 12 ? move : { x: 0, y: 0 }, ...(walk ? { walk: true } : {}) }), k.NONE], cfg);
  return k.of(evs, 'slip').filter(e => e.side === 0);
};
check('a back push is the lean back (human)', slipsFrom({ x: 0, y: -1 }, false).length === 1);
check('a back push flagged walk starts no evade', slipsFrom({ x: 0, y: -1 }, true).length === 0);
check('a side push is the slip (human)', slipsFrom({ x: 1, y: 0 }, false).length === 1);
check('a side push flagged walk starts no evade', slipsFrom({ x: 1, y: 0 }, true).length === 0);

// 3. one medium fight, pressure v counter: evades the sim started against evades the AIs chose
const specs = ['pressure', 'counter'].map(style => ({ ...k.core.ROSTER[0], style }));
const acfg = { ...cfg, aiDifficulty: 1, roundSeconds: 30, roundCount: 1 };
let s = k.sim.createState(specs, acfg, 7);
let ais = specs.map((sp, i) => k.ai.createAi(i, 7 + i, acfg, k.ai.styleFor(sp, acfg, 1)));
const started = [0, 0];
let walked = 0, ticks = 0;
for (let t = 0; t < 60 * 40 && s.round.phase !== 'over'; t++) {
  const ins = ais.map((a, i) => { const r = k.ai.aiStep(a, s, acfg); ais[i] = r.ai; return r.input; });
  if (s.round.phase === 'fighting') { ticks += 2; walked += (ins[0].walk ? 1 : 0) + (ins[1].walk ? 1 : 0); }
  const r = k.sim.step(s, ins, acfg); s = r.state;
  for (const e of r.events) if (e.type === 'slip' && !e.dodged) started[e.side]++;
}
const meant = ais.map(a => a.used.slip + a.used.roll);
check('the steer flags its stick as footwork on most ticks', walked > 0.8 * ticks, `${walked} of ${ticks}`);
for (const i of [0, 1])
  check(`${specs[i].style}: the sim starts no more evades than the AI chose (+2 for chained moves)`, started[i] <= meant[i] + 2, `started ${started[i]}, chose ${meant[i]}`);
done();

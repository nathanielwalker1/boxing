/**
 * bots_test.mjs — the cheat bots and honest reference bots (scripts/bots/) and the fight runner under bot_ladder.mjs.
 *   npm run test:quick bots
 * Every bot returns a valid input every tick for 600 ticks, and one ladder fight is deterministic (same seed twice, same result).
 * Deliberately NOT asserted: that the cheat bots lose. That is a finding (bot_ladder.mjs), not a test yet.
 */
import { check, done } from './check.js';
import { makeEnv, participants, aiParticipants, fight } from './bots/fight.mjs';

const env = await makeEnv();
const { core, sim, AI, cfg } = env;
const ai = aiParticipants(AI);
console.log(`jab reach ${env.jabReach.toFixed(3)} m`);
check('jab reach is a sane distance', env.jabReach > 0.8 && env.jabReach < 2, String(env.jabReach));

const validInput = i => i && typeof i === 'object' && i.move && Number.isFinite(i.move.x) && Number.isFinite(i.move.y)
  && Math.hypot(i.move.x, i.move.y) <= 1.0001 && ['jab', 'cross', 'hook', 'uppercut', 'block', 'level'].every(k => typeof i[k] === 'boolean');

for (const p of participants()) {
  const specs = [{ ...core.ROSTER[0], style: p.style }, { ...core.ROSTER[0], style: 'pressure' }];
  let s = sim.createState(specs, cfg, 3);
  const bot = p.make(0, 3, { game: cfg, jabReach: env.jabReach, delay: 12 });
  let foe = AI.createAi(1, 3, cfg, AI.styleFor(specs[1], cfg));
  let bad = 0, punched = 0, first = '';
  for (let t = 0; t < 600; t++) {
    const mine = bot(s, t);
    if (!validInput(mine)) { bad++; if (!first) first = JSON.stringify(mine); }
    if (mine.jab || mine.cross || mine.hook || mine.uppercut) punched++;
    const d = AI.aiStep(foe, s, cfg); foe = d.ai;
    s = sim.step(s, [validInput(mine) ? mine : core.cloneInput(core.NULL_INPUT), d.input], cfg).state;
  }
  check(`${p.id}: valid input for 600 ticks`, bad === 0, `${bad} bad, first ${first}`);
  const neverPunches = p.id === 'runner' || p.id === 'turtle';
  check(`${p.id}: ${neverPunches ? 'never presses a punch' : 'presses punches'}`, neverPunches ? punched === 0 : punched > 0, `${punched} presses`);
}

// determinism: a bot v bot fight and a bot v AI fight, each twice with the same seed
const by = Object.fromEntries([...participants(), ...ai].map(p => [p.id, p]));
const sig = r => JSON.stringify({ w: r.winner, m: r.method, t: r.ticks, s: r.stats });
const a1 = fight(env, by.turtle_counter, by.masher_mix, 7), a2 = fight(env, by.turtle_counter, by.masher_mix, 7);
check('ladder fight: same seed, same result', sig(a1) === sig(a2), sig(a1) + ' vs ' + sig(a2));
check('ladder fight ends with a result', a1.method !== 'none', a1.method);
done();

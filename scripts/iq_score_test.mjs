/**
 * iq_score_test.mjs — the judges score what a punch does (cfg.iqScoring, docs/HIGH_IQ.md principles 1, 8, 9).
 *   npm run test:quick iq_score
 * With the key on: 6 clean crosses outscore 12 clean jabs; a round where one man lands nothing and the other has 20 punches
 * blocked goes 10-9 to the worker; a round one man clearly out-punched is not overturned by the other's work. With the key off a
 * seeded fight ends in the same state (and the same cards) as with the key absent.
 */
import { check, done } from './check.js';
import { makeEnv } from './bots/fight.mjs';
import { BOTS } from './bots/index.mjs';
import { load } from './load.mjs';

const env = await makeEnv();
const { core, sim, AI, cfg } = env;
const [round] = await load('/src/sim/round.ts');
const inp = (o = {}) => ({ move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false, ...o });

/** A mashes `punch` at a man who does `how` ('stand' | 'block') from about 0.75 m until `until(s, tally)` says stop. Returns the state and the tally. */
function mash(punch, how, until, seed = 5) {
  cfg.iqScoring = true;
  let s = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, seed);
  const tally = { clean: 0, blocked: 0, aLanded: 0, bLanded: 0 };
  for (let t = 0; t < 6000 && !until(s, tally); t++) {
    const a = inp(), d = inp();
    const dist = Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z);
    if (dist > 0.78) a.move = { x: 0, y: 1 }; else if (dist < 0.62) a.move = { x: 0, y: -0.5 };
    if (dist <= 0.78 && dist > 0.6 && s.round.phase === 'fighting' && t % 4 === 0) a[punch] = true;
    if (how === 'block') d.block = true;
    const r = sim.step(s, [a, d], cfg); s = r.state;
    for (const e of r.events) {
      if (e.type === 'punchLand' && e.side === 0) { tally.aLanded++; if (e.grade !== 'glancing') tally.clean++; }
      else if (e.type === 'punchLand' && e.side === 1) tally.bLanded++;
      else if (e.type === 'punchBlock' && e.side === 0) tally.blocked++;
    }
  }
  return { s, tally };
}

// ---- 1. a few hard clean punches beat a pile of light ones ----
// What the sim itself adds to the card for each clean land in real bot fights (a tick with exactly one land by one man).
{
  cfg.iqScoring = true;
  const val = { jab: [], cross: [], hook: [], uppercut: [] };
  for (const [x, y] of [['boxer', 'swarmer'], ['swarmer', 'counter'], ['counter', 'boxer'], ['masher_mix', 'counter']]) {
    const ps = [BOTS[x], BOTS[y]], seed = 11;
    let s = sim.createState(ps.map(p => ({ ...core.ROSTER[0], style: p.style })), cfg, seed);
    const drv = ps.map((p, side) => p.make(side, seed, { game: cfg, jabReach: env.jabReach, delay: 12 }));
    for (let t = 0; t < 4000 && s.round.phase !== 'over'; t++) {
      const before = [s.round.iqScore[0], s.round.iqScore[1]], idx = s.round.index;
      const r = sim.step(s, [drv[0](s, t), drv[1](s, t)], cfg); s = r.state;
      const lands = r.events.filter(e => e.type === 'punchLand');
      if (lands.length === 1 && s.round.index === idx && lands[0].grade !== 'glancing') val[lands[0].punch].push(s.round.iqScore[lands[0].side] - before[lands[0].side]);
    }
  }
  const med = a => [...a].sort((p, q) => p - q)[a.length >> 1];
  check('weight: the fights produced clean jabs and crosses', val.jab.length >= 5 && val.cross.length >= 5, `jab ${val.jab.length}, cross ${val.cross.length}, hook ${val.hook.length}, uppercut ${val.uppercut.length}`);
  const j = med(val.jab), c = med(val.cross);
  check('weight: 6 clean crosses outscore 12 clean jabs on the effective-punching card', 6 * c > 12 * j, `6 crosses ${(6 * c).toFixed(1)}, 12 jabs ${(12 * j).toFixed(1)} (jab ${j.toFixed(2)}, cross ${c.toFixed(2)})`);
  // (a median over whichever punches the sampled bot fights happen to throw: it moves when any fight rule moves, so the band is wide)
  check('weight: a clean cross is worth 2 to 4 jabs', c / j > 2 && c / j < 4, `${(c / j).toFixed(2)}`);
}

// ---- 2. the worker takes a round nobody landed in ----
{
  const { s, tally } = mash('jab', 'block', (st, t) => st.round.reached[0] >= 20);
  check('work: 20 punches reached the blocker', s.round.reached[0] >= 20, `reached ${s.round.reached[0]}`);
  check('work: the blocker landed nothing', tally.bLanded === 0 && s.round.reached[1] === 0, `blocker landed ${tally.bLanded}`);
  const card = round.scoreRound(s, cfg);
  check('work: the round goes 10-9 to the man whose punches were blocked', card[0] === 10 && card[1] === 9, JSON.stringify(card));
  const quiet = round.iqCall({ ...s.round, iqScore: [0, 0], reached: [20, 0], control: [0, 0] }, cfg);
  check('work: nothing landed, 20 blocked = the tie-break decided it', quiet.tieBreak && quiet.loser === 1, JSON.stringify(quiet));
  const level = round.iqCall({ ...s.round, iqScore: [0, 0], reached: [0, 0], control: [0, 0] }, cfg);
  check('work: a round where nobody did anything is still 10-10', level.loser === null, JSON.stringify(level));
}

// ---- 3. clear punching is not overturned by work ----
{
  const s = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, 5);
  s.round.iqScore = [60, 20]; s.round.reached = [10, 40]; s.round.control = [0, 30];   // he out-punched him 3 to 1; the other man did far more work
  const card = round.scoreRound(s, cfg);
  check('clear: 60 vs 20 on punching stays 10-9 to the puncher whatever the work', card[0] === 10 && card[1] === 9, JSON.stringify(card));
  s.round.iqScore = [60, 55]; s.round.reached = [10, 40];
  const close = round.scoreRound(s, cfg);
  check('close: 60 vs 55 on punching with 4x the work goes to the worker', close[0] === 9 && close[1] === 10, JSON.stringify(close));
  s.round.iqScore = [60, 55]; s.round.reached = [10, 11]; s.round.control = [0, 0];
  const lead = round.scoreRound(s, cfg);
  check('close: work inside the lead margin is 10-10', lead[0] === 10 && lead[1] === 10, JSON.stringify(lead));
}

// ---- 4. key off = key absent, bit for bit ----
{
  const play = absent => {
    const c = core.createConfig();
    c.humanBody = true; c.mocapGeo = true; c.mocapOutcome = true; c.humanIqScoring = false;
    core.applyHumanMode(c);
    if (absent) delete c.iqScoring; else c.iqScoring = false;
    const specs = [{ ...core.ROSTER[0], style: 'pressure' }, { ...core.ROSTER[0], style: 'counter' }];
    let s = sim.createState(specs, c, 21);
    const bot = BOTS.masher_mix.make(0, 21, { game: c, jabReach: env.jabReach, delay: 12 });
    let foe = AI.createAi(1, 21, c, AI.styleFor(specs[1], c));
    for (let t = 0; t < 2400; t++) {   // past the end of round 1, so the card is in the state
      const mine = bot(s, t), d = AI.aiStep(foe, s, c); foe = d.ai;
      s = sim.step(s, [mine, d.input], c).state;
    }
    return JSON.stringify(s);
  };
  const a = play(false), b = play(true);
  check('key off: a 2400-tick seeded fight (one card in) ends in the same state as with the key absent', a === b, `${a.length} vs ${b.length} chars`);
  check('key off: the first round was scored', JSON.parse(a).round.score.length >= 1, JSON.stringify(JSON.parse(a).round.score));
}

done();

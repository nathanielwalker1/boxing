/**
 * iq_miss_test.mjs — the cost of missing (cfg.iqMissCost, docs/HIGH_IQ.md principle 6).
 *   npm run test:quick iq_miss
 * A mashed jab at a standing man. With the key on: a clean land still chains as fast as before (same start gap, same shortened
 * wind-up); a block waits for the chain point and gets the cold wind-up; a miss by more costs a longer recovery than a miss by
 * less. With the key off a seeded fight ends in exactly the state it does with the key absent.
 */
import { check, done } from './check.js';
import { makeEnv } from './bots/fight.mjs';
import { BOTS } from './bots/index.mjs';
import { load } from './load.mjs';

const env = await makeEnv();
const { core, sim, AI, cfg } = env;
const [outcome] = await load('/src/sim/outcome.ts');
const inp = (o = {}) => ({ move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false, ...o });

/** Mash jab every 4 ticks from `want` metres away at a man who does `how`; returns the jab starts [{ t, tell }] and what resolved each. */
function run(iq, how, want, seed = 5, ticks = 700) {
  cfg.iqMissCost = iq;
  let s = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, seed);
  const starts = [], res = [];
  for (let t = 0; t < ticks; t++) {
    const a = inp(), d = inp();
    const dist = Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z);
    if (dist > want + 0.03) a.move = { x: 0, y: 1 }; else if (dist < want - 0.12) a.move = { x: 0, y: -0.5 };
    if (dist <= want + 0.03 && dist > want - 0.15 && s.round.phase === 'fighting' && t % 4 === 0) a.jab = true;   // pressed standing, never mid-step: one variant, one cold wind-up
    if (how === 'block') d.block = true;
    const r = sim.step(s, [a, d], cfg); s = r.state;
    for (const e of r.events) {
      if (e.side !== 0) continue;
      if (e.type === 'punchStart') starts.push({ t, tell: e.tell });
      else if (e.type === 'punchLand') res.push({ t, cls: e.grade === 'glancing' ? 'glance' : 'clean' });
      else if (e.type === 'punchBlock') res.push({ t, cls: 'block' });
      else if (e.type === 'punchWhiff') res.push({ t, cls: e.dodged ? 'dodge' : 'whiff', margin: e.margin });
    }
  }
  return { starts, res };
}

/** The punch that resolved first as `cls`, and the one after it: { gap: ticks between their starts, cold: its tell, next: the next one's tell }. */
function after(r, cls) {
  const x = r.res.find(q => q.cls === cls);
  if (!x) return null;
  let i = -1; r.starts.forEach((st, k) => { if (st.t < x.t) i = k; });
  if (i < 0 || i + 1 >= r.starts.length) return null;
  return { gap: r.starts[i + 1].t - r.starts[i].t, cold: r.starts[i].tell, next: r.starts[i + 1].tell, margin: x.margin };
}

const s0 = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, 5);
const band = outcome.punchBand(s0.fighters[0], 'jab', 'lead', 'jab', cfg, s0.fighters[1]);
const CLEAN = 1.15;   // a clean (not glancing) jab on a standing man (probed: 1.1 and up is clean for jab and cross)

let chainedTell = 0;   // the shortened wind-up of a jab chained off a clean land, s
// ---- 1. a clean land chains as fast as before ----
{
  const off = run(false, 'idle', CLEAN), on = run(true, 'idle', CLEAN);
  // the second jab: the first chained start, after a first jab that landed clean
  const second = r => (r.res[0] && r.res[0].cls === 'clean' && r.starts.length > 1) ? { gap: r.starts[1].t - r.starts[0].t, tell: r.starts[1].tell, cold: r.starts[0].tell } : null;
  const a = second(off), b = second(on);
  check('clean land: the first jab landed clean in both runs', !!a && !!b, JSON.stringify({ a, b }));
  if (a && b) {
    chainedTell = b.tell;
    check('clean land: the next jab starts on the same tick with the key on', a.gap === b.gap, `off ${a.gap}, on ${b.gap}`);
    check('clean land: the chained wind-up is still the short one', b.tell < b.cold - 1e-9 && Math.abs(a.tell - b.tell) < 1e-9, `cold ${b.cold}, chained on ${b.tell}, off ${a.tell}`);
  }
}

// ---- 2. a block waits for the chain point and the wind-up is cold ----
{
  const off = after(run(false, 'block', CLEAN), 'block'), on = after(run(true, 'block', CLEAN), 'block');
  check('block: a jab was blocked and followed by another', !!off && !!on, JSON.stringify({ off, on }));
  if (off && on) {
    check('block: the next jab starts later than with the key off', on.gap > off.gap, `off ${off.gap}, on ${on.gap} ticks`);
    check('block: the next jab has the full cold wind-up', Math.abs(on.next - on.cold) < 1e-9, `cold ${on.cold}, next ${on.next}`);
    check('block: with the key off the next jab keeps the short wind-up', off.next < off.cold - 1e-9, `cold ${off.cold}, next ${off.next}`);
    check('block: the gap is longer than the wind-up and extension alone (the chain point is later in the recovery)', on.gap > Math.ceil(on.cold * 60), `gap ${on.gap}, tell ${Math.ceil(on.cold * 60)} ticks`);
  }
}

// ---- 3. a miss by more costs a longer recovery ----
{
  const near = after(run(true, 'idle', band.far + 0.05), 'whiff'), far = after(run(true, 'idle', band.far + 0.5), 'whiff');
  const offNear = after(run(false, 'idle', band.far + 0.05), 'whiff');
  check('miss: both runs whiffed and threw again', !!near && !!far && !!offNear, JSON.stringify({ near, far, offNear }));
  if (near && far && offNear) {
    check('miss: the margins are what was asked for', far.margin > near.margin + 0.1, `near ${near.margin}, far ${far.margin}`);
    check('miss: the bigger miss leaves a longer gap to the next punch', far.gap > near.gap, `near ${near.gap}, far ${far.gap} ticks`);
    check('miss: the next jab is not the short chained one (a cold throw, step-in or standing)', near.next > chainedTell + 0.05 && far.next > chainedTell + 0.05, `chained ${chainedTell}, next ${near.next} / ${far.next}`);
    check('miss: a small miss with the key on is slower than with it off', near.gap > offNear.gap, `on ${near.gap}, off ${offNear.gap}`);
  }
}

// ---- 4. key off = key absent, bit for bit ----
{
  const play = absent => {
    const c = core.createConfig();
    c.humanBody = true; c.mocapGeo = true; c.mocapOutcome = true; c.humanIqMissCost = false;
    core.applyHumanMode(c);
    if (absent) delete c.iqMissCost; else c.iqMissCost = false;
    const specs = [{ ...core.ROSTER[0], style: 'pressure' }, { ...core.ROSTER[0], style: 'counter' }];
    let s = sim.createState(specs, c, 21);
    const bot = BOTS.masher_mix.make(0, 21, { game: c, jabReach: env.jabReach, delay: 12 });
    let foe = AI.createAi(1, 21, c, AI.styleFor(specs[1], c));
    for (let t = 0; t < 1800; t++) {
      const mine = bot(s, t), d = AI.aiStep(foe, s, c); foe = d.ai;
      s = sim.step(s, [mine, d.input], c).state;
    }
    return JSON.stringify(s);
  };
  const a = play(false), b = play(true);
  check('key off: a 1800-tick seeded fight ends in the same state as with the key absent', a === b, `${a.length} vs ${b.length} chars`);
}

done();

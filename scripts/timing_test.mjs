/** timing_test.mjs — punch phases, resolve moment and duration match config within one tick (port of legacy timing_test). */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim, punches] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/sim/punches.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT } = core;
const { punchPhases, PUNCHES } = punches;
const cfg = createConfig();
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const FAR = 1.3;   // whiff range: no hit-stop, so the clock is undisturbed

function fresh(c = cfg) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -FAR / 2, z: 0 }; s.fighters[1].pos = { x: FAR / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}

// ── 1. Derived phase fractions (legacy punchPhases) ─────────────────────────
const TYPES = ['jab', 'cross', 'hook', 'uppercut'];
for (const t of TYPES) {
  const p = punchPhases(cfg, t);
  const cock = cfg[`${t}Cock`], ext = cfg[`${t}Extend`], rec = cfg[`${t}Recover`];
  check(`${t}: total = cock + extend + recover`, near(p.total, cock + ext + rec, 1e-12));
  check(`${t}: cockEnd = cock / total`, near(p.cockEnd, cock / p.total, 1e-12));
  check(`${t}: peakAt = (cock + extend) / total`, near(p.peakAt, (cock + ext) / p.total, 1e-12));
  check(`${t}: cocks for longer than it extends (the telegraph)`, cock > ext);
}
check('cock ordering is jab < cross < hook < uppercut (the telegraph gradient)', cfg.jabCock < cfg.crossCock && cfg.crossCock < cfg.hookCock && cfg.hookCock < cfg.uppercutCock);
check('all four punches are in the table', TYPES.every(t => PUNCHES[t] !== undefined));
{
  const x2 = punchPhases({ ...cfg, punchTimeScale: 2 }, 'jab'), x1 = punchPhases(cfg, 'jab');
  check('punchTimeScale ×2 doubles the total and leaves the fractions alone', near(x2.total, x1.total * 2, 1e-12) && near(x2.peakAt, x1.peakAt, 1e-12));
}

// ── 2. A thrown punch runs on that clock ────────────────────────────────────
function trace(type, c = cfg) {
  let s = fresh(c);
  const phases = [], progress = [];
  let resolveTick = null, endTick = null, resolvedFlagTick = null;
  for (let i = 0; i < 60; i++) {
    const r = sim.step(s, [inp({ [type]: i === 0 }), NONE], c);
    s = r.state;
    const p = s.fighters[0].punch;
    if (p.type !== null) { phases.push(p.phase); progress.push(p.progress); }
    if (resolvedFlagTick === null && p.resolved) resolvedFlagTick = i;
    for (const e of r.events) if (e.type === 'punchWhiff') resolveTick = i;
    if (endTick === null && i > 0 && p.type === null) endTick = i;
  }
  return { phases, progress, resolveTick, endTick, resolvedFlagTick };
}
for (const t of TYPES) {
  const p = punchPhases(cfg, t);
  const tr = trace(t);
  const wantResolve = Math.ceil((p.cock + p.extend) / SIM_DT) - 1;   // press tick counts as the first dt
  const wantEnd = Math.ceil(p.total / SIM_DT) - 1;
  check(`${t}: resolves at the configured progress (tick ${wantResolve})`, Math.abs(tr.resolveTick - wantResolve) <= 1, `resolved on tick ${tr.resolveTick}`);
  check(`${t}: resolved flag is set on the resolve tick`, tr.resolvedFlagTick === tr.resolveTick);
  check(`${t}: duration matches config within one tick (tick ${wantEnd})`, Math.abs(tr.endTick - wantEnd) <= 1, `ended on tick ${tr.endTick}`);
  const seq = tr.phases.filter((x, i) => i === 0 || tr.phases[i - 1] !== x).join('→');
  check(`${t}: phases run cock→extend→recover`, seq === 'cock→extend→recover', seq);
  check(`${t}: progress is monotonic and ends near 1`, tr.progress.every((x, i) => i === 0 || x > tr.progress[i - 1]) && tr.progress[tr.progress.length - 1] > 0.9);
  const firstRecover = tr.phases.indexOf('recover');
  check(`${t}: the recover phase begins on the resolve tick`, firstRecover === tr.resolveTick, `recover from ${firstRecover}`);
}
{
  const slow = { ...cfg, punchTimeScale: 2 };
  const a = trace('jab'), b = trace('jab', slow);
  check('punchTimeScale ×2 makes a live jab take twice as long', Math.abs(b.endTick - (2 * (a.endTick + 1) - 1)) <= 1, `${a.endTick} → ${b.endTick}`);
  check('…and resolve twice as late', Math.abs(b.resolveTick - (2 * (a.resolveTick + 1) - 1)) <= 1, `${a.resolveTick} → ${b.resolveTick}`);
}
{
  // Lean and torso twist ride the punch: peak at the resolve moment, zero after.
  let s = fresh(), peakLean = 0, peakTwist = 0;
  for (let i = 0; i < 30; i++) {
    s = sim.step(s, [inp({ cross: i === 0 }), NONE], cfg).state;
    peakLean = Math.max(peakLean, s.fighters[0].lean.fwd);
    peakTwist = Math.max(peakTwist, Math.abs(s.fighters[0].torsoTwist));
  }
  check('forward lean peaks at punchLean during the cross', near(peakLean, cfg.punchLean, 0.05), `${peakLean.toFixed(3)}`);
  check('torso twist peaks at the cross\'s turn', near(peakTwist, PUNCHES.cross.turn, 0.1), `${peakTwist.toFixed(3)}`);
  check('lean and twist are back to zero after the punch', s.fighters[0].lean.fwd === 0 && s.fighters[0].torsoTwist === 0);
  let h = fresh(), peakHook = 0;
  for (let i = 0; i < 30; i++) {
    h = sim.step(h, [inp({ hook: i === 0, move: { x: i === 0 ? -1 : 0, y: 0 } }), NONE], cfg).state;
    peakHook = Math.max(peakHook, Math.abs(h.fighters[0].torsoTwist));
  }
  check('a hook turns the torso to its own turn (0.7), less than the cross', near(peakHook, PUNCHES.hook.turn, 0.1) && peakHook < peakTwist, `${peakHook.toFixed(3)}`);
}

// ── 3. Round clock ──────────────────────────────────────────────────────────
{
  const short = { ...cfg, roundSeconds: 1 };
  let s = sim.createState(specs, short, 1);
  const evs = [];
  const first = sim.step(s, [NONE, NONE], short);
  check('the first tick rings the opening bell and starts round 0', first.events.some(e => e.type === 'bell') && first.events.some(e => e.type === 'roundStart' && e.index === 0));
  s = first.state;
  let endTick = null;
  for (let i = 1; i < 120; i++) {
    const r = sim.step(s, [inp({ move: { x: 1, y: 0 } }), NONE], short);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (endTick === null && s.round.phase === 'over') endTick = i;
  }
  const end = evs.find(e => e.type === 'roundEnd');
  check('the clock counts down to 0 and the round ends on time', endTick !== null && Math.abs(endTick - 59) <= 1 && s.round.clock === 0, `over at tick ${endTick}`);
  check('roundEnd carries index 0 and a 10-10 score, with a bell', end?.index === 0 && end?.score[0] === 10 && end?.score[1] === 10 && evs.some(e => e.type === 'bell' && e.tick === end.tick));
  check('score is recorded on the round', s.round.score.length === 1);
  const after = sim.step(s, [inp({ move: { x: 1, y: 0 }, jab: true }), NONE], short);
  check('after the round is over, inputs are ignored', after.state.fighters[0].punch.type === null && !after.events.some(e => e.type === 'punchStart'));
  check('health and stamina stay at 1 in Stage 1', s.fighters.every(f => f.health === 1 && f.stamina === 1));
}

done();

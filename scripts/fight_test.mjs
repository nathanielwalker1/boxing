/**
 * fight_test.mjs — the fight state machine: rounds and the rest between them,
 * corners, the judges' tallies and 10-point-must cards, the decision, the
 * referee's 10-count with the chin-based get-up, KO vs TKO (CONTRACT §8).
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT } = core;
// Short rounds so a whole fight is a few hundred ticks; no stamina cost so nothing goes gassed mid-test.
// jabHealthFloor 0 (overhaul 2026-11-11): the knockdown cases here floor a man with jabs; by default a jab can no longer empty the bar (attrition_test pins that).
// ratingsOn / stylesOn off (overhaul phase 2): this file pins the reference fighters' numbers and margins as they were before
// ratings and guard shapes did anything — both un-rated, both in the high guard. ratings_test / styles_test cover those.
const cfg = { ...({ ...createConfig(), ratingsOn: false, stylesOn: false }), roundSeconds: 2, betweenRoundSeconds: 1, roundCount: 3, staminaPunchCost: 0, jabHealthFloor: 0 };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;
const T = s => Math.round(s / SIM_DT);

function fresh(dist = MID, c = cfg, sp = specs, seed = 1) {
  let s = sim.createState(sp, c, seed);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
function run(s, n, inputs, onTick, c = cfg) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, inputs(i), c);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (onTick) onTick(s, i, r.events);
  }
  return { s, evs };
}
const of = (evs, type) => evs.filter(e => e.type === type);
const ROUND = T(cfg.roundSeconds), REST = T(cfg.betweenRoundSeconds);

// ── 1. Rounds and the rest between them ─────────────────────────────────────
{
  // fresh() already spent 30 ticks of round 0; the clock has ROUND − 30 ticks left.
  const left = T(fresh().round.clock);
  const trace = [];
  // A short walk forward, not a whole round of it: a fighter still pushing into the other at the bell is shoved apart by separation for a tick.
  const walk = i => i < 15 || (i > left + REST + 5 && i < left + REST + 25);   // a few steps in round 0, a few more once round 1 is on
  const { s, evs } = run(fresh(), left + REST + 40, i => [inp({ move: { x: 0, y: walk(i) ? 1 : 0 }, jab: i === left + 5 }), NONE], (st, i) => trace.push({ i, ph: st.round.phase, idx: st.round.index, clock: st.round.clock, x0: st.fighters[0].pos.x }));
  const end0 = of(evs, 'roundEnd')[0];
  check('the clock runs out and round 0 ends with a bell and a 10-10 card (nobody landed)', end0 && end0.index === 0 && end0.score[0] === 10 && end0.score[1] === 10 && of(evs, 'bell').some(b => b.tick === end0.tick), JSON.stringify(end0));
  check('…into the rest, not the end of the fight', trace[end0.tick].ph === 'between' && !evs.some(e => e.type === 'decision'));
  const rest = trace.slice(end0.tick, end0.tick + REST - 1);
  const bad = rest.find(t => !(t.ph === 'between' && t.clock === 0 && near(t.x0, trace[end0.tick].x0, 1e-9)));
  check('the clock holds at 0 through the rest and nothing moves or punches', !bad && !evs.some(e => e.type === 'punchStart'), bad ? `tick ${bad.i}: ${bad.ph} clock ${bad.clock} x0 ${bad.x0.toFixed(4)} vs ${trace[end0.tick].x0.toFixed(4)}` : `punchStart ${evs.filter(e => e.type === 'punchStart').map(e => e.tick)}`);
  const start1 = of(evs, 'roundStart').find(e => e.index === 1);
  check(`round 1 starts ${cfg.betweenRoundSeconds} s later with a bell`, start1 && Math.abs(start1.tick - (end0.tick + REST)) <= 1 && of(evs, 'bell').some(b => b.tick === start1.tick), `started ${start1?.tick}, expected ~${end0.tick + REST}`);
  check('…with a fresh clock and index 1', trace[start1.tick].idx === 1 && near(trace[start1.tick].clock, cfg.roundSeconds, 1e-9) && trace[start1.tick].ph === 'fighting', `${trace[start1.tick].clock}`);
  check('the clock runs from the next tick', near(trace[start1.tick + 1].clock, cfg.roundSeconds - SIM_DT, 1e-9));
  check('the fighter who walked forward all round is back in the corner', trace[start1.tick - 1].x0 > -0.3 && near(trace[start1.tick].x0, -1.2, 1e-9), `${trace[start1.tick - 1].x0.toFixed(2)} → ${trace[start1.tick].x0.toFixed(2)}`);
  check('the sim keeps taking input in round 1', s.round.phase === 'fighting' && s.fighters[0].pos.x > -1.2 + 0.01);
}
{
  // The stool: part of the missing bars comes back; the round's knockdown pips clear.
  // (Stamina and health regen off, or the bars refill on their own before the bell.)
  const noRegen = { ...cfg, staminaRegen: 0, healthRegen: 0 };
  let s = fresh(MID, noRegen);
  s.fighters[0].health = 0.5; s.fighters[0].stamina = 0.5; s.fighters[0].knockdowns = 1;
  const left = T(s.round.clock);
  const { s: r1 } = run(s, left + REST + 2, () => [NONE, NONE], null, noRegen);
  check('between rounds a fraction of the missing health comes back', r1.round.index === 1 && near(r1.fighters[0].health, 0.5 + 0.5 * cfg.betweenRoundHealthRestore, 1e-9), `${r1.fighters[0].health}`);
  check('…and of the missing stamina', near(r1.fighters[0].stamina, 0.5 + 0.5 * cfg.betweenRoundStaminaRestore, 1e-6), `${r1.fighters[0].stamina}`);
  check('the round\'s knockdowns are cleared (pips are per round)', r1.fighters[0].knockdowns === 0);
}

// ── 2. The judges ───────────────────────────────────────────────────────────
{
  // Hit-stop slows the clock a few ticks per landed punch, so run past the nominal end and read the card from the event.
  const left = T(fresh().round.clock) + 30;
  let tally = null;
  // (The first jab stumbles the dummy back ~30 cm now, so the player walks in before the second.)
  const two = run(fresh(), left, i => [inp({ jab: i === 0 || i === 40, move: { x: 0, y: i > 12 && i < 38 ? 1 : 0 } }), NONE], (st, i, ev) => { if (st.round.phase === 'fighting' && !ev.some(e => e.type === 'roundEnd')) tally = { landed: [...st.round.landed], power: [...st.round.power] }; });
  const card = of(two.evs, 'roundEnd')[0]?.score;
  check('two clean jabs: the tally counts them and their impulse', two.s.round.score.length === 1 && of(two.evs, 'punchLand').length === 2 && Math.abs(tally?.landed[0] - of(two.evs, 'punchLand').reduce((n, e) => n + (e.grade === 'glancing' ? cfg.scoreGlancing : 1), 0)) < 1e-9 /* phase 4: a glancing land counts scoreGlancing */ && tally?.landed[1] === 0 && tally?.power[0] > 200 && tally?.power[1] === 0, `${of(two.evs, 'punchLand').length} lands, tally ${JSON.stringify(tally)}`);
  check('the busier fighter takes the round 10-9', card && card[0] === 10 && card[1] === 9, JSON.stringify(card));
  const next = run(two.s, REST + 5, () => [NONE, NONE]);
  check('the tallies reset at the next bell', next.s.round.index === 1 && next.s.round.landed[0] === 0 && next.s.round.power[0] === 0);
  const other = run(fresh(), left, i => [NONE, inp({ jab: i === 0 })]);
  check('…either way round', JSON.stringify(of(other.evs, 'roundEnd')[0]?.score) === '[9,10]');
  // Phase 4, control: a punch he makes the other man miss is credit to him. Side 0 swings at air from 2 m; nobody lands.
  let ctl = null;
  const air = run(fresh(2.0), left, i => [inp({ cross: i === 0 }), NONE], (st, i, ev) => { if (st.round.phase === 'fighting' && !ev.some(e => e.type === 'roundEnd')) ctl = [...st.round.control]; });
  check('a miss is control for the man who was not there (the tally), but with nothing landed it wins no round: control counts only up to what he landed', of(air.evs, 'punchWhiff').length === 1 && ctl?.[1] === 1 && ctl?.[0] === 0 && JSON.stringify(of(air.evs, 'roundEnd')[0]?.score) === '[10,10]', `control ${JSON.stringify(ctl)}, card ${JSON.stringify(of(air.evs, 'roundEnd')[0]?.score)}`);
  const card2 = (landed, power, control, c = cfg) => { const st = fresh(); st.round.landed = landed; st.round.power = power; st.round.control = control; return JSON.stringify(sim.scoreRound(st, c)); };
  check('level on punches and power, the man who made the other miss takes the round', card2([3, 3], [600, 600], [0, 2]) === '[9,10]' && card2([3, 3], [600, 600], [2, 0]) === '[10,9]');
  check('…and scoreControlWeight 0 makes it level again', card2([3, 3], [600, 600], [0, 2], { ...cfg, scoreControlWeight: 0 }) === '[10,10]');
  check(`three clean jabs out-score two crosses (scorePowerWeight ${cfg.scorePowerWeight})`, card2([3, 2], [3 * 195, 2 * 272], [0, 0]) === '[10,9]');
  // Blocked punches are not landed punches.
  const blocked = run(fresh(), left, i => [inp({ jab: i === 0 }), inp({ block: true })]);
  check('a blocked punch does not score', of(blocked.evs, 'punchBlock').length === 1 && JSON.stringify(of(blocked.evs, 'roundEnd')[0]?.score) === '[10,10]');
  // One jab each, but a cross for side 1: equal lands, power decides.
  // (Overhaul 2026-11-11: the jab knocks side 1 back to the end of its cross's reach, where the cross would be graded
  // GLANCING and score under the jab. Side 1 steps back in first, so this stays a test of the judges, not of range.)
  const power = run(fresh(), left, i => [inp({ jab: i === 0 }), inp({ cross: i === 40, move: { x: 0, y: i >= 20 && i < 27 ? 1 : 0 } })]);
  check('equal lands: the harder puncher takes it on power', of(power.evs, 'punchLand').length === 2 && JSON.stringify(of(power.evs, 'roundEnd')[0]?.score) === '[9,10]', JSON.stringify(of(power.evs, 'roundEnd')[0]?.score));
  // A knockdown costs a point: 10-8.
  const heavy = { ...cfg, healthDamagePerImpulse: 1, getUpJitter: 0 };
  const kd = run(fresh(MID, heavy), left + 400, i => [inp({ jab: i === 0 }), NONE], null, heavy);
  const kdCard = of(kd.evs, 'roundEnd')[0]?.score;
  check('a knockdown costs the floored fighter a point: 10-8', of(kd.evs, 'getUp').length === 1 && kdCard && kdCard[0] === 10 && kdCard[1] === 8, JSON.stringify(kdCard));
}

// ── 3. The decision ─────────────────────────────────────────────────────────
{
  // Side 0 lands one jab early in every round; nothing else happens. Later
  // rounds start in the corners (2.4 m apart), so the test walks them to MID
  // at each bell the way the fighters would; round 0's start happened inside
  // fresh(), so the run sees two roundStarts.
  const FIGHT = 3 * ROUND + 2 * REST + 40;
  const starts = new Set();
  const { s, evs } = run(fresh(), FIGHT, i => [inp({ jab: [...starts].some(t => i === t + 5) || i === 0 }), NONE], (st, i, ev) => {
    for (const e of ev) if (e.type === 'roundStart') { starts.add(i); st.fighters[0].pos = { x: -MID / 2, z: 0 }; st.fighters[1].pos = { x: MID / 2, z: 0 }; }
  });
  const d = of(evs, 'decision')[0];
  check('after the last round the fight goes to the cards', d && s.round.phase === 'over' && of(evs, 'roundEnd').length === 3, `${of(evs, 'roundEnd').length} rounds`);
  check('three 10-9 rounds: side 0 wins the decision', d && d.winner === 0 && d.cards.length === 3 && d.cards.every(c => c[0] === 10 && c[1] === 9), JSON.stringify(d?.cards));
  check('no fourth round starts', of(evs, 'roundStart').length === 2 && Math.max(...of(evs, 'roundStart').map(e => e.index)) === 2);
  const after = run(s, 20, i => [inp({ jab: i === 0 }), NONE]);
  check('after the decision inputs are ignored', !after.evs.some(e => e.type === 'punchStart'));
  const quiet = run(fresh(), FIGHT, () => [NONE, NONE]);
  const qd = of(quiet.evs, 'decision')[0];
  check('nothing landed all fight: a draw (winner null, three 10-10 cards)', qd && qd.winner === null && qd.cards.every(c => c[0] === 10 && c[1] === 10));
}

// ── 4. The referee's count ──────────────────────────────────────────────────
// One landed jab floors the dummy. The round is long enough to hold a full
// count: since 2026-10-15 the clock runs through the count, and a 2 s round
// would end on the get-up.
const heavy = { ...cfg, healthDamagePerImpulse: 1, roundSeconds: 20 };
const TICK = T(cfg.countTickSeconds);
{
  const trace = [];
  const { evs } = run(fresh(MID, heavy), 12 * TICK + 20, i => [inp({ jab: i === 0 }), NONE], (st, i) => trace.push({ i, ph: st.round.phase, n: st.round.count, clock: st.round.clock, down: st.fighters[1].down }), heavy);
  const kd = of(evs, 'knockdown')[0], gu = of(evs, 'getUp')[0], ticks = of(evs, 'countTick');
  check('the count starts at the knockdown', kd && trace[kd.tick].ph === 'count' && trace[kd.tick].n === 0);
  // The knockdown punch's hit-stop slows the first count by a couple of ticks (the count runs on sim time, as everything does); the spacing is what is exact.
  check(`countTick events come every countTickSeconds (${TICK} ticks), numbered from 1`, ticks.length > 0 && ticks.every((t, k) => t.n === k + 1 && t.side === 1 && (k === 0 ? t.tick - kd.tick >= TICK && t.tick - kd.tick <= TICK + 4 : Math.abs(t.tick - ticks[k - 1].tick - TICK) <= 1)), ticks.map(t => `${t.n}@${t.tick}`).join(' '));
  check('round.count follows the referee', ticks.every(t => trace[t.tick].n === t.n));
  const chin = ROSTER[1].chin / 100;
  const expect = cfg.getUpCountWorst + (cfg.getUpCountBest - cfg.getUpCountWorst) * chin;
  check(`they rise inside the roll: count ${(expect - cfg.getUpJitter).toFixed(1)}–${(expect + cfg.getUpJitter).toFixed(1)} for chin ${ROSTER[1].chin}`, gu && (gu.tick - kd.tick) / TICK >= expect - cfg.getUpJitter - 0.05 && (gu.tick - kd.tick) / TICK <= expect + cfg.getUpJitter + 0.05, `rose at count ${((gu?.tick - kd?.tick) / TICK).toFixed(2)}`);
  check('the count stops when they rise, and the fight resumes with count 0', ticks.every(t => t.tick <= gu.tick) && trace[gu.tick].ph === 'fighting' && trace[gu.tick].n === 0 && !trace[gu.tick].down);
  // 2026-10-15 (Nate): the round clock keeps running through the count, as it does in a real round.
  check('the clock runs through the count (never up, and well down by the get-up)', trace.slice(kd.tick + 1, gu.tick + 1).every((t, k, arr) => k === 0 || t.clock <= arr[k - 1].clock) && trace[gu.tick].clock < trace[kd.tick].clock - 0.5, `${trace[kd.tick].clock.toFixed(3)} → ${trace[gu.tick].clock.toFixed(3)}`);
}
{
  // Chin decides the count: the same knockdown, no jitter, an iron chin vs a glass one.
  const noJitter = { ...heavy, getUpJitter: 0 };
  const riseAt = chin => {
    const sp = [ROSTER[0], { ...ROSTER[1], chin }];
    const { evs } = run(fresh(MID, noJitter, sp), 12 * TICK + 20, i => [inp({ jab: i === 0 }), NONE], null, noJitter);
    const kd = of(evs, 'knockdown')[0], gu = of(evs, 'getUp')[0];
    return { count: gu ? (gu.tick - kd.tick) / TICK : null, ko: of(evs, 'ko')[0], ticks: of(evs, 'countTick').length };
  };
  const iron = riseAt(100), glass = riseAt(0), mid = riseAt(50);
  check(`chin 100 rises on ${cfg.getUpCountBest}`, iron.count !== null && Math.abs(iron.count - cfg.getUpCountBest) <= 1.5 / TICK + 0.05, `${iron.count}`);
  check(`chin 0 rises on ${cfg.getUpCountWorst}`, glass.count !== null && Math.abs(glass.count - cfg.getUpCountWorst) <= 1.5 / TICK + 0.05, `${glass.count}`);
  check('a better chin gets up sooner', iron.count < mid.count && mid.count < glass.count, `${iron.count} < ${mid.count} < ${glass.count}`);
  check('nobody was counted out', !iron.ko && !glass.ko);
}
{
  // A second knockdown in the round adds getUpCountPerKnockdown: the glass chin does not beat ten.
  const noJitter = { ...heavy, getUpJitter: 0 };
  const sp = [ROSTER[0], { ...ROSTER[1], chin: 0 }];
  let s = fresh(MID, noJitter, sp);
  s.fighters[1].knockdowns = 1;
  const trace = [];
  const { s: out, evs } = run(s, 12 * TICK + 20, i => [inp({ jab: i === 0 }), NONE], (st, i) => trace.push({ i, ph: st.round.phase, n: st.round.count }), noJitter);
  const ko = of(evs, 'ko')[0], kd = of(evs, 'knockdown')[0];
  check('the second knockdown of the round: they hear ten', of(evs, 'countTick').length === 10 && !evs.some(e => e.type === 'getUp'));
  const ten = of(evs, 'countTick').find(t => t.n === 10);
  check('…KO for the other side on the tenth count, fight over, fighter still down', ko && ko.winner === 0 && ten && ko.tick === ten.tick && out.round.phase === 'over' && out.fighters[1].down && out.round.count === 10, `ko at ${ko?.tick}, ten at ${ten?.tick}, kd at ${kd?.tick}`);
  check('no tko was called (that is the third knockdown\'s stoppage)', !evs.some(e => e.type === 'tko'));
  const after = run(out, 20, i => [inp({ jab: i === 0 }), NONE], null, noJitter);
  check('after the KO inputs are ignored', !after.evs.some(e => e.type === 'punchStart'));
}
{
  // An iron chin survives two knockdowns and is stopped on the third (TKO, not KO).
  const noJitter = { ...heavy, getUpJitter: 0 };
  const sp = [ROSTER[0], { ...ROSTER[1], chin: 100 }];
  let s = fresh(MID, noJitter, sp);
  s.fighters[1].knockdowns = 1;
  // Run only until they are up (count 4.5 ≈ 135 ticks): the round must still be on for the third knockdown to count in it.
  const second = run(s, 5 * TICK + 20, i => [inp({ jab: i === 0 }), NONE], null, noJitter);
  check('iron chin, second knockdown: still gets up', of(second.evs, 'getUp').length === 1 && !second.evs.some(e => e.type === 'ko') && second.s.round.phase === 'fighting' && second.s.round.index === 0, `${second.s.round.phase} round ${second.s.round.index}`);
  const third = run(second.s, 40, i => [inp({ jab: i === 0 }), NONE], null, noJitter);
  check('the third is the stoppage: tko, no count', of(third.evs, 'tko')[0]?.winner === 0 && !third.evs.some(e => e.type === 'countTick') && third.s.round.phase === 'over');
}

// ── 5. Determinism through the roll ─────────────────────────────────────────
{
  const script = i => [inp({ jab: i === 0 || i === 200 }), NONE];
  const a = run(fresh(MID, heavy), 400, script, null, heavy), b = run(fresh(MID, heavy), 400, script, null, heavy);
  check('two runs through a knockdown and its roll are identical', JSON.stringify(a.s) === JSON.stringify(b.s) && JSON.stringify(a.evs) === JSON.stringify(b.evs));
  // The jitter is real: across a few seeds the get-up count is not always the same.
  const counts = new Set([1, 2, 3, 4, 5, 6].map(seed => { const r = run(fresh(MID, heavy, specs, seed), 400, script, null, heavy); return of(r.evs, 'getUp')[0]?.tick - of(r.evs, 'knockdown')[0]?.tick; }));
  check('different seeds roll different counts', counts.size > 1, [...counts].join(','));
  check('state stays plain JSON (the KO sentinel is -1, not Infinity)', !JSON.stringify(a.s).includes('Infinity') && !JSON.stringify(a.s).includes('NaN'));
}

done();

/**
 * interrupt_test.mjs — the interrupt (2026-09-22): a clean hit on a fighter
 * whose own punch is still in flight breaks it. Early in the flight the punch
 * is STUFFED (never resolves, rewinds home, nothing starts until it has);
 * late in the flight it arrives weakened; a same-tick trade lands clean both
 * ways; a punch already in its hold or recovery is untouched.
 */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, v3dist } = core;
// ratingsOn / stylesOn off (overhaul phase 2): this file pins the reference fighters' numbers and margins as they were before
// ratings and guard shapes did anything — both un-rated, both in the high guard. ratings_test / styles_test cover those.
const cfg = ({ ...createConfig(), ratingsOn: false, stylesOn: false });
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;
const NO_HITSTOP = { ...cfg, hitStopBase: 0, counterHitStopBonus: 0 };
const OFF = { ...cfg, interruptStuffBefore: 0, interruptPowerLoss: 0 };

function fresh(dist = MID, c = cfg) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
/** Run n ticks; per-tick trace of both fighters' punch clocks, gloves and body channels, plus tagged events. */
function run(s, n, inputs, c = cfg) {
  const evs = [], trace = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, inputs(i), c);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    trace.push(s.fighters.map(f => ({
      type: f.punch.type, phase: f.punch.phase, progress: f.punch.progress, block: f.block,
      lead: { ...f.gloves[0].pos }, rear: { ...f.gloves[1].pos }, lean: f.lean.fwd, twist: f.torsoTwist, crouch: f.crouch,
    })));
  }
  return { s, evs, trace };
}
const flight = type => cfg[`${type}Cock`] + cfg[`${type}Extend`];
const total = type => flight(type) + cfg[`${type}Recover`];
const resolvesOf = (evs, side) => evs.filter(e => e.side === side && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock'));

// ── 1. The stuff: a jab lands while the other's hook is winding up ──────────
{
  // Both press on tick 0: the jab (0.11 s flight) lands while the hook (0.25 s) is still cocking.
  const script = i => [inp({ jab: i === 0 }), inp({ hook: i === 0 })];
  const { evs, trace } = run(fresh(), 90, script);
  const land = evs.find(e => e.type === 'punchLand' && e.side === 0);
  const stuff = evs.find(e => e.type === 'punchStuffed');
  check('the jab lands on the winding-up hooker', !!land, evs.map(e => `${e.type}@${e.tick}`).join(', '));
  check('punchStuffed fires on the land tick: side 1, by 0, hook', stuff && stuff.tick === land?.tick && stuff.side === 1 && stuff.by === 0 && stuff.punch === 'hook', JSON.stringify(stuff));
  const u = trace[land?.tick ?? 0][1].progress / (flight('hook') / total('hook'));
  check(`…hit ${u.toFixed(2)} of the way through the hook's flight — at or before interruptStuffBefore ${cfg.interruptStuffBefore}`, u <= cfg.interruptStuffBefore);
  check('the hook never resolves (no land / whiff / block from side 1)', resolvesOf(evs, 1).length === 0, resolvesOf(evs, 1).map(e => e.type).join(','));
  check('the hooker still takes the hit (hurt event on side 1)', evs.some(e => e.type === 'hurt' && e.side === 1));
  // The rewind: progress falls every tick from the stuff until the punch clears.
  const from = stuff.tick;
  let end = trace.findIndex((t, i) => i > from && t[1].type === null);
  const rewind = trace.slice(from, end).map(t => t[1].progress);
  check('the hook rewinds: progress falls monotonically to 0, then the punch clears', end > from && rewind.every((p, i) => i === 0 || p < rewind[i - 1]), rewind.map(p => p.toFixed(3)).join(' '));
  check('…phase is never `recover` on the way home (no chain window opens)', trace.slice(from, end).every(t => t[1].phase !== 'recover'), trace.slice(from, end).map(t => t[1].phase).join(','));
  // No jump anywhere: fist, lean, twist per tick on the way home vs on the way out.
  const stepOf = (a, b) => v3dist(a[1].rear, b[1].rear);
  const outSteps = trace.slice(1, from + 1).map((t, i) => stepOf(trace[i], t));
  const homeSteps = trace.slice(from + 1, end + 1).map((t, i) => stepOf(trace[from + i], t));
  const maxOut = Math.max(...outSteps), maxHome = Math.max(...homeSteps);
  check(`the rear glove comes home without a jump (max ${(maxHome * 100).toFixed(1)} cm/tick vs ${(maxOut * 100).toFixed(1)} cm/tick going out)`, maxHome <= Math.max(0.03, 2.2 * maxOut));
  const chan = k => Math.max(...trace.slice(from + 1, end + 1).map((t, i) => Math.abs(t[1][k] - trace[from + i][1][k])));
  check(`lean / twist / crouch unwind smoothly (max per-tick lean ${chan('lean').toFixed(3)}, twist ${chan('twist').toFixed(3)} rad, crouch ${chan('crouch').toFixed(3)})`, chan('lean') < 0.25 && chan('twist') < 0.35 && chan('crouch') < 0.05);
  // The body is home when the punch clears.
  const at = trace[end][1];
  check('lean, twist and crouch are 0 the tick the stuffed punch clears', at.lean === 0 && at.twist === 0 && at.crouch === 0, `${at.lean} ${at.twist} ${at.crouch}`);
}
{
  // Timing without hit-stop: the rewind takes (progress at the stuff × total) / interruptRewindRate seconds.
  const script = i => [inp({ jab: i === 0 }), inp({ hook: i === 0 })];
  const { evs, trace } = run(fresh(MID, NO_HITSTOP), 90, script, NO_HITSTOP);
  const stuff = evs.find(e => e.type === 'punchStuffed');
  const end = trace.findIndex((t, i) => i > stuff.tick && t[1].type === null);
  const expect = trace[stuff.tick][1].progress * total('hook') / cfg.interruptRewindRate / SIM_DT;
  check(`the rewind takes ~${expect.toFixed(1)} ticks at interruptRewindRate ${cfg.interruptRewindRate} (got ${end - stuff.tick})`, Math.abs(end - stuff.tick - expect) <= 1.01);
  const slow = { ...NO_HITSTOP, interruptRewindRate: 0.8 };
  const r2 = run(fresh(MID, slow), 120, script, slow);
  const st2 = r2.evs.find(e => e.type === 'punchStuffed');
  const end2 = r2.trace.findIndex((t, i) => i > st2.tick && t[1].type === null);
  check('a lower interruptRewindRate keeps the stuffed fighter busy longer', end2 - st2.tick > end - stuff.tick, `${end2 - st2.tick} vs ${end - stuff.tick}`);
}
{
  // Locked out: through the rewind the stuffed fighter can neither block nor start a punch; both come back the tick after it clears.
  const base = fresh(MID, NO_HITSTOP);
  const { evs, trace } = run(base, 90, i => [inp({ jab: i === 0 }), inp({ hook: i === 0 })], NO_HITSTOP);
  const stuff = evs.find(e => e.type === 'punchStuffed');
  const end = trace.findIndex((t, i) => i > stuff.tick && t[1].type === null);
  const blockRun = run(base, 90, i => [inp({ jab: i === 0 }), inp({ hook: i === 0, block: i > stuff.tick })], NO_HITSTOP);
  const firstBlock = blockRun.trace.findIndex(t => t[1].block);
  // Actions read the punch state at the top of the tick, so the guard engages the tick after the arm is home (as after any punch).
  check('a block held through the rewind comes up the tick after the punch clears, not before', firstBlock === end + 1, `block @${firstBlock}, cleared @${end}`);
  const pressRun = run(base, 90, i => [inp({ jab: i === 0 }), inp({ hook: i === 0, cross: i === stuff.tick + 2 })], NO_HITSTOP);
  const cross = pressRun.evs.find(e => e.type === 'punchStart' && e.side === 1 && e.punch === 'cross');
  check('a cross pressed mid-rewind waits (buffered) and starts once the arm is home', cross && cross.tick >= end && cross.tick <= end + 1, `cross @${cross?.tick}, cleared @${end}`);
  // A second clean hit on a punch already stuffed adds nothing (no second event).
  const twice = run(base, 90, i => [inp({ jab: i === 0, cross: i === 2 }), inp({ hook: i === 0 })], NO_HITSTOP);
  const stuffs = twice.evs.filter(e => e.type === 'punchStuffed');
  check('a 1-2 into a wind-up stuffs it once (the second hit lands on a punch already rewinding)', stuffs.length === 1 && twice.evs.filter(e => e.type === 'punchLand' && e.side === 0).length === 2, `${stuffs.length} stuffs, ${twice.evs.filter(e => e.type === 'punchLand' && e.side === 0).length} lands`);
}

// ── 2. Late in the flight: the punch arrives, weakened; a same-tick trade is clean ─
{
  // Side 1's cross (0.2 s flight); side 0's jab pressed so it lands around 0.8 of that flight.
  const pressAt = 3;
  const script = i => [inp({ jab: i === pressAt }), inp({ cross: i === 0 })];
  const { evs, trace } = run(fresh(MID, NO_HITSTOP), 60, script, NO_HITSTOP);
  const jab = evs.find(e => e.type === 'punchLand' && e.side === 0);
  const u = trace[jab.tick][1].progress / (flight('cross') / total('cross'));
  const cross = evs.find(e => e.type === 'punchLand' && e.side === 1);
  check(`the jab lands ${u.toFixed(2)} of the way through the cross's flight — past interruptStuffBefore`, u > cfg.interruptStuffBefore && u < 1, `u ${u.toFixed(3)}`);
  check('the cross is not stuffed and still lands', !evs.some(e => e.type === 'punchStuffed') && !!cross);
  const off = run(fresh(MID, { ...NO_HITSTOP, interruptPowerLoss: 0 }), 60, script, { ...NO_HITSTOP, interruptPowerLoss: 0 });
  const crossOff = off.evs.find(e => e.type === 'punchLand' && e.side === 1);
  const ratio = cross.power / crossOff.power;
  const expect = 1 - cfg.interruptPowerLoss * (1 - u) / (1 - cfg.interruptStuffBefore);
  check(`…with ${((1 - ratio) * 100).toFixed(0)}% less power than the same cross with interruptPowerLoss 0 (expected ${((1 - expect) * 100).toFixed(0)}%)`, Math.abs(ratio - expect) < 0.02, `ratio ${ratio.toFixed(3)} vs ${expect.toFixed(3)}`);
}
{
  const script = i => [inp({ jab: i === 0 }), inp({ jab: i === 0 })];
  const { evs } = run(fresh(MID, NO_HITSTOP), 40, script, NO_HITSTOP);
  const lands = evs.filter(e => e.type === 'punchLand');
  check('a same-tick jab trade: both land, on the same tick, neither stuffed', lands.length === 2 && lands[0].tick === lands[1].tick && !evs.some(e => e.type === 'punchStuffed'), lands.map(e => `${e.side}@${e.tick}`).join(','));
  // (The powers themselves differ: side 0 resolves first and its stagger and counter reach side 1 before side 1's resolve — pre-existing tie-break, not the interrupt's.)
  const off = run(fresh(MID, { ...NO_HITSTOP, interruptStuffBefore: 0, interruptPowerLoss: 0 }), 40, script, { ...NO_HITSTOP, interruptStuffBefore: 0, interruptPowerLoss: 0 });
  const landsOff = off.evs.filter(e => e.type === 'punchLand');
  check('…at exactly the powers they land with the interrupt switched off (the tie costs neither side)', lands.length === 2 && landsOff.length === 2 && lands.every((e, i) => Math.abs(e.power - landsOff[i].power) < 1e-9), `${lands.map(e => e.power?.toFixed(4)).join(' / ')} vs off ${landsOff.map(e => e.power?.toFixed(4)).join(' / ')}`);
}

// ── 3. A punch in its hold or recovery is past interrupting ─────────────────
{
  // Side 1 crosses first (lands ~tick 12, then holds and recovers); side 0's jab, pressed the tick it lands, lands into that recovery. A touch closer so the cross's shove does not put the jab out of reach.
  const script = i => [inp({ jab: i === 12 }), inp({ cross: i === 0 })];
  const { evs, trace } = run(fresh(0.72, NO_HITSTOP), 60, script, NO_HITSTOP);
  const first = evs.find(e => (e.type === 'punchLand' || e.type === 'punchBlock') && e.side === 1);   // at 0.72 m the resting guard glove on the cheek absorbs it: a plain block, still a touch that holds
  const second = evs.find(e => e.type === 'punchLand' && e.side === 0);
  check('the earlier cross arrived first and the later jab landed into its recovery', first && second && first.tick < second.tick && trace[second.tick][1].phase === 'recover', `${first?.tick} < ${second?.tick}, phase ${trace[second?.tick]?.[1].phase}; ${evs.map(e => `${e.type}${e.side ?? ''}@${e.tick}`).join(', ')}`);
  check('…no stuff, and the recovery keeps running forward', !evs.some(e => e.type === 'punchStuffed') && trace[second.tick + 1][1].progress > trace[second.tick][1].progress);
}

// ── 4. The off switch, a blocked hit, the AI, determinism ───────────────────
{
  const script = i => [inp({ jab: i === 0 }), inp({ hook: i === 0 })];
  const { evs } = run(fresh(MID, OFF), 90, script, OFF);
  check('interruptStuffBefore 0 + interruptPowerLoss 0: the hook resolves as before, no stuff', !evs.some(e => e.type === 'punchStuffed') && resolvesOf(evs, 1).length === 1, resolvesOf(evs, 1).map(e => e.type).join(','));
}
{
  // A punch that is BLOCKED does not interrupt: side 1 holds the guard until the jab is absorbed, then throws.
  const script = i => [inp({ jab: i === 0 }), inp({ block: i < 12, hook: i === 12 })];
  const { evs } = run(fresh(MID, NO_HITSTOP), 90, script, NO_HITSTOP);
  check('a blocked jab followed by a hook: no stuff (nothing was in flight when it was absorbed)', evs.some(e => e.type === 'punchBlock') && !evs.some(e => e.type === 'punchStuffed'), evs.map(e => `${e.type}@${e.tick}`).join(', '));
}
{
  const script = i => [inp({ jab: i === 0 }), inp({ hook: i === 0 })];
  const a = run(fresh(), 90, script).s, b = run(fresh(), 90, script).s;
  check('deterministic: two identical runs through a stuff end in the same state', JSON.stringify(a) === JSON.stringify(b));
  const isNaNDeep = v => typeof v === 'number' ? Number.isNaN(v) : v && typeof v === 'object' ? Object.values(v).some(isNaNDeep) : false;
  check('no NaN anywhere in the state after a stuff', !isNaNDeep(a));
}

// ── Weight (phase 3): a big man is not stopped by a light shot ───────────────
{
  const heavy = ROSTER.find(f => f.id === 'raffle');   // 112 kg
  const vs = (who, press, c = cfg, late = 0) => {
    let s = sim.createState([specs[0], who], c, 1);
    s.fighters[0].pos = { x: -MID / 2, z: 0 }; s.fighters[1].pos = { x: MID / 2, z: 0 };
    for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
    return run(s, 90, i => [inp({ [press]: i === 0, move: { x: i === 0 && press === 'hook' ? -1 : 0, y: 0 } }), inp({ hook: i === late })], c).evs;
  };
  const bar = cfg.interruptPoise * (heavy.massKg - cfg.interruptPoiseMass);
  const jabOnHeavy = vs(heavy, 'jab'), jabLand = jabOnHeavy.find(e => e.type === 'punchLand' && e.side === 0);
  check(`a jab (${Math.hypot(jabLand.impulse.x, jabLand.impulse.z).toFixed(0)} N·s) on the 112 kg man winding up a hook lands but does not stuff it (his bar: ${bar.toFixed(0)} N·s)`, !!jabLand && !jabOnHeavy.some(e => e.type === 'punchStuffed') && resolvesOf(jabOnHeavy, 1).length === 1);
  const hookOnHeavy = vs(heavy, 'hook', cfg, 8);   // (his hook starts 8 ticks after mine, so mine arrives in his wind-up)
  const hookLand = hookOnHeavy.find(e => e.type === 'punchLand' && e.side === 0);
  check(`a hook (${hookLand ? Math.hypot(hookLand.impulse.x, hookLand.impulse.z).toFixed(0) : '-'} N·s) on him still stuffs it`, hookOnHeavy.some(e => e.type === 'punchStuffed' && e.side === 1));
  check('the same jab on an 82 kg man stuffs his hook, as always (interruptPoiseMass 90)', vs(specs[1], 'jab').some(e => e.type === 'punchStuffed' && e.side === 1));
  check('interruptPoise 0: weight does not matter', vs(heavy, 'jab', { ...cfg, interruptPoise: 0 }).some(e => e.type === 'punchStuffed' && e.side === 1));
}

// ── The loaded counter is not stopped by a jab (phase 4) ─────────────────────
{
  // Side 1 throws the cross with its rear hand LOADED (as a slip to the rear side leaves it: the state is set directly,
  // so no slip is in play); side 0's BODY jab, pressed on the same tick, lands in its wind-up (the body: a loaded
  // cross dips the head off a head jab's line).
  const exchange = (c, load) => { const s = fresh(MID, c); if (load) { s.fighters[1].loaded = 1; s.fighters[1].loadedT = c.slipLoadedTime; } return run(s, 90, i => [inp({ level: i <= 9, jab: i === 9 }), inp({ cross: i === 12 })], c).evs; };   // (the cross starts 3 ticks after the jab, so the jab arrives early in its wind-up)
  const loaded = exchange(cfg, true), cold = exchange(cfg, false), off = exchange({ ...cfg, slipLoadedPoise: 0 }, true);
  const jabLanded = evs => evs.some(e => e.type === 'punchLand' && e.side === 0);  check('a jab that lands in the wind-up of a cold cross stuffs it (control)', jabLanded(cold) && cold.some(e => e.type === 'punchStuffed' && e.side === 1));
  check('the same jab in the wind-up of a LOADED cross lands but does not stuff it: the counter still arrives', jabLanded(loaded) && !loaded.some(e => e.type === 'punchStuffed') && resolvesOf(loaded, 1).length === 1);
  check('slipLoadedPoise 0: it is stuffed like any other punch', off.some(e => e.type === 'punchStuffed' && e.side === 1));
}

done();

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
const NO_HITSTOP = { ...cfg, hitStopBase: 0, hitStopFlush: 0, hitStopGlancing: 0, hitStopMin: 0, counterHitStopBonus: 0 };
const OFF = { ...cfg, hitNerfOn: false, interruptStuffBefore: 0, interruptPowerLoss: 0 };
/** The rule as it was before the polish phase (any clean hit in the first interruptStuffBefore of the flight stuffs): what the weight and loaded-counter sections pin — they are about WHO can be stuffed, not when. */
const OLD = { ...cfg, hitNerfOn: false };

// ── 0. THE RULE (polish phase, 2026-11-11 — changed on purpose; Nate: "I should still be able to throw if I get
// hit, although my punch should feel and look nerfed"): only a FLUSH land in the first interruptStuffEarly of a
// punch's flight stuffs it. Anything later, or less than flush, lets it through NERFED. Swept over when the jab is
// pressed, on a man standing still (the jab lands clean) and on one walking onto it (it lands flush).
const WALK = { dist: 1.3, pre: 12 };   // side 1 walks in for `pre` ticks, then throws as it walks
const walkIn = (hisPress, myPress, extra0 = () => ({}), extra1 = () => ({})) => i =>
  [inp({ jab: i === myPress, ...extra0(i) }), inp({ move: { x: 0, y: i <= hisPress + 2 ? 1 : 0 }, cross: i === hisPress, ...extra1(i) })];
// (MEASURED, scripts/_debug.mjs flushsweep: a man's exposure stays under 0.2 through his own wind-up, so a STANDING
// man cannot be hit flush in it — and neither can one throwing a hook, which plants his feet. The man who can is the
// one coming forward as he winds up: a cross thrown walking in. That is the stop-hit, and it is what stuffs now.)
/** The stuffing exchange found by the sweep, with extra inputs for either side. */
const stuffScript = (extra0, extra1) => walkIn(STUFF.hisPress, STUFF.myPress, extra0, extra1);
let STUFF = null;   // the first swept case that stuffs: reused below for the rewind checks
{
  const seen = { stuffed: 0, cleanEarly: 0, flushLate: 0, wrong: [] };
  const sweep = (dist, script, label, his) => {
    for (let o = -2; o <= 14; o++) {
      const sc = script(o);
      const { evs, trace } = run(fresh(dist, NO_HITSTOP), 90, sc, NO_HITSTOP);
      const hisStart = evs.find(e => e.type === 'punchStart' && e.side === 1);
      const land = evs.find(e => e.type === 'punchLand' && e.side === 0);
      if (!hisStart || !land || land.tick < hisStart.tick) continue;
      const was = trace[land.tick - 1]?.[1];   // his punch the tick before the land
      if (!was || was.type === null || was.resolved) continue;
      const u = was.progress * total(his) / cfg[`${his}Cock`];   // how far through the WIND-UP his punch was when the jab arrived
      const stuffed = evs.some(e => e.type === 'punchStuffed' && e.side === 1);
      const should = land.grade === 'flush' && u <= cfg.interruptStuffEarly;
      if (stuffed !== should && Math.abs(u - cfg.interruptStuffEarly) > 0.12) seen.wrong.push(`${label} o=${o} ${land.grade} u=${u.toFixed(2)} stuffed=${stuffed}`);
      if (stuffed) { seen.stuffed++; if (label === 'walking in') STUFF ??= { dist, hisPress: WALK.pre, myPress: WALK.pre - 4 + o }; }
      else if (land.grade !== 'flush' && u <= cfg.interruptStuffEarly) seen.cleanEarly++;
      else if (land.grade === 'flush') seen.flushLate++;
    }
  };
  sweep(MID, o => i => [inp({ jab: i === Math.max(0, o) }), inp({ hook: i === 0 })], 'standing', 'hook');
  sweep(WALK.dist, o => walkIn(WALK.pre, WALK.pre - 4 + o), 'walking in', 'cross');
  check(`the rule holds over the sweep: stuffed ⟺ flush AND in the first ${cfg.interruptStuffEarly} of the wind-up`, seen.wrong.length === 0, seen.wrong.join(' | '));
  check(`…and both sides of it were seen (${seen.stuffed} stuffs, ${seen.cleanEarly} clean-in-the-wind-up not stuffed, ${seen.flushLate} flush-but-late not stuffed)`, seen.stuffed > 0 && seen.cleanEarly > 0 && STUFF !== null);
}
{
  // A clean jab EARLY in a standing man's hook: under the old rule a stuff; now the hook still comes, nerfed.
  const script = i => [inp({ jab: i === 0 }), inp({ hook: i === 0 })];
  const { evs, s } = run(fresh(), 90, script);
  const land = evs.find(e => e.type === 'punchLand' && e.side === 0);
  check('a clean jab early in a standing man\'s hook does NOT stuff it', land && land.grade !== 'flush' && !evs.some(e => e.type === 'punchStuffed'));
  check('…the hook resolves (it comes out), flagged nerfed in state while in flight', resolvesOf(evs, 1).length === 1);
  const old = run(fresh(MID, OLD), 90, script, OLD);
  check('hitNerfOn off: the same jab stuffs it, as before the polish phase', old.evs.some(e => e.type === 'punchStuffed' && e.side === 1) && resolvesOf(old.evs, 1).length === 0);
  // A punch STARTED just after being hit comes out slower and weaker, flagged on punchStart.
  const after = run(fresh(), 60, i => [inp({ jab: i === 0 }), inp({ cross: i === 9 })]);
  const st = after.evs.find(e => e.type === 'punchStart' && e.side === 1), cold = run(fresh(), 60, i => [NONE, inp({ cross: i === 9 })]).evs.find(e => e.type === 'punchStart' && e.side === 1);
  check(`a cross pressed 2 ticks after a clean jab lands on him starts at once, nerfed (nerf ${st?.nerf?.toFixed(2)}), with a longer tell (${(st?.tell * 1000).toFixed(0)} vs ${(cold?.tell * 1000).toFixed(0)} ms)`, st && st.tick <= 10 && st.nerf > 0.3 && st.tell > cold.tell * 1.1);
  const late = run(fresh(), 80, i => [inp({ jab: i === 0 }), inp({ cross: i === 40 })]).evs.find(e => e.type === 'punchStart' && e.side === 1);
  check('…and one pressed after the hit window has closed is a normal punch (nerf 0)', late && late.nerf === 0);
  void s;
}

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
function flight(type) { return cfg[`${type}Cock`] + cfg[`${type}Extend`]; }
function total(type) { return flight(type) + cfg[`${type}Recover`]; }
function resolvesOf(evs, side) { return evs.filter(e => e.side === side && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock')); }

// ── 1. The stuff: a jab lands while the other's hook is winding up ──────────
{
  // Both press on tick 0: the jab (0.11 s flight) lands while the hook (0.25 s) is still cocking.
  // (Polish phase: the exchange is the one the sweep above found — a jab that lands FLUSH on a man walking onto it, in his hook's wind-up.)
  const script = stuffScript();
  const { evs, trace } = run(fresh(STUFF.dist), 90, script);
  const land = evs.find(e => e.type === 'punchLand' && e.side === 0);
  const stuff = evs.find(e => e.type === 'punchStuffed');
  check('the jab lands flush on the winding-up hooker', land?.grade === 'flush', !!land, evs.map(e => `${e.type}@${e.tick}`).join(', '));
  check('punchStuffed fires on the land tick: side 1, by 0, cross', stuff && stuff.tick === land?.tick && stuff.side === 1 && stuff.by === 0 && stuff.punch === 'cross', JSON.stringify(stuff));
  const u = trace[(land?.tick ?? 1) - 1][1].progress * total('cross') / cfg.crossCock;
  check(`…hit ${u.toFixed(2)} of the way through the cross's wind-up — at or before interruptStuffEarly ${cfg.interruptStuffEarly}`, u <= cfg.interruptStuffEarly);
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
  const script = stuffScript();
  const { evs, trace } = run(fresh(STUFF.dist, NO_HITSTOP), 90, script, NO_HITSTOP);
  const stuff = evs.find(e => e.type === 'punchStuffed');
  const end = trace.findIndex((t, i) => i > stuff.tick && t[1].type === null);
  const expect = trace[stuff.tick][1].progress * total('cross') / cfg.interruptRewindRate / SIM_DT;
  check(`the rewind takes ~${expect.toFixed(1)} ticks at interruptRewindRate ${cfg.interruptRewindRate} (got ${end - stuff.tick})`, Math.abs(end - stuff.tick - expect) <= 1.01);
  const slow = { ...NO_HITSTOP, interruptRewindRate: 0.8 };
  const r2 = run(fresh(STUFF.dist, slow), 120, script, slow);
  const st2 = r2.evs.find(e => e.type === 'punchStuffed');
  const end2 = r2.trace.findIndex((t, i) => i > st2.tick && t[1].type === null);
  check('a lower interruptRewindRate keeps the stuffed fighter busy longer', end2 - st2.tick > end - stuff.tick, `${end2 - st2.tick} vs ${end - stuff.tick}`);
}
{
  // Locked out: through the rewind the stuffed fighter can neither block nor start a punch; both come back the tick after it clears.
  const base = fresh(STUFF.dist, NO_HITSTOP);
  const { evs, trace } = run(base, 90, stuffScript(), NO_HITSTOP);
  const stuff = evs.find(e => e.type === 'punchStuffed');
  const end = trace.findIndex((t, i) => i > stuff.tick && t[1].type === null);
  const blockRun = run(base, 90, stuffScript(undefined, i => ({ block: i > stuff.tick })), NO_HITSTOP);
  const firstBlock = blockRun.trace.findIndex(t => t[1].block);
  // Actions read the punch state at the top of the tick, so the guard engages the tick after the arm is home (as after any punch).
  check('a block held through the rewind comes up the tick after the punch clears, not before', firstBlock === end + 1, `block @${firstBlock}, cleared @${end}`);
  const pressRun = run(base, 90, stuffScript(undefined, i => ({ cross: i === stuff.tick + 2 })), NO_HITSTOP);
  const cross = pressRun.evs.find(e => e.type === 'punchStart' && e.side === 1 && e.punch === 'cross');
  check('a cross pressed mid-rewind waits (buffered) and starts once the arm is home', cross && cross.tick >= end && cross.tick <= end + 1, `cross @${cross?.tick}, cleared @${end}`);
  // A second clean hit on a punch already stuffed adds nothing (no second event).
  const twice = run(base, 90, stuffScript(i => ({ cross: i === STUFF.myPress + 2 })), NO_HITSTOP);
  const stuffs = twice.evs.filter(e => e.type === 'punchStuffed');
  // (Polish phase: the stuffed man was walking in and the jab stops him, so the cross behind it may fall short — what is pinned is ONE stuff, and that the cross was thrown.)
  check('a 1-2 into a wind-up stuffs it once (a second punch adds no second stuff)', stuffs.length === 1 && twice.evs.filter(e => e.type === 'punchStart' && e.side === 0).length === 2, `${stuffs.length} stuffs, ${twice.evs.filter(e => e.type === 'punchLand' && e.side === 0).length} lands`);
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
  // (Polish phase, deliberate: the loss is now interruptPowerLoss × how hard the hit was (its grade) × how much of the flight was left — it fades over the whole flight, not from the old stuff line.)
  const sev = jab.grade === 'flush' ? cfg.hitSevFlush : jab.grade === 'glancing' ? cfg.hitSevGlancing : cfg.hitSevClean;
  const expect = 1 - cfg.interruptPowerLoss * sev * (1 - u);
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
  // (Polish phase: the jab is thrown just after the cross thudded on side 0's guard, so it is a touch slower — nerfed — and can arrive on the recovery's last tick: "forward" includes "finished".)
  check('…no stuff, and the recovery keeps running forward', !evs.some(e => e.type === 'punchStuffed') && (trace[second.tick + 1][1].type === null || trace[second.tick + 1][1].progress > trace[second.tick][1].progress));
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
  const script = stuffScript();
  const a = run(fresh(STUFF.dist), 90, script).s, b = run(fresh(STUFF.dist), 90, script).s;
  check('deterministic: two identical runs through a stuff end in the same state', JSON.stringify(a) === JSON.stringify(b));
  const isNaNDeep = v => typeof v === 'number' ? Number.isNaN(v) : v && typeof v === 'object' ? Object.values(v).some(isNaNDeep) : false;
  check('no NaN anywhere in the state after a stuff', !isNaNDeep(a));
}

// ── Weight (phase 3): a big man is not stopped by a light shot ───────────────
{
  const heavy = ROSTER.find(f => f.id === 'raffle');   // 112 kg
  const vs = (who, press, c = OLD, late = 0) => {   // (the old rule: this section is about WHO can be stuffed)
    let s = sim.createState([specs[0], who], c, 1);
    s.fighters[0].pos = { x: -MID / 2, z: 0 }; s.fighters[1].pos = { x: MID / 2, z: 0 };
    for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
    return run(s, 90, i => [inp({ [press]: i === 0, move: { x: i === 0 && press === 'hook' ? -1 : 0, y: 0 } }), inp({ hook: i === late })], c).evs;
  };
  const bar = cfg.interruptPoise * (heavy.massKg - cfg.interruptPoiseMass);
  const jabOnHeavy = vs(heavy, 'jab'), jabLand = jabOnHeavy.find(e => e.type === 'punchLand' && e.side === 0);
  check(`a jab (${Math.hypot(jabLand.impulse.x, jabLand.impulse.z).toFixed(0)} N·s) on the 112 kg man winding up a hook lands but does not stuff it (his bar: ${bar.toFixed(0)} N·s)`, !!jabLand && !jabOnHeavy.some(e => e.type === 'punchStuffed') && resolvesOf(jabOnHeavy, 1).length === 1);
  const hookOnHeavy = vs(heavy, 'hook', OLD, 8);   // (his hook starts 8 ticks after mine, so mine arrives in his wind-up)
  const hookLand = hookOnHeavy.find(e => e.type === 'punchLand' && e.side === 0);
  check(`a hook (${hookLand ? Math.hypot(hookLand.impulse.x, hookLand.impulse.z).toFixed(0) : '-'} N·s) on him still stuffs it`, hookOnHeavy.some(e => e.type === 'punchStuffed' && e.side === 1));
  check('the same jab on an 82 kg man stuffs his hook, as always (interruptPoiseMass 90)', vs(specs[1], 'jab').some(e => e.type === 'punchStuffed' && e.side === 1));
  check('interruptPoise 0: weight does not matter', vs(heavy, 'jab', { ...OLD, interruptPoise: 0 }).some(e => e.type === 'punchStuffed' && e.side === 1));
}

// ── The loaded counter is not stopped by a jab (phase 4) ─────────────────────
{
  // Side 1 throws the cross with its rear hand LOADED (as a slip to the rear side leaves it: the state is set directly,
  // so no slip is in play); side 0's BODY jab, pressed on the same tick, lands in its wind-up (the body: a loaded
  // cross dips the head off a head jab's line).
  const exchange = (c, load) => { const s = fresh(MID, c); if (load) { s.fighters[1].loaded = 1; s.fighters[1].loadedT = c.slipLoadedTime; } return run(s, 90, i => [inp({ level: i <= 9, jab: i === 9 }), inp({ cross: i === 12 })], c).evs; };   // (the cross starts 3 ticks after the jab, so the jab arrives early in its wind-up)
  const loaded = exchange(OLD, true), cold = exchange(OLD, false), off = exchange({ ...OLD, slipLoadedPoise: 0 }, true);   // (the old rule, as above)
  const jabLanded = evs => evs.some(e => e.type === 'punchLand' && e.side === 0);  check('a jab that lands in the wind-up of a cold cross stuffs it (control)', jabLanded(cold) && cold.some(e => e.type === 'punchStuffed' && e.side === 1));
  check('the same jab in the wind-up of a LOADED cross lands but does not stuff it: the counter still arrives', jabLanded(loaded) && !loaded.some(e => e.type === 'punchStuffed') && resolvesOf(loaded, 1).length === 1);
  check('slipLoadedPoise 0: it is stuffed like any other punch', off.some(e => e.type === 'punchStuffed' && e.side === 1));
}

done();

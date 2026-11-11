/**
 * ai/index.ts — the opponent (SIM workstream, CONTRACT §2). Port of
 * legacy/src/dummy.js's four heuristics as a pure FrameInput producer: given
 * its own state and the sim state at the top of a tick, `aiStep` returns the
 * input its side feeds to sim.step that tick, plus its next state. Nothing
 * here mutates its arguments. No clocks and no Math.random — its only
 * randomness is core/rng on streams of its own, seeded from the fight seed —
 * so a seed plus the other side's input history replays byte-identical
 * (CONTRACT §3). The sim never knows the AI exists: side 1 is "whatever input
 * it is given", exactly as before.
 *
 * BEHAVIOUR COMES FROM A STYLE (overhaul 2026-11-11): every number below is
 * read from a `StyleParams` (ai/style.ts) — `ai.style`, or, when that is
 * null, `defaultStyle(cfg)` rebuilt from the live config each tick so the
 * tuning panel keeps working. Per-fighter styles are data.
 *
 *   0. Footwork mode  — (2026-09-16) a mode rolled on a seeded timer decides
 *                        WHERE it wants to be and whether it moves at all:
 *                        PRESS   the standoff steer below, at the standoff
 *                        PROBE   the same steer at probeDist — out of range;
 *                                it steps in only to throw, then drifts back out
 *                        CIRCLE  a loose standoff plus lateral stick, one way
 *                        HOLD    no steering for a beat
 *                        RESET   steps out to resetDist after an exchange (a
 *                                throw, or a solid shot taken), then re-rolls.
 *   1. Standoff steer   — walks toward / away from the mode's standoff through
 *                         the shared locomotion, with a hysteresis band (no
 *                         steering inside it) and a proportional taper into the
 *                         band, so it settles instead of hunting. Acts on the
 *                         PREDICTED distance (closing speed × lookahead) so
 *                         it decelerates into range rather than gliding through.
 *   2. Range-gated punch — the randomised timer only ARMS a punch. Arming picks
 *                         the type by weight and, for a hook or uppercut, a
 *                         hand by coin flip. The throw waits for the opponent
 *                         inside that punch's own landing band, and while armed
 *                         with a short punch it steps in to get there.
 *   3. Reactive defence — the tick after the opponent's punch starts it rolls
 *                         blockChance; on success the guard is up for
 *                         blockWindow seconds. Never re-rolled while up.
 *   4. Opening punish   — an unguarded in-range, gassed or stumbling opponent
 *                         drains the attack timer faster (they stack).
 *   5. The hit states   — (2026-09-22) COUNTER an exposed opponent; COVER
 *                         after being stuffed or hit solidly; nothing thrown
 *                         while stumbling.
 *   6. The tools        — (overhaul) drawn from a SECOND rng stream so the
 *                         five above replay as before:
 *                         BODY     an armed punch may go downstairs (it drops
 *                                  its level, then throws) — more against a held guard
 *                         SLIP / ROLL  a share of the punches it defends it
 *                                  slips (away from the hand) or, hooks, rolls under
 *                         CUT OFF  near the ropes it mirrors the opponent's
 *                                  sideways movement instead of following
 *                         PIVOT    off the ropes; PUSH-OFF when crowded and
 *                                  wanting space, or when being grabbed
 *                         FINISH   a hurt opponent gets power shots
 *                         SURVIVE  hurt: tie up if close (hurtClinch), else
 *                                  cover and give ground
 *                         FEINT    a heavy punch may be shown first
 *                         BURST    a reset may start with a hop back
 *                         Multi-tick moves are MACROS (a few ticks of scripted
 *                         stick / buttons — the same FrameInput a player gives).
 *
 * Stick discipline: a push that would be released inside the flick window is
 * held through it, so the AI never slips or bursts by accident — a flick is
 * always a macro.
 *
 * Timers run on the sim's clock: during hit-stop they slow with it.
 */
import {
  NULL_INPUT, RING_HALF, SIM_DT, clamp, cloneInput, frameOf, handLateralSign, lerp, rngChance, rngClone, rngFloat, rngInt, rngRange, seedRng, v2dist,
  type Config, type FrameInput, type PunchType, type RngState, type Side, type SimState,
} from '../core';
import { canStartPunch } from '../sim';
import { defaultStyle, type ComboStep, type StyleParams } from './style';

export { defaultStyle, styleFor, styleParams, withDifficulty, withReach, DIFFICULTY, STYLE_IDS, type StyleParams, type ComboStep, type Difficulty } from './style';
export { DRILLS, type Drill } from './drills';

export type AiMode = 'press' | 'probe' | 'circle' | 'hold' | 'reset';

/** A few ticks of scripted input: the flick family, the feint, the clinch. */
export interface AiMacro {
  kind: 'slip' | 'roll' | 'pivot' | 'push' | 'burst' | 'feint' | 'clinch' | 'tell';
  /** Ticks into the macro. */
  t: number;
  /** The stick it pushes (fighter frame). */
  x: number; y: number;
  /** The punch a feint shows. */
  punch: PunchType | null;
}

export interface AiState {
  side: Side;
  rng: RngState;
  /** The tools' own stream (overhaul), so the legacy heuristics replay unchanged whatever the tools draw. */
  rngT: RngState;
  /** null = the default style, rebuilt from the live config every tick. */
  style: StyleParams | null;
  /** Seconds until the next punch is armed; held at 0 while armed and waiting for range. */
  attackTimer: number;
  /** The punch it has armed and is waiting to land (null = timer still running). */
  armed: PunchType | null;
  /** Hand for the armed hook/uppercut, as the stick sign the sim reads at the press (-1 = lead). */
  armedX: -1 | 1;
  /** The armed punch goes to the body (it drops its level first). */
  armedBody: boolean;
  /** The armed punch has been feinted already (one show per punch). */
  armedShown: boolean;
  /** Seconds of reactive guard remaining. */
  blockTimer: number;
  /** The opponent had a punch in flight last tick (rising-edge detection). */
  oppPunching: boolean;
  /** Last tick's timer drain multiplier — 1, mult or mult². Read by tests. */
  aggression: number;
  /** Last measured centre-to-centre distance, m. */
  dist: number;
  /** Punches committed so far, and the gate distance the last one was committed at. Read by tests. */
  throwCount: number;
  lastThrowDist: number;
  /** Footwork mode and the seconds left in it. */
  mode: AiMode;
  modeTimer: number;
  /** Which way it circles this time, as a stick x sign. */
  circleDir: -1 | 1;
  /** Own health last tick (a drop is a hit taken). */
  lastHealth: number;
  /** A reset was rolled at the last throw; it starts once that punch has finished. */
  resetPending: boolean;
  /** Where it THINKS the opponent is: the true position lagged by the reaction time (a human does not track a coordinate). */
  seen: { x: number; z: number };
  /** Seconds until a pending block reaction fires (0 = none pending). */
  blockReact: number;
  /** Extra punches left in the current burst (0 = single shots). */
  burst: number;
  /** Seconds of give-ground left (the standoff is pushed out while > 0). */
  giveGround: number;
  /** Seconds before it may respond to the opponent's pressure again. */
  pressureCooldown: number;
  /** Seconds it declines to chase an opponent who just backed off. */
  chaseHold: number;
  /** The opponent was retreating faster than pressureSpeed last tick (the chase hold is set on the rising edge). */
  oppRetreating: boolean;
  /** The opponent's exposure was at or above counterVuln last tick (one counter roll per opening, on the rising edge). */
  oppExposed: boolean;
  /** Seconds until a counter it has decided on is armed (0 = none pending). */
  counterReact: number;
  /** Own unresolved punch's progress last tick, -1 if none (a drop = it was stuffed and is rewinding). */
  lastProgress: number;
  /** Counters armed so far. Read by tests. */
  counterCount: number;
  /** The scripted move in progress (null = none). */
  macro: AiMacro | null;
  /** Stick discipline (no accidental double-taps): stickT = seconds the current push has been held; stickX = the direction class of the last short push (−1 / 1 lateral, 2 back, 3 forward; 0 = none); stickY = seconds since it was let go. */
  stickX: number; stickY: number; stickT: number;
  /** It was hurt last tick (the survive plan is rolled on the rising edge) and the plan: tie up, or cover and move. */
  wasHurt: boolean;
  hurtPlan: 'none' | 'clinch' | 'cover' | 'swing';
  /** Shots taken lately (decays one a second): two = it is taking a combination. Seconds left of walking in behind the guard after being picked off at range. */
  hits: number; shellT: number;
  /** Phase 2. The opponent was inside range last tick, and whether it decided (as he got there) to keep its guard up in there. */
  wasInside: boolean; insideHold: boolean;
  /** The opponent's recent MISSES (decaying; ÷ WILD_WINDOW = misses a second): a rush. */
  oppRate: number;
  /** The rest of the signature combination it is throwing, and the seconds before it gives up on it. */
  queue: ComboStep[]; queueT: number;
  /** The armed cross is the overhand; the armed punch has shown its tell already; the armed punch is thrown going backward (retreat jab / check hook). */
  armedOver: boolean; armedTold: boolean; armedBack: boolean;
  /** Its block stun last tick (a rise = a punch just landed on its guard). */
  lastStun: number;
  /** The opponent's punch had resolved last tick (false again while he is still punching = a NEW punch chained off it). */
  oppResolved: boolean;
  /** What it does when the shove it has started is done: 0 nothing, 1 go to work in the gap it bought, 2 get out. */
  pushFollow: 0 | 1 | 2;
  /** It is taking a breather: out of range, guard down, no leads, until its wind is back. */
  resting: boolean;
  /** Seconds before it may throw another stiff jab at a man walking in. */
  interceptCd: number;
  /** Seconds since the opponent last STARTED a punch (phase 3: a combination is punches less than COVER_QUIET apart). */
  oppQuiet: number;
  /** Covering up through his combination at close range: seconds since it decided to (the guard is up once that passes its reaction time); -1 = not covering. */
  coverT: number;
  /** Behind the guard: the last push at or over the flick threshold, held through the flick window so it is never a pivot or a shove by accident. */
  holdX: number; holdY: number;
  /** How many times it has used each tool. Read by tests and the bot table. */
  used: { body: number; slip: number; roll: number; pivot: number; push: number; burst: number; feint: number; clinch: number; cutOff: number };
}

/** A fresh AI for `side`. Its rng streams are derived from the fight seed so two sides never share one. `style`: null = the default (live from config). */
export function createAi(side: Side, seed: number, cfg: Config, style: StyleParams | null = null): AiState {
  const rng = seedRng((seed + 7919 * (side + 1)) >>> 0);
  const st = style ?? defaultStyle(cfg);
  return {
    side,
    rng,
    rngT: seedRng((seed + 104729 * (side + 1)) >>> 0),
    style,
    attackTimer: rngRange(rng, st.attackDelayMin, st.attackDelayMax),
    armed: null,
    armedX: -1,
    armedBody: false,
    armedShown: false,
    blockTimer: 0,
    oppPunching: false,
    aggression: 1,
    dist: Infinity,
    throwCount: 0,
    lastThrowDist: Infinity,
    mode: 'press',
    modeTimer: rngRange(rng, st.modeMin, st.modeMax),
    circleDir: -1,
    lastHealth: 1,
    resetPending: false,
    seen: { x: 0, z: 0 },
    blockReact: 0,
    burst: 0,
    giveGround: 0,
    pressureCooldown: 0,
    chaseHold: 0,
    oppRetreating: false,
    oppExposed: false,
    counterReact: 0,
    lastProgress: -1,
    counterCount: 0,
    macro: null,
    stickX: 0, stickY: 999, stickT: 0,
    wasHurt: false,
    hurtPlan: 'none',
    hits: 0, shellT: 0,
    wasInside: false, insideHold: false, oppRate: 0, queue: [], queueT: 0, armedOver: false, armedTold: false, armedBack: false, lastStun: 0, oppResolved: false, pushFollow: 0, resting: false, interceptCd: 0, oppQuiet: 9, coverT: -1, holdX: 0, holdY: 0,
    used: { body: 0, slip: 0, roll: 0, pivot: 0, push: 0, burst: 0, feint: 0, clinch: 0, cutOff: 0 },
  };
}

const TYPES: readonly PunchType[] = ['jab', 'cross', 'hook', 'uppercut'];
const POWER: readonly PunchType[] = ['cross', 'hook', 'uppercut'];
const weightOf = (t: PunchType, st: StyleParams): number =>
  t === 'jab' ? st.jabWeight : t === 'cross' ? st.crossWeight : t === 'hook' ? st.hookWeight : st.uppercutWeight;
/** Weighted pick among `types`; all weights 0 = the first. */
function pickPunch(rng: RngState, st: StyleParams, types: readonly PunchType[] = TYPES): PunchType {
  const total = types.reduce((s, t) => s + Math.max(0, weightOf(t, st)), 0);
  if (total <= 0) return types[0]!;
  let r = rngFloat(rng) * total;
  for (const t of types) { r -= Math.max(0, weightOf(t, st)); if (r < 0) return t; }
  return types[types.length - 1]!;
}
const engageOf = (t: PunchType, st: StyleParams): number =>
  t === 'hook' ? st.engageHook : t === 'uppercut' ? st.engageUppercut : st.engageStraight;
/** Farthest centre-to-centre distance the default style commits `t` at. */
export const engageDist = (t: PunchType, cfg: Config): number => engageOf(t, defaultStyle(cfg));
/** Nearest: straights lose power inside smotherDist; hooks and uppercuts keep full power to body contact. */
export const nearDist = (t: PunchType, cfg: Config): number =>
  t === 'hook' || t === 'uppercut' ? cfg.separationDist : cfg.smotherDist;

/** Roll the next footwork mode (never reset — that is event-driven) and its duration. Circling fades with stamina. */
function rollMode(a: AiState, stamina: number, st: StyleParams): void {
  const circleW = Math.max(0, st.circleWeight) * lerp(st.tiredFootwork, 1, clamp(stamina, 0, 1));
  const weights: [AiMode, number][] = [
    ['press', Math.max(0, st.pressWeight)], ['probe', Math.max(0, st.probeWeight)], ['circle', circleW], ['hold', Math.max(0, st.holdWeight)],
  ];
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let mode: AiMode = 'press';
  if (total > 0) {
    let r = rngFloat(a.rng) * total;
    for (const [m, w] of weights) { r -= w; if (r < 0) { mode = m; break; } }
  }
  a.mode = mode;
  a.modeTimer = mode === 'hold' ? rngRange(a.rng, 0.3, Math.max(0.3, st.holdMax)) : rngRange(a.rng, st.modeMin, Math.max(st.modeMin, st.modeMax));
  if (mode === 'circle') a.circleDir = rngChance(a.rng, 0.5) ? -1 : 1;
}

// ── Macros: ticks of scripted input. Shape (tick counts), not tunables. ──────
/** Ticks a flick's push lasts (inside slipFlickMax), then one tick released. */
const FLICK_TICKS = 2;
/** Ticks the second push of a double-tap is held (past the flick window, so it is footwork). */
const BURST_HOLD_TICKS = 13;
/** A feint: the punch is pressed on tick 0 and the guard comes up on these ticks. */
const FEINT_BLOCK_FROM = 3, FEINT_END = 6;
/** A clinch attempt is abandoned after this many ticks. */
const CLINCH_MAX_TICKS = 50;

/** Write this tick of the macro into `input`. Returns false when the macro has finished (it wrote nothing). */
function runMacro(a: AiState, input: FrameInput, s: SimState, cfg: Config): boolean {
  const m = a.macro;
  if (!m) return false;
  const me = s.fighters[a.side];
  const t = m.t;
  m.t += 1;
  const push = (): void => { input.move.x = m.x; input.move.y = m.y; };
  switch (m.kind) {
    case 'slip':
      if (t < FLICK_TICKS) push();
      if (t >= FLICK_TICKS) a.macro = null;
      return true;
    case 'roll':
      input.level = true;
      if (t < FLICK_TICKS) push();
      if (t >= FLICK_TICKS + 1) a.macro = null;
      return true;
    case 'pivot':
    case 'push':
      input.block = true;
      if (t < FLICK_TICKS) push();
      if (t >= FLICK_TICKS) a.macro = null;
      return true;
    case 'burst':
      if (t < FLICK_TICKS || t > FLICK_TICKS) push();
      if (t >= FLICK_TICKS + BURST_HOLD_TICKS) a.macro = null;
      return true;
    case 'feint':
      if (t === 0 && m.punch) { input[m.punch] = true; if (m.punch === 'hook' || m.punch === 'uppercut') input.move.x = m.x; }
      if (t >= FEINT_BLOCK_FROM) input.block = true;
      if (t >= FEINT_END) a.macro = null;
      return true;
    case 'tell':
      // The habit before the big one: x = 1 it dips (level), else it draws back half a step (under the push threshold).
      if (m.x === 1) input.level = true; else input.move.y = -0.55;
      if (t >= TELL_TICKS) a.macro = null;
      return true;
    case 'clinch':
      // (x = 1: a tie-up to smother a combination, not to clear the head — it does not need to be hurt.)
      if (me.clinch.active || (m.x === 0 && me.hurt <= 0) || t > CLINCH_MAX_TICKS || me.clinch.cd > 0) { a.macro = null; return me.clinch.active; }
      input.block = true; input.level = true;
      if (a.dist > cfg.clinchRange - 0.05) input.move.y = 0.55;   // walk in under the flick threshold: a push here must not read as a shove
      return true;
  }
}

/**
 * The AI's own copy of the sim's push tracking (slip.ts). `guard`: hold a
 * push that would complete a double-tap just under the threshold; a macro's
 * pushes are deliberate and only tracked.
 */
function trackStick(a: AiState, input: FrameInput, dt: number, cfg: Config, pressed: boolean, guard: boolean): void {
  const mag = Math.hypot(input.move.x, input.move.y);
  const cls = Math.abs(input.move.x) >= Math.abs(input.move.y) ? (input.move.x > 0 ? 1 : -1) : input.move.y < 0 ? 2 : 3;
  a.stickY += dt;   // seconds since the last short push was let go
  if (mag >= cfg.slipInputThreshold) {
    if (guard && a.stickT === 0 && cls === a.stickX && a.stickY <= cfg.burstTapWindow + SIM_DT) {
      const k = cfg.slipInputThreshold * UNDER_PUSH / mag;
      input.move.x *= k; input.move.y *= k;
      return;
    }
    if (a.stickT === 0) a.stickX = cls;
    a.stickT += dt;
    if (pressed) a.stickT = cfg.slipFlickMax + 1;   // spent: letting it go is not a flick
  } else {
    if (a.stickT > 0 && a.stickT <= cfg.slipFlickMax) a.stickY = 0;   // that was a flick to the sim: the tap window opens
    else if (a.stickT > 0) a.stickX = 0;
    a.stickT = 0;
  }
}

/**
 * Decide this tick's input from the state the sim is about to step. Pure:
 * returns a new AiState and a fresh FrameInput, touches neither argument.
 */
export function aiStep(ai: Readonly<AiState>, s: SimState, cfg: Config): { ai: AiState; input: FrameInput } {
  const a: AiState = { ...ai, rng: rngClone(ai.rng), rngT: rngClone(ai.rngT), macro: ai.macro ? { ...ai.macro } : null, used: { ...ai.used }, queue: ai.queue.slice() };
  const st = a.style ?? defaultStyle(cfg);
  const tools = cfg.aiToolsOn || a.style !== null;
  const input = cloneInput(NULL_INPUT);
  const me = s.fighters[a.side];
  const opp = s.fighters[a.side === 0 ? 1 : 0];
  // The same clock sim.step will use for this tick (hit-stop scales it).
  const dt = s.hitStop > 0 ? SIM_DT * cfg.hitStopScale : SIM_DT;

  const dist = v2dist(me.pos, opp.pos);
  a.dist = dist;
  const oppPunching = opp.punch.type !== null;
  // A punch started: the guard-down → punching edge (the pre-overhaul read), or — with the tools — a NEW punch
  // chained off the last (his punch had resolved and now has not): every punch of a combination is a start.
  const oppStarted = oppPunching && (!a.oppPunching || (tools && a.oppResolved && !opp.punch.resolved));
  a.oppPunching = oppPunching;
  // …and a punch of his that has just gone by WITHOUT touching anything (no contact point) is a miss.
  const oppMissed = oppPunching && opp.punch.resolved && !a.oppResolved && opp.punch.contact === null;
  a.oppResolved = oppPunching && opp.punch.resolved;
  const hurt = a.lastHealth - me.health;
  a.lastHealth = me.health;
  // Stuffed (2026-09-22): its punch is still the same one but its clock ran
  // backwards this tick — the sim's interrupt. Read off progress, not events.
  // Only an UNRESOLVED punch is tracked (-1 otherwise): a chained punch
  // starts from a resolved one, so its low progress is never a false drop.
  // (Its own feint rewinds too — that is not a stuff.)
  const stuffed = me.punch.type !== null && !me.punch.resolved && !me.punch.feint && a.lastProgress >= 0 && me.punch.progress < a.lastProgress - 1e-9;
  a.lastProgress = me.punch.type !== null && !me.punch.resolved ? me.punch.progress : -1;
  // Rocked (sim/stun.ts) reads as stumbling both ways: it throws nothing while
  // rocked and covers; a rocked opponent is pressed for the finish.
  // (Phase 3, with the tools: only a shot that really moved it — OWN_STUMBLE m/s, more than a clean cross gives —
  // stops its hands. MEASURED: at the style's stumbleSpeed (0.6–2.5) every jab that touched it held its fire, so
  // under a combination it could not punch at all: 16 punches started in a 28 s fight, 55 against.)
  const meStumbling = Math.hypot(me.stagger.x, me.stagger.z) > (tools ? Math.max(st.stumbleSpeed, OWN_STUMBLE) : st.stumbleSpeed) || me.hurt > 0;
  const oppStumbling = Math.hypot(opp.stagger.x, opp.stagger.z) > st.stumbleSpeed || opp.hurt > 0;
  if (me.hurt > 0 && a.hurtPlan !== 'swing') a.blockTimer = Math.max(a.blockTimer, st.coverTime);
  // A rush (phase 2): how many punches a second the opponent has been MISSING with. (Starts alone would not do:
  // measured, a man throwing clean three-punch combinations was read as wild and the AI stopped fighting him.)
  a.oppRate = Math.max(0, a.oppRate - a.oppRate * dt / WILD_WINDOW) + (oppMissed ? 1 : 0);
  const wild = tools && a.oppRate / WILD_WINDOW > st.wildRate;
  const sure = 1 - st.mistake;   // difficulty: a defensive decision is sometimes simply not made
  // Its own wind (phase 2; measured: the outboxer burst, pivoted, shoved and held its guard to an empty bar in ten
  // seconds and was stopped flat-footed). Spent, it stops spending: no hops, pivots, shoves or feints; and under
  // REST_BELOW it takes a breather — steps out and does not lead — until it is back over REST_UNTIL.
  const spent = tools && me.stamina < TOOL_STAMINA;
  if (tools && me.stamina < REST_BELOW) a.resting = true; else if (me.stamina > REST_UNTIL || !tools) a.resting = false;

  // Perception (2026-09-16): what it steers by is the opponent's position
  // lagged by the reaction time (a first-order lag, so it is one number per
  // axis and serialises), never the live coordinate. Zero = the old omniscient
  // AI. Its own position it knows exactly.
  if (st.reaction <= 0 || ai.dist === Infinity) {
    a.seen = { x: opp.pos.x, z: opp.pos.z };
  } else {
    const k = Math.min(1, dt / st.reaction);
    a.seen = { x: a.seen.x + (opp.pos.x - a.seen.x) * k, z: a.seen.z + (opp.pos.z - a.seen.z) * k };
  }
  const seenDist = v2dist(me.pos, a.seen);

  // Between rounds or on the canvas: no intent, and the timers hold.
  if (s.round.phase !== 'fighting' || me.down) { a.macro = null; a.stickT = 0; return { ai: a, input }; }

  const punching = me.punch.type !== null;
  // The sim's own chain window (hit confirm on a touch, later on a miss) —
  // and nothing is thrown off stumbling feet.
  // ── Surviving (overhaul): the plan is rolled once, as it is hurt. Close → maybe tie up; a slugger may swing back;
  // otherwise cover and give ground.
  const nowHurt = me.hurt > 0;
  if (nowHurt && !a.wasHurt) {
    a.hurtPlan = tools && rngChance(a.rngT, st.hurtClinch) ? 'clinch' : tools && rngChance(a.rngT, st.hurtSwing) ? 'swing' : 'cover';
    if (a.hurtPlan === 'swing') a.blockTimer = 0;
  }
  if (!nowHurt) a.hurtPlan = 'none';
  a.wasHurt = nowHurt;
  // (Swinging back: the one case it throws off hurt legs.)
  const canThrow = canStartPunch(me, cfg) && (!meStumbling || a.hurtPlan === 'swing');
  // The inside fight (phase 2): as the opponent gets inside it decides whether its guard stays up in there.
  const inside = dist < cfg.rangeInside + INSIDE_MARGIN;
  if (inside && !a.wasInside) {
    a.insideHold = tools && rngChance(a.rngT, st.insideGuard * sure);
    // …or whether it just ties him up (a style that does not want him there): the break puts the fight back at range.
    if (tools && a.macro === null && !punching && cfg.clinchOn && me.clinch.cd === 0 && !nowHurt && rngChance(a.rngT, st.insideClinch * sure)) {
      a.macro = { kind: 'clinch', t: 0, x: 1, y: 0, punch: null };
      a.used.clinch += 1;
    }
  }
  a.wasInside = inside;
  // Tired at close range: lean on him.
  if (tools && st.tiredClinchRate > 0 && me.fatigue > TIRED_CLINCH_AT && dist <= cfg.clinchRange && a.macro === null && !punching && cfg.clinchOn && me.clinch.cd === 0 && rngChance(a.rngT, st.tiredClinchRate * dt)) {
    a.macro = { kind: 'clinch', t: 0, x: 1, y: 0, punch: null };
    a.used.clinch += 1;
  }
  if (tools && a.hurtPlan === 'clinch' && a.macro === null && cfg.clinchOn && me.clinch.cd === 0 && !me.clinch.active && !punching && dist <= cfg.clinchRange + CLINCH_WALK_IN) {
    a.macro = { kind: 'clinch', t: 0, x: 0, y: 0, punch: null };
    a.used.clinch += 1;
  }

  // ── Under fire (overhaul). Picked off from outside its own range → it shells up and walks in behind the guard.
  // Two shots inside a second at close range → it is taking a combination: tie up, or shove off.
  a.hits = Math.max(0, a.hits - dt);
  a.shellT = Math.max(0, a.shellT - dt);
  if (tools && hurt > HIT_NOTICED) {
    a.hits += 1;
    a.shellT = st.shellTime;   // any shot that gets through: hands up until it has something to throw
    if (a.hits >= 2 && dist <= cfg.clinchRange && a.macro === null && !punching && !nowHurt) {
      a.hits = 0.5;
      if (rngChance(a.rngT, st.crowdClinch)) {
        if (cfg.clinchOn && me.clinch.cd === 0) { a.macro = { kind: 'clinch', t: 0, x: 1, y: 0, punch: null }; a.used.clinch += 1; }
        else if (cfg.pushOffOn && me.pushCd === 0) { a.macro = { kind: 'push', t: 0, x: 0, y: 1, punch: null }; a.used.push += 1; }
      }
    }
  }

  // ── Reading the hit states (2026-09-22) ────────────────────────────────────
  // The cover: stuffed, or a solid shot taken → with coverChance the guard
  // comes up for coverTime (the sim raises it once the punch has cleared)
  // and the armed punch is dropped — it stops swinging and covers.
  if ((stuffed || (hurt >= st.hitResetDamage && st.hitResetDamage > 0)) && rngChance(a.rng, st.coverChance)) {
    a.blockTimer = Math.max(a.blockTimer, st.coverTime);
    a.blockReact = 0;
    if (a.armed !== null) { a.armed = null; a.attackTimer = rngRange(a.rng, st.attackDelayMin, st.attackDelayMax); }
    a.burst = 0; a.queue = [];
  }
  // A rush (phase 2): he is swinging wild. Every punch of his that has gone by and left him hanging is taken — no
  // roll, no reaction beat to think about it: the hook if he is close enough, else the cross.
  if (wild && a.armed === null && opp.punch.type !== null && opp.punch.resolved && opp.vuln >= WILD_VULN && !opp.down && !nowHurt && a.mode !== 'reset') {
    a.armed = dist <= st.engageHook ? 'hook' : 'cross';
    a.armedX = -1; a.armedBody = false; a.armedOver = false; a.armedShown = true; a.armedTold = true;
    a.attackTimer = 0; a.queue = [];
    a.counterCount += 1;
  }
  // A punch just landed on its guard (phase 2): it may fire straight back as the block stun ends — the hook or
  // uppercut inside, the cross at range. Pressing a guard is not free.
  const stunned = me.blockStun > 0 && a.lastStun === 0 && me.block;
  a.lastStun = me.blockStun;
  const fireBack = (): void => {
    a.armed = inside ? (rngChance(a.rngT, 0.5) ? 'hook' : 'uppercut') : 'cross';
    a.armedX = rngChance(a.rngT, 0.5) ? -1 : 1;
    a.armedBody = false; a.armedOver = false; a.armedBack = false; a.armedShown = true; a.armedTold = true; a.queue = [];
    a.attackTimer = 0; a.blockTimer = 0; a.shellT = 0;
  };
  // Under fire up close — a punch on the guard or one that got through — the first answer is the SHOVE: it sends
  // him back, smothers what he was winding up and holds him out of punching for a beat. Then the style decides:
  // go to work in that beat, or get out. (Without it the man throwing never stops: his next punch stuffs any reply.)
  const underFire = stunned || hurt > HIT_NOTICED;
  // (Not gated on its own wind: this is survival, not an optional tool.)
  if (tools && underFire && a.macro === null && !nowHurt && !punching && cfg.pushOffOn && me.pushCd === 0 && dist < cfg.pushRange - 0.05 && rngChance(a.rngT, st.crowdPush * sure)) {
    a.macro = { kind: 'push', t: 0, x: 0, y: 1, punch: null };
    a.pushFollow = st.pushThen === 'leave' ? 2 : 1;
    a.used.push += 1;
  } else if (tools && stunned && a.macro === null && !nowHurt && !wild && rngChance(a.rngT, st.blockCounter)) fireBack();
  // Covering a combination (phase 3). Inside punches are quicker than its reaction — it cannot block them one at a
  // time — so what it reads is the COMBINATION: the first one lands, the guard comes up a reaction later and stays up
  // while he keeps throwing (punches less than COVER_QUIET apart), and when he stops it is its turn: it fires back
  // into his recovery. Rolled once per combination at insideBlock. (Measured before: the inside-fighter bot emptied
  // every style's health bar three times in about thirty seconds; the AI's guard was a coin flipped once on the way in.)
  a.oppQuiet = oppStarted ? 0 : Math.min(9, a.oppQuiet + dt);
  const close = dist < cfg.rangeInside + COVER_MARGIN;
  if (tools && cfg.aiCoverOn && oppStarted && close && a.coverT < 0 && !nowHurt && rngChance(a.rngT, st.insideBlock * sure)) a.coverT = 0;
  if (a.coverT >= 0) {
    a.coverT += dt;
    if (a.oppQuiet > COVER_QUIET || !close || nowHurt) {
      const done = a.oppQuiet > COVER_QUIET && close && !nowHurt;
      a.coverT = -1;
      if (done && tools && a.macro === null && !punching && !wild && !spent && rngChance(a.rngT, st.blockCounter)) fireBack();
    }
  }
  // The shove is done: use the beat.
  if (a.pushFollow !== 0 && a.macro === null) {
    if (a.pushFollow === 1 && !wild) fireBack();
    else { a.mode = 'reset'; a.modeTimer = st.resetTime; a.resetPending = false; if (cfg.burstOn && me.burstCd === 0 && !spent) { a.macro = { kind: 'burst', t: 0, x: 0, y: -1, punch: null }; a.used.burst += 1; } }
    a.pushFollow = 0;
  }
  // The rest of a signature combination lapses if it cannot be thrown (he has gone).
  if (a.queue.length > 0) { a.queueT = Math.max(0, a.queueT - dt); if (a.queueT === 0) a.queue = []; }
  // The counter: the opponent's exposure crossing counterVuln is an
  // OPENING (their punch deep in its flight or hanging in a whiffed recovery,
  // or the punish window after they were slipped or perfectly blocked). One
  // roll per opening; the decision lands a reaction later and arms a
  // straight on the spot — the cross if the opening is still wide, the jab
  // if it is closing — which the throw below fires if in range. A fast jab's
  // peak is gone before a human reaction lands; a whiffed hook and a slipped
  // punch are not. That is the point.
  const oppExposed = opp.vuln >= st.counterVuln && !opp.down;
  if (oppExposed && !a.oppExposed && a.counterReact === 0 && rngChance(a.rng, st.counterChance)) a.counterReact = Math.max(st.reaction, 1e-6);
  a.oppExposed = oppExposed;
  if (a.counterReact > 0) {
    a.counterReact = Math.max(0, a.counterReact - dt);
    // (Phase 3, with the tools: the opening is taken from behind the guard and from a step-out too — the hands come
    // down and it stops leaving. MEASURED: the counter style, which blocks 85% of what it reads and resets half the
    // time, threw away nearly every opening it had decided to take; it lost all 18 fights to the legitimate bots.)
    // (Only once his punch has been and gone: dropping the guard to counter a punch still on its way is how to be hit by it.)
    const gone = opp.punch.type === null || opp.punch.resolved;
    if (a.counterReact === 0 && opp.vuln > 0 && !opp.down && ((tools && gone) || (a.blockTimer === 0 && a.mode !== 'reset'))) {
      if (tools && gone) { a.blockTimer = 0; a.shellT = 0; a.coverT = -1; if (a.mode === 'reset') { a.mode = 'probe'; a.modeTimer = st.modeMin; a.resetPending = false; } }
      a.armed = opp.vuln >= st.counterVuln ? 'cross' : 'jab';
      a.armedBody = false; a.armedOver = false; a.armedShown = true; a.armedTold = true; a.queue = [];   // a counter is thrown, never shown
      // (Phase 3: what he left out there was a JAB — it is back before a cross arrives, and his next one stuffs it
      // (measured: 21 of the counter style's 50 punches against the jabber). The answer to a jab is the jab, with the
      // cross behind it.)
      if (tools && opp.punch.type === 'jab') { a.armed = 'jab'; a.queue = [{ p: 'cross' }]; a.queueT = QUEUE_LIFE; }
      a.attackTimer = 0;
      a.counterCount += 1;
    }
  }

  // ── Reading the opponent (2026-09-16) ──────────────────────────────────────
  // Closing speed of the opponent along the line (positive = coming at me).
  let ux = 1, uz = 0;
  if (dist > 0.01) { ux = (opp.pos.x - me.pos.x) / dist; uz = (opp.pos.z - me.pos.z) / dist; }
  const oppClosing = -((opp.vel.x + opp.stagger.x) * ux + (opp.vel.z + opp.stagger.z) * uz);
  a.giveGround = Math.max(0, a.giveGround - dt);
  a.pressureCooldown = Math.max(0, a.pressureCooldown - dt);
  a.chaseHold = Math.max(0, a.chaseHold - dt);
  // Rushed: either give ground (the standoff steps out for a while) or stand
  // and fire — a jab is armed on the spot to meet them coming in.
  if (oppClosing > st.pressureSpeed && a.pressureCooldown === 0 && a.mode !== 'reset') {
    a.pressureCooldown = st.pressureCooldown;
    if (rngChance(a.rng, st.giveGroundChance)) a.giveGround = st.giveGroundTime;
    else if (a.armed === null) {
      a.armed = 'jab'; a.armedBody = false; a.armedOver = false; a.armedShown = true; a.armedTold = true; a.attackTimer = 0;
      // A style that fights off the back foot answers going away: the retreat jab, or the check hook if he is on top of it.
      a.armedBack = tools && rngChance(a.rngT, st.backFoot);
      if (a.armedBack && dist <= st.engageHook) { a.armed = 'hook'; a.armedX = -1; }
    }
  }
  // The stiff jab (phase 2): a man walking in through its range gets one at once, without waiting for the timer.
  // It stops him (the sim's jabStop) — this is how a style keeps a man off, or makes him pay to get in.
  a.interceptCd = Math.max(0, a.interceptCd - dt);
  if (tools && st.intercept > 0 && a.interceptCd === 0 && a.macro === null && !nowHurt && !wild && oppClosing > INTERCEPT_SPEED
    && dist <= engageOf(st.interceptWith, st) + INTERCEPT_LEAD && dist > cfg.smotherDist && a.armed !== st.interceptWith && canStartPunch(me, cfg)) {
    a.interceptCd = st.interceptGap;
    if (rngChance(a.rngT, st.intercept * sure)) {
      a.armed = st.interceptWith;
      a.armedBody = false; a.armedOver = false; a.armedShown = true; a.armedTold = true; a.queue = [];
      a.armedBack = st.interceptWith === 'jab' && rngChance(a.rngT, st.backFoot);
      a.attackTimer = 0; a.blockTimer = 0; a.shellT = 0;
    }
  }
  // They backed off: let the space open before following (no chasing for a
  // beat). Set as the retreat BEGINS, so a long retreat is still followed
  // once the beat has passed.
  const retreating = oppClosing < -st.pressureSpeed;
  if (retreating && !a.oppRetreating) a.chaseHold = Math.max(a.chaseHold, st.chaseDelay);
  a.oppRetreating = retreating;

  // ── 0. Footwork mode ───────────────────────────────────────────────────────
  // A solid shot taken may trigger a reset, and a reset rolled at the last
  // throw starts once that punch has finished; the timer expiring rolls the
  // next mode.
  const wasReset = a.mode === 'reset';
  if (a.mode !== 'reset' && hurt >= st.hitResetDamage && st.hitResetDamage > 0 && rngChance(a.rng, st.hitResetChance)) {
    a.mode = 'reset'; a.modeTimer = st.resetTime; a.resetPending = false;
  }
  if (a.resetPending && !punching) { a.mode = 'reset'; a.modeTimer = st.resetTime; a.resetPending = false; }
  a.modeTimer = Math.max(0, a.modeTimer - dt);
  if (a.modeTimer === 0) rollMode(a, me.stamina, st);
  // Ring use: a style that circles away always goes away from the opponent's POWER hand (his rear hand is on my
  // left when he is orthodox, so away is my right).
  if (tools && st.ringUse === 'circleAway') a.circleDir = handLateralSign('rear', opp.stance);
  // A reset may start with a burst back (overhaul): out, in one hop.
  if (tools && a.mode === 'reset' && !wasReset && a.macro === null && !punching && !spent && cfg.burstOn && me.burstCd === 0 && rngChance(a.rngT, st.burstChance)) {
    a.macro = { kind: 'burst', t: 0, x: 0, y: -1, punch: null };
    a.used.burst += 1;
  }

  // ── 3. Reactive defence ────────────────────────────────────────────────────
  // A guard that is already up is neither re-rolled nor extended — a follow-up
  // inside the window is covered, one after it gets its own roll. Punching and
  // blocking are mutually exclusive (locked mechanic), for the AI too.
  // The reaction is a reaction time late (2026-09-16): the roll is made when
  // the punch is noticed, the guard comes up when the reaction lands — so a
  // jab is through before the hands move and a hook meets a guard, as with a
  // person. Zero = the tick after, as before.
  if (a.blockTimer > 0) a.blockTimer = Math.max(0, a.blockTimer - dt);
  if (oppStarted && a.blockReact === 0 && a.blockTimer === 0 && dist <= st.engageStraight) {
    a.blockReact = Math.max(st.reaction, 1e-6);
  }
  if (a.blockReact > 0) {
    a.blockReact = Math.max(0, a.blockReact - dt);
    // (Inside range it defends at insideBlock; against a rush, always; and difficulty makes it miss some.)
    const defend = (wild ? 1 : inside ? Math.max(st.blockChance, st.insideBlock) : st.blockChance) * sure;
    if (a.blockReact === 0 && !punching && a.blockTimer === 0 && rngChance(a.rng, defend)) {
      a.blockTimer = st.blockWindow;
      // Overhaul: a share of the punches it has decided to defend it takes
      // with its head instead — a roll under a head hook, a slip away from
      // the punching hand. Only while that punch is still coming.
      const p = opp.punch;
      // (Phase 3: only if there is TIME — the punch's tell less its own reaction leaves the slip its lead. Measured:
      // the counter style "slipped" nine jabs a fight and dodged one; a jab is 0.11 s and it had already spent 0.18
      // seeing it. What it cannot slip it blocks.)
      if (tools && a.macro === null && p.type !== null && !p.resolved && !nowHurt && !me.slip.active && p.tell - st.reaction >= SLIP_LEAD - 1e-9) {
        const hand = handLateralSign(p.hand, opp.stance);   // + = the hand is on the opponent's right, which is MY left
        const r = rngFloat(a.rngT);
        const headHook = p.type === 'hook' && p.variant !== 'bodyHook';
        if (headHook && cfg.rollOn && cfg.levelOn && r < st.rollShare) {
          a.macro = { kind: 'roll', t: 0, x: -hand, y: 0, punch: null };   // under it, toward where it came from
          a.blockTimer = 0; a.used.roll += 1;
        } else if (r < (headHook ? st.rollShare + (1 - st.rollShare) * st.slipShare : st.slipShare)) {
          a.macro = { kind: 'slip', t: 0, x: hand, y: 0, punch: null };    // away from the hand
          a.blockTimer = 0; a.used.slip += 1;
        }
      }
    }
  }
  input.block = a.blockTimer > 0 && !punching;
  // Shelled up (picked off at range): the guard stays up while it walks in, and comes down to throw once it is there.
  // Phase 2: the same behind the guard at inside range (if it decided to), and against a rush — where it also holds
  // its fire while his punch is still coming, and throws only into what he leaves.
  const covering = a.coverT >= st.reaction;   // (phase 3) through his combination: up, and it stays up until he stops
  const holdFire = (wild && oppPunching && !opp.punch.resolved && dist <= st.engageStraight + 0.2) || covering;
  // (Only where he can reach: a guard held up out of range is wind spent on nothing.)
  // (Phase 3: and not the shell at INSIDE range unless it is covering a combination or chose to hold there — a guard
  // kept up "until it has something to throw" with a man on its chest was a third of its time there.)
  const guardUp = (a.shellT > 0 && dist <= st.engageStraight + SHELL_RANGE && !inside) || (inside && a.insideHold) || (wild && dist <= st.engageStraight + 0.2) || covering;
  const shelled = tools && guardUp && a.hurtPlan !== 'swing' && !punching && (holdFire || !(a.armed !== null && dist <= engageOf(a.armed, st) && dist >= nearDist(a.armed, cfg)));
  if (shelled) input.block = true;

  // ── 2. Arm: the timer expiring picks the punch (and hand) — it does not throw.
  // Expired = ARMED: the timer holds at 0 and the punch waits for range rather
  // than rolling a fresh wait after the walk-in.
  const inRange = dist <= st.engageStraight;
  let aggression = 1;
  if (inRange && !opp.block) aggression *= st.aggression;
  if (opp.stamina < cfg.lowStamina) aggression *= st.aggression;
  if (oppStumbling) aggression *= st.aggression;   // the follow-up: a stumbling opponent is pressed (2026-09-22)
  a.aggression = aggression;
  // (Tired, its tempo drops: the timer drains 1 / tiredTempo as fast at full fatigue.)
  // (Inside, an inside fighter works faster. Against a rush it does not lead at all until he has punched himself out.)
  const tempo = tools ? (inside ? st.insideTempo : 1) / lerp(1, st.tiredTempo, clamp(me.fatigue, 0, 1)) : 1;
  // (Out of wind it does not lead either: it gets out, covers, and — if he is on top of it — ties him up, which is
  // where a gassed fighter gets his breath back.)
  const evade = ((wild && opp.stamina > WILD_GASSED) || a.resting) && !nowHurt;
  if (tools && a.resting && !nowHurt && a.macro === null && !punching && cfg.clinchOn && me.clinch.cd === 0 && !me.clinch.active && dist <= cfg.clinchRange) {
    a.macro = { kind: 'clinch', t: 0, x: 1, y: 0, punch: null };
    a.used.clinch += 1;
  }
  if (!evade) a.attackTimer = Math.max(0, a.attackTimer - dt * aggression * tempo);
  if (a.attackTimer === 0 && a.armed === null && !evade) {
    a.armed = pickPunch(a.rng, st);
    a.armedX = rngChance(a.rng, 0.5) ? -1 : 1;
    a.armedBody = false; a.armedShown = false; a.armedOver = false; a.armedTold = false; a.armedBack = false; a.queue = [];
    if (tools) {
      // The finish: a hurt opponent gets power. Otherwise a SIGNATURE combination of the style's, or a single
      // punch that sometimes goes to the body — more against a held guard — or, a cross, over the top.
      if (opp.hurt > 0 && rngChance(a.rngT, st.finishPower)) a.armed = pickPunch(a.rngT, st, POWER);
      else if (st.combos.length > 0 && rngChance(a.rngT, st.comboSignature * st.comboChance)) {
        const combo = st.combos[rngInt(a.rngT, 0, st.combos.length - 1)]!;
        armStep(a, combo[0]!);
        a.queue = combo.slice(1); a.queueT = QUEUE_LIFE;
      } else if (cfg.levelOn && rngChance(a.rngT, opp.block ? st.bodyRateHighGuard : st.bodyRate)) a.armedBody = true;
      else if (a.armed === 'cross' && cfg.levelOn && rngChance(a.rngT, st.overhandRate)) a.armedOver = true;
    }
  }

  // ── 1. Standoff steer ──────────────────────────────────────────────────────
  // `move` is opponent-relative in the fighter's own frame (y = toward), so the
  // unit vector to the opponent is projected onto that frame; the yaw lags the
  // opponent by at most turnRate, so this steers along the true line, not the
  // facing. Speed tapers over two band widths so it decelerates into the band
  // instead of overshooting and bouncing back out. Backing off (rather than
  // just stopping) when too close is what restores its own jab's power.
  // Armed with a punch shorter than its resting distance, it steps in to that
  // punch's range (and drifts back out to the standoff once it has thrown) —
  // except mid-reset (it is leaving) and on hold (it is standing).
  // hurt: get out of range, keep the feet moving. The same against a rush: give him the ring until he is gassed.
  const surviving = tools && ((nowHurt && a.hurtPlan === 'cover') || evade);
  const mode = surviving ? 'reset' : a.mode;
  let standoff = mode === 'reset' ? st.resetDist : mode === 'probe' ? st.probeDist : mode === 'circle' ? st.standoff + st.standoffBand : st.standoff;
  const band = mode === 'circle' ? st.standoffBand * 2 : st.standoffBand;
  const stepsIn = a.armed !== null && st.stepIn > 0 && mode !== 'reset' && mode !== 'hold';
  if (stepsIn) standoff = Math.min(standoff, engageOf(a.armed!, st) - st.stepIn * st.standoffBand);
  if (a.giveGround > 0) standoff += st.giveGround;
  // Steer by the PERCEIVED distance: closing speed along the line (positive =
  // the gap is shrinking) → the distance it is heading for.
  const closing = (me.vel.x - opp.vel.x) * ux + (me.vel.z - opp.vel.z) * uz;
  const half = RING_HALF - cfg.ringInset;
  // Cutting off a mover (phase 2): pressing, it steers for where he WILL be (his walking velocity × leadPursuit,
  // kept inside the ring), not where he is — it takes the ring away instead of following him round it.
  let sx = ux, sz = uz, sDist = seenDist;
  if (tools && st.leadPursuit > 0 && (mode === 'press' || mode === 'probe') && !surviving) {
    const lx = clamp(a.seen.x + (opp.vel.x + opp.hop.x) * st.leadPursuit, -half, half), lz = clamp(a.seen.z + (opp.vel.z + opp.hop.z) * st.leadPursuit, -half, half);
    const ld = Math.hypot(lx - me.pos.x, lz - me.pos.z);
    if (ld > 0.05) { sx = (lx - me.pos.x) / ld; sz = (lz - me.pos.z) / ld; sDist = ld; }
  }
  const predicted = sDist - closing * st.lookahead;
  const err = predicted - standoff;
  const fr = frameOf(me.yaw);
  const chasing = err > 0 && a.chaseHold > 0;   // they just backed off: let the space open
  if (mode !== 'hold' && !chasing && Math.abs(err) > band) {
    const mag = clamp(Math.abs(err) / (band * 2), 0, 1) * st.speed;
    const sign = err > 0 ? 1 : -1;   // +1 = close in, -1 = back off
    if (dist > 0.01) {
      input.move.y = (fr.fwd.x * sx + fr.fwd.z * sz) * sign * mag;
      input.move.x = (fr.right.x * sx + fr.right.z * sz) * sign * mag;
    } else {
      input.move.y = -mag;   // co-located: no usable direction, back straight off
    }
  }
  if (mode === 'circle' || surviving) {
    // Lateral stick: the sim's x is the fighter's right, which is already
    // perpendicular to the line to the opponent (the yaw tracks it).
    input.move.x += a.circleDir * st.circleSpeed * st.speed;
    const len = Math.hypot(input.move.x, input.move.y);
    if (len > 1) { input.move.x /= len; input.move.y /= len; }
  }
  // Ring use (phase 2): a style that holds the centre drifts back to it; one that circles away will not circle
  // itself onto the ropes — near them it comes back toward the open ring.
  if (tools && !surviving && mode !== 'reset' && a.style !== null) {
    const r = Math.hypot(me.pos.x, me.pos.z);
    const edge = Math.min(half - Math.abs(me.pos.x), half - Math.abs(me.pos.z));
    if ((st.ringUse === 'centre' && r > CENTRE_RADIUS) || (st.ringUse === 'circleAway' && edge < ROPE_SHY) && r > 0.01) {
      const cx = -me.pos.x / r, cz = -me.pos.z / r;
      input.move.y += (fr.fwd.x * cx + fr.fwd.z * cz) * CENTRE_PULL * st.speed;
      input.move.x += (fr.right.x * cx + fr.right.z * cz) * CENTRE_PULL * st.speed;
      const len = Math.hypot(input.move.x, input.move.y);
      if (len > 1) { input.move.x /= len; input.move.y /= len; }
    }
  }
  // Cutting off the ring (overhaul): with the opponent near the ropes it does
  // not follow — it mirrors their sideways movement, staying between them and
  // the open ring.
  if (tools && st.cutOff > 0 && (mode === 'press' || mode === 'probe') && !surviving) {
    const edge = Math.min(half - Math.abs(opp.pos.x), half - Math.abs(opp.pos.z));
    if (edge < st.cutOffZone) {
      const lat = (opp.vel.x + opp.hop.x) * fr.right.x + (opp.vel.z + opp.hop.z) * fr.right.z;   // their sideways speed, in my frame
      if (Math.abs(lat) > CUT_OFF_MIN_SPEED) {
        input.move.x += (lat > 0 ? 1 : -1) * st.cutOff * st.speed;
        const len = Math.hypot(input.move.x, input.move.y);
        if (len > 1) { input.move.x /= len; input.move.y /= len; }
        a.used.cutOff += 1;
      }
    }
  }

  // Coming in through the jab (phase 2): in his jab range, walking in, a style that comes in under punches moves
  // its head off the line without waiting to read one — toward one side or the other, never on a beat.
  if (tools && st.approachSlip > 0 && a.macro === null && !punching && !nowHurt && !evade && cfg.rollOn !== undefined
    && dist > st.engageHook && dist < APPROACH_FAR && me.slip.dir === 0 && err > 0 && rngChance(a.rngT, st.approachSlip * dt)) {
    a.macro = { kind: 'slip', t: 0, x: rngChance(a.rngT, 0.5) ? 1 : -1, y: 0, punch: null };
    a.used.slip += 1;
  }

  // ── 6. The tools that are flicks: off the ropes, and making space ──────────
  if (tools && a.macro === null && !punching && !nowHurt && !spent) {
    // On the ropes with the opponent in range: pivot off, toward the open ring.
    if (cfg.pivotOn && me.ropes > 0.5 && dist < st.engageStraight + 0.2 && me.burstCd === 0 && rngChance(a.rngT, st.ropePivotRate * dt)) {
      const open = (fr.right.x * -me.pos.x + fr.right.z * -me.pos.z) >= 0 ? 1 : -1;   // which of my sides the ring centre is on
      a.macro = { kind: 'pivot', t: 0, x: open, y: 0, punch: null };
      a.used.pivot += 1;
    } else if (cfg.pushOffOn && me.pushCd === 0 && dist < cfg.pushRange - 0.05
      && (opp.clinch.reach > 0 ? rngChance(a.rngT, 0.5) : (mode === 'probe' || mode === 'circle' || mode === 'reset') && dist < cfg.rangeInside && rngChance(a.rngT, st.pushOffRate * dt))) {
      // Crowded while it wants space, or being grabbed: shove.
      a.macro = { kind: 'push', t: 0, x: 0, y: 1, punch: null };
      a.used.push += 1;
    }
  }

  // ── 2 + 4. Throw: only inside the armed punch's own landing band ──────────
  // (4 is the aggression drain above: the opening punish tracks an opening
  // appearing or closing mid-wait instead of being locked in at the last throw.)
  // Not while resetting: it is stepping out, not fighting. Each throw may
  // trigger a reset once it has landed or missed — the step-out after the exchange.
  // Bursts (2026-09-16): a throw may open a burst of comboMax punches; the
  // follow-ups are armed almost at once (comboGap) and chain inside the
  // sim's combo window. The reset roll waits for the burst to end — the
  // step-out comes after the exchange, not after every punch.
  let pressed = false;
  // (Phase 3: stepping out is not a licence to be hit. MEASURED: the outboxer, in reset three-quarters of the time
  // with a man on his chest, stood armed and silent for seconds at a stretch — 12 punches started in a 27 s fight,
  // 51 against. While resetting it still throws if he is on top of it (it could not get away: fight), and a style
  // that fights off the back foot jabs going away.)
  // …and a straight armed for a man who is now chest to chest is the wrong punch: it waited there, armed, for as long
  // as he stayed (measured: 2 s at 0.55 m). Smothered, it changes to the hook or the uppercut.
  // The same for any armed punch whose band he is not in while he IS at close range (an uppercut armed for a man
  // 2 cm too far: 12% of its time there): it takes the punch that fits where he is.
  if (tools && a.armed !== null && a.attackTimer === 0 && a.queue.length === 0 && dist < cfg.rangeInside + RESET_FIGHT) {
    const fits = (t: PunchType): boolean => dist <= engageOf(t, st) && dist >= nearDist(t, cfg);
    if (!fits(a.armed)) {
      const alt: PunchType | null = fits('hook') ? 'hook' : fits('uppercut') ? 'uppercut' : fits('jab') ? 'jab' : null;
      if (alt !== null) {
        a.armed = alt;
        a.armedX = rngChance(a.rngT, 0.5) ? -1 : 1;
        a.armedBody = false; a.armedOver = false; a.armedBack = false;
      }
    }
  }
  const crowdedOut = tools && mode === 'reset' && dist < cfg.rangeInside + RESET_FIGHT;
  const jabOut = tools && mode === 'reset' && a.armed === 'jab' && st.backFoot > 0;
  if (jabOut && !crowdedOut) a.armedBack = true;
  if (a.armed !== null && a.attackTimer === 0 && (mode !== 'reset' || crowdedOut || jabOut) && a.macro === null) {
    const t = a.armed;
    const inBand = dist <= engageOf(t, st) && dist >= nearDist(t, cfg);
    if (inBand && canThrow && !input.block) {
      // A body shot (and the overhand) drops its level first and throws once it is down.
      const needLevel = a.armedBody || a.armedOver;
      const bodyReady = !needLevel || me.level >= cfg.levelAt;
      if (needLevel) input.level = true;
      // The tell (phase 2): before a lone power punch the style's habit may show — one roll per punch.
      if (tools && !a.armedTold && st.tell !== 'none' && t !== 'jab' && !punching && a.burst === 0 && a.queue.length === 0) {
        a.armedTold = true;
        if (rngChance(a.rngT, st.tellRate)) a.macro = { kind: 'tell', t: 0, x: st.tell === 'dip' ? 1 : 0, y: 0, punch: null };
      }
      if (a.macro !== null) {
        // (showing its tell this tick; the punch stays armed)
      } else if (tools && !a.armedShown && t !== 'jab' && cfg.feintOn && !punching && !spent && a.burst === 0 && rngChance(a.rngT, st.feintChance)) {
        // Show it first: a feint, then the real one (the punch stays armed).
        a.armedShown = true;
        a.macro = { kind: 'feint', t: 0, x: a.armedX, y: 0, punch: t };
        a.used.feint += 1;
        a.throwCount += 1;   // a shown punch is a commit too (it fires a punchStart)
        a.lastThrowDist = dist;
      } else if (bodyReady && st.hesitate > 0 && a.queue.length === 0 && a.burst === 0 && rngChance(a.rngT, st.hesitate)) {
        // Difficulty (phase 3): set, in range — and it does not pull the trigger. It waits a beat, still armed.
        a.attackTimer = HESITATE_T;
      } else if (bodyReady) {
        a.armedShown = true;
        input[t] = true;   // one tick high = the rising edge the sim fires on
        pressed = true;
        if (t === 'hook' || t === 'uppercut') input.move.x = a.armedX;   // the stick at the press picks the hand
        if (a.armedOver) input.move.y = 1;   // the overhand steps in
        if (a.armedBack) { input.move.y = -1; if (t === 'hook') input.move.x = a.armedX * 0.5; a.armedBack = false; }   // thrown going away
        if (a.armedBody) a.used.body += 1;
        a.armed = null;
        a.throwCount += 1;
        a.lastThrowDist = dist;
        if (a.queue.length > 0) {
          // The next punch of the signature combination: armed at once, pressed a combo gap later (a fresh edge).
          armStep(a, a.queue.shift()!);
          a.armedShown = true; a.armedTold = true;
          a.queueT = QUEUE_LIFE; a.attackTimer = Math.max(st.comboGap, SIM_DT * 2);
          a.burst = 0;
        } else {
        // (The last punch of a signature combination ends the exchange: no random burst on top of it.)
        const signed = a.queueT > 0;
        a.queueT = 0;
        if (!signed && a.burst === 0 && st.comboMax > 1 && rngChance(a.rng, st.comboChance)) a.burst = rngInt(a.rng, 1, Math.floor(st.comboMax) - 1);
        else if (a.burst > 0) a.burst -= 1;
        if (a.burst > 0) a.attackTimer = st.comboGap;
        else {
          a.attackTimer = rngRange(a.rng, st.attackDelayMin, st.attackDelayMax);
          if (rngChance(a.rng, st.resetChance)) a.resetPending = true;
        }
        }
      }
    }
  }

  // ── Macros take the controls for their few ticks ───────────────────────────
  if (a.macro !== null) {
    const m = cloneInput(NULL_INPUT);
    if (runMacro(a, m, s, cfg)) { trackStick(a, m, dt, cfg, false, false); return { ai: a, input: m }; }
  }

  // ── Stick discipline: never a double-tap by accident ────────────────────────
  // The steer's stick comes and goes; a short push followed by another the
  // same way inside burstTapWindow is, to the sim, a BURST. So the AI tracks
  // its own short pushes the way the sim does (slip.ts) and, when a new push
  // would complete a double-tap, keeps it just under the push threshold until
  // the window has passed. A burst is always a macro. (A push on the stick at
  // a punch press is that punch's hand selection — the sim spends it.)
  // With the guard up a flick is a pivot or a shove: behind the guard the steer's stick stays under the push threshold
  // (it walks in a little slower with its hands up). Those two are always macros.
  // (Phase 2: it used to cap the stick under the threshold, which made a guarded walk-in 40% slower than the man it
  // was chasing. Now a push at or over the threshold is simply HELD through the flick window before it may end.)
  if (input.block) {
    const m = Math.hypot(input.move.x, input.move.y);
    if (m >= cfg.slipInputThreshold) { a.holdX = input.move.x; a.holdY = input.move.y; }
    else if (a.stickT > 0 && a.stickT <= cfg.slipFlickMax + SIM_DT) { input.move.x = a.holdX; input.move.y = a.holdY; }
  }
  trackStick(a, input, dt, cfg, pressed, true);
  // Never the clinch by accident: level and block together are a macro's.
  if (input.block) input.level = false;

  return { ai: a, input };
}
/** Arm one step of a signature combination. */
function armStep(a: AiState, step: ComboStep): void {
  a.armed = step.p;
  if (step.x !== undefined) a.armedX = step.x;
  a.armedBody = step.body === true;
  a.armedOver = false;
}
/** Ticks the tell (the dip, the half step back) shows before the punch. Shape. */
const TELL_TICKS = 7;
/** The window the opponent's punch rate is measured over, s; the exposure at which a rushing man's miss is taken. Shape. */
const WILD_WINDOW = 1.5, WILD_VULN = 0.3;
/** A rushing man is "punched out" below this stamina: then it stops giving ground and goes to work. Shape. */
const WILD_GASSED = 0.3;
/** The far edge of "in his jab range" for the approach slip, m. Shape. */
const APPROACH_FAR = 1.2;
/** Seconds a hesitation (StyleParams.hesitate) costs. Shape. */
const HESITATE_T = 0.45;
/** Stagger speed, m/s, above which the AI's own hands are stopped (a clean cross starts ~3, a hook ~5). Shape. */
const OWN_STUMBLE = 4.5;
/** While stepping out it still fights if he is within rangeInside + this, m. Shape. */
const RESET_FIGHT = 0.1;
/** A combination is punches started less than this many seconds apart; and how far outside rangeInside it still covers one, m. Shape. */
const COVER_QUIET = 0.3, COVER_MARGIN = 0.12;
/** Seconds a slip or roll needs between the decision and the punch arriving (the flick is 3 ticks, then the head has to travel). Shape. */
const SLIP_LEAD = 0.05;
/** A man closing faster than this (m/s) is walking in; the stiff jab is thrown this far (m) before he reaches its range. Shape. */
const INTERCEPT_SPEED = 0.8, INTERCEPT_LEAD = 0.12;
/** Its own stamina: below TOOL_STAMINA no optional tools; below REST_BELOW it rests until REST_UNTIL; the guard is only held up within SHELL_RANGE of its engage distance. Shape. */
const TOOL_STAMINA = 0.35, REST_BELOW = 0.22, REST_UNTIL = 0.55, SHELL_RANGE = 0.35;
/** How far outside rangeInside still counts as "inside" for its guard, m. Shape. */
const INSIDE_MARGIN = 0.04;
/** Fatigue above which a style that leans on people when tired does. Shape. */
const TIRED_CLINCH_AT = 0.6;
/** Seconds the rest of a signature combination waits to be thrown before it is dropped. Shape. */
const QUEUE_LIFE = 0.9;
/** A style that holds the centre drifts back from further out than this, m; one that circles away comes off the ropes inside this, m; the stick they do it with. Shape. */
const CENTRE_RADIUS = 1.3, ROPE_SHY = 0.8, CENTRE_PULL = 0.55;
/** A health drop in one tick above this is a shot it noticed (any clean land; a blocked jab is 0). Shape. */
const HIT_NOTICED = 0.005;
/** A push held back from completing a double-tap sits at this fraction of the push threshold. Shape. */
const UNDER_PUSH = 0.95;
/** How far outside clinchRange a hurt AI will still walk in to tie up, m. Shape. */
const CLINCH_WALK_IN = 0.25;
/** Sideways speed under which the opponent is not "moving along the ropes", m/s. Shape. */
const CUT_OFF_MIN_SPEED = 0.3;

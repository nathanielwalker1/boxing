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
import { defaultStyle, type StyleParams } from './style';

export { defaultStyle, type StyleParams } from './style';

export type AiMode = 'press' | 'probe' | 'circle' | 'hold' | 'reset';

/** A few ticks of scripted input: the flick family, the feint, the clinch. */
export interface AiMacro {
  kind: 'slip' | 'roll' | 'pivot' | 'push' | 'burst' | 'feint' | 'clinch';
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
  hurtPlan: 'none' | 'clinch' | 'cover';
  /** Shots taken lately (decays one a second): two = it is taking a combination. Seconds left of walking in behind the guard after being picked off at range. */
  hits: number; shellT: number;
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
  const a: AiState = { ...ai, rng: rngClone(ai.rng), rngT: rngClone(ai.rngT), macro: ai.macro ? { ...ai.macro } : null, used: { ...ai.used } };
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
  const oppStarted = oppPunching && !a.oppPunching;
  a.oppPunching = oppPunching;
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
  const meStumbling = Math.hypot(me.stagger.x, me.stagger.z) > st.stumbleSpeed || me.hurt > 0;
  const oppStumbling = Math.hypot(opp.stagger.x, opp.stagger.z) > st.stumbleSpeed || opp.hurt > 0;
  if (me.hurt > 0) a.blockTimer = Math.max(a.blockTimer, st.coverTime);

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
  const canThrow = canStartPunch(me, cfg) && !meStumbling;

  // ── Surviving (overhaul): the plan is rolled once, as it is hurt. Close → maybe tie up; otherwise cover and give ground.
  const nowHurt = me.hurt > 0;
  if (nowHurt && !a.wasHurt) a.hurtPlan = tools && rngChance(a.rngT, st.hurtClinch) ? 'clinch' : 'cover';
  if (!nowHurt) a.hurtPlan = 'none';
  a.wasHurt = nowHurt;
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
    a.burst = 0;
  }
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
    if (a.counterReact === 0 && opp.vuln > 0 && !opp.down && a.blockTimer === 0 && a.mode !== 'reset') {
      a.armed = opp.vuln >= st.counterVuln ? 'cross' : 'jab';
      a.armedBody = false; a.armedShown = true;   // a counter is thrown, never shown
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
    else if (a.armed === null) { a.armed = 'jab'; a.armedBody = false; a.armedShown = true; a.attackTimer = 0; }
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
  // A reset may start with a burst back (overhaul): out, in one hop.
  if (tools && a.mode === 'reset' && !wasReset && a.macro === null && !punching && cfg.burstOn && me.burstCd === 0 && rngChance(a.rngT, st.burstChance)) {
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
    if (a.blockReact === 0 && !punching && a.blockTimer === 0 && rngChance(a.rng, st.blockChance)) {
      a.blockTimer = st.blockWindow;
      // Overhaul: a share of the punches it has decided to defend it takes
      // with its head instead — a roll under a head hook, a slip away from
      // the punching hand. Only while that punch is still coming.
      const p = opp.punch;
      if (tools && a.macro === null && p.type !== null && !p.resolved && !nowHurt && !me.slip.active) {
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
  const shelled = tools && a.shellT > 0 && !punching && !(a.armed !== null && dist <= engageOf(a.armed, st) && dist >= nearDist(a.armed, cfg));
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
  a.attackTimer = Math.max(0, a.attackTimer - dt * aggression);
  if (a.attackTimer === 0 && a.armed === null) {
    a.armed = pickPunch(a.rng, st);
    a.armedX = rngChance(a.rng, 0.5) ? -1 : 1;
    a.armedBody = false; a.armedShown = false;
    if (tools) {
      // The finish: a hurt opponent gets power. Otherwise, sometimes, the body — more against a held guard.
      if (opp.hurt > 0 && rngChance(a.rngT, st.finishPower)) a.armed = pickPunch(a.rngT, st, POWER);
      else if (cfg.levelOn && rngChance(a.rngT, opp.block ? st.bodyRateHighGuard : st.bodyRate)) a.armedBody = true;
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
  const surviving = tools && nowHurt && a.hurtPlan === 'cover';   // hurt: get out of range, keep the feet moving
  const mode = surviving ? 'reset' : a.mode;
  let standoff = mode === 'reset' ? st.resetDist : mode === 'probe' ? st.probeDist : mode === 'circle' ? st.standoff + st.standoffBand : st.standoff;
  const band = mode === 'circle' ? st.standoffBand * 2 : st.standoffBand;
  const stepsIn = a.armed !== null && st.stepIn > 0 && mode !== 'reset' && mode !== 'hold';
  if (stepsIn) standoff = Math.min(standoff, engageOf(a.armed!, st) - st.stepIn * st.standoffBand);
  if (a.giveGround > 0) standoff += st.giveGround;
  // Steer by the PERCEIVED distance: closing speed along the line (positive =
  // the gap is shrinking) → the distance it is heading for.
  const closing = (me.vel.x - opp.vel.x) * ux + (me.vel.z - opp.vel.z) * uz;
  const predicted = seenDist - closing * st.lookahead;
  const err = predicted - standoff;
  const fr = frameOf(me.yaw);
  const chasing = err > 0 && a.chaseHold > 0;   // they just backed off: let the space open
  if (mode !== 'hold' && !chasing && Math.abs(err) > band) {
    const mag = clamp(Math.abs(err) / (band * 2), 0, 1) * st.speed;
    const sign = err > 0 ? 1 : -1;   // +1 = close in, -1 = back off
    if (dist > 0.01) {
      input.move.y = (fr.fwd.x * ux + fr.fwd.z * uz) * sign * mag;
      input.move.x = (fr.right.x * ux + fr.right.z * uz) * sign * mag;
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
  // Cutting off the ring (overhaul): with the opponent near the ropes it does
  // not follow — it mirrors their sideways movement, staying between them and
  // the open ring.
  if (tools && st.cutOff > 0 && (mode === 'press' || mode === 'probe') && !surviving) {
    const half = RING_HALF - cfg.ringInset;   // the movement bound; the opponent's distance to it on the nearer axis:
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

  // ── 6. The tools that are flicks: off the ropes, and making space ──────────
  if (tools && a.macro === null && !punching && !nowHurt) {
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
  if (a.armed !== null && mode !== 'reset' && a.macro === null) {
    const t = a.armed;
    const inBand = dist <= engageOf(t, st) && dist >= nearDist(t, cfg);
    if (inBand && canThrow && !input.block) {
      // A body shot drops its level first and throws once it is down.
      const bodyReady = !a.armedBody || me.level >= cfg.levelAt;
      if (a.armedBody) input.level = true;
      if (tools && !a.armedShown && t !== 'jab' && cfg.feintOn && !punching && a.burst === 0 && rngChance(a.rngT, st.feintChance)) {
        // Show it first: a feint, then the real one (the punch stays armed).
        a.armedShown = true;
        a.macro = { kind: 'feint', t: 0, x: a.armedX, y: 0, punch: t };
        a.used.feint += 1;
        a.throwCount += 1;   // a shown punch is a commit too (it fires a punchStart)
        a.lastThrowDist = dist;
      } else if (bodyReady) {
        a.armedShown = true;
        input[t] = true;   // one tick high = the rising edge the sim fires on
        pressed = true;
        if (t === 'hook' || t === 'uppercut') input.move.x = a.armedX;   // the stick at the press picks the hand
        if (a.armedBody) a.used.body += 1;
        a.armed = null;
        a.throwCount += 1;
        a.lastThrowDist = dist;
        if (a.burst === 0 && st.comboMax > 1 && rngChance(a.rng, st.comboChance)) a.burst = rngInt(a.rng, 1, Math.floor(st.comboMax) - 1);
        else if (a.burst > 0) a.burst -= 1;
        if (a.burst > 0) a.attackTimer = st.comboGap;
        else {
          a.attackTimer = rngRange(a.rng, st.attackDelayMin, st.attackDelayMax);
          if (rngChance(a.rng, st.resetChance)) a.resetPending = true;
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
  if (input.block) {
    const m = Math.hypot(input.move.x, input.move.y);
    if (m >= cfg.slipInputThreshold) { const kk = cfg.slipInputThreshold * UNDER_PUSH / m; input.move.x *= kk; input.move.y *= kk; }
  }
  trackStick(a, input, dt, cfg, pressed, true);
  // Never the clinch by accident: level and block together are a macro's.
  if (input.block) input.level = false;

  return { ai: a, input };
}
/** A health drop in one tick above this is a shot it noticed (any clean land; a blocked jab is 0). Shape. */
const HIT_NOTICED = 0.005;
/** A push held back from completing a double-tap sits at this fraction of the push threshold. Shape. */
const UNDER_PUSH = 0.95;
/** How far outside clinchRange a hurt AI will still walk in to tie up, m. Shape. */
const CLINCH_WALK_IN = 0.25;
/** Sideways speed under which the opponent is not "moving along the ropes", m/s. Shape. */
const CUT_OFF_MIN_SPEED = 0.3;

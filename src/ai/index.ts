/**
 * ai/index.ts — the opponent (SIM workstream, CONTRACT §2). Port of
 * legacy/src/dummy.js's four heuristics as a pure FrameInput producer: given
 * its own state and the sim state at the top of a tick, `aiStep` returns the
 * input its side feeds to sim.step that tick, plus its next state. Nothing
 * here mutates its arguments. No clocks and no Math.random — its only
 * randomness is core/rng on a stream of its own, seeded from the fight seed —
 * so a seed plus the other side's input history replays byte-identical
 * (CONTRACT §3). The sim never knows the AI exists: side 1 is "whatever input
 * it is given", exactly as before.
 *
 *   0. Footwork mode  — (2026-09-16) a mode rolled on a seeded timer decides
 *                        WHERE it wants to be and whether it moves at all:
 *                        PRESS   the standoff steer below, at aiStandoffDist
 *                        PROBE   the same steer at aiProbeDist — out of range;
 *                                it steps in only to throw, then drifts back out
 *                        CIRCLE  a loose standoff plus lateral stick, one way
 *                        HOLD    no steering for a beat
 *                        RESET   steps out to aiResetDist after an exchange (a
 *                                throw, or a solid shot taken), then re-rolls.
 *                        Fight Night / UFC opponents pick spacing behaviour per
 *                        style rather than holding one distance; this is the
 *                        cheap version of that. Zero every weight but press
 *                        and reset chance and it is the old AI.
 *   1. Standoff steer   — walks toward / away from the mode's standoff through
 *                         the shared locomotion, with a hysteresis band (no
 *                         steering inside it) and a proportional taper into the
 *                         band, so it settles instead of hunting. Acts on the
 *                         PREDICTED distance (closing speed × aiLookahead) so
 *                         it decelerates into range rather than gliding through.
 *   2. Range-gated punch — the randomised timer only ARMS a punch. Arming picks
 *                         the type by weight (aiJabWeight…) and, for a hook or
 *                         uppercut, a hand by coin flip. The throw waits for the
 *                         opponent inside that punch's own landing band (straights
 *                         [smotherDist, aiEngageDist]; hooks/uppercuts from body
 *                         contact out to their measured reach), and while armed
 *                         with a short punch it steps in to get there (aiStepIn).
 *   3. Reactive block   — the tick after the opponent's punch starts it rolls
 *                         aiBlockChance; on success the guard is up for
 *                         aiBlockWindow seconds. Never re-rolled while up.
 *   4. Opening punish   — an unguarded in-range or gassed opponent drains the
 *                         attack timer faster (the two stack multiplicatively),
 *                         so the punish tracks an opening appearing mid-wait.
 *
 * Timers run on the sim's clock: during hit-stop they slow with it.
 */
import {
  NULL_INPUT, SIM_DT, clamp, cloneInput, frameOf, lerp, rngChance, rngClone, rngFloat, rngInt, rngRange, seedRng, v2dist,
  type Config, type FrameInput, type PunchType, type RngState, type Side, type SimState,
} from '../core';

export type AiMode = 'press' | 'probe' | 'circle' | 'hold' | 'reset';

export interface AiState {
  side: Side;
  rng: RngState;
  /** Seconds until the next punch is armed; held at 0 while armed and waiting for range. */
  attackTimer: number;
  /** The punch it has armed and is waiting to land (null = timer still running). */
  armed: PunchType | null;
  /** Hand for the armed hook/uppercut, as the stick sign the sim reads at the press (-1 = lead). */
  armedX: -1 | 1;
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
  /** Where it THINKS the opponent is: the true position lagged by aiReactionTime (a human does not track a coordinate). */
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
  /** The opponent was retreating faster than aiPressureSpeed last tick (the chase hold is set on the rising edge). */
  oppRetreating: boolean;
}

/** A fresh AI for `side`. Its rng stream is derived from the fight seed so two sides never share one. */
export function createAi(side: Side, seed: number, cfg: Config): AiState {
  const rng = seedRng((seed + 7919 * (side + 1)) >>> 0);
  return {
    side,
    rng,
    attackTimer: rngRange(rng, cfg.aiAttackDelayMin, cfg.aiAttackDelayMax),
    armed: null,
    armedX: -1,
    blockTimer: 0,
    oppPunching: false,
    aggression: 1,
    dist: Infinity,
    throwCount: 0,
    lastThrowDist: Infinity,
    mode: 'press',
    modeTimer: rngRange(rng, cfg.aiModeMin, cfg.aiModeMax),
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
  };
}

/** The recover phase of `t` in seconds, as the sim will time it (punches.ts phases()). */
function recoverOf(t: PunchType, cfg: Config): number {
  const r = t === 'jab' ? cfg.jabRecover : t === 'cross' ? cfg.crossRecover : t === 'hook' ? cfg.hookRecover : cfg.uppercutRecover;
  return r * Math.max(0.01, cfg.punchTimeScale);
}

const TYPES: readonly PunchType[] = ['jab', 'cross', 'hook', 'uppercut'];
const weightOf = (t: PunchType, cfg: Config): number =>
  t === 'jab' ? cfg.aiJabWeight : t === 'cross' ? cfg.aiCrossWeight : t === 'hook' ? cfg.aiHookWeight : cfg.aiUppercutWeight;
/** Weighted pick; all weights 0 = jab. */
function pickPunch(rng: RngState, cfg: Config): PunchType {
  const total = TYPES.reduce((s, t) => s + Math.max(0, weightOf(t, cfg)), 0);
  if (total <= 0) return 'jab';
  let r = rngFloat(rng) * total;
  for (const t of TYPES) { r -= Math.max(0, weightOf(t, cfg)); if (r < 0) return t; }
  return 'uppercut';
}
/** Farthest centre-to-centre distance it commits `t` at. */
export const engageDist = (t: PunchType, cfg: Config): number =>
  t === 'hook' ? cfg.aiHookEngageDist : t === 'uppercut' ? cfg.aiUppercutEngageDist : cfg.aiEngageDist;
/** Nearest: straights lose power inside smotherDist; hooks and uppercuts keep full power to body contact. */
export const nearDist = (t: PunchType, cfg: Config): number =>
  t === 'hook' || t === 'uppercut' ? cfg.separationDist : cfg.smotherDist;

/** Roll the next footwork mode (never reset — that is event-driven) and its duration. Circling fades with stamina. */
function rollMode(a: AiState, stamina: number, cfg: Config): void {
  const circleW = Math.max(0, cfg.aiCircleWeight) * lerp(cfg.aiTiredFootwork, 1, clamp(stamina, 0, 1));
  const weights: [AiMode, number][] = [
    ['press', Math.max(0, cfg.aiPressWeight)], ['probe', Math.max(0, cfg.aiProbeWeight)], ['circle', circleW], ['hold', Math.max(0, cfg.aiHoldWeight)],
  ];
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let mode: AiMode = 'press';
  if (total > 0) {
    let r = rngFloat(a.rng) * total;
    for (const [m, w] of weights) { r -= w; if (r < 0) { mode = m; break; } }
  }
  a.mode = mode;
  a.modeTimer = mode === 'hold' ? rngRange(a.rng, 0.3, Math.max(0.3, cfg.aiHoldMax)) : rngRange(a.rng, cfg.aiModeMin, Math.max(cfg.aiModeMin, cfg.aiModeMax));
  if (mode === 'circle') a.circleDir = rngChance(a.rng, 0.5) ? -1 : 1;
}

/**
 * Decide this tick's input from the state the sim is about to step. Pure:
 * returns a new AiState and a fresh FrameInput, touches neither argument.
 */
export function aiStep(ai: Readonly<AiState>, s: SimState, cfg: Config): { ai: AiState; input: FrameInput } {
  const a: AiState = { ...ai, rng: rngClone(ai.rng) };
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

  // Perception (2026-09-16): what it steers by is the opponent's position
  // lagged by aiReactionTime (a first-order lag, so it is one number per axis
  // and serialises), never the live coordinate. Zero = the old omniscient AI.
  // Its own position it knows exactly.
  if (cfg.aiReactionTime <= 0 || ai.dist === Infinity) {
    a.seen = { x: opp.pos.x, z: opp.pos.z };
  } else {
    const k = Math.min(1, dt / cfg.aiReactionTime);
    a.seen = { x: a.seen.x + (opp.pos.x - a.seen.x) * k, z: a.seen.z + (opp.pos.z - a.seen.z) * k };
  }
  const seenDist = v2dist(me.pos, a.seen);

  // Between rounds or on the canvas: no intent, and the timers hold.
  if (s.round.phase !== 'fighting' || me.down) return { ai: a, input };

  const punching = me.punch.type !== null;
  // Mirror of the sim's chain window: a follow-up may start this far into the recovery.
  const chainOpen = punching && me.punch.phase === 'recover' && me.punch.t >= cfg.punchChainAt * recoverOf(me.punch.type!, cfg);
  const canThrow = !punching || chainOpen;

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
  if (oppClosing > cfg.aiPressureSpeed && a.pressureCooldown === 0 && a.mode !== 'reset') {
    a.pressureCooldown = cfg.aiPressureCooldown;
    if (rngChance(a.rng, cfg.aiGiveGroundChance)) a.giveGround = cfg.aiGiveGroundTime;
    else if (a.armed === null) { a.armed = 'jab'; a.attackTimer = 0; }
  }
  // They backed off: let the space open before following (no chasing for a
  // beat). Set as the retreat BEGINS, so a long retreat is still followed
  // once the beat has passed.
  const retreating = oppClosing < -cfg.aiPressureSpeed;
  if (retreating && !a.oppRetreating) a.chaseHold = Math.max(a.chaseHold, cfg.aiChaseDelay);
  a.oppRetreating = retreating;

  // ── 0. Footwork mode ───────────────────────────────────────────────────────
  // A solid shot taken may trigger a reset, and a reset rolled at the last
  // throw starts once that punch has finished; the timer expiring rolls the
  // next mode.
  if (a.mode !== 'reset' && hurt >= cfg.aiHitResetDamage && cfg.aiHitResetDamage > 0 && rngChance(a.rng, cfg.aiHitResetChance)) {
    a.mode = 'reset'; a.modeTimer = cfg.aiResetTime; a.resetPending = false;
  }
  if (a.resetPending && !punching) { a.mode = 'reset'; a.modeTimer = cfg.aiResetTime; a.resetPending = false; }
  a.modeTimer = Math.max(0, a.modeTimer - dt);
  if (a.modeTimer === 0) rollMode(a, me.stamina, cfg);

  // ── 3. Reactive block ──────────────────────────────────────────────────────
  // A guard that is already up is neither re-rolled nor extended — a follow-up
  // inside the window is covered, one after it gets its own roll. Punching and
  // blocking are mutually exclusive (locked mechanic), for the AI too.
  // The reaction is aiReactionTime late (2026-09-16): the roll is made when
  // the punch is noticed, the guard comes up when the reaction lands — so a
  // jab is through before the hands move and a hook meets a guard, as with a
  // person. Zero = the tick after, as before.
  if (a.blockTimer > 0) a.blockTimer = Math.max(0, a.blockTimer - dt);
  if (oppStarted && a.blockReact === 0 && a.blockTimer === 0 && dist <= cfg.aiEngageDist) {
    a.blockReact = Math.max(cfg.aiReactionTime, 1e-6);
  }
  if (a.blockReact > 0) {
    a.blockReact = Math.max(0, a.blockReact - dt);
    if (a.blockReact === 0 && !punching && a.blockTimer === 0 && rngChance(a.rng, cfg.aiBlockChance)) a.blockTimer = cfg.aiBlockWindow;
  }
  input.block = a.blockTimer > 0 && !punching;

  // ── 2. Arm: the timer expiring picks the punch (and hand) — it does not throw.
  // Expired = ARMED: the timer holds at 0 and the punch waits for range rather
  // than rolling a fresh wait after the walk-in.
  const inRange = dist <= cfg.aiEngageDist;
  let aggression = 1;
  if (inRange && !opp.block) aggression *= cfg.aiAggressionMult;
  if (opp.stamina < cfg.lowStamina) aggression *= cfg.aiAggressionMult;
  a.aggression = aggression;
  a.attackTimer = Math.max(0, a.attackTimer - dt * aggression);
  if (a.attackTimer === 0 && a.armed === null) {
    a.armed = pickPunch(a.rng, cfg);
    a.armedX = rngChance(a.rng, 0.5) ? -1 : 1;
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
  const mode = a.mode;
  let standoff = mode === 'reset' ? cfg.aiResetDist : mode === 'probe' ? cfg.aiProbeDist : mode === 'circle' ? cfg.aiStandoffDist + cfg.aiStandoffBand : cfg.aiStandoffDist;
  const band = mode === 'circle' ? cfg.aiStandoffBand * 2 : cfg.aiStandoffBand;
  const stepsIn = a.armed !== null && cfg.aiStepIn > 0 && mode !== 'reset' && mode !== 'hold';
  if (stepsIn) standoff = Math.min(standoff, engageDist(a.armed!, cfg) - cfg.aiStepIn * cfg.aiStandoffBand);
  if (a.giveGround > 0) standoff += cfg.aiGiveGround;
  // Steer by the PERCEIVED distance: closing speed along the line (positive =
  // the gap is shrinking) → the distance it is heading for.
  const closing = (me.vel.x - opp.vel.x) * ux + (me.vel.z - opp.vel.z) * uz;
  const predicted = seenDist - closing * cfg.aiLookahead;
  const err = predicted - standoff;
  const fr = frameOf(me.yaw);
  const chasing = err > 0 && a.chaseHold > 0;   // they just backed off: let the space open
  if (mode !== 'hold' && !chasing && Math.abs(err) > band) {
    const mag = clamp(Math.abs(err) / (band * 2), 0, 1) * cfg.aiSpeedScale;
    const sign = err > 0 ? 1 : -1;   // +1 = close in, -1 = back off
    if (dist > 0.01) {
      input.move.y = (fr.fwd.x * ux + fr.fwd.z * uz) * sign * mag;
      input.move.x = (fr.right.x * ux + fr.right.z * uz) * sign * mag;
    } else {
      input.move.y = -mag;   // co-located: no usable direction, back straight off
    }
  }
  if (mode === 'circle') {
    // Lateral stick: the sim's x is the fighter's right, which is already
    // perpendicular to the line to the opponent (the yaw tracks it).
    input.move.x += a.circleDir * cfg.aiCircleSpeed * cfg.aiSpeedScale;
    const len = Math.hypot(input.move.x, input.move.y);
    if (len > 1) { input.move.x /= len; input.move.y /= len; }
  }

  // ── 2 + 4. Throw: only inside the armed punch's own landing band ──────────
  // (4 is the aggression drain above: the opening punish tracks an opening
  // appearing or closing mid-wait instead of being locked in at the last throw.)
  // Not while resetting: it is stepping out, not fighting. Each throw may
  // trigger a reset once it has landed or missed — the step-out after the exchange.
  // Bursts (2026-09-16): a throw may open a burst of aiComboMax punches; the
  // follow-ups are armed almost at once (aiComboGap) and chain inside the
  // sim's combo window. The reset roll waits for the burst to end — the
  // step-out comes after the exchange, not after every punch.
  if (a.armed !== null && mode !== 'reset') {
    const t = a.armed;
    const inBand = dist <= engageDist(t, cfg) && dist >= nearDist(t, cfg);
    if (inBand && canThrow && !input.block) {
      input[t] = true;   // one tick high = the rising edge the sim fires on
      if (t === 'hook' || t === 'uppercut') input.move.x = a.armedX;   // the stick at the press picks the hand
      a.armed = null;
      a.throwCount += 1;
      a.lastThrowDist = dist;
      if (a.burst === 0 && cfg.aiComboMax > 1 && rngChance(a.rng, cfg.aiComboChance)) a.burst = rngInt(a.rng, 1, Math.floor(cfg.aiComboMax) - 1);
      else if (a.burst > 0) a.burst -= 1;
      if (a.burst > 0) a.attackTimer = cfg.aiComboGap;
      else {
        a.attackTimer = rngRange(a.rng, cfg.aiAttackDelayMin, cfg.aiAttackDelayMax);
        if (rngChance(a.rng, cfg.aiResetChance)) a.resetPending = true;
      }
    }
  }

  return { ai: a, input };
}

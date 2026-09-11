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
 *   1. Standoff steer   — walks toward / away from aiStandoffDist through the
 *                         shared locomotion, with a hysteresis band (no steering
 *                         inside it) and a proportional taper into the band, so
 *                         it settles instead of hunting.
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
  NULL_INPUT, SIM_DT, clamp, cloneInput, frameOf, rngChance, rngClone, rngFloat, rngRange, seedRng, v2dist,
  type Config, type FrameInput, type PunchType, type RngState, type Side, type SimState,
} from '../core';

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
  };
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

  // Between rounds or on the canvas: no intent, and the timers hold.
  if (s.round.phase !== 'fighting' || me.down) return { ai: a, input };

  const punching = me.punch.type !== null;

  // ── 3. Reactive block ──────────────────────────────────────────────────────
  // A guard that is already up is neither re-rolled nor extended — a follow-up
  // inside the window is covered, one after it gets its own roll. Punching and
  // blocking are mutually exclusive (locked mechanic), for the AI too.
  if (a.blockTimer > 0) a.blockTimer = Math.max(0, a.blockTimer - dt);
  if (oppStarted && !punching && a.blockTimer === 0 && dist <= cfg.aiEngageDist && rngChance(a.rng, cfg.aiBlockChance)) {
    a.blockTimer = cfg.aiBlockWindow;
  }
  input.block = a.blockTimer > 0 && !punching;

  // ── 2. Arm: the timer expiring picks the punch (and hand) — it does not throw.
  // Expired = ARMED: the timer holds at 0 and the punch waits for range rather
  // than rolling a fresh wait after the walk-in.
  const inRange = dist <= cfg.aiEngageDist;
  let aggression = 1;
  if (inRange && !opp.block) aggression *= cfg.aiAggressionMult;
  if (opp.stamina < cfg.aiLowStamina) aggression *= cfg.aiAggressionMult;
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
  // punch's range (and drifts back out to the standoff once it has thrown).
  let standoff = cfg.aiStandoffDist;
  if (a.armed !== null && cfg.aiStepIn > 0) standoff = Math.min(standoff, engageDist(a.armed, cfg) - cfg.aiStepIn * cfg.aiStandoffBand);
  const err = dist - standoff;
  if (Math.abs(err) > cfg.aiStandoffBand) {
    const mag = clamp(Math.abs(err) / (cfg.aiStandoffBand * 2), 0, 1) * cfg.aiSpeedScale;
    const sign = err > 0 ? 1 : -1;   // +1 = close in, -1 = back off
    if (dist > 0.01) {
      const fr = frameOf(me.yaw);
      const ux = (opp.pos.x - me.pos.x) / dist, uz = (opp.pos.z - me.pos.z) / dist;
      input.move.y = (fr.fwd.x * ux + fr.fwd.z * uz) * sign * mag;
      input.move.x = (fr.right.x * ux + fr.right.z * uz) * sign * mag;
    } else {
      input.move.y = -mag;   // co-located: no usable direction, back straight off
    }
  }

  // ── 2 + 4. Throw: only inside the armed punch's own landing band ──────────
  // (4 is the aggression drain above: the opening punish tracks an opening
  // appearing or closing mid-wait instead of being locked in at the last throw.)
  if (a.armed !== null) {
    const t = a.armed;
    const inBand = dist <= engageDist(t, cfg) && dist >= nearDist(t, cfg);
    if (inBand && !punching && !input.block) {
      input[t] = true;   // one tick high = the rising edge the sim fires on
      if (t === 'hook' || t === 'uppercut') input.move.x = a.armedX;   // the stick at the press picks the hand
      a.armed = null;
      a.attackTimer = rngRange(a.rng, cfg.aiAttackDelayMin, cfg.aiAttackDelayMax);
      a.throwCount += 1;
      a.lastThrowDist = dist;
    }
  }

  return { ai: a, input };
}

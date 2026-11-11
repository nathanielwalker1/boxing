/**
 * sim/punches.ts — the punch table and the glove trajectory each punch draws.
 *
 * Port of the PUNCHES table in legacy/src/rig.js and punchPhases() in
 * legacy/src/config.js. Timing, impulse and reaction magnitudes come from
 * config (live sliders); the SHAPE of a punch — where the wind-up goes, the
 * path the fist takes, how much the torso turns — is authored data here,
 * exactly as v1 kept it out of config.
 *
 * Shapes are re-authored in 3D rather than converted from v1's joint angles:
 * v1 drew a side view and faked the hook's lateral sweep with elbow height.
 * What is ported is what v1 measured — phase timing, turn, the relative
 * reaches (cross ≥ hook > uppercut), where each wind-up goes (hook coils out
 * across the body, uppercut drops to the hip) — see docs/PORT_NOTES.md.
 *
 * Reach note: local poses are measured from the fighter's centre, not the
 * shoulder. The torso twist carries the punching shoulder forward, so a hook
 * peak 0.66 m out gives the rig an elbow bent ~115°, not a straight arm.
 */
import type { BodyDims, Config, FighterState, GuardShape, Hand, PunchType, Stance } from '../core';
import { GUARDS, handLateralSign, lerp, smoothstep } from '../core';
import { whiffMult } from './state';
import { shapePath, type VariantDef } from './variants';

/** `spin`: how much of the impulse (× the fist's sideways travel) becomes a yaw whip of the head and shoulders — the hook's signature (2026-09-16). */
export interface ReactShape { back: number; lift: number; twist: number; torso: number; snap: number; spin: number }

export interface PunchPhases {
  cock: number; extend: number; recover: number; total: number;
  cockEnd: number;   // progress at which the extension starts
  peakAt: number;    // progress at which the hit test runs
  hold: number;      // fraction of `recover` the fist stays at full extension before returning
}

export interface PunchDef {
  /**
   * Which hand throws it. 'input' = chosen at the press from the joystick:
   * move.x < 0 → lead, otherwise rear (CONTRACT 2026-09-02, hook/uppercut).
   */
  hand: Hand | 'input';
  /** Straight punches lose power inside smotherDist; hooks/uppercuts do not. */
  smotherable: boolean;
  /** Can this punch ROCK or FINISH a fighter (sim/stun.ts)? The jab cannot (Nate, 2026-10-15). */
  rocks: boolean;
  /** Torso twist at full extension, radians about y (legacy PUNCHES.turn; 1 = full torque). */
  turn: number;
  /**
   * Counter-rotation through the wind-up as a fraction of `turn`: the body
   * coils the other way before it comes across (a hook), 0 for a punch that
   * turns straight into it (the straights, as before).
   */
  coil: number;
  /** Forward weight transfer at full extension, as a multiple of cfg.punchLean. */
  lean: number;
  /**
   * The load (2026-09-16): through the wind-up the weight first goes BACK onto
   * the rear foot by this fraction of the punch's full lean (× cfg.punchLoad),
   * and the hips counter-turn by `coil`; the drive then comes forward off
   * that foot. The heel-hip-shoulder-fist chain starts at the ground.
   */
  load: number;
  /**
   * Lateral weight transfer at full extension, -1..1, signed toward the
   * punching hand's side: a hook drives the weight ACROSS (negative), an
   * uppercut loads over the punching hip (positive).
   */
  sway: number;
  /**
   * Body dip, m: how far the body sits down through the wind-up. It comes
   * back up through the extension to 0.4 × dip ABOVE rest at the peak (the
   * leg drive), then settles (legacy PUNCHES.dip, 6 px on the uppercut).
   */
  dip: number;
  /**
   * How much of the impulse direction comes from the fist's own travel at the
   * resolve moment rather than the attacker→defender line. 0 for straights
   * (they travel along that line anyway); ~1 for the hook, whose fist crosses
   * the face, so the head and body are sent sideways.
   */
  swing: number;
  /**
   * The fist rides the torso (2026-09-16): the path's poses are in the TORSO
   * frame — yawed by the current torso twist before use — so the body's turn
   * carries the fist and the arc of a hook IS the rotation of the shoulders.
   * Straights keep the fighter frame (their peak is on the opponent).
   */
  torsoFrame: boolean;
  /** The glove's path: guard → wind-up → peak, in the fighter's local frame (or the torso frame, see `torsoFrame`). */
  path(body: BodyDims, hand: Hand, stance: Stance, cfg: Config): PunchPath;
  phases(cfg: Config): PunchPhases;
  /** Glove-spring stiffness multiplier through the recovery (cfg.chainRecoverK, or the jab's own snap-back). */
  recoverK(cfg: Config): number;
  impulseMult(cfg: Config): number;
  /** Weight on the whiff recovery stretch (legacy `${type}WhiffScale`). */
  whiffScale(cfg: Config): number;
  react(cfg: Config): ReactShape;
}

/**
 * A punch that MISSED never holds at full extension (2026-09-16): with the
 * stretched recovery, a held whiff was a fist floating in the air for a
 * quarter of a second. It starts home at once, slowly — off balance, not
 * frozen. Reads the whiff multiplier the resolve set, so before the resolve
 * (cock, extend) the phases are untouched.
 */
export function whiffPhases(f: FighterState, ph: PunchPhases): PunchPhases {
  return whiffMult(f) > 1 ? { ...ph, hold: 0 } : ph;
}

/** The recover-phase multiplier a missed punch of this type pays: 1 + (global − 1) × weight, never under 1. */
export function whiffRecoveryMult(def: PunchDef, cfg: Config): number {
  return 1 + Math.max(0, cfg.whiffRecoveryMult - 1) * Math.max(0, def.whiffScale(cfg));
}

function phases(cock: number, extend: number, recover: number, scale: number, hold: number): PunchPhases {
  const s = Math.max(0.01, scale);
  const c = cock * s, e = extend * s, r = recover * s;
  const total = c + e + r;
  return { cock: c, extend: e, recover: r, total, cockEnd: c / total, peakAt: (c + e) / total, hold: Math.min(0.95, Math.max(0, hold)) };
}

export const PUNCHES: Record<PunchType, PunchDef> = {
  // The whip (2026-09-16): no pull-back — the fist leaves the guard on the
  // line it travels — the shortest hold of the four (jabHoldFrac), and the
  // fist is snapped home as hard as it was thrown (jabChainRecoverK). The
  // lead shoulder still drives it (turn 0.45, raised from v1's 0.15 at the
  // 2026-09-03 feel-test) and the body's turn snaps back with the fist.
  jab: {
    hand: 'lead', smotherable: true, rocks: false, torsoFrame: false, turn: 0.45, coil: 0.05, swing: 0, lean: 0.8, sway: 0, dip: 0.02, load: 0.15,
    path: (b, h, s) => straightPath(b, h, s, 0.04),
    phases: cfg => phases(cfg.jabCock, cfg.jabExtend, cfg.jabRecover, cfg.punchTimeScale, cfg.jabHoldFrac),
    recoverK: cfg => cfg.jabChainRecoverK,
    impulseMult: cfg => cfg.jabImpulseMult,
    whiffScale: cfg => cfg.jabWhiffScale,
    react: cfg => ({ back: cfg.jabReactBack, lift: cfg.jabReactLift, twist: cfg.jabReactTwist, torso: cfg.jabReactTorso, snap: cfg.jabReactSnap, spin: cfg.jabReactSpin }),
  },
  cross: {
    hand: 'rear', smotherable: true, rocks: true, torsoFrame: false, turn: 1.15, coil: 0.15, swing: 0, lean: 1.0, sway: -0.15, dip: 0.03, load: 0.5,   // turn 1.15 (was 1.0): "not enough twisting", 2026-09-16
    path: (b, h, s) => straightPath(b, h, s, 0.35),
    phases: cfg => phases(cfg.crossCock, cfg.crossExtend, cfg.crossRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    recoverK: cfg => cfg.chainRecoverK,
    impulseMult: cfg => cfg.crossImpulseMult,
    whiffScale: cfg => cfg.crossWhiffScale,
    react: cfg => ({ back: cfg.crossReactBack, lift: cfg.crossReactLift, twist: cfg.crossReactTwist, torso: cfg.crossReactTorso, snap: cfg.crossReactSnap, spin: cfg.crossReactSpin }),
  },
  // The body coils the other way while the elbow comes up into a compact L
  // (glove in front of the elbow), then the whole body turns through it: the
  // fist sweeps wide at jaw height, arm flat to the floor, and finishes past
  // the centreline with the elbow at ~90°. Turn raised from v1's 0.70 to the
  // cross's 1.0 — the hook IS the hip turn — and the weight goes across.
  hook: {
    hand: 'input', smotherable: false, rocks: true, torsoFrame: true, turn: 1.45, coil: 0.3, swing: 0.5, lean: 0.6, sway: -0.5, dip: 0.05, load: 0.4,   // swing 0.5 on the turn's tangent ≈ 45° (was 0.85 on the glove's own velocity)   // turn 1.45 (1.3 at the 2026-09-09 feel-test): the shoulders come right round, and now the fist rides them
    path: hookPath,
    phases: cfg => phases(cfg.hookCock, cfg.hookExtend, cfg.hookRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    recoverK: cfg => cfg.chainRecoverK,
    impulseMult: cfg => cfg.hookImpulseMult,
    whiffScale: cfg => cfg.hookWhiffScale,
    react: cfg => ({ back: cfg.hookReactBack, lift: cfg.hookReactLift, twist: cfg.hookReactTwist, torso: cfg.hookReactTorso, snap: cfg.hookReactSnap, spin: cfg.hookReactSpin }),
  },
  // The body sits down over the punching hip while the fist drops to it, then
  // the legs drive up and the fist rises through the chin line, finishing
  // above it with the elbow low. Shortest reach of the four (legacy: turn
  // 0.70, dip 6 px ≈ 0.07 m; 0.09 here so the sit-down reads at the play camera).
  uppercut: {
    hand: 'input', smotherable: false, rocks: true, torsoFrame: true, turn: 0.85, coil: 0.15, swing: 0, lean: 0.4, sway: 0.55, dip: 0.09, load: 0.6,   // sway 0.55 (was 0.3): the body loads and rolls hard over the punching hip (Tyson reference, 2026-09-16); turn 0.85 (was 0.7)
    path: uppercutPath,
    phases: cfg => phases(cfg.uppercutCock, cfg.uppercutExtend, cfg.uppercutRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    recoverK: cfg => cfg.chainRecoverK,
    impulseMult: cfg => cfg.uppercutImpulseMult,
    whiffScale: cfg => cfg.uppercutWhiffScale,
    react: cfg => ({ back: cfg.uppercutReactBack, lift: cfg.uppercutReactLift, twist: cfg.uppercutReactTwist, torso: cfg.uppercutReactTorso, snap: cfg.uppercutReactSnap, spin: cfg.uppercutReactSpin }),
  },
};

export function punchPhases(cfg: Config, type: PunchType): PunchPhases {
  return PUNCHES[type].phases(cfg);
}

/** The hand a punch is thrown with, given the joystick at the press. */
export function punchHand(def: PunchDef, moveX: number): Hand {
  return def.hand === 'input' ? (moveX < 0 ? 'lead' : 'rear') : def.hand;
}

// ── Local poses (forward, up, lateral) in the fighter's own frame ─────────────

export interface LocalPose { fwd: number; up: number; lat: number }

/**
 * Guard: the RELAXED stance (2026-09-16, Fight Night reference): lead glove
 * out in front at chin height, rear glove by the cheek, both a hand's width
 * outside the face so the face is visible and there is air between the
 * gloves. Elbows still hang over the ribs (Stage-1 feel-test).
 */
export function guardLocal(body: BodyDims, hand: Hand, stance: Stance, shape: GuardShape = 'high'): LocalPose {
  // Phase 2: the pose is the guard SHAPE's (core/styles.ts GUARDS). `high` is the relaxed stance described above, to the digit.
  const p = GUARDS[shape].rest[hand];
  return { fwd: body.upperArm * p.fwd, up: body.headY + body.headR * p.up, lat: handLateralSign(hand, stance) * body.shoulderW * p.lat };
}

/**
 * Block: COVERED UP — both gloves up at the brow, together in front of the
 * face (a glove's width apart), pulled in close; the rig adds the hunch, the
 * shrug and the chin tuck. Visibly a different pose from the guard.
 */
export function blockLocal(body: BodyDims, hand: Hand, stance: Stance, shape: GuardShape = 'high'): LocalPose {
  const p = GUARDS[shape].block[hand];
  return { fwd: body.upperArm * p.fwd, up: body.headY + body.headR * p.up, lat: handLateralSign(hand, stance) * body.shoulderW * p.lat };
}

/**
 * A punch's path: the wind-up pose, the peak, and (for punches that swing) a
 * point the fist passes THROUGH half-way, so the extend phase is a quadratic
 * curve instead of a line. `via: null` = straight.
 */
export interface PunchPath { cocked: LocalPose; via: LocalPose | null; peak: LocalPose }

function mix(a: LocalPose, b: LocalPose, t: number): LocalPose {
  return { fwd: lerp(a.fwd, b.fwd, t), up: lerp(a.up, b.up, t), lat: lerp(a.lat, b.lat, t) };
}

/**
 * Yaw a local pose about the fighter's vertical axis by `theta` (radians),
 * with the rig's convention (a three.js Y rotation: +theta turns forward
 * toward the fighter's left). The torso twist is applied to torso-frame
 * poses with this; authoring inverse-rotates with −theta.
 */
export function yawPose(p: LocalPose, theta: number): LocalPose {
  const c = Math.cos(theta), s = Math.sin(theta);
  return { fwd: p.fwd * c + p.lat * s, up: p.up, lat: -p.fwd * s + p.lat * c };
}

/** The torso twist (radians, signed as the sim signs it) at the peak of a punch thrown with `hand`: `side` × turn. */
function peakTwist(def: PunchDef, hand: Hand, stance: Stance): number {
  return handLateralSign(hand, stance) * def.turn;
}

/** Quadratic curve a → b that passes through `via` at t = 0.5 (the control point is derived, so `via` is a real waypoint). */
function curve(a: LocalPose, via: LocalPose, b: LocalPose, t: number): LocalPose {
  const u = 1 - t, wa = u * u, wc = 2 * u * t, wb = t * t;
  const c = { fwd: 2 * via.fwd - (a.fwd + b.fwd) / 2, up: 2 * via.up - (a.up + b.up) / 2, lat: 2 * via.lat - (a.lat + b.lat) / 2 };
  return {
    fwd: a.fwd * wa + c.fwd * wc + b.fwd * wb,
    up: a.up * wa + c.up * wc + b.up * wb,
    lat: a.lat * wa + c.lat * wc + b.lat * wb,
  };
}

/** Straight punch: a small wind-back off the guard, then full extension on the chin line, nearly centred. */
function straightPath(body: BodyDims, hand: Hand, stance: Stance, cockBack: number): PunchPath {
  const g = guardLocal(body, hand, stance);
  const reach = body.upperArm + body.forearm;
  return {
    cocked: { fwd: g.fwd - body.upperArm * cockBack, up: g.up, lat: g.lat },
    via: null,
    peak: { fwd: reach * 0.95 + body.upperArm * 0.3, up: body.headY - body.headR * 0.4, lat: g.lat * 0.3 },
  };
}

/**
 * Hook. Wind-up: a compact L — the elbow rises to the chin line out to the
 * side, the glove sits IN FRONT of the elbow (never a high-five), while the
 * body coils the other way (`coil`). Extend: the whole body turns through it
 * and the fist sweeps WIDE (through `via`: a full arm's width out on the
 * chin line, arm flat), finishing past the centreline so the last half of
 * the arc crosses the opponent's face. Everything sits on the chin line
 * (head centre − 0.7 R) so the arm reads parallel to the floor. Peak reach
 * ~0.59 m from the fighter's centre with the shoulder carried forward by
 * the full-torque twist: an elbow of ~90°. An inside punch — lands to ~0.8 m
 * centre-to-centre; `hookReachScale` (config) trades that elbow for range.
 */
function hookPath(body: BodyDims, hand: Hand, stance: Stance, cfg: Config): PunchPath {
  const side = handLateralSign(hand, stance);
  const chin = body.headY - body.headR * 0.7;
  const def = PUNCHES.hook;
  const thetaPeak = peakTwist(def, hand, stance);
  // Torso frame (2026-09-16): the COMPACT hook. The wind-up is the fist by
  // the chin with the elbow bent, on the punching side, while the body coils
  // the other way; the peak is authored where it lands in the fighter frame
  // (across the centreline, elbow ~90°, reach as measured before) and
  // inverse-rotated by the peak twist, so the fist gets there BY the turn:
  // the arc is the shoulders coming round, nothing is drawn wide.
  // Fist a hand's width in front of and below the chin (2026-09-18): at
  // fwd 0.55 / chin height the fist sat 21 cm from the shoulder and the arm
  // folded to 30° — a wing. ~25 cm gives a ~55° fold, the elbow hanging.
  const cockedF = { fwd: body.upperArm * 0.85, up: chin - body.headR * 0.5, lat: side * (body.shoulderW / 2 + body.upperArm * 0.15) };
  const peakF = { fwd: (body.upperArm + body.forearm * 0.75) * cfg.hookReachScale, up: chin, lat: -side * body.shoulderW * 0.12 };
  return {
    cocked: yawPose(cockedF, -(-def.coil) * thetaPeak),   // the body is coiled to −coil × turn when the fist sits here
    via: null,
    peak: yawPose(peakF, -thetaPeak),
  };
}

/**
 * Uppercut. Wind-up: a tight fold — the fist sits at rib height a forearm
 * IN FRONT of the shoulder line, so the upper arm hangs down and back and
 * the forearm points forward-up. (The fist must be forward of the shoulder
 * by about as much as it is below it: straight below, the elbow solver has
 * no "down" to work with and the elbow wings out sideways.) It is the body
 * that dips, not the hand. Extend: drives forward low (through `via`) and
 * rises up the centreline to the chin, elbow low and bent (~75°), glove
 * pointing up. Reach is the shortest of the four (~0.44 m out; lands inside
 * ~0.66 m centre-to-centre). `uppercutReachScale` (config) trades the elbow
 * for range.
 */
function uppercutPath(body: BodyDims, hand: Hand, stance: Stance, cfg: Config): PunchPath {
  const g = guardLocal(body, hand, stance);
  const side = handLateralSign(hand, stance);
  const torso = body.shoulderY - body.hipY;
  const def = PUNCHES.uppercut;
  const thetaPeak = peakTwist(def, hand, stance);
  // Torso frame: authored in the fighter frame at the moments they occur and
  // inverse-rotated by the twist at those moments, so the body's turn carries
  // the fist up through the chin line (the shovel).
  const cockedF = { fwd: body.upperArm * 0.6, up: body.shoulderY - torso * 0.3, lat: side * (body.shoulderW / 2 + body.gloveR * 0.3) };
  const viaF = { fwd: body.upperArm * 0.9, up: body.shoulderY - torso * 0.1, lat: g.lat * 0.9 };
  const peakF = { fwd: body.upperArm * 1.3 * cfg.uppercutReachScale, up: body.headY - body.headR * 0.2, lat: g.lat * 0.5 };
  return {
    cocked: yawPose(cockedF, def.coil * thetaPeak),
    via: yawPose(viaF, -0.85 * thetaPeak),
    peak: yawPose(peakF, -thetaPeak),
  };
}

/**
 * Where the punching glove is being pulled `elapsed` seconds into a punch:
 * guard → wind-up (cock) → peak (extend, along the path's curve if it has
 * one) → hold → guard (recover). Each phase is a smoothstep so the target
 * never jumps. The hold is the first `ph.hold` of the recover phase: the fist
 * sits at the peak so the punch is actually on screen, then snaps home in
 * what is left.
 */
export function punchLocal(body: BodyDims, stance: Stance, def: PunchDef, hand: Hand, elapsed: number, ph: PunchPhases, cfg: Config, twist = 0, variant: VariantDef | null = null, aim?: number, shape: GuardShape = 'high', reach = 1): LocalPose {
  // The fist leaves from and comes home to the fighter's own guard shape; the path between is authored once.
  const g = guardLocal(body, hand, stance, shape);
  // The variant bends the base path (overhaul): a body shot's peak is lower, an overhand loops, a compact punch is shorter.
  const path0 = variant ? shapePath(def.path(body, hand, stance, cfg), variant, cfg, aim) : def.path(body, hand, stance, cfg);
  // `reach`: the guard's jab reach (the long guard's jab is longer, the peek-a-boo's shorter).
  const path = reach === 1 ? path0 : { ...path0, peak: { ...path0.peak, fwd: path0.peak.fwd * reach } };
  // Torso-frame paths are yawed by the CURRENT twist into the fighter frame
  // before mixing with the guard, so the fist rides the turn.
  const cocked = def.torsoFrame ? yawPose(path.cocked, twist) : path.cocked;
  const via = def.torsoFrame && path.via ? yawPose(path.via, twist) : path.via;
  const peak = def.torsoFrame ? yawPose(path.peak, twist) : path.peak;
  if (elapsed < ph.cock) return mix(g, cocked, smoothstep(elapsed / ph.cock));
  if (elapsed < ph.cock + ph.extend) {
    // The target reaches the peak at chainArrive of the extend and waits
    // there, so the glove spring (which lags a fast target by a few cm) has
    // settled onto the peak by the resolve tick whatever the tick alignment.
    const t = smoothstep(Math.min(1, (elapsed - ph.cock) / (ph.extend * Math.max(0.05, cfg.chainArrive))));
    return via ? curve(cocked, via, peak, t) : mix(cocked, peak, t);
  }
  const rt = (elapsed - ph.cock - ph.extend) / ph.recover;
  const s = smoothstep(Math.max(0, (rt - ph.hold) / (1 - ph.hold)));
  // A torso-frame punch comes home IN the torso frame (2026-09-17): the fist
  // folds back toward the guard as the shoulders carry it, so the elbow bends
  // first and the arm rides the unwind. Mixed in the fighter frame, the guard
  // point sat a full arm from the turned shoulder and the hook's return was a
  // straight-armed swing out wide before it folded.
  if (def.torsoFrame) return yawPose(mix(path.peak, g, s), twist);
  return mix(peak, g, s);
}

/**
 * The whole-body envelope `elapsed` seconds into a punch, 0..1: rises
 * linearly to 1 at the resolve moment, HOLDS there through the same
 * fraction of the recovery the fist holds at full extension (the follow-
 * through: shoulders over, weight on the front foot, while the glove is on
 * the target), then unwinds with the fist. Was a triangle that started
 * unwinding the instant the fist arrived, so the body was already home
 * while the glove was still out there (2026-09-16).
 */
export function punchEnvelope(elapsed: number, ph: PunchPhases): number {
  const p = elapsed / ph.total;
  if (p < ph.peakAt) return Math.max(0, p / ph.peakAt);
  const rt = ph.recover > 0 ? (elapsed - ph.cock - ph.extend) / ph.recover : 1;
  if (rt < ph.hold) return 1;
  return Math.max(0, 1 - smoothstep((rt - ph.hold) / Math.max(1e-6, 1 - ph.hold)));
}

/**
 * Wind-up → drive shape shared by the twist and the lean: goes to −`back`
 * through the cock (the load: counter-turn, weight onto the rear foot), then
 * from −`back` to 1 through the extension (the drive), then the envelope's
 * hold and unwind. `back` = 0 is the plain envelope.
 */
function loadThenDrive(back: number, elapsed: number, ph: PunchPhases): number {
  if (back <= 0) return punchEnvelope(elapsed, ph);
  // The chain in time (2026-09-16): the load is complete at CHAIN_LOAD_AT of
  // the wind-up and the drive starts THERE — the hips and shoulders are
  // already turning into the punch through the rest of the wind-up, and the
  // fist leaves last (its target only moves in the extend). The turn reads
  // as a turn instead of a 3-frame pop, and a hook comes from the body.
  const loadEnd = ph.cock * CHAIN_LOAD_AT;
  if (elapsed < loadEnd) return -back * smoothstep(elapsed / Math.max(1e-6, loadEnd));
  if (elapsed < ph.cock + ph.extend) return lerp(-back, 1, smoothstep((elapsed - loadEnd) / Math.max(1e-6, ph.cock + ph.extend - loadEnd)));
  return punchEnvelope(elapsed, ph);
}
/** Fraction of the wind-up by which the load is complete and the drive begins. Shape, not a tunable (the phase table is). */
const CHAIN_LOAD_AT = 0.4;

/**
 * Torso twist `elapsed` seconds into a punch, as a fraction of `turn` (sign
 * applied by the caller): winds the other way through the cock (to −coil),
 * comes across through the extension, holds with the fist, unwinds.
 */
export function punchTwist(def: PunchDef, elapsed: number, ph: PunchPhases): number {
  return loadThenDrive(def.coil, elapsed, ph);
}

/**
 * Forward weight `elapsed` seconds into a punch, as a fraction of the punch's
 * full lean: BACK onto the rear foot through the cock (to −load × cfg.punchLoad),
 * forward through the drive, held, unwound. The rig reads the negative part
 * as the hips and chest rocking back and the heel staying down.
 */
export function punchLean(def: PunchDef, elapsed: number, ph: PunchPhases, cfg: Config): number {
  return loadThenDrive(def.load * cfg.punchLoad, elapsed, ph);
}

/**
 * The body dip `elapsed` seconds into a punch, m (+ = down): sits down
 * through the wind-up, drives up through the extension to 0.4 × dip above
 * rest at the peak (legacy punchKey: cock dip = dip, peak dip = -0.4 dip),
 * settles to 0 through the recovery.
 */
export function punchCrouch(def: PunchDef, elapsed: number, ph: PunchPhases, cfg: Config): number {
  const dip = def.dip * cfg.punchDipScale;
  if (elapsed < ph.cock) return dip * smoothstep(elapsed / ph.cock);
  if (elapsed < ph.cock + ph.extend) return lerp(dip, -0.4 * dip, smoothstep((elapsed - ph.cock) / ph.extend));
  const rt = (elapsed - ph.cock - ph.extend) / ph.recover;
  return lerp(-0.4 * dip, 0, smoothstep(rt));
}

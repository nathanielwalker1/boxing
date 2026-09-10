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
import type { BodyDims, Config, Hand, PunchType, Stance } from '../core';
import { handLateralSign, lerp, smoothstep } from '../core';

export interface ReactShape { back: number; lift: number; twist: number; torso: number; snap: number }

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
  /** Torso twist at full extension, radians about y (legacy PUNCHES.turn; 1 = full torque). */
  turn: number;
  /** Forward weight transfer at full extension, as a multiple of cfg.punchLean. */
  lean: number;
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
  /** The glove's path: guard → wind-up → peak, in the fighter's local frame. */
  path(body: BodyDims, hand: Hand, stance: Stance, cfg: Config): PunchPath;
  phases(cfg: Config): PunchPhases;
  impulseMult(cfg: Config): number;
  react(cfg: Config): ReactShape;
}

function phases(cock: number, extend: number, recover: number, scale: number, hold: number): PunchPhases {
  const s = Math.max(0.01, scale);
  const c = cock * s, e = extend * s, r = recover * s;
  const total = c + e + r;
  return { cock: c, extend: e, recover: r, total, cockEnd: c / total, peakAt: (c + e) / total, hold: Math.min(0.95, Math.max(0, hold)) };
}

export const PUNCHES: Record<PunchType, PunchDef> = {
  jab: {
    hand: 'lead', smotherable: true, turn: 0.45, swing: 0, lean: 0.8, sway: 0, dip: 0.02,   // turn raised from v1's 0.15: the lead shoulder drives the jab (feel-test 2026-09-03)
    path: (b, h, s) => straightPath(b, h, s, 0.15),
    phases: cfg => phases(cfg.jabCock, cfg.jabExtend, cfg.jabRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    impulseMult: cfg => cfg.jabImpulseMult,
    react: cfg => ({ back: cfg.jabReactBack, lift: cfg.jabReactLift, twist: cfg.jabReactTwist, torso: cfg.jabReactTorso, snap: cfg.jabReactSnap }),
  },
  cross: {
    hand: 'rear', smotherable: true, turn: 1.0, swing: 0, lean: 1.0, sway: -0.15, dip: 0.03,
    path: (b, h, s) => straightPath(b, h, s, 0.35),
    phases: cfg => phases(cfg.crossCock, cfg.crossExtend, cfg.crossRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    impulseMult: cfg => cfg.crossImpulseMult,
    react: cfg => ({ back: cfg.crossReactBack, lift: cfg.crossReactLift, twist: cfg.crossReactTwist, torso: cfg.crossReactTorso, snap: cfg.crossReactSnap }),
  },
  // Elbow comes up and out, then the whole body turns through it: the fist
  // sweeps wide at jaw height and finishes past the centreline with the
  // elbow at ~90°. Turn raised from v1's 0.70 to the cross's 1.0 — the hook
  // IS the hip turn — and the weight goes across to the far leg.
  hook: {
    hand: 'input', smotherable: false, turn: 1.0, swing: 0.85, lean: 0.6, sway: -0.5, dip: 0.05,
    path: hookPath,
    phases: cfg => phases(cfg.hookCock, cfg.hookExtend, cfg.hookRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    impulseMult: cfg => cfg.hookImpulseMult,
    react: cfg => ({ back: cfg.hookReactBack, lift: cfg.hookReactLift, twist: cfg.hookReactTwist, torso: cfg.hookReactTorso, snap: cfg.hookReactSnap }),
  },
  // The body sits down over the punching hip while the fist drops to it, then
  // the legs drive up and the fist rises through the chin line, finishing
  // above it with the elbow low. Shortest reach of the four (legacy: turn
  // 0.70, dip 6 px ≈ 0.07 m; 0.09 here so the sit-down reads at the play camera).
  uppercut: {
    hand: 'input', smotherable: false, turn: 0.7, swing: 0, lean: 0.4, sway: 0.3, dip: 0.09,
    path: uppercutPath,
    phases: cfg => phases(cfg.uppercutCock, cfg.uppercutExtend, cfg.uppercutRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    impulseMult: cfg => cfg.uppercutImpulseMult,
    react: cfg => ({ back: cfg.uppercutReactBack, lift: cfg.uppercutReactLift, twist: cfg.uppercutReactTwist, torso: cfg.uppercutReactTorso, snap: cfg.uppercutReactSnap }),
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
 * Guard: lead glove a little forward at chin height, rear glove by the cheek.
 * Kept close to the body so the elbows hang down over the ribs rather than
 * winging out (Stage-1 feel-test).
 */
export function guardLocal(body: BodyDims, hand: Hand, stance: Stance): LocalPose {
  const lead = hand === 'lead';
  return {
    fwd: body.upperArm * (lead ? 0.6 : 0.35),
    up: body.headY - body.headR * (lead ? 0.6 : 0.2),
    lat: handLateralSign(hand, stance) * body.shoulderW * 0.32,
  };
}

/** Block: both gloves raised to the brow and pulled in tight in front of the face. */
export function blockLocal(body: BodyDims, hand: Hand, stance: Stance): LocalPose {
  const lead = hand === 'lead';
  return {
    fwd: body.upperArm * (lead ? 0.5 : 0.4),
    up: body.headY + body.headR * 0.15,
    lat: handLateralSign(hand, stance) * body.shoulderW * 0.2,
  };
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
 * Hook: the elbow comes up and the fist coils out to its own side, sweeps
 * WIDE (through `via`: a full arm's width out at jaw height, elbow up), and
 * finishes past the centreline, so the last half of the arc crosses the
 * opponent's face. Peak reach is ~0.59 m from the fighter's centre with the
 * shoulder carried forward by the full-torque twist: an elbow of ~90°. It is
 * an inside punch — lands to ~0.8 m centre-to-centre. `hookReachScale` (config)
 * trades that elbow for range.
 */
function hookPath(body: BodyDims, hand: Hand, stance: Stance, cfg: Config): PunchPath {
  const g = guardLocal(body, hand, stance);
  const side = handLateralSign(hand, stance);
  return {
    cocked: { fwd: g.fwd - body.upperArm * 0.3, up: g.up + body.headR * 0.3, lat: g.lat + side * body.upperArm * 0.5 },
    via: { fwd: body.upperArm * 0.8, up: body.headY - body.headR * 0.35, lat: side * (body.shoulderW / 2 + body.upperArm * 0.85) },
    peak: { fwd: (body.upperArm + body.forearm * 0.75) * cfg.hookReachScale, up: body.headY - body.headR * 0.45, lat: -side * body.shoulderW * 0.12 },
  };
}

/**
 * Uppercut: the fist drops to the hip as the body sits down, drives forward
 * low (through `via`) and rises up through the chin line, finishing just
 * above it with the elbow low and bent (~75°). Reach is the shortest of the
 * four (~0.44 m out; lands inside ~0.66 m centre-to-centre): an inside punch.
 * `uppercutReachScale` (config) trades the elbow for range.
 */
function uppercutPath(body: BodyDims, hand: Hand, stance: Stance, cfg: Config): PunchPath {
  const g = guardLocal(body, hand, stance);
  const side = handLateralSign(hand, stance);
  const torso = body.shoulderY - body.hipY;
  return {
    cocked: { fwd: g.fwd * 0.6, up: body.hipY + torso * 0.35, lat: g.lat + side * body.shoulderW * 0.05 },
    via: { fwd: body.upperArm, up: body.shoulderY - torso * 0.25, lat: g.lat * 0.9 },
    peak: { fwd: body.upperArm * 1.3 * cfg.uppercutReachScale, up: body.headY + body.headR * 0.15, lat: g.lat * 0.5 },
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
export function punchLocal(body: BodyDims, stance: Stance, def: PunchDef, hand: Hand, elapsed: number, ph: PunchPhases, cfg: Config): LocalPose {
  const g = guardLocal(body, hand, stance);
  const { cocked, via, peak } = def.path(body, hand, stance, cfg);
  if (elapsed < ph.cock) return mix(g, cocked, smoothstep(elapsed / ph.cock));
  if (elapsed < ph.cock + ph.extend) {
    const t = smoothstep((elapsed - ph.cock) / ph.extend);
    return via ? curve(cocked, via, peak, t) : mix(cocked, peak, t);
  }
  const rt = (elapsed - ph.cock - ph.extend) / ph.recover;
  return mix(peak, g, smoothstep(Math.max(0, (rt - ph.hold) / (1 - ph.hold))));
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

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
  /**
   * How much of the impulse direction comes from the fist's own travel at the
   * resolve moment rather than the attacker→defender line. 0 for straights
   * (they travel along that line anyway); ~1 for the hook, whose fist crosses
   * the face, so the head and body are sent sideways.
   */
  swing: number;
  /** The glove's path: guard → wind-up → peak, in the fighter's local frame. */
  path(body: BodyDims, hand: Hand, stance: Stance): PunchPath;
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
    hand: 'lead', smotherable: true, turn: 0.45, swing: 0,   // turn raised from v1's 0.15: the lead shoulder drives the jab (feel-test 2026-09-03)
    path: (b, h, s) => straightPath(b, h, s, 0.15),
    phases: cfg => phases(cfg.jabCock, cfg.jabExtend, cfg.jabRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    impulseMult: cfg => cfg.jabImpulseMult,
    react: cfg => ({ back: cfg.jabReactBack, lift: cfg.jabReactLift, twist: cfg.jabReactTwist, torso: cfg.jabReactTorso, snap: cfg.jabReactSnap }),
  },
  cross: {
    hand: 'rear', smotherable: true, turn: 1.0, swing: 0,
    path: (b, h, s) => straightPath(b, h, s, 0.35),
    phases: cfg => phases(cfg.crossCock, cfg.crossExtend, cfg.crossRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    impulseMult: cfg => cfg.crossImpulseMult,
    react: cfg => ({ back: cfg.crossReactBack, lift: cfg.crossReactLift, twist: cfg.crossReactTwist, torso: cfg.crossReactTorso, snap: cfg.crossReactSnap }),
  },
  // Coils out and across the body, then sweeps round at jaw height with the
  // elbow up, finishing just past the centreline (legacy: turn 0.70, no dip).
  hook: {
    hand: 'input', smotherable: false, turn: 0.7, swing: 0.85,
    path: hookPath,
    phases: cfg => phases(cfg.hookCock, cfg.hookExtend, cfg.hookRecover, cfg.punchTimeScale, cfg.punchHoldFrac),
    impulseMult: cfg => cfg.hookImpulseMult,
    react: cfg => ({ back: cfg.hookReactBack, lift: cfg.hookReactLift, twist: cfg.hookReactTwist, torso: cfg.hookReactTorso, snap: cfg.hookReactSnap }),
  },
  // Drops to the hip, drives forward and up through the chin line, finishing
  // above it with the elbow low. Shortest reach of the four (legacy: turn 0.70).
  uppercut: {
    hand: 'input', smotherable: false, turn: 0.7, swing: 0,
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
 * control point the fist is pulled through on the way, so the extend phase is
 * a quadratic curve instead of a line. `via: null` = straight.
 */
export interface PunchPath { cocked: LocalPose; via: LocalPose | null; peak: LocalPose }

function mix(a: LocalPose, b: LocalPose, t: number): LocalPose {
  return { fwd: lerp(a.fwd, b.fwd, t), up: lerp(a.up, b.up, t), lat: lerp(a.lat, b.lat, t) };
}

/** Quadratic Bézier a → (via) → b. */
function curve(a: LocalPose, via: LocalPose, b: LocalPose, t: number): LocalPose {
  const u = 1 - t, wa = u * u, wv = 2 * u * t, wb = t * t;
  return {
    fwd: a.fwd * wa + via.fwd * wv + b.fwd * wb,
    up: a.up * wa + via.up * wv + b.up * wb,
    lat: a.lat * wa + via.lat * wv + b.lat * wb,
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
 * Hook: the fist coils back and out to its own side, sweeps wide (via) at
 * jaw height with the elbow up, and finishes just past the centreline, so the
 * last part of the arc crosses the opponent's face. Peak reach is ~0.66 m from
 * the fighter's centre (lands to ~0.9 m centre-to-centre, a touch inside the
 * straights): with the shoulder carried forward by the twist that is an elbow
 * of ~115°.
 */
function hookPath(body: BodyDims, hand: Hand, stance: Stance): PunchPath {
  const g = guardLocal(body, hand, stance);
  const side = handLateralSign(hand, stance);
  return {
    cocked: { fwd: g.fwd - body.upperArm * 0.25, up: g.up + body.headR * 0.1, lat: g.lat + side * body.upperArm * 0.5 },
    via: { fwd: body.upperArm, up: body.headY - body.headR * 0.4, lat: side * (body.shoulderW / 2 + body.upperArm * 0.6) },
    peak: { fwd: body.upperArm + body.forearm * 0.95, up: body.headY - body.headR * 0.5, lat: -side * body.shoulderW * 0.05 },
  };
}

/**
 * Uppercut: the fist drops to the hip, drives forward low (via) and rises up
 * through the chin line, finishing above it. Reach is the shortest of the
 * four (~0.54 m out; lands inside ~0.78 m centre-to-centre): an inside punch.
 */
function uppercutPath(body: BodyDims, hand: Hand, stance: Stance): PunchPath {
  const g = guardLocal(body, hand, stance);
  const side = handLateralSign(hand, stance);
  const torso = body.shoulderY - body.hipY;
  return {
    cocked: { fwd: g.fwd * 0.7, up: body.hipY + torso * 0.4, lat: g.lat + side * body.shoulderW * 0.05 },
    via: { fwd: body.upperArm * 1.1, up: body.shoulderY - torso * 0.15, lat: g.lat * 0.8 },
    peak: { fwd: body.upperArm * 1.6, up: body.headY + body.headR * 0.3, lat: g.lat * 0.5 },
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
export function punchLocal(body: BodyDims, stance: Stance, def: PunchDef, hand: Hand, elapsed: number, ph: PunchPhases): LocalPose {
  const g = guardLocal(body, hand, stance);
  const { cocked, via, peak } = def.path(body, hand, stance);
  if (elapsed < ph.cock) return mix(g, cocked, smoothstep(elapsed / ph.cock));
  if (elapsed < ph.cock + ph.extend) {
    const t = smoothstep((elapsed - ph.cock) / ph.extend);
    return via ? curve(cocked, via, peak, t) : mix(cocked, peak, t);
  }
  const rt = (elapsed - ph.cock - ph.extend) / ph.recover;
  return mix(peak, g, smoothstep(Math.max(0, (rt - ph.hold) / (1 - ph.hold))));
}

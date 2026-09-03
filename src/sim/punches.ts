/**
 * sim/punches.ts — the punch table and the glove trajectory each punch draws.
 *
 * Port of the PUNCHES table in legacy/src/rig.js and punchPhases() in
 * legacy/src/config.js. Timing, impulse and reaction magnitudes come from
 * config (live sliders); the SHAPE of a punch — where the wind-up goes, how
 * much the torso turns — is authored data here, exactly as v1 kept it out of
 * config. Stage 1 has two rows; hook and uppercut are two more rows in Stage 2
 * (their hand is chosen from move.x at press instead of being fixed).
 */
import type { BodyDims, Config, Hand, PunchType, Stance } from '../core';
import { handLateralSign, lerp, smoothstep } from '../core';

export interface ReactShape { back: number; lift: number; twist: number; torso: number; snap: number }

export interface PunchPhases {
  cock: number; extend: number; recover: number; total: number;
  cockEnd: number;   // progress at which the extension starts
  peakAt: number;    // progress at which the hit test runs
}

export interface PunchDef {
  /** Which hand throws it. Hook/uppercut will resolve this from input (Stage 2). */
  hand: Hand;
  /** Straight punches are smothered inside smotherDist; hooks/uppercuts are not. */
  smotherable: boolean;
  /** Torso twist at full extension, 0 = square, 1 = full torque (legacy PUNCHES.turn). */
  turn: number;
  /** Wind-back before the throw as a fraction of upperArm (legacy cockRel). */
  cockBack: number;
  phases(cfg: Config): PunchPhases;
  impulseMult(cfg: Config): number;
  react(cfg: Config): ReactShape;
}

function phases(cock: number, extend: number, recover: number, scale: number): PunchPhases {
  const s = Math.max(0.01, scale);
  const c = cock * s, e = extend * s, r = recover * s;
  const total = c + e + r;
  return { cock: c, extend: e, recover: r, total, cockEnd: c / total, peakAt: (c + e) / total };
}

export const PUNCHES: Partial<Record<PunchType, PunchDef>> = {
  jab: {
    hand: 'lead', smotherable: true, turn: 0.15, cockBack: 0.15,
    phases: cfg => phases(cfg.jabCock, cfg.jabExtend, cfg.jabRecover, cfg.punchTimeScale),
    impulseMult: cfg => cfg.jabImpulseMult,
    react: cfg => ({ back: cfg.jabReactBack, lift: cfg.jabReactLift, twist: cfg.jabReactTwist, torso: cfg.jabReactTorso, snap: cfg.jabReactSnap }),
  },
  cross: {
    hand: 'rear', smotherable: true, turn: 1.0, cockBack: 0.35,
    phases: cfg => phases(cfg.crossCock, cfg.crossExtend, cfg.crossRecover, cfg.punchTimeScale),
    impulseMult: cfg => cfg.crossImpulseMult,
    react: cfg => ({ back: cfg.crossReactBack, lift: cfg.crossReactLift, twist: cfg.crossReactTwist, torso: cfg.crossReactTorso, snap: cfg.crossReactSnap }),
  },
};

export function punchPhases(cfg: Config, type: PunchType): PunchPhases | null {
  const def = PUNCHES[type];
  return def ? def.phases(cfg) : null;
}

// ── Local poses (forward, up, lateral) in the fighter's own frame ─────────────

export interface LocalPose { fwd: number; up: number; lat: number }

/** Guard: lead glove a little forward at chin height, rear glove by the cheek. */
export function guardLocal(body: BodyDims, hand: Hand, stance: Stance): LocalPose {
  const lead = hand === 'lead';
  return {
    fwd: body.upperArm * (lead ? 0.9 : 0.45),
    up: body.headY - body.headR * (lead ? 0.6 : 0.2),
    lat: handLateralSign(hand, stance) * body.shoulderW * 0.38,
  };
}

/** Block: both gloves raised and pulled in tight in front of the face. */
export function blockLocal(body: BodyDims, hand: Hand, stance: Stance): LocalPose {
  const lead = hand === 'lead';
  return {
    fwd: body.upperArm * (lead ? 0.55 : 0.4),
    up: body.headY - body.headR * 0.1,
    lat: handLateralSign(hand, stance) * body.shoulderW * 0.22,
  };
}

/** Full extension of a straight punch: on the chin line, nearly centred. */
function peakLocal(body: BodyDims, g: LocalPose): LocalPose {
  const reach = body.upperArm + body.forearm;
  return { fwd: reach * 0.95 + body.upperArm * 0.3, up: body.headY - body.headR * 0.4, lat: g.lat * 0.3 };
}

function mix(a: LocalPose, b: LocalPose, t: number): LocalPose {
  return { fwd: lerp(a.fwd, b.fwd, t), up: lerp(a.up, b.up, t), lat: lerp(a.lat, b.lat, t) };
}

/**
 * Where the punching glove is being pulled `elapsed` seconds into a straight
 * punch: guard → wind-back (cock) → full extension (extend) → guard (recover).
 * Each phase is a smoothstep so the target never jumps.
 */
export function punchLocal(body: BodyDims, stance: Stance, def: PunchDef, hand: Hand, elapsed: number, ph: PunchPhases): LocalPose {
  const g = guardLocal(body, hand, stance);
  const cocked: LocalPose = { fwd: g.fwd - body.upperArm * def.cockBack, up: g.up, lat: g.lat };
  const peak = peakLocal(body, g);
  if (elapsed < ph.cock) return mix(g, cocked, smoothstep(elapsed / ph.cock));
  if (elapsed < ph.cock + ph.extend) return mix(cocked, peak, smoothstep((elapsed - ph.cock) / ph.extend));
  return mix(peak, g, smoothstep((elapsed - ph.cock - ph.extend) / ph.recover));
}

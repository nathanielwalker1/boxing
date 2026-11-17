/**
 * sim/grade.ts — how well a landed punch landed (overhaul 2026-11-11, brief
 * A3): GLANCING, CLEAN or FLUSH. Deterministic, from five measured things:
 *
 *   range     where in the punch's reach the target stood. Past gradeSweetHi
 *             of full reach it arrived on the end of the arm; a straight
 *             thrown inside smotherDist is cramped.
 *   square    how squarely the fist met the target: the distance from the
 *             target's centre to the punch's line (the attacker's forward
 *             axis through the fist), over the two radii. A head that had
 *             mostly slipped or ducked is clipped.
 *   timing    the punch itself: broken by a hit taken late in its flight,
 *             thrown gassed, or landing on a target going away with it.
 *   exposure  how open the target was: mid-punch or in a punish window
 *             (vuln), hurt, taken from an angle, flat-footed, caught slipping
 *             the wrong way, head coming down onto an uppercut.
 *   closing   the target walking INTO it.
 *
 * quality = min(range, square, timing): any one of them poor = GLANCING.
 * FLUSH needs quality AND an open or closing target. Everything else is CLEAN
 * — a standing punch at a sensible distance on a set target, exactly what a
 * land was before grades existed (impulse × 1).
 *
 * The grade scales impulse (combat.ts), so damage, stagger and the reaction
 * all follow, and sets the hit-stop tier. It rides on punchLand for sound,
 * camera and crowd.
 */
import type { BodyPart, Config, FighterState, HitGrade, Vec3 } from '../core';
import { clamp, lerp } from '../core';
import type { PunchDef } from './punches';
import { shapePath, type VariantDef } from './variants';
import { angleExposure } from './footing';
import { brokenMult } from './state';

export interface GradeResult { grade: HitGrade; quality: number; bonus: number; range: number; square: number; timing: number; exposure: number; closing: number }

/** Full reach of this punch as thrown, centre to centre, m: its peak + the lean's shift + the two radii − the measured slack. */
export function punchReach(a: FighterState, d: FighterState, def: PunchDef, v: VariantDef, part: BodyPart, cfg: Config): number {
  const path = shapePath(def.path(a.body, a.punch.hand, a.stance, cfg), v, cfg);
  const radial = Math.hypot(path.peak.fwd, path.peak.lat);
  const r = radial + cfg.punchLean * def.lean * cfg.punchLeanShift + (part === 'head' ? d.body.headR : d.body.bodyR) + a.body.gloveR - cfg.gradeReachSlack;
  return cfg.mocapGeo ? r * cfg.mocapRangeScale : r;   // mocapGeo: the mocap punches reach further (sim/mocap.ts)
}

export interface GradeInput {
  a: FighterState; d: FighterState; def: PunchDef; v: VariantDef; part: BodyPart;
  dist: number;
  /** The struck centre (head centre, or the nearest point on the body's axis), the fist, the attacker's unit forward axis on the floor, and whether the punch travels UP (an uppercut). */
  centre: Vec3; glove: Vec3; line: { x: number; z: number }; rising: boolean;
  /** 0..1: the target moving away along the impulse / into it, as fractions of walking speed. */
  retreat: number; closing: number;
  /** The target slipped into it. */
  wrongWay: boolean;
}

export function gradeHit(g: GradeInput, cfg: Config): GradeResult {
  const { a, d, def, v, part, dist } = g;
  // ── range
  const reach = punchReach(a, d, def, v, part, cfg);
  const q = reach > 1e-6 ? dist / reach : 1;
  let range = q <= cfg.gradeSweetHi ? 1 : clamp(1 - (q - cfg.gradeSweetHi) / Math.max(1e-6, cfg.gradeFarZero - cfg.gradeSweetHi), 0, 1);
  if (def.smotherable && dist < cfg.smotherDist) {
    const span = Math.max(1e-6, cfg.smotherDist - cfg.separationDist);
    range = Math.min(range, lerp(cfg.gradeSmotherRange, 1, clamp((dist - cfg.separationDist) / span, 0, 1)));
  }
  // ── square: how far off the punch's line the target's centre is. The line is the attacker's forward axis
  // through the fist (a hook in this sim finishes ACROSS the front of the face, so its own sideways travel says
  // nothing about how well it found the head). Sideways and vertical misses both count — except for an uppercut,
  // which travels up: only the sideways miss does.
  const cx = g.centre.x - g.glove.x, cy = g.rising ? 0 : g.centre.y - g.glove.y, cz = g.centre.z - g.glove.z;
  const along = cx * g.line.x + cz * g.line.z;
  const px = cx - along * g.line.x, pz = cz - along * g.line.z;
  const off = Math.hypot(px, cy, pz) / ((part === 'head' ? d.headBox.r : d.bodyBox.r) + a.body.gloveR);
  const square = clamp((cfg.gradeSquareZero - off) / Math.max(1e-6, cfg.gradeSquareZero - cfg.gradeSquareFull), 0, 1);
  // ── timing
  const timing = clamp(brokenMult(a), 0, 1) * (1 - cfg.gradeFatigueWeight * a.fatigue) * (1 - cfg.gradeRollWeight * g.retreat);
  // ── exposure and closing
  let exposure = Math.max(d.vuln, angleExposure(d, cfg));
  if (cfg.flatFootedOn) exposure = Math.max(exposure, cfg.gradeFlatExpose * d.flat);
  if (v.base === 'uppercut' || v.arc(cfg) > 0) exposure = Math.max(exposure, cfg.gradeLevelUppercut * Math.max(d.level, d.buckle));
  if (g.wrongWay) exposure = 1;
  const bonus = exposure + g.closing * cfg.gradeClosingWeight;
  const quality = Math.min(range, square, timing);
  const grade: HitGrade = !cfg.gradesOn ? 'clean'
    : quality < cfg.gradeGlanceBelow && !g.wrongWay ? 'glancing'   // a man who slipped INTO it never gets the glancing discount: he moved onto the fist
    : quality >= cfg.gradeFlushQuality && bonus >= cfg.gradeFlushAt ? 'flush' : 'clean';
  const out = { grade, quality, bonus, range, square, timing, exposure, closing: g.closing };
  probe.last = out;
  return out;
}

/** The last grade computed, for probes and tests (scripts/_debug.mjs, grade_test). Scratch: never read by the sim. */
export const probe: { last: GradeResult | null } = { last: null };

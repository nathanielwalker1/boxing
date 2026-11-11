/**
 * core/body.ts — one function from FighterSpec to sizes. The sim's hit spheres
 * and the rig's meshes both come from here, so they cannot disagree
 * (CONTRACT §5). Proportions are config so the rig can be tuned live.
 *
 * Build is continuous (FighterSpec.morph, overhaul 2026-11-11). With every
 * morph at 0 the numbers are the old `athletic` build; muscle −0.5 is the old
 * `lean`. The roster's `red` and `blue` are pinned to those (roster_test).
 */
import type { BodyDims, BodyMorph, FighterSpec } from './types';
import type { Config } from './config';

/** The average fighter: every morph at 0. */
export const NEUTRAL_MORPH: BodyMorph = Object.freeze({
  frame: 0, muscle: 0, bodyFat: 0, limbLength: 0, neck: 0,
  head: Object.freeze({ width: 0, jaw: 0, chin: 0, brow: 0, nose: 0, ears: 0, height: 0 }),
}) as BodyMorph;

/** A morph with any missing field filled from neutral (specs built by hand or by old data). */
export function morphOf(spec: { morph?: Partial<BodyMorph> }): BodyMorph {
  const m = spec.morph ?? {};
  return {
    frame: m.frame ?? 0, muscle: m.muscle ?? 0, bodyFat: m.bodyFat ?? 0, limbLength: m.limbLength ?? 0, neck: m.neck ?? 0,
    head: { ...NEUTRAL_MORPH.head, ...(m.head ?? {}) },
  };
}

export function bodyDims(spec: FighterSpec, cfg: Config): BodyDims {
  const h = spec.heightM;
  const m = morphOf(spec);
  const headH = h / cfg.headsTall;
  const headR = headH * 0.5;
  // The old build multiplier, now continuous. Terms that are 0 for a morph at 0 are added, so the old numbers hold exactly.
  const buildMul = 1 + m.muscle * cfg.morphMuscleGirth;
  const fat = m.bodyFat > 0 ? m.bodyFat : 0;

  const bodyR = h * cfg.bodyRadiusRatio * (buildMul + fat * cfg.morphFatGirth + m.frame * cfg.morphFrameGirth);
  const shoulderW = h * cfg.shoulderRatio * (0.5 + 0.5 * buildMul) * (1 + m.frame * cfg.morphFrameShoulder);
  const hipW = h * cfg.hipRatio * (1 + m.frame * cfg.morphFrameHip + fat * cfg.morphFatHip);

  // Legs: floor → hip. Boot is part of the shin length for reach purposes.
  const legLen = h * cfg.legRatio * (1 + m.limbLength * cfg.morphLimbLeg);
  const thigh = legLen * 0.52;
  const shin = legLen * 0.48;
  const bootH = headR * 0.6;
  const hipY = legLen;

  // Torso: hips → spine top → chest → neck → head centre.
  const torsoTop = h - headH;              // base of the head
  const neckLen = headH * 0.25 * (1 - m.neck * cfg.morphNeckLen);
  const torsoLen = torsoTop - neckLen - hipY;
  const spineLen = torsoLen * 0.45;
  const chestLen = torsoLen * 0.55;
  const shoulderY = hipY + spineLen + chestLen * 0.9;
  const headY = torsoTop + headR;

  // Arms: the spec's reach wins over the height ratio so range bands are honest.
  // reach ≈ shoulderW + 2·(upperArm + forearm + glove)
  const anatomicalFist = headR * 0.42;
  const gloveR = anatomicalFist * cfg.gloveScale;
  const armFromReach = (spec.reachM - shoulderW) / 2 - gloveR;
  const armFromHeight = h * cfg.armRatio;
  const armLen = Math.max(armFromHeight * 0.85, Math.min(armFromHeight * 1.15, armFromReach));
  const upperArm = armLen * 0.5;
  const forearm = armLen * 0.5;

  return {
    heightM: h, reachM: spec.reachM, massKg: spec.massKg,
    headR, gloveR, bodyR, shoulderW, hipW,
    neckLen, chestLen, spineLen,
    upperArm, forearm, thigh, shin, bootH,
    hipY, headY, shoulderY,
  };
}

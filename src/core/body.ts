/**
 * core/body.ts — one function from FighterSpec to sizes. The sim's hit spheres
 * and the rig's meshes both come from here, so they cannot disagree
 * (CONTRACT §5). Proportions are config so the rig can be tuned live.
 */
import type { BodyDims, FighterSpec } from './types';
import type { Config } from './config';

export function bodyDims(spec: FighterSpec, cfg: Config): BodyDims {
  const h = spec.heightM;
  const headH = h / cfg.headsTall;
  const headR = headH * 0.5;
  const buildMul = spec.build === 'lean' ? cfg.buildLean : spec.build === 'heavy' ? cfg.buildHeavy : 1;

  const bodyR = h * cfg.bodyRadiusRatio * buildMul;
  const shoulderW = h * cfg.shoulderRatio * (0.5 + 0.5 * buildMul);
  const hipW = h * cfg.hipRatio;

  // Legs: floor → hip. Boot is part of the shin length for reach purposes.
  const legLen = h * cfg.legRatio;
  const thigh = legLen * 0.52;
  const shin = legLen * 0.48;
  const bootH = headR * 0.6;
  const hipY = legLen;

  // Torso: hips → spine top → chest → neck → head centre.
  const torsoTop = h - headH;              // base of the head
  const neckLen = headH * 0.25;
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

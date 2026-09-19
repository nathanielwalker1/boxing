/**
 * core/arms.ts — the arm joints, pure. Shoulder on the twisted shoulder
 * line (reaching forward with a punch), elbow from the analytic two-bone
 * solve with the pole the rig used to choose: down at the guard, out and
 * level for a hook, back for an uppercut, flaring as the glove rises; and
 * the torso-clearance re-solve. Shared by the sim (sim/arms.ts steps the
 * pole lags and stores the joints on FighterState) and the fixtures. The
 * rig draws these joints — hit geometry is drawn geometry (2026-09-18).
 */
import type { ArmJoints, BodyDims, Hand, Stance, Vec3 } from './types';
import type { Config } from './config';
import { closestOnSegment, handLateralSign, twoBoneMid, v3dist, type Frame } from './math';

export interface ArmPose {
  /** 0..1: the elbow pole goes level (a hook). */
  level: number;
  /** 0..1: the elbow pole goes back (an uppercut's fold). */
  back: number;
  /** 0..1: elbow flare, from the glove's height above the shoulder. */
  flare: number;
}

/** The flare the geometry asks for: elbows tuck at the guard, wing out as the glove rises past the shoulder. */
export function armFlareTarget(level: number, gloveY: number, shoulderY: number, body: BodyDims, cfg: Config): number {
  return Math.max(level, Math.min(1, Math.max(0, cfg.rigElbowFlareBias + (gloveY - shoulderY) / body.upperArm)));
}

/**
 * One arm's joints. `chest` is the sim's shoulder-line centre (bodyBox.b),
 * `hips` its hip end (for the torso clearance), `twist` the torso twist,
 * `reach` how far this shoulder is carried forward out of the chest (m).
 */
export function solveArm(body: BodyDims, cfg: Config, stance: Stance, hand: Hand, chest: Vec3, hips: Vec3, fr: Frame, twist: number, reach: number, glove: Vec3, pose: ArmPose): ArmJoints {
  const side = handLateralSign(hand, stance);
  const lat = side * body.shoulderW / 2;
  // (reach, lat) yawed by the twist: +twist turns forward toward the fighter's left (yawPose convention).
  const c = Math.cos(twist), s = Math.sin(twist);
  const fwdOff = reach * c + lat * s, latOff = -reach * s + lat * c;
  const shoulder: Vec3 = {
    x: chest.x + fr.fwd.x * fwdOff + fr.right.x * latOff,
    y: chest.y,
    z: chest.z + fr.fwd.z * fwdOff + fr.right.z * latOff,
  };
  const { level, back, flare } = pose;
  const poleFwd = -cfg.rigElbowPoleBack + (-cfg.rigUppercutElbowBack + cfg.rigElbowPoleBack) * back;
  const poleOut = side * cfg.rigElbowPoleOut * (0.6 + flare * 0.6 + level * 0.8);
  const poleDown = -cfg.rigElbowPoleDown * (1 - flare * 0.8) * (1 - level);
  let pole: Vec3 = { x: fr.fwd.x * poleFwd + fr.right.x * poleOut, y: poleDown, z: fr.fwd.z * poleFwd + fr.right.z * poleOut };
  let elbow = twoBoneMid(shoulder, glove, body.upperArm, body.forearm, pole, cfg.rigArmStretchMax);
  const clearance = body.bodyR * (1 + cfg.rigForearmR) * cfg.rigElbowClearance;
  if (v3dist(closestOnSegment(hips, chest, elbow), elbow) < clearance) {
    // The forearm would enter the torso: elbow out, but hanging down so a tucked guard stays tucked.
    pole = { x: fr.right.x * side, y: -cfg.rigElbowPoleDown, z: fr.right.z * side };
    elbow = twoBoneMid(shoulder, glove, body.upperArm, body.forearm, pole, cfg.rigArmStretchMax);
  }
  return { shoulder, elbow };
}

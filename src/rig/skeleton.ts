/**
 * rig/skeleton.ts — bones, the bind pose, and the derived sizes the mesh and
 * the pose solver share (overhaul 2026-11-11).
 *
 * Bones are flat children of the rig root: the pose solver (index.ts) places
 * each one directly in the rig's local frame (+x forward, +y up, +z the
 * fighter's right). The BIND pose is the fighter standing straight with the
 * arms hanging and every bone unrotated, so a bone's inverse bind matrix is a
 * plain translation and a vertex can blend between bones.
 *
 * Bone-local conventions:
 *   limbs  : origin at the proximal joint, the bone runs down local −y.
 *            Arms: local +z is the elbow's hinge axis, +x the flexor side
 *            (biceps, the inside of the forearm). Legs: +x is the kneecap.
 *   joint helpers (elbow, knee, shoulder, spine): sit on the joint, turned
 *            half-way between the two bones they join — the skin near a joint
 *            blends upper → helper → lower, so it bends as one surface.
 *   glove  : origin at the glove centre, local +y back up the forearm, +x the thumb
 *   neck   : origin at the neck base, runs up +y (scaled to reach the head)
 *   head   : origin at the head centre, face on +x
 *   hips   : origin at the hip joint centre, +x = pelvis forward
 *   chest  : origin at the shoulder-line centre, +x = chest forward
 *   boot   : origin at the ankle, +x = toes, sole at −bootH
 *   hem    : the trunks' hem on each thigh, on a spring (cloth.ts)
 *   tail   : hair that hangs (braids, dreads, a tied tail), on a spring
 */
import * as THREE from 'three';
import { morphOf, type BodyDims, type BodyMorph, type Config, type FighterSpec } from '../core';
import type { Geo, Rect } from './geo';

export const BONE = {
  hips: 0, spine: 1, chest: 2, neck: 3, head: 4,
  shoulder0: 5, upperArm0: 6, elbow0: 7, forearm0: 8, glove0: 9,
  shoulder1: 10, upperArm1: 11, elbow1: 12, forearm1: 13, glove1: 14,
  thigh0: 15, knee0: 16, shin0: 17, boot0: 18, hem0: 19,
  thigh1: 20, knee1: 21, shin1: 22, boot1: 23, hem1: 24,
  tail: 25,
} as const;
export const BONE_COUNT = 26;

export interface ArmBones { shoulder: number; upper: number; elbow: number; fore: number; glove: number }
export interface LegBones { thigh: number; knee: number; shin: number; boot: number; hem: number }
export const armBones = (i: number): ArmBones => i === 0
  ? { shoulder: BONE.shoulder0, upper: BONE.upperArm0, elbow: BONE.elbow0, fore: BONE.forearm0, glove: BONE.glove0 }
  : { shoulder: BONE.shoulder1, upper: BONE.upperArm1, elbow: BONE.elbow1, fore: BONE.forearm1, glove: BONE.glove1 };
export const legBones = (i: number): LegBones => i === 0
  ? { thigh: BONE.thigh0, knee: BONE.knee0, shin: BONE.shin0, boot: BONE.boot0, hem: BONE.hem0 }
  : { thigh: BONE.thigh1, knee: BONE.knee1, shin: BONE.shin1, boot: BONE.boot1, hem: BONE.hem1 };

/** Derived sizes the mesh and the pose solver both need. */
export interface RigDims {
  upperArmR: number; forearmR: number; thighR: number; shinR: number; neckR: number;
  footLen: number; footW: number; chestDepth: number; waistW: number;
  /** Drawn hip joints: ± this from the centre line. */
  hipJ: number;
  /** Neck base above the shoulder line, and the bind length from there to the head centre. */
  neckBase: number; neckBind: number;
  /** Trunks hem: this far down the thigh from the hip joint. */
  trunkLen: number;
  /** Boot shaft top above the ankle. */
  shaftH: number;
}

/** Trunk length down the thigh, as a fraction of the thigh, per cut. */
const TRUNK_LEN: Record<FighterSpec['trunksStyle'], number> = { short: 0.42, classic: 0.56, long: 0.86, belt: 0.6, skirt: 0.64, split: 0.5 };
const SHAFT_H: Record<NonNullable<FighterSpec['bootHeight']>, number> = { low: 0.16, mid: 0.36, high: 0.58 };

export function rigDims(spec: FighterSpec, body: BodyDims, cfg: Config): RigDims {
  const m = morphOf(spec);
  const limb = 1 + m.muscle * cfg.rigMorphMuscleLimb + Math.max(0, m.bodyFat) * 0.1;
  const neckR = body.headR * cfg.rigNeckR * (1 + m.neck * cfg.rigMorphNeckR);
  const neckBase = body.chestLen * 0.05;
  return {
    upperArmR: body.bodyR * cfg.rigUpperArmR * limb,
    forearmR: body.bodyR * cfg.rigForearmR * limb,
    thighR: body.bodyR * cfg.rigThighR * limb,
    shinR: body.bodyR * cfg.rigShinR * limb,
    neckR,
    footLen: body.bootH * cfg.rigFootLen,
    footW: body.bootH * cfg.rigFootW,
    chestDepth: body.bodyR * cfg.rigChestDepth,
    waistW: body.shoulderW * cfg.rigWaistRatio * (1 + Math.max(0, m.bodyFat) * 0.35),
    hipJ: body.hipW / 2 * cfg.rigHipJoint,
    neckBase,
    neckBind: body.headY - body.shoulderY - neckBase,
    trunkLen: body.thigh * (spec.outfit ? 1 : TRUNK_LEN[spec.trunksStyle] ?? 0.5),
    shaftH: body.shin * (spec.outfit ? 0.12 : SHAFT_H[spec.bootHeight ?? 'mid']),
  };
}

/** Bind-pose bone origins (every bone unrotated). `lat` = the lateral sign of limb 0 (lead) and 1 (rear). */
export function bindPose(body: BodyDims, d: RigDims, lat: readonly [number, number]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < BONE_COUNT; i++) out.push(new THREE.Vector3());
  out[BONE.hips]!.set(0, body.hipY, 0);
  out[BONE.spine]!.set(0, (body.hipY + body.shoulderY) / 2, 0);
  out[BONE.chest]!.set(0, body.shoulderY, 0);
  out[BONE.neck]!.set(0, body.shoulderY + d.neckBase, 0);
  out[BONE.head]!.set(0, body.headY, 0);
  out[BONE.tail]!.set(0, body.headY, 0);
  for (let i = 0; i < 2; i++) {
    const a = armBones(i), l = legBones(i);
    const az = lat[i]! * body.shoulderW / 2, lz = lat[i]! * d.hipJ;
    out[a.shoulder]!.set(0, body.shoulderY, az);
    out[a.upper]!.set(0, body.shoulderY, az);
    out[a.elbow]!.set(0, body.shoulderY - body.upperArm, az);
    out[a.fore]!.set(0, body.shoulderY - body.upperArm, az);
    out[a.glove]!.set(0, body.shoulderY - body.upperArm - body.forearm, az);
    out[l.thigh]!.set(0, body.hipY, lz);
    out[l.knee]!.set(0, body.hipY - body.thigh, lz);
    out[l.shin]!.set(0, body.hipY - body.thigh, lz);
    out[l.boot]!.set(0, body.hipY - body.thigh - body.shin, lz);
    out[l.hem]!.set(0, body.hipY - d.trunkLen, lz);
  }
  return out;
}

/** What every part builder gets. */
export interface Ctx {
  g: Geo;
  spec: FighterSpec;
  body: BodyDims;
  d: RigDims;
  cfg: Config;
  m: BodyMorph;
  /** Lateral sign of limb 0 (lead) and 1 (rear): +1 = the fighter's right. */
  lat: readonly [number, number];
  /** Low quality tier: fewer segments. */
  low: boolean;
  bind: THREE.Vector3[];
  rect: (name: string) => Rect;
}

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
import { fk, morphOf, restPose, skelDef, skelHeadCentre, type BodyDims, type BodyMorph, type Config, type FighterSpec } from '../core';
import type { Geo, Rect } from './geo';

export const BONE = {
  hips: 0, spine: 1, chest: 2, neck: 3, head: 4,
  shoulder0: 5, upperArm0: 6, elbow0: 7, forearm0: 8, glove0: 9,
  shoulder1: 10, upperArm1: 11, elbow1: 12, forearm1: 13, glove1: 14,
  thigh0: 15, knee0: 16, shin0: 17, boot0: 18, hem0: 19,
  thigh1: 20, knee1: 21, shin1: 22, boot1: 23, hem1: 24,
  tail: 25,
  // anim Phase 1.1 (cfg.skelOn): the low thoracic joint and the clavicles of the core skeleton. Unweighted and unposed with skelOn off.
  spine2: 26, clav0: 27, clav1: 28,
} as const;
export const BONE_COUNT = 29;

/**
 * With cfg.skelOn the bones are a real HIERARCHY that mirrors core/skeleton.ts joint for joint (the parent of each
 * bone, −1 = the rig root group). Helpers ride as children: the deltoid on the clavicle at the shoulder joint, the
 * elbow and knee on the upper bone at the hinge, the hem on the thigh, the hair on the head. `spine` is the lumbar
 * joint (spine1), `chest` the chest joint, `glove` the hand, `boot` the foot.
 */
export const BONE_PARENT: readonly number[] = (() => {
  const p = new Array<number>(BONE_COUNT).fill(-1);
  p[BONE.spine] = BONE.hips; p[BONE.spine2] = BONE.spine; p[BONE.chest] = BONE.spine2;
  p[BONE.neck] = BONE.chest; p[BONE.head] = BONE.neck; p[BONE.tail] = BONE.head;
  // (armBones / legBones are declared below; the ids are spelled out so this runs at module load.)
  const arms = [[BONE.clav0, BONE.shoulder0, BONE.upperArm0, BONE.elbow0, BONE.forearm0, BONE.glove0], [BONE.clav1, BONE.shoulder1, BONE.upperArm1, BONE.elbow1, BONE.forearm1, BONE.glove1]] as const;
  const legs = [[BONE.thigh0, BONE.knee0, BONE.shin0, BONE.boot0, BONE.hem0], [BONE.thigh1, BONE.knee1, BONE.shin1, BONE.boot1, BONE.hem1]] as const;
  for (const [clav, sh, up, el, fo, gl] of arms) { p[clav] = BONE.chest; p[sh] = clav; p[up] = clav; p[el] = up; p[fo] = up; p[gl] = fo; }
  for (const [th, kn, shn, bt, hm] of legs) { p[th] = BONE.hips; p[kn] = th; p[shn] = th; p[bt] = shn; p[hm] = th; }
  return p;
})();

/** The core joint each skeleton bone draws (index = core SKJ id). */
export const JOINT_BONE: readonly number[] = [
  BONE.hips, BONE.spine, BONE.spine2, BONE.chest, BONE.neck, BONE.head,
  BONE.clav0, BONE.upperArm0, BONE.forearm0, BONE.glove0, BONE.clav1, BONE.upperArm1, BONE.forearm1, BONE.glove1,
  BONE.thigh0, BONE.shin0, BONE.boot0, BONE.thigh1, BONE.shin1, BONE.boot1,
];

/**
 * Bone ORIGINS for the skeleton hierarchy (cfg.skelOn), rig-local, every bone unrotated: the core skeleton's rest
 * FK. They differ from bindPose's reference points only where a joint moved: the spinal joints, the chest joint
 * (mid ribcage, not the shoulder line), the clavicles, and the head (its pivot on the top of the neck, not its
 * centre). The mesh is still authored around bindPose's points; the inverse binds use these.
 */
export function skelBindPose(spec: FighterSpec, body: BodyDims, d: RigDims, cfg: Config): THREE.Vector3[] {
  const def = skelDef(body, spec.stance, cfg);
  const f = fk(def, restPose(def, 0, 0, 0));
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < BONE_COUNT; i++) out.push(new THREE.Vector3());
  for (let j = 0; j < JOINT_BONE.length; j++) { const p = f.p[j]!; out[JOINT_BONE[j]!]!.set(p.x, p.y, p.z); }
  const hc = skelHeadCentre(def, f);
  out[BONE.tail]!.set(hc.x, hc.y, hc.z);
  for (let i = 0; i < 2; i++) {
    const a = armBones(i), l = legBones(i);
    out[a.shoulder]!.copy(out[a.upper]!);
    out[a.elbow]!.copy(out[a.fore]!);
    out[l.knee]!.copy(out[l.shin]!);
    out[l.hem]!.copy(out[l.thigh]!).y -= d.trunkLen;
  }
  return out;
}

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
  const limb = 1 + m.muscle * cfg.rigMorphMuscleLimb + Math.max(0, m.bodyFat) * 0.03;   // bodyR already carries the fat; more made the heavy fighter's arm a balloon
  const neckR = body.headR * cfg.rigNeckR * (1 + m.neck * cfg.rigMorphNeckR);
  const neckBase = body.chestLen * 0.05;
  return {
    // The referee's arms are an older man's: thinner than a fighter's (cfg.rigRefArm).
    upperArmR: body.bodyR * cfg.rigUpperArmR * limb * (spec.outfit ? cfg.rigRefArm : 1),
    forearmR: body.bodyR * cfg.rigForearmR * limb * (spec.outfit ? cfg.rigRefArm : 1),
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

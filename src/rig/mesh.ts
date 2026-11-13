/**
 * rig/mesh.ts — the fighter as ONE skinned mesh (overhaul 2026-11-11: the
 * capsule toy figure is retired for procedural anatomy).
 *
 * buildRigMesh assembles the parts (anatomy.ts: torso, arms, legs; head.ts:
 * skull, face, ears, hair; kit.ts: gloves, trunks, boots, the referee's
 * outfit) into one BufferGeometry with blended skin weights, morph targets
 * for the face, UVs into one painted atlas (paint.ts) and a material kind per
 * vertex. One SkinnedMesh draws the whole fighter: one draw call, plus one for
 * the shadow pass, plus one for the optional outline hull.
 *
 * Bones and the bind pose are in skeleton.ts. Sizes come from BodyDims; what
 * is not in BodyDims is a `rig` / `rig body` config key.
 */
import * as THREE from 'three';
import { morphOf, type BodyDims, type Config, type FighterSpec } from '../core';
import { Geo } from './geo';
import { BONE_COUNT, BONE_PARENT, bindPose, rigDims, skelBindPose, type Ctx, type RigDims } from './skeleton';
import { armSpan, buildArm, buildLeg, buildTorso, muscleDef, torsoShape } from './anatomy';
import { buildFacialHair, buildHair, buildHead, headShape } from './head';
import { buildBoot, buildBowTie, buildGlove, buildTrunks } from './kit';
import { atlasRect } from './atlas';
import { paintAtlas, type FighterAtlas } from './paint';

export { BONE, BONE_COUNT, rigDims, type RigDims } from './skeleton';

/** Morph targets, in order (the face state the view exposes). */
export const MORPHS = ['wince', 'mouthOpen', 'swellL', 'swellR'] as const;
/**
 * Phase 1.3 morphs, appended after MORPHS (indices 4 and 5 of morphTargetInfluences; also in morphTargetDictionary by name). They are
 * kept out of MORPHS because the rig driver (index.ts) types its face state by that list; the next worker folds them in. See LOG_MESH.md.
 */
export const MORPHS_EXTRA = ['grimace', 'slack'] as const;

/** Everything that changes the geometry or the atlas; the view rebuilds when it changes. */
export function rigGeomKey(spec: FighterSpec, body: BodyDims, cfg: Config): string {
  return [
    JSON.stringify(spec),
    body.headR, body.gloveR, body.bodyR, body.shoulderW, body.hipW, body.neckLen, body.chestLen, body.spineLen,
    body.upperArm, body.forearm, body.thigh, body.shin, body.bootH,
    cfg.rigUpperArmR, cfg.rigForearmR, cfg.rigThighR, cfg.rigShinR, cfg.rigNeckR, cfg.rigChestDepth, cfg.rigWaistRatio,
    cfg.rigGloveElongate, cfg.rigCuffLen, cfg.rigFootLen, cfg.rigFootW, cfg.rigHairColor, cfg.rigEyeColor, cfg.rigCuffColor,
    cfg.rigChestWidth, cfg.rigWaistDepth, cfg.rigPelvisWidth, cfg.rigHipJoint, cfg.rigDeltoid, cfg.rigMuscleDef, cfg.rigMorphMuscleDef,
    cfg.rigMorphMuscleLimb, cfg.rigMorphFatBelly, cfg.rigMorphNeckR, cfg.rigAoStrength, cfg.rigHandScale, cfg.rigJointBlend, cfg.rigQuality,
    // anim Phase 1.1: the skeleton changes the bones (a hierarchy) and the skin weights.
    // anim Phase 1.2 / 1.3.
    cfg.rigNeckBase, cfg.rigHipBlend, cfg.rigTrunkGap, cfg.rigRefBelly, cfg.rigRefArm, cfg.rigRefTrouser,
    cfg.skelOn, cfg.skelSpine1At, cfg.skelSpine2At, cfg.skelChestAt, cfg.skelNeckBase, cfg.skelHeadPivot, cfg.skelClavicleInset, cfg.skelSkinBlend,
  ].join('|');
}

export interface RigMesh {
  group: THREE.Group;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
  body: THREE.SkinnedMesh;
  outline: THREE.SkinnedMesh;
  dims: RigDims;
  /** The reference points the mesh is authored around (bindPose). */
  bind: THREE.Vector3[];
  /** Bone origins, rig-local, unrotated (= bind with skelOn off; the skeleton's rest FK with it on). */
  boneBind: THREE.Vector3[];
  atlas: FighterAtlas;
  triangles: number;
  /** Named runs of the geometry (torso, arm0, leg0, trunks, glove0 …) by vertex and index range. */
  parts: { name: string; v0: number; v1: number; i0: number; i1: number }[];
  specId: string;
  dispose(): void;
}

export function buildRigMesh(
  spec: FighterSpec, body: BodyDims, cfg: Config, latSign: readonly [number, number],
  material: THREE.Material, outlineMat: THREE.Material,
): RigMesh {
  const d = rigDims(spec, body, cfg);
  const low = cfg.rigQuality < 0.5 || !!spec.outfit;   // the referee is background: always the low tier
  const g = new Geo();
  const bind = bindPose(body, d, latSign);
  const c: Ctx = { g, spec, body, d, cfg, m: morphOf(spec), lat: latSign, low, bind, rect: atlasRect };

  const torso = torsoShape(c);
  g.part('torso', () => buildTorso(c, torso));
  for (let i = 0; i < 2; i++) { g.part(`arm${i}`, () => buildArm(c, i, torso)); g.part(`leg${i}`, () => buildLeg(c, i)); }
  const head = headShape(c);
  g.part('head', () => buildHead(c, head));
  g.part('hair', () => { buildHair(c, head); buildFacialHair(c, head); });
  g.part('trunks', () => buildTrunks(c, torso));
  for (let i = 0; i < 2; i++) { g.part(`glove${i}`, () => buildGlove(c, i)); g.part(`boot${i}`, () => buildBoot(c, i)); }
  if (spec.outfit) g.part('tie', () => buildBowTie(c, torso));

  const geometry = g.build([...MORPHS, ...MORPHS_EXTRA]);
  const span = armSpan(c);
  const atlas = paintAtlas(spec, cfg, low, {
    torsoV: y => 1 - (y - torso.yBottom) / (torso.yTop - torso.yBottom),
    pecY: body.shoulderY - body.chestLen * 0.3, ribsY: body.hipY + body.spineLen, neckY: body.shoulderY + body.chestLen * 0.27,
    shoulderY: body.shoulderY, hipY: body.hipY,
    elbowV: (body.upperArm - span.s0) / (span.s1 - span.s0), deltV: (body.upperArm * 0.44 - span.s0) / (span.s1 - span.s0),
    pecU: 0.07, def: muscleDef(c),
  });

  const group = new THREE.Group();
  const bones: THREE.Bone[] = [];
  const inverses: THREE.Matrix4[] = [];
  // skelOn: a real hierarchy on the core skeleton's joints (bone origins from skelBindPose; still unrotated, so the
  // inverse binds stay translations). Off: 26 flat siblings placed absolutely, as before.
  const boneBind = cfg.skelOn ? skelBindPose(spec, body, d, cfg) : bind;
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = new THREE.Bone();
    b.name = `bone${i}`;
    b.position.copy(boneBind[i]!);
    bones.push(b);
    inverses.push(new THREE.Matrix4().makeTranslation(-boneBind[i]!.x, -boneBind[i]!.y, -boneBind[i]!.z));
  }
  for (let i = 0; i < BONE_COUNT; i++) {
    const p = cfg.skelOn ? BONE_PARENT[i]! : -1;
    if (p < 0) group.add(bones[i]!);
    else { bones[p]!.add(bones[i]!); bones[i]!.position.sub(boneBind[p]!); }
  }
  const skeleton = new THREE.Skeleton(bones, inverses);

  const bodyMesh = new THREE.SkinnedMesh(geometry, material);
  bodyMesh.bind(skeleton, new THREE.Matrix4());
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.frustumCulled = false;
  group.add(bodyMesh);

  const outline = new THREE.SkinnedMesh(geometry, outlineMat);
  outline.bind(skeleton, new THREE.Matrix4());
  outline.morphTargetInfluences = bodyMesh.morphTargetInfluences;   // one face state for both
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.frustumCulled = false;
  outline.visible = cfg.outlines;
  group.add(outline);

  const built: RigMesh = {
    group, bones, skeleton, body: bodyMesh, outline, dims: d, bind, boneBind, atlas, triangles: g.triangles, parts: g.parts, specId: spec.id,
    dispose(): void {
      if (typeof window !== 'undefined' && window.__rigMeshes) { const k = window.__rigMeshes.indexOf(built); if (k >= 0) window.__rigMeshes.splice(k, 1); }
      geometry.dispose();
      skeleton.dispose();
      atlas.dispose();
      group.removeFromParent();
    },
  };
  // Test hook (scripts/clip_check.mjs): every live fighter mesh, so the check can read the skinned vertices the page is drawing.
  if (typeof window !== 'undefined') { (window.__rigMeshes = window.__rigMeshes ?? []).push(built); window.__THREE = THREE; }
  return built;
}

declare global {
  interface Window {
    /** three.js, for scripts/mesh_view.mjs (it renders a bare mesh on its own canvas). */
    __THREE?: typeof THREE;
    /** The live fighter meshes (newest last). Test hook for scripts/clip_check.mjs; nothing in the game reads it. */
    __rigMeshes?: RigMesh[];
  }
}

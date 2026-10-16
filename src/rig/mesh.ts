/**
 * rig/mesh.ts — the toy figure as ONE skinned mesh.
 *
 * Every part (capsule limbs, octagonal-prism torso, sphere head, glove
 * spheres, boot boxes, hair blocks) is authored in its bone's local frame,
 * coloured through a vertex-colour attribute, hard-weighted (weight 1) to that
 * bone, and merged into a single BufferGeometry. One SkinnedMesh draws the
 * whole fighter (one draw call, plus one for the shadow pass, plus one for the
 * optional outline hull). Bones are flat children of the rig root — the pose
 * solver in index.ts places each bone directly in the rig's local frame, so
 * bind matrices are identity and a bone's world matrix IS the part's transform.
 *
 * Bone-local conventions (rig-local frame is +x forward, +y up, +z right):
 *   limbs  : origin at the proximal joint, the bone runs down local -y
 *   glove  : origin at the glove centre, local +y points back up the forearm
 *   neck   : origin at the neck base, unit length up +y (scaled to fit)
 *   head   : origin at the head centre, face on +x
 *   hips   : origin at the hip joint centre, +x = pelvis forward
 *   chest  : origin at the shoulder-line centre, +x = chest forward
 *   boot   : origin at the ankle, +x = toes, sole at -bootH
 * Sizes come from BodyDims; anything not in BodyDims is a `rig` config key.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BodyDims, Config, FighterSpec } from '../core';

export const BONE = {
  hips: 0, chest: 1, neck: 2, head: 3,
  upperArm0: 4, forearm0: 5, glove0: 6,
  upperArm1: 7, forearm1: 8, glove1: 9,
  thigh0: 10, shin0: 11, boot0: 12,
  thigh1: 13, shin1: 14, boot1: 15,
  shoulder0: 16, shoulder1: 17,   // the deltoid balls, on the arm roots (the sim's shoulders), not the chest
} as const;
export const BONE_COUNT = 18;

/** Derived sizes the pose solver also needs (radii for clearance, boot box). */
export interface RigDims {
  upperArmR: number; forearmR: number; thighR: number; shinR: number; neckR: number;
  footLen: number; footW: number; chestDepth: number; waistW: number;
}

export function rigDims(body: BodyDims, cfg: Config): RigDims {
  return {
    upperArmR: body.bodyR * cfg.rigUpperArmR,
    forearmR: body.bodyR * cfg.rigForearmR,
    thighR: body.bodyR * cfg.rigThighR,
    shinR: body.bodyR * cfg.rigShinR,
    neckR: body.headR * cfg.rigNeckR,
    footLen: body.bootH * cfg.rigFootLen,
    footW: body.bootH * cfg.rigFootW,
    chestDepth: body.bodyR * cfg.rigChestDepth,
    waistW: Math.max(body.hipW, body.shoulderW * cfg.rigWaistRatio),
  };
}

/** Everything that changes the merged geometry; the view rebuilds when it changes. */
export function rigGeomKey(spec: FighterSpec, body: BodyDims, cfg: Config): string {
  return [
    spec.id, spec.hair, spec.facialHair, spec.trunksStyle, spec.skin, spec.trunksPrimary, spec.trunksSecondary, spec.gloves, spec.boots,
    spec.outfit ? `${spec.outfit.shirt}/${spec.outfit.trousers}/${spec.outfit.tie}` : '',
    body.headR, body.gloveR, body.bodyR, body.shoulderW, body.hipW, body.neckLen, body.chestLen, body.spineLen,
    body.upperArm, body.forearm, body.thigh, body.shin, body.bootH,
    cfg.rigUpperArmR, cfg.rigForearmR, cfg.rigThighR, cfg.rigShinR, cfg.rigNeckR, cfg.rigChestDepth, cfg.rigWaistRatio,
    cfg.rigGloveElongate, cfg.rigCuffLen, cfg.rigFootLen, cfg.rigFootW, cfg.rigHairColor, cfg.rigEyeColor, cfg.rigCuffColor,
  ].join('|');
}

export interface RigMesh {
  group: THREE.Group;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
  body: THREE.SkinnedMesh;
  outline: THREE.SkinnedMesh;
  dims: RigDims;
  triangles: number;
  dispose(): void;
}

// ── Part helpers ─────────────────────────────────────────────────────────────

const _color = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

/** Tag a primitive with colour + bone, after placing it with `m`. */
function part(geo: THREE.BufferGeometry, bone: number, colorHex: string, m: THREE.Matrix4): THREE.BufferGeometry {
  geo.applyMatrix4(m);
  const n = geo.attributes.position!.count;
  _color.set(colorHex);
  const col = new Float32Array(n * 3);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _color.r; col[i * 3 + 1] = _color.g; col[i * 3 + 2] = _color.b;
    si[i * 4] = bone;
    sw[i * 4] = 1;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  return geo;
}

function at(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}
function atRot(x: number, y: number, z: number, rx: number, ry: number, rz: number, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** A capsule from the bone origin down local -y. */
function limb(len: number, r: number): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(r, Math.max(len - 2 * r * 0.6, 0.001), 3, 10).translate(0, -len / 2, 0);
}

/** Rounded octagonal prism: unit cylinder, a flat facing forward, scaled to (depth, height, width). */
function prism(depth: number, height: number, width: number, taper = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.5 * taper, 1, 8, 1);
  g.rotateY(Math.PI / 8);
  g.scale(depth, height, width);
  return g;
}

// ── Build ────────────────────────────────────────────────────────────────────

export function buildRigMesh(
  spec: FighterSpec, body: BodyDims, cfg: Config, latSign: readonly [number, number],
  toon: THREE.Material, outlineMat: THREE.Material,
): RigMesh {
  const d = rigDims(body, cfg);
  const parts: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, bone: number, color: string, m: THREE.Matrix4 = IDENTITY): void => { parts.push(part(geo, bone, color, m)); };

  const R = body.headR;
  const skin = spec.skin, hair = cfg.rigHairColor, eye = cfg.rigEyeColor;
  // A dressed figure (the referee): the torso and upper arms take the shirt,
  // the legs the trousers, the hands are bare. Same bones, same geometry.
  const outfit = spec.outfit;
  const torsoCol = outfit ? outfit.shirt : skin;
  const legCol = outfit ? outfit.trousers : skin;

  // ── Torso ──
  const chestDepth = d.chestDepth * 2;
  const taper = Math.min(1, d.waistW / (body.shoulderW * 0.92));
  add(prism(chestDepth, body.chestLen * 1.1, body.shoulderW * 0.92, taper), BONE.chest, torsoCol, at(0, -body.chestLen * 0.45, 0));
  if (outfit) {
    // Bow tie at the collar: a knot and two wings, on the chest's front face.
    add(new THREE.BoxGeometry(R * 0.16, R * 0.22, R * 0.2), BONE.chest, outfit.tie, at(chestDepth * 0.5 + R * 0.04, -R * 0.1, 0));
    add(new THREE.BoxGeometry(R * 0.12, R * 0.3, R * 0.62), BONE.chest, outfit.tie, at(chestDepth * 0.5 + R * 0.02, -R * 0.1, 0));
  }
  // The shoulder balls ride their own bones, placed on the arm roots (2026-09-19:
  // on the chest they sat a few cm off the arm the sim now places).
  add(new THREE.SphereGeometry(d.upperArmR * 1.4, 10, 7), BONE.shoulder0, torsoCol, at(0, 0, 0));
  add(new THREE.SphereGeometry(d.upperArmR * 1.4, 10, 7), BONE.shoulder1, torsoCol, at(0, 0, 0));
  void latSign;
  add(prism(chestDepth * 0.88, body.spineLen * 0.9, d.waistW, 0.98), BONE.hips, torsoCol, at(0, body.spineLen * 0.68, 0));
  const pelvisH = body.spineLen * 0.38 + body.bodyR * 0.6;
  add(prism(chestDepth * 0.98, pelvisH, d.waistW * 1.08), BONE.hips, spec.trunksPrimary, at(0, (body.spineLen * 0.38 - body.bodyR * 0.6) / 2, 0));
  const bandH = body.bodyR * 0.32 * (spec.trunksStyle === 'belt' ? 1.9 : 1);
  add(prism(chestDepth * 1.03, bandH, d.waistW * 1.13), BONE.hips, spec.trunksSecondary, at(0, body.spineLen * 0.38 + bandH / 2 - 0.004, 0));

  // ── Neck (unit length, scaled by the bone) ──
  add(new THREE.CylinderGeometry(d.neckR, d.neckR * 1.15, 1, 8), BONE.neck, skin, at(0, 0.5, 0));

  // ── Head ──
  add(new THREE.SphereGeometry(R, 16, 12), BONE.head, skin);
  for (const s of [-1, 1]) {
    add(new THREE.SphereGeometry(R * 0.17, 7, 5), BONE.head, skin, at(-R * 0.02, R * 0.05, s * R * 0.95));   // ears
    add(new THREE.SphereGeometry(R * 0.11, 6, 5), BONE.head, eye, at(R * 0.9, R * 0.1, s * R * 0.33));      // eyes
  }
  add(new THREE.BoxGeometry(R * 0.34, R * 0.13, R * 0.92), BONE.head, eye, atRot(R * 0.82, R * 0.32, 0, 0, 0, -0.25)); // brow ridge
  add(new THREE.BoxGeometry(R * 0.22, R * 0.28, R * 0.2), BONE.head, skin, at(R * 1.0, -R * 0.1, 0));         // nose
  switch (spec.hair) {
    case 'short':
      add(new THREE.SphereGeometry(R * 1.07, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.46), BONE.head, hair, atRot(-R * 0.04, 0, 0, 0, 0, 0.22));
      break;
    case 'afro':
      add(new THREE.SphereGeometry(R * 1.35, 10, 8), BONE.head, hair, at(-R * 0.15, R * 0.2, 0));
      break;
    case 'braids':
      add(new THREE.SphereGeometry(R * 1.07, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), BONE.head, hair, atRot(-R * 0.04, 0, 0, 0, 0, 0.22));
      for (let i = 0; i < 5; i++) {
        const a = (i / 4 - 0.5) * Math.PI * 0.9;          // fan across the back of the head
        add(new THREE.CylinderGeometry(R * 0.08, R * 0.07, R * 0.9, 5), BONE.head, hair,
          atRot(-R * 0.75 * Math.cos(a), -R * 0.1, R * 0.75 * Math.sin(a), 0, 0, 0.35 * Math.cos(a)));
      }
      break;
    case 'long':
      add(new THREE.SphereGeometry(R * 1.07, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), BONE.head, hair, atRot(-R * 0.04, 0, 0, 0, 0, 0.22));
      add(new THREE.BoxGeometry(R * 0.5, R * 1.2, R * 1.15), BONE.head, hair, at(-R * 0.6, -R * 0.35, 0));
      break;
    case 'mohawk':
      add(new THREE.BoxGeometry(R * 1.3, R * 0.5, R * 0.26), BONE.head, hair, at(-R * 0.1, R * 1.0, 0));
      break;
    case 'none':
      break;
  }
  if (spec.facialHair === 'goatee' || spec.facialHair === 'beard') {
    add(new THREE.BoxGeometry(R * 0.3, R * 0.36, R * 0.42), BONE.head, hair, at(R * 0.86, -R * 0.6, 0));
  }
  if (spec.facialHair === 'beard') {
    add(new THREE.BoxGeometry(R * 0.4, R * 0.48, R * 1.08), BONE.head, hair, at(R * 0.66, -R * 0.55, 0));
  }

  // ── Arms + gloves ──
  const cuffLen = body.gloveR * cfg.rigCuffLen;
  for (let i = 0; i < 2; i++) {
    const ua = i === 0 ? BONE.upperArm0 : BONE.upperArm1;
    const fa = i === 0 ? BONE.forearm0 : BONE.forearm1;
    const gl = i === 0 ? BONE.glove0 : BONE.glove1;
    add(limb(body.upperArm, d.upperArmR), ua, torsoCol);
    add(limb(body.forearm, d.forearmR), fa, skin);
    if (outfit) {
      // A bare hand: a smaller sphere, no cuff.
      add(new THREE.SphereGeometry(body.gloveR * 0.72, 10, 8), gl, skin);
      continue;
    }
    const g = new THREE.SphereGeometry(body.gloveR, 12, 9);
    g.scale(1, cfg.rigGloveElongate, 1);
    add(g, gl, spec.gloves);
    add(new THREE.CylinderGeometry(body.gloveR * 0.7, body.gloveR * 0.76, cuffLen, 10), gl, spec.gloves, at(0, body.gloveR * 0.7 + cuffLen / 2 - 0.01, 0));
    add(new THREE.CylinderGeometry(body.gloveR * 0.8, body.gloveR * 0.8, cuffLen * 0.32, 10), gl, cfg.rigCuffColor, at(0, body.gloveR * 0.7 + cuffLen * 0.84 - 0.01, 0));
  }

  // ── Legs + boots ──
  const trunkLen = body.thigh * (outfit ? 1.0 : spec.trunksStyle === 'long' ? 0.72 : 0.46);
  for (let i = 0; i < 2; i++) {
    const th = i === 0 ? BONE.thigh0 : BONE.thigh1;
    const sh = i === 0 ? BONE.shin0 : BONE.shin1;
    const bt = i === 0 ? BONE.boot0 : BONE.boot1;
    const s = latSign[i]!;
    add(limb(body.thigh, d.thighR), th, legCol);
    add(new THREE.CylinderGeometry(d.thighR * 1.12, d.thighR * 1.06, trunkLen, 10), th, spec.trunksPrimary, at(0, -trunkLen / 2 + body.bodyR * 0.12, 0));
    if (!outfit) add(new THREE.BoxGeometry(d.thighR * 0.5, trunkLen * 0.85, d.thighR * 0.3), th, spec.trunksSecondary, at(0, -trunkLen / 2 + body.bodyR * 0.1, s * d.thighR * 1.1));
    add(limb(body.shin, d.shinR), sh, legCol);
    add(new THREE.BoxGeometry(d.footLen, body.bootH, d.footW), bt, spec.boots, at(d.footLen * 0.22, -body.bootH / 2, 0));
    add(new THREE.CylinderGeometry(d.shinR * 1.18, d.shinR * 1.3, body.bootH * 1.5, 8), bt, spec.boots, at(0, body.bootH * 0.35, 0));
  }

  const geometry = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geometry) throw new Error('rig: geometry merge failed');
  geometry.deleteAttribute('uv');

  const group = new THREE.Group();
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const b = new THREE.Bone();
    b.name = `bone${i}`;
    bones.push(b);
    group.add(b);
  }
  const skeleton = new THREE.Skeleton(bones);   // fresh bones: identity inverses

  const bodyMesh = new THREE.SkinnedMesh(geometry, toon);
  bodyMesh.bind(skeleton, new THREE.Matrix4());
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.frustumCulled = false;
  group.add(bodyMesh);

  const outline = new THREE.SkinnedMesh(geometry, outlineMat);
  outline.bind(skeleton, new THREE.Matrix4());
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.frustumCulled = false;
  outline.visible = cfg.outlines;
  group.add(outline);

  const triangles = geometry.index ? geometry.index.count / 3 : geometry.attributes.position!.count / 3;

  return {
    group, bones, skeleton, body: bodyMesh, outline, dims: d, triangles,
    dispose(): void {
      geometry.dispose();
      skeleton.dispose();
      group.removeFromParent();
    },
  };
}

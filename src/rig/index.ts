/**
 * rig/index.ts — the rig's public surface. RIG workstream owns this folder.
 *
 * createFighterView builds a procedural low-poly toy-figure boxer (mesh.ts)
 * and poses it every frame from sim state (CONTRACT §6 as amended 2026-09-02):
 *   1. pose targets — head, gloves and body capsule come straight from the sim
 *      (interpolated prev→next by alpha). Head and glove meshes are placed
 *      EXACTLY there: they are the hit spheres.
 *   2. secondary motion — springs on hips, spine, shoulder line and elbow
 *      pole only (descending stiffness up the chain, left ≠ right).
 *   3. idle life — breathing, weight shift, hip bob.
 *   4. hit reaction — torso from the sim's reaction springs; contact squash on
 *      the receiving part / attacking glove from events.
 * The whole rig lives in a local lead/rear frame (+x forward, +y up, +z the
 * fighter's right) under one root rotated by `state.yaw`. There is no mirror:
 * side 1 is side 0 turned through π.
 *
 * Test hook: window.__rig[side] exposes head/glove world positions and the
 * per-fighter draw-call / triangle counts (scripts/rig_check.mjs).
 */
import * as THREE from 'three';
import {
  angleDelta, closestOnSegment, frameOf, handLateralSign, lerp, localToWorld, smoothstep, spring1, spring3, v3dist, worldToLocal,
  type Config, type FighterSpec, type FighterState, type FighterView, type Frame, type Side, type SimEvent, type Vec2, type Vec3,
} from '../core';
import { BONE, buildRigMesh, rigGeomKey, type RigMesh } from './mesh';
import { outlineMaterial, toonMaterial, updateMaterials } from './materials';
import { solveTwoBone, type TwoBone } from './ik';
import { chase1, chase3 } from './springs';
import { Squash } from './squash';
import { FootPlanter, type FootPose } from './feet';
import { SkeletonDebug } from './debug';

export interface RigProbe {
  head(): Vec3;
  gloves(): [Vec3, Vec3];
  /** Main-pass draw calls, shadow-pass draw calls, and triangles for this fighter. */
  stats(): { calls: number; shadowCalls: number; tris: number };
}

declare global {
  interface Window { __rig?: Partial<Record<Side, RigProbe>> }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const YAXIS = new THREE.Vector3(0, 1, 0);
const ZAXIS = new THREE.Vector3(0, 0, 1);
const DEG = Math.PI / 180;
const MAX_DT = 0.1;

/** Skeleton overlay: point indices. */
const J = { hips: 0, shoulders: 1, neckBase: 2, head: 3, sh0: 4, el0: 5, gl0: 6, sh1: 7, el1: 8, gl1: 9, hp0: 10, kn0: 11, an0: 12, hp1: 13, kn1: 14, an1: 15 } as const;
const DEBUG_BONES: readonly (readonly [number, number])[] = [
  [J.hips, J.shoulders], [J.shoulders, J.neckBase], [J.neckBase, J.head],
  [J.shoulders, J.sh0], [J.sh0, J.el0], [J.el0, J.gl0],
  [J.shoulders, J.sh1], [J.sh1, J.el1], [J.el1, J.gl1],
  [J.hips, J.hp0], [J.hp0, J.kn0], [J.kn0, J.an0],
  [J.hips, J.hp1], [J.hp1, J.kn1], [J.kn1, J.an1],
];

export function createFighterView(side: Side, spec: FighterSpec, cfg: Config, parent: THREE.Object3D): FighterView {
  const root = new THREE.Group();
  root.name = `fighter${side}`;
  parent.add(root);

  const leadSign = handLateralSign('lead', spec.stance);
  const latSign: readonly [number, number] = [leadSign, -leadSign];   // index 0 = lead, 1 = rear

  const toon = toonMaterial(cfg);
  const hull = outlineMaterial(cfg);
  let rig: RigMesh | null = null;
  let geomKey = '';

  const debug = new SkeletonDebug(16, DEBUG_BONES.length, 0.018);
  root.add(debug.group);
  const dbgPts: THREE.Vector3[] = [];
  for (let i = 0; i < 16; i++) dbgPts.push(new THREE.Vector3());

  // ── Secondary-motion state (non-hitbox parts only) ──
  const hipSway = spring3();
  const spineBend = spring3();
  const shoulderYaw = spring1(leadSign * cfg.rigStanceShoulderYawDeg * DEG);
  const elbowFlare = [spring1(0), spring1(0)] as const;
  const hookLevel = [spring1(0), spring1(0)] as const;   // 1 while this arm throws a hook: the elbow pole goes level, so the arm lies flat
  const upBack = [spring1(0), spring1(0)] as const;      // 1 while this arm throws an uppercut: the elbow pole goes back, so the fist folds up by the ribs
  const hookDrive = spring1(0);   // 1 while a hook is in flight: hips, head and the punching-side foot turn harder with it
  const blockAmt = spring1(0);   // 0 = open guard, 1 = hunched into the block
  const hipYaw = spring1(0);     // hips follow a fraction of the sim's torso twist (stiffest link, so they lead)
  const feet = [new FootPlanter(), new FootPlanter()] as const;
  const squashHead = new Squash();
  const squashTorso = new Squash();
  const squashGlove = [new Squash(), new Squash()] as const;
  let tIdle = side * 1.7;   // phase offset so the two fighters never breathe in sync

  // ── Scratch ──
  const pos: Vec2 = { x: 0, z: 0 };
  let frame: Frame = frameOf(0);
  const headL = new THREE.Vector3();
  const gloveL = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const hipL = new THREE.Vector3();
  const shoulderL = new THREE.Vector3();
  const torsoOffL = new THREE.Vector3();
  const H = new THREE.Vector3();
  const S = new THREE.Vector3();
  const neckBase = new THREE.Vector3();
  const qHips = new THREE.Quaternion();
  const qChest = new THREE.Quaternion();
  const qTmp = new THREE.Quaternion();
  const qInv = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const shoulderJ = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const hipJ = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const ankle = new THREE.Vector3();
  const ik: TwoBone = { mid: new THREE.Vector3(), end: new THREE.Vector3(), stretch: 1 };
  const footDesired: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  const scl = new THREE.Vector3();
  const wp = new THREE.Vector3();

  // ── Helpers ──
  const toLocal = (p: Vec3, out: THREE.Vector3): THREE.Vector3 => {
    const l = worldToLocal(pos, frame, p);
    return out.set(l.forward, l.up, l.lateral);
  };
  const lerpLocal = (a: Vec3, b: Vec3, t: number, out: THREE.Vector3): THREE.Vector3 =>
    toLocal({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }, out);
  /** World direction → rig-local direction (rotation only). */
  const dirToLocal = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(x * frame.fwd.x + z * frame.fwd.z, y, x * frame.right.x + z * frame.right.z);
  const bone = (id: number): THREE.Bone => rig!.bones[id]!;
  /** Place a limb bone: origin at `from`, local -y toward `to`. */
  const placeLimb = (id: number, from: THREE.Vector3, to: THREE.Vector3, stretch = 1): void => {
    const b = bone(id);
    b.position.copy(from);
    v.subVectors(to, from);
    const l = v.length();
    if (l > 1e-6) v.divideScalar(l); else v.set(0, -1, 0);
    b.quaternion.setFromUnitVectors(DOWN, v);
    b.scale.set(1, stretch, 1);
  };

  const rebuild = (state: FighterState): void => {
    if (rig) { rig.dispose(); rig = null; }
    rig = buildRigMesh(spec, state.body, cfg, latSign, toon, hull);
    root.add(rig.group);
    geomKey = rigGeomKey(spec, state.body, cfg);
  };

  const probe: RigProbe = {
    head: () => { bone(BONE.head).getWorldPosition(wp); return { x: wp.x, y: wp.y, z: wp.z }; },
    gloves: () => {
      bone(BONE.glove0).getWorldPosition(wp); const a = { x: wp.x, y: wp.y, z: wp.z };
      bone(BONE.glove1).getWorldPosition(wp); const b = { x: wp.x, y: wp.y, z: wp.z };
      return [a, b];
    },
    stats: () => {
      let calls = 0, shadowCalls = 0, tris = 0;
      root.traverse(o => {
        if (!o.visible) return;
        if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.LineSegments)) return;
        // an invisible ancestor hides this too
        for (let p: THREE.Object3D | null = o.parent; p; p = p.parent) if (!p.visible) return;
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
        let t = g.index ? g.index.count / 3 : g.attributes.position!.count / 3;
        if (o instanceof THREE.InstancedMesh) t *= o.count;
        if (o instanceof THREE.LineSegments) t = 0;
        calls++;
        tris += t;
        if ((o as THREE.Mesh).castShadow) shadowCalls++;
      });
      return { calls, shadowCalls, tris };
    },
  };
  window.__rig = window.__rig ?? {};
  window.__rig[side] = probe;

  // ── Events → squash ──
  const onEvents = (events: readonly SimEvent[], body: FighterState['body']): void => {
    for (const e of events) {
      if (e.type === 'punchLand' && e.target === side) fireBodySquash(e.part, e.impulse);
      else if (e.type === 'hurt' && e.side === side) fireBodySquash(e.part, e.impulse);
      else if (e.type === 'punchLand' && e.side === side) {
        // attacker: squash the glove along the forearm (bone-local y)
        squashGlove[e.hand === 'lead' ? 0 : 1]!.fire(YAXIS, cfg.rigGloveSquashAmount, cfg.rigGloveSquashDur);
      }
    }
    void body;
  };
  const fireBodySquash = (part: 'head' | 'body', impulse: Vec3): void => {
    dirToLocal(impulse.x, impulse.y, impulse.z, v);
    if (v.lengthSq() < 1e-10) v.set(-1, 0, 0);
    const target = part === 'head' ? squashHead : squashTorso;
    const q = part === 'head' ? bone(BONE.head).quaternion : qChest;
    qInv.copy(q).invert();
    v.applyQuaternion(qInv);
    target.fire(v, cfg.rigSquashAmount, cfg.rigSquashDur);
  };

  // ── Per frame ──
  function apply(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[]): void {
    dt = dt > MAX_DT ? MAX_DT : dt < 0 ? 0 : dt;
    const c = cfg;
    const body = next.body;
    if (!rig || rigGeomKey(spec, body, c) !== geomKey) rebuild(next);
    const r = rig!;
    const d = r.dims;

    // 1. Pose targets from the sim, interpolated.
    pos.x = lerp(prev.pos.x, next.pos.x, alpha);
    pos.z = lerp(prev.pos.z, next.pos.z, alpha);
    const yaw = prev.yaw + angleDelta(prev.yaw, next.yaw) * alpha;
    frame = frameOf(yaw);
    root.position.set(pos.x, 0, pos.z);
    root.rotation.set(0, -yaw, 0);
    lerpLocal(prev.headBox, next.headBox, alpha, headL);
    lerpLocal(prev.gloves[0].pos, next.gloves[0].pos, alpha, gloveL[0]);
    lerpLocal(prev.gloves[1].pos, next.gloves[1].pos, alpha, gloveL[1]);
    lerpLocal(prev.bodyBox.a, next.bodyBox.a, alpha, hipL);
    lerpLocal(prev.bodyBox.b, next.bodyBox.b, alpha, shoulderL);
    dirToLocal(
      lerp(prev.reaction.torso.x, next.reaction.torso.x, alpha),
      lerp(prev.reaction.torso.y, next.reaction.torso.y, alpha),
      lerp(prev.reaction.torso.z, next.reaction.torso.z, alpha), torsoOffL);
    const tilt = lerp(prev.reaction.tilt.x, next.reaction.tilt.x, alpha);
    const leanF = lerp(prev.lean.fwd, next.lean.fwd, alpha);
    const leanL = lerp(prev.lean.lat, next.lean.lat, alpha);
    const twist = lerp(prev.torsoTwist, next.torsoTwist, alpha);
    // Block hunch: chest pitch + shoulder shrug, chased so it eases in and out.
    // Non-hitbox only — the sim's head sphere is untouched.
    const blk = chase1(blockAmt, next.block ? 1 : 0, c.rigSpineK, c.rigSpineZeta, dt);
    // Whole-body drive on a punch: hips turn with the twist (hip spring, so
    // they arrive before the shoulders), the feet pivot with the hips, and the
    // rear heel comes up. All non-hitbox.
    // A hook is the whole body turning: hips, head and the punching-side
    // foot follow the twist harder than on a straight (rigHookDrive).
    const hookAmt = chase1(hookDrive, next.punch.type === 'hook' ? 1 : 0, c.rigHipK, c.rigHipZeta, dt);
    const drive = 1 + hookAmt * (c.rigHookDrive - 1);
    const hipYawS = chase1(hipYaw, twist * c.rigPunchHipFollow * drive, c.rigHipK, c.rigHipZeta, dt);

    onEvents(events, body);

    // 3. Idle life.
    tIdle += dt;
    const breath = Math.sin(tIdle * c.rigBreathHz * Math.PI * 2);
    const sway = Math.sin(tIdle * c.rigSwayHz * Math.PI * 2 + side * 2.1);
    const bob = Math.sin(tIdle * c.rigSwayHz * Math.PI * 4 + 0.7) * c.rigBobAmp;

    // 2. Secondary motion — springs, hips stiffest → elbows loosest.
    chase3(hipSway, leanF * c.rigLeanHip, bob, leanL * c.rigLeanLat + sway * c.rigSwayAmp, c.rigHipK, c.rigHipZeta, dt);
    chase3(spineBend, leanF * c.rigLeanChest, 0, sway * c.rigSwayAmp * 0.5, c.rigSpineK, c.rigSpineZeta, dt);
    const yawS = chase1(shoulderYaw, leadSign * c.rigStanceShoulderYawDeg * DEG + twist, c.rigShoulderK, c.rigShoulderZeta, dt);

    // Hips.
    H.copy(hipL).add(hipSway as unknown as THREE.Vector3Like);
    qHips.setFromAxisAngle(YAXIS, leadSign * c.rigStanceHipYawDeg * DEG + hipYawS);
    const bHips = bone(BONE.hips);
    bHips.position.copy(H);
    bHips.quaternion.copy(qHips);
    bHips.scale.set(1, 1, 1);

    // Chest: on the capsule top + sim torso reaction + spine spring, yawed by the
    // shoulder line, pitched by lean and the sim's tilt (positive = leaning back).
    S.copy(shoulderL).add(torsoOffL).add(spineBend as unknown as THREE.Vector3Like);
    qChest.setFromAxisAngle(YAXIS, yawS);
    qTmp.setFromAxisAngle(ZAXIS, tilt - (leanF * c.rigLeanTiltDeg + blk * c.rigBlockTiltDeg) * DEG);
    qChest.multiply(qTmp);
    const bChest = bone(BONE.chest);
    bChest.position.copy(S);
    bChest.quaternion.copy(qChest);
    scl.set(1 + breath * c.rigBreathAmp, 1, 1 + breath * c.rigBreathAmp * 0.5);
    squashTorso.step(dt);
    squashTorso.applyTo(scl);
    bChest.scale.copy(scl);

    // Shoulder joints and neck base ride on the chest.
    const shrug = blk * c.rigBlockShrug;
    for (let i = 0; i < 2; i++) {
      shoulderJ[i]!.set(0, shrug, latSign[i]! * body.shoulderW / 2).applyQuaternion(qChest).add(S);
    }
    neckBase.set(0, body.chestLen * 0.05 + shrug, 0).applyQuaternion(qChest).add(S);
    const bNeck = bone(BONE.neck);
    bNeck.position.copy(neckBase);
    v.subVectors(headL, neckBase);
    const neckLen = v.length();
    if (neckLen > 1e-6) v.divideScalar(neckLen); else v.set(0, 1, 0);
    bNeck.quaternion.setFromUnitVectors(UP, v);
    bNeck.scale.set(1, Math.max(0.01, neckLen + body.headR * 0.3), 1);

    // Head: exactly on the sim's head sphere.
    const bHead = bone(BONE.head);
    bHead.position.copy(headL);
    bHead.quaternion.setFromAxisAngle(YAXIS, yawS * Math.min(1, c.rigHeadFollow * drive));
    qTmp.setFromAxisAngle(ZAXIS, tilt * 0.5);
    bHead.quaternion.multiply(qTmp);
    scl.set(1, 1, 1);
    squashHead.step(dt);
    squashHead.applyTo(scl);
    bHead.scale.copy(scl);

    // Arms: 2-bone IK from the shoulder to the glove centre. The elbow pole
    // blends down (guard, straight punches) → out/up (hooks) through a spring.
    const clearance = (body.bodyR + d.forearmR) * c.rigElbowClearance;
    for (let i = 0; i < 2; i++) {
      const sh = shoulderJ[i]!, gl = gloveL[i]!;
      // A hooking arm lies flat: elbow up to the glove line, pole level, so the
      // forearm is parallel to the floor and the glove leads the elbow.
      const mine = (next.punch.hand === 'lead') === (i === 0);
      const hooking = next.punch.type === 'hook' && mine ? c.rigHookElbowLevel : 0;
      // An uppercutting arm folds with the elbow BEHIND the fist (the guard's
      // pole points the elbow forward, which would aim the forearm back at
      // the body when the fist is low by the ribs).
      const uppercutting = next.punch.type === 'uppercut' && mine ? 1 : 0;
      const kMul = i === 1 ? 1 + c.rigTwinSkew : 1;
      const level = chase1(hookLevel[i]!, hooking, c.rigElbowK * kMul * 2, c.rigElbowZeta, dt);
      const back = chase1(upBack[i]!, uppercutting, c.rigElbowK * kMul * 2, c.rigElbowZeta, dt);
      const flareTarget = Math.max(level, Math.min(1, Math.max(0, c.rigElbowFlareBias + (gl.y - sh.y) / body.upperArm)));
      const flare = chase1(elbowFlare[i]!, flareTarget, c.rigElbowK * kMul, c.rigElbowZeta, dt);
      v2.set(0, 0, latSign[i]!).applyQuaternion(qChest);   // outward, in the chest's frame
      const poleFwd = lerp(-c.rigElbowPoleBack, -c.rigUppercutElbowBack, back);
      pole.set(poleFwd, -c.rigElbowPoleDown * (1 - flare * 0.8) * (1 - level), 0)
        .addScaledVector(v2, c.rigElbowPoleOut * (0.6 + flare * 0.6 + level * 0.8));
      solveTwoBone(sh, gl, body.upperArm, body.forearm, pole, c.rigArmStretchMax, ik);
      if (v3dist(closestOnSegment(H, S, ik.mid), ik.mid) < clearance) {
        // Forearm would enter the torso: push the elbow out, but keep it hanging
        // down so a tucked guard reads as tucked, not as a chicken wing.
        pole.copy(v2).addScaledVector(DOWN, c.rigElbowPoleDown);
        solveTwoBone(sh, gl, body.upperArm, body.forearm, pole, c.rigArmStretchMax, ik);
      }
      placeLimb(i === 0 ? BONE.upperArm0 : BONE.upperArm1, sh, ik.mid);
      placeLimb(i === 0 ? BONE.forearm0 : BONE.forearm1, ik.mid, gl, ik.stretch);
      const bGlove = bone(i === 0 ? BONE.glove0 : BONE.glove1);
      bGlove.position.copy(gl);                             // exact
      bGlove.quaternion.copy(bone(i === 0 ? BONE.forearm0 : BONE.forearm1).quaternion);
      scl.set(1, 1, 1);
      squashGlove[i]!.step(dt);
      squashGlove[i]!.applyTo(scl);
      bGlove.scale.copy(scl);
    }

    // Legs: feet planted in world space, stepped when the body walks away.
    const moving = Math.hypot(next.vel.x, next.vel.z) > 1e-3;
    for (let i = 0; i < 2; i++) {
      const s = latSign[i]!;
      const restFwd = i === 0 ? c.rigStanceFwd : -c.rigStanceBack;
      const restLat = s * c.rigStanceLat;
      const footYawLocal = leadSign * (i === 0 ? c.rigLeadFootYawDeg : c.rigRearFootYawDeg) * DEG;
      const w = localToWorld(pos, frame, restFwd + hipSway.x, 0, restLat);
      footDesired.x = w.x + (moving ? next.vel.x * c.rigStepLead : 0);
      footDesired.z = w.z + (moving ? next.vel.z * c.rigStepLead : 0);
      footDesired.y = 0;
      footDesired.rotY = -yaw + footYawLocal;
      const fp = feet[i]!.update(footDesired, dt, c, feet[1 - i]!);
      toLocal({ x: fp.x, y: fp.y, z: fp.z }, ankle);
      // Rear heel lifts with the torso twist; the boot pitches about the ankle so the toe stays down.
      const lift = i === 1 ? c.rigPunchHeelLift * Math.min(1, Math.abs(twist)) : 0;
      ankle.y += body.bootH + lift;
      // The foot under the punching hand of a hook pivots like the rear foot
      // on a cross (toe turns in, heel out); otherwise lead/rear as authored.
      const hookFoot = hookAmt * ((next.punch.hand === 'lead') === (i === 0) ? 1 : 0);
      const pivot = i === 0 ? lerp(c.rigPunchLeadFootPivot, c.rigPunchFootPivot, hookFoot) : c.rigPunchFootPivot;
      const yawL = fp.rotY + yaw + hipYawS * pivot;

      hipJ[i]!.set(0, 0, s * body.hipW / 2).applyQuaternion(qHips).add(H);
      // No hyperextension: pull the ankle in horizontally, then up if it must.
      const maxD = c.rigKneeMax * (body.thigh + body.shin);
      v.subVectors(ankle, hipJ[i]!);
      const horiz = Math.hypot(v.x, v.z);
      const dist = v.length();
      if (dist > maxD) {
        const h2 = maxD * maxD - v.y * v.y;
        if (h2 > 0 && horiz > 1e-6) {
          const k = Math.sqrt(h2) / horiz;
          ankle.x = hipJ[i]!.x + v.x * k;
          ankle.z = hipJ[i]!.z + v.z * k;
        } else {
          ankle.x = hipJ[i]!.x; ankle.z = hipJ[i]!.z; ankle.y = hipJ[i]!.y - maxD;
        }
      }
      pole.set(c.rigKneePoleFwd * Math.cos(yawL), 0, -c.rigKneePoleFwd * Math.sin(yawL)).addScaledVector(ZAXIS, s * c.rigKneePoleOut);
      solveTwoBone(hipJ[i]!, ankle, body.thigh, body.shin, pole, 1, ik);
      placeLimb(i === 0 ? BONE.thigh0 : BONE.thigh1, hipJ[i]!, ik.mid);
      placeLimb(i === 0 ? BONE.shin0 : BONE.shin1, ik.mid, ankle);
      const bBoot = bone(i === 0 ? BONE.boot0 : BONE.boot1);
      bBoot.position.copy(ankle);
      bBoot.quaternion.setFromAxisAngle(YAXIS, yawL);
      if (lift > 0) bBoot.quaternion.multiply(qTmp.setFromAxisAngle(ZAXIS, -Math.asin(Math.min(1, lift / (d.footLen * 0.72)))));
      bBoot.scale.set(1, 1, 1);
      if (i === 0) { dbgPts[J.hp0]!.copy(hipJ[0]!); dbgPts[J.kn0]!.copy(ik.mid); dbgPts[J.an0]!.copy(ankle); }
      else { dbgPts[J.hp1]!.copy(hipJ[1]!); dbgPts[J.kn1]!.copy(ik.mid); dbgPts[J.an1]!.copy(ankle); }
    }

    // Debug overlay.
    debug.visible = c.debugSkeleton;
    if (c.debugSkeleton) {
      dbgPts[J.hips]!.copy(H); dbgPts[J.shoulders]!.copy(S); dbgPts[J.neckBase]!.copy(neckBase); dbgPts[J.head]!.copy(headL);
      dbgPts[J.sh0]!.copy(shoulderJ[0]!); dbgPts[J.el0]!.copy(bone(BONE.forearm0).position); dbgPts[J.gl0]!.copy(gloveL[0]);
      dbgPts[J.sh1]!.copy(shoulderJ[1]!); dbgPts[J.el1]!.copy(bone(BONE.forearm1).position); dbgPts[J.gl1]!.copy(gloveL[1]);
      debug.update(dbgPts, DEBUG_BONES);
    }

    // Materials + outline toggle (live).
    updateMaterials(c);
    r.outline.visible = c.outlines;

    root.updateMatrixWorld(true);
    void smoothstep;
  }

  return {
    side,
    apply,
    dispose(): void {
      if (rig) { rig.dispose(); rig = null; }
      debug.dispose();
      root.removeFromParent();
      if (window.__rig) delete window.__rig[side];
    },
  };
}

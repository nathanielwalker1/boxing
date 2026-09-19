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
  type Config, type FighterSpec, type FighterState, type FighterView, type Frame, type PunchType, type Side, type SimEvent, type Vec2, type Vec3,
} from '../core';
import { BONE, buildRigMesh, rigGeomKey, type RigMesh } from './mesh';
import { outlineMaterial, toonMaterial, updateMaterials } from './materials';
import { solveTwoBone, type TwoBone } from './ik';
import { chase1, chase3 } from './springs';
import { Squash } from './squash';
import { FootPlanter, stepRoles, type FootPose, type StepStyle } from './feet';
import { SkeletonDebug } from './debug';

export interface RigProbe {
  head(): Vec3;
  gloves(): [Vec3, Vec3];
  /** Main-pass draw calls, shadow-pass draw calls, and triangles for this fighter. */
  stats(): { calls: number; shadowCalls: number; tris: number };
  /** Step phase per foot (0..1, 1 = planted), index 0 = lead foot. */
  feet(): [number, number];
  /** Shoulder / elbow / glove joints per arm (index 0 = lead) and whether the torso-clearance re-solve fired this frame (probes). */
  arms(): [{ shoulder: Vec3; elbow: Vec3; glove: Vec3; cleared: boolean }, { shoulder: Vec3; elbow: Vec3; glove: Vec3; cleared: boolean }];
}

declare global {
  interface Window { __rig?: Partial<Record<Side, RigProbe>> }
}

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);
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
  const moveLean = spring3();    // walking: velocity in the rig frame as a fraction of moveSpeed (x forward, z lateral), lagged so the body leans in after the feet push
  const rhythmGate = spring1(1); // 1 = the idle bounce is on; eases to 0 while punching / blocking / down
  // ── Knockdown ──
  // The fall is a timeline on the sim's downT, shaped by the finishing punch:
  // its impulse direction (captured rig-local from the punchLand that came
  // with the knockdown event) is the fall line, its type picks the lead-in.
  // fallAmt is 1 while down and eases to 0 over rigGetUpTime after the get-up.
  const fallAmt = spring1(0);
  const fallDir = new THREE.Vector3(-1, 0, 0);
  const fallAxis = new THREE.Vector3(0, 0, 1);
  let fallType: PunchType = 'cross';
  let lastHit: { punch: PunchType; impulse: Vec3 } | null = null;
  let lastDownT = 0;
  const qFall = new THREE.Quaternion();
  const qHead = new THREE.Quaternion();
  const qHipsF = new THREE.Quaternion();
  const qChestF = new THREE.Quaternion();
  const Hf = new THREE.Vector3();
  const Sf = new THREE.Vector3();
  const headF = new THREE.Vector3();
  const gloveF = [new THREE.Vector3(), new THREE.Vector3()] as const;
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
  const elbowJ = [new THREE.Vector3(), new THREE.Vector3()] as const;   // drawn elbows (the sim's; probes)
  const shoulderFall = [new THREE.Vector3(), new THREE.Vector3()] as const;   // chest-frame shoulders, for the knockdown flop
  const elbowCleared = [false, false];
  const hipJ = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const ankle = new THREE.Vector3();
  const ik: TwoBone = { mid: new THREE.Vector3(), end: new THREE.Vector3(), stretch: 1 };
  const footDesired: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  const footRest: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  const stepStyle: StepStyle = { role: 'lead', lateral: false };
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
    feet: () => [feet[0].phase, feet[1].phase],
    arms: () => [0, 1].map(i => ({ shoulder: { x: shoulderJ[i]!.x, y: shoulderJ[i]!.y, z: shoulderJ[i]!.z }, elbow: { x: elbowJ[i]!.x, y: elbowJ[i]!.y, z: elbowJ[i]!.z }, glove: { x: gloveL[i]!.x, y: gloveL[i]!.y, z: gloveL[i]!.z }, cleared: elbowCleared[i]! })) as ReturnType<RigProbe['arms']>,
  };
  window.__rig = window.__rig ?? {};
  window.__rig[side] = probe;

  // ── Events → squash ──
  const onEvents = (events: readonly SimEvent[], body: FighterState['body']): void => {
    for (const e of events) {
      if (e.type === 'punchLand' && e.target === side) { fireBodySquash(e.part, e.impulse); lastHit = { punch: e.punch, impulse: e.impulse }; }
      else if (e.type === 'knockdown' && e.side === side) {
        fallType = lastHit?.punch ?? 'cross';
        if (lastHit) dirToLocal(lastHit.impulse.x, 0, lastHit.impulse.z, fallDir); else fallDir.set(-1, 0, 0);
        fallDir.y = 0;
        if (fallDir.lengthSq() < 1e-8) fallDir.set(-1, 0, 0);
        // An uppercut sends you back whatever the fist was doing; a straight is already back.
        if (fallType === 'uppercut') fallDir.x = Math.min(fallDir.x, -0.7);
        fallDir.normalize();
        fallAxis.crossVectors(UP, fallDir).normalize();   // tipping UP toward fallDir
        lastDownT = 0;
      }
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
    const spin = lerp(prev.reaction.spin.x, next.reaction.spin.x, alpha);   // yaw whip from a hit (hooks)
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

    // 3. Idle life: slow breath + drift, and on top the boxer's rhythm — knees
    //    pumping on a beat, weight shifting foot to foot every other beat, the
    //    head riding it a little late. All non-hitbox (the sim's boxes hold
    //    still); the rhythm eases out through a punch or a block so the
    //    authored motion is not fighting a bounce.
    tIdle += dt;
    const breath = Math.sin(tIdle * c.rigBreathHz * Math.PI * 2);
    const sway = Math.sin(tIdle * c.rigSwayHz * Math.PI * 2 + side * 2.1);
    const bob = Math.sin(tIdle * c.rigSwayHz * Math.PI * 4 + 0.7) * c.rigBobAmp;
    const busy = next.punch.type !== null || next.block || next.down;
    // …and it dies down as the fighter tires (stamina → rigRhythmTired).
    const freshness = lerp(c.rigRhythmTired, 1, Math.max(0, Math.min(1, next.stamina)));
    const rhythm = chase1(rhythmGate, (busy ? 1 - c.rigRhythmFade : 1) * freshness, c.rigSpineK, c.rigSpineZeta, dt);
    const beat = tIdle * c.rigRhythmHz * (1 - 0.06 * side) * Math.PI * 2 + side * 1.3;
    const rDip = c.rigRhythmBob * (0.5 - 0.5 * Math.cos(beat)) * rhythm;        // hips drop on the beat, feet planted → knees
    const rLat = c.rigRhythmSway * Math.sin(beat / 2) * rhythm;                  // weight foot to foot, every other beat
    const rFwd = c.rigRhythmFwd * Math.sin(beat / 2 + 1.1) * rhythm;             // and a little rock front / back
    const rHeadY = -c.rigRhythmBob * (0.5 - 0.5 * Math.cos(beat - 0.5)) * c.rigRhythmHead * rhythm;   // head follows, a little late
    const rHeadZ = c.rigRhythmSway * Math.sin(beat / 2 - 0.5) * c.rigRhythmHead * rhythm;
    const rRoll = c.rigRhythmRoll * DEG * Math.sin(beat / 2 - 0.25) * rhythm;    // chest rolls over the loaded foot
    // Head off the centre line: a slow asymmetric weave of the upper body
    // (head full, shoulders 0.6), on top of the beat, gated the same way.
    const wPh = tIdle * c.rigWeaveHz * Math.PI * 2 + side * 2.7;
    const weaveZ = c.rigWeaveAmp * (Math.sin(wPh) + 0.35 * Math.sin(wPh * 1.7 + 0.8)) * rhythm;
    const weaveX = c.rigWeaveFwd * Math.sin(wPh * 0.5 + 1.9) * rhythm;
    headL.y += rHeadY;
    headL.z += rHeadZ + weaveZ;
    headL.x += weaveX;

    // Walking lean: the body leans into the direction of travel (hips shift,
    // chest pitches / rolls), through the spine spring so it arrives a beat
    // after the velocity does. Rig-local, as a fraction of top speed.
    dirToLocal(next.vel.x, 0, next.vel.z, v);
    const vScale = c.moveSpeed > 1e-6 ? 1 / c.moveSpeed : 0;
    const vFwd = v.x, vLat = v.z, vSpd = Math.hypot(vFwd, vLat);
    chase3(moveLean, vFwd * vScale, 0, vLat * vScale, c.rigSpineK, c.rigSpineZeta, dt);
    const mvFwd = moveLean.x, mvLat = moveLean.z;
    // Footwork roles: the foot nearest the direction of travel leads, the
    // other drags. Forward → lead foot; back → rear foot; sideways → the foot
    // on that side. Sideways travel is a shuffle.
    const { leader, lateral: lateralTravel } = stepRoles(vFwd, vLat, leadSign);
    // The push off the planted foot: the hips surge along the travel and rise
    // through the leading foot's swing (last frame's phase; one frame of lag).
    let stepUp = 0, stepSurge = 0;
    if (feet[leader]!.stepping && vSpd > 1e-3) {
      const sPh = Math.sin(Math.PI * feet[leader]!.phase);
      stepUp = c.rigStepBob * sPh;
      stepSurge = c.rigStepSurge * sPh;
    }
    const surgeF = vSpd > 1e-3 ? stepSurge * vFwd / vSpd : 0, surgeL = vSpd > 1e-3 ? stepSurge * vLat / vSpd : 0;

    // 2. Secondary motion — springs, hips stiffest → elbows loosest.
    chase3(hipSway, leanF * c.rigLeanHip + rFwd + mvFwd * c.rigMoveLeanShift + surgeF, bob - rDip + stepUp, leanL * c.rigLeanLat + sway * c.rigSwayAmp + rLat + mvLat * c.rigMoveLeanShift * 0.7 + surgeL, c.rigHipK, c.rigHipZeta, dt);
    chase3(spineBend, leanF * c.rigLeanChest + mvFwd * c.rigMoveLeanShift * 0.6 + weaveX * 0.6, 0, sway * c.rigSwayAmp * 0.5 + rLat * 0.3 + mvLat * c.rigMoveLeanShift * 0.4 + weaveZ * 0.6, c.rigSpineK, c.rigSpineZeta, dt);
    // Circling: the head leads the travel.
    headL.z += mvLat * c.rigMoveHeadLead;
    const yawS = chase1(shoulderYaw, leadSign * c.rigStanceShoulderYawDeg * DEG + twist, c.rigShoulderK, c.rigShoulderZeta, dt);

    // Hips.
    H.copy(hipL).add(hipSway as unknown as THREE.Vector3Like);
    qHips.setFromAxisAngle(YAXIS, leadSign * c.rigStanceHipYawDeg * DEG + hipYawS);

    // Chest: on the capsule top + sim torso reaction + spine spring, yawed by the
    // shoulder line, pitched by lean and the sim's tilt (positive = leaning back).
    S.copy(shoulderL).add(torsoOffL).add(spineBend as unknown as THREE.Vector3Like);
    // The torso BENDS with the hip→shoulder line (rigTorsoBend): a slip, a
    // pull, the lean shift and a hit all move S relative to H in the sim, and
    // the chest mesh now tilts to follow instead of shearing sideways upright.
    v.subVectors(S, H);
    const bendPitch = Math.atan2(v.x, Math.max(1e-3, v.y)) * c.rigTorsoBend;   // forward lean → +x over +y
    const bendRoll = Math.atan2(v.z, Math.max(1e-3, v.y)) * c.rigTorsoBend;    // sideways → +z over +y
    qChest.setFromAxisAngle(ZAXIS, -bendPitch);
    qTmp.setFromAxisAngle(XAXIS, bendRoll);
    qChest.multiply(qTmp);
    qTmp.setFromAxisAngle(YAXIS, yawS + spin);   // the shoulders whip round with a hook's spin
    qChest.multiply(qTmp);
    qTmp.setFromAxisAngle(ZAXIS, tilt - (leanF * c.rigLeanTiltDeg + blk * c.rigBlockTiltDeg + mvFwd * c.rigMoveLeanDeg) * DEG);
    qChest.multiply(qTmp);
    // Roll about the forward axis: the rhythm's roll over the loaded foot,
    // walking (roll into the travel) and the punch's lateral weight transfer
    // (a hook rolls the shoulders across with the weight, an uppercut over the
    // punching hip).
    qTmp.setFromAxisAngle(XAXIS, -rRoll + (mvLat * c.rigMoveLeanDeg * (lateralTravel ? 1.1 : 0.7) + leanL * c.rigLeanRollDeg) * DEG);   // circling rolls the torso harder into the travel
    qChest.multiply(qTmp);

    // ── Knockdown: rewrite hips, chest, head and gloves from the fall timeline ──
    // While down the pose is the timeline at downT (sim time, so it freezes
    // with hit-stop); after the get-up it eases back to the stance. The sim's
    // boxes stay standing — a downed fighter cannot be hit, so that is fine.
    if (next.down) { fallAmt.x = 1; fallAmt.v = 0; lastDownT = lerp(prev.down ? prev.downT : 0, next.downT, alpha); }
    const fallK = next.down ? 1 : chase1(fallAmt, 0, 25 / (c.rigGetUpTime * c.rigGetUpTime), 0.9, dt);
    if (fallK > 1e-4) {
      const t = lastDownT;
      const isUp = fallType === 'uppercut', isHook = fallType === 'hook';
      // Uppercut lead-in: up on the toes, head punched up, a slight arch — then the legs go.
      const tl = isUp ? c.rigFallLiftTime : 0;
      const tf = Math.max(0, t - tl);
      const liftY = tl > 0 && t < tl ? c.rigFallLift * Math.sin(Math.PI * t / tl) : 0;
      // Legs give way: the hips fall under rigFallGravity to the canvas and slide along the fall line.
      const hipFloor = body.bodyR * 1.05;
      const hipDropMax = Math.max(0.01, H.y - hipFloor);
      const hipDrop = Math.min(hipDropMax, 0.5 * c.rigFallGravity * tf * tf);
      Hf.copy(H).addScaledVector(fallDir, (hipDrop / hipDropMax) * c.rigFallSlide);
      Hf.y = H.y - hipDrop + liftY;
      // Torso tips about the hips along the fall line, accelerating, until it lies; a damped bounce on landing.
      const thetaMax = 88 * DEG;
      const tLand = Math.sqrt(2 * thetaMax / c.rigFallTip);
      let theta = Math.min(thetaMax, 0.5 * c.rigFallTip * tf * tf);
      if (tf > tLand) { const tb = tf - tLand; theta = thetaMax - c.rigFallBounce * Math.exp(-5 * tb) * Math.max(0, Math.sin(18 * tb)); }
      if (t < tl) theta = 0.2 * Math.sin(Math.PI * t / tl);   // the arch during the lift
      qFall.setFromAxisAngle(fallAxis, theta);
      if (isHook) {   // the body turns with the punch as it goes down sideways
        qTmp.setFromAxisAngle(YAXIS, c.rigFallHookSpin * DEG * Math.min(1, tf / 0.6) * (fallDir.z < 0 ? -1 : 1));
        qFall.multiply(qTmp);
      }
      v.subVectors(S, H).applyQuaternion(qFall);
      Sf.copy(Hf).add(v);
      Sf.y = Math.max(Sf.y, body.bodyR);
      qChestF.copy(qFall).multiply(qChest);
      qHipsF.copy(qFall).multiply(qHips);
      // The head whips past the torso; the canvas stops it.
      qHead.setFromAxisAngle(fallAxis, Math.min(thetaMax + 0.35, theta * (1 + c.rigFallHeadLag)));
      v.subVectors(headL, S).applyQuaternion(qHead);
      headF.copy(Sf).add(v);
      headF.y = Math.max(headF.y, body.headR);
      // Arms flop: from the fallen shoulders, forward-down and out, onto the canvas.
      for (let i = 0; i < 2; i++) {
        v.set(0.22, -0.2, latSign[i]! * (body.shoulderW / 2 + 0.12)).applyQuaternion(qChestF);
        gloveF[i]!.copy(Sf).add(v);
        gloveF[i]!.y = Math.max(gloveF[i]!.y, body.gloveR);
      }
      H.lerp(Hf, fallK);
      S.lerp(Sf, fallK);
      headL.lerp(headF, fallK);
      gloveL[0].lerp(gloveF[0]!, fallK);
      gloveL[1].lerp(gloveF[1]!, fallK);
      qHips.slerp(qHipsF, fallK);
      qChest.slerp(qChestF, fallK);
    }

    const bHips = bone(BONE.hips);
    bHips.position.copy(H);
    bHips.quaternion.copy(qHips);
    bHips.scale.set(1, 1, 1);
    const bChest = bone(BONE.chest);
    bChest.position.copy(S);
    bChest.quaternion.copy(qChest);
    scl.set(1 + breath * c.rigBreathAmp, 1, 1 + breath * c.rigBreathAmp * 0.5);
    squashTorso.step(dt);
    squashTorso.applyTo(scl);
    bChest.scale.copy(scl);

    // Shoulder joints and neck base ride on the chest. On a punch the punching
    // shoulder reaches forward out of the chest (the scapula), the other
    // pulls back — keyed on the forward weight, so it peaks with the fist.
    const shrug = blk * c.rigBlockShrug;
    const leanN = Math.min(1, Math.max(0, leanF) / c.rigHeelLiftLean);
    // The chest-frame shoulder is kept only for the knockdown flop (the sim's
    // shoulders, drawn below, do not fall with the chest).
    for (let i = 0; i < 2; i++) {
      const mine = next.punch.type !== null && (next.punch.hand === 'lead') === (i === 0);
      const reach = next.punch.type === null ? 0 : leanN * c.rigPunchShoulderReach * (mine ? 1 : -0.5);
      shoulderFall[i]!.set(reach, shrug, latSign[i]! * body.shoulderW / 2).applyQuaternion(qChest).add(S);
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
    bHead.quaternion.setFromAxisAngle(YAXIS, yawS * Math.min(1, c.rigHeadFollow * drive) + spin * c.rigHitHeadSpin);   // the head whips further than the shoulders
    // Chin tucks behind the gloves in the block, and behind the shoulder on a punch.
    qTmp.setFromAxisAngle(ZAXIS, tilt * 0.5 - (blk * c.rigBlockChinTuckDeg + leanN * c.rigPunchChinTuckDeg) * DEG);
    bHead.quaternion.multiply(qTmp);
    scl.set(1, 1, 1);
    squashHead.step(dt);
    squashHead.applyTo(scl);
    bHead.scale.copy(scl);

    // Arms: drawn on the SIM's joints (2026-09-18 — hit geometry is drawn
    // geometry: the sim places shoulders and elbows in sim/arms.ts with the
    // pole logic that used to live here, and resolves arm contacts on them,
    // so what you see cross is what the sim keeps apart). The rig's own
    // two-bone solve remains only for the knockdown flop, where the sim's
    // gloves do not follow the fall.
    for (let i = 0; i < 2; i++) {
      const sh = shoulderJ[i]!, gl = gloveL[i]!;
      lerpLocal(prev.arms[i]!.shoulder, next.arms[i]!.shoulder, alpha, sh);
      lerpLocal(prev.arms[i]!.elbow, next.arms[i]!.elbow, alpha, elbowJ[i]!);
      elbowCleared[i] = false;
      let stretch = 1;
      if (fallK > 1e-3) {
        sh.lerp(shoulderFall[i]!, fallK);
        // Falling: the flopped glove needs its own elbow. Blend toward it.
        v2.set(0, 0, latSign[i]!);
        pole.copy(v2).addScaledVector(DOWN, c.rigElbowPoleDown);
        solveTwoBone(sh, gl, body.upperArm, body.forearm, pole, c.rigArmStretchMax, ik);
        elbowJ[i]!.lerp(ik.mid, fallK);
        stretch = lerp(1, ik.stretch, fallK);
      } else {
        // The drawn forearm is the sim's bone; if the glove sits beyond it (a
        // stretched reach) the mesh stretches the same way the solve did.
        const l = v3dist(elbowJ[i]!, gl);
        if (l > body.forearm) stretch = Math.min(c.rigArmStretchMax, l / body.forearm);
      }
      placeLimb(i === 0 ? BONE.upperArm0 : BONE.upperArm1, sh, elbowJ[i]!);
      placeLimb(i === 0 ? BONE.forearm0 : BONE.forearm1, elbowJ[i]!, gl, stretch);
      const bGlove = bone(i === 0 ? BONE.glove0 : BONE.glove1);
      bGlove.position.copy(gl);                             // exact
      bGlove.quaternion.copy(bone(i === 0 ? BONE.forearm0 : BONE.forearm1).quaternion);
      scl.set(1, 1, 1);
      squashGlove[i]!.step(dt);
      squashGlove[i]!.applyTo(scl);
      bGlove.scale.copy(scl);
    }

    // Legs: feet planted in world space, stepped when the body walks away.
    // The leader is updated first so it wins when both feet are due.
    const moving = vSpd > 1e-3;
    for (const i of leader === 0 ? [0, 1] : [1, 0]) {
      const s = latSign[i]!;
      const restFwd = i === 0 ? c.rigStanceFwd : -c.rigStanceBack;
      const restLat = s * c.rigStanceLat;
      const footYawLocal = leadSign * (i === 0 ? c.rigLeadFootYawDeg : c.rigRearFootYawDeg) * DEG;
      const w = localToWorld(pos, frame, restFwd + hipSway.x, 0, restLat);
      footRest.x = w.x; footRest.z = w.z; footRest.y = 0; footRest.rotY = -yaw + footYawLocal;
      // Sideways the leading foot reaches further (a pivot step); the drag foot's target is the rest spot anyway.
      const leadT = c.rigStepLead * (lateralTravel ? c.rigShuffleLead : 1);
      footDesired.x = w.x + (moving ? next.vel.x * leadT : 0);
      footDesired.z = w.z + (moving ? next.vel.z * leadT : 0);
      footDesired.y = 0;
      footDesired.rotY = footRest.rotY;
      stepStyle.role = i === leader ? 'lead' : 'trail';
      stepStyle.lateral = lateralTravel;
      feet[i]!.update(footDesired, footRest, stepStyle, dt, c, feet[1 - i]!);
    }
    for (let i = 0; i < 2; i++) {
      const s = latSign[i]!;
      const fp = feet[i]!.out;
      toLocal({ x: fp.x, y: fp.y, z: fp.z }, ankle);
      // The foot under the punching hand of a hook pivots like the rear foot
      // on a cross (toe turns in, heel out); otherwise lead/rear as authored.
      const hookFoot = hookAmt * ((next.punch.hand === 'lead') === (i === 0) ? 1 : 0);
      const pivot = i === 0 ? lerp(c.rigPunchLeadFootPivot, c.rigPunchFootPivot, hookFoot) : c.rigPunchFootPivot;
      const pivotYaw = hipYawS * pivot;
      const yawL = fp.rotY + yaw + pivotYaw;
      // The pivot is on the BALL of the foot, not the ankle: the heel swings
      // round the ball, so the ankle moves along an arc (2026-09-16). +x is the
      // toe in the boot's frame, a Y rotation by θ sends it to (cos θ, 0, −sin θ).
      const ballD = d.footLen * c.rigPivotBall;
      const th0 = yawL - pivotYaw;
      ankle.x += ballD * (Math.cos(th0) - Math.cos(yawL));
      ankle.z += ballD * (Math.sin(yawL) - Math.sin(th0));
      // The pivoting foot's heel lifts with the torso twist (rear foot on a
      // straight, the punching-side foot on a hook); the boot pitches about the
      // ankle so the toe stays down.
      // Keyed on the forward weight, not the twist: through the load the
      // weight is back and the heel stays down; it comes up with the drive.
      const liftW = i === 1 ? 1 : hookFoot;
      const lift = c.rigPunchHeelLift * Math.min(1, Math.max(0, leanF) / c.rigHeelLiftLean) * liftW;
      ankle.y += body.bootH + lift;

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

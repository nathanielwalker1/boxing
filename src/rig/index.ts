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
  ROSTER, SIM_DT, addToRoster, generateFighter, angleDelta, closestOnSegment, frameOf, handLateralSign, lerp, localToWorld, smoothstep, spring1, spring3, v3dist, worldToLocal,
  SKJ, clampJoint, clampPose, clavicleTarget, fitArm, fitLeg, fitTorso, fk, lerpPose, poseQ, qAxis, restPose, setPoseQ, skelArm, skelDef, skelHeadCentre, skelLeg, skelLimits, skelShoulderLine,
  type Config, type FighterSpec, type FighterState, type FighterView, type Frame, type PunchType, type Side, type SimEvent, type SkelFK, type SkelPose, type Vec2, type Vec3,
} from '../core';
import { BONE, BONE_COUNT, MORPHS, buildRigMesh, rigGeomKey, type RigMesh } from './mesh';
import { JOINT_BONE, armBones, legBones } from './skeleton';
import { SkelDebugView } from './debug';
import { Reads, stanceParams } from './reads';
import { Spray } from './spray';
import { installRigReplay, type ReplayFeed } from './replay';
import { createRigMaterial, outlineMaterial, setGlow, updateMaterials, type RigMaterial } from './materials';
import { solveTwoBone, type TwoBone } from './ik';
import { chase1, chase3 } from './springs';
import { Squash } from './squash';
import { FootPlanter, stepRoles, type FootPose, type StepStyle } from './feet';
import { SkeletonDebug } from './debug';
import { chainPose } from '../sim/punches';   // pure pose curves (the V2 kinetic chain): what the hips, feet and knees do while the sim turns the shoulders

/**
 * The face, set by the host (sim state → expression is wired by the
 * orchestrator). Every field is optional: what is left out keeps its value.
 * Scalars are 0..1 and eased over ~0.1 s by the rig.
 */
export interface FaceState {
  /** Eyes squeeze shut, brow comes down (taking a shot). */
  wince?: number;
  /** Jaw drops (gassed; a KO). */
  mouthOpen?: number;
  /** Swelling under each eye, [the fighter's left, right]: the eye closes and the cheek bruises. */
  swell?: readonly [number, number];
  /** Cuts by place, 0 = none … 1 = open and running. */
  cuts?: Partial<Record<CutPlace, number>>;
}
export type CutPlace = 'browL' | 'browR' | 'cheekL' | 'cheekR' | 'nose' | 'lip';
/** The skin: sweat that builds (0 dry … 1 drenched) and reddening where the punches have been landing. */
export interface BodyState {
  sweat?: number;
  redden?: { head?: number; body?: number };
}
/** What createFighterView returns: the FighterView contract plus the face / body state (overhaul 2026-11-11). */
export interface RigView extends FighterView {
  setFace(face: FaceState): void;
  setBodyState(body: BodyState): void;
}

export interface RigProbe {
  /** Test hooks for the face / body state (lookbook): same as the view's. */
  setFace?: (face: FaceState) => void;
  setBodyState?: (body: BodyState) => void;
  /** Lookbook only: hang the arms so the face and chest are clear (the drawn arms leave the sim's joints while it is on). */
  portrait?: (on: boolean) => void;
  /**
   * Filmstrips / lookbook only: fields laid over the sim state this view is given, so a read that scripted
   * input cannot reach quickly (a spent fighter, a cut face, a clinch) can be looked at. null clears it. Never set in play.
   */
  override?: (o: Partial<FighterState> | null) => void;
  /** skelOn: the largest distance this frame from a drawn shoulder / elbow / hand to the sim's skeleton (m). */
  skelDiverge?: () => { sh: number; el: number; gl: number };
  /** Sweat droplets in the air right now (tests). */
  sprayCount?: () => number;
  /** The drawn feet's WORLD positions, lead then rear (the pivot's planted foot is measured with this). */
  footPos?: () => [Vec3, Vec3];
  /** Filmstrips (rig/replay.ts): one sim tick with its events at the fixed step; and hold the pose after. */
  feed?: (prev: FighterState, next: FighterState, events: readonly SimEvent[]) => void;
  freeze?: (on: boolean) => void;
  head(): Vec3;
  gloves(): [Vec3, Vec3];
  /** Main-pass draw calls, shadow-pass draw calls, and triangles for this fighter. */
  stats(): { calls: number; shadowCalls: number; tris: number };
  /** Step phase per foot (0..1, 1 = planted), index 0 = lead foot. */
  feet(): [number, number];
  /** Shoulder / elbow / glove joints per arm (index 0 = lead) and whether the torso-clearance re-solve fired this frame (probes). */
  arms(): [{ shoulder: Vec3; elbow: Vec3; glove: Vec3; cleared: boolean }, { shoulder: Vec3; elbow: Vec3; glove: Vec3; cleared: boolean }];
  /**
   * The drawn lower body, for scripts/chain_probe.mjs (rig-local: +x forward, +z the fighter's right): the hips' turn on top of
   * the stance (rad), their height and sideways shift (m); per foot (lead, rear) the pivot on the ball (rad), the heel's
   * lift (m) and how far the knee sits INSIDE the hip–ankle line (m).
   */
  chain?: () => { hipYaw: number; hipY: number; hipLat: number; footYaw: [number, number]; heel: [number, number]; kneeIn: [number, number] };
}

declare global {
  interface Window {
    __rig?: Partial<Record<Side, RigProbe>>;
    /** Lookbook: generate a fighter per seed (core/generator.ts), add them to the roster, return their ids — so `__look(id)` can show them. */
    __rigGen?: (seeds: readonly number[]) => string[];
    /** Lookbook: a roster fighter's spec by id (row labels). */
    __rosterSpec?: (id: string) => FighterSpec | null;
  }
}
if (typeof window !== 'undefined') {
  window.__rosterSpec = id => ROSTER.find(f => f.id === id) ?? null;
  window.__rigGen = seeds => seeds.map(s => { const f = generateFighter(s); addToRoster(f); return f.id; });
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

/**
 * `opts.key`: the toon-material key (default the side). A non-fighter figure
 * drawn with this rig (the referee) passes its own so the read's rim never
 * warms it, and `probe: false` so it does not take over window.__rig[side].
 */
export function createFighterView(side: Side, spec: FighterSpec, cfg: Config, parent: THREE.Object3D, opts: { key?: number; probe?: boolean } = {}): RigView {
  const root = new THREE.Group();
  root.name = opts.key !== undefined && opts.key !== side ? spec.id : `fighter${side}`;
  parent.add(root);

  const leadSign = handLateralSign('lead', spec.stance);
  const latSign: readonly [number, number] = [leadSign, -leadSign];   // index 0 = lead, 1 = rear

  let mat: RigMaterial | null = null;   // per fighter: its own atlas, sweat, damage and the read's warm rim
  const hull = outlineMaterial(cfg);
  // Face and body state (set by the host through setFace / setBodyState; eased here so nothing pops).
  const faceTarget = { wince: 0, mouthOpen: 0, swellL: 0, swellR: 0 };
  const faceNow = { wince: 0, mouthOpen: 0, swellL: 0, swellR: 0 };
  const bodyTarget = { sweat: 0, reddenHead: 0, reddenBody: 0 };
  // The elbow / knee hinge axes, remembered so a straight limb keeps the roll it had.
  const hingeArm = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)] as const;
  const hingeLeg = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)] as const;
  let cuts: Partial<Record<CutPlace, number>> = {};
  let portrait = false;
  let stateOverride: Partial<FighterState> | null = null;
  let frozen = false;
  const CUT_PLACES: readonly CutPlace[] = ['browL', 'browR', 'cheekL', 'cheekR', 'nose', 'lip'];
  const mergedCuts: Record<CutPlace, number> = { browL: 0, browR: 0, cheekL: 0, cheekR: 0, nose: 0, lip: 0 };
  let damageKey = '';
  let glowAmt = 0;   // the read: 0..1 from the UI, drawn as a warm rim (readGlowStrength × this)
  let rig: RigMesh | null = null;
  let geomKey = '';

  const debug = new SkeletonDebug(16, DEBUG_BONES.length, 0.018);
  root.add(debug.group);
  const skelView = new SkelDebugView();   // cfg.skelDebug: the fitted skeleton and its joint limits
  root.add(skelView.group);

  // ── Skeleton (anim Phase 1.1, cfg.skelOn) ──
  // The solver below still produces its points, offsets, springs and rotations; with skelOn they are TARGETS. These
  // hold what it produced this frame where it is overwritten in a loop, for the fit at the end (poseSkeleton).
  const skAnkle = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const skKneePole = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const skFoot = [new THREE.Quaternion(), new THREE.Quaternion()] as const;
  const skHem = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const skReach = [0, 0], skLift = [0, 0];
  const skHeadQ = new THREE.Quaternion(), skTailQ = new THREE.Quaternion();
  let skPose: SkelPose | null = null;
  /** The sim's own skeleton, interpolated to this frame, and its FK (world): the base the rig's targets start from. */
  let skBaseFk: SkelFK | null = null;
  let skBaseDef: ReturnType<typeof skelDef> | null = null;
  /** The knockdown blend this frame (0 standing … 1 down): outside it the drawn arms are the sim's. */
  let skFallK = 0;
  /** Drawn vs sim arm joints this frame, m (probe.skelDiverge). */
  const skDiverge = { sh: 0, el: 0, gl: 0 };
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
  let downKind: FighterState['downKind'] = 'heavy', downFall: FighterState['fall'] = 'none';   // the kind of the knockdown being drawn (rigDownV2), held through the get-up
  const qFall = new THREE.Quaternion();
  const qHead = new THREE.Quaternion();
  const qHipsF = new THREE.Quaternion();
  const qChestF = new THREE.Quaternion();
  const Hf = new THREE.Vector3();
  const Sf = new THREE.Vector3();
  const headF = new THREE.Vector3();
  const gloveF = [new THREE.Vector3(), new THREE.Vector3()] as const;
  const chainOut = { hipYaw: 0, hipY: 0, hipLat: 0, footYaw: [0, 0], heel: [0, 0], kneeIn: [0, 0] };   // what was drawn last frame, for probe.chain()
  const hipYaw = spring1(0);     // hips follow a fraction of the sim's torso twist (stiffest link, so they lead)
  const feet = [new FootPlanter(), new FootPlanter()] as const;
  const squashHead = new Squash();
  const squashTorso = new Squash();
  const squashGlove = [new Squash(), new Squash()] as const;
  let tIdle = side * 1.7;   // phase offset so the two fighters never breathe in sync
  let breathPh = side * 1.7, beatPh = 0;

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
  const fx = new THREE.Vector3(), fy = new THREE.Vector3(), fz = new THREE.Vector3();
  const du = new THREE.Vector3(), df = new THREE.Vector3(), hTmp = new THREE.Vector3();
  const mBasis = new THREE.Matrix4();
  const qNeck = new THREE.Quaternion();

  // ── Helpers ──
  const toLocal = (p: Vec3, out: THREE.Vector3): THREE.Vector3 => {
    const l = worldToLocal(pos, frame, p);
    return out.set(l.forward, l.up, l.lateral);
  };
  const lerpLocal = (a: Vec3, b: Vec3, t: number, out: THREE.Vector3): THREE.Vector3 =>
    toLocal({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }, out);
  /** The sim's shoulder joint for arm i this frame, rig-local: the skeleton's FK when there is one, else the lerped point. */
  const simShoulder = (prev: FighterState, next: FighterState, alpha: number, i: number, out: THREE.Vector3): THREE.Vector3 =>
    skBaseFk ? toLocal(skBaseFk.p[skelArm(i).upper]!, out) : lerpLocal(prev.arms[i]!.shoulder, next.arms[i]!.shoulder, alpha, out);
  /** World direction → rig-local direction (rotation only). */
  const dirToLocal = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(x * frame.fwd.x + z * frame.fwd.z, y, x * frame.right.x + z * frame.right.z);
  // Sprung cloth and hair, in world space.
  const hemS = [spring3(), spring3()] as const;
  const tailS = spring3();
  let sprungInit = false;
  let rootYaw = 0;
  /** Rig-local point → world, in place (the root is a yaw and a floor position). */
  const toWorldV = (p: THREE.Vector3): THREE.Vector3 => p.applyAxisAngle(YAXIS, -rootYaw).add(root.position);
  const toLocalV = (p: THREE.Vector3): THREE.Vector3 => p.sub(root.position).applyAxisAngle(YAXIS, rootYaw);
  const bone = (id: number): THREE.Bone => rig!.bones[id]!;
  /** A bone frame: local −y along `dir`, local +z along `hinge` (made perpendicular), +x = y × z. */
  const frameQuat = (dir: THREE.Vector3, hinge: THREE.Vector3, out: THREE.Quaternion): void => {
    fy.copy(dir).negate();
    fz.copy(hinge).addScaledVector(fy, -hinge.dot(fy));
    if (fz.lengthSq() < 1e-10) { fz.set(0, 0, 1).addScaledVector(fy, -fy.z); if (fz.lengthSq() < 1e-10) fz.set(1, 0, 0); }
    fz.normalize();
    fx.crossVectors(fy, fz);
    mBasis.makeBasis(fx, fy, fz);
    out.setFromRotationMatrix(mBasis);
  };
  /**
   * A two-bone limb a → b → c with its half-way joint bone, so the skin bends
   * as one surface. Both bones share the hinge axis (their local +z), so the
   * joint is a pure hinge — no twist for the blended skin to collapse over.
   * `sign` = +1 for arms (the forearm folds toward local +x), −1 for legs
   * (the shin folds toward −x). The joint bone widens in the bend plane to
   * put back the volume linear blending loses (rigJointMitre).
   * Returns the cosine of the bend (1 = straight).
   */
  const placeChain = (upperId: number, jointId: number, lowerId: number, a: THREE.Vector3, b: THREE.Vector3, cEnd: THREE.Vector3, hinge: THREE.Vector3, sign: number, stretch: number): number => {
    du.subVectors(b, a);
    if (du.lengthSq() > 1e-12) du.normalize(); else du.set(0, -1, 0);
    df.subVectors(cEnd, b);
    if (df.lengthSq() > 1e-12) df.normalize(); else df.copy(du);
    hTmp.crossVectors(du, df).multiplyScalar(sign);
    hinge.multiplyScalar(0.03).add(hTmp);
    if (hinge.lengthSq() < 1e-12) hinge.set(0, 0, 1);
    hinge.normalize();
    const bU = bone(upperId), bJ = bone(jointId), bL = bone(lowerId);
    bU.position.copy(a);
    frameQuat(du, hinge, bU.quaternion);
    bU.scale.set(1, 1, 1);
    bL.position.copy(b);
    frameQuat(df, hinge, bL.quaternion);
    bL.scale.set(1, stretch, 1);
    const cosBend = Math.max(-1, Math.min(1, du.dot(df)));
    const half = Math.acos(cosBend) / 2;
    const mitre = Math.min(cfg.rigJointMitreMax, 1 + cfg.rigJointMitre * (1 / Math.max(0.2, Math.cos(half)) - 1));
    bJ.position.copy(b);
    bJ.quaternion.slerpQuaternions(bU.quaternion, bL.quaternion, 0.5);
    bJ.scale.set(mitre, 1, 1);
    return cosBend;
  };

  const rebuild = (state: FighterState): void => {
    if (rig) { rig.dispose(); rig = null; }
    if (mat) mat.dispose();
    mat = createRigMaterial(cfg);
    rig = buildRigMesh(spec, state.body, cfg, latSign, mat.material, hull);
    mat.material.map = rig.atlas.texture;
    mat.uniforms.uDamage.value = rig.atlas.damage;
    damageKey = '';
    root.add(rig.group);
    geomKey = rigGeomKey(spec, state.body, cfg);
  };

  const probe: RigProbe = {
    // (skelOn: the head bone is the skull's pivot on the neck; the tail bone sits at the head centre in both modes.)
    head: () => { bone(cfg.skelOn ? BONE.tail : BONE.head).getWorldPosition(wp); return { x: wp.x, y: wp.y, z: wp.z }; },
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
  const probing = opts.probe ?? true;
  if (probing) {
    window.__rig = window.__rig ?? {};
    window.__rig[side] = probe;
  }

  // ── Events → squash ──
  const onEvents = (events: readonly SimEvent[], body: FighterState['body']): void => {
    for (const e of events) {
      if (e.type === 'punchLand' && e.target === side) { lastHit = { punch: e.punch, impulse: e.impulse }; }   // the squash is graded: reads.hits, in apply
      else if (e.type === 'knockdown' && e.side === side) {
        fallType = lastHit?.punch ?? 'cross';
        if (lastHit) dirToLocal(lastHit.impulse.x, 0, lastHit.impulse.z, fallDir); else fallDir.set(-1, 0, 0);
        fallDir.y = 0;
        if (fallDir.lengthSq() < 1e-8) fallDir.set(-1, 0, 0);
        // An uppercut sends you back whatever the fist was doing; a straight is already back.
        if (fallType === 'uppercut') fallDir.x = Math.min(fallDir.x, -0.7);
        // A body shot folds him: he goes down FORWARD, onto a knee and his hands, whatever line the punch had.
        if (e.cause === 'body') fallDir.set(1, 0, fallDir.z * 0.3);
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
  const fireBodySquash = (part: 'head' | 'body', impulse: Vec3, amount = 1, dur = 1): void => {
    dirToLocal(impulse.x, impulse.y, impulse.z, v);
    if (v.lengthSq() < 1e-10) v.set(-1, 0, 0);
    const target = part === 'head' ? squashHead : squashTorso;
    const q = part === 'head' ? bone(BONE.head).quaternion : qChest;
    qInv.copy(q).invert();
    v.applyQuaternion(qInv);
    target.fire(v, Math.min(0.5, cfg.rigSquashAmount * amount), cfg.rigSquashDur * dur);
  };
  const reads = new Reads(side);
  const spray = new Spray(parent);
  const readLocal = (x: number, y: number, z: number): readonly [number, number, number] => [x * frame.fwd.x + z * frame.fwd.z, y, x * frame.right.x + z * frame.right.z];

  // ── The skeleton pose (cfg.skelOn) ──
  const tv = (p: THREE.Vector3): Vec3 => ({ x: p.x, y: p.y, z: p.z });
  const tq = (q: THREE.Quaternion): { x: number; y: number; z: number; w: number } => ({ x: q.x, y: q.y, z: q.z, w: q.w });
  const qIdent = new THREE.Quaternion(), qJ = new THREE.Quaternion();
  /**
   * Fit the core skeleton to what the solver produced this frame (all rig-local: the rig frame is the root, floor
   * point at the origin facing +x), clamp it, and write it into the bone hierarchy: the pelvis takes its position and
   * orientation, every other bone its FIXED offset and its local rotation, helpers their half-way turns. No bone is
   * scaled — breath, squash, the stretchy neck and forearm and the joint mitres are gone with skelOn.
   */
  function poseSkeleton(body: FighterState['body'], c: Config): void {
    const def = skelDef(body, spec.stance, c), lim = skelLimits(c);
    const pose = skPose ?? restPose(def, 0, 0, 0);
    skPose = pose;
    fitTorso(def, lim, c, pose, { rootX: 0, rootZ: 0, yaw: 0, pelvis: tv(H), pelvisRot: tq(qHips), chest: tv(S), chestRot: tq(qChest), chestTwist: 0, head: tv(headL), headRot: tq(skHeadQ) });
    const fc = fk(def, pose, SKJ.chest + 1);
    for (let i = 0; i < 2; i++) {
      const a = skelArm(i);
      // The rig's own arm targets: the drawn shoulder offsets, the elbow where the solver put it (clinch / cover / knock
      // re-solves), the glove with its drawn-only offsets — used as they are only in a knockdown.
      let clavT = clavicleTarget(def, fc, i, skReach[i]!, skLift[i]!), glT = tv(gloveL[i]!);
      let pole = { x: elbowJ[i]!.x - shoulderJ[i]!.x, y: elbowJ[i]!.y - shoulderJ[i]!.y, z: elbowJ[i]!.z - shoulderJ[i]!.z };
      // Phase 1.1b: hit geometry = drawn geometry. Standing, the drawn arm IS the sim's — the clavicle aims at the sim's
      // shoulder, the hand at the sim's glove, the elbow bends to the sim's elbow — blending to the rig's own targets
      // only through a knockdown (fallK). No rig-only shoulder, elbow or hand offset survives outside one.
      if (skBaseFk) {
        const k = 1 - skFallK;
        const sS = toLocal(skBaseFk.p[a.upper]!, v2), sx = sS.x, sy = sS.y, sz = sS.z;
        const sE = toLocal(skBaseFk.p[a.fore]!, v2), ex = sE.x, ey = sE.y, ez = sE.z;
        const sH = toLocal(skBaseFk.p[a.hand]!, v2);
        clavT = { x: clavT.x + (sx - clavT.x) * k, y: clavT.y + (sy - clavT.y) * k, z: clavT.z + (sz - clavT.z) * k };
        glT = { x: glT.x + (sH.x - glT.x) * k, y: glT.y + (sH.y - glT.y) * k, z: glT.z + (sH.z - glT.z) * k };
        pole = { x: pole.x + (ex - sx - pole.x) * k, y: pole.y + (ey - sy - pole.y) * k, z: pole.z + (ez - sz - pole.z) * k };
      }
      const r = fitArm(def, lim, c, pose, i, clavT, glT, pole, 0);
      // The fist turns over as the arm straightens (as drawn before), on the hand joint: the forearm's twist, carried at the wrist.
      const ext = smoothstep((Math.cos(r.flex) + 0.2) / 1.1);
      setPoseQ(pose, a.hand, clampJoint(qAxis(1, latSign[i]! * lerp(c.rigGloveGuardRollDeg, c.rigGlovePronateDeg, ext) * DEG), lim[a.hand] ?? null, def.side[a.hand]!));
    }
    for (let i = 0; i < 2; i++) fitLeg(def, lim, c, pose, i, tv(skAnkle[i]!), tv(skKneePole[i]!), tq(skFoot[i]!));
    clampPose(def, pose, lim);
    const f = fk(def, pose);
    const r = rig!;
    for (let b = 0; b < BONE_COUNT; b++) r.bones[b]!.scale.set(1, 1, 1);
    for (let j = 0; j < JOINT_BONE.length; j++) {
      const b = bone(JOINT_BONE[j]!);
      if (j === SKJ.pelvis) { b.position.set(f.p[0]!.x, f.p[0]!.y, f.p[0]!.z); b.quaternion.set(f.r[0]!.x, f.r[0]!.y, f.r[0]!.z, f.r[0]!.w); continue; }
      const o = def.off[j]!, q = poseQ(pose, j);
      b.position.set(o.x, o.y, o.z);
      b.quaternion.set(q.x, q.y, q.z, q.w);
    }
    for (let i = 0; i < 2; i++) {
      const ab = armBones(i), lb = legBones(i), a = skelArm(i), l = skelLeg(i);
      const qu = poseQ(pose, a.upper), qf = poseQ(pose, a.fore), qs = poseQ(pose, l.shin);
      const bs = bone(ab.shoulder), ou = def.off[a.upper]!;
      bs.position.set(ou.x, ou.y, ou.z);
      bs.quaternion.slerpQuaternions(qIdent, qJ.set(qu.x, qu.y, qu.z, qu.w), c.rigShoulderFollow);   // the deltoid, turned part of the way to the arm
      const be = bone(ab.elbow);
      be.position.set(0, -def.upperArm, 0);
      be.quaternion.slerpQuaternions(qIdent, qJ.set(qf.x, qf.y, qf.z, qf.w), 0.5);
      const bk = bone(lb.knee);
      bk.position.set(0, -def.thigh, 0);
      bk.quaternion.slerpQuaternions(qIdent, qJ.set(qs.x, qs.y, qs.z, qs.w), 0.5);
      // The hem: the cloth spring's point, carried into the thigh's frame.
      const tp = f.p[l.thigh]!, tr = f.r[l.thigh]!;
      const bm = bone(lb.hem);
      bm.position.copy(skHem[i]!).sub(v.set(tp.x, tp.y, tp.z)).applyQuaternion(qJ.set(tr.x, tr.y, tr.z, tr.w).invert());
      bm.quaternion.identity();
      // Probes report what is drawn.
      const ps = f.p[a.upper]!, pe = f.p[a.fore]!, ph = f.p[a.hand]!;
      shoulderJ[i]!.set(ps.x, ps.y, ps.z); elbowJ[i]!.set(pe.x, pe.y, pe.z); gloveL[i]!.set(ph.x, ph.y, ph.z);
      chainOut.kneeIn[i] = -latSign[i]! * (f.p[l.shin]!.z - (f.p[l.thigh]!.z + f.p[l.foot]!.z) / 2);
    }
    // Hair rides the head at its centre; the spring's swing is relative to the head.
    const hr = f.r[SKJ.head]!, bt = bone(BONE.tail);
    bt.position.set(0, def.headCentre, 0);
    bt.quaternion.multiplyQuaternions(qJ.set(hr.x, hr.y, hr.z, hr.w).invert(), skTailQ);
    chainOut.hipY = f.p[0]!.y; chainOut.hipLat = f.p[0]!.z;
    // Drawn vs hit geometry: the largest distance from a drawn shoulder / elbow / hand to the sim's, this frame (probe).
    skDiverge.sh = skDiverge.el = skDiverge.gl = 0;
    if (skBaseFk) for (let i = 0; i < 2; i++) {
      const a = skelArm(i);
      for (const [key, j] of [['sh', a.upper], ['el', a.fore], ['gl', a.hand]] as const) {
        toLocal(skBaseFk.p[j]!, v2);
        const p = f.p[j]!;
        skDiverge[key] = Math.max(skDiverge[key], Math.hypot(p.x - v2.x, p.y - v2.y, p.z - v2.z));
      }
    }
    if (c.skelDebug) skelView.update(def, pose, f, lim);
  }

  // ── Per frame ──
  function apply(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[]): void {
    if (stateOverride) { prev = { ...prev, ...stateOverride }; next = { ...next, ...stateOverride }; }
    dt = frozen ? 0 : dt > MAX_DT ? MAX_DT : dt < 0 ? 0 : dt;
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
    rootYaw = yaw;
    lerpLocal(prev.headBox, next.headBox, alpha, headL);
    lerpLocal(prev.gloves[0].pos, next.gloves[0].pos, alpha, gloveL[0]);
    lerpLocal(prev.gloves[1].pos, next.gloves[1].pos, alpha, gloveL[1]);
    lerpLocal(prev.bodyBox.a, next.bodyBox.a, alpha, hipL);
    lerpLocal(prev.bodyBox.b, next.bodyBox.b, alpha, shoulderL);
    // skelOn: start from the SIM's skeleton, interpolated (slerp per joint), not from linearly lerped points — the
    // head, hips, shoulder line and gloves are its FK, so a turning segment keeps its length between ticks too.
    skBaseFk = null;
    if (c.skelOn && prev.skel && next.skel && !stateOverride) {
      skBaseDef = skelDef(body, spec.stance, c);
      skBaseFk = fk(skBaseDef, lerpPose(prev.skel, next.skel, alpha));
      toLocal(skelHeadCentre(skBaseDef, skBaseFk), headL);
      toLocal(skBaseFk.p[SKJ.pelvis]!, hipL);
      toLocal(skelShoulderLine(skBaseDef, skBaseFk), shoulderL);
      for (let i = 0; i < 2; i++) toLocal(skBaseFk.p[skelArm(i).hand]!, gloveL[i]!);
    }
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
    // V2 chain (polish, item 4): the hips LEAD the sim's shoulder line (they were following it through this spring, so the
    // order was shoulders → hips → foot), turn less than the shoulders, and one foot pushes while the other stays planted.
    const pt = next.punch.type;
    const cp = chainPose(pt, next.punch.hand, spec.stance, pt !== null && prev.punch.type === pt ? lerp(prev.punch.progress, next.punch.progress, alpha) : next.punch.progress, c);
    const pushFoot = next.punch.hand === 'lead' && pt !== 'jab' ? 0 : 1;   // the foot that drives this punch: the rear foot for a rear hand and for the jab, the lead foot for a lead hook / uppercut
    let hipYawS: number;
    if (cp.on) {
      // The chain's hip curve is already eased; the hip spring's ~2.5 ticks of lag ate the lead (measured), so it is a short first-order follow here.
      hipYaw.x += ((twist + cp.hipLead) * c.rigChainHipFollow * reads.hipFollowScale - hipYaw.x) * (1 - Math.exp(-dt * c.rigChainHipRate));
      hipYaw.v = 0;
      hipYawS = hipYaw.x;
    } else hipYawS = chase1(hipYaw, twist * c.rigPunchHipFollow * drive * reads.hipFollowScale, c.rigHipK, c.rigHipZeta, dt);   // (hipFollowScale: a nerfed punch is an arm punch — last frame's value, reads.step runs below)

    onEvents(events, body);
    // The reads: the sim's fight state as pose channels, a face and a skin (reads.ts). A landed punch is graded:
    // glancing brushes, flush squashes more and longer and throws sweat off the head.
    const punchIdx = next.punch.hand === 'lead' ? 0 : 1;
    reads.step(prev, next, alpha, dt, events, c, readLocal, latSign[punchIdx]!, leadSign);
    for (const h of reads.hits) {
      fireBodySquash(h.part, h.dir, h.squash, h.squashDur);
      if (h.spray > 0) {
        // Off the FAR side of the head (the way the punch is going), not from the contact point: thrown from the
        // contact they sat on the face like paint for the first frames (phase 3 film).
        const dl = Math.hypot(h.dir.x, h.dir.y, h.dir.z) || 1, off = body.headR * 2.3;   // right through to the back of the skull: at 1.25 R they started INSIDE the head and only the stragglers showed
        v2.set(h.at.x + h.dir.x / dl * off, h.at.y + body.headR * 0.3, h.at.z + h.dir.z / dl * off);
        spray.burst(h.spray, v2, h.dir, c.rigSpraySpeed, c.rigSpraySize, c.rigSprayLife);
      }
    }
    spray.update(dt);
    // Clinch: the drawn head leans onto the other man's shoulder (the head sphere stays; nobody is hit in a clinch).
    headL.x += reads.headFwd; headL.z += reads.headLat;
    const st = stanceParams(next, c);

    // 3. Idle life: slow breath + drift, and on top the boxer's rhythm — knees
    //    pumping on a beat, weight shifting foot to foot every other beat, the
    //    head riding it a little late. All non-hitbox (the sim's boxes hold
    //    still); the rhythm eases out through a punch or a block so the
    //    authored motion is not fighting a bounce.
    tIdle += dt;
    breathPh += dt * c.rigBreathHz * reads.breathRate * Math.PI * 2;   // tired = faster and deeper: the chest heaves
    const breath = Math.sin(breathPh) * reads.breathAmp * (1 - 0.85 * reads.still);
    const sway = Math.sin(tIdle * c.rigSwayHz * Math.PI * 2 + side * 2.1);
    const bob = Math.sin(tIdle * c.rigSwayHz * Math.PI * 4 + 0.7) * c.rigBobAmp;
    const busy = next.punch.type !== null || next.block || next.down;
    // ROCKED (sim/stun.ts): 1 at the shot, fading as it clears. Non-hitbox only:
    // the hips drop (knees give), the weight shift grows and slows to a wobble,
    // the chest rolls with it — the legs reading as gone.
    // Only a HEAD hurt wobbles (hurtKind): a winded fighter folds instead (reads.ts) — he used to draw the rocked wobble too.
    const hurt = (next.hurt > 0 && next.hurtMax > 0 ? Math.min(1, next.hurt / next.hurtMax) : 0) * reads.wobble;
    const wob = hurt > 0 ? Math.sin(tIdle * c.rigHurtHz * Math.PI * 2) * hurt * reads.wobbleAmp : 0;   // (rigHurtV2: bigger when the legs are gone, small when he is covering up)
    // …and it dies down as the fighter tires (stamina → rigRhythmTired) and goes flat-footed (stanceParams: 1 − flat).
    const freshness = lerp(c.rigRhythmTired, 1, Math.max(0, Math.min(1, next.stamina)));
    const rhythm = chase1(rhythmGate, (busy ? 1 - c.rigRhythmFade : 1) * freshness * (1 - reads.still), c.rigSpineK, c.rigSpineZeta, dt);   // (still: the beat before a late body shot folds him)
    beatPh += dt * st.bounceHz * (1 - 0.06 * side) * Math.PI * 2;
    const beat = beatPh + side * 1.3;
    const rDip = st.bounceAmp * (0.5 - 0.5 * Math.cos(beat)) * rhythm;        // hips drop on the beat, feet planted → knees
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
    // A lateral slip loads the leg on that side (2026-09-19): the drawn hips
    // shift toward the head's side by rigSlipHipShift of the head's move,
    // and (below) that knee bends in. The sim lowers the whole body
    // (slipCrouch) so the knees bend for real.
    const slipLat = next.slip.dir === -1 || next.slip.dir === 1 ? headL.z - shoulderL.z : 0;
    const slipAmt = Math.min(1, Math.abs(slipLat) / Math.max(1e-3, c.slipHeadOffset));
    chase3(hipSway, leanF * c.rigLeanHip + rFwd + mvFwd * c.rigMoveLeanShift + surgeF + wob * c.rigHurtSway * 0.4, bob - rDip + stepUp - slipAmt * c.rigSlipDip - hurt * c.rigHurtSink, leanL * c.rigLeanLat + (pt === 'jab' ? 0 : latSign[next.punch.hand === 'lead' ? 0 : 1]! * cp.load * c.rigChainLoadShift) + sway * c.rigSwayAmp + rLat + mvLat * c.rigMoveLeanShift * 0.7 + surgeL + slipLat * c.rigSlipHipShift + wob * c.rigHurtSway, c.rigHipK, c.rigHipZeta, dt);
    chase3(spineBend, leanF * c.rigLeanChest + mvFwd * c.rigMoveLeanShift * 0.6 + weaveX * 0.6, 0, sway * c.rigSwayAmp * 0.5 + rLat * 0.3 + mvLat * c.rigMoveLeanShift * 0.4 + weaveZ * 0.6, c.rigSpineK, c.rigSpineZeta, dt);
    // Circling: the head leads the travel.
    headL.z += mvLat * c.rigMoveHeadLead;
    const yawS = chase1(shoulderYaw, leadSign * c.rigStanceShoulderYawDeg * DEG + twist, c.rigShoulderK, c.rigShoulderZeta, dt);

    // Hips.
    H.copy(hipL).add(hipSway as unknown as THREE.Vector3Like);
    // Reads (non-hitbox): the hips sit back on the ropes, sag to a knee when winded, drop on a landing, drive up into a rising punch.
    H.x += reads.hipFwd; H.y -= reads.hipDrop; H.z += reads.hipLat;
    qHips.setFromAxisAngle(YAXIS, leadSign * st.hipYawDeg * DEG + hipYawS + reads.hipYaw);

    // Chest: on the capsule top + sim torso reaction + spine spring, yawed by the
    // shoulder line, pitched by lean and the sim's tilt (positive = leaning back).
    // (bodyBox.b already carries the sim's torso reaction offset — adding
    // torsoOffL here too moved the chest twice as far as the head and hips
    // on every hit, the "out of sync" look. Fixed 2026-09-19.)
    S.copy(shoulderL).add(spineBend as unknown as THREE.Vector3Like);
    // The torso BENDS with the hip→shoulder line (rigTorsoBend): a slip, a
    // pull, the lean shift and a hit all move S relative to H in the sim, and
    // the chest mesh now tilts to follow instead of shearing sideways upright.
    v.subVectors(S, H);
    const bendPitch = Math.atan2(v.x, Math.max(1e-3, v.y)) * c.rigTorsoBend;   // forward lean → +x over +y
    const bendRoll = Math.atan2(v.z, Math.max(1e-3, v.y)) * c.rigTorsoBend;    // sideways → +z over +y
    qChest.setFromAxisAngle(ZAXIS, -bendPitch);
    qTmp.setFromAxisAngle(XAXIS, bendRoll);
    qChest.multiply(qTmp);
    // The chest turns to the line between the SIM's shoulder joints (overhaul
    // 2026-11-11). The arms are drawn on those joints, and now that the
    // deltoids and the corners of the chest are one skin with them the chest
    // has to agree: the old stance blade (rigStanceShoulderYawDeg, still what
    // the head follows) turned the chest 38° off the shoulders it carries.
    for (let i = 0; i < 2; i++) simShoulder(prev, next, alpha, i, shoulderJ[i]!);
    const iR = latSign[0] > 0 ? 0 : 1;
    const yawSh = Math.atan2(shoulderJ[iR]!.x - shoulderJ[1 - iR]!.x, shoulderJ[iR]!.z - shoulderJ[1 - iR]!.z);
    // THE BLADE (phase 2): the ribcage turns toward the lead side (stanceParams.chestYawDeg) on top of the shoulder
    // line. The shoulder BONES stay on the sim's joints and carry the deltoids and the corners of the chest, so
    // no hit geometry moves; the turn fades as the punch's own twist takes over (a cross squares the chest itself).
    // skelOn: no drawn-only blade — on the skeleton the shoulders ride the chest, so a rig-only chest turn moved the drawn
    // shoulders 9–13 cm off the sim's (measured, Phase 1.1b). The stance blade belongs in the sim's fit or nowhere.
    const blade = c.skelOn ? 0 : leadSign * st.chestYawDeg * DEG * (1 - Math.min(1, Math.abs(twist) / 0.5));
    qTmp.setFromAxisAngle(YAXIS, yawSh + spin + blade + reads.chestYaw);   // the shoulders whip round with a hook's spin
    qChest.multiply(qTmp);
    qTmp.setFromAxisAngle(ZAXIS, tilt - (leanF * c.rigLeanTiltDeg + blk * c.rigBlockTiltDeg + mvFwd * c.rigMoveLeanDeg) * DEG - reads.chestPitch);
    qChest.multiply(qTmp);
    qTmp.setFromAxisAngle(XAXIS, reads.chestRoll);
    qChest.multiply(qTmp);
    // Roll about the forward axis: the rhythm's roll over the loaded foot,
    // walking (roll into the travel) and the punch's lateral weight transfer
    // (a hook rolls the shoulders across with the weight, an uppercut over the
    // punching hip).
    qTmp.setFromAxisAngle(XAXIS, -rRoll + (mvLat * c.rigMoveLeanDeg * (lateralTravel ? 1.1 : 0.7) + leanL * c.rigLeanRollDeg + (pt === 'uppercut' ? latSign[next.punch.hand === 'lead' ? 0 : 1]! * cp.sit * c.rigUppercutDropDeg : 0) + wob * c.rigHurtRollDeg) * DEG);   // circling rolls the torso harder into the travel; rocked, it rolls with the wobble
    qChest.multiply(qTmp);

    // ── Knockdown: rewrite hips, chest, head and gloves from the fall timeline ──
    // While down the pose is the timeline at downT (sim time, so it freezes
    // with hit-stop); after the get-up it eases back to the stance. The sim's
    // boxes stay standing — a downed fighter cannot be hit, so that is fine.
    if (next.down) { fallAmt.x = 1; fallAmt.v = 0; lastDownT = lerp(prev.down ? prev.downT : 0, next.downT, alpha); downKind = next.downKind; downFall = next.fall; }
    const fallK = next.down ? 1 : chase1(fallAmt, 0, 25 / (c.rigGetUpTime * c.rigGetUpTime), 0.9, dt);
    skFallK = fallK;
    if (fallK > 1e-4) {
      const t = lastDownT;
      const isUp = fallType === 'uppercut', isHook = fallType === 'hook';
      // Uppercut lead-in: up on the toes, head punched up, a slight arch — then the legs go.
      const tl = isUp ? c.rigFallLiftTime : 0;
      const tf = Math.max(0, t - tl);
      const liftY = tl > 0 && t < tl ? c.rigFallLift * Math.sin(Math.PI * t / tl) : 0;
      // Legs give way: the hips fall under rigFallGravity to the canvas and slide along the fall line.
      // How he goes down depends on why (knockdown.cause): a body shot folds him forward onto a knee and his
      // hands (hips stay off the canvas); a flash knockdown sits him down hard; the rest lay him out.
      // rigDownV2: the KIND of knockdown picks the fall. flash = the sit-down (and reads.ts gets him up fast); heavy = laid out (or
      // folded, for a body shot); knee and out are written over the timeline below.
      const kind = c.rigDownV2 ? downKind : null;
      const cause = kind === 'flash' ? 'flash' : kind === 'heavy' && reads.fallCause === 'flash' ? 'health' : reads.fallCause;
      const up = reads.up;   // the get-up: 0 lying … 1 on his feet (reads.ts, from getUp.phase)
      const hipFloor = cause === 'body' ? body.shin * 0.92 : body.bodyR * 1.05;
      const hipDropMax = Math.max(0.01, H.y - hipFloor);
      const fallG = cause === 'flash' ? c.rigFallGravity * 2.2 : c.rigFallGravity;
      // Getting up, the hips come off the canvas to kneeling height before the torso is upright.
      const hipDrop = Math.min(hipDropMax, 0.5 * fallG * tf * tf) * (1 - 0.62 * Math.min(1, up * 1.25));
      // Laid out (not folded, not sat down) the hips go on sliding until the legs are nearly straight: with the
      // feet planted and only rigFallSlide of travel he lay knees-up like a sit-up (phase 2 strip). It comes back as he gets up.
      const laid = cause === 'body' || cause === 'flash' ? 0 : smoothstep((0.5 * c.rigFallTip * tf * tf) / (80 * DEG)) * (1 - Math.min(1, up * 1.6));
      Hf.copy(H).addScaledVector(fallDir, (hipDrop / hipDropMax) * c.rigFallSlide * (cause === 'flash' ? 0.5 : 1) + laid * c.rigFallLaySlide);
      Hf.y = H.y - hipDrop + liftY;
      // Torso tips about the hips along the fall line, accelerating, until it lies; a damped bounce on landing.
      const thetaMax = (cause === 'flash' ? 42 : cause === 'body' ? 66 : 88) * DEG;
      const tLand = Math.sqrt(2 * thetaMax / c.rigFallTip);
      let theta = Math.min(thetaMax, 0.5 * c.rigFallTip * tf * tf);
      if (tf > tLand) { const tb = tf - tLand; theta = thetaMax - c.rigFallBounce * Math.exp(-5 * tb) * Math.max(0, Math.sin(18 * tb)); }
      if (t < tl) theta = 0.2 * Math.sin(Math.PI * t / tl);   // the arch during the lift
      // The struggle: he comes up off the canvas by `up`, unsteadily, and a slump drops him back.
      theta = theta * (1 - up) + reads.struggle * 0.05 * Math.min(1, up * 6);
      qFall.setFromAxisAngle(fallAxis, theta);
      if (isHook) {   // the body turns with the punch as it goes down sideways
        qTmp.setFromAxisAngle(YAXIS, c.rigFallHookSpin * DEG * Math.min(1, tf / 0.6) * (fallDir.z < 0 ? -1 : 1));
        qFall.multiply(qTmp);
      }
      let rigidArms = false, keepArms = false;
      if (kind === 'out' && downFall === 'stiff') {
        // OUT, STIFF: a plank. Nothing folds: hips, chest and head turn as one about the heels, the arms stay where they were,
        // and he lands flat with one small bounce.
        const tFlat = Math.sqrt(Math.PI / c.rigDownPlank), tb = t - tFlat;
        theta = tb > 0 ? Math.PI / 2 - 0.07 * Math.exp(-6 * tb) * Math.max(0, Math.sin(20 * tb)) : 0.5 * c.rigDownPlank * t * t;
        qFall.setFromAxisAngle(fallAxis, theta);
        Hf.copy(H).addScaledVector(fallDir, H.y * Math.sin(theta));
        Hf.y = Math.max(body.bodyR * 1.05, H.y * Math.cos(theta));
        rigidArms = true;
      } else if (kind === 'out' && downFall === 'crumple') {
        // OUT, CRUMPLE: the legs go first — the hips drop straight down over the feet, fast, the chest pitching forward over the
        // knees — and only then does he tip over along the punch.
        const drop = Math.min(hipDropMax, 0.5 * c.rigDownCrumple * t * t), tDrop = Math.sqrt(2 * hipDropMax / c.rigDownCrumple);
        Hf.copy(H).addScaledVector(fallDir, 0.1 * drop / hipDropMax);
        Hf.y = H.y - drop;
        const tt = Math.max(0, t - tDrop * 0.7);
        theta = Math.min(84 * DEG, 0.5 * c.rigFallTip * 0.7 * tt * tt);
        qFall.setFromAxisAngle(fallAxis, theta);
        qTmp.setFromAxisAngle(ZAXIS, -40 * DEG * smoothstep(t / tDrop) * (1 - smoothstep((t - tDrop) / 0.5)));
        qFall.multiply(qTmp);
      } else if (kind === 'knee') {
        // TAKING A KNEE: down under control. The hips sink back over the rear foot to shin height (the rear knee goes to the canvas, the
        // lead knee stays up), the chest stays nearly upright, the hands stay up. He comes back up with the get-up.
        const drop = Math.min(Math.max(0.01, H.y - body.shin * 1.02), 0.5 * 3.2 * t * t) * (1 - Math.min(1, up * 1.25));
        const k = drop / Math.max(0.01, H.y - body.shin * 1.02);
        Hf.set(H.x - st.back * 0.55 * k, H.y - drop, H.z - leadSign * 0.05 * k);
        theta = 9 * DEG * k;
        qFall.setFromAxisAngle(ZAXIS, -theta);
        keepArms = true;
      }
      v.subVectors(S, H).applyQuaternion(qFall);
      Sf.copy(Hf).add(v);
      Sf.y = Math.max(Sf.y, body.bodyR);
      qChestF.copy(qFall).multiply(qChest);
      qHipsF.copy(qFall).multiply(qHips);
      // The head rides the fallen chest at its REST neck length, a little
      // further round than the torso (rigFallHeadLag). It is rebuilt from the
      // chest rather than rotated from headL: headL still carries the KO
      // punch's reaction spring, and rotating that offset as well stretched
      // the neck like a cartoon (Nate, 2026-10-15).
      qHead.setFromAxisAngle(fallAxis, Math.min(thetaMax + 0.25, theta * (1 + c.rigFallHeadLag)));
      v.set(0, body.headY - body.shoulderY, 0).applyQuaternion(qHead);
      headF.copy(Sf).add(v);
      headF.y = Math.max(headF.y, body.headR);
      // Arms flop: from the fallen shoulders, forward-down and out, onto the canvas. Getting up (and folded by a
      // body shot) the hands go DOWN to the canvas under the shoulders and push.
      // (Body cause: only as far as he has folded — at push = 1 from the first tick the gloves were pinned to the canvas
      //  under a man still standing, and the arm could not reach them: a glove and cuff stood on the floor by themselves.)
      const push = cause === 'body' ? smoothstep(theta / (45 * DEG)) * (1 - smoothstep((up - 0.6) / 0.3)) : Math.min(1, up * 3) * (1 - smoothstep((up - 0.6) / 0.3));
      const armReach = (body.upperArm + body.forearm) * 0.98;
      for (let i = 0; i < 2; i++) {
        v.set(0.22, -0.2, latSign[i]! * (body.shoulderW / 2 + 0.12)).applyQuaternion(qChestF);
        gloveF[i]!.copy(Sf).add(v);
        if (rigidArms || keepArms) {
          // The arms are not flung and do not flop: they ride the body as they were (stiff), or stay in the guard (a knee).
          v.subVectors(gloveL[i]!, H).applyQuaternion(qFall);
          gloveF[i]!.copy(Hf).add(v);
          gloveF[i]!.y = Math.max(gloveF[i]!.y, body.gloveR);
          continue;
        }
        // Laid out, the arms lie ON the canvas out from the shoulders, a little toward the hips — the chest-frame
        // flop pointed them at the ceiling once he was on his back (seen in the first knockdown strip).
        const lie = smoothstep(theta / (70 * DEG));
        if (lie > 0) {
          v.set(0, 0, latSign[i]!).applyQuaternion(qChestF); v.y = 0;
          if (v.lengthSq() < 1e-6) v.set(0, 0, latSign[i]!); else v.normalize();
          v2.copy(Sf).addScaledVector(v, body.shoulderW / 2 + body.upperArm * 0.75).addScaledVector(fallDir, -0.22);
          v2.y = body.gloveR;
          gloveF[i]!.lerp(v2, lie);
        }
        if (push > 0) {
          v2.set(Sf.x + fallDir.x * 0.12, body.gloveR, Sf.z + fallDir.z * 0.12 + latSign[i]! * (body.shoulderW / 2 + 0.05));
          gloveF[i]!.lerp(v2, push);
        }
        gloveF[i]!.y = Math.max(gloveF[i]!.y, body.gloveR);
        // Never further from its own shoulder than the arm is long: the hand comes to the shoulder's reach, not the arm to the hand.
        v.set(0, 0, latSign[i]! * body.shoulderW / 2).applyQuaternion(qChestF).add(Sf);
        v2.subVectors(gloveF[i]!, v);
        const gd = v2.length();
        if (gd > armReach) gloveF[i]!.copy(v).addScaledVector(v2, armReach / gd);
      }
      H.lerp(Hf, fallK);
      S.lerp(Sf, fallK);
      headL.lerp(headF, fallK);
      gloveL[0].lerp(gloveF[0]!, fallK);
      gloveL[1].lerp(gloveF[1]!, fallK);
      qHips.slerp(qHipsF, fallK);
      qChest.slerp(qChestF, fallK);
    }

    chainOut.hipYaw = hipYawS + reads.hipYaw; chainOut.hipY = H.y; chainOut.hipLat = H.z;
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
    // The waist: a bone half-way between hips and chest, so the skin between them curves and twists as one.
    const bSpine = bone(BONE.spine);
    bSpine.position.addVectors(H, S).multiplyScalar(0.5);
    bSpine.quaternion.slerpQuaternions(qHips, qChest, 0.5);
    bSpine.scale.set(1, 1, 1);

    // Shoulder joints and neck base ride on the chest. On a punch the punching
    // shoulder reaches forward out of the chest (the scapula), the other
    // pulls back — keyed on the forward weight, so it peaks with the fist.
    const shrug = blk * c.rigBlockShrug + reads.shrug;   // + the reads: hunched inside, slumped when the guard droops or breaks
    const leanN = Math.min(1, Math.max(0, leanF) / c.rigHeelLiftLean);
    // The chest-frame shoulder is kept only for the knockdown flop (the sim's
    // shoulders, drawn below, do not fall with the chest).
    for (let i = 0; i < 2; i++) {
      const mine = next.punch.type !== null && (next.punch.hand === 'lead') === (i === 0);
      const reach = next.punch.type === null ? 0 : leanN * c.rigPunchShoulderReach * (mine ? 1 : -0.5);
      shoulderFall[i]!.set(reach, shrug, latSign[i]! * body.shoulderW / 2).applyQuaternion(qChest).add(S);
    }
    neckBase.set(0, d.neckBase + shrug, 0).applyQuaternion(qChest).add(S);

    // Head: exactly on the sim's head sphere.
    const bHead = bone(BONE.head);
    bHead.position.copy(headL);
    bHead.quaternion.setFromAxisAngle(YAXIS, yawSh * Math.min(1, c.rigHeadFollow * drive) + spin * c.rigHitHeadSpin);   // the head whips further than the shoulders
    void yawS;
    // Chin tucks behind the gloves in the block, and behind the shoulder on a punch.
    qTmp.setFromAxisAngle(ZAXIS, tilt * 0.5 - (blk * c.rigBlockChinTuckDeg + leanN * c.rigPunchChinTuckDeg) * DEG);
    bHead.quaternion.multiply(qTmp);
    // Reads: a flush shot whips the head on along the punch and it comes back; it rocks with a blocked one; it hangs when winded; it goes to the side in a clinch.
    qTmp.setFromAxisAngle(YAXIS, reads.headYaw);
    bHead.quaternion.multiply(qTmp);
    qTmp.setFromAxisAngle(ZAXIS, reads.headPitch);
    bHead.quaternion.multiply(qTmp);
    qTmp.setFromAxisAngle(XAXIS, reads.headRoll);
    bHead.quaternion.multiply(qTmp);
    skHeadQ.copy(bHead.quaternion);   // skelOn: the head's orientation target
    scl.set(1, 1, 1);
    squashHead.step(dt);
    squashHead.applyTo(scl);
    bHead.scale.copy(scl);

    // Neck: from the chest to the head, turned half-way between them, aimed
    // at the head and stretched to reach it — the skin blends chest → neck → head.
    const bNeck = bone(BONE.neck);
    v.subVectors(headL, neckBase);
    let neckLen = v.length();
    // The head never leaves the body (polish B): a flush land moves the sim's head up to 1.4 × reactionMaxNeck off the shoulders, a
    // finisher 1.6 ×. Past rigNeckReach × its bind length the neck's BASE follows the head (the top of the chest gives).
    const neckMax = c.rigNeckReach * d.neckBind;
    if (neckLen > neckMax) { neckBase.addScaledVector(v, (neckLen - neckMax) / neckLen); v.subVectors(headL, neckBase); neckLen = v.length(); }
    bNeck.position.copy(neckBase);
    if (neckLen > 1e-6) v.divideScalar(neckLen); else v.set(0, 1, 0);
    qNeck.slerpQuaternions(qChest, bHead.quaternion, 0.5);
    v2.set(0, 1, 0).applyQuaternion(qNeck);
    qTmp.setFromUnitVectors(v2, v);
    bNeck.quaternion.multiplyQuaternions(qTmp, qNeck);
    bNeck.scale.set(1, Math.max(0.3, Math.min(c.rigNeckReach, neckLen / Math.max(1e-3, d.neckBind))), 1);
    // Hanging hair rides the head (cloth.ts springs it).
    // Hanging hair: a point 0.3 m down the head's own axis is chased in WORLD space on a loose spring, and the
    // tail bone swings to it — so the hair trails a slip, a turn and a punch landing, and settles.
    const bTail = bone(BONE.tail);
    bTail.position.copy(headL);
    v.set(0, -1, 0).applyQuaternion(bHead.quaternion);
    v2.copy(headL).addScaledVector(v, 0.3);
    toWorldV(v2);
    if (!sprungInit || Math.hypot(tailS.x - v2.x, tailS.y - v2.y, tailS.z - v2.z) > 0.6) { tailS.x = v2.x; tailS.y = v2.y; tailS.z = v2.z; tailS.vx = tailS.vy = tailS.vz = 0; }
    chase3(tailS, v2.x, v2.y, v2.z, c.rigTailK, c.rigTailZeta, dt);
    v2.set(tailS.x, tailS.y, tailS.z);
    toLocalV(v2).sub(headL);
    if (v2.lengthSq() > 1e-8) {
      v2.normalize();
      qTmp.setFromUnitVectors(v, v2);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(qTmp.w))), maxA = c.rigTailMaxDeg * DEG;
      if (ang > maxA && ang > 1e-6) qTmp.slerp(qInv.identity(), 1 - maxA / ang);
      bTail.quaternion.multiplyQuaternions(qTmp, bHead.quaternion);
    } else bTail.quaternion.copy(bHead.quaternion);
    bTail.scale.set(1, 1, 1);
    skTailQ.copy(bTail.quaternion);

    // Arms: drawn on the SIM's joints (2026-09-18 — hit geometry is drawn
    // geometry: the sim places shoulders and elbows in sim/arms.ts with the
    // pole logic that used to live here, and resolves arm contacts on them,
    // so what you see cross is what the sim keeps apart). The rig's own
    // two-bone solve remains only for the knockdown flop, where the sim's
    // gloves do not follow the fall.
    for (let i = 0; i < 2; i++) {
      const sh = shoulderJ[i]!, gl = gloveL[i]!;
      simShoulder(prev, next, alpha, i, sh);
      if (skBaseFk) toLocal(skBaseFk.p[skelArm(i).fore]!, elbowJ[i]!);
      else lerpLocal(prev.arms[i]!.elbow, next.arms[i]!.elbow, alpha, elbowJ[i]!);
      if (portrait) {
        // Lookbook portrait: the arms hang, a little forward and bent, so the face and chest are clear. Never set in play.
        elbowJ[i]!.set(sh.x - 0.02, sh.y - body.upperArm * 0.98, sh.z + latSign[i]! * 0.07);
        gl.set(elbowJ[i]!.x + body.forearm * 0.3, elbowJ[i]!.y - body.forearm * 0.95, elbowJ[i]!.z + latSign[i]! * 0.03);
      }
      // Reads on the drawn arm root (a few cm, non-hitbox): the shoulders hunch or slump, and a feint twitches the punching one.
      sh.y += shrug + (i === 0 ? reads.shrugLead : 0) - reads.shoulderGive[latSign[i]! > 0 ? 0 : 1]!;   // (the hit-side shoulder gives)
      // V2 chain, drawn only: the punching shoulder drops in an uppercut's sit; the lead shoulder comes up into the chin on a jab.
      if (cp.on && (next.punch.hand === 'lead') === (i === 0)) sh.y += pt === 'uppercut' ? -cp.sit * c.rigUppercutShoulderDrop : pt === 'jab' ? cp.push * c.rigJabShrug : 0;
      if ((next.punch.hand === 'lead') === (i === 0)) sh.x += reads.feintReach;
      if (c.skelOn) {
        // The same reach and the same few cm of shrug / give / feint, for the clavicle to carry (chest frame) — the skeleton's shoulder rides the chest.
        const isPunch = (next.punch.hand === 'lead') === (i === 0), mineP = next.punch.type !== null && isPunch;
        skReach[i] = (next.punch.type === null ? 0 : leanN * c.rigPunchShoulderReach * (mineP ? 1 : -0.5)) + (isPunch ? reads.feintReach : 0);
        skLift[i] = shrug + (i === 0 ? reads.shrugLead : 0) - reads.shoulderGive[latSign[i]! > 0 ? 0 : 1]!
          + (cp.on && isPunch ? (pt === 'uppercut' ? -cp.sit * c.rigUppercutShoulderDrop : pt === 'jab' ? cp.push * c.rigJabShrug : 0) : 0);
      }
      // Clinch and push-off: the sim leaves the gloves at the guard (nobody can punch in a clinch; a shove has no
      // fist), so the DRAWN arms leave the sim's joints for these two — wrapped round the other man, or both
      // forearms driving out from the chest.
      const tie = Math.max(reads.clinch, reads.push);
      if (tie > 1e-3 && fallK < 0.5) {
        if (reads.push >= reads.clinch) v2.set(S.x + 0.2 + 0.34 * reads.push, S.y - 0.1, S.z + latSign[i]! * 0.11);
        // The tie-up goes ROUND him, not through him: each arm stays on its own side, past his ribs to his back —
        // the lead arm over his arm at shoulder height, the rear arm under at the waist. (Phase 2 crossed them to
        // the far side and they passed through his chest.)
        else v2.set(S.x + 0.56, S.y + (i === 0 ? 0.03 : -0.2), S.z + latSign[i]! * 0.21);
        gl.lerp(v2, tie);
        pole.set(0, -0.3, latSign[i]!);
        solveTwoBone(sh, gl, body.upperArm, body.forearm, pole, c.rigArmStretchMax, ik);
        elbowJ[i]!.lerp(ik.mid, tie);
      }
      // Covering up: after a clean body shot the elbow on that side drops to the ribs and the glove comes down with it.
      const mineBusy = next.punch.type !== null && (next.punch.hand === 'lead') === (i === 0);
      if (reads.cover > 1e-3 && latSign[i] === reads.coverSide && !mineBusy && fallK < 0.5 && tie < 0.5) {
        v2.set(H.x + 0.15, H.y + 0.3, H.z + latSign[i]! * 0.16);
        gl.lerp(v2, reads.cover * 0.9);
        pole.set(-0.5, -1, latSign[i]! * 0.25);
        solveTwoBone(sh, gl, body.upperArm, body.forearm, pole, c.rigArmStretchMax, ik);
        elbowJ[i]!.lerp(ik.mid, reads.cover * 0.9);
      }
      // A hand knocked loose by a flush shot (rigReactV2): out, down and a little back for a beat; the elbow goes part of the way.
      const ak = reads.armKick[latSign[i]! > 0 ? 0 : 1]!;
      if (ak > 1e-4 && fallK < 0.5) { v2.set(-0.35 * ak, -0.45 * ak, latSign[i]! * 0.85 * ak); gl.add(v2); elbowJ[i]!.addScaledVector(v2, 0.45); }
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
      const ab = armBones(i);
      const cosBend = placeChain(ab.upper, ab.elbow, ab.fore, sh, elbowJ[i]!, gl, hingeArm[i]!, 1, stretch);
      // The deltoid belongs to the arm: its bone sits on the arm root, turned part of the way from the chest to the upper arm.
      const bShoulder = bone(ab.shoulder);
      bShoulder.position.copy(sh);
      bShoulder.quaternion.slerpQuaternions(qChest, bone(ab.upper).quaternion, c.rigShoulderFollow);
      bShoulder.scale.set(1, 1, 1);
      const bGlove = bone(ab.glove);
      bGlove.position.copy(gl);                             // exact
      // The fist turns over as the arm straightens: thumbs toward the fighter at the guard, palm down at full reach.
      const ext = smoothstep((cosBend + 0.2) / 1.1);
      qTmp.setFromAxisAngle(YAXIS, latSign[i]! * lerp(c.rigGloveGuardRollDeg, c.rigGlovePronateDeg, ext) * DEG);
      bGlove.quaternion.copy(bone(ab.fore).quaternion).multiply(qTmp);
      scl.set(1, 1, 1);
      squashGlove[i]!.step(dt);
      squashGlove[i]!.applyTo(scl);
      bGlove.scale.copy(scl);
    }

    // Legs: feet planted in world space, stepped when the body walks away.
    // The leader is updated first so it wins when both feet are due.
    const moving = vSpd > 1e-3;
    const keyFeet = c.skelOn && c.punchKeysOn && !!next.footKey && fallK < 0.5;
    for (const i of leader === 0 ? [0, 1] : [1, 0]) {
      const s = latSign[i]!;
      // Stance from stanceParams (one place: a style table can drive it). A step jab's lead foot steps with the punch.
      // Punch keys (cfg.punchKeysOn): the sim's foot channels replace the rig's own punch step — [stepF, stepL, pivot, heel] per foot.
      const fk = keyFeet ? next.footKey! : null;
      const jabStep = fk ? 0 : cp.on && pt === 'jab' && next.punch.variant === 'jab' ? cp.push * c.rigJabStep : 0;   // V2: the jab steps off the lead foot
      const keyStepF = fk ? fk[i * 4]! : 0, keyStepL = fk ? fk[i * 4 + 1]! : 0;
      const restFwd = (i === 0 ? st.fwd + reads.leadStep + jabStep : -st.back) + keyStepF;
      const restLat = s * (st.lat + keyStepL);
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
      if (i === 0 && next.pivot.dir !== 0) {
        // The pivot: the body swings round the planted lead foot — it stays on the sim's pivot point, turning with him.
        // MEASURED (scripts/_debug.mjs pivot): once there the drawn foot is 0.0 cm off the sim's point for the whole
        // pivot — but it got there by teleporting 28 cm in one tick (the sim plants the foot pivotReach ahead). It
        // now takes a quick step to the point (≈ 4 ticks) and plants.
        footDesired.x = next.pivot.cx; footDesired.z = next.pivot.cz;
        footRest.x = footDesired.x; footRest.z = footDesired.z;
        const off = Math.hypot(feet[0].out.x - footDesired.x, feet[0].out.z - footDesired.z);
        if (feet[0].stepping) feet[0].update(footDesired, footRest, stepStyle, dt, c, feet[1]);
        else if (off > 0.03) feet[0].stepNow(footDesired, c, 0.3);
        else feet[0].snap(footDesired);
      } else if (reads.airborne > 0) {
        // The burst: both feet leave the canvas and travel with him; they land where the hop ends.
        feet[i]!.snap(footDesired);
        feet[i]!.out.y = reads.footLift * (i === leader ? 1 : 0.7);
      } else if (i === 0 && reads.followStep && !feet[0].stepping && Math.hypot(footDesired.x - feet[0].out.x, footDesired.z - feet[0].out.z) > 0.04) {
        // rigComboV2: the sim's follow step carries the attacker in — the LEAD foot goes first, at once, not when the planter gets round to it.
        stepStyle.role = 'lead'; stepStyle.lateral = false; feet[0].stepNow(footDesired, c);
      } else if (i === 0 && reads.leadStep + jabStep + keyStepF > 0.02 && !feet[0].stepping) {
        const fd = Math.hypot(footDesired.x - feet[0].out.x, footDesired.z - feet[0].out.z);
        if (fd > 0.05) { stepStyle.role = 'lead'; stepStyle.lateral = false; feet[0].stepNow(footDesired, c); } else feet[i]!.update(footDesired, footRest, stepStyle, dt, c, feet[1 - i]!);
      } else feet[i]!.update(footDesired, footRest, stepStyle, dt, c, feet[1 - i]!);
    }
    for (let i = 0; i < 2; i++) {
      const s = latSign[i]!;
      const fp = feet[i]!.out;
      toLocal({ x: fp.x, y: fp.y, z: fp.z }, ankle);
      // The foot under the punching hand of a hook pivots like the rear foot
      // on a cross (toe turns in, heel out); otherwise lead/rear as authored.
      const hookFoot = hookAmt * ((next.punch.hand === 'lead') === (i === 0) ? 1 : 0);
      const pivot = cp.on ? (i === pushFoot ? c.rigPunchFootPivot * (pt === 'jab' ? c.rigChainJabHeel : 1) : c.rigChainOffFootPivot)
        : i === 0 ? lerp(c.rigPunchLeadFootPivot, c.rigPunchFootPivot, hookFoot) : c.rigPunchFootPivot;
      // (Keyed: the sim's pivot channel, radians in the fighter's frame; still about the ball, below.)
      const pivotYaw = keyFeet ? next.footKey![i * 4 + 2]! : hipYawS * pivot;
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
      // + the reads: on the balls of the feet while he bounces (the rear heel stays off the canvas; flat-footed = down),
      //   and both heels up through a hop or a rising punch.
      // V2 chain: the pushing foot's heel comes up WITH the hip drive (foot first), not with the forward lean (which peaks with the fist).
      const punchLift = cp.on ? c.rigPunchHeelLift * cp.push * (i === pushFoot ? (pt === 'jab' ? c.rigChainJabHeel : 1) : 0) : c.rigPunchHeelLift * Math.min(1, Math.max(0, leanF) / c.rigHeelLiftLean) * liftW;
      const keyLift = keyFeet ? next.footKey![i * 4 + 3]! : punchLift * reads.heelScale;
      const lift = Math.max(keyLift, (i === 1 ? reads.heelRear * rhythm : 0), reads.heelBoth) * (1 - fallK);
      ankle.y += body.bootH + lift;

      hipJ[i]!.set(0, 0, s * d.hipJ).applyQuaternion(qHips).add(H);
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
      // The knee on the slip's side turns in as the weight lands on it.
      const slipKnee = slipLat !== 0 && Math.sign(slipLat) === Math.sign(s) ? Math.min(1, Math.abs(slipLat) / Math.max(1e-3, c.slipHeadOffset)) * c.rigSlipKneeIn : 0;
      pole.set(c.rigKneePoleFwd * Math.cos(yawL), 0, -c.rigKneePoleFwd * Math.sin(yawL)).addScaledVector(ZAXIS, s * (c.rigKneePoleOut - slipKnee - (cp.on && i === pushFoot ? cp.push * c.rigChainKneeIn : 0) - reads.kneeIn * 0.5));   // (kneeIn: rocked, the legs gone — both knees fall in)
      skAnkle[i]!.copy(ankle); skKneePole[i]!.copy(pole);   // skelOn: the leg's targets (core IK, knee limited)
      solveTwoBone(hipJ[i]!, ankle, body.thigh, body.shin, pole, 1, ik);
      const lb = legBones(i);
      placeChain(lb.thigh, lb.knee, lb.shin, hipJ[i]!, ik.mid, ankle, hingeLeg[i]!, -1, 1);
      // Trunks hem: rides the thigh (cloth.ts springs it).
      const bHem = bone(lb.hem);
      bHem.quaternion.copy(bone(lb.thigh).quaternion);
      bHem.position.set(0, -d.trunkLen, 0).applyQuaternion(bHem.quaternion).add(hipJ[i]!);
      bHem.scale.set(1, 1, 1);
      // Cloth on a spring: the hem's place is chased in WORLD space, so it lags the leg and the hips and swings past.
      const hsp = hemS[i]!;
      v2.copy(bHem.position);
      toWorldV(v2);
      if (!sprungInit || Math.hypot(hsp.x - v2.x, hsp.y - v2.y, hsp.z - v2.z) > 0.6) { hsp.x = v2.x; hsp.y = v2.y; hsp.z = v2.z; hsp.vx = hsp.vy = hsp.vz = 0; }
      chase3(hsp, v2.x, v2.y, v2.z, c.rigClothK, c.rigClothZeta, dt);
      let ox = hsp.x - v2.x, oy = hsp.y - v2.y, oz = hsp.z - v2.z;
      const ol = Math.hypot(ox, oy, oz);
      if (ol > c.rigClothMax) { const k = c.rigClothMax / ol; ox *= k; oy *= k; oz *= k; hsp.x = v2.x + ox; hsp.y = v2.y + oy; hsp.z = v2.z + oz; }
      v2.set(hsp.x, hsp.y, hsp.z);
      bHem.position.copy(toLocalV(v2));
      skHem[i]!.copy(bHem.position);
      const bBoot = bone(lb.boot);
      bBoot.position.copy(ankle);
      bBoot.quaternion.setFromAxisAngle(YAXIS, yawL);
      if (lift > 0) bBoot.quaternion.multiply(qTmp.setFromAxisAngle(ZAXIS, -Math.asin(Math.min(1, lift / (d.footLen * 0.72)))));
      else if (reads.toeUp > 1e-3) bBoot.quaternion.multiply(qTmp.setFromAxisAngle(ZAXIS, reads.toeUp * 16 * DEG));   // rocked back on the heels: the toes come off the canvas
      bBoot.scale.set(1, 1, 1);
      skFoot[i]!.copy(bBoot.quaternion);
      chainOut.footYaw[i] = pivotYaw; chainOut.heel[i] = lift;
      chainOut.kneeIn[i] = -s * (ik.mid.z - (hipJ[i]!.z + ankle.z) / 2);
      if (i === 0) { dbgPts[J.hp0]!.copy(hipJ[0]!); dbgPts[J.kn0]!.copy(ik.mid); dbgPts[J.an0]!.copy(ankle); }
      else { dbgPts[J.hp1]!.copy(hipJ[1]!); dbgPts[J.kn1]!.copy(ik.mid); dbgPts[J.an1]!.copy(ankle); }
    }

    // anim Phase 1.1: everything above was a target; fit the skeleton to it, clamp it, and pose the bone hierarchy.
    if (c.skelOn) poseSkeleton(body, c);
    skelView.visible = c.skelOn && c.skelDebug;

    // Debug overlay.
    debug.visible = c.debugSkeleton;
    if (c.debugSkeleton) {
      dbgPts[J.hips]!.copy(H); dbgPts[J.shoulders]!.copy(S); dbgPts[J.neckBase]!.copy(neckBase); dbgPts[J.head]!.copy(headL);
      dbgPts[J.sh0]!.copy(shoulderJ[0]!); dbgPts[J.el0]!.copy(bone(BONE.forearm0).position); dbgPts[J.gl0]!.copy(gloveL[0]);
      dbgPts[J.sh1]!.copy(shoulderJ[1]!); dbgPts[J.el1]!.copy(bone(BONE.forearm1).position); dbgPts[J.gl1]!.copy(gloveL[1]);
      debug.update(dbgPts, DEBUG_BONES);
    }

    // Materials + outline toggle (live), and this fighter's read.
    updateMaterials(c);
    setGlow(mat!, c.readEnabled ? glowAmt * c.readGlowStrength : 0, c.readGlowColor);
    r.outline.visible = c.outlines;
    // Face and body state: what the fight has done to him (reads.ts, from FighterState and the events), or what
    // a host set through setFace / setBodyState if that is more — eased so nothing pops.
    const kF = 1 - Math.exp(-dt * 14);
    const infl = r.body.morphTargetInfluences;
    for (let k = 0; k < MORPHS.length; k++) {
      const name = MORPHS[k]!;
      faceNow[name] += (Math.max(faceTarget[name], reads[name]) - faceNow[name]) * kF;
      if (infl) infl[k] = faceNow[name];
    }
    const u = mat!.uniforms;
    u.uSweat.value += (Math.max(bodyTarget.sweat, reads.sweat) - u.uSweat.value) * kF;
    u.uRedden.value.x += (Math.max(bodyTarget.reddenHead, reads.reddenHead) - u.uRedden.value.x) * kF;
    u.uRedden.value.y += (Math.max(bodyTarget.reddenBody, reads.reddenBodyR) - u.uRedden.value.y) * kF;   // the torso's right (the liver side)
    u.uRedden.value.z += (Math.max(bodyTarget.reddenBody, reads.reddenBodyL) - u.uRedden.value.z) * kF;   // and its left
    // Cuts and swelling are painted into the damage layer; repaint only when one has moved a step.
    let key = '';
    for (const p of CUT_PLACES) { const sev = Math.max(cuts[p] ?? 0, reads.cuts[p]); mergedCuts[p] = sev; key += Math.round(sev * 12) + ','; }
    const swL = Math.max(faceTarget.swellL, reads.swellL), swR = Math.max(faceTarget.swellR, reads.swellR);
    key += Math.round(swL * 12) + ',' + Math.round(swR * 12);
    if (key !== damageKey) { damageKey = key; r.atlas.setDamage(mergedCuts, [swL, swR]); }

    sprungInit = true;
    root.updateMatrixWorld(true);
  }

  const clamp1 = (x: number | undefined, was: number): number => x === undefined ? was : x < 0 ? 0 : x > 1 ? 1 : x;
  const setFace = (f: FaceState): void => {
    faceTarget.wince = clamp1(f.wince, faceTarget.wince);
    faceTarget.mouthOpen = clamp1(f.mouthOpen, faceTarget.mouthOpen);
    if (f.swell) { faceTarget.swellL = clamp1(f.swell[0], faceTarget.swellL); faceTarget.swellR = clamp1(f.swell[1], faceTarget.swellR); }
    if (f.cuts) cuts = { ...cuts, ...f.cuts };
    damageKey = '';   // repainted on the next frame
  };
  const setBodyState = (b: BodyState): void => {
    bodyTarget.sweat = clamp1(b.sweat, bodyTarget.sweat);
    if (b.redden) { bodyTarget.reddenHead = clamp1(b.redden.head, bodyTarget.reddenHead); bodyTarget.reddenBody = clamp1(b.redden.body, bodyTarget.reddenBody); }
  };
  probe.setFace = setFace;
  probe.setBodyState = setBodyState;
  probe.portrait = (on: boolean): void => { portrait = on; };
  probe.override = (o): void => { stateOverride = o; };
  probe.feed = (p, n, ev): void => apply(p, n, 1, SIM_DT, ev);
  probe.freeze = (on): void => { frozen = on; };
  if (probing) installRigReplay(cfg, () => (window.__rig ?? {}) as Partial<Record<Side, ReplayFeed>>);
  probe.sprayCount = (): number => spray.active;
  probe.skelDiverge = () => ({ ...skDiverge });
  probe.chain = () => ({ hipYaw: chainOut.hipYaw, hipY: chainOut.hipY, hipLat: chainOut.hipLat, footYaw: [chainOut.footYaw[0]!, chainOut.footYaw[1]!], heel: [chainOut.heel[0]!, chainOut.heel[1]!], kneeIn: [chainOut.kneeIn[0]!, chainOut.kneeIn[1]!] });
  probe.footPos = () => [{ x: feet[0].out.x, y: feet[0].out.y, z: feet[0].out.z }, { x: feet[1].out.x, y: feet[1].out.y, z: feet[1].out.z }];

  return {
    side,
    apply,
    highlight(strength: number): void { glowAmt = strength > 1 ? 1 : strength < 0 ? 0 : strength; },
    setFace,
    setBodyState,
    dispose(): void {
      if (rig) { rig.dispose(); rig = null; }
      if (mat) { mat.dispose(); mat = null; }
      spray.dispose();
      debug.dispose();
      skelView.dispose();
      root.removeFromParent();
      if (probing && window.__rig) delete window.__rig[side];
    },
  };
}

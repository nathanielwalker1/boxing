/**
 * human/referee.ts — the Meshy referee (public/fighter/referee.glb, built by tools/blender/build_referee.mjs; the
 * boxers' 52-bone Mixamo skeleton). Drawn only: ui/referee.ts still decides where he stands, where he faces and where
 * his hands go; this draws that state on the skinned man instead of the old rig.
 *
 *   await preloadReferee();                       // once (ui/referee.ts starts it in human mode)
 *   const v = createRefereeBody(cfg, scene);      // null until loaded
 *   v.apply(state, dt);                           // state = ui/referee.ts's FighterState (pos, vel, yaw, gloves)
 *
 * Pose per frame, from the rest T-pose: the body placed and turned like the fighters (yaw -> rotation.y = pi/2 - yaw);
 * a slow weight shift side to side while he stands (refSway*); a stride while he walks, its phase from the distance
 * covered (refStride*); each arm bent by two-bone IK onto the hand point ui/referee.ts chose (hang, the winner's arm
 * up, the wave-off), the elbow pointed back and out.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { REFEREE, type Config, type FighterState } from '../core';

let src: { scene: THREE.Object3D; height: number } | null = null;
let loading: Promise<void> | null = null;

/** Load referee.glb once. Safe to call every frame. */
export function preloadReferee(): Promise<void> {
  if (!loading) {
    loading = new GLTFLoader().loadAsync('/fighter/referee.glb').then(g => {
      const ex = (g.parser.json as { asset?: { extras?: { height?: number } } }).asset?.extras;
      src = { scene: g.scene, height: ex?.height ?? 1.8 };
    }, e => { console.info('referee.glb not loaded; the old referee draws', e); });
  }
  return loading;
}
export const refereeReady = (): boolean => src !== null;

export interface RefereeBody { apply(s: FighterState, dt: number): void; dispose(): void }

const SIDES = ['Left', 'Right'] as const;
const UP = new THREE.Vector3(0, 1, 0);
const qP = new THREE.Quaternion(), qL = new THREE.Quaternion(), qT = new THREE.Quaternion();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3();

/** Apply a WORLD-space rotation r to bone b about its own pivot (as human/view.ts). */
function rotateWorld(b: THREE.Object3D, r: THREE.Quaternion): void {
  b.parent!.getWorldQuaternion(qP);
  qL.copy(qP).invert().multiply(r).multiply(qP);
  b.quaternion.premultiply(qL);
  b.updateMatrixWorld(true);
}
/** Turn bone b about its pivot so the direction from it to `child` points along `dir` (world). */
function aim(b: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3): void {
  b.getWorldPosition(vA); child.getWorldPosition(vB);
  vB.sub(vA).normalize();
  rotateWorld(b, qT.setFromUnitVectors(vB, vC.copy(dir).normalize()));
}

export function createRefereeBody(cfg: Config, parent: THREE.Object3D): RefereeBody | null {
  if (!src) { void preloadReferee(); return null; }
  const root = cloneSkinned(src.scene);
  const group = new THREE.Group();
  group.add(root);
  group.scale.setScalar(REFEREE.heightM / src.height);
  root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; } });
  parent.add(group);
  const bones = new Map<string, THREE.Bone>();
  root.traverse(o => { if ((o as THREE.Bone).isBone) bones.set(o.name.replace('mixamorig', '').replace(':', ''), o as THREE.Bone); });
  const bone = (n: string): THREE.Bone => { const b = bones.get(n); if (!b) throw new Error('referee.glb: no bone ' + n); return b; };
  const rest = [...bones.values()].map(b => [b, b.quaternion.clone(), b.position.clone()] as const);
  const hips = bone('Hips');
  const arm = SIDES.map(s => [bone(s + 'Arm'), bone(s + 'ForeArm'), bone(s + 'Hand')] as const);
  const leg = SIDES.map(s => [bone(s + 'UpLeg'), bone(s + 'Leg'), bone(s + 'Foot')] as const);
  let t = 0, stride = 0, walkAmt = 0;

  return {
    apply(s, dt) {
      t += dt;
      for (const [b, q, p] of rest) { b.quaternion.copy(q); b.position.copy(p); }
      group.position.set(s.pos.x, 0, s.pos.z);
      group.rotation.y = Math.PI / 2 - s.yaw;
      const F = vD.set(Math.cos(s.yaw), 0, Math.sin(s.yaw));            // his forward on the floor
      const R = new THREE.Vector3(-F.z, 0, F.x);                        // his right (F x up)
      const speed = Math.hypot(s.vel.x, s.vel.z);
      walkAmt += (Math.min(1, speed / cfg.refStrideFullSpeed) - walkAmt) * (1 - Math.exp(-8 * dt));
      stride += speed * dt / cfg.refStrideM * Math.PI;                  // one stride (one foot forward) = half a cycle
      // standing: the weight drifts from foot to foot; walking: the hips bob twice per cycle
      const sway = Math.sin(t * cfg.refSwayHz * 2 * Math.PI) * (1 - walkAmt);
      const k = 1 / group.scale.x;                                      // bone positions are in the glb's own metres
      hips.position.x += sway * cfg.refSwayM * k;
      hips.position.y -= (Math.abs(Math.cos(stride)) * 0.02 * walkAmt + cfg.refSwayDropM * Math.abs(sway)) * k;
      root.updateMatrixWorld(true);
      rotateWorld(hips, qT.setFromAxisAngle(F, -sway * cfg.refSwayRollDeg * Math.PI / 180));

      // ── legs: swing about his right axis, the knee bends on the forward swing ──
      for (const i of [0, 1] as const) {
        const ph = stride + (i === 0 ? 0 : Math.PI);
        const swing = Math.sin(ph) * cfg.refLegSwingDeg * walkAmt * Math.PI / 180;
        const knee = Math.max(0, Math.cos(ph)) * cfg.refKneeDeg * walkAmt * Math.PI / 180;
        const [up, low, foot] = leg[i]!;
        // a standing man unloads the leg his weight is off: a touch of knee on the far side of the sway
        const ease = Math.max(0, (i === 0 ? -1 : 1) * sway) * cfg.refSwayKneeDeg * Math.PI / 180;
        rotateWorld(up, qT.setFromAxisAngle(R, -swing));
        rotateWorld(low, qT.setFromAxisAngle(R, knee + ease));
        rotateWorld(foot, qT.setFromAxisAngle(R, -(knee + ease) * 0.5 + swing * 0.3));
      }

      // ── arms: two-bone IK onto ui/referee.ts's hand points (gloves[0] = lead = his left, orthodox) ──
      root.updateMatrixWorld(true);
      for (const i of [0, 1] as const) {
        const [up, fore, hand] = arm[i]!;
        const g = s.gloves[i]!.pos;
        const T = new THREE.Vector3(g.x, g.y, g.z);
        const S = up.getWorldPosition(new THREE.Vector3());
        const Ew = fore.getWorldPosition(new THREE.Vector3()), Ww = hand.getWorldPosition(new THREE.Vector3());
        const a = S.distanceTo(Ew), b = Ew.distanceTo(Ww);
        const toT = T.clone().sub(S);
        const c = Math.max(Math.abs(a - b) + 1e-3, Math.min(a + b - 1e-3, toT.length()));
        toT.normalize();
        // the elbow points back and out (and down), whatever the hand does
        const out = R.clone().multiplyScalar(i === 0 ? -1 : 1);
        const pole = F.clone().multiplyScalar(-1).add(out.multiplyScalar(0.6)).addScaledVector(UP, -0.4);
        pole.addScaledVector(toT, -pole.dot(toT));
        if (pole.lengthSq() < 1e-8) pole.copy(out);
        pole.normalize();
        const cosA = (a * a + c * c - b * b) / (2 * a * c);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        const E = S.clone().addScaledVector(toT, a * cosA).addScaledVector(pole, a * sinA);
        aim(up, fore, E.clone().sub(S));
        aim(fore, hand, T.clone().sub(fore.getWorldPosition(new THREE.Vector3())));
      }
      root.updateMatrixWorld(true);
    },
    dispose() {
      parent.remove(group);
      root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    },
  };
}

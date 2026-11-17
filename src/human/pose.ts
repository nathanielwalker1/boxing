// Poses the boxer GLB's Mixamo-named skeleton into an orthodox guard by setting bone rotations.
// No IK library: rotations are applied in WORLD space ("aim this bone's child along that direction"),
// so it does not depend on the bone roll the exporter gave each joint. Pose frame: the character
// faces +Z, its left side is +X, up is +Y. Metres.
import * as THREE from 'three';


const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const rad = (d: number) => (d * Math.PI) / 180;

function bone(root: THREE.Object3D, name: string): THREE.Bone {
  // GLTFLoader strips ':' from node names, so "mixamorig:Hips" arrives as "mixamorigHips".
  const b = root.getObjectByName('mixamorig' + name) ?? root.getObjectByName('mixamorig:' + name);
  if (!b) throw new Error('bone missing: ' + name);
  return b as THREE.Bone;
}
const wpos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

function setWorldQuat(b: THREE.Object3D, wq: THREE.Quaternion): void {
  const pq = (b.parent as THREE.Object3D).getWorldQuaternion(new THREE.Quaternion());
  b.quaternion.copy(pq.invert().multiply(wq));
  b.updateMatrixWorld(true);
}
/** Rotate a bone about a world axis through its own joint. */
function spin(b: THREE.Object3D, axis: THREE.Vector3, deg: number): void {
  const wq = b.getWorldQuaternion(new THREE.Quaternion());
  wq.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, rad(deg)));
  setWorldQuat(b, wq);
}
/** Minimal world rotation that turns the bone→child line onto `dir`. */
function aim(b: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3): void {
  const cur = wpos(child).sub(wpos(b)).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
  const wq = b.getWorldQuaternion(new THREE.Quaternion()).premultiply(q);
  setWorldQuat(b, wq);
}

/** Two-bone IK in world space: put `end` on `target`, bend towards `pole`. */
function ik(upper: THREE.Object3D, lower: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): THREE.Vector3 {
  const a = wpos(upper), k = wpos(lower), e = wpos(end);
  const l1 = a.distanceTo(k), l2 = k.distanceTo(e);
  const to = target.clone().sub(a);
  let d = to.length();
  const u = to.clone().divideScalar(d);
  d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(d, (l1 + l2) * 0.9995));
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const pv = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u))).normalize();
  const knee = a.clone().addScaledVector(u, l1 * cosA).addScaledVector(pv, l1 * sinA);
  const reached = a.clone().addScaledVector(u, d);
  aim(upper, lower, knee.clone().sub(a));
  aim(lower, end, reached.clone().sub(wpos(lower)));
  return reached;
}

// ---- the guard (every number here is a pose choice, not a game tunable) ----
export type PoseName = 'guard' | 'reach';

/** 'guard' = orthodox guard; 'reach' = stress pose: lead arm straight out at shoulder height, deep knee bend. */
export function guard(root: THREE.Object3D, pose: PoseName = 'guard'): void {
  const reach = pose === 'reach';
  root.updateMatrixWorld(true);
  const B = (n: string) => bone(root, n);
  const hips = B('Hips'), sp0 = B('Spine'), sp1 = B('Spine1'), sp2 = B('Spine2'), neck = B('Neck'), head = B('Head');
  const YAW = -26;   // hips; the chest adds more. Negative = left (lead) side turns toward the opponent (+Z)

  // 1. hips: down and a little forward of centre, turned, leaning
  const rest = wpos(hips);
  const hipsAt = v3(-0.06, reach ? 0.72 : 0.865, 0.04);
  hips.position.copy((hips.parent as THREE.Object3D).worldToLocal(hipsAt.clone()));
  hips.updateMatrixWorld(true);
  void rest;
  spin(hips, AXIS_Y, YAW);
  spin(hips, AXIS_X, 3);
  for (const [b, yaw, pitch] of [[sp0, -6, 3], [sp1, -6, 4], [sp2, -5, 4]] as const) {
    spin(b, AXIS_Y, yaw);
    spin(b, AXIS_X, pitch);
  }
  // head back round to face the opponent, chin tucked
  spin(neck, AXIS_Y, 21);
  spin(neck, AXIS_X, -2);
  spin(head, AXIS_Y, 22);
  spin(head, AXIS_X, 1);

  // 2. legs: lead (left) foot forward and flat, rear (right) foot back and out, heel up
  const legs: Array<[string, THREE.Vector3, THREE.Vector3, THREE.Vector3, number]> = [
    ['Left', v3(0.11, 0.073, 0.31), v3(0.12, 0, 1).normalize(), v3(0.15, 0, 1), 0],
    ['Right', v3(-0.27, 0.073 + 0.075, -0.21), v3(-0.62, 0, 0.78).normalize(), v3(-0.55, 0, 0.85), 0.075],
  ];
  for (const [side, ankle, toeDir, pole, heel] of legs) {
    const up = B(side + 'UpLeg'), leg = B(side + 'Leg'), foot = B(side + 'Foot'), toe = B(side + 'ToeBase');
    ik(up, leg, foot, ankle, pole);
    // foot: ankle→ball line, ball stays on the floor; toes flat
    const restToe = wpos(toe).sub(wpos(foot));
    const len = restToe.length();
    const dir = toeDir.clone().multiplyScalar(Math.sqrt(Math.max(0, len * len - (0.043 + heel) ** 2))).add(v3(0, -(0.043 + heel), 0));
    aim(foot, toe, dir);
    const flat = toeDir.clone().multiplyScalar(0.146).add(v3(0, -0.043, 0));
    const q = new THREE.Quaternion().setFromUnitVectors(dir.clone().normalize(), flat.normalize());
    setWorldQuat(toe, toe.getWorldQuaternion(new THREE.Quaternion()).premultiply(q));
  }

  // 3. arms
  const th = rad(YAW - 17);
  const fwdC = v3(Math.sin(th), 0, Math.cos(th));      // chest facing
  const sideL = v3(Math.cos(th), 0, -Math.sin(th));    // chest's left
  const opp = v3(0, 0, 1);
  const hd = wpos(head);
  const L = { up: B('LeftArm'), fore: B('LeftForeArm'), hand: B('LeftHand'), mid: B('LeftHandMiddle1') };
  const R = { up: B('RightArm'), fore: B('RightForeArm'), hand: B('RightHand'), mid: B('RightHandMiddle1') };
  const lSh = wpos(L.up);
  // lead glove: out in front of the lead shoulder at chin height; elbow down
  const leadWrist = reach
    ? lSh.clone().addScaledVector(opp, 0.7).addScaledVector(sideL, -0.03)   // shoulder height, fully extended
    : lSh.clone().addScaledVector(opp, 0.33).add(v3(0, 0.05, 0)).addScaledVector(sideL, -0.02);
  ik(L.up, L.fore, L.hand, leadWrist, v3(0, -1, 0).addScaledVector(sideL, 0.5));
  aim(L.hand, L.mid, reach ? opp.clone().add(v3(0, 0.1, 0)) : opp.clone().multiplyScalar(0.8).add(v3(0, 0.6, 0)));
  // rear glove: at the cheek, elbow tucked in against the ribs
  const rearWrist = hd.clone().addScaledVector(fwdC, 0.15).addScaledVector(sideL, -0.03).add(v3(0, -0.09, 0));
  ik(R.up, R.fore, R.hand, rearWrist, v3(0, -1, 0).addScaledVector(fwdC, 0.35).addScaledVector(sideL, 0.2));
  aim(R.hand, R.mid, v3(0, 0.85, 0).addScaledVector(fwdC, 0.3).addScaledVector(sideL, 0.3));
  root.updateMatrixWorld(true);
}

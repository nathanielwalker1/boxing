/**
 * rig/debug.ts — cfg.debugSkeleton overlay: joints as one InstancedMesh of
 * small spheres, bones as one LineSegments. Two draw calls, drawn on top.
 * SkelDebugView (cfg.skelDebug, anim Phase 1.1): the fitted core skeleton — bones, and each joint's limits drawn
 * where they are: the swing cone's outline (the elliptical limit, swept with the bone at a fraction of its length)
 * with four spokes, a hinge's range as an arc. Three draw calls, dev only.
 */
import * as THREE from 'three';
import { JOINT_COUNT, JOINT_PARENT, SKJ, qFromRotVec, qMul, qRot, type JointLimit, type Quat, type SkelDef, type SkelFK, type SkelPose, type Vec3 } from '../core';

/** The bone a joint swings, as a rest direction in its own frame, and how long to draw its limit (m). */
function boneDir(def: SkelDef, j: number): { dir: Vec3; len: number } {
  for (let k = j + 1; k < JOINT_COUNT; k++) if (JOINT_PARENT[k] === j) {
    const o = def.off[k]!, l = def.len[k]!;
    if (l > 1e-6 && !(j === SKJ.chest && k !== SKJ.neck)) return { dir: { x: o.x / l, y: o.y / l, z: o.z / l }, len: l };
  }
  if (j === SKJ.head) return { dir: { x: 0, y: 1, z: 0 }, len: def.headCentre * 2 };
  if (j === 9 || j === 13) return { dir: { x: 0, y: -1, z: 0 }, len: 0.08 };   // hands
  return { dir: { x: 1, y: 0, z: 0 }, len: 0.12 };   // feet: the toe
}

export class SkelDebugView {
  readonly group = new THREE.Group();
  private joints: THREE.InstancedMesh;
  private bones: THREE.LineSegments;
  private limits: THREE.LineSegments;
  private bonePos: THREE.BufferAttribute;
  private limPos: THREE.BufferAttribute;
  private geo = new THREE.SphereGeometry(1, 6, 5);
  private jointMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false });
  private boneMat = new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false });
  private limMat = new THREE.LineBasicMaterial({ color: 0xff4fd8, depthTest: false, transparent: true, opacity: 0.8 });
  private m = new THREE.Matrix4();
  private static readonly SAMPLES = 16;
  private static readonly MAX_LIM = JOINT_COUNT * (SkelDebugView.SAMPLES + 4);

  constructor() {
    this.joints = new THREE.InstancedMesh(this.geo, this.jointMat, JOINT_COUNT + 1);
    this.joints.renderOrder = 999; this.joints.frustumCulled = false;
    this.bonePos = new THREE.BufferAttribute(new Float32Array((JOINT_COUNT + 1) * 6), 3);
    this.bonePos.setUsage(THREE.DynamicDrawUsage);
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', this.bonePos);
    this.bones = new THREE.LineSegments(bg, this.boneMat);
    this.limPos = new THREE.BufferAttribute(new Float32Array(SkelDebugView.MAX_LIM * 6), 3);
    this.limPos.setUsage(THREE.DynamicDrawUsage);
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', this.limPos);
    this.limits = new THREE.LineSegments(lg, this.limMat);
    for (const o of [this.bones, this.limits]) { o.renderOrder = 999; o.frustumCulled = false; }
    this.group.add(this.joints, this.bones, this.limits);
    this.group.visible = false;
  }

  set visible(v: boolean) { this.group.visible = v; }

  /** `f` is the FK of `pose` in the group's frame (the rig root). */
  update(def: SkelDef, pose: SkelPose, f: SkelFK, lim: readonly (JointLimit | null)[]): void {
    void pose;
    const b = this.bonePos.array as Float32Array, L = this.limPos.array as Float32Array;
    let nb = 0, nl = 0;
    const seg = (arr: Float32Array, n: number, a: Vec3, c: Vec3): void => {
      arr[n * 6] = a.x; arr[n * 6 + 1] = a.y; arr[n * 6 + 2] = a.z; arr[n * 6 + 3] = c.x; arr[n * 6 + 4] = c.y; arr[n * 6 + 5] = c.z;
    };
    for (let j = 0; j < JOINT_COUNT; j++) {
      const p = f.p[j]!;
      this.m.makeScale(0.014, 0.014, 0.014).setPosition(p.x, p.y, p.z);
      this.joints.setMatrixAt(j, this.m);
      if (j > 0) seg(b, nb++, f.p[JOINT_PARENT[j]!]!, p);
    }
    const hc = qRot(f.r[SKJ.head]!, { x: 0, y: def.headCentre, z: 0 }), ph = f.p[SKJ.head]!;
    const hcp = { x: ph.x + hc.x, y: ph.y + hc.y, z: ph.z + hc.z };
    seg(b, nb++, ph, hcp);
    this.m.makeScale(0.02, 0.02, 0.02).setPosition(hcp.x, hcp.y, hcp.z);
    this.joints.setMatrixAt(JOINT_COUNT, this.m);
    this.joints.count = JOINT_COUNT + 1;
    this.joints.instanceMatrix.needsUpdate = true;
    // Limits: sample the swing boundary in the joint's PARENT frame (the limit is on the local rotation).
    const N = SkelDebugView.SAMPLES;
    for (let j = 1; j < JOINT_COUNT; j++) {
      const lm = lim[j];
      if (!lm) continue;
      const side = def.side[j]!;
      const { dir, len } = boneDir(def, j);
      const Rp: Quat = f.r[JOINT_PARENT[j]!]!, o = f.p[j]!;
      const [ia, ib] = lm.twist === 0 ? [1, 2] : lm.twist === 1 ? [0, 2] : [0, 1];
      const pts: Vec3[] = [];
      const hingeA = !(lm.hi[ia]! > 0) && !(-lm.lo[ia]! > 0), hingeB = !(lm.hi[ib]! > 0) && !(-lm.lo[ib]! > 0);
      for (let s = 0; s <= N; s++) {
        const r = [0, 0, 0];
        if (hingeA || hingeB) {
          const ax = hingeA ? ib : ia, t = s / N;
          r[ax] = lm.lo[ax]! + (lm.hi[ax]! - lm.lo[ax]!) * t;
        } else {
          const th = (s / N) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
          r[ia] = cs * (cs >= 0 ? lm.hi[ia]! : -lm.lo[ia]!);
          r[ib] = sn * (sn >= 0 ? lm.hi[ib]! : -lm.lo[ib]!);
        }
        // A left joint's limits are the right side's mirrored (z → −z): a rotation vector's x and y flip.
        const rv = side < 0 ? { x: -r[0]!, y: -r[1]!, z: r[2]! } : { x: r[0]!, y: r[1]!, z: r[2]! };
        const d = qRot(qMul(Rp, qFromRotVec(rv)), dir);
        pts.push({ x: o.x + d.x * len * 0.55, y: o.y + d.y * len * 0.55, z: o.z + d.z * len * 0.55 });
      }
      for (let s = 0; s < N && nl < SkelDebugView.MAX_LIM; s++) seg(L, nl++, pts[s]!, pts[s + 1]!);
      for (let s = 0; s < N && nl < SkelDebugView.MAX_LIM; s += N / 4) seg(L, nl++, o, pts[s]!);
    }
    this.bones.geometry.setDrawRange(0, nb * 2);
    this.limits.geometry.setDrawRange(0, nl * 2);
    this.bonePos.needsUpdate = true;
    this.limPos.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose(); this.jointMat.dispose(); this.boneMat.dispose(); this.limMat.dispose();
    this.bones.geometry.dispose(); this.limits.geometry.dispose(); this.joints.dispose();
  }
}

export class SkeletonDebug {
  readonly group = new THREE.Group();
  private joints: THREE.InstancedMesh;
  private lines: THREE.LineSegments;
  private linePos: THREE.BufferAttribute;
  private geo = new THREE.SphereGeometry(1, 6, 5);
  private jointMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false });
  private lineMat = new THREE.LineBasicMaterial({ color: 0x3fd2ff, depthTest: false });
  private m = new THREE.Matrix4();

  constructor(private maxJoints: number, private maxBones: number, private jointR: number) {
    this.joints = new THREE.InstancedMesh(this.geo, this.jointMat, maxJoints);
    this.joints.renderOrder = 999;
    this.joints.frustumCulled = false;
    this.linePos = new THREE.BufferAttribute(new Float32Array(maxBones * 6), 3);
    this.linePos.setUsage(THREE.DynamicDrawUsage);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', this.linePos);
    this.lines = new THREE.LineSegments(lg, this.lineMat);
    this.lines.renderOrder = 999;
    this.lines.frustumCulled = false;
    this.group.add(this.joints, this.lines);
    this.group.visible = false;
  }

  set visible(v: boolean) { this.group.visible = v; }

  /** `pts` in the group's local frame; `bones` are index pairs into `pts`. */
  update(pts: readonly THREE.Vector3[], bones: readonly (readonly [number, number])[]): void {
    const n = Math.min(pts.length, this.maxJoints);
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      this.m.makeScale(this.jointR, this.jointR, this.jointR).setPosition(p.x, p.y, p.z);
      this.joints.setMatrixAt(i, this.m);
    }
    this.joints.count = n;
    this.joints.instanceMatrix.needsUpdate = true;
    const nb = Math.min(bones.length, this.maxBones);
    const arr = this.linePos.array as Float32Array;
    for (let i = 0; i < nb; i++) {
      const [a, b] = bones[i]!;
      const pa = pts[a]!, pb = pts[b]!;
      arr[i * 6] = pa.x; arr[i * 6 + 1] = pa.y; arr[i * 6 + 2] = pa.z;
      arr[i * 6 + 3] = pb.x; arr[i * 6 + 4] = pb.y; arr[i * 6 + 5] = pb.z;
    }
    this.lines.geometry.setDrawRange(0, nb * 2);
    this.linePos.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.jointMat.dispose();
    this.lineMat.dispose();
    this.lines.geometry.dispose();
    this.joints.dispose();
  }
}

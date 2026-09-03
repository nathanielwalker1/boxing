/**
 * rig/debug.ts — cfg.debugSkeleton overlay: joints as one InstancedMesh of
 * small spheres, bones as one LineSegments. Two draw calls, drawn on top.
 */
import * as THREE from 'three';

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

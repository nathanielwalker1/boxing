/**
 * human/stains.ts — what a fight leaves on the canvas: blood off a cut man, sweat off a wet one. Flat blots lying on the
 * ring floor (y = 0), drawn by MULTIPLYING the canvas under them (blood darkens it to red-brown, sweat to a damp grey),
 * so they sit in the picture like paint rather than glowing on top of it. They stay for the whole fight.
 * Drawn only: the sim never reads them. Scatter is a seeded generator (no Math.random), as rig/spray.ts.
 */
import * as THREE from 'three';

const MAX = 320;

export class Stains {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private count = 0;
  private seed = 7;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(parent: THREE.Object3D) {
    const geo = new THREE.CircleGeometry(1, 10);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, depthWrite: false, fog: false, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,   // result = stain colour × canvas
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.name = 'canvasStains';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    parent.add(this.mesh);
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /**
   * `n` blots thrown from the floor point under `from` along `dir` (x, z): each lands `near`..`far` metres out, up to
   * `spread` metres to either side, `size` metres across (0.6..1.4 of it), stretched along the throw. The oldest are reused past MAX.
   */
  splat(n: number, from: { x: number; z: number }, dir: { x: number; z: number }, near: number, far: number, spread: number, size: number, color: THREE.Color): void {
    const dl = Math.hypot(dir.x, dir.z) || 1, dx = dir.x / dl, dz = dir.z / dl;
    for (let k = 0; k < n; k++) {
      const d = near + (far - near) * this.rnd(), side = (this.rnd() * 2 - 1) * spread;
      const r = size * 0.5 * (0.6 + 0.8 * this.rnd());
      this.p.set(from.x + dx * d - dz * side, 0.003, from.z + dz * d + dx * side);
      this.q.setFromAxisAngle(Stains.UP, Math.atan2(-dz, dx) + (this.rnd() - 0.5) * 0.6);
      this.s.set(r * (1 + 0.9 * this.rnd()), 1, r);
      this.m.compose(this.p, this.q, this.s);
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.count = Math.min(MAX, this.count + 1);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, color);
    }
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  get active(): number { return this.count; }

  /** A new fight: a clean canvas. */
  clear(): void { this.next = 0; this.count = 0; this.mesh.count = 0; }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

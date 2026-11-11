/**
 * rig/spray.ts — sweat thrown off the head by a clean or flush shot (overhaul
 * phase 2; made to read in phase 3). A pooled burst: one InstancedMesh of
 * small droplets per fighter, in WORLD space, hidden (and not drawn) while
 * none is alive. The droplets are scene-lit AND a little self-lit, so the
 * rim lights catch them and they still show against the dark arena; they fly
 * off along the punch in a fan, fall, and are gone in under a second. How
 * many is the read: none for a glancing shot, a few for a clean one, a burst
 * for a flush one on a fighter who is wet.
 */
import * as THREE from 'three';

const MAX = 48;
const GRAVITY = 5;

export class Spray {
  readonly mesh: THREE.InstancedMesh;
  private px = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private age = new Float32Array(MAX).fill(1e9);
  private life = new Float32Array(MAX).fill(1);
  private size = new Float32Array(MAX);
  private next = 0;
  private alive = 0;
  private seed = 1;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(parent: THREE.Object3D) {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshPhongMaterial({ color: 0xeef4fa, emissive: 0x8fa3b8, emissiveIntensity: 0.9, specular: 0xffffff, shininess: 120, transparent: true, opacity: 0.92, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.name = 'sweatSpray';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this.mesh.count = 0;
    parent.add(this.mesh);
  }

  /** Deterministic scatter (a view is presentation, but a replayed frame should look the same). */
  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** Throw `n` droplets from a world point along a world direction. `size` in metres, `life` in seconds. */
  burst(n: number, at: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, speed: number, size = 0.016, life = 0.8): void {
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    for (let k = 0; k < Math.min(MAX, n); k++) {
      const i = this.next; this.next = (this.next + 1) % MAX;
      const s = speed * (0.35 + 0.9 * this.rnd());
      this.px[i * 3] = at.x + (this.rnd() - 0.5) * 0.1; this.px[i * 3 + 1] = at.y + (this.rnd() - 0.2) * 0.12; this.px[i * 3 + 2] = at.z + (this.rnd() - 0.5) * 0.1;
      // A fan: along the punch, spread wide, and thrown UP so it hangs in the light before it falls.
      this.vel[i * 3] = dir.x / dl * s + (this.rnd() - 0.5) * speed * 0.9;
      this.vel[i * 3 + 1] = dir.y / dl * s + (0.35 + 0.8 * this.rnd()) * speed * 0.55;
      this.vel[i * 3 + 2] = dir.z / dl * s + (this.rnd() - 0.5) * speed * 0.9;
      this.age[i] = 0;
      this.life[i] = life * (0.6 + 0.4 * this.rnd());
      this.size[i] = size * (0.6 + 0.8 * this.rnd());
    }
  }

  get active(): number { return this.alive; }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.age[i]! >= this.life[i]!) continue;
      this.age[i] = this.age[i]! + dt;
      if (this.age[i]! >= this.life[i]!) continue;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! - GRAVITY * dt;
      const drag = Math.exp(-2.6 * dt);
      for (let a = 0; a < 3; a++) { this.vel[i * 3 + a] = this.vel[i * 3 + a]! * drag; this.px[i * 3 + a] = this.px[i * 3 + a]! + this.vel[i * 3 + a]! * dt; }
      if (this.px[i * 3 + 1]! < 0.01) { this.age[i] = 1e9; continue; }
      // A streak along its own travel (a droplet in flight), shrinking as it goes.
      const k = 1 - 0.7 * this.age[i]! / this.life[i]!;
      this.dir.set(this.vel[i * 3]!, this.vel[i * 3 + 1]!, this.vel[i * 3 + 2]!);
      const sp = this.dir.length();
      if (sp > 1e-4) this.q.setFromUnitVectors(Spray.UP, this.dir.divideScalar(sp)); else this.q.identity();
      const sz = this.size[i]! * k;
      this.s.set(sz, sz * (1 + Math.min(2.5, sp * 0.9)), sz);
      this.p.set(this.px[i * 3]!, this.px[i * 3 + 1]!, this.px[i * 3 + 2]!);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.alive = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

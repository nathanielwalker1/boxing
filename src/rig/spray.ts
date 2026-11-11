/**
 * rig/spray.ts — sweat thrown off the head by a clean or flush shot (overhaul
 * phase 2). A pooled burst: one InstancedMesh of small lit droplets per
 * fighter, in WORLD space, hidden (and not drawn) while none is alive. The
 * droplets are scene-lit (the key light catches them), fly off along the
 * punch with some spread, fall, and are gone in about half a second. How many
 * is the read: none for a glancing shot or a dry fighter, a spray for a flush
 * one late in a fight.
 */
import * as THREE from 'three';

const MAX = 48;
const LIFE = 0.55;
const GRAVITY = 6;

export class Spray {
  readonly mesh: THREE.InstancedMesh;
  private px = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private age = new Float32Array(MAX).fill(LIFE);
  private size = new Float32Array(MAX);
  private next = 0;
  private alive = 0;
  private seed = 1;
  private m = new THREE.Matrix4();

  constructor(parent: THREE.Object3D) {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshPhongMaterial({ color: 0xdfe8f2, specular: 0xffffff, shininess: 90, transparent: true, opacity: 0.85 });
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

  /** Throw `n` droplets from a world point along a world direction. */
  burst(n: number, at: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, speed: number): void {
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    for (let k = 0; k < Math.min(MAX, n); k++) {
      const i = this.next; this.next = (this.next + 1) % MAX;
      const s = speed * (0.45 + 0.75 * this.rnd());
      this.px[i * 3] = at.x + (this.rnd() - 0.5) * 0.08; this.px[i * 3 + 1] = at.y + (this.rnd() - 0.3) * 0.1; this.px[i * 3 + 2] = at.z + (this.rnd() - 0.5) * 0.08;
      this.vel[i * 3] = dir.x / dl * s + (this.rnd() - 0.5) * speed * 0.7;
      this.vel[i * 3 + 1] = dir.y / dl * s + (0.2 + 0.6 * this.rnd()) * speed * 0.5;
      this.vel[i * 3 + 2] = dir.z / dl * s + (this.rnd() - 0.5) * speed * 0.7;
      this.age[i] = 0;
      this.size[i] = 0.006 + 0.007 * this.rnd();
    }
  }

  get active(): number { return this.alive; }

  update(dt: number): void {
    let n = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.age[i]! >= LIFE) continue;
      this.age[i] = this.age[i]! + dt;
      if (this.age[i]! >= LIFE) continue;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! - GRAVITY * dt;
      const drag = Math.exp(-2.2 * dt);
      for (let a = 0; a < 3; a++) { this.vel[i * 3 + a] = this.vel[i * 3 + a]! * drag; this.px[i * 3 + a] = this.px[i * 3 + a]! + this.vel[i * 3 + a]! * dt; }
      if (this.px[i * 3 + 1]! < 0.01) { this.age[i] = LIFE; continue; }
      const s = this.size[i]! * (1 - 0.6 * this.age[i]! / LIFE);
      this.m.makeScale(s, s * 1.5, s).setPosition(this.px[i * 3]!, this.px[i * 3 + 1]!, this.px[i * 3 + 2]!);
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

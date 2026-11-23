/**
 * render/ropes.ts — ropes that give (render only; the sim never reads any of this).
 *
 * Each rope of each side is a chain of points on damped springs, anchored at the posts, pulled toward its neighbours
 * (a bow is a curve, not a kink). Every frame the DRAWN bodies' capsules (read from the skeleton bones, not the sim)
 * push the points outward until they clear; when the body leaves, the rope springs back with a short wobble. The bow
 * has a limit; a body the limited rope still cannot hold (a fall beside the ropes) is slid inward as a whole along
 * the floor (an eased offset on his group, after his pose), so no rope passes through him.
 *
 * Time: fixed sub-steps from the frame dt (frame-rate independent). No allocation per frame.
 * Hooked in through scene.onBeforeRender (before the renderer updates matrices), so no other file calls it.
 * Test hook: window.__ropes { update(dt), cost, capsules(side), points() }.
 */
import * as THREE from 'three';
import type { Config } from '../core';

const N = 24;                   // segments per rope
const NP = N + 1;
const SUB = 1 / 240;            // fixed sub-step, s
const RAD = 6;                  // tube sides
const SIDES = 4;
// side k: outward normal (nx, nz), tangent (tx, tz); rope point = n*(h + d) + t*u, u in [-h, h] (matches ring.ts `ends`)
const NX = [0, 1, 0, -1], NZ = [-1, 0, 1, 0], TX = [1, 0, -1, 0], TZ = [0, 1, 0, -1];
const COS = new Float32Array(RAD), SIN = new Float32Array(RAD);
for (let k = 0; k < RAD; k++) { COS[k] = Math.cos(k / RAD * Math.PI * 2); SIN[k] = Math.sin(k / RAD * Math.PI * 2); }
const BONES = ['Hips', 'Spine2', 'Head', 'HeadTop_End', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'] as const;
// joint slots in J: 0 hips, 1 chest, 2 head centre, 3-5 L shoulder / elbow / glove, 6-8 R, 9-11 L hip / knee / ankle, 12-14 R
const J_COUNT = 15;
// capsules: a, b (joint slots), radius key
type RKey = 'ropeTorsoR' | 'ropeHeadR' | 'ropeArmR' | 'ropeForearmR' | 'ropeGloveR' | 'ropeThighR' | 'ropeShinR';
const CAPS: [number, number, RKey][] = [
  [0, 1, 'ropeTorsoR'], [2, 2, 'ropeHeadR'],
  [3, 4, 'ropeArmR'], [4, 5, 'ropeForearmR'], [5, 5, 'ropeGloveR'],
  [6, 7, 'ropeArmR'], [7, 8, 'ropeForearmR'], [8, 8, 'ropeGloveR'],
  [9, 10, 'ropeThighR'], [10, 11, 'ropeShinR'], [12, 13, 'ropeThighR'], [13, 14, 'ropeShinR'],
];

interface Fighter {
  group: THREE.Object3D | null;
  bones: (THREE.Object3D | null)[];
  J: Float64Array;
  off: [number, number];          // the eased inward offset applied, m
  last: [number, number];         // the group position as I last wrote it
  applied: boolean;
  ex: Float64Array;               // per side: the deepest the unshifted body sits past the LIMITED rope, m
  has: boolean;
}

export class Ropes {
  readonly mesh: THREE.Mesh;
  /** a one-triangle mesh whose onBeforeRender finds the scene on the first render */
  readonly trigger: THREE.Mesh;
  private readonly c: Config;
  private readonly h: number;
  private readonly count: number;
  private readonly yRope: number[];
  private readonly d: Float32Array;
  private readonly v: Float32Array;
  private readonly req: Float32Array;
  private readonly prevReq: Float32Array;
  private readonly sinTab = new Float32Array(NP);
  private readonly pos: THREE.BufferAttribute;
  private readonly nor: THREE.BufferAttribute;
  private awake = true;
  /** test hook: render frames take dt 0 (a film steps the ropes itself, per sim tick) */
  hold = false;
  private acc = 0;
  private lastT = 0;
  private spacers: THREE.InstancedMesh | null = null;
  private spacerStatic: Float32Array | null = null;
  private spacerDirty = false;
  private readonly spacerRest: { yc: number; sy: number }[] = [];
  private readonly fighters: Fighter[] = [0, 1].map(() => ({ group: null, bones: [], J: new Float64Array(J_COUNT * 3), off: [0, 0], last: [0, 0], applied: false, ex: new Float64Array(SIDES), has: false }));
  private scene: THREE.Scene | null = null;
  private retry = 0;
  private bendOn = false;
  /** the cost of update(), ms: running mean over frames that did work */
  readonly cost = { sum: 0, n: 0 };

  constructor(c: Config, h: number, count: number, cols: THREE.Color[], staticMesh: THREE.Mesh, spacers: THREE.InstancedMesh) {
    this.c = c; this.h = h; this.count = count;
    this.yRope = []; for (let j = 0; j < count; j++) this.yRope.push(c.ropeTopY * (j + 1) / count);
    const R = SIDES * count;
    this.d = new Float32Array(R * NP); this.v = new Float32Array(R * NP);
    this.req = new Float32Array(R * NP); this.prevReq = new Float32Array(R * NP);
    for (let i = 0; i < NP; i++) this.sinTab[i] = Math.sin(Math.PI * i / N);
    const nv = R * NP * RAD;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.nor = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const col = new Float32Array(nv * 3);
    const idx = new Uint32Array(R * N * RAD * 6);
    let ii = 0;
    for (let r = 0; r < R; r++) {
      const cc = cols[(r % count) % cols.length]!;
      for (let i = 0; i < NP; i++) for (let k = 0; k < RAD; k++) {
        const vi = (r * NP + i) * RAD + k;
        col[vi * 3] = cc.r; col[vi * 3 + 1] = cc.g; col[vi * 3 + 2] = cc.b;
        if (i < N) {
          const a = vi, b = (r * NP + i + 1) * RAD + k, a2 = (r * NP + i) * RAD + (k + 1) % RAD, b2 = (r * NP + i + 1) * RAD + (k + 1) % RAD;
          idx[ii++] = a; idx[ii++] = b; idx[ii++] = a2; idx[ii++] = a2; idx[ii++] = b; idx[ii++] = b2;
        }
      }
    }
    geo.setAttribute('position', this.pos); geo.setAttribute('normal', this.nor);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 12);
    this.mesh = new THREE.Mesh(geo, (staticMesh.material as THREE.Material).clone());
    this.mesh.castShadow = true; this.mesh.frustumCulled = false; this.mesh.visible = false;
    this.staticMesh = staticMesh;
    // the trigger: a degenerate triangle, drawn (invisible: colour write off) so its onBeforeRender runs once per main render
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.trigger = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this.trigger.frustumCulled = false;
    this.trigger.onBeforeRender = (_r, scene) => this.hook(scene as THREE.Scene);
    this.spacers = spacers;
    this.spacerStatic = new Float32Array(spacers.instanceMatrix.array as Float32Array);
    const yBot = c.ropeTopY / count, yTop = c.ropeTopY;
    for (let s = 0; s < 8; s++) this.spacerRest.push({ yc: (yBot + yTop) / 2, sy: yTop - yBot + 0.06 });
    this.rebuild();
    (window as unknown as { __ropes?: unknown }).__ropes = {
      update: (dt: number) => this.update(dt, true),
      cost: this.cost,
      hold: (on: boolean) => { this.hold = on; },
      dbg: () => { let o: THREE.Object3D | null = this.trigger; const chain: string[] = []; while (o) { chain.push(o.type + ':' + o.name); o = o.parent; } return { scene: !!this.scene, chain, g: this.fighters.map(f => !!f.group), b: this.fighters.map(f => f.bones.map(x => !!x)) }; },
      reset: () => { this.d.fill(0); this.v.fill(0); this.req.fill(0); this.prevReq.fill(0); this.acc = 0; this.awake = true; for (const f of this.fighters) { f.off[0] = 0; f.off[1] = 0; } },
      capsules: (side: number) => this.capsules(side),
      points: () => this.points(),
      state: () => ({ off: this.fighters.map(f => [...f.off]), awake: this.awake, maxD: this.maxD() }),
    };
  }
  private readonly staticMesh: THREE.Mesh;

  private hook(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    this.scene = scene;
    const prev = scene.onBeforeRender;
    scene.onBeforeRender = (...a: Parameters<typeof prev>) => { this.update(0, false); prev.apply(scene, a); };
  }

  private maxD(): number { let m = 0; for (let i = 0; i < this.d.length; i++) m = Math.max(m, this.d[i]!); return m; }

  private findFighters(): void {
    const sc = this.scene; if (!sc) return;
    for (let f = 0; f < 2; f++) {
      const F = this.fighters[f]!;
      if (F.group && F.group.parent) continue;
      if (this.retry > 0 && !F.group) continue;
      const g = sc.getObjectByName(`human${f}`) ?? null;
      F.group = g; F.bones = []; F.applied = false; F.off[0] = 0; F.off[1] = 0;
      if (g) {
        const all: THREE.Object3D[] = [];
        g.traverse(o => { if ((o as THREE.Bone).isBone) all.push(o); });
        F.bones = BONES.map(n => all.find(b => b.name.endsWith(n)) ?? null);
      }
    }
    this.retry = (this.retry + 1) % 120;
  }

  /** Read one fighter's joints (world, un-offset) into F.J. False when the body is missing. */
  private read(F: Fighter): boolean {
    const b = F.bones, J = F.J;
    for (let i = 0; i < 16; i++) if (i !== 3 && !b[i]) return false;
    const p = (o: THREE.Object3D | null | undefined, slot: number): void => {
      if (!o) return;
      const e = o.matrixWorld.elements; J[slot * 3] = e[12]!; J[slot * 3 + 1] = e[13]!; J[slot * 3 + 2] = e[14]!;
    };
    p(b[0], 0); p(b[1], 1);
    // head sphere centre: halfway from the Head bone (skull base) toward its tip, or 8 cm up its own axis when there is no tip bone
    const hd = b[2]!.matrixWorld.elements;
    if (b[3]) { const ht = b[3].matrixWorld.elements; J[6] = (hd[12]! + ht[12]!) * 0.5; J[7] = (hd[13]! + ht[13]!) * 0.5; J[8] = (hd[14]! + ht[14]!) * 0.5; }
    else { J[6] = hd[12]! + hd[4]! * 0.08; J[7] = hd[13]! + hd[5]! * 0.08; J[8] = hd[14]! + hd[6]! * 0.08; }
    const gl = this.c.humanGloveOffset;
    const arm = (a: number, base: number): void => {
      p(b[a], base); p(b[a + 1], base + 1); p(b[a + 2], base + 2);
      const o = (base + 2) * 3, e = (base + 1) * 3;
      const dx = J[o]! - J[e]!, dy = J[o + 1]! - J[e + 1]!, dz = J[o + 2]! - J[e + 2]!, l = Math.hypot(dx, dy, dz) || 1;
      J[o] = J[o]! + dx / l * gl; J[o + 1] = J[o + 1]! + dy / l * gl; J[o + 2] = J[o + 2]! + dz / l * gl;
    };
    arm(4, 3); arm(7, 6);
    p(b[10], 9); p(b[11], 10); p(b[12], 11); p(b[13], 12); p(b[14], 13); p(b[15], 14);
    return true;
  }

  private rad(k: RKey): number { return this.c[k]; }

  /** One sphere against all four sides: mode 0 measures the excess past the LIMITED rope, mode 1 raises the rope requirement. */
  private sphere(F: Fighter, cx: number, cy: number, cz: number, r: number, mode: number): void {
    const { h, count, c } = this, rr0 = c.ropeThickR, cell = 2 * h / N, lim = c.ropeBowMax;
    for (let k = 0; k < SIDES; k++) {
      const qn = cx * NX[k]! + cz * NZ[k]!;
      if (qn + r + rr0 < h - 0.7) continue;
      const qu = cx * TX[k]! + cz * TZ[k]!;
      if (qu < -h - r || qu > h + r) continue;
      for (let j = 0; j < count; j++) {
        let dy = cy - this.yRope[j]!;
        if (j === 0 && dy < 0) dy = 0;                       // the bottom rope is a wall to the floor: nothing slides under it
        const r2 = r * r - dy * dy;
        if (r2 <= 0) continue;
        const rr = Math.sqrt(r2);
        const e = qn + rr + rr0 - h;
        if (mode === 0) {
          const s = Math.min(1, Math.max(0, (qu + h) / (2 * h)));
          const ex = e - lim * Math.sin(Math.PI * s);
          if (ex > F.ex[k]!) F.ex[k] = ex;
        } else {
          if (e <= 0) continue;
          const base = (k * count + j) * NP;
          const fi = (qu + h) / cell, i0 = Math.max(0, Math.min(N - 1, Math.floor(fi)));
          if (e > 0 && rr < cell) { if (this.req[base + i0]! < e) this.req[base + i0] = e; if (this.req[base + i0 + 1]! < e) this.req[base + i0 + 1] = e; }
          const ia = Math.max(1, Math.ceil((qu - rr + h) / cell)), ib = Math.min(N - 1, Math.floor((qu + rr + h) / cell));
          for (let i = ia; i <= ib; i++) {
            const du = i * cell - h - qu;
            const q = qn + Math.sqrt(Math.max(0, rr * rr - du * du)) + rr0 - h;
            if (q > this.req[base + i]!) this.req[base + i] = q;
          }
        }
      }
    }
  }

  /** Every capsule of one fighter as sample spheres, shifted by (sx, sz). */
  private body(F: Fighter, sx: number, sz: number, mode: number): void {
    const J = F.J;
    for (let ci = 0; ci < CAPS.length; ci++) {
      const cp = CAPS[ci]!, r = this.rad(cp[2]), a = cp[0] * 3, b = cp[1] * 3;
      const ax = J[a]! + sx, ay = J[a + 1]!, az = J[a + 2]! + sz;
      if (a === b) { this.sphere(F, ax, ay, az, r, mode); continue; }
      const bx = J[b]! + sx, by = J[b + 1]!, bz = J[b + 2]! + sz;
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      const n = Math.max(1, Math.min(8, Math.ceil(len / (r * 1.1))));
      for (let k = 0; k <= n; k++) { const t = k / n; this.sphere(F, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, r, mode); }
    }
  }

  /** The frame's work. dt seconds of wall time (0 = a repeat render in the same frame); force = refresh matrices myself (a script). */
  update(dtIn: number, force: boolean): void {
    if (!this.trigger.parent) return;       // a ring that was rebuilt: its replacement owns the bodies now
    const t0 = performance.now();
    const c = this.c;
    let dt = dtIn;
    if (!force) {
      const now = t0 / 1000;
      if (this.lastT === 0) { this.lastT = now; dt = 0; }
      else { dt = Math.min(0.05, now - this.lastT); if (dt < 0.002) dt = 0; else this.lastT = now; }
    }
    if (!force && this.hold) dt = 0;
    const on = c.ropesBend;
    if (on !== this.bendOn) { this.bendOn = on; this.staticMesh.visible = !on; this.mesh.visible = on; if (on) this.awake = true; else this.restoreSpacers(); }
    this.findFighters();
    this.req.fill(0);
    let any = false;
    for (let f = 0; f < 2; f++) {
      const F = this.fighters[f]!, g = F.group;
      if (!g) continue;
      // back to the pose as the view left it (it sets the position absolutely every frame it runs)
      if (F.applied && Math.abs(g.position.x - F.last[0]) < 1e-9 && Math.abs(g.position.z - F.last[1]) < 1e-9) { g.position.x -= F.off[0]; g.position.z -= F.off[1]; }
      F.applied = false;
      if (!on || !g.visible) { F.off[0] = 0; F.off[1] = 0; F.has = false; continue; }
      g.updateMatrixWorld(true);
      if (!this.read(F)) { F.has = false; continue; }
      F.has = true;
      if (c.ropesContain) {
        F.ex.fill(0);
        this.body(F, 0, 0, 0);
        // target: slide away from each side by how far the unshifted body is past the limited rope
        const tx = -F.ex[1]! + F.ex[3]!, tz = -F.ex[2]! + F.ex[0]!;   // side 1 normal +x, 3 normal -x; side 2 +z, 0 -z (z side 2 pushes -z)
        const ease = (cur: number, tgt: number): number => {
          if (dt <= 0) return cur;
          const tau = Math.abs(tgt) > Math.abs(cur) ? c.ropeContainIn : c.ropeContainOut;
          return cur + (tgt - cur) * (1 - Math.exp(-dt / tau));
        };
        F.off[0] = ease(F.off[0], tx); F.off[1] = ease(F.off[1], tz);
      } else { F.off[0] = 0; F.off[1] = 0; }
      F.last[0] = g.position.x += F.off[0]; F.last[1] = g.position.z += F.off[1]; F.applied = true;
      this.body(F, F.off[0], F.off[1], 1);
      any = true;
      if (force) g.updateMatrixWorld(true);
    }
    if (on) {
      let touched = false;
      if (any) for (let i = 0; i < this.req.length; i++) if (this.req[i]! > 0) { touched = true; break; }
      if (touched || this.awake) this.stepRopes(dt, touched);
    }
    const ms = performance.now() - t0;
    if (on && (any || this.awake)) { this.cost.sum += ms; this.cost.n++; }
  }

  private stepRopes(dt: number, touched: boolean): void {
    const c = this.c, { d, v, req, prevReq } = this, R = SIDES * this.count;
    this.acc += dt;
    const n = Math.floor(this.acc / SUB);
    this.acc -= n * SUB;
    const stiff = c.ropeStiff, ten = c.ropeTension, damp = c.ropeDamp, lim = c.ropeBowMax;
    for (let s = 0; s < n; s++) {
      const al = (s + 1) / n;
      for (let r = 0; r < R; r++) {
        const o = r * NP;
        for (let i = 1; i < N; i++) {
          const k = o + i;
          v[k] = v[k]! + (-stiff * d[k]! - damp * v[k]! + ten * (d[k - 1]! + d[k + 1]! - 2 * d[k]!)) * SUB;
        }
        for (let i = 1; i < N; i++) {
          const k = o + i, old = d[k]!;
          let x = old + v[k]! * SUB;
          const rq = prevReq[k]! + (req[k]! - prevReq[k]!) * al;
          if (x < rq) { x = rq; const vv = (rq - old) / SUB; if (v[k]! < vv) v[k] = vv; }
          const L = lim * this.sinTab[i]!;
          if (x > L) { x = L; if (v[k]! > 0) v[k] = 0; }
          d[k] = x;
        }
      }
    }
    prevReq.set(req);
    // asleep when still and nothing pushes: skip the rebuild until the next contact
    let e = 0;
    for (let i = 0; i < d.length; i++) e += Math.abs(d[i]!) + Math.abs(v[i]!) * 0.1;
    if (!touched && e < 2e-3) { d.fill(0); v.fill(0); this.awake = false; this.rebuild(); this.updateSpacers(); return; }
    this.awake = true;
    this.rebuild(); this.updateSpacers();
  }

  /** Tube geometry from the rope points. */
  private rebuild(): void {
    const { h, count, c } = this, P = this.pos.array as Float32Array, Nn = this.nor.array as Float32Array;
    const rr = c.ropeThickR, sag = c.ropeSag;
    let vi = 0;
    for (let k = 0; k < SIDES; k++) for (let j = 0; j < count; j++) {
      const base = (k * count + j) * NP, y0 = this.yRope[j]!;
      for (let i = 0; i < NP; i++) {
        const u = -h + 2 * h * i / N, dd = this.d[base + i]!, s = i / N;
        const px = NX[k]! * (h + dd) + TX[k]! * u, pz = NZ[k]! * (h + dd) + TZ[k]! * u, py = y0 - 2 * s * (1 - s) * sag;
        // tangent from neighbours
        const ia = Math.max(0, i - 1), ib = Math.min(N, i + 1);
        const ua = -h + 2 * h * ia / N, ub = -h + 2 * h * ib / N, da = this.d[base + ia]!, db = this.d[base + ib]!;
        const sa = ia / N, sb = ib / N;
        let tx = (TX[k]! * (ub - ua) + NX[k]! * (db - da)), tz = (TZ[k]! * (ub - ua) + NZ[k]! * (db - da)), ty = (-2 * sb * (1 - sb) * sag) - (-2 * sa * (1 - sa) * sag);
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        // side = t x up (horizontal), second = side x t
        let sxv = -tz, szv = tx; const sl = Math.hypot(sxv, szv) || 1; sxv /= sl; szv /= sl;
        const qx = -szv * ty, qy = szv * tx - sxv * tz, qz = sxv * ty;
        for (let q = 0; q < RAD; q++, vi++) {
          const cx = COS[q]!, sn = SIN[q]!;
          const nx = sxv * cx + qx * sn, ny = qy * sn, nz = szv * cx + qz * sn;
          P[vi * 3] = px + nx * rr; P[vi * 3 + 1] = py + ny * rr; P[vi * 3 + 2] = pz + nz * rr;
          Nn[vi * 3] = nx; Nn[vi * 3 + 1] = ny; Nn[vi * 3 + 2] = nz;
        }
      }
    }
    this.pos.needsUpdate = true; this.nor.needsUpdate = true;
  }

  /** The spacer between each rope at 1/3 and 2/3 of the span follows the mean bow of its ropes. */
  private updateSpacers(): void {
    const sp = this.spacers, m = new THREE.Matrix4();
    if (!sp) return;
    const { h, count } = this;
    let si = 0;
    for (let k = 0; k < SIDES; k++) for (const t of [1 / 3, 2 / 3]) {
      const fi = t * N, i0 = Math.floor(fi), w = fi - i0;
      let dm = 0;
      for (let j = 0; j < count; j++) { const b = (k * count + j) * NP; dm += this.d[b + i0]! * (1 - w) + this.d[b + i0 + 1]! * w; }
      dm /= count;
      const u = -h + 2 * h * t, rest = this.spacerRest[si]!, sag = 2 * t * (1 - t) * this.c.ropeSag;
      m.makeScale(1, rest.sy, 1).setPosition(NX[k]! * (h + dm) + TX[k]! * u, rest.yc - sag, NZ[k]! * (h + dm) + TZ[k]! * u);
      sp.setMatrixAt(si++, m);
    }
    sp.instanceMatrix.needsUpdate = true; this.spacerDirty = true;
  }

  private restoreSpacers(): void {
    if (!this.spacers || !this.spacerStatic || !this.spacerDirty) return;
    (this.spacers.instanceMatrix.array as Float32Array).set(this.spacerStatic);
    this.spacers.instanceMatrix.needsUpdate = true; this.spacerDirty = false;
  }

  /** Test hook: this fighter's capsules as drawn now, [ax, ay, az, bx, by, bz, r, name]. Call update(dt) first. */
  capsules(side: number): (number | string)[][] | null {
    const F = this.fighters[side];
    if (!F || !F.group) return null;
    F.group.updateMatrixWorld(true);
    if (!this.read(F)) return null;
    const names = ['torso', 'head', 'upperArmL', 'forearmL', 'gloveL', 'upperArmR', 'forearmR', 'gloveR', 'thighL', 'shinL', 'thighR', 'shinR'];
    return CAPS.map((cp, i) => {
      const a = cp[0] * 3, b = cp[1] * 3, J = F.J;
      return [J[a]!, J[a + 1]!, J[a + 2]!, J[b]!, J[b + 1]!, J[b + 2]!, this.rad(cp[2]), names[i]!];
    });
  }

  /** Test hook: the drawn rope polylines [side][rope] -> flat xyz of NP points (rope centre line). */
  points(): number[][][] {
    const out: number[][][] = [];
    for (let k = 0; k < SIDES; k++) {
      const row: number[][] = [];
      for (let j = 0; j < this.count; j++) {
        const pts: number[] = [], base = (k * this.count + j) * NP;
        for (let i = 0; i < NP; i++) {
          const u = -this.h + 2 * this.h * i / N, dd = this.d[base + i]!, s = i / N;
          pts.push(NX[k]! * (this.h + dd) + TX[k]! * u, this.yRope[j]! - 2 * s * (1 - s) * this.c.ropeSag, NZ[k]! * (this.h + dd) + TZ[k]! * u);
        }
        row.push(pts);
      }
      out.push(row);
    }
    return out;
  }
}

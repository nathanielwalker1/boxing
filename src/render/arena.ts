/**
 * render/arena.ts — the L7 placeholder (CONTRACT §7): a dark bowl of low-poly
 * seating tiers receding into fog, a crowd as ONE InstancedMesh of silhouettes
 * (dark, desaturated — never competing with the ring), camera-flash sparkles,
 * and an overhead truss with additive beam cones. Layout uses a render-local
 * seeded RNG (never the sim's). Rebuilt whole when ARENA_KEYS change; fog,
 * beam opacity and flashes update per frame.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RING_HALF, APRON_W, TAU, type Config } from '../core';
import { seededRng, disposeTree } from './util';

export const ARENA_KEYS = ['bowlColor', 'bowlInnerR', 'bowlTiers', 'bowlTierRise', 'bowlTierDepth', 'crowdCount', 'crowdColor',
  'crowdVariance', 'crowdSeed', 'flashCount', 'trussHeight', 'trussSize', 'beamCount', 'beamColor', 'beamRadius'] as const;

export function arenaKey(c: Config): string { return ARENA_KEYS.map(k => String(c[k])).join('|'); }

const FLOOR_Y = -1.0;
const FLASH_LIFE = 0.14;
const UP = new THREE.Vector3(0, 1, 0);

interface Seat { pos: THREE.Vector3; theta: number; tier: number }

export class Arena {
  readonly group = new THREE.Group();
  private crowd: THREE.InstancedMesh | null = null;
  private flashes: THREE.InstancedMesh | null = null;
  private flashPos: THREE.Vector3[] = [];
  private flashStart: number[] = [];
  private flashNext: number[] = [];
  private beamMat: THREE.MeshBasicMaterial | null = null;
  private tmpM = new THREE.Matrix4();
  private tmpS = new THREE.Vector3();

  constructor(c: Config) { this.rebuild(c); }

  rebuild(c: Config): void {
    disposeTree(this.group);
    this.crowd = null; this.flashes = null; this.beamMat = null;
    const rng = seededRng(c.crowdSeed);

    // ── Bowl: floor disc, risers + treads per tier, back wall. One merged mesh.
    const seg = 48;
    const parts: THREE.BufferGeometry[] = [];
    const flat = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    parts.push(new THREE.CircleGeometry(c.bowlInnerR, seg).applyMatrix4(flat).translate(0, FLOOR_Y, 0));
    let rIn = c.bowlInnerR, y = FLOOR_Y;
    for (let i = 0; i < c.bowlTiers; i++) {
      parts.push(new THREE.CylinderGeometry(rIn, rIn, c.bowlTierRise, seg, 1, true).translate(0, y + c.bowlTierRise / 2, 0));
      y += c.bowlTierRise;
      parts.push(new THREE.RingGeometry(rIn, rIn + c.bowlTierDepth, seg, 1).applyMatrix4(flat).translate(0, y, 0));
      rIn += c.bowlTierDepth;
    }
    const wallH = 18;
    parts.push(new THREE.CylinderGeometry(rIn, rIn, wallH, seg, 1, true).translate(0, y + wallH / 2, 0));
    const bowl = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshLambertMaterial({ color: new THREE.Color(c.bowlColor), side: THREE.DoubleSide }));
    this.group.add(bowl);

    // ── Seats: ringside rows on the floor, then rows across each tread.
    const rows: { r: number; y: number; tier: number }[] = [];
    for (let r = RING_HALF + APRON_W + 1.0; r < c.bowlInnerR - 0.45; r += 0.8) rows.push({ r, y: FLOOR_Y, tier: 0 });
    rIn = c.bowlInnerR; y = FLOOR_Y;
    for (let i = 0; i < c.bowlTiers; i++) {
      y += c.bowlTierRise;
      for (let r = rIn + 0.5; r < rIn + c.bowlTierDepth - 0.3; r += 0.8) rows.push({ r, y, tier: i + 1 });
      rIn += c.bowlTierDepth;
    }
    const seats: Seat[] = [];
    if (c.crowdCount > 0 && rows.length) {
      const total = rows.reduce((s, row) => s + TAU * row.r, 0);
      const spacing = Math.max(0.5, total / c.crowdCount);
      for (const row of rows) {
        const n = Math.floor(TAU * row.r / spacing);
        for (let k = 0; k < n; k++) {
          const theta = ((k + 0.5) / n) * TAU + (rng() - 0.5) * 0.4 / row.r;
          const rr = row.r + (rng() - 0.5) * 0.2;
          seats.push({ pos: new THREE.Vector3(rr * Math.cos(theta), row.y, rr * Math.sin(theta)), theta, tier: row.tier });
        }
      }
    }

    // ── Crowd: one InstancedMesh; torso box + octahedron head = 20 tris each.
    if (seats.length) {
      const torso = new THREE.BoxGeometry(0.42, 0.85, 0.24).translate(0, 0.575, 0).toNonIndexed();
      const head = new THREE.OctahedronGeometry(0.13, 0).scale(0.9, 1.1, 0.9).translate(0, 1.13, 0);
      torso.deleteAttribute('uv'); head.deleteAttribute('uv');
      const geo = mergeGeometries([torso, head]);
      const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(c.crowdColor) });
      const crowd = new THREE.InstancedMesh(geo, mat, seats.length);
      const q = new THREE.Quaternion(), s = new THREE.Vector3(), col = new THREE.Color();
      seats.forEach((seat, i) => {
        q.setFromAxisAngle(UP, -seat.theta + Math.PI / 2);
        s.set(0.85 + rng() * 0.3, 0.85 + rng() * 0.3, 1);
        crowd.setMatrixAt(i, this.tmpM.compose(seat.pos, q, s));
        const b = 1 + (rng() - 0.5) * 2 * c.crowdVariance;
        col.setRGB(b * (1 + (rng() - 0.5) * 0.1), b * (1 + (rng() - 0.5) * 0.1), b * (1 + (rng() - 0.5) * 0.1));
        crowd.setColorAt(i, col);
      });
      crowd.castShadow = false; crowd.receiveShadow = false;
      this.crowd = crowd;
      this.group.add(crowd);
    }

    // ── Camera flashes: a handful of additive quads parked on random seats.
    this.flashPos = []; this.flashStart = []; this.flashNext = [];
    if (c.flashCount > 0 && seats.length) {
      const fl = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), c.flashCount);
      for (let i = 0; i < c.flashCount; i++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        this.flashPos.push(seat.pos.clone().add(new THREE.Vector3(0, 1.1, 0)));
        this.flashStart.push(-1e9);
        this.flashNext.push(rng() * 2);
        fl.setMatrixAt(i, this.tmpM.makeScale(0, 0, 0));
      }
      fl.frustumCulled = false;
      this.flashes = fl;
      this.group.add(fl);
    }

    // ── Truss: two square chords with struts, merged. Lamps: instanced housings.
    {
      const S = c.trussSize / 2, H = c.trussHeight, bar = 0.2;
      const geos: THREE.BufferGeometry[] = [];
      const m = new THREE.Matrix4();
      for (const lvl of [0, 0.55]) {
        geos.push(new THREE.BoxGeometry(S * 2 + bar, bar, bar).applyMatrix4(m.makeTranslation(0, H + lvl, S)));
        geos.push(new THREE.BoxGeometry(S * 2 + bar, bar, bar).applyMatrix4(m.makeTranslation(0, H + lvl, -S)));
        geos.push(new THREE.BoxGeometry(bar, bar, S * 2 + bar).applyMatrix4(m.makeTranslation(S, H + lvl, 0)));
        geos.push(new THREE.BoxGeometry(bar, bar, S * 2 + bar).applyMatrix4(m.makeTranslation(-S, H + lvl, 0)));
      }
      const n = Math.max(2, Math.round(c.trussSize / 1.5));
      for (let i = 0; i <= n; i++) {
        const p = -S + (i / n) * S * 2;
        for (const [x, z] of [[p, S], [p, -S], [S, p], [-S, p]] as [number, number][]) {
          geos.push(new THREE.BoxGeometry(0.06, 0.55, 0.06).applyMatrix4(m.makeTranslation(x, H + 0.275, z)));
        }
      }
      const truss = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.6, metalness: 0.6 }));
      this.group.add(truss);
    }

    // ── Beams: cones from lamps on the truss down to just above the ring, bright at the lamp, black at the base.
    const beamCol = new THREE.Color(c.beamColor);
    const lampOrigins: { from: THREE.Vector3; to: THREE.Vector3 }[] = [];
    for (let k = 0; k < c.beamCount; k++) {
      const a = (k + 0.5) * TAU / c.beamCount + Math.PI / 4;
      const sc = (c.trussSize / 2) / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const from = new THREE.Vector3(Math.cos(a) * sc, c.trussHeight - 0.15, Math.sin(a) * sc);
      const to = new THREE.Vector3(-Math.cos(a) * 0.6, 1.25, -Math.sin(a) * 0.6);
      lampOrigins.push({ from, to });
    }
    // decorative lamps along the chords (no beam) so the truss reads as a light rig
    const extraLamps: { from: THREE.Vector3; to: THREE.Vector3 }[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const sc = (c.trussSize / 2) / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const from = new THREE.Vector3(Math.cos(a) * sc, c.trussHeight - 0.12, Math.sin(a) * sc);
      extraLamps.push({ from, to: from.clone().setY(0) });
    }
    const lamps = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.13, 0.2, 0.34, 10),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.5, emissive: beamCol, emissiveIntensity: 1.6 }), lampOrigins.length + extraLamps.length);
    [...lampOrigins, ...extraLamps].forEach((l, i) => {
      const dir = l.to.clone().sub(l.from).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
      lamps.setMatrixAt(i, this.tmpM.compose(l.from, q, new THREE.Vector3(1, 1, 1)));
    });
    this.group.add(lamps);

    if (lampOrigins.length) {
      const cones: THREE.BufferGeometry[] = [];
      for (const l of lampOrigins) {
        const len = l.from.distanceTo(l.to);
        const g = new THREE.CylinderGeometry(0.18, c.beamRadius, len, 20, 1, true);
        g.deleteAttribute('uv');
        const pos = g.attributes['position']!;
        const colArr = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          const f = Math.pow(pos.getY(i) / len + 0.5, 1.6);   // 1 at the narrow (lamp) end, 0 at the base
          colArr[i * 3] = beamCol.r * f; colArr[i * 3 + 1] = beamCol.g * f; colArr[i * 3 + 2] = beamCol.b * f;
        }
        g.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
        const dir = l.from.clone().sub(l.to).normalize();     // local +y (narrow end) → lamp
        const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
        g.applyMatrix4(this.tmpM.compose(l.from.clone().lerp(l.to, 0.5), q, new THREE.Vector3(1, 1, 1)));
        cones.push(g);
      }
      this.beamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: c.beamOpacity,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const beams = new THREE.Mesh(mergeGeometries(cones), this.beamMat);
      beams.renderOrder = 10;
      this.group.add(beams);
    }
  }

  /** Per-frame: crowd toggle, beam opacity, camera flashes (wall time `t`). */
  update(c: Config, t: number, camera: THREE.Camera): void {
    if (this.crowd) this.crowd.visible = c.crowdEnabled;
    if (this.beamMat) this.beamMat.opacity = c.beamOpacity;
    const fl = this.flashes;
    if (!fl) return;
    fl.visible = c.crowdEnabled;
    const mean = c.flashRate > 0 ? this.flashPos.length / c.flashRate : Infinity;
    for (let i = 0; i < this.flashPos.length; i++) {
      if (t >= this.flashNext[i]!) {
        this.flashStart[i] = t;
        this.flashNext[i] = t + mean * (0.3 + Math.random() * 1.4);   // render-local jitter, not the sim RNG
      }
      const u = (t - this.flashStart[i]!) / FLASH_LIFE;
      const s = u < 1 ? c.flashSize * (1 - u * u) : 0;
      this.tmpS.setScalar(s);
      fl.setMatrixAt(i, this.tmpM.compose(this.flashPos[i]!, camera.quaternion, this.tmpS));
    }
    fl.instanceMatrix.needsUpdate = true;
  }

  dispose(): void { disposeTree(this.group); }
}

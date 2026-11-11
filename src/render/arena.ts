/**
 * render/arena.ts — the room (CONTRACT §7; overhaul 2026-11-11, "the show").
 *
 * From the ring outward, the layers the play camera sees behind the fighters:
 *   lit ring → ringside floor (press tables, straight rows, corner teams,
 *   camera platforms) catching most of the spill → a haze layer → the lower
 *   bowl behind an LED barrier board, aisles with step lights → a lit
 *   concourse slot the back row is silhouetted against → the upper deck's LED
 *   ribbon board → a dark upper deck picked out by practical lights → black.
 * Overhead: a square truss with fixtures, key / back / house beams, dust in
 * the key, and a four-sided scoreboard hung over the middle.
 *
 * Draw calls: structure 1 (baked vertex light, unlit material), LED boards 2,
 * crowd 2, flashes 1, practicals 1, truss 1, fixtures 2, beams 1, haze 1,
 * motes 1, scoreboard 2. Layout uses a render-local seeded RNG (never the
 * sim's). Rebuilt whole when an ARENA_KEYS value or the quality tier changes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RING_HALF, APRON_W, TAU, type Config } from '../core';
import { seededRng, disposeTree, makeCanvas, canvasTexture } from './util';
import { SPONSORS, paintSlot, paintLedPanel } from './sponsors';
import { Crowd, CrowdFlashes, type Seat } from './crowd';
import { Beams, Haze, Motes, Practicals, type BeamSpec, type Practical } from './atmos';
import { qualityTier, softwareRenderer } from './tier';
import type { Reaction } from './mood';

export const ARENA_KEYS = ['bowlColor', 'bowlInnerR', 'bowlWallH', 'bowlTiers', 'bowlTierRise', 'bowlTierDepth', 'concourseH', 'concourseDepth',
  'fasciaH', 'upperTiers', 'upperRise', 'upperDepth', 'aisleCount', 'aisleWidth', 'spillIntensity', 'spillFalloff', 'bowlAmbient',
  'practicalBrightness', 'crowdCount', 'crowdColor', 'crowdVariance', 'crowdSaturation', 'crowdSeed', 'flashCount', 'trussHeight', 'trussSize',
  'beamCount', 'beamOpacity', 'beamColor', 'beamRadius', 'backBeamOpacity', 'backColorA', 'backColorB', 'houseBeamCount', 'houseBeamOpacity',
  'hazeRadius', 'hazeHeight', 'moteCount', 'keyHeight', 'jumbotronSize', 'lowCrowdScale', 'lowBeamCount', 'lowHazeScale'] as const;

export function arenaKey(c: Config): string { return ARENA_KEYS.map(k => String(c[k])).join('|') + '|' + qualityTier(c); }

const FLOOR_Y = -1.0;
const OUTER = RING_HALF + APRON_W;
const SEAT_PITCH = 0.56;           // m between neighbours in a row
const RUNWAY_W = 1.8;              // m: width of the fighters' runway from the entrance tunnel
const UP = new THREE.Vector3(0, 1, 0);

type P3 = [number, number, number];
const polar = (r: number, th: number, y: number): P3 => [r * Math.cos(th), y, r * Math.sin(th)];

/** Accumulates quads with baked per-vertex colour into one geometry. */
class Builder {
  private pos: number[] = []; private col: number[] = []; private idx: number[] = [];
  quad(a: P3, b: P3, c: P3, d: P3, albedo: THREE.Color, light: (p: P3) => number): void {
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) {
      const l = light(p);
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(albedo.r * l, albedo.g * l, albedo.b * l);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** A box, yawed about y; `top` / `side` scale the light on up-facing and vertical faces. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw: number, albedo: THREE.Color, light: (p: P3) => number, top = 1, side = 0.6): void {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const at = (x: number, y: number, z: number): P3 => [cx + x * cs + z * sn, cy + y, cz - x * sn + z * cs];
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const l = (k: number) => (p: P3) => light(p) * k;
    this.quad(at(-hx, hy, -hz), at(hx, hy, -hz), at(hx, hy, hz), at(-hx, hy, hz), albedo, l(top));
    this.quad(at(-hx, -hy, hz), at(hx, -hy, hz), at(hx, hy, hz), at(-hx, hy, hz), albedo, l(side));
    this.quad(at(-hx, -hy, -hz), at(hx, -hy, -hz), at(hx, hy, -hz), at(-hx, hy, -hz), albedo, l(side));
    this.quad(at(hx, -hy, -hz), at(hx, -hy, hz), at(hx, hy, hz), at(hx, hy, -hz), albedo, l(side * 0.8));
    this.quad(at(-hx, -hy, -hz), at(-hx, -hy, hz), at(-hx, hy, hz), at(-hx, hy, -hz), albedo, l(side * 0.8));
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

/** The LED strip both boards share: the four sponsors, twice round, on black, with a pixel grid. */
function paintLedStrip(): HTMLCanvasElement {
  const w = 4096, h = 128, panels = 8, pw = w / panels;
  const [cv, g] = makeCanvas(w, h);
  g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < panels; i++) paintLedPanel(g, SPONSORS[i % SPONSORS.length]!, i * pw + 8, 6, pw - 16, h - 12);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  for (let x = 0; x < w; x += 4) g.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1);
  return cv;
}

export class Arena {
  readonly group = new THREE.Group();
  private crowd: Crowd | null = null;
  private flashes: CrowdFlashes | null = null;
  private beams: Beams | null = null;
  private haze: Haze | null = null;
  private motes: Motes | null = null;
  private practicals: Practicals | null = null;
  private ribbonTex: THREE.Texture | null = null;
  private ribbonMat: THREE.MeshBasicMaterial | null = null;
  private barrierMat: THREE.MeshBasicMaterial | null = null;
  private boardTex: THREE.CanvasTexture | null = null;
  private boardMat: THREE.MeshBasicMaterial | null = null;
  private boardText: readonly string[] | null = null;
  private tmpM = new THREE.Matrix4();
  private clock = 0;
  private hazeScale = 1;
  /** Seats built and people seated in them (probes, the log). */
  stats = { seats: 0, people: 0 };

  constructor(c: Config, private aniso = 1) { this.rebuild(c); }

  rebuild(c: Config): void {
    this.crowd?.dispose(); this.flashes?.dispose(); this.beams?.dispose(); this.haze?.dispose(); this.motes?.dispose(); this.practicals?.dispose();
    this.crowd = null; this.flashes = null; this.beams = null; this.haze = null; this.motes = null; this.practicals = null;
    disposeTree(this.group);
    const high = qualityTier(c) === 2;
    const rng = seededRng(c.crowdSeed);
    const seats: Seat[] = [];
    const lights: Practical[] = [];
    const b = new Builder();

    // The one light formula the structure bakes and the crowd shader repeats: house ambient + the ring's spill.
    const spill = (r: number): number => { const q = Math.max(0, r - OUTER) / c.spillFalloff; return c.spillIntensity / (1 + q * q); };
    const lit = (facing: number) => (p: P3): number => c.bowlAmbient + spill(Math.hypot(p[0], p[2])) * facing;
    const flat = (level: number) => (): number => level;
    const concrete = new THREE.Color(c.bowlColor);
    const stair = concrete.clone().multiplyScalar(1.7);
    const carpet = concrete.clone().multiplyScalar(0.7);
    const warm = new THREE.Color('#ffb46a'), cool = new THREE.Color('#cfe0ff'), exit = new THREE.Color('#58ff9a'), tally = new THREE.Color('#ff3a2a');
    const N = Math.max(4, Math.round(c.aisleCount));
    const SEG = 4;   // arc segments per seating sector
    // The entrance tunnel is the doorway nearest the blue corner's diagonal (225°): the ring walk comes from there.
    const TUNNEL_K = Math.max(0, Math.min(N - 1, Math.round(0.625 * N - 0.5)));
    const tunnelTh = TAU / (2 * N) + TUNNEL_K * TAU / N;

    const arc = (rA: number, yA: number, rB: number, yB: number, tA0: number, tA1: number, tB0: number, tB1: number, segs: number, albedo: THREE.Color, light: (p: P3) => number): void => {
      for (let i = 0; i < segs; i++) {
        const u0 = i / segs, u1 = (i + 1) / segs;
        b.quad(polar(rA, tA0 + (tA1 - tA0) * u0, yA), polar(rA, tA0 + (tA1 - tA0) * u1, yA),
          polar(rB, tB0 + (tB1 - tB0) * u1, yB), polar(rB, tB0 + (tB1 - tB0) * u0, yB), albedo, light);
      }
    };
    const ring = (rA: number, yA: number, rB: number, yB: number, albedo: THREE.Color, light: (p: P3) => number): void =>
      arc(rA, yA, rB, yB, 0, TAU, 0, TAU, 48, albedo, light);

    // ── Floor: concentric bands so the spill pool round the ring is a gradient, not one flat tone.
    {
      const R0 = c.bowlInnerR;
      const radii = [0.01, OUTER + 0.3, OUTER + 1.2, OUTER + 2.4, OUTER + 3.8, R0];
      for (let i = 0; i < radii.length - 1; i++) if (radii[i + 1]! > radii[i]!) ring(radii[i]!, FLOOR_Y, radii[i + 1]!, FLOOR_Y, carpet, lit(0.8));
    }

    // ── A raked deck: risers + treads per row, cut into sectors by constant-width aisles (lighter stairs, step lights).
    const deck = (r0: number, y0: number, rows: number, rise: number, depth: number, aisleOff: number, zone: 1 | 2, lightEvery: number): { rEnd: number; yEnd: number } => {
      for (let i = 0; i < rows; i++) {
        const r = r0 + i * depth, y = y0 + i * rise;
        const haIn = c.aisleWidth / (2 * r), haOut = c.aisleWidth / (2 * (r + depth));
        for (let k = 0; k < N; k++) {
          const t0 = aisleOff + k * TAU / N, t1 = aisleOff + (k + 1) * TAU / N;
          if (i > 0) {
            arc(r, y - rise, r, y, t0 + haIn, t1 - haIn, t0 + haIn, t1 - haIn, SEG, concrete, lit(1));
            arc(r, y - rise, r, y, t0 - haIn, t0 + haIn, t0 - haIn, t0 + haIn, 1, stair, lit(1));
          }
          arc(r, y, r + depth, y, t0 + haIn, t1 - haIn, t0 + haOut, t1 - haOut, SEG, concrete, lit(0.45));
          arc(r, y, r + depth, y, t0 - haIn, t0 + haIn, t0 - haOut, t0 + haOut, 1, stair, lit(0.6));
          // seats across the sector
          const rs = r + depth * 0.5, ha = c.aisleWidth / (2 * rs) + 0.25 / rs;
          const span = (t1 - t0) - 2 * ha;
          const n = Math.floor(span * rs / SEAT_PITCH);
          for (let s = 0; s < n; s++) {
            const th = t0 + ha + ((s + 0.5) / n) * span + (rng() - 0.5) * 0.12 / rs;
            const rr = rs + (rng() - 0.5) * 0.12;
            // nobody sits on the fighters' runway (lower bowl, the entrance tunnel's aisle)
            if (zone === 1 && Math.abs(Math.atan2(Math.sin(th - tunnelTh), Math.cos(th - tunnelTh))) * rs < RUNWAY_W / 2 + 0.3) continue;
            const x = rr * Math.cos(th), z = rr * Math.sin(th);
            seats.push({ x, y, z, yaw: Math.atan2(-x, -z), zone, role: 'fan' });
          }
          if (i % lightEvery === 0) for (const sgn of [-1, 1]) {
            const p = polar(r + 0.06, t0 + sgn * haIn * 0.92, y + 0.05);
            lights.push({ x: p[0], y: p[1], z: p[2], color: warm, size: 0.035, twinkle: 0 });
          }
        }
      }
      return { rEnd: r0 + rows * depth, yEnd: y0 + (rows - 1) * rise };
    };

    // ── Lower bowl behind its front wall.
    const R0 = c.bowlInnerR;
    const yFront = FLOOR_Y + c.bowlWallH;
    const ledH = Math.min(0.62, c.bowlWallH * 0.6);
    ring(R0, FLOOR_Y, R0, yFront - ledH, concrete, lit(1));
    ring(R0 - 0.02, yFront, R0 + 0.02, yFront + 0.02, stair, lit(0.7));   // the wall's cap
    const lower = deck(R0, yFront, Math.max(1, Math.round(c.bowlTiers)), c.bowlTierRise, c.bowlTierDepth, TAU / (2 * N), 1, 1);

    // ── Concourse slot: a floor, a lit back wall with doorways, a soffit. The back row is silhouetted against it.
    const rL = lower.rEnd, yL = lower.yEnd;
    const rBack = rL + c.concourseDepth, ySoffit = yL + c.concourseH;
    // The wall is lit in pools: brightest beside each doorway, falling off between them (baked per vertex).
    const corridor = new THREE.Color('#8a6548');
    const doorAt = (k: number): number => TAU / (2 * N) + k * TAU / N;
    const pool = (p: P3): number => {
      const th = Math.atan2(p[2], p[0]);
      const u = ((th - TAU / (2 * N)) / (TAU / N) % 1 + 1) % 1;       // 0 at a doorway, 0.5 midway to the next
      const d = Math.min(u, 1 - u) * 2;
      return (0.012 + 0.11 * Math.pow(1 - d, 3)) * c.practicalBrightness;
    };
    ring(rL, yL, rBack, yL, concrete, flat(0.03 * c.practicalBrightness));
    ring(rL - 0.4, ySoffit, rBack, ySoffit, concrete, flat(0.02 * c.practicalBrightness));
    {
      // Tunnel mouths (phase 2: the flat orange rectangles read as stickers). Each doorway is a recess cut into the
      // wall: the light is in the room beyond, so the far wall glows, the side walls and floor fall off toward the
      // mouth, the floor stays darkest, and a figure or two stands in it in silhouette. The entrance tunnel (the
      // one over the blue corner's diagonal) is wider, cooler and brighter, under an arch of lamps.
      const yTopDoor = ySoffit - 0.3, D = 3.2, PB = c.practicalBrightness;
      const ink = new THREE.Color('#0b0a0c'), entrance = new THREE.Color('#dfe9ff');
      const halfOf = (k: number): number => (k === TUNNEL_K ? 1.5 : 0.62);
      for (let k = 0; k < N; k++) {
        const th = doorAt(k), hw = halfOf(k), big = k === TUNNEL_K;
        const haF = hw / rBack, haB = hw / (rBack + D);
        // the wall from this mouth to the next, and the lintel over this one
        const next = doorAt(k + 1), nextHa = halfOf((k + 1) % N) / rBack;
        arc(rBack, yL, rBack, ySoffit, th + haF, next - nextHa, th + haF, next - nextHa, 8, corridor, pool);
        arc(rBack, yTopDoor, rBack, ySoffit, th - haF, th + haF, th - haF, th + haF, 1, corridor, flat(0.012 * PB));
        const col = big ? entrance : warm, far = (big ? 0.55 : 0.3) * PB;
        const depthOf = (p: P3): number => Math.min(1, Math.max(0, (Math.hypot(p[0], p[2]) - rBack) / D));   // 0 at the mouth, 1 at the far wall
        const wallL = (p: P3): number => far * (0.05 + 0.5 * Math.pow(depthOf(p), 1.6));
        const floorL = (p: P3): number => far * (0.02 + 0.28 * Math.pow(depthOf(p), 2));
        const ceilL = (p: P3): number => far * (0.01 + 0.14 * Math.pow(depthOf(p), 2));
        const farL = (p: P3): number => far * (p[1] > (yL + yTopDoor) / 2 ? 0.55 : 1);
        const A = (r: number, s: number, y: number): P3 => polar(r, th + s * (r > rBack + 0.01 ? haB : haF), y);
        b.quad(A(rBack + D, -1, yL), A(rBack + D, 1, yL), A(rBack + D, 1, yTopDoor), A(rBack + D, -1, yTopDoor), col, farL);
        for (const s of [-1, 1]) b.quad(A(rBack, s, yL), A(rBack + D, s, yL), A(rBack + D, s, yTopDoor), A(rBack, s, yTopDoor), col, wallL);
        b.quad(A(rBack, -1, yL), A(rBack, 1, yL), A(rBack + D, 1, yL), A(rBack + D, -1, yL), col, floorL);
        b.quad(A(rBack, -1, yTopDoor), A(rBack, 1, yTopDoor), A(rBack + D, 1, yTopDoor), A(rBack + D, -1, yTopDoor), col, ceilL);
        // figures in the mouth: legs, body, head — ink against the glow
        const figures = big ? 3 : rng() < 0.75 ? 1 + Math.floor(rng() * 2) : 0;
        for (let f = 0; f < figures; f++) {
          const fr = rBack + 0.5 + rng() * 1.2, fth = th + (rng() - 0.5) * 1.3 * haF, h = 1.05 + rng() * 0.2;
          const p = polar(fr, fth, yL);
          b.box(p[0], yL + h * 0.42, p[2], 0.34, h * 0.84, 0.2, -fth - Math.PI / 2, ink, flat(1), 1, 1);
          b.box(p[0], yL + h * 0.92, p[2], 0.17, h * 0.17, 0.17, -fth - Math.PI / 2, ink, flat(1), 1, 1);
        }
        const e = polar(rBack - 0.05, th, ySoffit - 0.1);
        if (!big) lights.push({ x: e[0], y: e[1], z: e[2], color: exit, size: 0.12, twinkle: 0 });
        else for (let i = 0; i <= 8; i++) {           // the arch: lamps up one side, across, down the other
          const u = i / 8, s = u * 2 - 1, y = yL + 0.15 + (yTopDoor + 0.18 - yL - 0.15) * Math.min(1, (1 - Math.abs(s)) * 3);
          const q = polar(rBack - 0.08, th + s * haF * 1.08, y);
          lights.push({ x: q[0], y: q[1], z: q[2], color: cool, size: 0.14, twinkle: 0 });
        }
      }
    }

    // ── The fighters' way in: a runway from the entrance tunnel down its aisle, over the front wall and across the
    // floor to the blue corner's steps, with lamps along both edges.
    {
      const th = doorAt(TUNNEL_K), carpet2 = new THREE.Color('#5a1418'), hw = RUNWAY_W / 2;
      const strip = (rA: number, yA: number, rB: number, yB: number, light: (p: P3) => number): void => {
        const a = hw / rA, bb = hw / rB;
        b.quad(polar(rA, th - a, yA), polar(rA, th + a, yA), polar(rB, th + bb, yB), polar(rB, th - bb, yB), carpet2, light);
        for (const s of [-1, 1]) for (let u = 0.15; u < 1; u += 0.7 / Math.max(0.7, Math.abs(rB - rA))) {
          const r = rA + (rB - rA) * u, q = polar(r, th + s * hw / r, yA + (yB - yA) * u + 0.05);
          lights.push({ x: q[0], y: q[1], z: q[2], color: cool, size: 0.05, twinkle: 0 });
        }
      };
      strip(Math.min(R0 - 2.2, OUTER * Math.SQRT2 + 1.6), FLOOR_Y + 0.012, R0 - 2.0, FLOOR_Y + 0.012, lit(1.1));   // from the foot of the corner steps
      strip(R0 - 2.0, FLOOR_Y + 0.012, R0 + 0.06, yFront + 0.015, lit(1.1));                                   // the ramp over the wall
      for (let i = 0; i < Math.round(c.bowlTiers); i++) {
        const r = R0 + i * c.bowlTierDepth, y = yFront + i * c.bowlTierRise + 0.015;
        if (i > 0) strip(r, y - c.bowlTierRise, r + 0.001, y, lit(1.2));
        strip(r, y, r + c.bowlTierDepth, y, lit(0.9));
      }
      strip(rL, yL + 0.015, rBack, yL + 0.015, flat(0.1 * c.practicalBrightness));
    }

    // ── Upper deck: starts at the ribbon board's top edge, overhanging the lower bowl's back row.
    const rU = rL - 0.4, yU = ySoffit + c.fasciaH;
    ring(rU, yU, rU, yU + 0.14, stair, lit(1));                           // front rail
    const upperRows = Math.round(c.upperTiers);
    const upper = upperRows > 0 ? deck(rU, yU, upperRows, c.upperRise, c.upperDepth, 0, 2, 3) : { rEnd: rU, yEnd: yU };
    const yRoof = upper.yEnd + 4.5;
    ring(upper.rEnd, upper.yEnd, upper.rEnd, yRoof, concrete, lit(0.6));  // back wall
    // Roof catwalk lamps: a ring of small cool lights high over the upper deck, a tighter ring over the lower bowl.
    for (let i = 0; i < 56; i++) { const p = polar(upper.rEnd - 1.5, (i + 0.5) * TAU / 56, yRoof - 0.4); lights.push({ x: p[0], y: p[1], z: p[2], color: cool, size: 0.2, twinkle: 0 }); }
    for (let i = 0; i < 32; i++) { const p = polar((R0 + rL) / 2, i * TAU / 32, yRoof - 0.2); lights.push({ x: p[0], y: p[1], z: p[2], color: cool, size: 0.16, twinkle: 0 }); }

    // ── Ringside floor: press tables on all four sides, straight rows behind them, corner teams, camera platforms.
    const cloth = new THREE.Color('#2a2c3c'), steel = new THREE.Color('#3a3c44'), screen = new THREE.Color('#9fc4ff');
    const tableD = OUTER + 1.05, tableLen = 5.6;
    const rowDs = [tableD + 0.55, tableD + 1.4, tableD + 2.25, tableD + 3.1];
    for (let sIdx = 0; sIdx < 4; sIdx++) {
      const a = sIdx * Math.PI / 2;                       // outward normal of this side
      const nx = Math.cos(a), nz = Math.sin(a), tx = -nz, tz = nx;
      b.box(nx * tableD, FLOOR_Y + 0.37, nz * tableD, tableLen, 0.74, 0.62, -a + Math.PI / 2, cloth, lit(0.9), 1, 0.7);
      for (let m = 0; m < 6; m++) {                       // monitors: dark slabs whose lit face looks at the press, away from the ring
        const u = (m + 0.5) / 6 * tableLen - tableLen / 2 + (rng() - 0.5) * 0.2;
        const mx = nx * (tableD - 0.05) + tx * u, mz = nz * (tableD - 0.05) + tz * u, my = FLOOR_Y + 0.86, hw = 0.17, hh = 0.11;
        b.box(mx, my, mz, hw * 2, hh * 2, 0.03, -a + Math.PI / 2, steel, lit(0.5), 1, 1);
        const fx = mx + nx * 0.02, fz = mz + nz * 0.02;
        b.quad([fx - tx * hw, my - hh, fz - tz * hw], [fx + tx * hw, my - hh, fz + tz * hw], [fx + tx * hw, my + hh, fz + tz * hw], [fx - tx * hw, my + hh, fz - tz * hw],
          screen, flat(0.55 * c.practicalBrightness));
      }
      rowDs.forEach((d, row) => {
        const half = Math.min(d * 0.78, Math.sqrt(Math.max(0, (R0 - 0.9) ** 2 - d * d)));
        const n = Math.floor(half * 2 / SEAT_PITCH);
        for (let s = 0; s < n; s++) {
          if (row > 0 && rng() < 0.05) continue;         // the odd empty chair
          const u = ((s + 0.5) / n - 0.5) * half * 2 + (rng() - 0.5) * 0.08;
          const x = nx * d + tx * u, z = nz * d + tz * u;
          seats.push({ x, y: FLOOR_Y, z, yaw: Math.atan2(-nx, -nz), zone: 0, role: row === 0 ? 'press' : 'fan' });
        }
      });
      // Camera platform on the axis, behind the last row: riser, tripod, camera, operator, tally light.
      const pr = Math.min(R0 - 0.9, rowDs[rowDs.length - 1]! + 0.95), px = nx * pr, pz = nz * pr, topY = FLOOR_Y + 0.55;
      b.box(px, FLOOR_Y + 0.275, pz, 1.5, 0.55, 1.3, -a + Math.PI / 2, steel, lit(0.9), 1, 0.7);
      b.box(px - nx * 0.35, topY + 0.6, pz - nz * 0.35, 0.07, 1.2, 0.07, 0, steel, lit(0.9), 1, 0.8);
      b.box(px - nx * 0.4, topY + 1.3, pz - nz * 0.4, 0.26, 0.24, 0.62, -a + Math.PI / 2, steel, lit(1), 1, 0.9);
      lights.push({ x: px - nx * 0.72, y: topY + 1.38, z: pz - nz * 0.72, color: tally, size: 0.05, twinkle: 0 });
      seats.push({ x: px + nx * 0.25, y: topY, z: pz + nz * 0.25, yaw: Math.atan2(-nx, -nz), zone: 0, role: 'corner' });
    }
    // Corner teams: two standing at the red (+x,+z) and blue (−x,−z) corners, on the floor beside the steps.
    for (const sgn of [1, -1]) for (const [ox, oz] of [[OUTER + 0.55, OUTER - 1.3], [OUTER - 1.3, OUTER + 0.55]] as [number, number][]) {
      const x = sgn * ox, z = sgn * oz;
      seats.push({ x, y: FLOOR_Y, z, yaw: Math.atan2(-x, -z), zone: 0, role: 'corner' });
    }

    const structure = new THREE.Mesh(b.build(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.group.add(structure);

    // ── LED boards: the barrier on the front wall, the ribbon on the upper deck's fascia. Seen from inside, so back faces, mirrored u.
    {
      const cv = paintLedStrip();
      const mk = (repeat: number): THREE.CanvasTexture => {
        const t = canvasTexture(cv, this.aniso);
        t.wrapS = THREE.RepeatWrapping; t.repeat.set(-repeat, 1);
        return t;
      };
      this.barrierMat = new THREE.MeshBasicMaterial({ map: mk(Math.max(1, Math.round(TAU * R0 / 20))), side: THREE.BackSide });
      const barrier = new THREE.Mesh(new THREE.CylinderGeometry(R0 - 0.03, R0 - 0.03, ledH, 96, 1, true).translate(0, yFront - ledH / 2, 0), this.barrierMat);
      this.ribbonTex = mk(Math.max(1, Math.round(TAU * rU / 22)));
      this.ribbonMat = new THREE.MeshBasicMaterial({ map: this.ribbonTex, side: THREE.BackSide });
      const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(rU, rU, c.fasciaH, 96, 1, true).translate(0, ySoffit + c.fasciaH / 2, 0), this.ribbonMat);
      this.group.add(barrier, ribbon);
    }

    // ── Crowd: thin to the cap (ringside always kept), scatter phones through the fans.
    {
      const cap = Math.round(c.crowdCount * (high ? 1 : c.lowCrowdScale));
      // What the play camera sees is full: ringside always, the lower bowl next, the upper deck takes what is left of the cap.
      const floor = seats.filter(s => s.zone === 0), bowl = seats.filter(s => s.zone === 1), deck2 = seats.filter(s => s.zone === 2);
      const keepBowl = Math.min(0.97, Math.max(0, cap - floor.length) / Math.max(1, bowl.length));
      const bowlKept = bowl.filter(() => rng() < keepBowl);
      const keepDeck = Math.min(0.95, Math.max(0, cap - floor.length - bowlKept.length) / Math.max(1, deck2.length));
      const chosen = cap > 0 ? [...floor, ...bowlKept, ...deck2.filter(() => rng() < keepDeck)] : [];
      this.stats = { seats: seats.length, people: chosen.length };
      if (chosen.length) {
        this.crowd = new Crowd(chosen, c, rng, high);
        this.group.add(this.crowd.group);
        for (const s of chosen) if (s.role === 'fan' && rng() < 0.008) {
          lights.push({ x: s.x + Math.sin(s.yaw) * 0.25, y: s.y + 1.02, z: s.z + Math.cos(s.yaw) * 0.25, color: cool, size: 0.05, twinkle: 0.05 + rng() });
        }
        const nFlash = Math.round(c.flashCount * (high ? 1 : 0.5));
        if (nFlash > 0) {
          this.flashes = new CrowdFlashes(chosen.filter(s => s.role === 'fan'), nFlash);
          this.group.add(this.flashes.points);
        }
      }
    }

    // ── Truss: two square chords with struts and cross-braces, hung from the roof. Fixtures: housings + lit lenses.
    const S = c.trussSize / 2, H = c.trussHeight;
    {
      const bar = 0.16, geos: THREE.BufferGeometry[] = [], m = new THREE.Matrix4();
      for (const lvl of [0, 0.55]) {
        geos.push(new THREE.BoxGeometry(S * 2 + bar, bar, bar).applyMatrix4(m.makeTranslation(0, H + lvl, S)));
        geos.push(new THREE.BoxGeometry(S * 2 + bar, bar, bar).applyMatrix4(m.makeTranslation(0, H + lvl, -S)));
        geos.push(new THREE.BoxGeometry(bar, bar, S * 2 + bar).applyMatrix4(m.makeTranslation(S, H + lvl, 0)));
        geos.push(new THREE.BoxGeometry(bar, bar, S * 2 + bar).applyMatrix4(m.makeTranslation(-S, H + lvl, 0)));
      }
      // cross spars carrying the key cluster
      geos.push(new THREE.BoxGeometry(S * 2, bar * 0.8, bar * 0.8).applyMatrix4(m.makeTranslation(0, H, 0)));
      geos.push(new THREE.BoxGeometry(bar * 0.8, bar * 0.8, S * 2).applyMatrix4(m.makeTranslation(0, H, 0)));
      const n = Math.max(2, Math.round(c.trussSize / 0.9));
      const q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), zAxis = new THREE.Vector3(0, 0, 1), xAxis = new THREE.Vector3(1, 0, 0);
      for (let i = 0; i < n; i++) {
        const p = -S + ((i + 0.5) / n) * S * 2, lean = (i % 2 ? 1 : -1) * Math.atan2(S * 2 / n, 0.55);
        const len = Math.hypot(S * 2 / n, 0.55);
        for (const z of [S, -S]) geos.push(new THREE.BoxGeometry(0.05, len, 0.05).applyMatrix4(m.compose(new THREE.Vector3(p, H + 0.275, z), q.setFromAxisAngle(zAxis, lean), one)));
        for (const x of [S, -S]) geos.push(new THREE.BoxGeometry(0.05, len, 0.05).applyMatrix4(m.compose(new THREE.Vector3(x, H + 0.275, p), q.setFromAxisAngle(xAxis, lean), one)));
      }
      for (const [x, z] of [[S, S], [S, -S], [-S, S], [-S, -S]] as [number, number][]) {
        geos.push(new THREE.BoxGeometry(0.03, yRoof - H, 0.03).applyMatrix4(m.makeTranslation(x, (yRoof + H) / 2 + 0.3, z)));   // hang cables
      }
      this.group.add(new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: 0x34343c, roughness: 0.55, metalness: 0.6 })));
    }

    // ── Beams and their lamps.
    const beamCol = new THREE.Color(c.beamColor);
    const beams: BeamSpec[] = [];
    const lamps: { from: THREE.Vector3; to: THREE.Vector3; color: THREE.Color; r: number }[] = [];
    const onSquare = (a: number): THREE.Vector3 => { const sc = S / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))); return new THREE.Vector3(Math.cos(a) * sc, H - 0.15, Math.sin(a) * sc); };
    const nKey = Math.round(high ? c.beamCount : Math.min(c.beamCount, c.lowBeamCount));
    for (let k = 0; k < nKey; k++) {
      const a = (k + 0.5) * TAU / nKey;                 // mid-sides: the corners belong to the back lights
      const from = onSquare(a), to = new THREE.Vector3(-Math.cos(a) * 0.5, 0.25, -Math.sin(a) * 0.5);
      beams.push({ from, to, r0: 0.16, r1: c.beamRadius, color: beamCol, level: c.beamOpacity });
      lamps.push({ from, to, color: beamCol, r: 1 });
    }
    const backA = new THREE.Color(c.backColorA), backB = new THREE.Color(c.backColorB);
    for (const [sgn, col] of [[1, backA], [-1, backB]] as [number, THREE.Color][]) {
      const from = new THREE.Vector3(sgn * S, H - 0.15, sgn * S), to = new THREE.Vector3(-sgn * 0.6, 0.4, -sgn * 0.6);
      if (high) beams.push({ from, to, r0: 0.14, r1: c.beamRadius * 0.8, color: col, level: c.backBeamOpacity });
      lamps.push({ from, to, color: col, r: 1 });
    }
    for (let i = 0; i < 16; i++) {                        // wash lamps along the chords (no visible beam)
      const from = onSquare((i + 0.25) * TAU / 16);
      lamps.push({ from, to: new THREE.Vector3(from.x * 0.2, 0, from.z * 0.2), color: i % 4 === 0 ? backA : i % 4 === 2 ? backB : beamCol, r: 0.7 });
    }
    if (high) for (let k = 0; k < Math.round(c.houseBeamCount); k++) {
      const a = (k + 0.5) * TAU / Math.round(c.houseBeamCount) + 0.2;
      const f = polar(Math.max(S + 1, R0 - 2.2), a, yRoof - 0.3), t = polar((R0 + rL) / 2 + 0.5, a, yFront + 0.8);
      const from = new THREE.Vector3(f[0], f[1], f[2]), to = new THREE.Vector3(t[0], t[1], t[2]);
      beams.push({ from, to, r0: 0.12, r1: 1.5, color: beamCol, level: c.houseBeamOpacity });
      lights.push({ x: from.x, y: from.y, z: from.z, color: cool, size: 0.3, twinkle: 0 });
    }
    {
      const housings = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.19, 0.36, 10), new THREE.MeshStandardMaterial({ color: 0x18181c, roughness: 0.5, metalness: 0.4 }), lamps.length);
      const lenses = new THREE.InstancedMesh(new THREE.CircleGeometry(0.17, 12), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), lamps.length);
      const q = new THREE.Quaternion(), s = new THREE.Vector3(), lensQ = new THREE.Quaternion(), fwd = new THREE.Vector3(0, 0, 1), col = new THREE.Color();
      lamps.forEach((l, i) => {
        const dir = l.to.clone().sub(l.from).normalize();
        housings.setMatrixAt(i, this.tmpM.compose(l.from, q.setFromUnitVectors(UP, dir), s.setScalar(l.r)));
        lenses.setMatrixAt(i, this.tmpM.compose(l.from.clone().addScaledVector(dir, 0.19 * l.r), lensQ.setFromUnitVectors(fwd, dir), s.setScalar(l.r)));
        lenses.setColorAt(i, col.copy(l.color).multiplyScalar(2.4));
      });
      this.group.add(housings, lenses);
    }
    if (beams.length) { this.beams = new Beams(beams); this.group.add(this.beams.mesh); }

    // ── Haze, motes (high tier only).
    // The haze layer is one back-face cylinder and two texture fetches a pixel: both tiers get it (thinner on low,
    // lowHazeScale), so the stands sit behind the same veil whichever tier is drawing. Motes stay high-tier.
    // Exception: a software rasteriser on the low tier (the headless test runs). A blended layer over half the
    // frame at 2× slowed every browser check enough to time one out (flow_check, 2026-11-11); real low-tier
    // devices have a GPU and keep the haze.
    this.hazeScale = high ? 1 : c.lowHazeScale;
    if ((high || !softwareRenderer()) && this.hazeScale > 0) {
      this.haze = new Haze(Math.min(c.hazeRadius, R0 - 0.3), FLOOR_Y, c.hazeHeight);
      this.group.add(this.haze.mesh);
    }
    if (high) {
      if (c.moteCount > 0) { this.motes = new Motes(Math.round(c.moteCount), RING_HALF + 0.4, 0.4, c.keyHeight - 0.6, rng); this.group.add(this.motes.points); }
    }

    // ── Scoreboard: a four-sided cube hung over the middle, above the truss.
    {
      const w = c.jumbotronSize, h = w * 0.56, y = H + 1.3 + h / 2;
      const [cv] = makeCanvas(512, 288);
      this.boardTex = canvasTexture(cv, this.aniso);
      this.boardMat = new THREE.MeshBasicMaterial({ map: this.boardTex });
      const faces: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 4; k++) faces.push(new THREE.PlaneGeometry(w, h).applyMatrix4(new THREE.Matrix4().makeRotationY(k * Math.PI / 2).multiply(new THREE.Matrix4().makeTranslation(0, y, w / 2 + 0.02))));
      // The housing sits INSIDE the screens' square (phase 1 had it 0.1 m outside them: four black faces, found the
      // first time the board was put in a frame); a rim top and bottom is the bezel.
      const frame = mergeGeometries([new THREE.BoxGeometry(w - 0.04, h + 0.3, w - 0.04).translate(0, y, 0),
        new THREE.BoxGeometry(w + 0.16, 0.1, w + 0.16).translate(0, y + h / 2 + 0.05, 0), new THREE.BoxGeometry(w + 0.16, 0.1, w + 0.16).translate(0, y - h / 2 - 0.05, 0)]);
      const hang = new THREE.BoxGeometry(0.06, yRoof - y, 0.06).translate(0, (yRoof + y) / 2 + h / 2, 0);
      this.group.add(new THREE.Mesh(mergeGeometries(faces), this.boardMat),
        new THREE.Mesh(mergeGeometries([frame, hang]), new THREE.MeshStandardMaterial({ color: 0x101014, roughness: 0.7 })));
      this.paintBoard();
    }

    if (lights.length) { this.practicals = new Practicals(lights); this.group.add(this.practicals.points); }
  }

  /** The scoreboard's screens: `lines` of text (round, clock — the host decides), or null for the title sponsor's card. */
  setBoardText(lines: readonly string[] | null): void {
    if (lines && this.boardText && lines.length === this.boardText.length && lines.every((l, i) => l === this.boardText![i])) return;
    if (!lines && !this.boardText) return;
    this.boardText = lines ? [...lines] : null;
    this.paintBoard();
  }

  private paintBoard(): void {
    if (!this.boardTex) return;
    const cv = this.boardTex.image as HTMLCanvasElement;
    const g = cv.getContext('2d');
    if (!g) return;
    const w = cv.width, h = cv.height;
    if (!this.boardText) {
      const tex = paintSlot(SPONSORS[0]!, 'roundCard');
      g.drawImage(tex.image as HTMLCanvasElement, 0, 0, w, h);
      tex.dispose();
    } else {
      g.fillStyle = '#05060a'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#f4f4f8'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const n = this.boardText.length;
      this.boardText.forEach((line, i) => {
        let px = Math.min(h / (n + 0.6), 120);
        for (;;) { g.font = `bold ${Math.round(px)}px system-ui, Helvetica, Arial, sans-serif`; if (g.measureText(line).width <= w * 0.9 || px < 10) break; px *= 0.92; }
        g.fillText(line, w / 2, h * (i + 0.5) / n);
      });
    }
    this.boardTex.needsUpdate = true;
  }

  /** A reaction from the mood: a ripple through the stands from the side it happened on, and a burst of flashes on the big ones. */
  react(r: Reaction, c: Config): void {
    const wave: Partial<Record<Reaction['kind'], number>> = { land: 0.1, body: 0.12, flush: 0.3, counter: 0.35, rocked: 0.55, knockdown: 0.9, ko: 1, nearMiss: 0.08, getUp: 0.4, bell: 0.2, decision: 0.5,
      escape: 0.15, guardBreak: 0.35, liver: 0.15, bodyHurt: 0.45, ole: 0.2, knee: 0.3, rise: 0.55, wince: 0.5, shock: 0.9 };
    const burst: Partial<Record<Reaction['kind'], number>> = { flush: 0.15, counter: 0.35, rocked: 0.5, knockdown: 1, ko: 1.3, getUp: 0.3, decision: 0.6,
      guardBreak: 0.2, bodyHurt: 0.3, rise: 0.4, wince: 0.6, shock: 1 };
    const w = (wave[r.kind] ?? 0) * Math.min(1.5, r.strength);
    if (w > 0 && this.crowd) {
      // The ripple starts at the ringside nearest the event: push the point out to the apron along its bearing from the centre.
      let x = 0, z = 0;
      if (r.pos) { const d = Math.hypot(r.pos.x, r.pos.z); if (d > 0.05) { x = r.pos.x / d * (OUTER + 1.5); z = r.pos.z / d * (OUTER + 1.5); } }
      this.crowd.wave(x, z, w, this.clock);
    }
    const n = (burst[r.kind] ?? 0) * c.flashBurst * Math.min(1.5, r.strength);
    if (n >= 1) this.flashes?.burst(Math.round(n), 1.2);
  }

  /** Per-frame: uniforms only. `dt` frame seconds, `excite` 0..1 from the mood, `viewportH` the drawing buffer height in px. */
  update(c: Config, dt: number, camera: THREE.PerspectiveCamera, fog: THREE.Fog, viewportH: number, excite: number): void {
    this.clock += dt;
    const t = this.clock;
    const pxPerM = viewportH / (2 * Math.tan(camera.fov * Math.PI / 360));
    if (this.crowd) { this.crowd.group.visible = c.crowdEnabled; this.crowd.update(c, t, excite, fog, OUTER, this.flashes?.pulse ?? 0); }
    if (this.flashes) { this.flashes.points.visible = c.crowdEnabled; this.flashes.update(c, t, dt, excite, pxPerM); }
    this.beams?.update(c, t);
    this.haze?.update(c, t, this.hazeScale);
    this.motes?.update(c, t, pxPerM);
    this.practicals?.update(c, t, pxPerM, fog);
    if (this.ribbonMat && this.ribbonTex) { this.ribbonMat.color.setScalar(c.ledBrightness); this.ribbonTex.offset.x = (this.ribbonTex.offset.x + c.ledScroll * Math.abs(this.ribbonTex.repeat.x) * dt) % 1; }
    this.barrierMat?.color.setScalar(c.barrierBrightness);
    this.boardMat?.color.setScalar(c.jumbotronBrightness);
  }

  dispose(): void {
    this.crowd?.dispose(); this.flashes?.dispose(); this.beams?.dispose(); this.haze?.dispose(); this.motes?.dispose(); this.practicals?.dispose();
    disposeTree(this.group);
  }
}

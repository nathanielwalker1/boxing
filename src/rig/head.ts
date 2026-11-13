/**
 * rig/head.ts — the head: skull, face, ears, hair and facial hair (overhaul
 * 2026-11-11). The skull fills the sim's head hit sphere (BodyDims.headR): the
 * crown is at +R, the chin at −R, the face a little inside the front.
 *
 * The head is a vertical loft: rows of a superellipse (half-width, front
 * depth, back depth per height, authored as a table in head radii) with the
 * features added on top — brow ridge, eye sockets, a nose with a bridge,
 * cheekbones, lips, chin, jaw corners. Columns are packed toward the face.
 * The eyes, brows, lips and nostrils are painted (paint.ts) at the same
 * (angle, height) landmarks exported here as FACE.
 *
 * Expression is morph targets on the same vertices (mesh.ts MORPHS):
 *   wince      the eyes squeeze shut, the brow comes down, the cheeks rise
 *   mouthOpen  the jaw drops; the painted strip between the two mouth rows
 *              (closed: zero height) opens to show the mouthguard and the dark
 *   swellL/R   the cheek under one eye swells out and closes the eye
 *
 * Hair and facial hair are shells over the same surface: a thickness function
 * over a scalp or jaw mask, plus hanging pieces (braids, dreads, a tail, a
 * long beard) weighted to the sprung `tail` bone.
 */
import * as THREE from 'three';
import type { FacialHair, HairStyle } from '../core';
import { addGrid, bump, KIND, sampleKeys, sgnPow, smooth01, type BW } from './geo';
import { BONE, type Ctx } from './skeleton';

/** Face landmarks in (angle from the front, radians; height in head radii). Shared with the painter. */
export const FACE = {
  eyeTh: 0.4, eyeY: 0.15, eyeHalfTh: 0.175, eyeHalfY: 0.062,
  browY: 0.31, mouthY: -0.5, mouthHalfTh: 0.36, lipH: 0.055,
  noseTipY: -0.18, noseBaseY: -0.27,
  /** Half-height of the mouth-interior strip in atlas v (the two mouth rows sit on its edges). */
  mouthStripV: 0.014,
} as const;

/** Row heights in head radii, crown → chin. Dense through the eyes and the mouth; the mouth row is doubled. */
const ROWS_Y = [
  1.0, 0.975, 0.92, 0.83, 0.72, 0.6, 0.5, 0.42, 0.355, 0.31, 0.265, 0.225, 0.19, 0.15, 0.11, 0.075, 0.03, -0.03, -0.1, -0.16, -0.21,
  -0.25, -0.29, -0.34, -0.4, -0.45, -0.485, -0.5, -0.5, -0.515, -0.55, -0.6, -0.67, -0.75, -0.83, -0.9, -0.955, -1.0,
];
/** How far the jaw swings at mouthOpen = 1. Was 15: from the play camera it read as a chin moving, not a mouth opening. */
const JAW_OPEN_DEG = 25;
const MOUTH_UPPER = ROWS_Y.indexOf(-0.5);
const MOUTH_LOWER = MOUTH_UPPER + 1;

// y, half-width, front depth, back depth, squareness — in head radii.
const SKULL: number[][] = [
  [-1.0, 0, 0.55, -0.3, 2],
  // Phase 2: a jaw. The lower face holds its width down to the jaw line and runs BACK under the ear (B stays
  // large to −0.66), then cuts in sharply below — a jaw angle and a flat underside instead of a face that tapers into the neck.
  [-0.955, 0.27, 0.76, -0.16, 2.2],
  [-0.9, 0.38, 0.82, 0.04, 2.5],
  [-0.8, 0.52, 0.86, 0.34, 2.8],
  [-0.66, 0.615, 0.86, 0.56, 2.9],
  [-0.52, 0.66, 0.875, 0.64, 2.7],
  [-0.4, 0.69, 0.885, 0.74, 2.55],
  [-0.2, 0.715, 0.875, 0.87, 2.4],
  [0.02, 0.755, 0.86, 0.955, 2.35],
  [0.18, 0.76, 0.845, 0.98, 2.3],
  [0.31, 0.755, 0.865, 0.97, 2.3],
  [0.5, 0.73, 0.8, 0.92, 2.25],
  [0.7, 0.655, 0.68, 0.8, 2.2],
  [0.86, 0.51, 0.5, 0.6, 2.1],
  [0.96, 0.29, 0.28, 0.33, 2.05],
  [1.0, 0, 0, 0, 2],
];
const SKULL_KEYS = SKULL.map(s => s[0]!);
const SKULL_VALS = SKULL.map(s => s.slice(1));

export interface HeadShape {
  R: number;
  rowsY: readonly number[];
  cols: number;
  /** Column → angle from the front (−π..π), packed toward the face. */
  theta(u: number): number;
  /** Angle → atlas u (inverse of theta). */
  uOf(theta: number): number;
  /** Height (head radii) → atlas v, 0 at the crown. */
  vOf(y: number): number;
  /** Surface point in head-local metres (the head centre is the origin, the face on +x). `lift` = metres off the surface. */
  point(theta: number, y: number, out: THREE.Vector3, lift?: number): void;
}

const WARP = 0.42;
const thetaOf = (u: number): number => { const s = 2 * u - 1; return Math.PI * s - WARP * Math.sin(Math.PI * s); };
const uOfTheta = (th: number): number => {
  let lo = 0, hi = 1;
  for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (thetaOf(mid) < th) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
};

/** Angle from the front → the head rect's u, and back (for the painter). */
export const headU = uOfTheta;
export const headTheta = thetaOf;

export function headShape(c: Ctx): HeadShape {
  const R = c.body.headR;
  const hm = c.m.head;
  const fat = Math.max(0, c.m.bodyFat);
  const row = [0, 0, 0, 0];
  const wide = 1 + 0.07 * hm.width + 0.04 * fat;
  const point = (th: number, y: number, out: THREE.Vector3, lift = 0): void => {
    sampleKeys(SKULL_KEYS, SKULL_VALS, y, row);
    const cf = Math.cos(th), sn = Math.sin(th);
    const lower = smooth01((0.05 - y) / 0.6);            // 0 above the cheekbones → 1 at the jaw
    const W = row[0]! * wide * (1 + lower * (0.13 * hm.jaw + 0.1 * fat));
    const F = row[1]! + (y < -0.6 ? 0.07 * hm.chin * bump((y + 0.84) / 0.3) : 0);
    const B = row[2]!;
    const n = row[3]! + lower * 0.25 * Math.max(0, hm.jaw);
    // A row spans x from −B to F about its own centre: under the cheekbones the back of the row
    // comes forward (B shrinks, then goes negative), so the jaw rows close under the face and the neck takes over behind.
    const cx = (F - B) / 2, a = (F + B) / 2;
    let x = a * sgnPow(cf, n), z = W * sgnPow(sn, n);
    const ath = Math.abs(th);
    const front = smooth01((cf + 0.05) / 0.5);
    let h = 0;                                            // radial relief, head radii
    // Brow ridge and the sockets under it.
    // Phase 1.3: a heavier brow ridge, deeper sockets, a firmer cheekbone and a jawline that runs from the corner to the chin.
    h += front * (0.05 + 0.04 * hm.brow) * bump((y - FACE.browY) / 0.1) * bump(ath / 1.15);
    h -= front * 0.09 * bump((ath - FACE.eyeTh) / 0.3) * bump((y - FACE.eyeY) / 0.13);
    h -= front * 0.035 * bump(ath / 0.16) * bump((y - 0.2) / 0.12);                      // the nasion, between the eyes
    // Cheekbones, the hollow under them, the jaw corner and the line of the jaw.
    h += 0.045 * (1 + 0.5 * hm.width) * bump((ath - 0.95) / 0.5) * bump((y + 0.03) / 0.16);
    h -= 0.04 * (1 - fat) * bump((ath - 0.85) / 0.45) * bump((y + 0.36) / 0.2);
    h += (0.04 + 0.05 * hm.jaw) * bump((ath - 1.45) / 0.5) * bump((y + 0.55) / 0.22);
    h += (0.02 + 0.02 * hm.jaw) * (1 - fat) * bump((ath - 1.0) / 0.5) * bump((y + 0.8) / 0.1);
    // Lips, the groove between them, the chin.
    const mouthW = bump(ath / (FACE.mouthHalfTh * 1.25));
    h += front * 0.035 * mouthW * bump((y - (FACE.mouthY + 0.06)) / 0.07);
    h += front * 0.04 * mouthW * bump((y - (FACE.mouthY - 0.065)) / 0.075);
    h -= front * 0.02 * mouthW * bump((y - FACE.mouthY) / 0.03);
    h -= front * 0.025 * bump(ath / 0.4) * bump((y + 0.67) / 0.07);                      // under the lower lip
    h -= front * 0.014 * bump(ath / 0.07) * bump((y - (FACE.mouthY + 0.17)) / 0.08);     // the philtrum
    h += front * (0.035 + 0.04 * hm.chin) * bump(ath / 0.42) * bump((y + 0.84) / 0.14);
    // Temples.
    h -= 0.02 * bump((ath - 1.15) / 0.4) * bump((y - 0.36) / 0.2);
    const r = Math.hypot(x, z);
    if (r > 1e-6) { const k = (r + h + lift / R) / r; x *= k; z *= k; }
    x += cx;
    // Nose: a ridge from the bridge to the tip, then the wings; pushed straight forward.
    const ns = 1 + 0.35 * hm.nose;
    const t = (FACE.eyeY + 0.03 - y) / (FACE.eyeY + 0.03 - FACE.noseTipY);                // 0 at the bridge → 1 at the tip
    if (t > -0.2 && y > FACE.noseBaseY - 0.06) {
      const along = y >= FACE.noseTipY ? 0.05 + 0.21 * Math.pow(Math.max(0, Math.min(1, t)), 1.25) : 0.26 * smooth01((y - (FACE.noseBaseY - 0.05)) / (FACE.noseTipY - FACE.noseBaseY + 0.05));
      // A ridge, not a plane: narrow at the bridge, a sharpened cross-section, wider at the wings.
      const width = 0.07 + 0.12 * Math.pow(Math.max(0, Math.min(1, t)), 1.5) * ns;
      x += ns * along * Math.pow(bump(ath / (width * 2.6)), 1.8) * smooth01((t + 0.2) / 0.2);
    }
    // The nostril mass: a wing (ala) each side of the tip, standing out from the cheek, with the nostril hollow under it.
    x += 0.04 * ns * bump((ath - 0.2) / 0.1) * bump((y - (FACE.noseBaseY + 0.045)) / 0.06) * front;
    x -= 0.012 * bump((ath - 0.13) / 0.07) * bump((y - (FACE.noseBaseY - 0.005)) / 0.035) * front;
    const yy = y >= 0 ? y * (1 + 0.07 * hm.height) : y * (1 + 0.05 * hm.chin);
    out.set(x * R, yy * R + (lift && y > 0.9 ? lift : 0), z * R);
  };
  return {
    R, rowsY: ROWS_Y, cols: c.low ? 28 : 44,
    theta: thetaOf, uOf: uOfTheta,
    vOf: y => (1 - y) / 2,
    point,
  };
}

/** Jaw-drop weight of a head vertex (mouthOpen): the chin and lower lip full, the cheeks easing off, the skull none. */
function jawWeight(th: number, y: number, lowerRow: boolean): number {
  const ath = Math.abs(th);
  const front = smooth01((Math.cos(th) + 0.15) / 0.6);
  const inMouth = bump(ath / (FACE.mouthHalfTh * 1.05));
  if (lowerRow) return inMouth * inMouth;
  if (y >= FACE.mouthY) return 0;
  return front * Math.max(inMouth, smooth01((FACE.mouthY - y) / 0.22));
}

export function buildHead(c: Ctx, hs: HeadShape): void {
  const { R, rowsY, cols } = hs;
  const H = c.bind[BONE.head]!;
  const tmp = new THREE.Vector3();
  const pivot = new THREE.Vector2(-0.1 * R, -0.12 * R);     // the jaw's hinge, by the ear (x, y)
  const jawOpen = JAW_OPEN_DEG * Math.PI / 180;
  const cj = Math.cos(-jawOpen), sj = Math.sin(-jawOpen);
  addGrid(c.g, {
    rows: rowsY.length, cols, wrap: true,
    point: (i, j, out) => { hs.point(hs.theta(j / cols), rowsY[i]!, out); out.add(H); },
    weights: p => {
      // The underside of the jaw at the back blends into the neck.
      const below = smooth01((H.y - R * 0.55 - p.y) / (R * 0.4)) * smooth01((R * 0.3 - (p.x - H.x)) / (R * 0.5));
      return below > 0.01 ? [[BONE.head, 1 - 0.5 * below], [BONE.neck, 0.5 * below]] as BW[] : [[BONE.head, 1]] as BW[];
    },
    rect: c.rect('head'),
    kind: KIND.face,
    uv: (i, j) => {
      let v = hs.vOf(rowsY[i]!);
      if (i === MOUTH_UPPER) v -= FACE.mouthStripV; else if (i === MOUTH_LOWER) v += FACE.mouthStripV;
      else if (i < MOUTH_UPPER) v -= FACE.mouthStripV * smooth01(1 - (MOUTH_UPPER - i) / 3);
      else v += FACE.mouthStripV * smooth01(1 - (i - MOUTH_LOWER) / 3);
      return [j / cols, v];
    },
    tint: (p) => {
      // Warmth in the cheeks, nose and ears' neighbourhood; a little shadow in the sockets comes from the AO.
      const x = (p.x - H.x) / R, y = (p.y - H.y) / R, z = Math.abs(p.z - H.z) / R;
      const cheek = x > 0.3 ? bump((z - 0.5) / 0.3) * bump((y + 0.12) / 0.22) : 0;
      const nose = x > 0.8 ? bump((y - FACE.noseTipY) / 0.2) * bump(z / 0.2) : 0;
      const e = Math.min(1, 0.6 * cheek + 0.7 * nose);
      return [1, 1 - 0.09 * e, 1 - 0.1 * e];
    },
    ao: c.cfg.rigAoStrength * 0.9,
    morph: (p, i, j) => {
      const th = hs.theta(j / cols), y = rowsY[i]!;
      const ath = Math.abs(th);
      const out: Record<string, [number, number, number]> = {};
      // Wince: each eye squeezes toward its own line, the brow drops, the cheeks rise.
      const eye = bump((ath - FACE.eyeTh) / 0.34) * bump((y - FACE.eyeY) / 0.17);
      const brow = bump(ath / 1.1) * bump((y - (FACE.browY + 0.04)) / 0.2) * smooth01((Math.cos(th) + 0.1) / 0.5);
      const cheek = bump((ath - 0.55) / 0.5) * bump((y + 0.1) / 0.22) * smooth01((Math.cos(th) + 0.1) / 0.5);
      const wy = -(y - FACE.eyeY) * 0.92 * eye - 0.06 * brow + 0.05 * cheek;
      const wx = -0.012 * eye;
      if (Math.abs(wy) > 1e-4) out.wince = [wx * R, wy * R, -Math.sign(th) * 0.03 * brow * R];
      // Swelling under one eye: the cheek pushes out and up, the eye closes from below.
      for (const side of [-1, 1]) {
        if (Math.sign(th) !== side) continue;
        const sw = bump((ath - (FACE.eyeTh + 0.08)) / 0.5) * bump((y - (FACE.eyeY - 0.05)) / 0.3);
        if (sw < 1e-3) continue;
        const dir = tmp.copy(p).sub(H).normalize();
        const close = -(y - (FACE.eyeY + 0.03)) * 0.8 * eye;
        out[side < 0 ? 'swellL' : 'swellR'] = [dir.x * 0.085 * sw * R, (dir.y * 0.085 * sw + close) * R, dir.z * 0.085 * sw * R];
      }
      // Mouth open: the jaw swings down about its hinge.
      const jw = jawWeight(th, y, i === MOUTH_LOWER);
      if (jw > 1e-3 && i >= MOUTH_LOWER) {
        const rx = p.x - H.x - pivot.x, ry = p.y - H.y - pivot.y;
        out.mouthOpen = [(rx * cj - ry * sj - rx) * jw, (rx * sj + ry * cj - ry) * jw, 0];
      }
      const frontMask = smooth01((Math.cos(th) + 0.1) / 0.5);
      // Grimace (teeth clenched): the brow hauled down and together, the eyes narrowed, the cheeks bunched, the nose wrinkled, the lips drawn
      // back wide and thin so the strip between them opens a little onto the guard and the teeth. The jaw stays shut.
      {
        const mouthBand = bump(ath / (FACE.mouthHalfTh * 1.35)) * bump((y - FACE.mouthY) / 0.2) * frontMask;
        const lipSign = i === MOUTH_UPPER ? 1 : i === MOUTH_LOWER ? -1 : 0;
        const nose = bump(ath / 0.32) * bump((y - (FACE.noseBaseY + 0.08)) / 0.14) * frontMask;
        const gy = -(y - FACE.eyeY) * 0.6 * eye - 0.05 * brow + 0.065 * cheek + 0.035 * nose + (0.022 * lipSign + 0.0) * mouthBand * (lipSign !== 0 ? 1 : 0);
        const gx = 0.015 * brow - 0.01 * eye;
        const gz = -Math.sign(th) * 0.035 * brow + Math.sign(th) * 0.055 * mouthBand;
        if (Math.abs(gy) + Math.abs(gx) + Math.abs(gz) > 1e-4) out.grimace = [gx * R, gy * R, gz * R];
      }
      // Slack (stunned, out on his feet): the jaw hangs part-way open, the upper lids half shut, the brow and cheeks let go.
      {
        const lid = y > FACE.eyeY ? -(y - FACE.eyeY) * 0.62 * eye : 0;
        const sy = lid - 0.025 * brow - 0.02 * cheek;
        const jaw = out.mouthOpen;
        const sx = jaw ? jaw[0] * 0.5 : 0, sjy = jaw ? jaw[1] * 0.5 : 0;
        if (Math.abs(sy) + Math.abs(sx) + Math.abs(sjy) > 1e-4) out.slack = [sx, sjy + sy * R, 0];
      }
      return out;
    },
  });
  buildEars(c, hs);
}

function buildEars(c: Ctx, hs: HeadShape): void {
  const R = hs.R;
  const H = c.bind[BONE.head]!;
  const e = c.m.head.ears;
  const size = 1 + 0.28 * e, flare = (0.42 + 0.3 * e);
  const side = new THREE.Vector3();
  for (const s of [-1, 1]) {
    hs.point(s * 1.62, 0.02, side);
    const rows = c.low ? 5 : 7, cols = c.low ? 6 : 10;
    const cy = Math.cos(flare), sy = Math.sin(flare);
    addGrid(c.g, {
      rows, cols, wrap: true,
      point: (i, j, out) => {
        // A flattened ellipsoid (the ear), tipped back and flared off the skull.
        const phi = -Math.PI / 2 + Math.PI * i / (rows - 1), th = j / cols * Math.PI * 2;
        const w = 0.155 * size;
        const ex = w * Math.cos(phi) * Math.cos(th), ey = 0.26 * size * Math.sin(phi);
        // The outer face is scooped (the concha) inside a raised rim, with a fuller lobe at the bottom: an ear, not a flat petal.
        const scoop = 1 - 0.7 * Math.max(0, Math.sin(th)) * bump(ey / (0.26 * size * 0.85)) * bump((ex + 0.08 * w) / (w * 0.85));
        const lobe = 1 + 0.5 * bump((ey + 0.19 * size) / (0.1 * size));
        const ez = 0.045 * Math.cos(phi) * Math.sin(th) * scoop * lobe;
        // Rooted at its front edge, the back edge swings out by the flare; the top leans back a little.
        const q = (w - ex) / (2 * w);
        const back = q * 2 * w + 0.05 * ey;
        out.set(side.x + (0.12 - back * cy) * R, side.y + ey * R, s * (Math.abs(side.z) + (-0.035 + back * sy + ez * (0.6 + 0.6 * q)) * R));
        out.add(H);
      },
      weights: () => [[BONE.head, 1]],
      rect: c.rect('ear'), kind: KIND.face, ao: c.cfg.rigAoStrength * 0.5,
    });
  }
}

// ── Hair ─────────────────────────────────────────────────────────────────────

interface HairDef {
  /** Hairline height (head radii) at the front, the sides and the nape. */
  line: [number, number, number];
  /** Thickness in head radii at (angle, height, lateral z in radii). */
  thick: (th: number, y: number, z: number) => number;
  /** Clamp the top to this height (a flat top). */
  flat?: number;
  /** Only a strip this wide (radii) down the middle (a mohawk). */
  strip?: number;
}

const lump = (th: number, y: number, k: number): number => 0.5 + 0.5 * Math.sin(th * k + y * 7.3) * Math.sin(y * k * 1.3 + th * 2.1);

const HAIR: Partial<Record<HairStyle, HairDef>> = {
  buzz: { line: [0.6, 0.2, -0.3], thick: () => 0.022 },
  short: { line: [0.6, 0.16, -0.34], thick: (_t, y) => 0.05 + 0.035 * smooth01((y - 0.4) / 0.4) },
  fade: { line: [0.62, 0.5, 0.42], thick: (_t, y) => 0.03 + 0.08 * smooth01((y - 0.55) / 0.3) },
  flatTop: { line: [0.62, 0.42, 0.3], thick: (_t, y) => 0.05 + 0.4 * smooth01((y - 0.5) / 0.25), flat: 1.24 },
  curls: { line: [0.58, 0.16, -0.36], thick: (t, y) => 0.08 + 0.07 * lump(t, y, 11) },
  afro: { line: [0.56, 0.1, -0.4], thick: (t, y) => 0.3 + 0.12 * smooth01((y + 0.2) / 0.6) + 0.05 * lump(t, y, 9) },
  cornrows: { line: [0.62, 0.16, -0.36], thick: (_t, _y, z) => 0.03 + 0.04 * Math.pow(0.5 + 0.5 * Math.cos(z * 24), 2) },
  braids: { line: [0.62, 0.16, -0.36], thick: (_t, _y, z) => 0.04 + 0.035 * Math.pow(0.5 + 0.5 * Math.cos(z * 20), 2) },
  dreads: { line: [0.6, 0.14, -0.38], thick: (t, y) => 0.07 + 0.05 * lump(t, y, 14) },
  long: { line: [0.6, 0.1, -0.42], thick: (_t, y) => 0.08 + 0.04 * smooth01((0.5 - y) / 0.8) },
  tied: { line: [0.64, 0.18, -0.34], thick: (th) => 0.04 + 0.03 * smooth01((Math.abs(th) - 1.6) / 1.2) },
  topKnot: { line: [0.64, 0.5, 0.4], thick: (_t, y) => 0.03 + 0.03 * smooth01((y - 0.6) / 0.3) },
  mohawk: { line: [0.5, 0.5, -0.3], thick: (th, y) => 0.26 * (0.55 + 0.45 * smooth01((y - 0.2) / 0.5)) * (0.7 + 0.3 * Math.abs(Math.sin(th * 3 + y * 9))), strip: 0.17 },
  receding: { line: [0.86, 0.3, -0.32], thick: (_t, y) => 0.04 + 0.02 * smooth01((0.9 - y) / 0.5) },
  slick: { line: [0.62, 0.16, -0.36], thick: (th, y) => 0.05 + 0.05 * smooth01((Math.abs(th) - 1.3) / 1.5) + 0.02 * smooth01((y - 0.5) / 0.4) },
};

/** Hairline height at an angle: front → temple → side → nape. */
function hairline(d: HairDef, ath: number): number {
  const [f, s, b] = d.line;
  if (ath < 0.75) return f - 0.04 * bump(ath / 0.3) + 0.1 * smooth01((ath - 0.45) / 0.3);   // a slight peak, then up into the temple corner
  if (ath < 1.25) { const t = smooth01((ath - 0.75) / 0.5); return (f + 0.1) * (1 - t) + s * t; }
  if (ath < 2.0) return s;
  const t = smooth01((ath - 2.0) / 0.7);
  return s * (1 - t) + b * t;
}

/** Skull half-width (head radii) at a height, for the painter's idea of where a point sits sideways. */
function skullHalfWidth(y: number): number {
  const row = [0, 0, 0, 0];
  sampleKeys(SKULL_KEYS, SKULL_VALS, y, row);
  return row[0]!;
}

/**
 * Where a hair style grows on the scalp, 0..1, at (angle, height in radii) — what the painter fills with the
 * hair colour. The shell (buildHair) starts a little inside this edge and sinks under the skin there, so its
 * rim is hidden in painted hair and the hairline is a soft painted edge, not a ledge.
 */
export function hairPaintMask(style: HairStyle, th: number, y: number): number {
  const d = HAIR[style];
  if (!d) return 0;
  let m = smooth01((y - hairline(d, Math.abs(th))) / 0.07 + 0.5);
  if (d.strip !== undefined) m *= smooth01((d.strip - Math.abs(skullHalfWidth(y) * sgnPow(Math.sin(th), 2.25))) / 0.05 + 0.5);
  return m;
}

/** Where a facial-hair style grows, 0..1 — painted under the shell for the same reason. */
export function beardPaintMask(style: FacialHair, th: number, y: number): number {
  return beardAt(style, Math.abs(th), y)[0];
}

export function buildHair(c: Ctx, hs: HeadShape): void {
  const style = c.spec.hair;
  const d = HAIR[style];
  const R = hs.R;
  const H = c.bind[BONE.head]!;
  if (d) {
    const ys = hs.rowsY.filter(y => y > Math.min(d.line[0], d.line[1], d.line[2]) - 0.05).reverse();   // nape → crown
    const cols = hs.cols;
    const base = new THREE.Vector3();
    addGrid(c.g, {
      rows: ys.length, cols, wrap: true,
      point: (i, j, out) => {
        const th = hs.theta(j / cols), y = ys[i]!, ath = Math.abs(th);
        hs.point(th, y, base);
        let mask = smooth01((y - hairline(d, ath) - 0.04) / 0.2);
        if (d.strip !== undefined) mask *= smooth01((d.strip - Math.abs(base.z / R)) / 0.1 + 0.3);
        const t = d.thick(th, y, base.z / R) * mask - 0.035 * (1 - mask);
        hs.point(th, y, out, t * R);
        // The crown pole lifts with the hair so the cap closes over the top.
        if (y > 0.9) { out.x = base.x * (1 + t * 0.4); out.z = base.z * (1 + t * 0.4); out.y = base.y + t * R; }
        if (d.flat !== undefined && out.y > d.flat * R) out.y = d.flat * R + (out.y - d.flat * R) * 0.08;
        out.add(H);
      },
      weights: () => [[BONE.head, 1]],
      rect: c.rect('hair'), kind: KIND.hair,
      uv: (i, j) => [j / cols, i / (ys.length - 1)],
      ao: c.cfg.rigAoStrength * 0.8,
    });
  }
  // Hanging pieces, on the sprung tail bone.
  const strand = (th: number, y: number, len: number, r: number, out0: number, droop: number): void => {
    const root = new THREE.Vector3();
    hs.point(th, y, root, 0.03 * R);
    const dirOut = new THREE.Vector3(root.x, 0, root.z).normalize();
    const rows = c.low ? 4 : 6, cols = c.low ? 4 : 6;
    addGrid(c.g, {
      rows, cols, wrap: true,
      point: (i, j, out) => {
        const t = i / (rows - 1);
        const a = j / cols * Math.PI * 2;
        const rr = r * R * (i === rows - 1 ? 0.01 : 1 - 0.35 * t) * (i === 0 ? 0.8 : 1);
        // Leaves the scalp outward, then hangs.
        const o = out0 * R * (1 - Math.pow(1 - t, 2)) * (1 - droop * t);
        out.set(root.x + dirOut.x * o + Math.cos(a) * rr, root.y - len * R * t * t * 0.4 - len * R * t * 0.6, root.z + dirOut.z * o + Math.sin(a) * rr);
        out.add(H);
      },
      weights: (p) => { const t = smooth01((H.y + root.y - p.y) / (len * R)); return [[BONE.head, 1 - 0.85 * t], [BONE.tail, 0.85 * t]]; },
      rect: c.rect('hair'), kind: KIND.hair, ao: 0,
    });
  };
  if (style === 'dreads') {
    const n = c.low ? 9 : 15;
    for (let k = 0; k < n; k++) {
      const th = (1.1 + (k / (n - 1)) * (2 * Math.PI - 2.2)) - Math.PI + Math.PI;       // round the sides and back
      const a = th > Math.PI ? th - 2 * Math.PI : th;
      strand(a, 0.25 + 0.3 * ((k * 7) % 5) / 5, 1.25 + 0.3 * ((k * 3) % 4) / 4, 0.075, 0.16, 0.3);
    }
  } else if (style === 'braids') {
    const n = c.low ? 5 : 8;
    for (let k = 0; k < n; k++) {
      const a = Math.PI + ((k + 0.5) / n - 0.5) * 2.0;
      strand(a > Math.PI ? a - 2 * Math.PI : a, -0.1 + 0.12 * (k % 2), 0.95 + 0.12 * (k % 3), 0.05, 0.1, 0.5);
    }
  } else if (style === 'tied') {
    strand(Math.PI, 0.35, 1.25, 0.14, 0.3, 0.75);
  } else if (style === 'cornrows') {
    const n = c.low ? 4 : 6;
    for (let k = 0; k < n; k++) { const a = Math.PI + ((k + 0.5) / n - 0.5) * 1.4; strand(a > Math.PI ? a - 2 * Math.PI : a, -0.3, 0.4, 0.04, 0.05, 0.6); }
  } else if (style === 'long') {
    // A curtain round the back and sides, to the shoulders.
    const rows = c.low ? 5 : 8, cols = c.low ? 10 : 18;
    const root = new THREE.Vector3();
    addGrid(c.g, {
      rows, cols, wrap: false, doubleSided: true,
      point: (i, j, out) => {
        const th = (1.25 + (j / (cols - 1)) * (2 * Math.PI - 2.5));
        const a = th > Math.PI ? th - 2 * Math.PI : th;
        const t = i / (rows - 1);
        hs.point(a, 0.1 - 0.25 * Math.min(1, t * 3), root, 0.1 * R);
        const k = 1 + 0.12 * t;
        out.set(root.x * k, (t < 0.34 ? root.y : root.y - (t - 0.34) * 1.5 * R), root.z * k);
        out.add(H);
      },
      weights: (p) => { const t = smooth01((H.y - 0.2 * R - p.y) / (1.1 * R)); return [[BONE.head, 1 - 0.8 * t], [BONE.tail, 0.8 * t]]; },
      outward: (p, o) => { o.set(p.x - H.x, 0, p.z - H.z); },
      rect: c.rect('hair'), kind: KIND.hair,
      uv: (i, j) => [j / (cols - 1), i / (rows - 1)],
    });
  } else if (style === 'topKnot') {
    const rows = 7, cols = 10;
    const root = new THREE.Vector3();
    hs.point(Math.PI, 0.86, root, 0);
    addGrid(c.g, {
      rows, cols, wrap: true,
      point: (i, j, out) => {
        const phi = -Math.PI / 2 + Math.PI * i / (rows - 1), a = j / cols * Math.PI * 2;
        out.set(root.x * 0.6 + 0.2 * R * Math.cos(phi) * Math.cos(a), root.y + 0.16 * R + 0.19 * R * Math.sin(phi), 0.2 * R * Math.cos(phi) * Math.sin(a));
        out.add(H);
      },
      weights: () => [[BONE.head, 1]], rect: c.rect('hair'), kind: KIND.hair, ao: 0,
    });
  }
}

// ── Facial hair ──────────────────────────────────────────────────────────────

/** Mask (0..1) and thickness (head radii) of a facial-hair style at (|angle|, height). */
function beardAt(style: FacialHair, ath: number, y: number): [number, number] {
  const lips = bump(ath / 0.34) * bump((y - FACE.mouthY) / 0.09);
  const tache = smooth01((0.4 - ath) / 0.08) * bump((y - (FACE.mouthY + 0.115)) / 0.075);
  const chin = smooth01((0.42 - ath) / 0.1) * smooth01((-0.57 - y) / 0.05);
  const jawTop = -0.2 - 0.32 * smooth01((1.2 - ath) / 0.9);            // the beard line: by the ear it climbs to the sideburn
  const full = smooth01((1.72 - ath) / 0.12) * smooth01((jawTop - y) / 0.08);
  switch (style) {
    case 'goatee': return [Math.max(chin, tache) * (1 - lips), 0.05];
    case 'beard': return [Math.max(full, tache) * (1 - lips), 0.07];
    case 'longBeard': return [Math.max(full, tache) * (1 - lips), 0.1];
    case 'chinstrap': return [smooth01((1.72 - ath) / 0.12) * smooth01((jawTop - 0.22 - y) / 0.05) * smooth01((ath - 0.2) / 0.2 + smooth01((-0.8 - y) / 0.05)), 0.035];
    case 'muttonChops': return [smooth01((1.72 - ath) / 0.1) * smooth01((ath - 0.62) / 0.12) * smooth01((0.12 - y) / 0.06) * smooth01((y + 0.86) / 0.1), 0.065];
    case 'soulPatch': return [smooth01((0.13 - ath) / 0.05) * bump((y + 0.66) / 0.1), 0.035];
    case 'moustache': return [tache, 0.045];
    case 'handlebar': return [Math.max(tache, smooth01((0.52 - ath) / 0.06) * smooth01((ath - 0.3) / 0.06) * bump((y + 0.52) / 0.2)), 0.045];
    default: return [0, 0];
  }
}

export function buildFacialHair(c: Ctx, hs: HeadShape): void {
  const style = c.spec.facialHair;
  if (style === 'none' || style === 'stubble') return;   // stubble is painted
  const R = hs.R;
  const H = c.bind[BONE.head]!;
  const ys = hs.rowsY.filter((y, i) => y < 0.2 && i !== MOUTH_LOWER);
  const cols = hs.cols;
  const long = style === 'longBeard' ? 0.55 : 0;
  addGrid(c.g, {
    rows: ys.length, cols, wrap: true,
    point: (i, j, out) => {
      const th = hs.theta(j / cols), y = ys[i]!;
      const [m0, t] = beardAt(style, Math.abs(th), y);
      const mask = smooth01((m0 - 0.3) / 0.6);     // starts inside the painted beard, so its rim is hidden
      hs.point(th, y, out, (t * mask - 0.035 * (1 - mask)) * R);
      // A long beard hangs off the chin.
      if (long && y < -0.6) out.y -= long * R * smooth01((-0.6 - y) / 0.4) * mask * bump(Math.abs(th) / 1.3);
      out.add(H);
    },
    weights: (p) => {
      const t = long ? smooth01((H.y - 1.0 * R - p.y) / (0.5 * R)) : 0;
      return t > 0.01 ? [[BONE.head, 1 - 0.6 * t], [BONE.tail, 0.6 * t]] : [[BONE.head, 1]];
    },
    rect: c.rect('beard'), kind: KIND.hair,
    uv: (i, j) => [j / cols, i / (ys.length - 1)],
    ao: c.cfg.rigAoStrength * 0.6,
    morph: (p, i, j) => {
      // The beard rides the jaw when the mouth opens.
      const th = hs.theta(j / cols), y = ys[i]!;
      const jw = jawWeight(th, y, false);
      if (jw < 1e-3) return null;
      const pivotX = -0.1 * R, pivotY = -0.12 * R, a = -JAW_OPEN_DEG * Math.PI / 180;
      const rx = p.x - H.x - pivotX, ry = p.y - H.y - pivotY;
      const dx = (rx * Math.cos(a) - ry * Math.sin(a) - rx) * jw, dy = (rx * Math.sin(a) + ry * Math.cos(a) - ry) * jw;
      return { mouthOpen: [dx, dy, 0], slack: [dx * 0.5, dy * 0.5, 0] };   // slack: the jaw hangs half-way
    },
  });
}

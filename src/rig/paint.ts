/**
 * rig/paint.ts — the fighter's atlas, painted in code (no external assets;
 * overhaul 2026-11-11). One canvas per fighter (atlas.ts says where each part
 * lives): skin with a little variation, the face (eyes with iris and whites,
 * brows, lips, the mouth's inside and a mouthguard, nostrils, stubble, shaved
 * scalp), procedural tattoos, the trunks' pattern and waistband with the
 * fighter's initials, glove panels / cuff / laces / seams, boot laces / sole /
 * stripes, hair streaks, and the referee's shirt.
 *
 * A second small canvas is the DAMAGE layer the skin shader reads
 * (materials.ts): R = where skin reddens most (painted once), G = bruises and
 * swelling, B = cuts (both redrawn by setDamage when the host changes them).
 *
 * Everything random is drawn from the core rng seeded by the spec, so a
 * fighter looks the same every time.
 */
import * as THREE from 'three';
import { rngFloat, rngRange, seedRng, type Config, type FighterSpec, type RngState, type Tattoo } from '../core';
import { ATLAS, ATLAS_UNITS } from './atlas';
import { FACE, beardPaintMask, hairPaintMask, headTheta, headU } from './head';

export interface FighterAtlas {
  texture: THREE.CanvasTexture;
  /** The damage layer: R = where skin reddens, G = bruise / swelling, B = cuts. */
  damage: THREE.CanvasTexture;
  setDamage(cuts: Partial<Record<string, number>>, swell: readonly [number, number]): void;
  dispose(): void;
}

/** Where the torso's landmarks fall in its rect (v, 0 = top), from the mesh. */
export interface PaintInfo {
  /** Torso height → v. */
  torsoV: (y: number) => number;
  pecY: number; ribsY: number; neckY: number; shoulderY: number; hipY: number;
  /** Arm: fraction of the arm rect's height at the elbow and at the deltoid's insertion. */
  elbowV: number; deltV: number;
  /** Half-width of a pec centre in torso u. */
  pecU: number;
  /** Muscle definition (anatomy.ts muscleDef): 1 = the baseline athlete. */
  def: number;
}

type G2 = CanvasRenderingContext2D;
interface Box { x: number; y: number; w: number; h: number }

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}
function hexOf(r: number, g: number, b: number): string {
  const f = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}
/** Mix two sRGB hex colours (display space: this is paint, not light). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  return hexOf(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
}
function hexToRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map(ch => ch + ch).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luma(h: string): number { const c = hexToRgb(h); return (0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]) / 255; }
void rgb;

export function paintAtlas(spec: FighterSpec, cfg: Config, low: boolean, info: PaintInfo): FighterAtlas {
  const size = low ? 1024 : 2048;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d')!;
  const k = size / ATLAS_UNITS;
  const box = (name: string): Box => { const r = ATLAS[name]!; return { x: r[0] * k, y: r[1] * k, w: r[2] * k, h: r[3] * k }; };
  const rng = seedRng(hash(spec.id + '|' + spec.name));
  const within = (b: Box, fn: () => void): void => { g.save(); g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip(); fn(); g.restore(); };
  const fill = (name: string, color: string): Box => { const b = box(name); g.fillStyle = color; g.fillRect(b.x, b.y, b.w, b.h); return b; };

  const skin = spec.skin;
  const hairCol = spec.hairColor ?? cfg.rigHairColor;
  const o = spec.outfit;
  const dark = luma(skin) < 0.42;
  g.fillStyle = skin; g.fillRect(0, 0, size, size);

  // ── Skin ──
  const skinNoise = (b: Box, n: number): void => within(b, () => {
    for (let i = 0; i < n; i++) {
      const x = b.x + rngFloat(rng) * b.w, y = b.y + rngFloat(rng) * b.h, r = (0.03 + 0.08 * rngFloat(rng)) * b.w;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const warm = rngFloat(rng) < 0.5;
      gr.addColorStop(0, warm ? 'rgba(150,40,30,0.07)' : 'rgba(20,10,0,0.06)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  });
  for (const n of ['torso', 'armL', 'armR', 'legL', 'legR', 'head', 'hand']) { fill(n, skin); skinNoise(box(n), low ? 14 : 30); }
  fill('ear', mixHex(skin, '#a03a30', 0.14));

  // ── Torso details ──
  const T = box('torso');
  const tx = (u: number): number => T.x + u * T.w, ty = (y: number): number => T.y + info.torsoV(y) * T.h;
  if (!o) within(T, () => {
    const nip = mixHex(skin, dark ? '#1a0a08' : '#7a3a30', 0.55);
    const ny = ty(info.pecY) + 0.022 * T.h;
    for (const s of [-1, 1]) {
      g.fillStyle = nip; g.beginPath(); g.ellipse(tx(0.5 + s * info.pecU), ny, 0.011 * T.w, 0.008 * T.h, 0, 0, Math.PI * 2); g.fill();
    }
    // Muscle lines: soft dark strokes along the grooves the geometry already has, so the definition
    // reads from the play camera under a flat top light. Strength follows the fighter's definition.
    const cl = (info.shoulderY - info.pecY) / 0.3, sp = info.ribsY - info.hipY;
    const a = Math.min(0.24, 0.1 * info.def);
    const soft = (draw: () => void, w: number): void => {
      g.lineCap = 'round';
      for (const [k2, al] of [[2.6, 0.35], [1.4, 0.6], [0.6, 1]] as const) { g.lineWidth = w * k2; g.strokeStyle = `rgba(30,8,4,${a * al})`; g.beginPath(); draw(); g.stroke(); }
    };
    if (a > 0.01) {
      const pecLow = ty(info.pecY - cl * 0.15), lw = 0.007 * T.h;
      for (const s of [-1, 1]) {
        // Under each pec, and where it meets the deltoid.
        soft(() => { g.moveTo(tx(0.5 + s * 0.008), pecLow - 0.012 * T.h); g.quadraticCurveTo(tx(0.5 + s * 0.07), pecLow + 0.022 * T.h, tx(0.5 + s * 0.15), pecLow - 0.03 * T.h); }, lw);
        soft(() => { g.moveTo(tx(0.5 + s * 0.15), pecLow - 0.03 * T.h); g.quadraticCurveTo(tx(0.5 + s * 0.165), ty(info.pecY), tx(0.5 + s * 0.14), ty(info.shoulderY) + 0.02 * T.h); }, lw * 0.8);
        // The outside edge of the abs, and three serratus ticks under the armpit.
        soft(() => { g.moveTo(tx(0.5 + s * 0.052), pecLow + 0.03 * T.h); g.quadraticCurveTo(tx(0.5 + s * 0.058), ty(info.hipY + sp * 0.8), tx(0.5 + s * 0.045), ty(info.hipY + sp * 0.4)); }, lw * 0.7);
        for (let q = 0; q < 3; q++) { const y0 = ty(info.pecY - cl * (0.26 + 0.12 * q)); soft(() => { g.moveTo(tx(0.5 + s * 0.2), y0); g.lineTo(tx(0.5 + s * 0.165), y0 + 0.022 * T.h); }, lw * 0.6); }
        // Back: under the shoulder blade, and the lat's lower edge running to the waist.
        const bu = s < 0 ? 0 : 1;
        soft(() => { g.moveTo(tx(bu - s * 0.03), ty(info.pecY + cl * 0.1)); g.quadraticCurveTo(tx(bu - s * 0.1), ty(info.pecY - cl * 0.05), tx(bu - s * 0.15), ty(info.pecY + cl * 0.12)); }, lw * 0.8);
        soft(() => { g.moveTo(tx(bu - s * 0.2), ty(info.pecY - cl * 0.1)); g.quadraticCurveTo(tx(bu - s * 0.12), ty(info.hipY + sp * 0.95), tx(bu - s * 0.03), ty(info.hipY + sp * 0.5)); }, lw * 0.8);
        soft(() => { g.moveTo(tx(bu - s * 0.004), ty(info.shoulderY - cl * 0.05)); g.lineTo(tx(bu - s * 0.004), ty(info.hipY + sp * 0.3)); }, lw * 0.9);
      }
      // Between the pecs, down the middle of the abs, and across them.
      soft(() => { g.moveTo(tx(0.5), ty(info.pecY + cl * 0.16)); g.lineTo(tx(0.5), ty(info.hipY + sp * 0.4)); }, lw * 0.8);
      for (const yy of [info.hipY + sp * 0.64, info.hipY + sp * 0.92]) soft(() => { g.moveTo(tx(0.5 - 0.05), ty(yy)); g.quadraticCurveTo(tx(0.5), ty(yy) + 0.006 * T.h, tx(0.5 + 0.05), ty(yy)); }, lw * 0.7);
    }
    // Collar bones: a soft light-over-dark stroke each side from the pit of the neck.
    const cy = ty(info.shoulderY) - 0.012 * T.h;
    for (const s of [-1, 1]) {
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.07)'; g.lineWidth = 0.012 * T.h;
      g.beginPath(); g.moveTo(tx(0.5 + s * 0.012), cy + 0.014 * T.h); g.quadraticCurveTo(tx(0.5 + s * 0.07), cy + 0.012 * T.h, tx(0.5 + s * 0.145), cy - 0.004 * T.h); g.stroke();
      g.strokeStyle = 'rgba(255,235,215,0.09)'; g.lineWidth = 0.008 * T.h;
      g.beginPath(); g.moveTo(tx(0.5 + s * 0.012), cy + 0.004 * T.h); g.quadraticCurveTo(tx(0.5 + s * 0.07), cy + 0.002 * T.h, tx(0.5 + s * 0.145), cy - 0.014 * T.h); g.stroke();
    }
  });
  if (o) {
    // The referee's shirt: collar, placket, buttons.
    fill('torso', o.shirt);
    within(T, () => {
      g.fillStyle = 'rgba(0,0,0,0.07)';
      for (let i = 0; i < 26; i++) g.fillRect(T.x + rngFloat(rng) * T.w, T.y, 2 * k, T.h);
      g.fillStyle = mixHex(o.shirt, '#ffffff', 0.5); g.fillRect(T.x, T.y, T.w, ty(info.neckY) - T.y + 0.03 * T.h);
      g.fillStyle = mixHex(o.shirt, '#ffffff', 0.25); g.fillRect(tx(0.5) - 0.012 * T.w, T.y, 0.024 * T.w, T.h);
      g.fillStyle = mixHex(o.shirt, '#000000', 0.5);
      for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(tx(0.5), ty(info.shoulderY) + (0.05 + i * 0.075) * T.h, 0.0045 * T.w, 0, Math.PI * 2); g.fill(); }
    });
    for (const n of ['armL', 'armR']) { const b = box(n); g.fillStyle = o.shirt; g.fillRect(b.x, b.y, b.w, b.h * (info.elbowV - 0.09)); g.fillStyle = mixHex(o.shirt, '#000000', 0.2); g.fillRect(b.x, b.y + b.h * (info.elbowV - 0.105), b.w, b.h * 0.015); }
    for (const n of ['legL', 'legR', 'trunks']) fill(n, o.trousers);
    const tb = box('trunks');
    g.fillStyle = mixHex(o.trousers, '#000000', 0.5); g.fillRect(tb.x, tb.y, tb.w, tb.h * 0.26);
    g.fillStyle = '#b9a66a'; g.fillRect(tb.x + tb.w * 0.5 - 0.012 * tb.w, tb.y + tb.h * 0.05, 0.024 * tb.w, tb.h * 0.16);
    fill('tie', o.tie);
  }

  // ── Face ──
  paintFace(g, box('head'), spec, cfg, hairCol, rng, low);

  // ── Tattoos ──
  if (!o) for (const t of spec.tattoos ?? []) paintTattoo(g, t, box, info, within, dark);

  // ── Trunks ──
  if (!o) paintTrunks(g, spec, box, within, rng);

  // ── Gloves ──
  const cuffCol = spec.gloveCuff ?? cfg.rigCuffColor;
  for (const n of ['gloveL', 'gloveR']) {
    const b = fill(n, spec.gloves);
    within(b, () => {
      const vC = 0.3;
      // Back-of-hand panel (u = 0.75 is the back).
      if (spec.glovePanel) { g.fillStyle = spec.glovePanel; g.beginPath(); g.ellipse(b.x + 0.75 * b.w, b.y + (vC + 0.36) * b.h, 0.15 * b.w, 0.2 * b.h, 0, 0, Math.PI * 2); g.fill(); }
      // Seams: round the fist and down the back.
      g.strokeStyle = mixHex(spec.gloves, '#000000', 0.45); g.lineWidth = Math.max(1, 2.5 * k);
      g.beginPath(); g.moveTo(b.x, b.y + (vC + 0.3) * b.h); g.lineTo(b.x + b.w, b.y + (vC + 0.3) * b.h); g.stroke();
      g.setLineDash([5 * k, 4 * k]); g.strokeStyle = mixHex(spec.gloves, '#ffffff', 0.35); g.lineWidth = Math.max(1, 1.5 * k);
      g.beginPath(); g.moveTo(b.x, b.y + (vC + 0.325) * b.h); g.lineTo(b.x + b.w, b.y + (vC + 0.325) * b.h); g.stroke();
      g.setLineDash([]);
      // Cuff.
      g.fillStyle = cuffCol; g.fillRect(b.x, b.y, b.w, vC * b.h);
      g.fillStyle = mixHex(cuffCol, spec.gloves, 0.85); g.fillRect(b.x, b.y + vC * 0.42 * b.h, b.w, vC * 0.2 * b.h);
      g.fillStyle = mixHex(cuffCol, '#000000', 0.35); g.fillRect(b.x, b.y + vC * b.h - 2 * k, b.w, 3 * k);
      // Closure on the palm side (u = 0.25).
      const lx = b.x + 0.25 * b.w;
      if ((spec.gloveClosure ?? 'laces') === 'laces') {
        g.fillStyle = mixHex(spec.gloves, '#000000', 0.35); g.fillRect(lx - 0.06 * b.w, b.y, 0.12 * b.w, (vC + 0.2) * b.h);
        g.strokeStyle = '#f4f0e6'; g.lineWidth = Math.max(1, 3 * k);
        for (let i = 0; i < 6; i++) {
          const y0 = b.y + (0.03 + i * 0.075) * b.h;
          g.beginPath(); g.moveTo(lx - 0.05 * b.w, y0); g.lineTo(lx + 0.05 * b.w, y0 + 0.06 * b.h); g.moveTo(lx + 0.05 * b.w, y0); g.lineTo(lx - 0.05 * b.w, y0 + 0.06 * b.h); g.stroke();
        }
      } else {
        g.fillStyle = mixHex(cuffCol, '#000000', 0.55); g.fillRect(b.x, b.y + vC * 0.25 * b.h, b.w, vC * 0.5 * b.h);
        g.fillStyle = mixHex(cuffCol, '#ffffff', 0.5); g.fillRect(lx - 0.09 * b.w, b.y + vC * 0.3 * b.h, 0.18 * b.w, vC * 0.4 * b.h);
      }
    });
  }
  fill('thumb', spec.gloveThumb ?? spec.gloves);
  fill('cuff', cuffCol);

  // ── Boots ──
  const trim = spec.bootTrim ?? spec.trunksSecondary;
  const soleCol = mixHex(trim, '#000000', luma(spec.boots) > 0.5 ? 0.75 : 0.2);
  for (const n of ['bootL', 'bootR']) {
    const b = fill(n, o ? spec.boots : spec.boots);
    within(b, () => {
      const half = b.h / 2;
      // Shaft (top half): rim band, tongue and laces down the front (u = 0.25), stripes on the outside (u = 0.5).
      g.fillStyle = trim; g.fillRect(b.x, b.y, b.w, 0.1 * half);
      if (spec.bootStripes && !o) {
        g.fillStyle = trim;
        for (let i = 0; i < 3; i++) g.fillRect(b.x + 0.42 * b.w, b.y + (0.26 + i * 0.2) * half, 0.26 * b.w, 0.085 * half);
      }
      const lx = b.x + 0.25 * b.w;
      g.fillStyle = mixHex(spec.boots, '#000000', 0.3); g.fillRect(lx - 0.07 * b.w, b.y, 0.14 * b.w, half * 1.38);
      g.strokeStyle = luma(spec.boots) > 0.5 ? mixHex(trim, '#000000', 0.5) : mixHex(trim, '#ffffff', 0.5); g.lineWidth = Math.max(1, 2.5 * k);
      for (let i = 0; i < 9; i++) {
        const y0 = b.y + (0.06 + i * 0.145) * half;
        g.beginPath(); g.moveTo(lx - 0.06 * b.w, y0); g.lineTo(lx + 0.06 * b.w, y0 + 0.11 * half); g.moveTo(lx + 0.06 * b.w, y0); g.lineTo(lx - 0.06 * b.w, y0 + 0.11 * half); g.stroke();
      }
      // Foot (bottom half): the sole is the band of u that faces down; a toe-cap line.
      g.fillStyle = soleCol; g.fillRect(b.x + 0.5 * b.w, b.y + half, 0.5 * b.w, half);
      g.fillStyle = mixHex(spec.boots, '#000000', 0.25); g.fillRect(b.x, b.y + half + 0.74 * half, b.w * 0.58, 2.5 * k); g.fillRect(b.x + 0.92 * b.w, b.y + half + 0.74 * half, b.w * 0.08, 2.5 * k);
    });
  }
  fill('sole', soleCol);
  fill('lining', mixHex(spec.trunksPrimary, '#000000', 0.55));
  fill('tassel', trim);
  fill('teeth', '#f1ede4');

  // ── Hair ──
  for (const n of ['hair', 'beard']) {
    const b = fill(n, hairCol);
    within(b, () => {
      const lightHair = luma(hairCol) > 0.45;
      for (let i = 0; i < (low ? 60 : 140); i++) {
        g.strokeStyle = rngFloat(rng) < 0.5 ? `rgba(255,255,255,${lightHair ? 0.16 : 0.07})` : 'rgba(0,0,0,0.18)';
        g.lineWidth = Math.max(1, (1 + 2.5 * rngFloat(rng)) * k);
        const x = b.x + rngFloat(rng) * b.w;
        g.beginPath(); g.moveTo(x, b.y); g.bezierCurveTo(x + rngRange(rng, -8, 8) * k, b.y + b.h * 0.33, x + rngRange(rng, -8, 8) * k, b.y + b.h * 0.66, x + rngRange(rng, -6, 6) * k, b.y + b.h); g.stroke();
      }
    });
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = low ? 2 : 8;

  // ── Damage layer ──
  const DS = low ? 256 : 512;
  const dc = document.createElement('canvas');
  dc.width = DS; dc.height = DS;
  const dg = dc.getContext('2d')!;
  const base = document.createElement('canvas');
  base.width = DS; base.height = DS;
  const bg = base.getContext('2d')!;
  const dk = DS / ATLAS_UNITS;
  const dbox = (name: string): Box => { const r = ATLAS[name]!; return { x: r[0] * dk, y: r[1] * dk, w: r[2] * dk, h: r[3] * dk }; };
  bg.fillStyle = '#660000'; bg.fillRect(0, 0, DS, DS);
  const hot = (b: Box, u: number, v: number, ru: number, rv: number): void => {
    const x = b.x + u * b.w, y = b.y + v * b.h, r = Math.max(ru * b.w, rv * b.h);
    bg.save(); bg.translate(x, y); bg.scale(ru * b.w / r, rv * b.h / r);
    const gr = bg.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, 'rgba(255,0,0,0.9)'); gr.addColorStop(1, 'rgba(255,0,0,0)');
    bg.fillStyle = gr; bg.beginPath(); bg.arc(0, 0, r, 0, Math.PI * 2); bg.fill(); bg.restore();
  };
  const HB = dbox('head'), TB = dbox('torso');
  const hv = (y: number): number => (1 - y) / 2;
  for (const s of [-1, 1]) {
    hot(HB, headU(s * 0.62), hv(-0.02), 0.07, 0.12);       // cheekbones
    hot(HB, headU(s * FACE.eyeTh), hv(FACE.browY), 0.06, 0.07);   // brows
    hot(TB, 0.5 + s * 0.2, info.torsoV(info.ribsY), 0.1, 0.16);    // the ribs and flanks
  }
  hot(HB, 0.5, hv(-0.1), 0.035, 0.12);                      // nose
  hot(TB, 0.5, info.torsoV(info.ribsY) + 0.03, 0.09, 0.12); // solar plexus
  const damage = new THREE.CanvasTexture(dc);
  damage.colorSpace = THREE.NoColorSpace;
  const CUTS: Record<string, [number, number, number]> = {
    browL: [-FACE.eyeTh - 0.08, FACE.browY + 0.03, 0.35], browR: [FACE.eyeTh + 0.08, FACE.browY + 0.03, -0.35],
    cheekL: [-0.62, -0.03, -0.2], cheekR: [0.62, -0.03, 0.2], nose: [0.02, 0.08, 1.3], lip: [0.1, FACE.mouthY + 0.07, 1.2],
  };
  const setDamage = (cuts: Partial<Record<string, number>>, swell: readonly [number, number]): void => {
    dg.globalCompositeOperation = 'source-over';
    dg.drawImage(base, 0, 0);
    dg.globalCompositeOperation = 'lighter';
    const blot = (u: number, v: number, ru: number, rv: number, a: number, col: string): void => {
      const x = HB.x + u * HB.w, y = HB.y + v * HB.h, r = Math.max(ru * HB.w, rv * HB.h);
      dg.save(); dg.translate(x, y); dg.scale(ru * HB.w / r, rv * HB.h / r);
      const gr = dg.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0, col.replace('A', String(a))); gr.addColorStop(0.6, col.replace('A', String(a * 0.6))); gr.addColorStop(1, col.replace('A', '0'));
      dg.fillStyle = gr; dg.beginPath(); dg.arc(0, 0, r, 0, Math.PI * 2); dg.fill(); dg.restore();
    };
    for (const s of [0, 1]) {
      const a = swell[s]!;
      if (a > 0.01) blot(headU((s === 0 ? -1 : 1) * (FACE.eyeTh + 0.06)), hv(FACE.eyeY - 0.07), 0.075, 0.13, Math.min(1, a), 'rgba(0,255,0,A)');
    }
    for (const name in cuts) {
      const sev = cuts[name] ?? 0, at = CUTS[name];
      if (!at || sev <= 0.01) continue;
      const u = headU(at[0]), v = hv(at[1]);
      blot(u, v, 0.03 + 0.02 * sev, 0.05 + 0.03 * sev, 0.5 * sev, 'rgba(0,255,0,A)');
      const x = HB.x + u * HB.w, y = HB.y + v * HB.h, len = (0.018 + 0.028 * sev) * HB.w;
      dg.strokeStyle = `rgba(0,0,255,${Math.min(1, 0.55 + 0.45 * sev)})`; dg.lineCap = 'round'; dg.lineWidth = Math.max(1.2, (1.5 + 2.5 * sev) * dk * 2);
      dg.beginPath(); dg.moveTo(x - Math.cos(at[2]) * len, y - Math.sin(at[2]) * len); dg.lineTo(x + Math.cos(at[2]) * len, y + Math.sin(at[2]) * len); dg.stroke();
      if (sev > 0.45) {
        // It runs.
        dg.strokeStyle = `rgba(0,0,255,${0.75 * sev})`; dg.lineWidth = Math.max(1, 2.2 * dk * 2);
        dg.beginPath(); dg.moveTo(x, y); dg.bezierCurveTo(x + 0.006 * HB.w, y + 0.05 * HB.h, x - 0.004 * HB.w, y + 0.1 * HB.h, x + 0.004 * HB.w, y + (0.08 + 0.2 * (sev - 0.45)) * HB.h); dg.stroke();
      }
    }
    damage.needsUpdate = true;
  };
  setDamage({}, [0, 0]);

  return { texture, damage, setDamage, dispose: () => { texture.dispose(); damage.dispose(); } };
}

// ── Face ─────────────────────────────────────────────────────────────────────

function paintFace(g: G2, b: Box, spec: FighterSpec, cfg: Config, hairCol: string, rng: RngState, low: boolean): void {
  const skin = spec.skin;
  const X = (th: number): number => b.x + headU(th) * b.w;
  const Y = (y: number): number => b.y + (1 - y) / 2 * b.h;
  const du = (th: number, w: number): number => (headU(th + w) - headU(th - w)) / 2 * b.w;      // half-width in px of ±w radians at th
  const dy = (h: number): number => h / 2 * b.h;
  g.save(); g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
  const dark = luma(skin) < 0.42;

  // Shaved scalp / stubble: a stipple of the hair colour wherever hair grows short.
  const stipple = (thMax: number, y0: number, y1: number, density: number, alpha: number, sides = false): void => {
    g.fillStyle = hairCol;
    const n = Math.round(density * (low ? 0.35 : 1));
    for (let i = 0; i < n; i++) {
      const th = rngRange(rng, -thMax, thMax), y = rngRange(rng, y0, y1);
      if (sides && Math.abs(th) < 0.8 && y < 0.62) continue;       // not across the face
      g.globalAlpha = alpha * (0.5 + 0.5 * rngFloat(rng));
      g.fillRect(X(th), Y(y), Math.max(1, b.w / 380), Math.max(1, b.w / 330));
    }
    g.globalAlpha = 1;
  };
  const wash = (y0: number, y1: number, alpha: number): void => {
    // A soft band of hair colour over the scalp sides and back (behind the face).
    const gr = g.createLinearGradient(0, Y(y1), 0, Y(y0));
    const c = hexToRgb(hairCol);
    gr.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${alpha})`); gr.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    g.fillStyle = gr;
    g.fillRect(b.x, Y(y1), X(-0.95) - b.x, Y(y0) - Y(y1));
    g.fillRect(X(0.95), Y(y1), b.x + b.w - X(0.95), Y(y0) - Y(y1));
  };
  /** Fill a mask over the head rect with the hair colour (half resolution, per pixel: a soft painted edge). */
  const layer = (mask: (th: number, y: number) => number, alpha: number): void => {
    const w = Math.max(8, Math.round(b.w / 2)), h = Math.max(8, Math.round(b.h / 2));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tg = tmp.getContext('2d')!;
    const img = tg.createImageData(w, h);
    const c = hexToRgb(hairCol);
    const ths: number[] = [];
    for (let x = 0; x < w; x++) ths.push(headTheta((x + 0.5) / w));
    for (let y = 0; y < h; y++) {
      const yy = 1 - 2 * (y + 0.5) / h;
      for (let x = 0; x < w; x++) {
        const m = mask(ths[x]!, yy);
        if (m <= 0.004) continue;
        const o = (y * w + x) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = Math.round(255 * alpha * m);
      }
    }
    tg.putImageData(img, 0, 0);
    g.drawImage(tmp, b.x, b.y, b.w, b.h);
  };
  const hair = spec.hair;
  if (hair !== 'none') {
    // The scalp under the hair is painted the hair's colour: the hairline is this soft painted edge, and the
    // hair shell's own rim hides inside it. Cuts with shaved sides get a stubble shadow below their line.
    const shaved = hair === 'fade' || hair === 'flatTop' || hair === 'topKnot' || hair === 'mohawk';
    if (shaved) { wash(-0.36, 0.7, 0.5); stipple(Math.PI, -0.3, 0.9, 5200, 0.5, true); }
    layer((th, y) => hairPaintMask(hair, th, y), hair === 'buzz' ? 0.8 : 1);
  }
  const fh = spec.facialHair;
  if (fh !== 'none' && fh !== 'stubble') layer((th, y) => beardPaintMask(fh, th, y), 0.94);
  if (fh !== 'none') {
    // A shadow of stubble over the jaw under any facial hair; 'stubble' is only this, heavier.
    const heavy = fh === 'stubble' ? 1 : 0.5;
    g.fillStyle = hairCol;
    for (let i = 0; i < (low ? 1400 : 4200); i++) {
      const th = rngRange(rng, -1.6, 1.6), y = rngRange(rng, -1.0, -0.2);
      const jawTop = -0.22 - 0.3 * Math.max(0, 1 - Math.abs(th) / 1.2);
      if (y > jawTop) continue;
      if (Math.abs(th) < 0.34 && Math.abs(y - FACE.mouthY) < 0.085) continue;
      g.globalAlpha = (dark ? 0.5 : 0.4) * heavy * (0.4 + 0.6 * rngFloat(rng));
      g.fillRect(X(th), Y(y), Math.max(1, b.w / 400), Math.max(1, b.w / 360));
    }
    g.globalAlpha = 1;
  }

  // Sockets: a soft shadow the geometry's AO only hints at.
  for (const s of [-1, 1]) {
    const ex = X(s * FACE.eyeTh), ey = Y(FACE.eyeY);
    const rw = du(s * FACE.eyeTh, FACE.eyeHalfTh * 1.5), rh = dy(FACE.eyeHalfY * 2.6);
    g.save(); g.translate(ex, ey); g.scale(1, rh / rw);
    const gr = g.createRadialGradient(0, 0, rw * 0.2, 0, 0, rw);
    gr.addColorStop(0, dark ? 'rgba(10,4,2,0.4)' : 'rgba(60,25,15,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rw, 0, Math.PI * 2); g.fill(); g.restore();
  }
  // Eyes: whites, iris, pupil, a catch light, the lid line.
  const iris = spec.eyeColor ?? '#3a2616';
  for (const s of [-1, 1]) {
    const ex = X(s * FACE.eyeTh), ey = Y(FACE.eyeY);
    const rw = du(s * FACE.eyeTh, FACE.eyeHalfTh), rh = dy(FACE.eyeHalfY);
    g.save();
    g.beginPath();
    // An almond: two arcs meeting at the corners, the outer corner a touch higher.
    g.moveTo(ex - rw, ey + rh * 0.15 * s); g.quadraticCurveTo(ex, ey - rh * 1.55, ex + rw, ey - rh * 0.15 * s); g.quadraticCurveTo(ex, ey + rh * 1.35, ex - rw, ey + rh * 0.15 * s);
    g.closePath();
    g.fillStyle = '#efe7dc'; g.fill();
    g.clip();
    const ir = rh * 1.05;
    g.fillStyle = iris; g.beginPath(); g.arc(ex - s * rw * 0.06, ey - rh * 0.05, ir, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0a0706'; g.beginPath(); g.arc(ex - s * rw * 0.06, ey - rh * 0.05, ir * 0.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(ex - s * rw * 0.06 - ir * 0.32, ey - rh * 0.32, ir * 0.2, 0, Math.PI * 2); g.fill();
    // The lid's shadow across the top of the eye.
    g.fillStyle = 'rgba(20,8,4,0.35)'; g.fillRect(ex - rw, ey - rh * 1.6, rw * 2, rh * 0.75);
    g.restore();
    g.strokeStyle = dark ? '#120805' : '#2a1610'; g.lineCap = 'round'; g.lineWidth = Math.max(1.2, rh * 0.42);
    g.beginPath(); g.moveTo(ex - rw * 1.04, ey + rh * 0.15 * s); g.quadraticCurveTo(ex, ey - rh * 1.62, ex + rw * 1.04, ey - rh * 0.15 * s); g.stroke();
    g.strokeStyle = dark ? 'rgba(10,4,2,0.5)' : 'rgba(60,25,15,0.45)'; g.lineWidth = Math.max(1, rh * 0.18);
    g.beginPath(); g.moveTo(ex - rw, ey + rh * 0.15 * s); g.quadraticCurveTo(ex, ey + rh * 1.4, ex + rw, ey - rh * 0.15 * s); g.stroke();
  }
  // Brows.
  g.strokeStyle = hairCol; g.lineCap = 'round';
  for (const s of [-1, 1]) {
    const x0 = X(s * 0.17), x1 = X(s * 0.47), x2 = X(s * 0.74);
    g.lineWidth = dy(0.075);
    g.beginPath(); g.moveTo(x0, Y(FACE.browY - 0.035)); g.quadraticCurveTo(x1, Y(FACE.browY + 0.045), x2, Y(FACE.browY - 0.02)); g.stroke();
  }
  // Nostrils.
  g.fillStyle = dark ? 'rgba(8,3,2,0.75)' : 'rgba(50,18,12,0.7)';
  for (const s of [-1, 1]) { g.beginPath(); g.ellipse(X(s * 0.105), Y(FACE.noseBaseY + 0.012), du(s * 0.105, 0.05), dy(0.03), 0, 0, Math.PI * 2); g.fill(); }
  // Mouth: the inside (a strip the two mouth rows hold shut), a mouthguard, then the lips either side of it.
  const mv = FACE.mouthStripV * b.h, my = Y(FACE.mouthY);
  const mx0 = X(-FACE.mouthHalfTh * 1.3), mx1 = X(FACE.mouthHalfTh * 1.3);
  g.fillStyle = '#1c0707'; g.fillRect(mx0, my - mv, mx1 - mx0, 2 * mv);
  g.fillStyle = spec.outfit ? '#e9e4da' : mixHex(spec.trunksPrimary, '#ffffff', 0.25); g.fillRect(mx0, my - mv, mx1 - mx0, mv * 0.8);
  const lip = mixHex(skin, dark ? '#4a1f22' : '#8e3f3c', dark ? 0.5 : 0.42);
  const lw = X(FACE.mouthHalfTh) - X(0);
  g.fillStyle = lip;
  g.beginPath(); g.moveTo(X(0) - lw, my - mv); g.quadraticCurveTo(X(0) - lw * 0.4, my - mv - dy(FACE.lipH * 1.25), X(0), my - mv - dy(FACE.lipH * 0.85)); g.quadraticCurveTo(X(0) + lw * 0.4, my - mv - dy(FACE.lipH * 1.25), X(0) + lw, my - mv); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(X(0) - lw, my + mv); g.quadraticCurveTo(X(0), my + mv + dy(FACE.lipH * 2.3), X(0) + lw, my + mv); g.closePath(); g.fill();
  g.strokeStyle = dark ? 'rgba(10,3,3,0.8)' : 'rgba(60,15,15,0.7)'; g.lineWidth = Math.max(1, dy(0.012));
  g.beginPath(); g.moveTo(X(0) - lw * 1.05, my - mv); g.lineTo(X(0) + lw * 1.05, my - mv); g.stroke();
  g.restore();
}

// ── Tattoos ──────────────────────────────────────────────────────────────────

function paintTattoo(g: G2, t: Tattoo, box: (n: string) => Box, info: PaintInfo, within: (b: Box, fn: () => void) => void, darkSkin: boolean): void {
  const rng = seedRng(t.seed * 7919 + hash(t.place + t.motif));
  const ink = darkSkin ? 'rgba(4,6,12,0.78)' : 'rgba(16,26,40,0.82)';
  const T = box('torso');
  // Where: [rect, centre u, centre v, half-width, half-height] in the rect's own 0..1; `wrap` draws it again across the u seam.
  let b: Box, cu: number, cv: number, hu: number, hv: number, wrap = false, around = false;
  const pv = info.torsoV(info.pecY), rv = info.torsoV(info.ribsY), nv = info.torsoV(info.neckY), sv = info.torsoV(info.shoulderY);
  switch (t.place) {
    case 'chest': b = T; cu = 0.5; cv = pv - 0.01; hu = 0.14; hv = 0.075; break;
    case 'back': b = T; cu = 0; cv = (sv + rv) / 2 + 0.02; hu = 0.15; hv = (rv - sv) * 0.62; wrap = true; break;
    case 'ribs': b = T; cu = 0.5 + (rngFloat(rng) < 0.5 ? -1 : 1) * 0.21; cv = rv + 0.02; hu = 0.05; hv = 0.11; break;
    case 'neck': b = T; cu = 0.5 + (rngFloat(rng) < 0.5 ? -1 : 1) * 0.2; cv = (nv + sv) / 2 - 0.012; hu = 0.06; hv = Math.max(0.018, (sv - nv) * 0.4); break;
    case 'sleeveL': case 'sleeveR': b = box(t.place === 'sleeveL' ? 'armL' : 'armR'); cu = 0.5; cv = (0.07 + info.elbowV) / 2; hu = 0.5; hv = (info.elbowV - 0.09) / 2; around = true; break;
    case 'forearmL': case 'forearmR': b = box(t.place === 'forearmL' ? 'armL' : 'armR'); cu = 0.5; cv = info.elbowV + 0.15; hu = 0.5; hv = 0.11; around = true; break;
    case 'shoulderL': case 'shoulderR': b = box(t.place === 'shoulderL' ? 'armL' : 'armR'); cu = 0.5; cv = info.deltV * 0.55 + 0.04; hu = 0.26; hv = info.deltV * 0.42; break;
    default: return;
  }
  const draw = (cx: number): void => {
    g.save();
    g.translate(b.x + cx * b.w, b.y + cv * b.h);
    const sx = hu * b.w, sy = hv * b.h;
    g.fillStyle = ink; g.strokeStyle = ink; g.lineCap = 'round'; g.lineJoin = 'round';
    motif(g, t.motif, sx, sy, seedRng(t.seed * 7919 + 13), around);
    g.restore();
  };
  within(b, () => {
    g.globalCompositeOperation = 'multiply';
    draw(cu);
    if (wrap) draw(cu + 1);
    g.globalCompositeOperation = 'source-over';
  });
}

/** Draw a motif centred on the origin inside ±sx × ±sy. `around` = it wraps a limb (bands of pattern rather than one emblem). */
function motif(g: G2, kind: Tattoo['motif'], sx: number, sy: number, rng: RngState, around: boolean): void {
  const s = Math.min(sx, sy);
  const blade = (x0: number, y0: number, x1: number, y1: number, bend: number, w: number): void => {
    // A tapered, curved blade from (x0, y0) to a point at (x1, y1).
    const mx = (x0 + x1) / 2 - (y1 - y0) * bend, my = (y0 + y1) / 2 + (x1 - x0) * bend;
    const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny) || 1;
    g.beginPath();
    g.moveTo(x0 + nx / nl * w, y0 + ny / nl * w);
    g.quadraticCurveTo(mx + nx / nl * w * 0.7, my + ny / nl * w * 0.7, x1, y1);
    g.quadraticCurveTo(mx - nx / nl * w * 0.7, my - ny / nl * w * 0.7, x0 - nx / nl * w, y0 - ny / nl * w);
    g.closePath(); g.fill();
  };
  switch (kind) {
    case 'tribal': {
      const n = around ? 7 : 4;
      for (let i = 0; i < n; i++) for (const m of [-1, 1]) {
        if (around) {
          const y = -sy + (i + 0.5) / n * 2 * sy;
          blade(m * sx * 0.02, y, m * sx * rngRange(rng, 0.7, 0.98), y + rngRange(rng, -0.25, 0.25) * sy, m * rngRange(rng, 0.15, 0.4), sy * 0.07);
          blade(m * sx * 0.3, y + sy * 0.06, m * sx * rngRange(rng, 0.5, 0.8), y - sy * 0.12, -m * 0.3, sy * 0.035);
        } else {
          const a = -0.9 + i * 0.6 + rngRange(rng, -0.1, 0.1);
          blade(m * sx * 0.06, sy * (0.15 - 0.1 * i), m * sx * (0.55 + 0.4 * Math.cos(a)) , sy * Math.sin(a) * 0.9, m * rngRange(rng, 0.2, 0.45), s * 0.12);
        }
      }
      if (!around) { g.beginPath(); g.moveTo(0, -sy * 0.75); g.lineTo(sx * 0.07, 0); g.lineTo(0, sy * 0.85); g.lineTo(-sx * 0.07, 0); g.closePath(); g.fill(); }
      break;
    }
    case 'script': {
      const lines = around ? 5 : 3;
      for (let l = 0; l < lines; l++) {
        const y0 = (-0.7 + (l + 0.5) / lines * 1.4) * sy, w = sx * (0.92 - 0.12 * Math.abs(l - (lines - 1) / 2));
        const f1 = rngRange(rng, 9, 14), f2 = rngRange(rng, 3, 5), ph = rngRange(rng, 0, 6);
        g.lineWidth = Math.max(1.5, s * 0.045);
        g.beginPath();
        for (let i = 0; i <= 90; i++) {
          const u = i / 90, x = -w + 2 * w * u;
          // Loops: a fast wave riding a slow one, leaning.
          const y = y0 + sy / lines * (0.33 * Math.sin(u * f1 * Math.PI + ph) * (0.6 + 0.4 * Math.sin(u * f2 * Math.PI)) - 0.1 * Math.cos(u * f1 * 2 * Math.PI));
          const xx = x + sy / lines * 0.25 * Math.cos(u * f1 * Math.PI + ph);
          if (i === 0) g.moveTo(xx, y); else g.lineTo(xx, y);
        }
        g.stroke();
      }
      break;
    }
    case 'cross': {
      const w = s * 0.2;
      g.beginPath();
      g.moveTo(-w, -sy * 0.95); g.lineTo(w, -sy * 0.95); g.lineTo(w * 0.7, -sy * 0.35); g.lineTo(sx * 0.7, -sy * 0.35 - w * 0.4); g.lineTo(sx * 0.7, -sy * 0.35 + w * 1.6);
      g.lineTo(w * 0.7, -sy * 0.35 + w * 1.2); g.lineTo(w, sy * 0.95); g.lineTo(-w, sy * 0.95); g.lineTo(-w * 0.7, -sy * 0.35 + w * 1.2);
      g.lineTo(-sx * 0.7, -sy * 0.35 + w * 1.6); g.lineTo(-sx * 0.7, -sy * 0.35 - w * 0.4); g.lineTo(-w * 0.7, -sy * 0.35); g.closePath(); g.fill();
      g.lineWidth = Math.max(1, s * 0.03);
      for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2 + 0.26; g.beginPath(); g.moveTo(Math.cos(a) * s * 0.45, -sy * 0.35 + w * 0.6 + Math.sin(a) * s * 0.45); g.lineTo(Math.cos(a) * s * 0.85, -sy * 0.35 + w * 0.6 + Math.sin(a) * s * 0.85); g.stroke(); }
      break;
    }
    case 'star': {
      const n = around ? 3 : 1;
      for (let q = 0; q < n; q++) {
        const cy = around ? (-0.6 + q * 0.6) * sy : 0, r = around ? s * 0.5 : s * 0.95;
        g.beginPath();
        for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.4 : r; if (i === 0) g.moveTo(Math.cos(a) * rr, cy + Math.sin(a) * rr); else g.lineTo(Math.cos(a) * rr, cy + Math.sin(a) * rr); }
        g.closePath(); g.lineWidth = Math.max(1.5, r * 0.09); g.stroke();
        // Nautical: alternate half-points filled.
        for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5, a2 = a + Math.PI / 5; g.beginPath(); g.moveTo(0, cy); g.lineTo(Math.cos(a) * r, cy + Math.sin(a) * r); g.lineTo(Math.cos(a2) * r * 0.4, cy + Math.sin(a2) * r * 0.4); g.closePath(); g.fill(); }
      }
      break;
    }
    case 'wings': {
      for (const m of [-1, 1]) for (let i = 0; i < 7; i++) {
        const a = 0.25 + i * 0.2;
        blade(m * sx * 0.05, sy * (0.25 - 0.06 * i), m * sx * (0.98 - 0.07 * i) * Math.cos(a - 0.5), -sy * (0.2 + 0.9 * Math.sin(a - 0.3)) + sy * 0.3, -m * 0.22, s * 0.075);
      }
      g.beginPath(); g.ellipse(0, sy * 0.1, sx * 0.07, sy * 0.4, 0, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'rose': {
      const r = s * 0.6;
      g.lineWidth = Math.max(1.5, r * 0.11);
      for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(Math.cos(i * 2.2) * r * 0.12 * i, -sy * 0.2 + Math.sin(i * 2.2) * r * 0.12 * i, r * (0.22 + 0.2 * i), i * 1.1, i * 1.1 + 4.4); g.stroke(); }
      g.beginPath(); g.arc(0, -sy * 0.2, r * 0.12, 0, Math.PI * 2); g.fill();
      for (const m of [-1, 1]) blade(0, -sy * 0.2 + r * 0.9, m * sx * 0.8, sy * 0.35, m * 0.3, r * 0.26);
      g.lineWidth = Math.max(1.5, r * 0.12); g.beginPath(); g.moveTo(0, -sy * 0.2 + r * 0.85); g.quadraticCurveTo(sx * 0.12, sy * 0.5, -sx * 0.05, sy * 0.95); g.stroke();
      break;
    }
    case 'bands': {
      const n = 3;
      for (let i = 0; i < n; i++) {
        const y = (-0.75 + i * 0.6) * sy, h = sy * (i === 1 ? 0.22 : 0.11);
        g.fillRect(-sx * 1.1, y - h / 2, sx * 2.2, h);
        if (i === 1) continue;
        // A saw edge on the thin bands.
        const teeth = 14;
        g.beginPath();
        for (let q = 0; q <= teeth; q++) { const x = -sx + q / teeth * 2 * sx; g.lineTo(x, y + (i === 0 ? 1 : -1) * (h / 2 + (q % 2 ? sy * 0.09 : 0))); }
        g.lineTo(sx, y); g.lineTo(-sx, y); g.closePath(); g.fill();
      }
      break;
    }
    case 'geometric': {
      g.lineWidth = Math.max(1.5, s * 0.035);
      const n = around ? 4 : 3, r = (around ? sx * 0.26 : s * 0.3);
      for (let iy = -n; iy <= n; iy++) for (let ix = -3; ix <= 3; ix++) {
        const cx = ix * r * 1.74 + (iy % 2 ? r * 0.87 : 0), cy = iy * r * 1.5;
        if (Math.abs(cx) > sx * 0.95 || Math.abs(cy) > sy * 0.95) continue;
        g.beginPath();
        for (let q = 0; q < 6; q++) { const a = Math.PI / 6 + q * Math.PI / 3; if (q === 0) g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); else g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
        g.closePath();
        if (rngFloat(rng) < 0.38) g.fill(); else g.stroke();
        if (rngFloat(rng) < 0.5) { g.beginPath(); g.arc(cx, cy, r * 0.16, 0, Math.PI * 2); g.fill(); }
      }
      break;
    }
    case 'serpent': {
      const turns = around ? 3.5 : 2.2, w0 = s * 0.2;
      const at = (u: number): [number, number] => [Math.sin(u * turns * Math.PI * 2) * sx * 0.72 * (0.55 + 0.45 * u), (-0.92 + 1.84 * u) * sy];
      for (let i = 0; i < 80; i++) {
        const u0 = i / 80, u1 = (i + 1.3) / 80;
        const [x0, y0] = at(u0), [x1, y1] = at(Math.min(1, u1));
        g.lineWidth = Math.max(1.5, w0 * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, u0 * 1.15))));
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      const [hx, hy] = at(0);
      g.beginPath(); g.ellipse(hx, hy - w0 * 0.3, w0 * 0.75, w0 * 1.05, 0.3, 0, Math.PI * 2); g.fill();
      break;
    }
  }
}

// ── Trunks ───────────────────────────────────────────────────────────────────

function paintTrunks(g: G2, spec: FighterSpec, box: (n: string) => Box, within: (b: Box, fn: () => void) => void, rng: RngState): void {
  const p = spec.trunksPrimary, s = spec.trunksSecondary;
  const pat = spec.trunksPattern ?? 'sideStripe';
  const B = box('trunks'), LL = box('trunkLegL'), LR = box('trunkLegR');
  const vBand = 0.26;
  const skirt = spec.trunksStyle === 'skirt';
  const star = (x: number, y: number, r: number): void => {
    g.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.42 : r; if (i === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    g.closePath(); g.fill();
  };
  /** The pattern over one panel. `side` = u of the outside seam(s); `body` = the pelvis panel (below its waistband). */
  const panel = (b: Box, v0: number, sides: number[], body: boolean, legIndex: number): void => within({ x: b.x, y: b.y + v0 * b.h, w: b.w, h: b.h * (1 - v0) }, () => {
    const y0 = b.y + v0 * b.h, h = b.h * (1 - v0);
    g.fillStyle = p; g.fillRect(b.x, y0, b.w, h);
    switch (pat) {
      case 'solid': break;
      case 'sideStripe':
        for (const u of sides) {
          const w = (body ? 0.05 : 0.2) * b.w;
          g.fillStyle = s; g.fillRect(b.x + u * b.w - w / 2, y0, w, h);
          g.fillStyle = mixHex(s, p, 0.5); g.fillRect(b.x + u * b.w - w * 0.72, y0, w * 0.1, h); g.fillRect(b.x + u * b.w + w * 0.62, y0, w * 0.1, h);
        }
        break;
      case 'waistStripe':
        g.fillStyle = s;
        if (body) { g.fillRect(b.x, y0 + h * 0.06, b.w, h * 0.09); g.fillRect(b.x, y0 + h * 0.2, b.w, h * 0.035); }
        else { g.fillRect(b.x, y0 + h * 0.8, b.w, h * 0.09); g.fillRect(b.x, y0 + h * 0.93, b.w, h * 0.07); }
        break;
      case 'twoTone':
        g.fillStyle = s;
        if (body) g.fillRect(b.x, y0, b.w * 0.5, h);                   // the fighter's right half (u < 0.5)
        else if (legIndex === 1 || skirt) g.fillRect(b.x + (skirt ? b.w * 0.5 : 0), y0, skirt ? b.w * 0.5 : b.w, h);
        break;
      case 'flames': {
        // Tongues climbing from the hem.
        const n = body ? 22 : 9;
        for (const [col, sc] of [[s, 1], [mixHex(s, '#ffffff', 0.45), 0.55]] as const) {
          g.fillStyle = col;
          g.beginPath(); g.moveTo(b.x, y0 + h);
          for (let i = 0; i < n; i++) {
            const x0 = b.x + i / n * b.w, x1 = b.x + (i + 1) / n * b.w;
            const top = y0 + h * (1 - sc * (body ? 0.42 : 0.82) * (0.55 + 0.45 * Math.abs(Math.sin(i * 2.4 + 1))));
            g.quadraticCurveTo(x0 + (x1 - x0) * 0.1, (top + y0 + h) / 2, x0 + (x1 - x0) * 0.55, top);
            g.quadraticCurveTo(x0 + (x1 - x0) * 0.75, (top + y0 + h) / 2, x1, y0 + h);
          }
          g.closePath(); g.fill();
        }
        break;
      }
      case 'stars': {
        g.fillStyle = s;
        const n = body ? 26 : 12;
        for (let i = 0; i < n; i++) star(b.x + rngFloat(rng) * b.w, y0 + rngFloat(rng) * h, (0.035 + 0.03 * rngFloat(rng)) * (body ? b.h : b.w * 0.6));
        break;
      }
      case 'checker': {
        const nx = body ? 24 : 8, cw = b.w / nx, ny = Math.max(1, Math.round(h / cw));
        g.fillStyle = s;
        for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) if ((ix + iy) % 2 === 0) g.fillRect(b.x + ix * cw, y0 + iy * h / ny, cw + 0.5, h / ny + 0.5);
        break;
      }
      case 'gradient': {
        const gr = g.createLinearGradient(0, body ? y0 : y0 - h * 0.6, 0, y0 + h);
        gr.addColorStop(0, p); gr.addColorStop(1, s);
        g.fillStyle = gr; g.fillRect(b.x, y0, b.w, h);
        break;
      }
    }
    // Folds: soft vertical streaks, so the cloth is not a flat fill.
    for (let i = 0; i < (body ? 34 : 14); i++) {
      g.fillStyle = rngFloat(rng) < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.05)';
      const w = (0.008 + 0.02 * rngFloat(rng)) * b.w;
      g.fillRect(b.x + rngFloat(rng) * b.w, y0, w, h);
    }
    // A hem line on the legs.
    if (!body) { g.fillStyle = mixHex(pat === 'solid' ? p : s, '#000000', 0.25); g.fillRect(b.x, y0 + h - Math.max(2, h * 0.035), b.w, Math.max(2, h * 0.035)); }
  });
  panel(B, vBand, [0.25, 0.75], true, -1);
  panel(LL, 0, [0.5], false, 0);
  panel(LR, 0, [0.5], false, 1);
  // Waistband: the secondary colour, piped, with the fighter's initials front and back.
  within({ x: B.x, y: B.y, w: B.w, h: B.h * vBand }, () => {
    const h = B.h * vBand;
    g.fillStyle = s; g.fillRect(B.x, B.y, B.w, h);
    g.fillStyle = mixHex(s, p, 0.75); g.fillRect(B.x, B.y + h * 0.1, B.w, h * 0.08); g.fillRect(B.x, B.y + h * 0.82, B.w, h * 0.08);
    g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(B.x, B.y + h - 3, B.w, 3);
    const initials = spec.name.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 3).toUpperCase();
    g.fillStyle = luma(s) > 0.5 ? mixHex(p, '#000000', 0.35) : mixHex(p, '#ffffff', 0.7);
    g.font = `900 ${Math.round(h * 0.56)}px Impact, "Arial Black", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const u of [0.5, 0, 1]) g.fillText(initials, B.x + u * B.w, B.y + h * 0.5);
  });
}

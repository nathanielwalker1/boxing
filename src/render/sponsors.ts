/**
 * render/sponsors.ts — CONTRACT §9 ad surfaces. `SPONSORS` is the in-house
 * roster (fictional; a real sponsor is a data swap). `paintSlot` renders a
 * sponsor into any slot as a CanvasTexture generated at load — placeholder
 * typography (system sans), a geometric mark keyed off the sponsor id, the
 * sponsor's own two colours. No external assets.
 */
import * as THREE from 'three';
import type { Sponsor, SlotId } from '../core';
import { makeCanvas, canvasTexture } from './util';

export const SPONSORS: readonly Sponsor[] = [
  { id: 'haymaker',   name: 'HAYMAKER ENERGY',   primary: '#f2b632', secondary: '#151515', slots: ['matCenter', 'apronFront', 'roundCard', 'introBanner'] },
  { id: 'cornerstone',name: 'CORNERSTONE MUTUAL',primary: '#1f3f8f', secondary: '#f3f1e8', slots: ['matCorners', 'apronSides', 'roundCard'] },
  { id: 'southpaw',   name: 'SOUTHPAW COFFEE',   primary: '#3a2418', secondary: '#e9d5b3', slots: ['apronSides', 'postPads'] },
  { id: 'ropeburn',   name: 'ROPEBURN ATHLETIC', primary: '#b3202b', secondary: '#f7f7f7', slots: ['apronSides', 'postPads', 'matCorners'] },
];

export function sponsorById(id: string): Sponsor {
  return SPONSORS.find(s => s.id === id) ?? SPONSORS[0]!;
}

/** Canvas size per slot; aspect matches the surface it lands on. */
const SLOT_SIZE: Record<SlotId, [number, number]> = {
  matCenter: [1024, 1024], matCorners: [512, 512], apronFront: [2048, 512], apronSides: [1024, 512],
  postPads: [256, 256], roundCard: [1024, 512], introBanner: [2048, 512],
};

type Mark = 'circle' | 'diamond' | 'hex' | 'shield';
const MARKS: Record<string, Mark> = { haymaker: 'diamond', cornerstone: 'shield', southpaw: 'circle', ropeburn: 'hex' };

function markPath(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, mark: Mark): void {
  g.beginPath();
  if (mark === 'circle') g.arc(cx, cy, r, 0, Math.PI * 2);
  else if (mark === 'diamond') { g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); }
  else if (mark === 'hex') { for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); }
  else { g.moveTo(cx - r, cy - r * 0.8); g.lineTo(cx + r, cy - r * 0.8); g.lineTo(cx + r, cy + r * 0.2); g.quadraticCurveTo(cx + r, cy + r * 0.9, cx, cy + r); g.quadraticCurveTo(cx - r, cy + r * 0.9, cx - r, cy + r * 0.2); g.closePath(); }
}

/** The sponsor's monogram: mark shape in `fill`, first letter in `ink`. */
function drawMark(g: CanvasRenderingContext2D, s: Sponsor, cx: number, cy: number, r: number, fill: string, ink: string): void {
  markPath(g, cx, cy, r, MARKS[s.id] ?? 'circle');
  g.fillStyle = fill; g.fill();
  g.fillStyle = ink;
  g.font = `bold ${Math.round(r * 1.25)}px system-ui, Helvetica, Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(s.name.charAt(0), cx, cy + r * 0.06);
}

/** Draw `text` centred at (cx, cy), shrinking the font until it fits `maxW`. */
function fitText(g: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, px: number, ink: string, weight = 'bold'): void {
  let size = px;
  for (;;) {
    g.font = `${weight} ${Math.round(size)}px system-ui, Helvetica, Arial, sans-serif`;
    if (g.measureText(text).width <= maxW || size < 8) break;
    size *= 0.92;
  }
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, cx, cy);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

/**
 * Paint `sponsor` into `slot`. Transparent-background slots (matCenter,
 * matCorners) are meant for alpha decals; the rest are opaque panels.
 * `postPads` is painted on WHITE so the pad's instance colour can tint it.
 */
export function paintSlot(sponsor: Sponsor, slot: SlotId, anisotropy = 1): THREE.CanvasTexture {
  const [w, h] = SLOT_SIZE[slot];
  const [c, g] = makeCanvas(w, h);
  const s = sponsor;

  if (slot === 'matCenter') {
    const cx = w / 2, cy = h / 2, R = w * 0.44;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fillStyle = s.primary; g.fill();
    g.lineWidth = w * 0.02; g.strokeStyle = s.secondary; g.stroke();
    g.beginPath(); g.arc(cx, cy, R * 0.86, 0, Math.PI * 2); g.stroke();
    drawMark(g, s, cx, cy - R * 0.3, R * 0.28, s.secondary, s.primary);
    fitText(g, s.name, cx, cy + R * 0.28, R * 1.5, w * 0.11, s.secondary);
    fitText(g, 'PRESENTS', cx, cy + R * 0.55, R * 1.2, w * 0.045, s.secondary, '600');
  } else if (slot === 'matCorners') {
    roundRect(g, w * 0.06, h * 0.06, w * 0.88, h * 0.88, w * 0.1);
    g.fillStyle = s.primary; g.fill();
    g.lineWidth = w * 0.025; g.strokeStyle = s.secondary; g.stroke();
    drawMark(g, s, w / 2, h * 0.4, w * 0.2, s.secondary, s.primary);
    fitText(g, s.name, w / 2, h * 0.74, w * 0.78, w * 0.1, s.secondary);
  } else if (slot === 'apronFront' || slot === 'apronSides' || slot === 'introBanner') {
    g.fillStyle = s.primary; g.fillRect(0, 0, w, h);
    g.fillStyle = s.secondary; g.fillRect(0, 0, w, h * 0.04); g.fillRect(0, h * 0.96, w, h * 0.04);
    const r = h * 0.28;
    drawMark(g, s, r * 1.4, h / 2, r, s.secondary, s.primary);
    drawMark(g, s, w - r * 1.4, h / 2, r, s.secondary, s.primary);
    fitText(g, s.name, w / 2, h * 0.5, w - r * 6, h * 0.42, s.secondary);
  } else if (slot === 'postPads') {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
    drawMark(g, s, w / 2, h / 2, w * 0.3, '#2a2a2a', '#ffffff');
  } else { // roundCard
    g.fillStyle = s.primary; g.fillRect(0, 0, w, h);
    g.fillStyle = s.secondary; g.fillRect(0, h * 0.62, w, h * 0.04);
    drawMark(g, s, w / 2, h * 0.32, h * 0.2, s.secondary, s.primary);
    fitText(g, s.name, w / 2, h * 0.8, w * 0.8, h * 0.16, s.secondary);
  }
  return canvasTexture(c, anisotropy);
}

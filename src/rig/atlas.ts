/**
 * rig/atlas.ts — where each part of the fighter lives in its texture atlas.
 * One square atlas per fighter (2048 px on the high tier, 1024 on the low),
 * painted in code (paint.ts). Rects are in pixels of a 2048 sheet here and
 * handed to the mesh in 0..1 UV units with a small inset so mips do not bleed.
 */
import type { Rect } from './geo';

export const ATLAS_UNITS = 2048;

/** name → [x, y, w, h] in 2048-sheet pixels. */
export const ATLAS: Record<string, readonly [number, number, number, number]> = {
  torso: [0, 0, 1024, 832],          // u: around (0.5 = front, seam down the spine); v: neck (top) → crotch
  head: [1024, 0, 768, 512],         // u: around (0.5 = the face); v: crown (top) → under the chin
  armL: [0, 832, 256, 640],          // u: around (0.25 = front, 0.5 = outside); v: shoulder → wrist
  armR: [256, 832, 256, 640],
  legL: [512, 832, 256, 640],        // v: hip → ankle
  legR: [768, 832, 256, 640],
  trunks: [1024, 512, 1024, 384],    // u: around (0.5 = front); v: waistband top → crotch
  trunkLegL: [1024, 896, 512, 256],  // u: around the leg (0.5 = outside); v: hip → hem
  trunkLegR: [1536, 896, 512, 256],
  gloveL: [1024, 1152, 256, 256],    // u: around (0.25 = the thumb side… see kit.ts); v: cuff top → knuckles
  gloveR: [1280, 1152, 256, 256],
  bootL: [1536, 1152, 256, 256],     // top half: the shaft (u around, 0.25 = front); bottom half: the foot
  bootR: [1792, 1152, 256, 256],
  hair: [1024, 1408, 384, 256],
  beard: [1408, 1408, 256, 256],
  // Flat swatches.
  sole: [1664, 1408, 64, 64],
  lining: [1728, 1408, 64, 64],
  ear: [1792, 1408, 64, 64],
  thumb: [1856, 1408, 64, 64],
  cuff: [1664, 1472, 128, 64],
  tie: [1792, 1472, 64, 64],
  hand: [1856, 1472, 64, 64],
  tassel: [1920, 1408, 64, 64],
  teeth: [1920, 1472, 64, 64],
  eyeL: [1664, 1536, 128, 128],
  eyeR: [1792, 1536, 128, 128],
};

export function atlasRect(name: string): Rect {
  const r = ATLAS[name];
  if (!r) throw new Error(`atlas: no rect '${name}'`);
  const inset = 2;
  return { x: (r[0] + inset) / ATLAS_UNITS, y: (r[1] + inset) / ATLAS_UNITS, w: (r[2] - 2 * inset) / ATLAS_UNITS, h: (r[3] - 2 * inset) / ATLAS_UNITS };
}

/**
 * ui/accent.ts — a fighter's colour on dark UI (the HUD bars, the cards, the
 * plates): his trunks colour, or the trim when the trunks are too dark to
 * read against a dark panel (two of the roster wear near-black).
 */
import type { FighterSpec } from '../core';

function lum(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1]!, 16);
  return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
}

/** [accent, second colour]. */
export function accent(f: Pick<FighterSpec, 'trunksPrimary' | 'trunksSecondary'>): [string, string] {
  return lum(f.trunksPrimary) < 0.16 ? [f.trunksSecondary, f.trunksPrimary] : [f.trunksPrimary, f.trunksSecondary];
}

/**
 * ui/wordmark.ts — the title's lettering, drawn in code (no fonts, no assets):
 * heavy condensed caps built from thick strokes on a 4 × 7 grid, slanted, with
 * a rule and a strapline in the same alphabet. An SVG string; it scales with
 * the box it is put in. Only the letters the title needs are defined.
 */
const GLYPHS: Record<string, string> = {
  L: 'M0,0 V7 H4',
  O: 'M1,0 H3 Q4,0 4,1 V6 Q4,7 3,7 H1 Q0,7 0,6 V1 Q0,0 1,0 Z',
  N: 'M0,7 V0 L4,7 V0',
  G: 'M4,1.3 Q4,0 3,0 H1 Q0,0 0,1 V6 Q0,7 1,7 H3 Q4,7 4,6 V3.8 H2.3',
  C: 'M4,1.3 Q4,0 3,0 H1 Q0,0 0,1 V6 Q0,7 1,7 H3 Q4,7 4,5.7',
  U: 'M0,0 V6 Q0,7 1,7 H3 Q4,7 4,6 V0',
  T: 'M0,0 H4 M2,0 V7',
  M: 'M0,7 V0 L2,3.6 L4,0 V7',
  A: 'M0,7 V1.6 Q0,0 2,0 Q4,0 4,1.6 V7 M0,4.4 H4',
  I: 'M2,0 V7',
  E: 'M4,0 H0 V7 H4 M0,3.5 H3.2',
  V: 'M0,0 L2,7 L4,0',
  B: 'M0,0 V7 H2.8 Q4,7 4,5.3 Q4,3.6 2.8,3.5 H0 M2.8,3.5 Q3.8,3.4 3.8,1.75 Q3.8,0 2.6,0 H0',
  X: 'M0,0 L4,7 M4,0 L0,7',
};

/** One line of lettering as SVG paths: `h` cap height, `weight` stroke as a fraction of it, `track` gap between letters in grid units. */
function line(text: string, x: number, y: number, h: number, weight: number, track: number, color: string): { svg: string; width: number } {
  const u = h / 7;
  let cx = 0, out = '';
  for (const ch of text) {
    if (ch === ' ') { cx += 2.6 + track; continue; }
    const d = GLYPHS[ch];
    if (!d) continue;
    const w = ch === 'I' ? 0 : 4;
    const ox = ch === 'I' ? -2 : 0;
    out += `<path d="${d}" transform="translate(${(x + (cx + ox) * u).toFixed(2)},${y}) scale(${u.toFixed(4)})"/>`;
    cx += w + track;
  }
  return {
    svg: `<g fill="none" stroke="${color}" stroke-width="${(weight * 7).toFixed(2)}" stroke-linejoin="miter" stroke-miterlimit="1.6" stroke-linecap="butt" vector-effect="none">${out}</g>`,
    width: (cx - track) * u,
  };
}

/** The title block: two lines of heavy caps, a gold rule, the strapline. */
export function wordmarkSvg(top: string, bottom: string, strap: string): string {
  const H = 78, W = 0.2;             // cap height and stroke weight of the big lines
  const pad = H * W;                  // room for the stroke outside the grid
  const a = line(top, pad, pad, H, W, 1.75, '#f4f1e8');
  const b = line(bottom, pad, pad + H + 26, H, W, 1.75, '#f4f1e8');
  // Each big line over a black copy of itself, dropped 5 units: the same hard shadow the names carry.
  const sh = (l: { svg: string }): string => `<g transform="translate(0,5)" opacity="0.9">${l.svg.replace(/stroke="#f4f1e8"/, 'stroke="#000"')}</g>${l.svg}`;
  const ruleY = pad + 2 * H + 26 + 30;
  const s = line(strap, pad, ruleY + 22, 13, 0.16, 3.4, '#d8b45a');
  const width = Math.max(a.width, b.width, s.width) + 2 * pad;
  const height = ruleY + 22 + 13 + pad;
  // The slant leans the top to the right: leave room for it.
  const lean = Math.tan(10 * Math.PI / 180) * height;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${(width + lean).toFixed(1)} ${height.toFixed(1)}" role="img" aria-label="${top} ${bottom}">` +
    `<g transform="translate(${lean.toFixed(1)},0) skewX(-10)">${sh(a)}${sh(b)}` +
    `<rect x="${pad}" y="${ruleY}" width="${(Math.max(a.width, b.width)).toFixed(1)}" height="4" fill="#d8b45a"/>${s.svg}</g></svg>`;
}

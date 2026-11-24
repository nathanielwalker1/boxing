/**
 * camclear.ts — the play camera's clear line (2026-11-24, "the post hides the blue fighter, ropes cross their heads").
 * Each frame the follow camera asks: from where I am about to stand, does a corner post / cushion stand in front
 * of either fighter's head or torso, or does a rope's line cross either man between the top of his head and his
 * waist? If so it tries a few nearby seats — the lens lifted (looking down over the top rope) and/or dollied in
 * (FOV widened to keep the fighters the same size) — and returns the cheapest seat that is clear. stage.ts eases
 * toward it, so the camera rises and falls smoothly, never cuts. Analytic geometry from the same constants
 * ring.ts builds with; render-only, nothing here touches the sim.
 */
import { RING_HALF, type Config, type Vec2 } from '../core';

export interface ClearSeat { liftDeg: number; scale: number; blocked: number }

/** How many of the two fighters' lines from camera C are fouled (posts count double: they hide, a rope only crosses). */
function fouled(C: readonly [number, number, number], fighters: readonly Vec2[], c: Config): number {
  const h = RING_HALF + c.postR, pOff = RING_HALF + c.postR + 0.05;
  const postTop = c.ropeTopY + 0.32, PR = Math.max(c.postR * 1.35, c.ringCushionW / 2 + 0.02) + c.camClearMargin;
  const yTop = c.camClearHeadY, yBot = c.camClearWaistY, mid = (yTop + yBot) / 2;
  let n = 0;
  for (const f of fighters) {
    // posts + cushions: a vertical cylinder at each corner, tested on the rays to head top, chest and waist
    let post = false;
    for (const y of [yTop, mid, yBot]) {
      const dx = f.x - C[0], dz = f.z - C[2];
      const A = dx * dx + dz * dz; if (A < 1e-9) continue;
      for (let k = 0; k < 4 && !post; k++) {
        const cx = (k & 1 ? 1 : -1) * pOff, cz = (k & 2 ? 1 : -1) * pOff;
        const fx = C[0] - cx, fz = C[2] - cz;
        const B = 2 * (fx * dx + fz * dz), Cc = fx * fx + fz * fz - PR * PR, disc = B * B - 4 * A * Cc;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc), t0 = Math.max(0, (-B - sq) / (2 * A)), t1 = Math.min(1, (-B + sq) / (2 * A));
        if (t0 > t1) continue;
        if (Math.min(C[1] + (y - C[1]) * t0, C[1] + (y - C[1]) * t1) < postTop) post = true;
      }
      if (post) break;
    }
    if (post) { n += 2; continue; }
    // ropes: where the rays to his head top and his waist pierce a side's plane, no rope height may lie between
    for (let s = 0; s < 4; s++) {
      const ax = s < 2 ? 0 : 2, sg = s & 1 ? 1 : -1, o = ax === 0 ? 2 : 0;
      const P = [f.x, 0, f.z];
      const d = P[ax]! - C[ax]; if (Math.abs(d) < 1e-9) continue;
      const t = (sg * h - C[ax]) / d; if (t <= 0 || t >= 1) continue;
      if (Math.abs(C[o] + (P[o]! - C[o]) * t) > h + 0.2) continue;
      const a = C[1] + (yTop - C[1]) * t, b = C[1] + (yBot - C[1]) * t;
      const lo = Math.min(a, b) - c.camClearMargin, hi = Math.max(a, b) + c.camClearMargin;
      let hit = false;
      for (let i = 0; i < c.ropeCount; i++) { const y = c.ropeTopY * (i + 1) / c.ropeCount; if (y > lo && y < hi) hit = true; }
      if (hit) { n += 1; break; }
    }
  }
  return n;
}

/**
 * The cheapest clear seat around (look, az, el, dist): lift in camClearStepDeg steps up to camClearMaxLiftDeg,
 * dolly scale down to camClearMinScale. Cost = lift degrees + (1 - scale) * camClearPullCost; the seat chosen last
 * frame gets camClearHold degrees off, so a boundary does not flip the choice back and forth (no shimmer).
 */
export function clearSeat(look: { x: number; y: number; z: number }, az: number, elBase: number, dist: number,
  fighters: readonly Vec2[], prev: ClearSeat, c: Config): ClearSeat {
  let best: ClearSeat | null = null, bestCost = Infinity, fallback: ClearSeat = { liftDeg: 0, scale: 1, blocked: 99 }, fbCost = Infinity;
  const steps = Math.max(0, Math.floor(c.camClearMaxLiftDeg / Math.max(0.5, c.camClearStepDeg)));
  const sSteps = 4;
  for (let si = 0; si <= sSteps; si++) {
    const scale = 1 - (1 - c.camClearMinScale) * si / sSteps;
    for (let li = 0; li <= steps; li++) {
      const liftDeg = li * c.camClearStepDeg;
      let cost = liftDeg + (1 - scale) * c.camClearPullCost;
      if (Math.abs(liftDeg - prev.liftDeg) < 1e-6 && Math.abs(scale - prev.scale) < 1e-6) cost -= c.camClearHold;
      if (cost >= bestCost) continue;
      const el = elBase + liftDeg * Math.PI / 180, d = dist * scale;
      const C: [number, number, number] = [look.x + d * Math.cos(el) * Math.cos(az), look.y + d * Math.sin(el), look.z + d * Math.cos(el) * Math.sin(az)];
      const n = fouled(C, fighters, c);
      if (n === 0) { best = { liftDeg, scale, blocked: 0 }; bestCost = cost; }
      else if (!best && (n < fallback.blocked || (n === fallback.blocked && cost < fbCost))) { fallback = { liftDeg, scale, blocked: n }; fbCost = cost; }
    }
  }
  return best ?? fallback;
}

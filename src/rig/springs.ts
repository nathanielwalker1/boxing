/**
 * rig/springs.ts — client-side spring-dampers for secondary motion on the
 * NON-hitbox parts (hips, spine, shoulder line, elbow pole). CONTRACT 2026-09-02
 * "the sim owns the glove": nothing here ever touches head or glove position.
 *
 * Parameterised by stiffness k and damping RATIO zeta (1 = critical, <1
 * overshoots) so the panel reads naturally. Sub-stepped so a long frame from a
 * background tab cannot blow the explicit integrator up.
 */
import { stepSpring1, stepSpring3, type Spring1, type Spring3 } from '../core';

const MAX_STEP = 1 / 120;

export function chase1(s: Spring1, target: number, k: number, zeta: number, dt: number): number {
  const c = 2 * zeta * Math.sqrt(k);
  let left = dt;
  while (left > 1e-9) {
    const h = left > MAX_STEP ? MAX_STEP : left;
    stepSpring1(s, target, k, c, h);
    left -= h;
  }
  return s.x;
}

export function chase3(s: Spring3, tx: number, ty: number, tz: number, k: number, zeta: number, dt: number): Spring3 {
  const c = 2 * zeta * Math.sqrt(k);
  let left = dt;
  while (left > 1e-9) {
    const h = left > MAX_STEP ? MAX_STEP : left;
    stepSpring3(s, tx, ty, tz, k, c, h);
    left -= h;
  }
  return s;
}

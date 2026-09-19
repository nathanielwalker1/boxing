/**
 * core/math.ts — the sim's entire maths vocabulary. No three.js here.
 *
 * Determinism note: `+ - * / sqrt` are IEEE-exact on every engine. `sin`, `cos`,
 * `atan2`, `exp` are not guaranteed bit-identical across engines, only within
 * one. The sim calls the wrappers below rather than Math.* directly so they can
 * be swapped for polynomial approximations when NET needs cross-machine
 * lockstep (CONTRACT addition 2026-09-02). For now: same-engine determinism.
 */
import type { Vec2, Vec3, Spring1, Spring3 } from './types';

export const TAU = Math.PI * 2;

export const sin   = (a: number): number => Math.sin(a);
export const cos   = (a: number): number => Math.cos(a);
export const atan2 = (y: number, x: number): number => Math.atan2(y, x);
export const sqrt  = (x: number): number => Math.sqrt(x);

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
export const clamp01 = (x: number): number => clamp(x, 0, 1);

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate-independent exponential approach: moves `a` toward `b` by rate λ over dt. */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function sign(x: number): -1 | 0 | 1 {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Shortest signed delta from angle a to angle b. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Turn `a` toward `b` by at most `maxStep` radians. */
export function turnToward(a: number, b: number, maxStep: number): number {
  const d = angleDelta(a, b);
  return wrapAngle(a + clamp(d, -maxStep, maxStep));
}

// ── Vec2 (floor: x, z) ────────────────────────────────────────────────────────

export const v2 = (x = 0, z = 0): Vec2 => ({ x, z });
export const v2len = (a: Vec2): number => sqrt(a.x * a.x + a.z * a.z);
export const v2dist = (a: Vec2, b: Vec2): number => sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
export const v2dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
export const v2sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const v2add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const v2scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s });
export function v2norm(a: Vec2): Vec2 {
  const l = v2len(a);
  return l > 1e-9 ? { x: a.x / l, z: a.z / l } : { x: 0, z: 0 };
}
/** Angle of a floor vector: yaw such that forward(yaw) == norm(a). */
export const v2angle = (a: Vec2): number => atan2(a.z, a.x);

// ── Vec3 ─────────────────────────────────────────────────────────────────────

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const v3len = (a: Vec3): number => sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const v3dist = (a: Vec3, b: Vec3): number => sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
export const v3sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const v3add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const v3scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const v3copy = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export function v3norm(a: Vec3): Vec3 {
  const l = v3len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}

// ── Fighter local frame ───────────────────────────────────────────────────────

/**
 * The floor-plane basis of a fighter facing `yaw`.
 *   fwd   = (cos yaw, sin yaw)      toward the opponent
 *   right = (-sin yaw, cos yaw)     the fighter's own right-hand side
 * Orthodox: lead hand is the LEFT (= -right), rear hand is the right.
 */
export interface Frame { fwd: Vec2; right: Vec2 }
export function frameOf(yaw: number): Frame {
  const c = cos(yaw), s = sin(yaw);
  return { fwd: { x: c, z: s }, right: { x: -s, z: c } };
}

/**
 * Local (forward, up, right) offsets → world Vec3 at floor point `pos`.
 * `lateral` > 0 is the fighter's right.
 */
export function localToWorld(pos: Vec2, f: Frame, forward: number, up: number, lateral: number): Vec3 {
  return {
    x: pos.x + f.fwd.x * forward + f.right.x * lateral,
    y: up,
    z: pos.z + f.fwd.z * forward + f.right.z * lateral,
  };
}

/** World Vec3 → local (forward, up, lateral) relative to `pos` facing frame `f`. */
export function worldToLocal(pos: Vec2, f: Frame, p: Vec3): { forward: number; up: number; lateral: number } {
  const dx = p.x - pos.x, dz = p.z - pos.z;
  return { forward: dx * f.fwd.x + dz * f.fwd.z, up: p.y, lateral: dx * f.right.x + dz * f.right.z };
}

/** Lateral sign of a hand for a stance: lead is the left hand for orthodox. */
export function handLateralSign(hand: 'lead' | 'rear', stance: 'orthodox' | 'southpaw'): -1 | 1 {
  const leadIsLeft = stance === 'orthodox';
  return (hand === 'lead') === leadIsLeft ? -1 : 1;
}

// ── Springs (semi-implicit Euler; the whole game's motion vocabulary) ─────────

/**
 * One spring-damper step toward `target`. k = stiffness (1/s²), c = damping (1/s).
 * Critically damped when c = 2·sqrt(k). Mutates and returns `s`.
 */
export function stepSpring1(s: Spring1, target: number, k: number, c: number, dt: number): Spring1 {
  s.v += (k * (target - s.x) - c * s.v) * dt;
  s.x += s.v * dt;
  return s;
}

export function stepSpring3(s: Spring3, tx: number, ty: number, tz: number, k: number, c: number, dt: number): Spring3 {
  s.vx += (k * (tx - s.x) - c * s.vx) * dt;
  s.vy += (k * (ty - s.y) - c * s.vy) * dt;
  s.vz += (k * (tz - s.z) - c * s.vz) * dt;
  s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
  return s;
}

export const spring1 = (x = 0): Spring1 => ({ x, v: 0 });
export const spring3 = (): Spring3 => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });

// ── Geometry queries ──────────────────────────────────────────────────────────

export function sphereOverlap(a: { x: number; y: number; z: number; r: number }, b: { x: number; y: number; z: number; r: number }): boolean {
  return v3dist(a, b) <= a.r + b.r;
}

/**
 * The middle joint of an analytic two-bone chain root→mid→target (bones l1,
 * l2), bending toward `pole`. Pure twin of rig/ik.ts solveTwoBone so the sim
 * can place elbows for contact: past reach the second bone stretches up to
 * `stretchMax` × l2, then the chain falls short along the line.
 */
export function twoBoneMid(root: Vec3, target: Vec3, l1: number, l2: number, pole: Vec3, stretchMax: number): Vec3 {
  let dx = target.x - root.x, dy = target.y - root.y, dz = target.z - root.z;
  let d = sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-6) { dx = 0; dy = -1; dz = 0; d = 1e-6; } else { dx /= d; dy /= d; dz /= d; }
  let len2 = l2;
  if (d > l1 + l2) len2 = Math.min(d - l1, l2 * stretchMax);
  const dEff = Math.min(d, l1 + len2);
  const a = (l1 * l1 - len2 * len2 + dEff * dEff) / (2 * dEff);
  const h = sqrt(Math.max(0, l1 * l1 - a * a));
  const pd = pole.x * dx + pole.y * dy + pole.z * dz;
  let px = pole.x - dx * pd, py = pole.y - dy * pd, pz = pole.z - dz * pd;
  let pl = px * px + py * py + pz * pz;
  if (pl < 1e-8) {
    // Pole along the chain: pick any perpendicular.
    const tx = Math.abs(dy) > 0.9 ? 1 : 0, ty = Math.abs(dy) > 0.9 ? 0 : 1;
    px = dy * 0 - dz * ty; py = dz * tx - dx * 0; pz = dx * ty - dy * tx;
    pl = px * px + py * py + pz * pz;
  }
  pl = sqrt(pl); px /= pl; py /= pl; pz /= pl;
  return { x: root.x + dx * a + px * h, y: root.y + dy * a + py * h, z: root.z + dz * a + pz * h };
}

/** Closest points between segments p0→p1 and q0→q1 (Ericson, Real-Time Collision Detection 5.1.9). */
export function closestSegSeg(p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3): { p: Vec3; q: Vec3 } {
  const d1 = v3sub(p1, p0), d2 = v3sub(q1, q0), r = v3sub(p0, q0);
  const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z, e = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z;
  const f = d2.x * r.x + d2.y * r.y + d2.z * r.z;
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) return { p: v3copy(p0), q: v3copy(q0) };
  if (a <= 1e-12) { t = clamp01(f / e); }
  else {
    const c = d1.x * r.x + d1.y * r.y + d1.z * r.z;
    if (e <= 1e-12) { s = clamp01(-c / a); }
    else {
      const b = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return { p: v3add(p0, v3scale(d1, s)), q: v3add(q0, v3scale(d2, t)) };
}

/** Closest point on segment a→b to p. */
export function closestOnSegment(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const ab = v3sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  if (l2 < 1e-12) return v3copy(a);
  const ap = v3sub(p, a);
  const t = clamp01((ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / l2);
  return v3add(a, v3scale(ab, t));
}

export function sphereCapsuleOverlap(s: { x: number; y: number; z: number; r: number }, c: { a: Vec3; b: Vec3; r: number }): boolean {
  return v3dist(closestOnSegment(c.a, c.b, s), s) <= s.r + c.r;
}

/** Triangle wave 0→1→0 over t∈[0,1] with the peak at `peak`. */
export function triangle(t: number, peak = 0.5): number {
  t = clamp01(t);
  return t < peak ? t / peak : (1 - t) / (1 - peak);
}

export function smoothstep(t: number): number {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

/**
 * sim/movement.ts — locomotion, ring bounds, body separation, facing.
 * Port of legacy/src/movement.js (stepMovement, resolveOverlap, stepFacing)
 * at 1 px = 0.0122 m, with the boundary as a floor square inset from the
 * ropes and facing as a yaw that turns at a capped rate instead of snapping.
 */
import type { Config, FighterState, FrameInput, Vec2 } from '../core';
import { RING_HALF, clamp, frameOf, sqrt, turnToward, v2angle, v2dist, v2len, v2sub } from '../core';

/** Half-size of the walkable square. */
export const bound = (cfg: Config): number => RING_HALF - cfg.ringInset;

/**
 * Accelerate toward the input velocity (or coast under friction), integrate,
 * clamp to the ring. Mass scales both rates so heavier = sluggier (v1's
 * acceleration / playerMass). `move` is opponent-relative and is resolved
 * through the fighter's own frame. Stagger is a separate floor velocity that
 * only decays — a shove never reads as walking.
 */
export function stepLocomotion(f: FighterState, input: Readonly<FrameInput>, cfg: Config, dt: number): void {
  const massScale = cfg.moveMassRef / f.body.massKg;
  const accelRate = cfg.moveAccel * massScale;
  const frictionRate = cfg.moveFriction * massScale;
  let mx = input.move.x, my = input.move.y;
  const hasInput = Math.abs(mx) > 0.01 || Math.abs(my) > 0.01;

  if (hasInput) {
    const len = sqrt(mx * mx + my * my);
    if (len > 1) { mx /= len; my /= len; }
    const fr = frameOf(f.yaw);
    const tvx = (fr.fwd.x * my + fr.right.x * mx) * cfg.moveSpeed;
    const tvz = (fr.fwd.z * my + fr.right.z * mx) * cfg.moveSpeed;
    const a = Math.min(1, accelRate * dt);
    f.vel.x += (tvx - f.vel.x) * a;
    f.vel.z += (tvz - f.vel.z) * a;
  } else {
    const decay = Math.min(1, frictionRate * dt);
    f.vel.x *= 1 - decay;
    f.vel.z *= 1 - decay;
    if (Math.abs(f.vel.x) < cfg.moveStopSpeed) f.vel.x = 0;
    if (Math.abs(f.vel.z) < cfg.moveStopSpeed) f.vel.z = 0;
  }

  const spd = v2len(f.vel);
  if (spd > cfg.moveSpeed) {
    f.vel.x = (f.vel.x / spd) * cfg.moveSpeed;
    f.vel.z = (f.vel.z / spd) * cfg.moveSpeed;
  }

  // Stagger: impact velocity, decays on its own clock.
  const sd = Math.max(0, 1 - cfg.staggerDecay * dt);
  f.stagger.x *= sd;
  f.stagger.z *= sd;
  if (Math.abs(f.stagger.x) < cfg.moveStopSpeed) f.stagger.x = 0;
  if (Math.abs(f.stagger.z) < cfg.moveStopSpeed) f.stagger.z = 0;

  f.pos.x += (f.vel.x + f.stagger.x) * dt;
  f.pos.z += (f.vel.z + f.stagger.z) * dt;

  const b = bound(cfg);
  const px = f.pos.x, pz = f.pos.z;
  f.pos.x = clamp(f.pos.x, -b, b);
  f.pos.z = clamp(f.pos.z, -b, b);
  if (f.pos.x !== px) { f.vel.x = 0; f.stagger.x = 0; }
  if (f.pos.z !== pz) { f.vel.z = 0; f.stagger.z = 0; }
}

/** Shift a body by d, clamped to the ring; returns the part the ring refused. */
function nudge(p: Vec2, dx: number, dz: number, b: number): Vec2 {
  const px = p.x, pz = p.z;
  p.x = clamp(p.x + dx, -b, b);
  p.z = clamp(p.z + dz, -b, b);
  return { x: dx - (p.x - px), z: dz - (p.z - pz) };
}

/**
 * Soft body separation: each tick only `separationStrength` of the overlap is
 * corrected, split half each, and whatever the ring refuses one fighter is
 * handed to the other so a cornered fighter is pushed out along the ropes.
 * Velocity is untouched — walking into someone shoves rather than stalls.
 */
export function resolveSeparation(a: FighterState, b: FighterState, cfg: Config): void {
  const minD = cfg.separationDist;
  if (minD <= 0) return;
  const d = v2dist(a.pos, b.pos);
  if (d >= minD) return;
  // Exactly co-located: a fixed axis rather than a jittering one.
  const ux = d > 0.001 ? (b.pos.x - a.pos.x) / d : 1;
  const uz = d > 0.001 ? (b.pos.z - a.pos.z) / d : 0;
  const half = (minD - d) * cfg.separationStrength / 2;
  const bd = bound(cfg);
  const restA = nudge(a.pos, -ux * half, -uz * half, bd);
  const restB = nudge(b.pos, ux * half, uz * half, bd);
  if (restA.x || restA.z) nudge(b.pos, -restA.x, -restA.z, bd);
  if (restB.x || restB.z) nudge(a.pos, -restB.x, -restB.z, bd);
}

/**
 * Face wherever the opponent is standing right now, turning at most
 * turnRate·dt per tick. Uses locomotion positions only (never a glove or a
 * reaction offset). At zero separation there is no answer, so hold.
 */
export function stepFacing(f: FighterState, opp: FighterState, cfg: Config, dt: number): void {
  const d = v2sub(opp.pos, f.pos);
  if (v2len(d) < 1e-6) return;
  f.yaw = turnToward(f.yaw, v2angle(d), cfg.turnRate * dt);
}

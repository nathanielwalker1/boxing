/**
 * sim/movement.ts — locomotion, ring bounds, body separation, facing.
 * Port of legacy/src/movement.js (stepMovement, resolveOverlap, stepFacing)
 * at 1 px = 0.0122 m, with the boundary as a floor square inset from the
 * ropes and facing as a yaw that turns at a capped rate instead of snapping.
 *
 * Overhaul 2026-11-11: walking is scaled by what the fighter is doing
 * (footing.ts moveScales: level, body wear, a punch planting the feet, block
 * stun, flat-footed push-off, a burst's landing); the burst rides its own
 * `hop` channel; a pivot swings the hips round the planted lead foot; a
 * stumble into the ropes rebounds; a fighter turns slower mid-punch and
 * after being pivoted on.
 */
import type { Config, FighterState, FrameInput, Vec2 } from '../core';
import { RING_HALF, clamp, frameOf, lerp, sqrt, turnToward, v2angle, v2dist, v2len, v2sub } from '../core';
import { moveScales, stepHop, stepPivot } from './footing';

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
  // The legs go first (2026-09-16): at zero stamina top speed and the push-off
  // are moveTiredScale of fresh, linearly in between. Both fighters.
  const tired = lerp(cfg.moveTiredScale, 1, clamp(f.stamina, 0, 1)) * (f.hurt > 0 && f.hurtKind !== 'body' ? cfg.stunMoveScale : 1);   // rocked: the legs go (sim/stun.ts)
  const ms = moveScales(f, cfg);
  const accelRate = cfg.moveAccel * massScale * tired * ms.accel;
  const frictionRate = cfg.moveFriction * massScale;
  let mx = input.move.x, my = input.move.y;
  const hasInput = (Math.abs(mx) > 0.01 || Math.abs(my) > 0.01) && ms.speed > 0;

  if (hasInput) {
    const len = sqrt(mx * mx + my * my);
    if (len > 1) { mx /= len; my /= len; }
    const fr = frameOf(f.yaw);
    // Direction-dependent top speed: full speed forward, slower backing off
    // and circling. Weighted by the squared components (which sum to the
    // squared magnitude), so a diagonal blends the two.
    const m2 = mx * mx + my * my;
    const dirScale = m2 > 0 ? ((my > 0 ? 1 : cfg.moveBackScale) * my * my + cfg.moveLateralScale * mx * mx) / m2 : 1;
    const speed = cfg.moveSpeed * dirScale * tired * ms.speed;
    const tvx = (fr.fwd.x * my + fr.right.x * mx) * speed;
    const tvz = (fr.fwd.z * my + fr.right.z * mx) * speed;
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
  const cap = cfg.moveSpeed * Math.max(1, ms.speed);   // (a fast fighter's top speed is above moveSpeed)
  if (spd > cap) {
    f.vel.x = (f.vel.x / spd) * cap;
    f.vel.z = (f.vel.z / spd) * cap;
  }

  // Stagger: impact velocity, decays on its own clock.
  const sd = Math.max(0, 1 - cfg.staggerDecay * dt);
  f.stagger.x *= sd;
  f.stagger.z *= sd;
  if (Math.abs(f.stagger.x) < cfg.moveStopSpeed) f.stagger.x = 0;
  if (Math.abs(f.stagger.z) < cfg.moveStopSpeed) f.stagger.z = 0;

  // The pivot turns the hips about the planted foot; walking is off for it (moveScales).
  stepPivot(f, cfg, dt);
  const hop = stepHop(f, cfg, dt);
  f.pos.x += (f.vel.x + f.stagger.x) * dt + hop.x;
  f.pos.z += (f.vel.z + f.stagger.z) * dt + hop.z;

  const b = bound(cfg);
  const px = f.pos.x, pz = f.pos.z;
  f.pos.x = clamp(f.pos.x, -b, b);
  f.pos.z = clamp(f.pos.z, -b, b);
  // The ropes (overhaul): a stumble into them comes back at ropeRebound of
  // its speed — toward the ring, which is toward whoever put you there.
  const reb = cfg.ropesOn ? -cfg.ropeRebound : 0;
  if (f.pos.x !== px) { f.vel.x = 0; f.hop.x = 0; f.stagger.x = (f.pos.x > 0) === (f.stagger.x > 0) ? f.stagger.x * reb : f.stagger.x; }
  if (f.pos.z !== pz) { f.vel.z = 0; f.hop.z = 0; f.stagger.z = (f.pos.z > 0) === (f.stagger.z > 0) ? f.stagger.z * reb : f.stagger.z; }
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
 * Overhaul: the rate drops while a punch is in flight (it was thrown where
 * the opponent WAS) and for a beat after being pivoted on (`turned`).
 */
export function stepFacing(f: FighterState, opp: FighterState, cfg: Config, dt: number): void {
  const d = v2sub(opp.pos, f.pos);
  if (v2len(d) < 1e-6) return;
  let rate = cfg.turnRate;
  if (cfg.anglesOn && f.punch.type !== null && !f.punch.resolved) rate *= cfg.turnPunchScale;
  if (f.turned > 0) rate *= cfg.pivotTurnScale;
  f.yaw = turnToward(f.yaw, v2angle(d), rate * dt);
}

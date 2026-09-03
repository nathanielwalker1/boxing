import Phaser from 'phaser';
import { config } from './config.js';
import { RIG_MARGIN_X, RIG_MARGIN_TOP, RIG_MARGIN_BOTTOM } from './rig.js';

/**
 * Shared locomotion step — the ONE movement/velocity implementation, used by
 * both the player (Fighter) and the dummy's movement AI (Stage 7). Lifted out
 * of Fighter unchanged so the dummy doesn't get a parallel movement model:
 * identical accel/friction/mass curve, identical ring boundary clamp.
 *
 * Mutates body.x / body.y / body.vx / body.vy in place. `body` is anything with
 * those four fields — the Fighter itself, or the Dummy's locomotion sub-body
 * (the dummy hangs its stagger spring off the result; see dummy.js).
 *
 * @param {{x:number,y:number,vx:number,vy:number}} body
 * @param {number} dt          seconds
 * @param {number} inputX      -1..1 desired direction (pass 0 to coast to a stop)
 * @param {number} inputY      -1..1
 * @param {{left,right,top,bottom}} ringBounds
 * @param {number} moveSpeed   top speed for this body (px/s)
 */
/**
 * Movement bounce — the "weight shift" layer on top of the static guard pose,
 * so standing still and moving don't look identical. Advances the carrier's
 * `_bobPhase` and returns this frame's vertical bob in px, which the rig folds
 * into its dip (torso/head/thighs ride it, shins stay planted).
 *
 * Both amplitude and phase rate scale with speed, so the bounce fades in and
 * out with movement instead of switching on. The phase FREEZES rather than
 * resetting when a fighter stops, so stopping mid-stride and starting again
 * never snaps the body to a new offset.
 *
 * @param {{_bobPhase:number}} carrier  holds the phase (Fighter / Dummy)
 * @param {number} dt         seconds
 * @param {number} vx         locomotion velocity (NOT stagger — see dummy.js)
 * @param {number} vy
 * @param {number} refSpeed   this body's top speed, i.e. what counts as "full"
 * @returns {number} px of vertical bob this frame
 */
export function stepBob(carrier, dt, vx, vy, refSpeed) {
  const frac = Math.min(1, Math.hypot(vx, vy) / Math.max(refSpeed, 1));
  carrier._bobPhase += dt * config.guardBobFrequency * Math.PI * 2 * frac;
  return Math.sin(carrier._bobPhase) * config.guardBobAmplitude * frac;
}

/**
 * Facing — the ONE rule, shared by the player and the dummy: face wherever the
 * opponent is standing RIGHT NOW, recomputed every frame from live positions.
 * Nothing else feeds it — not movement input, not velocity, not AI state, not
 * ring position.
 *
 * Both arguments must be LOCOMOTION positions (where the fighter is standing),
 * never a render position carrying a transient impact offset. The dummy's
 * this.x is its locomotion x plus the stagger spring's offset, and passing that
 * in is what broke facing near the ropes: a few px of stagger wobble is not the
 * fighter walking around their opponent, but pinned against a rope it is the
 * ENTIRE horizontal separation — both bodies clamp to the same RIG_MARGIN_X, so
 * they sit at the identical x — and the wobble's sign therefore decided facing.
 * A punch would spin the dummy to face the ropes for the whole ~1 s recovery.
 * Same reason the movement AI measures its standoff distance from _loco.
 *
 * Exact ties are routine rather than a rare float coincidence, for that same
 * shared-clamp reason. Zero separation has no left/right answer, so facing
 * holds through a small deadband — stated deliberately, instead of falling out
 * of an `if (>) … else if (<)` with no else, and wide enough that sub-pixel
 * jitter can't strobe the sprite. Because the deadband only ever engages at
 * effectively-zero separation, the value it holds is the last real side the
 * opponent was on, which at a rope is always the ring side.
 *
 * @param {boolean} facingRight  current facing, returned unchanged inside the deadband
 * @param {number} selfX         this fighter's locomotion x
 * @param {number} opponentX     the opponent's locomotion x
 * @returns {boolean} facingRight for this frame
 */
export function stepFacing(facingRight, selfX, opponentX) {
  const dx = opponentX - selfX;
  if (dx >  config.facingDeadband) return true;
  if (dx < -config.facingDeadband) return false;
  return facingRight;
}

export function stepMovement(body, dt, inputX, inputY, ringBounds, moveSpeed) {
  const accelRate    = config.acceleration / config.playerMass;
  const frictionRate = config.friction     / config.playerMass;
  const hasInput     = Math.abs(inputX) > 0.01 || Math.abs(inputY) > 0.01;

  if (hasInput) {
    const len = Math.sqrt(inputX * inputX + inputY * inputY);
    const nx  = inputX / Math.max(len, 1);
    const ny  = inputY / Math.max(len, 1);
    const tvx = nx * moveSpeed;
    const tvy = ny * moveSpeed;
    const a   = Math.min(1, accelRate * dt);
    body.vx  += (tvx - body.vx) * a;
    body.vy  += (tvy - body.vy) * a;
  } else {
    const decay = Math.min(1, frictionRate * dt);
    body.vx *= (1 - decay);
    body.vy *= (1 - decay);
    if (Math.abs(body.vx) < 0.5) body.vx = 0;
    if (Math.abs(body.vy) < 0.5) body.vy = 0;
  }

  const spd = Math.hypot(body.vx, body.vy);
  if (spd > moveSpeed) {
    body.vx = (body.vx / spd) * moveSpeed;
    body.vy = (body.vy / spd) * moveSpeed;
  }

  body.x += body.vx * dt;
  body.y += body.vy * dt;

  const preX = body.x, preY = body.y;
  body.x = Phaser.Math.Clamp(body.x, ringBounds.left + RIG_MARGIN_X,   ringBounds.right  - RIG_MARGIN_X);
  body.y = Phaser.Math.Clamp(body.y, ringBounds.top  + RIG_MARGIN_TOP, ringBounds.bottom - RIG_MARGIN_BOTTOM);
  if (body.x !== preX) body.vx = 0;
  if (body.y !== preY) body.vy = 0;
}

/**
 * Shift a body by (dx, dy), clamped to the ring, and return the part of the
 * move the ring refused. Velocity is deliberately untouched: this is a
 * positional correction, not a force, so a fighter walking into someone keeps
 * their input velocity and shoves rather than stalling against them.
 */
function nudge(body, dx, dy, ringBounds) {
  const preX = body.x, preY = body.y;
  body.x = Phaser.Math.Clamp(body.x + dx, ringBounds.left + RIG_MARGIN_X,   ringBounds.right  - RIG_MARGIN_X);
  body.y = Phaser.Math.Clamp(body.y + dy, ringBounds.top  + RIG_MARGIN_TOP, ringBounds.bottom - RIG_MARGIN_BOTTOM);
  return { dx: dx - (body.x - preX), dy: dy - (body.y - preY) };
}

/**
 * Body separation — keep two fighters from standing in the same space.
 *
 * Soft, not solid: each frame only config.fighterSeparationStrength of the
 * current overlap is corrected, so the pair eases apart over a few frames.
 * Walking into an opponent therefore shoves them along instead of stopping
 * dead against an invisible wall, and a clinch stays possible — which matters,
 * because the punch rules need the too-close/smothered band to be reachable.
 *
 * Both bodies must be LOCOMOTION bodies (the dummy's _loco, not its stagger-
 * displaced this.x): the stagger is an impact wobble, and letting it drive the
 * push would have the two fighters shoving each other every time one got hit.
 * A staggered fighter can still visually overlap for the length of the wobble,
 * which reads as being knocked into someone rather than as clipping.
 *
 * Corners are the case this exists for and also the one that needs care: the
 * naive half-each split leaves the pair still overlapping when one of them is
 * pinned and cannot take its half. Whatever the ring refuses is handed to the
 * other fighter, so a cornered opponent gets pushed out along the ropes instead
 * of being stood inside.
 *
 * @param {{x,y}} a  locomotion body
 * @param {{x,y}} b  locomotion body
 * @param {{left,right,top,bottom}} ringBounds
 */
export function resolveOverlap(a, b, ringBounds) {
  const minD = config.fighterSeparationDist;
  if (minD <= 0) return;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d  = Math.hypot(dx, dy);
  if (d >= minD) return;

  // Exactly co-located: no separation axis to read, so pick a fixed one rather
  // than a random or facing-derived direction, which would make the resolution
  // jitter frame to frame.
  const ux = d > 0.001 ? dx / d : 1;
  const uy = d > 0.001 ? dy / d : 0;

  const half = (minD - d) * config.fighterSeparationStrength / 2;
  const restA = nudge(a, -ux * half, -uy * half, ringBounds);
  const restB = nudge(b,  ux * half,  uy * half, ringBounds);

  // Hand each fighter's refused share to the other — see the corner note above.
  if (restA.dx || restA.dy) nudge(b, -restA.dx, -restA.dy, ringBounds);
  if (restB.dx || restB.dy) nudge(a, -restB.dx, -restB.dy, ringBounds);
}

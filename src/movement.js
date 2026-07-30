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

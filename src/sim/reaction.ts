/**
 * sim/reaction.ts — hit reaction springs and the derived hitboxes.
 *
 * Port of legacy/src/reaction.js: three spring-dampers (head, torso, tilt)
 * pulling back to rest, kicked by an impulse. v2 differences: offsets are in
 * WORLD metres (the impulse direction comes from the event, so nothing needs
 * a mirrored local axis), and each level has its own stiffness/damping so the
 * chain lags instead of only scaling (CONTRACT §6 step 4). The per-punch
 * `snap` multiplier still rides on top of every level, as in v1.
 */
import type { Config, FighterState, PunchType, Vec3 } from '../core';
import { clamp, frameOf, localToWorld, stepSpring1, stepSpring3 } from '../core';
import { PUNCHES } from './punches';
import { reactionSnap, setReactionSnap } from './state';

/** Kick the defender's springs. `dir` is the unit impulse direction, `mag` in N·s. */
export function applyReaction(f: FighterState, type: PunchType, dir: Vec3, mag: number, cfg: Config): void {
  const def = PUNCHES[type];
  if (!def) return;
  const s = def.react(cfg);
  const v = mag * cfg.reactionForceScale;
  const r = f.reaction;
  r.head.vx += dir.x * s.back * v;
  r.head.vz += dir.z * s.back * v;
  r.head.vy += s.lift * v;
  r.torso.vx += dir.x * s.back * s.torso * v;
  r.torso.vz += dir.z * s.back * s.torso * v;
  r.torso.vy += s.lift * s.torso * v;
  r.tilt.v += s.twist * mag * cfg.reactionTwistScale;
  setReactionSnap(f, s.snap);
}

export function stepReaction(f: FighterState, cfg: Config, dt: number): void {
  const snap = reactionSnap(f);
  const r = f.reaction;
  stepSpring3(r.head, 0, 0, 0, cfg.reactionHeadK * snap, cfg.reactionHeadC, dt);
  stepSpring3(r.torso, 0, 0, 0, cfg.reactionTorsoK * snap, cfg.reactionTorsoC, dt);
  stepSpring1(r.tilt, 0, cfg.reactionTiltK * snap, cfg.reactionTiltC, dt);
  const m = cfg.reactionMaxOffset;
  r.head.x = clamp(r.head.x, -m, m); r.head.y = clamp(r.head.y, -m, m); r.head.z = clamp(r.head.z, -m, m);
  r.torso.x = clamp(r.torso.x, -m, m); r.torso.y = clamp(r.torso.y, -m, m); r.torso.z = clamp(r.torso.z, -m, m);
  r.tilt.x = clamp(r.tilt.x, -cfg.reactionMaxTilt, cfg.reactionMaxTilt);
}

/**
 * headBox = head rest + torso offset + head offset (the head rides on the
 * torso, as in v1). bodyBox = hips→shoulders capsule + torso offset. Slip
 * offset joins the head in Stage 2.
 */
export function computeBoxes(f: FighterState): void {
  const fr = frameOf(f.yaw);
  const b = f.body, r = f.reaction;
  const head = localToWorld(f.pos, fr, 0, b.headY, 0);
  f.headBox.x = head.x + r.torso.x + r.head.x;
  f.headBox.y = head.y + r.torso.y + r.head.y;
  f.headBox.z = head.z + r.torso.z + r.head.z;
  f.headBox.r = b.headR;
  const hip = localToWorld(f.pos, fr, 0, b.hipY, 0);
  const sh = localToWorld(f.pos, fr, 0, b.shoulderY, 0);
  f.bodyBox.a.x = hip.x + r.torso.x; f.bodyBox.a.y = hip.y + r.torso.y; f.bodyBox.a.z = hip.z + r.torso.z;
  f.bodyBox.b.x = sh.x + r.torso.x; f.bodyBox.b.y = sh.y + r.torso.y; f.bodyBox.b.z = sh.z + r.torso.z;
  f.bodyBox.r = b.bodyR;
}

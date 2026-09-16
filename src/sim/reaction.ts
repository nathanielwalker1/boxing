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
import { slipBack, slipLateral, slipShape } from './slip';

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
  // The head offset rides on top of the torso offset (see computeBoxes), so
  // its clamp is the neck: how far the head may leave the shoulders.
  const m = cfg.reactionMaxOffset, n = cfg.reactionMaxNeck;
  r.head.x = clamp(r.head.x, -n, n); r.head.y = clamp(r.head.y, -n, n); r.head.z = clamp(r.head.z, -n, n);
  r.torso.x = clamp(r.torso.x, -m, m); r.torso.y = clamp(r.torso.y, -m, m); r.torso.z = clamp(r.torso.z, -m, m);
  r.tilt.x = clamp(r.tilt.x, -cfg.reactionMaxTilt, cfg.reactionMaxTilt);
}

/**
 * headBox = head rest + torso offset + head offset (the head rides on the
 * torso, as in v1). bodyBox = hips→shoulders capsule + torso offset. Both
 * sit down by `crouch` (punch dip; the rig's hips, chest and head are drawn
 * on these boxes, so the knees bend with it). A slip (slip.ts) is a bend at
 * the waist: the head sphere moves sideways by the full offset, the shoulder
 * end of the capsule by slipShoulderFrac of it, the hips not at all — so a
 * slipped straight can still catch the body if the slip went the wrong way.
 */
export function computeBoxes(f: FighterState, cfg: Config): void {
  const fr = frameOf(f.yaw);
  const b = f.body, r = f.reaction, c = f.crouch;
  const slipLat = slipLateral(f);
  // The weight transfer moves the BODY, not just the drawing (2026-09-16):
  // head and shoulders go forward by lean.fwd × punchLeanShift (back through
  // the load), the hips by half. So a punch reaches further and the head is
  // out over the front knee where a counter can find it; the rig draws on
  // these boxes, so hit geometry stays drawn geometry.
  const shift = f.lean.fwd * cfg.punchLeanShift;
  // Slip: a lateral slip dips the head as it goes (slipDip); a pull (dir 2)
  // takes the head straight back. Both bend at the waist: shoulders by
  // slipShoulderFrac of the head's move, hips not at all.
  const back = slipBack(f);
  const dip = f.slip.dir !== 0 && f.slip.dir !== 2 ? cfg.slipDip * slipShape(f, cfg) : 0;
  const head = localToWorld(f.pos, fr, shift - back, b.headY - c - dip, slipLat);
  f.headBox.x = head.x + r.torso.x + r.head.x;
  f.headBox.y = head.y + r.torso.y + r.head.y;
  f.headBox.z = head.z + r.torso.z + r.head.z;
  f.headBox.r = b.headR;
  const hip = localToWorld(f.pos, fr, shift * 0.5, b.hipY - c, 0);
  const sh = localToWorld(f.pos, fr, shift - back * cfg.slipShoulderFrac, b.shoulderY - c, slipLat * cfg.slipShoulderFrac);
  f.bodyBox.a.x = hip.x + r.torso.x; f.bodyBox.a.y = hip.y + r.torso.y; f.bodyBox.a.z = hip.z + r.torso.z;
  f.bodyBox.b.x = sh.x + r.torso.x; f.bodyBox.b.y = sh.y + r.torso.y; f.bodyBox.b.z = sh.z + r.torso.z;
  f.bodyBox.r = b.bodyR;
}

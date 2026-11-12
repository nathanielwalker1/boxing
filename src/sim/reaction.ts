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
import { neckMult, reactionSnap, setNeckMult, setReactionSnap } from './state';
import { slipBack, slipHeadDip, slipLateral, slipShape } from './slip';
import { stanceDrop } from './footing';

/**
 * Kick the defender's springs. `dir` is the unit impulse direction, `mag` in
 * N·s. The spin (2026-09-16): the sideways part of the impulse, in the
 * defender's frame, becomes a yaw whip of the head and shoulders — a hook
 * turns the head round, a straight barely does.
 */
export function applyReaction(f: FighterState, type: PunchType, dir: Vec3, mag: number, cfg: Config, opt: { scale?: number; neck?: number; vary?: number; vary2?: number } = {}): void {
  const def = PUNCHES[type];
  if (!def) return;
  // Polish phase: `scale` = the grade's own size on top of the impulse (glancing less, flush more); `neck` = how much
  // further than the clamp the head may go for this hit; `vary` / `vary2` = the seeded variation (± a few %): one
  // trades the head's snap back against its lift and whip, the other the shoulders' turn — so two identical punches
  // do not move him identically.
  const sc = opt.scale ?? 1, va = opt.vary ?? 0, vb = opt.vary2 ?? 0;
  const s0 = def.react(cfg);
  const s = { ...s0, back: s0.back * (1 + va), lift: s0.lift * (1 - va), spin: s0.spin * (1 - va), twist: s0.twist * (1 + vb), torso: s0.torso * (1 - vb * 0.5) };
  setNeckMult(f, opt.neck ?? 1);
  mag *= sc;
  const v = mag * cfg.reactionForceScale;
  const r = f.reaction;
  const fr = frameOf(f.yaw);
  // Sideways component of the impulse in the defender's frame (+ = toward their right) → yaw the other way.
  const side = dir.x * fr.right.x + dir.z * fr.right.z;
  const dv = {
    head: { x: dir.x * s.back * v, y: s.lift * v, z: dir.z * s.back * v },
    torso: { x: dir.x * s.back * s.torso * v, y: s.lift * s.torso * v, z: dir.z * s.back * s.torso * v },
    tilt: s.twist * mag * cfg.reactionTwistScale,
    spin: -side * s.spin * mag * cfg.reactionSpinScale,
    sink: mag * cfg.reactionSinkScale,
  };
  // The pose below pre-integrates the first reactionImpactPose seconds of
  // the kick, so the velocity that follows is what remains of a swing that
  // peaks in about POSE_PEAK_T — otherwise the pose stacks on the full swing
  // and every punch pins the neck clamp.
  const remain = Math.max(0.3, 1 - cfg.reactionImpactPose / POSE_PEAK_T);
  r.head.vx += dv.head.x * remain; r.head.vy += dv.head.y * remain; r.head.vz += dv.head.z * remain;
  r.torso.vx += dv.torso.x; r.torso.vy += dv.torso.y; r.torso.vz += dv.torso.z;
  r.tilt.v += dv.tilt;
  r.spin.v += dv.spin;
  r.sink.v += dv.sink;
  // The impact pose (2026-09-19): hit-stop freezes the sim right after the
  // land, and a spring that has only velocity shows nothing frozen — the
  // head then jumped 17 cm in one tick when time resumed ("laggy, a few
  // frames"). The first reactionImpactPose seconds of the kick are applied
  // as displacement at once, so the frozen frames are the impact.
  // The neck snap is the impact; the torso's share is smaller so the fist,
  // which follows the head only as far as its own reach, stays on the face.
  const p = cfg.reactionImpactPose, pt = cfg.reactionImpactPoseTorso;
  r.head.x += dv.head.x * p; r.head.y += dv.head.y * p; r.head.z += dv.head.z * p;
  r.torso.x += dv.torso.x * pt; r.torso.y += dv.torso.y * pt; r.torso.z += dv.torso.z * pt;
  r.tilt.x += dv.tilt * pt;   // the turn of the shoulders is the torso's: the smaller share (a 26° instant whip swung the arms through the other's)
  r.spin.x += dv.spin * pt;
  r.sink.x += dv.sink * p;
  clampReaction(r, cfg, neckMult(f));
  setReactionSnap(f, s.snap);
}

/** About when the head's swing peaks after a kick, s — shape, for the impact-pose bookkeeping only. */
const POSE_PEAK_T = 0.1;

function clampReaction(r: FighterState['reaction'], cfg: Config, neck = 1): void {
  // The head offset rides on top of the torso offset (see computeBoxes), so
  // its clamp is the neck: how far the head may leave the shoulders.
  const m = cfg.reactionMaxOffset, n = cfg.reactionMaxNeck * neck;
  r.head.x = clamp(r.head.x, -n, n); r.head.y = clamp(r.head.y, -n, n); r.head.z = clamp(r.head.z, -n, n);
  r.torso.x = clamp(r.torso.x, -m, m); r.torso.y = clamp(r.torso.y, -m, m); r.torso.z = clamp(r.torso.z, -m, m);
  r.tilt.x = clamp(r.tilt.x, -cfg.reactionMaxTilt, cfg.reactionMaxTilt);
  r.spin.x = clamp(r.spin.x, -cfg.reactionMaxSpin, cfg.reactionMaxSpin);
  r.sink.x = clamp(r.sink.x, -cfg.reactionSinkMax * 0.3, cfg.reactionSinkMax);   // the legs give down; a little spring back up
}

export function stepReaction(f: FighterState, cfg: Config, dt: number): void {
  const snap = reactionSnap(f);
  const r = f.reaction;
  stepSpring3(r.head, 0, 0, 0, cfg.reactionHeadK * snap, cfg.reactionHeadC, dt);
  stepSpring3(r.torso, 0, 0, 0, cfg.reactionTorsoK * snap, cfg.reactionTorsoC, dt);
  stepSpring1(r.tilt, 0, cfg.reactionTiltK * snap, cfg.reactionTiltC, dt);
  stepSpring1(r.spin, 0, cfg.reactionSpinK * snap, cfg.reactionSpinC, dt);
  stepSpring1(r.sink, 0, cfg.reactionSinkK, cfg.reactionSinkC, dt);
  clampReaction(r, cfg, neckMult(f));
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
  const b = f.body, r = f.reaction;
  const slipLat = slipLateral(f);
  // The body sits down through a punch's dip, a hit (the legs give, `sink`)
  // and a lateral slip (slipCrouch — the whole body goes under the punch,
  // not just the head; 2026-09-19). The hips carry it, so the knees bend.
  // Overhaul: the held level, the inside posture and the buckle are in stanceDrop — real height.
  const c = stanceDrop(f, cfg) + r.sink.x + (f.slip.dir === -1 || f.slip.dir === 1 ? cfg.slipCrouch * slipShape(f, cfg) : 0);
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
  const dip = slipHeadDip(f, cfg);   // a slip's dip, or the roll's U
  const head = localToWorld(f.pos, fr, shift - back, b.headY - c - dip, slipLat);
  f.headBox.x = head.x + r.torso.x + r.head.x;
  f.headBox.y = head.y + r.torso.y + r.head.y;
  f.headBox.z = head.z + r.torso.z + r.head.z;
  f.headBox.r = b.headR;
  const hip = localToWorld(f.pos, fr, shift * 0.5, b.hipY - c, 0);
  const sh = localToWorld(f.pos, fr, shift - back * cfg.slipShoulderFrac, b.shoulderY - c, slipLat * cfg.slipShoulderFrac);
  // A hit moves the shoulders by the whole torso offset and the hips by
  // reactionHipFollow of it, so the body BENDS back from the waist (the rig
  // draws the chest along the capsule) instead of sliding as a post.
  const hf = cfg.reactionHipFollow;
  f.bodyBox.a.x = hip.x + r.torso.x * hf; f.bodyBox.a.y = hip.y + r.torso.y * hf; f.bodyBox.a.z = hip.z + r.torso.z * hf;
  f.bodyBox.b.x = sh.x + r.torso.x; f.bodyBox.b.y = sh.y + r.torso.y; f.bodyBox.b.z = sh.z + r.torso.z;
  f.bodyBox.r = b.bodyR;
}

/**
 * The body capsule a FIST is tested against (phase 3, heights). bodyBox has
 * one radius, hips to shoulders; on a thick man (bodyR 23 cm at 112 kg) its
 * top stood 15 cm above his chin and further forward than his face, so every
 * cross, hook and uppercut thrown at his head stopped on air above his chest
 * and scored to the body. A thick torso carries its bulk at the belly: for
 * fists, the top end comes down the capsule's own axis until, at the height
 * of the chin, the capsule is no wider than bodyBoxChinSection × the head's
 * radius — the jaw is not behind the chest. A body inside that (red 0.77,
 * blue 0.61) gets bodyBox itself. Body-to-body separation and the rig keep
 * bodyBox.
 */
export function hitBody(f: FighterState, cfg: Config): FighterState['bodyBox'] {
  const b = f.body, box = f.bodyBox;
  const half = cfg.bodyBoxChinSection * b.headR;
  const need = b.bodyR > half ? Math.sqrt(b.bodyR * b.bodyR - half * half) : 0;   // how far under the chin the top end must be
  const over = need - (b.headY - b.headR - b.shoulderY);
  if (!(over > 0)) return box;
  const ax = box.b.x - box.a.x, ay = box.b.y - box.a.y, az = box.b.z - box.a.z;
  const len = Math.hypot(ax, ay, az);
  if (len < 1e-6) return box;
  const t = 1 - clamp(over / len, 0, 0.6);
  return { a: box.a, b: { x: box.a.x + ax * t, y: box.a.y + ay * t, z: box.a.z + az * t }, r: box.r };
}

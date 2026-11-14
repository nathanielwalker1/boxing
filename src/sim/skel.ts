/**
 * sim/skel.ts — the sim's half of the rigid skeleton (anim Phase 1.1, cfg.skelOn; DESIGN.md §2.2).
 *
 * The legacy point maths (reaction.ts computeBoxes, core/arms.ts solveArm, the glove springs) still runs and
 * produces TARGETS; these two calls fit the skeleton to them and rewrite the hit shapes FROM the skeleton, so
 * hit geometry = the skeleton exactly:
 *   fitSimTorso (end of computeBoxes): pelvis on bodyBox.a, the spine carrying the chest toward bodyBox.b at fixed
 *     length, the neck swinging the head toward headBox about the neck base; legs to stance feet. Then headBox,
 *     bodyBox.a and bodyBox.b are rewritten from the FK.
 *   fitSimArm (stepArms): clavicle toward the chest-frame shoulder carried `reach` forward, two-bone IK to the
 *     glove with solveArm's elbow as the pole (its pole logic and torso clearance, unchanged). arms[i] and the
 *     glove are rewritten from the FK: a glove beyond reach is pulled in and loses its outward velocity, so the
 *     glove spring does not fight the clamp.
 * Nothing here runs with skelOn off: the sim is then bit-identical to before.
 */
import type { ArmJoints, ArmPose, Config, FighterState, Vec3 } from '../core';
import {
  closestOnSegment, smoothstep, twoBoneMid, GUARDS,
  clavicleTarget, fitArm, fitLeg, fitTorso, fk, frameOf, handLateralSign, localToWorld, qAxisAngle, qMul, qRot, restPose, rootQuat,
  skelDef, skelLimits, torsoShapes, SKJ, clampPose,
  applyKeyedTorso, keyedClavicleTarget, keyedPose, poseScale, swivelPole, type KeyedInput, type RPose,
} from '../core';
import { PUNCHES, whiffPhases } from './punches';
import { VARIANTS } from './variants';
import { pressDist } from './state';

/** Pelvis yaw (relative to the root) for a torso twist: skelHipTwistShare of it, more if the spine would pass its rotation limits. */
export function pelvisYawFor(twist: number, cfg: Config): number {
  const cap = (cfg.skelLumbarRot + cfg.skelSpineRot + cfg.skelChestRot) * (Math.PI / 180) * 0.95;
  let py = twist * cfg.skelHipTwistShare;
  if (twist - py > cap) py = twist - cap;
  else if (twist - py < -cap) py = twist + cap;
  return py;
}

/** Punches as key poses (Phase 1.4): on with the skeleton. */
export const keyedOn = (cfg: Config): boolean => cfg.skelOn && cfg.punchKeysOn;
/**
 * This fighter keyed this tick: the keys are on and, if he is throwing, that punch's own toggle (punchKeysJab /
 * Cross / Hook / Uppercut) is on. A punch whose keys are off runs the whole fighter on the legacy motion for its flight.
 */
export function keyedFor(f: FighterState, cfg: Config): boolean {
  if (!keyedOn(cfg)) return false;
  const t = f.punch.type;
  return t === null || (t === 'jab' ? cfg.punchKeysJab : t === 'cross' ? cfg.punchKeysCross : t === 'hook' ? cfg.punchKeysHook : cfg.punchKeysUppercut);
}

/** This fighter's keyed pose for this tick (core/poses.ts), from the punch clock as it stands. */
export function simKeyedPose(f: FighterState, cfg: Config): RPose {
  const p = f.punch;
  const shape = cfg.stylesOn ? f.guardShape : 'high';
  let punch: KeyedInput['punch'] = null;
  if (p.type !== null) {
    const ph = whiffPhases(f, PUNCHES[p.type].phases(cfg));
    // Range absorption: inside, a punch has no room for the full drive (a cross at 0.55 m drove the rear shoulder up to
    // his face and the arm folded onto its stop, spinning — measured). Straights give up more of it than hooks / uppercuts.
    const straight = p.type === 'jab' || p.type === 'cross';
    const room = Math.max(0, Math.min(1, (pressDist(f) - cfg.poseRangeNear) / Math.max(1e-3, cfg.poseRangeFar - cfg.poseRangeNear)));
    const lo = straight ? cfg.poseRangeStraightMin : cfg.poseRangeCurvedMin;
    punch = { type: p.type, hand: p.hand, elapsed: p.progress * ph.total, clock: { cock: ph.cock, extend: ph.extend, recover: ph.recover, hold: ph.hold, total: ph.total }, bodyLevel: !!VARIANTS[p.variant]?.body, drive: lo + (1 - lo) * room };
  }
  return keyedPose({ cfg, body: f.body, stance: f.stance, shape, block: f.block, punch });
}

/**
 * The aim point of a keyed punch: the other man's STANDING chin (or his body lane), on his centre — never where his
 * head is now, so a slip or a duck still takes it away (the legacy aim rule, gloves.ts).
 */
export function aimPoint(f: FighterState, other: FighterState, cfg: Config): Vec3 {
  const shape = cfg.stylesOn ? other.guardShape : 'high';
  const body = f.punch.type !== null && !!VARIANTS[f.punch.variant]?.body;
  // (The head CENTRE: aimed at the legacy chin point the endpoint sat inside his body capsule under the chin and was cut
  // back out of his chest, 13 cm short of the face — measured. A key's hAU moves it.)
  // (Revised: the CHIN line — the legacy lane, punchAimChin under the head centre — is the aim; a key's hAU puts an
  //  uppercut under it and a hook at the jaw. His STANDING height: a duck still takes the head away — level_test.)
  const y = body ? (other.body.shoulderY + other.body.hipY) / 2 : other.body.headY - cfg.punchAimChin;
  // (+ his guard key's knee bend: he STANDS that much lower with the keys on.)
  const guardDrop = keyedFor(other, cfg) ? ((cfg as unknown as Record<string, number>).pose_guard_pelUp ?? 0) * poseScale(other.body) : 0;
  // The two punches that answer a low head (variants.ts aimAtPress) come down / up to where it was at the press —
  // the overhand and the uppercut; straights and hooks keep their lane (that is what ducking is for).
  const v = f.punch.type !== null ? VARIANTS[f.punch.variant] : undefined;
  const pressDrop = v && !v.body && (v.arc(cfg) > 0 || v.base === 'uppercut') ? f.punch.aim : 0;
  // punchAimTrack (as the legacy lane): the aim height is mine + track × (his − mine); 0 = thrown at my own height.
  const his = y - GUARDS[shape].crouch + guardDrop;
  const mine = (body ? (f.body.shoulderY + f.body.hipY) / 2 : f.body.headY - cfg.punchAimChin) - GUARDS[cfg.stylesOn ? f.guardShape : 'high'].crouch + guardDrop;
  return { x: other.pos.x, y: mine + (his - mine) * cfg.punchAimTrack - pressDrop, z: other.pos.z };
}

/**
 * How far his lane sits above mine (m, standing, guards' crouch included): the whole keyed punch plane — its
 * chest-frame part too — is lifted by this, so a short man's hook tilts up to a tall man's jaw instead of landing
 * on his chest (heights_test).
 */
export function laneLift(f: FighterState, other: FighterState, cfg: Config): number {
  const body = f.punch.type !== null && !!VARIANTS[f.punch.variant]?.body;
  const lane = (x: FighterState): number => (body ? (x.body.shoulderY + x.body.hipY) / 2 : x.body.headY) - GUARDS[cfg.stylesOn ? x.guardShape : 'high'].crouch;
  return lane(other) - lane(f);
}

/** Per fighter object, this tick: keyed head minus the reactive head target (m). Derived, rebuilt every computeBoxes. */
const HEAD_SHIFT = new WeakMap<FighterState, Vec3>();
const ZERO3: Vec3 = { x: 0, y: 0, z: 0 };
export const keyHeadShift = (f: FighterState): Vec3 => HEAD_SHIFT.get(f) ?? ZERO3;

export function fitSimTorso(f: FighterState, cfg: Config): void {
  const def = skelDef(f.body, f.stance, cfg), lim = skelLimits(cfg);
  if (!f.skel) f.skel = restPose(def, f.pos.x, f.pos.z, f.yaw);
  const pose = f.skel;
  const R0 = rootQuat(f.yaw);
  const keyed = keyedFor(f, cfg);
  // Keyed: the base is the reactive body only (computeBoxes left the punch's lean and dip out); the punch is the key layer.
  const tw = keyed ? 0 : f.torsoTwist;
  const rp = keyed ? simKeyedPose(f, cfg) : null;
  // Keyed, the key's pelvis turn goes INTO the fit, so the reactive head / chest targets (a slip, a pull) are still
  // reached: turned after the fit, the 35° guard blade swung a slip's sideways lean 18% forward (measured). The spine
  // twist stays in the key layer (shared by rotation range; the fit's shares put the lumbar on its stop) and the head
  // starts facing the pelvis, as it did when the whole fit was turned.
  const py = rp ? rp.pelYaw : pelvisYawFor(tw, cfg);
  fitTorso(def, lim, cfg, pose, {
    rootX: f.pos.x, rootZ: f.pos.z, yaw: f.yaw,
    pelvis: f.bodyBox.a, pelvisRot: qMul(R0, qAxisAngle(0, 1, 0, py)),
    chest: f.bodyBox.b, chestRot: null, chestTwist: rp ? 0 : tw - py,
    // The head turns with rigHeadFollow of the shoulders' turn (the eyes stay on the man), as the rig drew it.
    head: f.headBox, headRot: qMul(R0, qAxisAngle(0, 1, 0, rp ? py : tw * cfg.rigHeadFollow)),
  });
  // The key layer: pelvis travel and tilt, spine, head over the turned base; feet published for the rig's planter.
  if (rp) applyKeyedTorso(def, pose, rp, cfg, f.stance, true);
  // Legs: the sim has no feet yet (Phase 2.3); the skeleton's stand at the rig's stance spots so the pose is whole
  // (keyed: plus the key's step, the pivot on the ball of the foot and the heel lift).
  const fr = frameOf(f.yaw), lead = handLateralSign('lead', f.stance);
  const fk2: number[] = [];
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? lead : -lead;
    const ft = rp ? rp.foot[i]! : { stepF: 0, stepL: 0, pivot: 0, heel: 0 };
    const ankle = localToWorld(f.pos, fr, (i === 0 ? cfg.rigStanceFwd : -cfg.rigStanceBack) + ft.stepF, f.body.bootH + ft.heel, s * (cfg.rigStanceLat + ft.stepL));
    // Keyed, the feet stand as the rig plants them (lead toes in rigLeadFootYawDeg, rear out rigRearFootYawDeg): with the
    // pelvis bladed by the guard key, feet pointing straight ahead held the lead hip on its rotation stop (measured).
    const stanceYaw = rp ? lead * (i === 0 ? cfg.rigLeadFootYawDeg : cfg.rigRearFootYawDeg) * Math.PI / 180 : 0;
    const yawF = stanceYaw + ft.pivot;
    // Keyed, the knee points part of the way from its foot toward the pelvis's facing (poseKneeFollow).
    const kneeYaw = rp ? yawF + (rp.pelYaw - yawF) * cfg.poseKneeFollow : yawF;
    const fwd = qRot(qAxisAngle(0, 1, 0, kneeYaw), { x: fr.fwd.x, y: 0, z: fr.fwd.z });
    const pole: Vec3 = { x: fwd.x + fr.right.x * s * cfg.rigKneePoleOut, y: 0, z: fwd.z + fr.right.z * s * cfg.rigKneePoleOut };
    const footLen = f.body.bootH * cfg.rigFootLen;
    const footRot = qMul(R0, qMul(qAxisAngle(0, 1, 0, yawF), qAxisAngle(0, 0, 1, -Math.asin(Math.min(1, ft.heel / Math.max(1e-3, footLen * 0.72))))));
    fitLeg(def, lim, cfg, pose, i, ankle, pole, footRot);
    fk2.push(ft.stepF, ft.stepL, ft.pivot, ft.heel);
  }
  if (rp) { clampPose(def, pose, lim); f.footKey = [...fk2, rp.weight]; }
  else if (f.footKey) delete f.footKey;
  const t = torsoShapes(def, pose);
  // Keyed: how far the key layer carried the head off its reactive target (the guard hands ride it: gloves.ts).
  if (rp) HEAD_SHIFT.set(f, { x: t.head.x - f.headBox.x, y: t.head.y - f.headBox.y, z: t.head.z - f.headBox.z });
  else HEAD_SHIFT.delete(f);
  f.headBox.x = t.head.x; f.headBox.y = t.head.y; f.headBox.z = t.head.z;
  f.bodyBox.a.x = t.hips.x; f.bodyBox.a.y = t.hips.y; f.bodyBox.a.z = t.hips.z;
  f.bodyBox.b.x = t.shoulders.x; f.bodyBox.b.y = t.shoulders.y; f.bodyBox.b.z = t.shoulders.z;
}

/** What the last arm fit did, per side and arm (scripts/skel_probe.mjs reads it; output only, never read by the sim). */
export const skelProbe: { arm: Record<string, { glove: Vec3; hand: Vec3; clear: number; oldSwitch: boolean; clearDist: number; clearAt: number }> } = { arm: {} };

/**
 * The elbow pole, continuous (anim Phase 1.1b). core/arms.ts solveArm SNAPS to a second pole ("elbow out, hanging")
 * the tick the first pole's elbow comes within the torso clearance — a discontinuity the elbow jumps across. Here the
 * same two poles (the same config keys) are BLENDED by how far inside the clearance the first pole's elbow would sit,
 * over ± skelClearBlend, and both are turned with the torso twist: solveArm builds them in the fighter's FLOOR frame,
 * and on a skeleton the elbow's "out" belongs to the chest (a lead hook's chest turns 66°: the unturned pole put the
 * elbow 33° behind the shoulders, past the shoulder's range).
 */
function armPole(f: FighterState, cfg: Config, i: number, shoulder: Vec3, glove: Vec3, ap: ArmPose): { pole: Vec3; w: number; d: number; clearance: number } {
  const fr = frameOf(f.yaw);
  const side = handLateralSign(i === 0 ? 'lead' : 'rear', f.stance);
  // The flare (Phase 1.1b): core/arms.ts flares the elbow as the glove rises above the SHOULDER — but a guard holds the
  // gloves at the face, 15–25 cm above the shoulder line, so the idle guard flared its elbows up and out (the chicken
  // wing in every strip). Here the glove's height counts only above skelGuardFlareFree over the shoulder, continuously;
  // a hook's level and an uppercut's back still drive the elbow as before.
  const lift = (glove.y - shoulder.y - cfg.skelGuardFlareFree) / Math.max(1e-3, f.body.upperArm);
  const flare = Math.max(ap.level, Math.min(ap.flare, Math.max(0, Math.min(1, lift))));
  const poleFwd = -cfg.rigElbowPoleBack + (-cfg.rigUppercutElbowBack + cfg.rigElbowPoleBack) * ap.back;
  const poleOut = side * cfg.rigElbowPoleOut * (0.6 + flare * 0.6 + ap.level * 0.8);
  const poleDown = -cfg.rigElbowPoleDown * (1 - flare * 0.8) * (1 - ap.level);
  const tw = qAxisAngle(0, 1, 0, f.torsoTwist * cfg.skelPoleTwist);
  const p1 = qRot(tw, { x: fr.fwd.x * poleFwd + fr.right.x * poleOut, y: poleDown, z: fr.fwd.z * poleFwd + fr.right.z * poleOut });
  const p2 = qRot(tw, { x: fr.right.x * side, y: -cfg.rigElbowPoleDown, z: fr.right.z * side });
  const e1 = twoBoneMid(shoulder, glove, f.body.upperArm, f.body.forearm, p1, 1);
  const c = closestOnSegment(f.bodyBox.a, f.bodyBox.b, e1);
  const d = Math.hypot(e1.x - c.x, e1.y - c.y, e1.z - c.z);
  const clearance = f.body.bodyR * (1 + cfg.rigForearmR) * cfg.rigElbowClearance;
  const band = Math.max(1e-4, cfg.skelClearBlend);
  const w = smoothstep((clearance + band - d) / (2 * band));
  const n1 = Math.hypot(p1.x, p1.y, p1.z) || 1, n2 = Math.hypot(p2.x, p2.y, p2.z) || 1;
  return { pole: { x: p1.x / n1 * (1 - w) + p2.x / n2 * w, y: p1.y / n1 * (1 - w) + p2.y / n2 * w, z: p1.z / n1 * (1 - w) + p2.z / n2 * w }, w, d, clearance };
}

/** Fit arm i to its glove; `hint` is solveArm's joints (probe only), `reach` the shoulder's forward roll (m), `ap` the elbow pole lags. */
export function fitSimArm(f: FighterState, cfg: Config, i: number, hint: ArmJoints, reach: number, ap: ArmPose): void {
  const pose = f.skel!;
  const def = skelDef(f.body, f.stance, cfg), lim = skelLimits(cfg);
  const fc = fk(def, pose, SKJ.chest + 1);
  const g = f.gloves[i]!;
  let clavT = clavicleTarget(def, fc, i, reach, 0);
  let P = armPole(f, cfg, i, clavT, g.pos, ap);
  let roll = 0;
  if (keyedFor(f, cfg)) {
    // Keyed (Phase 1.4): the clavicle takes the key's protraction and elevation, the elbow its swivel about the
    // shoulder→hand axis (it replaces the legacy pole terms), the forearm its pronation.
    const rp = simKeyedPose(f, cfg), side = handLateralSign(i === 0 ? 'lead' : 'rear', f.stance);
    clavT = keyedClavicleTarget(def, fc, i, rp.clPro[i]!, rp.clElev[i]!);
    P = { ...P, pole: swivelPole(clavT, g.pos, rp.hand[i]!.swivel, side, fc.r[SKJ.chest]!, f.body.upperArm + f.body.forearm), w: 0 };
    roll = side * rp.hand[i]!.pron;
  }
  const r = fitArm(def, lim, cfg, pose, i, clavT, g.pos, P.pole, roll);
  f.arms[i] = { shoulder: r.shoulder, elbow: r.elbow };
  skelProbe.arm[`${f.specId}:${i}`] = { glove: { ...g.pos }, hand: { ...r.hand }, clear: P.w, oldSwitch: P.d < P.clearance, clearDist: P.d, clearAt: P.clearance };
  void hint;
  // The glove is the hand. If the fit moved it (out of reach, or a limit), the velocity that carried it there goes.
  const dx = g.pos.x - r.hand.x, dy = g.pos.y - r.hand.y, dz = g.pos.z - r.hand.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > 1e-9) {
    const vn = (g.vel.x * dx + g.vel.y * dy + g.vel.z * dz) / d;
    if (vn > 0) { g.vel.x -= dx / d * vn; g.vel.y -= dy / d * vn; g.vel.z -= dz / d * vn; }
  }
  g.pos.x = r.hand.x; g.pos.y = r.hand.y; g.pos.z = r.hand.z;
}

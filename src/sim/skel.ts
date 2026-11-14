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
  poseQ, setPoseQ, qFromRotVec, qFromBasis, qSlerp, skelArm, skelLeg, cloneSkel, lerpPose, SIM_DT, type SkelFK, type SkelPose, type Quat,
} from '../core';
import { chainAngles, chainOn } from './reaction';
import { PUNCHES, whiffPhases } from './punches';
import { VARIANTS } from './variants';
import { pressDist, fallInfo, getUpAt } from './state';

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
  // hitChainV2: the hit reaction, additive in joint space on top of the fitted pose, then clamped (before the legs, so
  // a pelvis turn is re-planted by the leg IK: the feet stay where they stood).
  if (chainOn(cfg)) applyHitChain(f, cfg, def, pose, lim);
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
  // knockdownV2: the fall is posed over the standing fit (the hit shapes above stay as they were: a downed man cannot be hit).
  if (fallActive(f, cfg)) fitDown(f, cfg, def, lim, cloneSkel(pose));
}

/** How far through his get-up (0 lying … 1 on his feet) from the sim's own count timing (resources.ts getUpPhaseAt's phases); 0 for a man who will not beat the count. */
export function getUpProgress(f: FighterState, cfg: Config): number {
  const at = getUpAt(f), t = f.downT;
  if (at < 0 || !cfg.getUpOn) return 0;
  const stirAt = at * cfg.getUpStirFrac, kneeAt = at * cfg.getUpKneeFrac, riseAt = Math.max(kneeAt, at - cfg.getUpRiseSeconds);
  const slumpAt = kneeAt + (riseAt - kneeAt) * 0.3, slumpEnd = slumpAt + cfg.getUpSlumpSeconds;   // (resources.ts SLUMP_AT)
  const seg = (a: number, b: number, p0: number, p1: number): number => p0 + (p1 - p0) * clamp01((t - a) / Math.max(1e-6, b - a));
  const kn = cfg.kdKneeAt, ri = cfg.kdRiseAt;
  let p: number;
  if (t < stirAt) p = 0;
  else if (t < kneeAt) p = seg(stirAt, kneeAt, 0, kn);
  else if (f.getUp.owed && slumpEnd <= riseAt) {
    p = t < slumpAt ? seg(kneeAt, slumpAt, kn, ri) : t < slumpEnd ? seg(slumpAt, slumpEnd, ri, 0.1) : t < riseAt ? seg(slumpEnd, riseAt, 0.1, ri) : seg(riseAt, at, ri, 1);
  } else p = t < riseAt ? seg(kneeAt, riseAt, kn, ri) : seg(riseAt, at, ri, 1);
  // The fall must have landed first (a short count has stirred before he is down).
  const landed = (cfg.kdDelay + cfg.kdFall + cfg.kdSettle) * SIM_DT;
  return p * smoothstep(clamp01((t - landed) / 0.2));
}

/** The skeleton while he is down: the fall, then (if he will rise) the get-up as key poses blended by getUpProgress, ending in the standing fit. */
function fitDown(f: FighterState, cfg: Config, def: ReturnType<typeof skelDef>, lim: ReturnType<typeof skelLimits>, stand: SkelPose): void {
  fitDownRaw(f, cfg, def, lim, stand);
  // The arms are the one part that carries over from tick to tick (`stand` holds last tick's): turned no more than kdArmRate
  // degrees a tick toward the key, so a two-bone IK flip (the elbow's side) can never show as a snap.
  ARM_PREV.set(f, stand);
  for (let i = 0; i < 2; i++) limitArm(f.skel!, stand, i, cfg.kdArmRate * DEG2);
  clampPose(def, f.skel!, lim);
}

function fitDownRaw(f: FighterState, cfg: Config, def: ReturnType<typeof skelDef>, lim: ReturnType<typeof skelLimits>, stand: SkelPose): void {
  const pose = f.skel!, tk = f.downT / SIM_DT;
  fitFall(f, cfg, def, lim, pose, tk);
  const P = getUpProgress(f, cfg);
  if (P <= 0) return;
  const kind = fallInfo(f).kind, body = f.body;
  const lying = cloneSkel(pose);
  fitFall(f, cfg, def, lim, lying, 1e6);   // the lying pose he fell into (the fall's last frame)
  const fr = frameOf(f.yaw), fwd = v3(fr.fwd.x, 0, fr.fwd.z), right = v3(fr.right.x, 0, fr.right.z);
  const info = fallInfo(f), push = v3(info.px, 0, info.pz);
  const lead = handLateralSign('lead', f.stance);
  const heavy = f.downKind === 'heavy';
  const kn = cfg.kdKneeAt, ri = cfg.kdRiseAt;
  const env = heavy ? Math.sin(Math.PI * clamp01((P - kn) / (1 - kn))) : 0;
  const sway = v3(right.x * cfg.kdSway * env * Math.sin(tk * 0.4), 0, right.z * cfg.kdSway * env * Math.sin(tk * 0.4));
  const stance = (i: number): Vec3 => localToWorld(f.pos, fr, i === 0 ? cfg.rigStanceFwd : -cfg.rigStanceBack, body.bootH, (i === 0 ? lead : -lead) * cfg.rigStanceLat);
  const pL = fk(def, lying).p[SKJ.pelvis]!;
  const keyPose = (s: { pel: Vec3; th: number; D: Vec3; a: [Vec3, Vec3]; poles: [Vec3, Vec3]; guard: boolean }): SkelPose => {
    const p = cloneSkel(pose);
    fitSpec(f, cfg, def, lim, p, s, fwd);
    return p;
  };
  const xz = (a: Vec3, b: Vec3, t: number, y: number): Vec3 => v3(mix(a.x, b.x, t), y, mix(a.z, b.z, t));
  const base = v3(f.pos.x, 0, f.pos.z);
  const up = v3(0, 1, 0), down = v3(0, -1, 0);
  const rearBehind = (pel: Vec3, k: number): Vec3 => v3(pel.x - fwd.x * def.shin * k, body.bootH, pel.z - fwd.z * def.shin * k);
  // K: hands and one knee (the rear knee on the canvas, the lead foot flat).
  const pelK = xz(pL, base, 0.85, def.thigh * 0.9 + body.bodyR * 0.6);
  pelK.x += sway.x; pelK.z += sway.z;
  const K = keyPose({ pel: pelK, th: 68 * DEG2, D: fwd, a: [stance(0), rearBehind(pelK, 0.9)], poles: [vAdd(fwd, up, 0.6), vAdd(fwd, down, 1.2)], guard: false });
  // R: up on the lead foot, the rear knee still down, trunk nearly upright, hands coming up; the half step (heavy only).
  const stepK = heavy ? cfg.kdStep * Math.sin(Math.PI * clamp01((P - ri) / (1 - ri))) : 0;
  const pelR = v3(base.x - fwd.x * 0.05 + sway.x, def.hipY * 0.72, base.z - fwd.z * 0.05 + sway.z);
  const aLR = stance(0); aLR.x += fwd.x * stepK; aLR.z += fwd.z * stepK;
  const R = keyPose({ pel: pelR, th: 18 * DEG2, D: fwd, a: [aLR, rearBehind(pelR, 0.85)], poles: [vAdd(fwd, up, 0.6), vAdd(fwd, down, 1.2)], guard: true });
  const knots: [number, SkelPose][] = [[0, lying]];
  const POLES = new Map<SkelPose, [Vec3, Vec3]>();
  const lyingPole = kind === 3 ? vAdd(v3(-push.x, 0, -push.z), up, -0.4) : vAdd(fwd, up, 1.2);
  POLES.set(lying, [lyingPole, lyingPole]);
  POLES.set(K, [vAdd(fwd, up, 0.6), vAdd(fwd, down, 1.2)]);
  POLES.set(R, [vAdd(fwd, up, 0.6), vAdd(fwd, down, 1.2)]);
  if (kind === 1 && cfg.kdElbowAt > 0.05) {
    // E: rolled onto a side, up on an elbow: the trunk half raised toward his right, legs as they lay.
    const side = vNorm(vAdd(vAdd(v3(0, 0, 0), right, 0.8), push, 0.2));
    const pelE = v3(pL.x, body.bodyR * 1.05 + 0.06, pL.z);
    const legs = (i: number): Vec3 => v3(pelE.x - push.x * (def.thigh + def.shin) * 0.95 + right.x * (i === 0 ? lead : -lead) * 0.12, body.bootH, pelE.z - push.z * (def.thigh + def.shin) * 0.95 + right.z * (i === 0 ? lead : -lead) * 0.12);
    const E = keyPose({ pel: pelE, th: 55 * DEG2, D: side, a: [legs(0), legs(1)], poles: [vAdd(fwd, up, 1), vAdd(fwd, up, 1)], guard: false });
    POLES.set(E, [vAdd(fwd, up, 1), vAdd(fwd, up, 1)]);
    knots.push([cfg.kdElbowAt, E]);
  }
  if (kind !== 3 && kn > 0.2) knots.push([kn, K]);
  knots.push([ri, R], [1, R]);
  let k = 1;
  while (k < knots.length - 1 && P > knots[k]![0]) k++;
  const [t0, A] = knots[k - 1]!, [t1, B] = knots[k]!;
  const sk = smoothstep(clamp01((P - t0) / Math.max(1e-6, t1 - t0)));
  const out = lerpPose(A, B, sk);
  // A blend of joint angles does not keep a foot on the canvas or a hand where it was meant: the feet and hands are
  // refitted to the blended ankle / wrist points (the knees and elbows keep their blended side).
  const fA = fk(def, A), fB = fk(def, B), fO = fk(def, out);
  const lp = (a: Vec3, b: Vec3): Vec3 => v3(mix(a.x, b.x, sk), mix(a.y, b.y, sk), mix(a.z, b.z, sk));
  // The knee's side: each key's own (knee off the hip-ankle line, unit; up-and-forward when the leg is straight), blended.
  // (The authored knee poles of the two keys, blended: an IK pole taken from a nearly straight leg flipped the knee in one tick.)
  const kneeSide = (P2: SkelPose, i: number): Vec3 => vNorm(POLES.get(P2)![i]!);
  for (let i = 0; i < 2; i++) {
    const l = skelLeg(i), pa = kneeSide(A, i), pb = kneeSide(B, i);
    fitLeg(def, lim, cfg, out, i, lp(fA.p[l.foot]!, fB.p[l.foot]!), vNorm(v3(mix(pa.x, pb.x, sk), mix(pa.y, pb.y, sk), mix(pa.z, pb.z, sk))), null);
  }
  const fC = fk(def, out, SKJ.chest + 1);
  for (let i = 0; i < 2; i++) {
    const a = skelArm(i), clav = clavicleTarget(def, fC, i, 0, 0), el = lp(fA.p[a.fore]!, fB.p[a.fore]!);
    fitArm(def, lim, cfg, out, i, clav, lp(fA.p[a.hand]!, fB.p[a.hand]!), v3(el.x - clav.x, el.y - clav.y, el.z - clav.z), 0);
  }
  // The last stretch: blended into the standing fit he returns to, so there is no snap when the count lets him up.
  const ws = smoothstep(clamp01((P - 0.75) / 0.25));
  const fin = lerpPose(out, stand, ws);
  // (The arms are last tick's from P 0.75 on, and fitSimArm chases the guard fit from there; before it they follow the key.)
  for (let i = 0; i < 2; i++) { const a = skelArm(i); for (const j of [a.clav, a.upper, a.fore, a.hand]) setPoseQ(fin, j, poseQ(ws > 0 ? stand : out, j)); }
  pose.root = fin.root; pose.q = fin.q;
  clampPose(def, pose, lim);
}

/** One key pose as targets for the standing fit: pelvis, trunk (tilt `th` toward `D`), the two ankles with knee poles, hands on the canvas under the shoulders or up in a guard. */
function fitSpec(f: FighterState, cfg: Config, def: ReturnType<typeof skelDef>, lim: ReturnType<typeof skelLimits>, pose: SkelPose, s: { pel: Vec3; th: number; D: Vec3; a: [Vec3, Vec3]; poles: [Vec3, Vec3]; guard: boolean }, fwd: Vec3): void {
  const body = f.body;
  const axis = (a: number): Vec3 => v3(s.D.x * Math.sin(a), Math.cos(a), s.D.z * Math.sin(a));
  const chest = vAdd(s.pel, axis(s.th), body.shoulderY - body.hipY);
  const head = vAdd(chest, axis(s.th * 1.04), body.headY - body.shoulderY);
  fitTorso(def, lim, cfg, pose, {
    rootX: f.pos.x, rootZ: f.pos.z, yaw: f.yaw,
    pelvis: s.pel, pelvisRot: bodyBasis(axis(s.th * cfg.kdSeatShare), fwd), chest, chestRot: bodyBasis(axis(s.th), fwd), chestTwist: 0,
    head, headRot: bodyBasis(axis(s.th * 1.04), fwd),
  });
  for (let i = 0; i < 2; i++) fitLeg(def, lim, cfg, pose, i, s.a[i]!, s.poles[i]!, null);
  const fc = fk(def, pose, SKJ.chest + 1), cq = fc.r[SKJ.chest]!, cp = fc.p[SKJ.chest]!;
  const Zh = qRot(cq, v3(0, 0, 1)), zl = Math.hypot(Zh.x, Zh.z) || 1;
  for (let i = 0; i < 2; i++) {
    const side = handLateralSign(i === 0 ? 'lead' : 'rear', f.stance);
    let hand: Vec3;
    if (s.guard) hand = vAdd(cp, qRot(cq, v3(0.28, 0.05, side * 0.2)));
    else hand = v3(cp.x + s.D.x * 0.1 + Zh.x / zl * side * (body.shoulderW / 2 + 0.05), body.gloveR, cp.z + s.D.z * 0.1 + Zh.z / zl * side * (body.shoulderW / 2 + 0.05));
    fitArm(def, lim, cfg, pose, i, clavicleTarget(def, fc, i, 0, 0), hand, v3(Zh.x / zl * side, -0.3, Zh.z / zl * side), 0);
  }
  clampPose(def, pose, lim);
}

/** knockdownV2 is posing this fighter: a heavy / flash knockdown, with the skeleton on and a fall chosen at the knockdown. */
export function fallActive(f: FighterState, cfg: Config): boolean {
  return cfg.knockdownV2 && cfg.skelOn && f.down && !!f.skel && (f.downKind === 'heavy' || f.downKind === 'flash') && fallInfo(f).kind > 0;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const vAdd = (a: Vec3, b: Vec3, k = 1): Vec3 => v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const vDot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const vNorm = (a: Vec3): Vec3 => { const l = Math.hypot(a.x, a.y, a.z) || 1; return v3(a.x / l, a.y / l, a.z / l); };
const vCross = (a: Vec3, b: Vec3): Vec3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const DEG2 = Math.PI / 180;

/** World orientation of a body part whose spine axis is `A` and whose chest faces `X` (made perpendicular to A). */
function bodyBasis(A: Vec3, Xh: Vec3): ReturnType<typeof qFromBasis> {
  const Y = vNorm(A), X = vNorm(vAdd(Xh, Y, -vDot(Xh, Y)));
  return qFromBasis(X, Y, vCross(X, Y));
}

/**
 * The authored falls (knockdownV2), as targets for the same legal fit the standing body uses (torso, legs, arms), clamped.
 * Clock in ticks since the knockdown: kdDelay (the legs lock), then kdFall (the pelvis accelerates to the canvas, u²), then
 * kdSettle (a bounce under a centimetre). The trunk tips later than the pelvis drops (seat first), the feet stay planted
 * until the knees have folded, then slide out.
 */
function fitFall(f: FighterState, cfg: Config, def: ReturnType<typeof skelDef>, lim: ReturnType<typeof skelLimits>, pose: SkelPose, tk: number): void {
  const info = fallInfo(f), body = f.body, kind = info.kind;
  const u = clamp01((tk - cfg.kdDelay) / cfg.kdFall);
  const ts = Math.max(0, tk - cfg.kdDelay - cfg.kdFall);
  const fr = frameOf(f.yaw), fwd = v3(fr.fwd.x, 0, fr.fwd.z), UP = v3(0, 1, 0);
  const push = v3(info.px, 0, info.pz), lat = v3(info.lx, 0, info.lz);
  // Fall line D (horizontal, the way the head goes), trunk tilt, and where the pelvis ends.
  let D: Vec3, tilt: number, v0: number, hLie: number;
  if (kind === 1) { D = push; tilt = cfg.kdBackTilt * DEG2; v0 = 0.3; hLie = body.bodyR * 1.05; }
  else if (kind === 2) {
    const b = cfg.kdHookTurn * DEG2;
    D = vNorm(vAdd(vAdd(v3(0, 0, 0), lat, Math.cos(b)), push, Math.sin(b)));
    tilt = cfg.kdSideTilt * DEG2; v0 = 0.3; hLie = body.bodyR * 1.05;
  } else { D = v3(-push.x, 0, -push.z); tilt = cfg.kdFoldTilt * DEG2; v0 = 0.4; hLie = def.thigh + body.bodyR * 0.6; }
  const hs = def.hipY;
  const drop = u * u;
  const bounce = ts > 0 ? cfg.kdBounce * Math.exp(-ts * 3 / cfg.kdSettle) * Math.abs(Math.sin(ts * 1.1)) : 0;
  const stiffen = cfg.kdStiffen * Math.sin(Math.PI * clamp01(tk / Math.max(1, cfg.kdDelay))) * (u > 0 ? 0 : 1);
  const py = mix(hs, hLie, drop) + bounce + stiffen;
  const slide = cfg.kdSlide * drop * (kind === 3 ? 0.5 : 1);
  const pel = v3(f.pos.x + D.x * slide, py, f.pos.z + D.z * slide);
  const v = Math.pow(clamp01((u - v0) / (1 - v0)), 1.5);
  const th = tilt * v, thP = th * cfg.kdSeatShare;
  const axis = (a: number): Vec3 => v3(D.x * Math.sin(a), Math.cos(a), D.z * Math.sin(a));
  const torsoLen = body.shoulderY - body.hipY, neckLen = body.headY - body.shoulderY;
  const chest = vAdd(pel, axis(th), torsoLen);
  const thH = th * 1.04;
  const head = vAdd(chest, axis(thH), neckLen);
  fitTorso(def, lim, cfg, pose, {
    rootX: f.pos.x, rootZ: f.pos.z, yaw: f.yaw,
    pelvis: pel, pelvisRot: bodyBasis(axis(thP), fwd), chest, chestRot: bodyBasis(axis(th), fwd), chestTwist: 0,
    head, headRot: bodyBasis(axis(thH), fwd),
  });
  // Legs: planted at the stance until the knees have folded, then the feet slide out to lie (straight along the fall line behind him, or behind the knees).
  const lead = handLateralSign('lead', f.stance), legLen = (def.thigh + def.shin) * 0.95;
  const wl = smoothstep(clamp01((u - (kind === 3 ? 0.2 : 0.4)) / (kind === 3 ? 0.6 : 0.6)));
  const rest = pose.root;   // (root kept by fitTorso)
  void rest;
  const fk0: SkelFK = fk(def, pose, SKJ.chest + 1);
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? lead : -lead;
    const stand = localToWorld(f.pos, fr, i === 0 ? cfg.rigStanceFwd : -cfg.rigStanceBack, body.bootH, s * cfg.rigStanceLat);
    const lie = kind === 3
      ? v3(pel.x - D.x * def.shin * 0.9 + fr.right.x * s * 0.1, body.bootH, pel.z - D.z * def.shin * 0.9 + fr.right.z * s * 0.1)
      : v3(pel.x - D.x * legLen + fr.right.x * s * 0.12, body.bootH, pel.z - D.z * legLen + fr.right.z * s * 0.12);
    const ankle = v3(mix(stand.x, lie.x, wl), body.bootH, mix(stand.z, lie.z, wl));
    const pole = kind === 3 ? vAdd(D, UP, -0.4) : vAdd(vAdd(fwd, UP, 0.4 + 0.8 * wl), v3(fr.right.x * s, 0, fr.right.z * s), 0.2);
    fitLeg(def, lim, cfg, pose, i, ankle, pole, null);
  }
  // Arms: from the guard, loose — they lie on the canvas out from the shoulders (straight, hook) or reach down to it under the shoulders (folded).
  // (On his side the arms stay up near the body — the lower one has no room to lie out under him.)
  const wa = smoothstep(clamp01((u - (kind === 3 ? 0.35 : 0.2)) / (kind === 3 ? 0.55 : 0.8))) * (kind === 2 ? 0.35 : 1);
  const chestQ = fk0.r[SKJ.chest]!, chestP = fk0.p[SKJ.chest]!;
  const Zh = qRot(chestQ, v3(0, 0, 1)); const zl = Math.hypot(Zh.x, Zh.z) || 1;
  for (let i = 0; i < 2; i++) {
    const side = handLateralSign(i === 0 ? 'lead' : 'rear', f.stance);
    const g0 = vAdd(chestP, qRot(chestQ, v3(0.28, 0.05, side * 0.2)));
    // (The world's sideways, not the chest's: lying on his side the chest's lateral axis points up and its horizontal part flips.)
    const zz = v3(fr.right.x * side, 0, fr.right.z * side);
    const lieH = kind === 3
      ? v3(chestP.x + D.x * 0.1 + zz.x * (body.shoulderW / 2 + 0.05), body.gloveR, chestP.z + D.z * 0.1 + zz.z * (body.shoulderW / 2 + 0.05))
      : v3(chestP.x + zz.x * (body.shoulderW / 2 + body.upperArm * 0.75) - D.x * 0.22, body.gloveR, chestP.z + zz.z * (body.shoulderW / 2 + body.upperArm * 0.75) - D.z * 0.22);
    const hand = v3(mix(g0.x, lieH.x, wa), Math.max(body.gloveR, mix(g0.y, lieH.y, wa)), mix(g0.z, lieH.z, wa));
    const fc = fk(def, pose, SKJ.chest + 1);
    fitArm(def, lim, cfg, pose, i, clavicleTarget(def, fc, i, 0, 0), hand, v3(zz.x, kind === 2 ? 0.8 : -0.3, zz.z), 0);   // (on his side the elbow bends up, not into the canvas)
  }
  clampPose(def, pose, lim);
}

/** Spine group split, lumbar / low thoracic / chest (sums to 1). Shape of the bend, not a tunable. */
const CHAIN_SPINE_SPLIT: readonly [number, number][] = [[SKJ.spine1, 0.25], [SKJ.spine2, 0.35], [SKJ.chest, 0.4]];

/** The hit chain (reaction.ts kickChain / stepChain) posted onto the joints: q ← q · rot(share × group angles), then clampPose. */
function applyHitChain(f: FighterState, cfg: Config, def: ReturnType<typeof skelDef>, pose: NonNullable<FighterState['skel']>, lim: ReturnType<typeof skelLimits>): void {
  const hd = chainAngles(f, 0), sp = chainAngles(f, 1), pv = chainAngles(f, 2);
  if (!hd.some(v => v !== 0) && !sp.some(v => v !== 0) && !pv.some(v => v !== 0)) return;
  const add = (j: number, a: readonly number[], w: number): void => {
    setPoseQ(pose, j, qMul(poseQ(pose, j), qFromRotVec({ x: a[0]! * w, y: a[1]! * w, z: a[2]! * w })));
  };
  add(SKJ.pelvis, pv, 1);
  for (const [j, w] of CHAIN_SPINE_SPLIT) add(j, sp, w);
  add(SKJ.neck, hd, cfg.hitChainNeckShare);
  add(SKJ.head, hd, 1 - cfg.hitChainNeckShare);
  clampPose(def, pose, lim);
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
  // knockdownV2: fitDown (end of fitSimTorso) posed both arms; only in the last stretch of the get-up do they come to the
  // ordinary guard fit below, blended in by the same weight that blends the body into its standing fit (no snap when he is up).
  // (From P > 0.75 on, fitDown leaves the arms as last tick's and this chases the guard fit at kdArmRate a tick.)
  let ref: SkelPose | null = null;
  if (fallActive(f, cfg)) {
    if (getUpProgress(f, cfg) <= 0.75) return;
    ref = ARM_PREV.get(f) ?? null;
    if (!ref) return;
  }
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
  if (ref) limitArm(pose, ref, i, cfg.kdArmRate * DEG2);
}

/** Last tick's skeleton as fitDown found it (derived each tick, like HEAD_SHIFT): the reference the arm rate limit works from. */
const ARM_PREV = new WeakMap<FighterState, SkelPose>();

/** Turn arm i's joints no further than `max` rad from their value in `ref`, toward where they are now. */
function limitArm(pose: SkelPose, ref: SkelPose, i: number, max: number): void {
  const a = skelArm(i);
  for (const j of [a.clav, a.upper, a.fore, a.hand]) {
    const q0 = poseQ(ref, j), q1 = poseQ(pose, j);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w)));
    if (ang > max) setPoseQ(pose, j, qSlerp(q0, q1, max / ang));
  }
}

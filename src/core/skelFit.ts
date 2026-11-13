/**
 * core/skelFit.ts — point and orientation targets → a LEGAL SkelPose (anim Phase 1.1, DESIGN.md §2.3 stage A).
 * Pure and deterministic (fixed iteration counts, no clocks, no randomness); the sim (sim/skel.ts) and the rig
 * (rig/index.ts) both call it, so what the sim tests against and what is drawn come from one solver.
 *
 * The legacy motion still produces points (hips, shoulder line, head, gloves, feet) and a few rotations; these are
 * TARGETS here. Each fit honours bone lengths exactly and ends in clampJoint, so no target can stretch the body or
 * push a joint past its range — a target that asks for the impossible is simply not met (the hit shapes are then
 * rewritten from where the skeleton actually is).
 *
 *   fitTorso  pelvis placed and turned; the three spinal joints share (skelSpineShare*) the swing and twist that
 *             carries the chest toward the shoulder-line target at fixed spine length (and, given an orientation
 *             hint, curve so the chest also takes that orientation); the neck and head swing the head about the
 *             neck BASE toward the head target (a displaced head rotates, it does not slide), the head joint
 *             taking the rest of the orientation hint.
 *   fitArm    the clavicle swings toward a shoulder target (a punch's reach, a shrug), then two-bone IK from the
 *             FK shoulder to the glove with a pole; the glove is clamped to reach.
 *   fitLeg    two-bone IK from the FK hip to the ankle with a knee pole; the foot takes a world orientation.
 */
import type { SkelPose, Vec3 } from './types';
import type { Config } from './config';
import {
  SKJ, fk, poseQ, qAxis, qConj, qFromRotVec, qFromTo, qMul, qNorm, qRot, qToRotVec, rootQuat, setPoseQ, skelArm,
  skelHeadCentre, skelLeg, skelShoulderLine, solveTwoBone, swingTwist, clampJoint,
  type JointLimit, type Quat, type SkelDef, type SkelFK,
} from './skeleton';

const DEG = Math.PI / 180;
/**
 * Fixed-point iterations for the spine's chord and the head's swing. Integration details, not tunables (like the
 * contact passes in sim/gloves.ts): enough that a reachable target is met to well under a millimetre and a joint at
 * its stop hands the rest to the others (scripts/_debug.mjs measured the residuals; LOG_SKELETON.md).
 */
const SPINE_ITERS = 8;
const NECK_ITERS = 8;
/** The neck/head swing never winds past this (rad): the limits stop the joints long before; this only keeps an unreachable target's iteration bounded. */
const W_MAX = Math.PI / 2;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scl = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
function nrm(a: Vec3, fallback: Vec3): Vec3 {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : fallback;
}
const UP: Vec3 = { x: 0, y: 1, z: 0 };

export interface TorsoTargets {
  /** The root: floor point and facing. */
  rootX: number; rootZ: number; yaw: number;
  /** Pelvis world position (the hip joint centre, the body capsule's bottom end) and world orientation. */
  pelvis: Vec3; pelvisRot: Quat;
  /** The shoulder-line centre (the capsule's top end), world. */
  chest: Vec3;
  /** World orientation hint for the chest; null = the natural arc toward `chest`, turned `chestTwist` about the pelvis's up axis. */
  chestRot: Quat | null;
  chestTwist: number;
  /** The head centre (the hit sphere), world, and a world orientation hint for the head. */
  head: Vec3; headRot: Quat;
}

/** Fit pelvis, spine, neck and head. Leaves limbs' local rotations alone. */
export function fitTorso(def: SkelDef, lim: readonly (JointLimit | null)[], cfg: Config, pose: SkelPose, t: TorsoTargets): void {
  const R0 = rootQuat(t.yaw);
  const pl = qRot(qConj(R0), { x: t.pelvis.x - t.rootX, y: t.pelvis.y, z: t.pelvis.z - t.rootZ });
  pose.root[0] = t.rootX; pose.root[1] = t.rootZ; pose.root[2] = t.yaw;
  pose.root[3] = pl.x; pose.root[4] = pl.y; pose.root[5] = pl.z;
  const Rp = qNorm(t.pelvisRot);
  setPoseQ(pose, SKJ.pelvis, qNorm(qMul(qConj(R0), Rp)));
  fitSpine(def, lim, pose, Rp, t);
  fitNeck(def, lim, cfg, pose, t);
}

/** The spinal joints (1..3), heights above the pelvis and levers: how far each sits below the shoulder line, as a fraction. */
function spineGeometry(def: SkelDef): { lever: [number, number, number]; gain: number } {
  const h1 = def.off[SKJ.spine1]!.y, h2 = h1 + def.off[SKJ.spine2]!.y, h3 = h2 + def.off[SKJ.chest]!.y, hS = h3 + def.shoulderLine;
  const lever: [number, number, number] = [(hS - h1) / hS, (hS - h2) / hS, (hS - h3) / hS];
  const s = def.spineShare;
  return { lever, gain: s[0] * lever[0] + s[1] * lever[1] + s[2] * lever[2] };
}

/**
 * Share `total` over joints by `share`, each kept inside its own [lo, hi]; what a joint at its stop cannot take goes
 * to the others in proportion (water-filling, three passes). Deterministic, continuous in `total`.
 */
function shareWithin(total: number, share: readonly number[], lo: readonly number[], hi: readonly number[]): number[] {
  const out = share.map(() => 0);
  let left = total;
  const open = share.map(() => true);
  for (let pass = 0; pass < 3 && Math.abs(left) > 1e-12; pass++) {
    let sw = 0;
    for (let k = 0; k < share.length; k++) if (open[k]) sw += share[k]!;
    if (sw <= 0) break;
    const give = left;
    for (let k = 0; k < share.length; k++) {
      if (!open[k]) continue;
      const want = out[k]! + give * share[k]! / sw;
      const got = want < lo[k]! ? lo[k]! : want > hi[k]! ? hi[k]! : want;
      if (got !== want) open[k] = false;
      left -= got - out[k]!;
      out[k] = got;
    }
  }
  return out;
}

function fitSpine(def: SkelDef, lim: readonly (JointLimit | null)[], pose: SkelPose, Rp: Quat, t: TorsoTargets): void {
  const J = [SKJ.spine1, SKJ.spine2, SKJ.chest];
  const s = def.spineShare;
  const { lever } = spineGeometry(def);
  const dt = nrm(qRot(qConj(Rp), sub(t.chest, t.pelvis)), UP);   // the chord the chest should lie on, pelvis frame
  let tau = t.chestTwist;
  let hint: Vec3 | null = null;
  if (t.chestRot) {
    const st = swingTwist(qMul(qConj(Rp), qNorm(t.chestRot)), 1);
    tau = st.twist; hint = st.swing;
  }
  // The turn: shared, each joint inside its rotation range, the rest to the joints that have some left.
  const tw = shareWithin(tau, s, J.map(j => lim[j]?.lo[1] ?? -Math.PI), J.map(j => lim[j]?.hi[1] ?? Math.PI));
  // Per-joint swing (rotation vector, local frame, y = 0). Natural arc: shares of one swing. With a hint: shares of
  // the hint's swing, then a chord-only mode (lumbar one way, chest the other: Σ = 0, so the chest keeps the hint)
  // for the first half of the iterations, the natural shares after (the chord wins when the hint cannot be had).
  const r: Vec3[] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  if (hint) for (let k = 0; k < 3; k++) r[k] = scl(hint, s[k]!);
  else {
    const c = qToRotVec(qFromTo(UP, dt)); c.y = 0;
    const g0 = s[0] * lever[0] + s[1] * lever[1] + s[2] * lever[2];
    for (let k = 0; k < 3; k++) r[k] = scl(c, s[k]! / g0);
  }
  const mode = [1, 0, -1];
  const open = [true, true, true];
  // Every iteration poses the CLAMPED joints (so the error is real) and moves each accumulator back to what its
  // joint actually took; a joint at its stop drops out and the correction goes to the others.
  const set = (): void => {
    for (let k = 0; k < 3; k++) {
      const want = qNorm(qMul(qFromRotVec(r[k]!), qAxis(1, tw[k]!)));
      const got = clampJoint(want, lim[J[k]!] ?? null, 0);
      setPoseQ(pose, J[k]!, got);
      const back = swingTwist(got, 1).swing;
      open[k] = Math.abs(back.x - r[k]!.x) + Math.abs(back.z - r[k]!.z) < 1e-9;
      r[k] = back;
    }
  };
  for (let it = 0; it < SPINE_ITERS; it++) {
    set();
    // The chord as posed, in the pelvis frame; and each joint's parent frame (to carry the correction into it).
    let p: Vec3 = { x: 0, y: 0, z: 0 }, R: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const parent: Quat[] = [];
    for (let k = 0; k < 3; k++) { p = add(p, qRot(R, def.off[J[k]!]!)); parent.push(R); R = qMul(R, poseQ(pose, J[k]!)); }
    const e = add(p, qRot(R, { x: 0, y: def.shoulderLine, z: 0 }));
    const err = qToRotVec(qFromTo(nrm(e, UP), dt));
    err.y = 0;
    const useMode = hint !== null && it < SPINE_ITERS / 2 && open[0] && open[2];
    const wts = useMode ? mode : s.map((v, k) => (open[k] ? v : 0));
    let g = 0;
    for (let k = 0; k < 3; k++) g += wts[k]! * lever[k]!;
    if (Math.abs(g) < 1e-6) break;   // every joint at its stop: the chord is as close as the spine allows
    const step = scl(err, 1 / g);
    for (let k = 0; k < 3; k++) {
      if (wts[k] === 0) continue;
      const loc = qRot(qConj(parent[k]!), step);
      loc.y = 0;
      r[k] = add(r[k]!, scl(loc, wts[k]!));
    }
  }
  set();
}

function fitNeck(def: SkelDef, lim: readonly (JointLimit | null)[], cfg: Config, pose: SkelPose, t: TorsoTargets): void {
  const f = fk(def, pose, SKJ.neck + 1);
  const Rc = f.r[SKJ.chest]!, nb = f.p[SKJ.neck]!;
  const Hrel = qMul(qConj(Rc), qNorm(t.headRot));   // the head's wanted orientation relative to the chest
  const hs = swingTwist(Hrel, 1);
  const tv = nrm(qRot(qConj(Rc), sub(t.head, nb)), UP);   // where the head centre should be, from the neck base, chest frame
  const share = cfg.skelNeckShare;
  const ln = lim[SKJ.neck], lh = lim[SKJ.head];
  // The head's turn relative to the chest, shared neck / head (C2–C7 / C1–C2), each inside its range.
  const tw = shareWithin(hs.twist, [cfg.skelNeckTwistShare, 1 - cfg.skelNeckTwistShare], [ln?.lo[1] ?? -Math.PI, lh?.lo[1] ?? -Math.PI], [ln?.hi[1] ?? Math.PI, lh?.hi[1] ?? Math.PI]);
  const offHead = def.off[SKJ.head]!, hc: Vec3 = { x: 0, y: def.headCentre, z: 0 };
  // w: the swing (chest frame) that carries the head about the neck base onto its target. The neck takes `share` of
  // it and of the hint's own tilt; the head joint the rest, so the head turns with the displacement (it does not
  // slide) and keeps the hint's orientation on top. Joints are clamped inside the loop: when the head joint is at its
  // stop the error is real, w grows, and the neck takes more.
  let w = qToRotVec(qFromTo(UP, tv)); w.y = 0;
  const hsw = hs.swing;
  let qn: Quat = { x: 0, y: 0, z: 0, w: 1 }, qh: Quat = qn;
  const set = (): void => {
    qn = clampJoint(qNorm(qMul(qFromRotVec(add(scl(w, share), scl(hsw, share))), qAxis(1, tw[0]!))), ln ?? null, 0);
    qh = clampJoint(qNorm(qMul(qConj(qn), qMul(qFromRotVec(w), Hrel))), lh ?? null, 0);
  };
  for (let it = 0; it < NECK_ITERS; it++) {
    set();
    const cur = add(qRot(qn, offHead), qRot(qMul(qn, qh), hc));
    const err = qToRotVec(qFromTo(nrm(cur, UP), tv));
    err.y = 0;
    w = add(w, err);
    const wl = Math.sqrt(w.x * w.x + w.z * w.z);
    if (wl > W_MAX) w = scl(w, W_MAX / wl);   // an unreachable target must not wind the swing past a quarter turn
  }
  set();
  setPoseQ(pose, SKJ.neck, qn);
  setPoseQ(pose, SKJ.head, qh);
}

/**
 * Where a clavicle should carry its shoulder: the bind shoulder in the CHEST's frame, `reach` forward and `lift`
 * up (both in the chest frame, m) — so the shoulders ride the ribcage. Needs an FK that reached the chest.
 */
export function clavicleTarget(def: SkelDef, f: SkelFK, i: number, reach: number, lift: number): Vec3 {
  const a = skelArm(i);
  const Rc = f.r[SKJ.chest]!, pc = f.p[SKJ.chest]!;
  const oc = def.off[a.clav]!, ou = def.off[a.upper]!;
  return add(pc, qRot(Rc, { x: oc.x + ou.x + reach, y: oc.y + ou.y + lift, z: oc.z + ou.z }));
}

export interface ArmFit { shoulder: Vec3; elbow: Vec3; hand: Vec3; flex: number }

/**
 * Fit one arm (i: 0 lead, 1 rear). The clavicle swings toward `shoulderTarget` (null = rest), the arm reaches for
 * `glove` bending toward `pole` (a world direction), the hand rolls `handRoll` about the forearm (rad, raw local +y).
 * If the shoulder clamp moves the upper arm, the elbow re-aims the forearm at the glove within its hinge.
 */
export function fitArm(def: SkelDef, lim: readonly (JointLimit | null)[], cfg: Config, pose: SkelPose, i: number, shoulderTarget: Vec3 | null, glove: Vec3, pole: Vec3, handRoll: number): ArmFit {
  const a = skelArm(i), side = def.side[a.clav]!;
  const f = fk(def, pose, SKJ.chest + 1);
  const Rc = f.r[SKJ.chest]!;
  const pClav = add(f.p[SKJ.chest]!, qRot(Rc, def.off[a.clav]!));
  let qc: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const rest = nrm(def.off[a.upper]!, { x: 0, y: 0, z: side });
  if (shoulderTarget) qc = qFromTo(rest, nrm(qRot(qConj(Rc), sub(shoulderTarget, pClav)), rest));
  qc = clampJoint(qc, lim[a.clav] ?? null, side);
  setPoseQ(pose, a.clav, qc);
  const Rcl = qMul(Rc, qc);
  const sh = add(pClav, qRot(Rcl, def.off[a.upper]!));
  const minF = cfg.skelIkStraightDeg * DEG, maxF = cfg.skelElbowFlex * DEG;
  const ik = solveTwoBone(sh, Rcl, glove, pole, def.upperArm, def.forearm, 1, minF, maxF);
  const qu = clampJoint(ik.upper, lim[a.upper] ?? null, side);
  setPoseQ(pose, a.upper, qu);
  const Ru = qMul(Rcl, qu);
  const el = add(sh, qRot(Ru, { x: 0, y: -def.upperArm, z: 0 }));
  // The hinge re-aims at the glove from wherever the (clamped) upper arm put the elbow: forearm dir = (sin θ, −cos θ, 0) locally.
  const dl = qRot(qConj(Ru), sub(glove, el));
  let flex = Math.atan2(dl.x, -dl.y);
  flex = flex < minF ? minF : flex > maxF ? maxF : flex;
  setPoseQ(pose, a.fore, clampJoint(qAxis(2, flex), lim[a.fore] ?? null, side));
  setPoseQ(pose, a.hand, clampJoint(qAxis(1, handRoll), lim[a.hand] ?? null, side));
  const Rf = qMul(Ru, poseQ(pose, a.fore));
  const hand = add(el, qRot(Rf, { x: 0, y: -def.forearm, z: 0 }));
  return { shoulder: sh, elbow: el, hand, flex };
}

export interface LegFit { hip: Vec3; knee: Vec3; ankle: Vec3 }

/** Fit one leg (i: 0 lead, 1 rear): IK from the FK hip to `ankle`, the knee toward `pole`; the foot takes `footRot` (world; null = with the shin). */
export function fitLeg(def: SkelDef, lim: readonly (JointLimit | null)[], cfg: Config, pose: SkelPose, i: number, ankle: Vec3, pole: Vec3, footRot: Quat | null): LegFit {
  const l = skelLeg(i), side = def.side[l.thigh]!;
  const f = fk(def, pose, 1);
  const Rp = f.r[SKJ.pelvis]!;
  const hip = add(f.p[SKJ.pelvis]!, qRot(Rp, def.off[l.thigh]!));
  const minF = cfg.skelIkStraightDeg * DEG, maxF = cfg.skelKneeFlex * DEG;
  const ik = solveTwoBone(hip, Rp, ankle, pole, def.thigh, def.shin, -1, minF, maxF);
  const qt = clampJoint(ik.upper, lim[l.thigh] ?? null, side);
  setPoseQ(pose, l.thigh, qt);
  const Rt = qMul(Rp, qt);
  const knee = add(hip, qRot(Rt, { x: 0, y: -def.thigh, z: 0 }));
  // Shin dir = (−sin θ, −cos θ, 0) locally (it folds back).
  const dl = qRot(qConj(Rt), sub(ankle, knee));
  let flex = Math.atan2(-dl.x, -dl.y);
  flex = flex < minF ? minF : flex > maxF ? maxF : flex;
  setPoseQ(pose, l.shin, clampJoint(qAxis(2, -flex), lim[l.shin] ?? null, side));
  const Rs = qMul(Rt, poseQ(pose, l.shin));
  setPoseQ(pose, l.foot, clampJoint(footRot ? qMul(qConj(Rs), qNorm(footRot)) : { x: 0, y: 0, z: 0, w: 1 }, lim[l.foot] ?? null, side));
  return { hip, knee, ankle: add(knee, qRot(Rs, { x: 0, y: -def.shin, z: 0 })) };
}

/** Torso hit shapes from a fitted pose: the head sphere's centre and the body capsule's two ends. */
export function torsoShapes(def: SkelDef, pose: SkelPose): { head: Vec3; hips: Vec3; shoulders: Vec3 } {
  const f = fk(def, pose, SKJ.head + 1);
  return { head: skelHeadCentre(def, f), hips: f.p[SKJ.pelvis]!, shoulders: skelShoulderLine(def, f) };
}

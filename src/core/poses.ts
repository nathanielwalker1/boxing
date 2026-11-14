/**
 * core/poses.ts — punches as authored KEY POSES in joint space (anim Phase 1.4; docs/anim/LOG_PUNCHES.md). Pure.
 *
 * The values live in config (`pose_*`, `punchk_*`, generated in config.ts from one table). A key is read into an
 * RPose: ABSOLUTE channels in body terms (radians about the root's axes, metres, lead / rear indexed), so the guard
 * and the punch keys — authored in punching-side convention and mirrored by the stance — blend in one space.
 *
 * Timeline on the existing punch clock (sim/punches.ts phases; the hit test stays on its tick):
 *   guard ──(cock × loadAt)── LOAD ──(drive)── CONTACT @ hit test ──(hold, ≥ followMin)── FOLLOW ──(recover)── guard
 * Through the drive every channel GROUP runs its own clock: feet and pelvis start first, then the spine (+dSpine),
 * the clavicle and shoulder (+dShoulder), the hand last (+dHand); all arrive at the contact tick. The hand eases IN
 * (fastest at arrival); body groups ease in-out. Back to the guard, the hand takes no longer than its drive took
 * (ease-OUT), and the body settles over the whole recovery.
 */
import type { BodyDims, GuardShape, Hand, PunchType, Stance, Vec3, SkelPose } from './types';
import { POSE_REF_HEIGHT, type Config } from './config';
import { handLateralSign } from './math';
import { SKJ, poseQ, qAxis, qFromRotVec, qMirror, qMul, qNorm, qRot, setPoseQ, skelArm, type Quat, type SkelDef, type SkelFK } from './skeleton';

const D = Math.PI / 180;

export type PosePunch = 'jab' | 'cross' | 'hookL' | 'hookR' | 'upperL' | 'upperR';
export function posePunchOf(type: PunchType, hand: Hand): PosePunch {
  if (type === 'jab') return 'jab';
  if (type === 'cross') return 'cross';
  if (type === 'hook') return hand === 'lead' ? 'hookL' : 'hookR';
  return hand === 'lead' ? 'upperL' : 'upperR';
}

export interface RHand { cF: number; cU: number; cL: number; aF: number; aU: number; aL: number; aim: number; swivel: number; pron: number }
export interface RFoot { stepF: number; stepL: number; pivot: number; heel: number }
/** A resolved pose: absolute, radians / metres (already scaled to the body), lead = index 0. */
export interface RPose {
  pelYaw: number; pelPitch: number; pelRoll: number; pelFwd: number; pelUp: number; pelLat: number;
  spTwist: number; spFlex: number; spSide: number;
  hdYaw: number; hdPitch: number; hdRoll: number; hdLook: number;
  clPro: [number, number]; clElev: [number, number];
  hand: [RHand, RHand];
  foot: [RFoot, RFoot];
  weight: number;
  /** The guard's own turn (pelvis + spine, rad): the non-punching hand is turned back by whatever the punch adds to it. */
  yawRef: number;
}

const zeroFoot = (): RFoot => ({ stepF: 0, stepL: 0, pivot: 0, heel: 0 });
const cloneR = (r: RPose): RPose => ({ ...r, clPro: [r.clPro[0], r.clPro[1]], clElev: [r.clElev[0], r.clElev[1]], hand: [{ ...r.hand[0] }, { ...r.hand[1] }], foot: [{ ...r.foot[0] }, { ...r.foot[1] }] });
const c = (cfg: Config, k: string): number => (cfg as unknown as Record<string, number>)[k] ?? 0;
export const poseScale = (body: BodyDims): number => body.heightM / POSE_REF_HEIGHT;

/** The guard (or the block), absolute. */
export function guardPose(cfg: Config, body: BodyDims, stance: Stance, shape: GuardShape, block: boolean): RPose {
  const sr = handLateralSign('rear', stance), s = poseScale(body);
  const g = (ch: string): number => c(cfg, `pose_guard_${ch}`);
  const sh = (ch: string): number => (shape === 'high' ? g(ch) : c(cfg, `pose_guard_${shape}_${ch}`));
  const hand = (pre: 'lead' | 'rear'): RHand => ({
    cF: sh(`${pre}F`) * s, cU: sh(`${pre}U`) * s, cL: sh(`${pre}L`) * s, aF: 0, aU: 0, aL: 0, aim: 0,
    swivel: g(`${pre}Swivel`) * D, pron: g(`${pre}Pron`) * D,
  });
  const r: RPose = {
    pelYaw: sr * g('pelYaw') * D, pelPitch: 0, pelRoll: 0, pelFwd: 0, pelUp: g('pelUp') * s, pelLat: 0,
    spTwist: sr * g('spTwist') * D, spFlex: g('spFlex') * D, spSide: 0,
    hdYaw: 0, hdPitch: g('hdPitch') * D, hdRoll: 0, hdLook: g('hdLook'),
    clPro: [g('clProL') * D, g('clProR') * D], clElev: [g('clElevL') * D, g('clElevR') * D],
    hand: [hand('lead'), hand('rear')], foot: [zeroFoot(), zeroFoot()], weight: g('weight'), yawRef: 0,
  };
  r.yawRef = r.pelYaw + r.spTwist;
  r.foot[1].heel = g('rearHeel') * s;
  if (block) {
    r.spFlex += cfg.poseBlockSpFlex * D; r.hdPitch += cfg.poseBlockChin * D;
    r.hand[0].cF = cfg.poseBlockLeadF * s; r.hand[0].cU = cfg.poseBlockLeadU * s; r.hand[0].cL = cfg.poseBlockLeadL * s;
    r.hand[1].cF = cfg.poseBlockRearF * s; r.hand[1].cU = cfg.poseBlockRearU * s; r.hand[1].cL = cfg.poseBlockRearL * s;
    r.hand[0].swivel += cfg.poseBlockSwivel * D; r.hand[1].swivel += cfg.poseBlockSwivel * D;
  }
  return r;
}

/** A punch key over the guard: the deltas in punching-side convention, mirrored by the stance. */
export function punchKey(cfg: Config, body: BodyDims, stance: Stance, guard: RPose, punch: PosePunch, hand: Hand, key: 'load' | 'contact' | 'follow', bodyLevel: boolean, drive = 1): RPose {
  const r = cloneR(guard);
  const sp = handLateralSign(hand, stance), s = poseScale(body), ip = hand === 'lead' ? 0 : 1;
  const k = (ch: string): number => c(cfg, `pose_${punch}_${key}_${ch}`);
  // `drive` (0..1, from the range at the press): how much of the key's body turn and travel this punch has room for.
  const dv = key === 'load' ? 1 : drive;
  r.pelYaw += sp * k('pelYaw') * D * dv; r.pelPitch += k('pelPitch') * D; r.pelRoll += sp * k('pelRoll') * D;
  r.pelFwd += k('pelFwd') * s * dv; r.pelUp += k('pelUp') * s; r.pelLat += sp * k('pelLat') * s;
  r.spTwist += sp * k('spTwist') * D * dv; r.spFlex += k('spFlex') * D; r.spSide += sp * k('spSide') * D;
  r.hdYaw += -sp * k('hdYaw') * D; r.hdPitch += k('hdPitch') * D; r.hdRoll += sp * k('hdRoll') * D;
  r.clPro[ip] += k('clPro') * D; r.clElev[ip] += k('clElev') * D;
  const h = r.hand[ip];
  if (key !== 'load') r.hand[ip === 0 ? 1 : 0].swivel = cfg.poseOffhandSwivel * D;
  h.cF += k('hCF') * s; h.cU += k('hCU') * s; h.cL += k('hCL') * s;
  h.aF = k('hAF') * s; h.aU = k('hAU') * s; h.aL = k('hAL') * s; h.aim = k('hAim');
  h.swivel += k('hSwivel') * D; h.pron += k('hPron') * D;
  const fp = r.foot[ip], fo = r.foot[ip === 0 ? 1 : 0];
  fp.stepF += k('fpStepF') * s; fp.stepL += k('fpStepL') * s; fp.pivot += sp * k('fpPivot') * D; fp.heel += k('fpHeel') * s;
  fo.stepF += k('foStepF') * s; fo.stepL += k('foStepL') * s; fo.pivot += sp * k('foPivot') * D; fo.heel += k('foHeel') * s;
  r.weight += k('weight') * dv;
  if (bodyLevel && key !== 'follow') {
    // The BODY version: the level is the knees (the pelvis drops), the waist bends no further than poseBodyFlexMax.
    r.pelUp -= c(cfg, `punchk_${punch}_bodyDrop`) * s * (key === 'load' ? 0.7 : 1);
  }
  if (bodyLevel) {
    r.pelUp -= key === 'follow' ? c(cfg, `punchk_${punch}_bodyDrop`) * s : 0;
    r.spFlex = Math.min(r.spFlex, cfg.poseBodyFlexMax * D);
  }
  return r;
}

type Group = 'feet' | 'pelvis' | 'spine' | 'shoulder' | 'hand';
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Blend `a` → `b` with a per-group weight. */
function blend(a: RPose, b: RPose, w: Record<Group, number>): RPose {
  const r = cloneR(a);
  const wf = w.feet, wp = w.pelvis, ws = w.spine, wc = w.shoulder, wh = w.hand;
  r.weight = lerp(a.weight, b.weight, wf);
  for (let i = 0; i < 2; i++) {
    const fa = a.foot[i]!, fb = b.foot[i]!;
    r.foot[i] = { stepF: lerp(fa.stepF, fb.stepF, wf), stepL: lerp(fa.stepL, fb.stepL, wf), pivot: lerp(fa.pivot, fb.pivot, wf), heel: lerp(fa.heel, fb.heel, wf) };
    r.clPro[i] = lerp(a.clPro[i]!, b.clPro[i]!, wc); r.clElev[i] = lerp(a.clElev[i]!, b.clElev[i]!, wc);
    const ha = a.hand[i]!, hb = b.hand[i]!;
    r.hand[i] = { cF: lerp(ha.cF, hb.cF, wh), cU: lerp(ha.cU, hb.cU, wh), cL: lerp(ha.cL, hb.cL, wh), aF: lerp(ha.aF, hb.aF, wh), aU: lerp(ha.aU, hb.aU, wh), aL: lerp(ha.aL, hb.aL, wh), aim: lerp(ha.aim, hb.aim, wh), swivel: lerp(ha.swivel, hb.swivel, wh), pron: lerp(ha.pron, hb.pron, wh) };
  }
  r.pelYaw = lerp(a.pelYaw, b.pelYaw, wp); r.pelPitch = lerp(a.pelPitch, b.pelPitch, wp); r.pelRoll = lerp(a.pelRoll, b.pelRoll, wp);
  r.pelFwd = lerp(a.pelFwd, b.pelFwd, wp); r.pelUp = lerp(a.pelUp, b.pelUp, wp); r.pelLat = lerp(a.pelLat, b.pelLat, wp);
  r.spTwist = lerp(a.spTwist, b.spTwist, ws); r.spFlex = lerp(a.spFlex, b.spFlex, ws); r.spSide = lerp(a.spSide, b.spSide, ws);
  r.hdYaw = lerp(a.hdYaw, b.hdYaw, ws); r.hdPitch = lerp(a.hdPitch, b.hdPitch, ws); r.hdRoll = lerp(a.hdRoll, b.hdRoll, ws); r.hdLook = lerp(a.hdLook, b.hdLook, ws);
  return r;
}
const smooth = (t: number): number => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); };
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const all = (v: number): Record<Group, number> => ({ feet: v, pelvis: v, spine: v, shoulder: v, hand: v });

export interface PunchClock { cock: number; extend: number; recover: number; hold: number; total: number }
export interface KeyedInput {
  cfg: Config; body: BodyDims; stance: Stance; shape: GuardShape; block: boolean;
  /** The punch in flight: its type and hand, seconds into its phase table, its phase table, and whether it goes to the body. */
  punch: { type: PunchType; hand: Hand; elapsed: number; clock: PunchClock; bodyLevel: boolean; drive?: number } | null;
}

/** Each group's progress through the drive (load → contact): staggered starts, all arrive at contact. Exposed for the probe. */
export function driveWeights(cfg: Config, punch: PosePunch, u0: number, t: number, t1: number): Record<Group, number> {
  const span = Math.max(1e-6, t1 - u0);
  const g = (d: number, ease: (x: number) => number): number => ease(clamp01((t - u0 - d) / Math.max(1e-6, span - d)));
  const dS = Math.min(span * 0.9, c(cfg, `punchk_${punch}_dSpine`)), dC = Math.min(span * 0.9, c(cfg, `punchk_${punch}_dShoulder`)), dH = Math.min(span * 0.9, c(cfg, `punchk_${punch}_dHand`));
  const pe = Math.max(1, cfg.poseHandEase);
  return { feet: g(0, smooth), pelvis: g(0, smooth), spine: g(dS, smooth), shoulder: g(dC, smooth), hand: g(dH, x => Math.pow(x, pe)) };
}

/** The keyed pose for this instant. */
export function keyedPose(inp: KeyedInput): RPose {
  const { cfg, body, stance, shape, block, punch } = inp;
  const guard = guardPose(cfg, body, stance, shape, block && !punch);
  if (!punch) return guard;
  const pp = posePunchOf(punch.type, punch.hand);
  const ck = punch.clock, e = punch.elapsed;
  const dv = punch.drive ?? 1;
  const L = punchKey(cfg, body, stance, guard, pp, punch.hand, 'load', punch.bodyLevel, dv);
  const C = punchKey(cfg, body, stance, guard, pp, punch.hand, 'contact', punch.bodyLevel, dv);
  const F = punchKey(cfg, body, stance, guard, pp, punch.hand, 'follow', punch.bodyLevel, dv);
  const tL = ck.cock * clamp01(c(cfg, `punchk_${pp}_loadAt`));
  const tC = ck.cock + ck.extend;
  const tF = tC + Math.max(ck.hold, c(cfg, `punchk_${pp}_followMin`)) * ck.recover;
  const tE = ck.total;
  if (e <= tL) return blend(guard, L, all(smooth(e / Math.max(1e-6, tL))));
  if (e <= tC) return blend(L, C, driveWeights(cfg, pp, tL, e, tC));
  if (e <= tF) return blend(C, F, all(smooth((e - tC) / Math.max(1e-6, tF - tC))));
  // Recovery: the hand is home in no more time than its drive took (ease-out); the body settles over the rest.
  const handOut = Math.max(1e-6, tC - tL - Math.min((tC - tL) * 0.9, c(cfg, `punchk_${pp}_dHand`)));
  const wb = smooth((e - tF) / Math.max(1e-6, tE - tF));
  const uh = clamp01((e - tF) / Math.min(handOut, Math.max(1e-6, tE - tF)));
  return blend(F, guard, { feet: wb, pelvis: wb, spine: wb, shoulder: wb, hand: 1 - (1 - uh) * (1 - uh) });
}

// ── Applying a pose ─────────────────────────────────────────────────────────

/** The keyed torso over a fitted base (the reactive body: hits, slips, the level): pelvis, spine, neck, head. */
/** `turned`: the pelvis yaw was already given to the torso fit; travel, tilt, spine and head here. */
export function applyKeyedTorso(def: SkelDef, pose: SkelPose, r: RPose, cfg: Config, stance: Stance, turned = false): void {
  const stanceLen = cfg.rigStanceFwd + cfg.rigStanceBack;
  const wShift = (0.5 - r.weight) * stanceLen * cfg.poseWeightTravel;
  // Pelvis travel is in the root frame (forward, up, right).
  pose.root[3] = pose.root[3]! + r.pelFwd + wShift;
  pose.root[4] = pose.root[4]! + r.pelUp;
  pose.root[5] = pose.root[5]! + r.pelLat;
  setPoseQ(pose, SKJ.pelvis, qNorm(qMul(poseQ(pose, SKJ.pelvis), qMul(qAxis(1, turned ? 0 : r.pelYaw), qMul(qAxis(2, -r.pelPitch), qAxis(0, r.pelRoll))))));
  // Bend shared by the spine shares; the TURN shared in proportion to each joint's rotation range, so no joint reaches
  // its stop before the others (25/35/40 put the lumbar, 8° range, on its stop through every cross — measured).
  const sh = def.spineShare, J = [SKJ.spine1, SKJ.spine2, SKJ.chest];
  const rot = [cfg.skelLumbarRot, cfg.skelSpineRot, cfg.skelChestRot], rotSum = rot[0]! + rot[1]! + rot[2]! || 1;
  for (let k = 0; k < 3; k++) {
    const w = sh[k]!, wt = rot[k]! / rotSum;
    setPoseQ(pose, J[k]!, qNorm(qMul(poseQ(pose, J[k]!), qFromRotVec({ x: w * r.spSide, y: wt * r.spTwist, z: -w * r.spFlex }))));
  }
  // The head: its own turn, less `look` of the chest's turn so the eyes stay on the man; nod and tilt. Neck / head halves.
  const yaw = r.hdYaw - r.hdLook * (r.pelYaw + r.spTwist);
  const nh = qFromRotVec({ x: 0.5 * r.hdRoll, y: 0.5 * yaw, z: -0.5 * r.hdPitch });
  setPoseQ(pose, SKJ.neck, qNorm(qMul(poseQ(pose, SKJ.neck), nh)));
  setPoseQ(pose, SKJ.head, qNorm(qMul(poseQ(pose, SKJ.head), nh)));
  void stance;
}

/**
 * World point a keyed hand goes to: its chest-frame spot and its aim-point spot, blended by `aim`. `counterYaw` (rad)
 * turns the chest-frame spot back about the vertical: the NON-punching hand stays at the face while the punch turns
 * the chest under it (a cross turned the chest ~80° and swung the lead glove 32 cm off the cheek — measured).
 */
export function keyedHandTarget(f: SkelFK, h: RHand, side: number, aimPoint: Vec3 | null, fwd: { x: number; z: number }, counterYaw = 0): Vec3 {
  const Rc = f.r[SKJ.chest]!, pc = f.p[SKJ.chest]!;
  let d = qRot(Rc, { x: h.cF, y: h.cU, z: side * h.cL });
  if (counterYaw !== 0) d = qRot(qAxis(1, -counterYaw), d);
  const chest = { x: pc.x + d.x, y: pc.y + d.y, z: pc.z + d.z };
  if (!aimPoint || h.aim <= 0) return chest;
  const right = { x: -fwd.z, z: fwd.x };
  const aim = { x: aimPoint.x + fwd.x * h.aF + right.x * side * h.aL, y: aimPoint.y + h.aU, z: aimPoint.z + fwd.z * h.aF + right.z * side * h.aL };
  return { x: chest.x + (aim.x - chest.x) * h.aim, y: chest.y + (aim.y - chest.y) * h.aim, z: chest.z + (aim.z - chest.z) * h.aim };
}

/** The elbow pole for a swivel angle: "hanging straight down" turned about the shoulder→hand axis, + = out on `side`. */
export function swivelPole(shoulder: Vec3, hand: Vec3, swivel: number, side: number, chestRot: Quat, armLen = Infinity, foldBlend = 0.45): Vec3 {
  let ax = hand.x - shoulder.x, ay = hand.y - shoulder.y, az = hand.z - shoulder.z;
  const l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
  // A hand folded in near its shoulder (a smothered straight inside) makes the reach axis short and wild: the swivel
  // frame spun the upper arm 178° in a tick (measured). Below foldBlend × the arm's length the pole eases to a fixed
  // one in the chest frame — elbow back, down and out.
  const fold = Number.isFinite(armLen) ? Math.max(0, Math.min(1, (foldBlend - l / armLen) / Math.max(1e-3, foldBlend * 0.5))) : 0;
  const fixed = qRot(chestRot, { x: -0.4, y: -1, z: side * 0.5 });
  let bx = 0, by = -1, bz = 0;
  let dd = bx * ax + by * ay + bz * az;
  bx -= ax * dd; by -= ay * dd; bz -= az * dd;
  if (bx * bx + by * by + bz * bz < 1e-6) { const back = qRot(chestRot, { x: -1, y: 0, z: 0 }); bx = back.x; by = back.y; bz = back.z; dd = bx * ax + by * ay + bz * az; bx -= ax * dd; by -= ay * dd; bz -= az * dd; }
  const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
  // Rodrigues about the axis by −side × swivel (derived: for the right arm a negative turn about the reach axis carries "down" outward).
  const th = -side * swivel, cs = Math.cos(th), sn = Math.sin(th);
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  const p = { x: bx * cs + cx * sn, y: by * cs + cy * sn, z: bz * cs + cz * sn };
  return fold > 0 ? { x: p.x + (fixed.x - p.x) * fold, y: p.y + (fixed.y - p.y) * fold, z: p.z + (fixed.z - p.z) * fold } : p;
}

/** Where a keyed clavicle carries its shoulder: the bind shoulder turned by protraction and elevation (chest frame). */
export function keyedClavicleTarget(def: SkelDef, f: SkelFK, i: number, pro: number, elev: number): Vec3 {
  const a = skelArm(i), side = def.side[a.clav]!;
  let q = qMul(qAxis(1, pro), qAxis(0, -elev));
  if (side < 0) q = qMirror(q);
  const Rc = f.r[SKJ.chest]!, pc = f.p[SKJ.chest]!;
  const oc = def.off[a.clav]!;
  const pClav = qRot(Rc, oc);
  const sh = qRot(Rc, qRot(q, def.off[a.upper]!));
  return { x: pc.x + pClav.x + sh.x, y: pc.y + pClav.y + sh.y, z: pc.z + pClav.z + sh.z };
}

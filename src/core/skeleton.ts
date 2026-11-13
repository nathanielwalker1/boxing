/**
 * core/skeleton.ts — the rigid skeleton (anim Phase 1.1, docs/anim/DESIGN.md §2.1). Pure: no three.js, no clocks,
 * no Math.random. The sim fits it every tick (core/skelFit.ts, sim/skel.ts) and rewrites the hit shapes from it;
 * the rig draws a three.js bone hierarchy that mirrors it joint for joint.
 *
 *   root (floor point, yaw)
 *     pelvis
 *       spine1 (lumbar) > spine2 (low thoracic) > chest (mid ribcage)
 *         neck > head
 *         clavicle L/R > upperArm > forearm > hand
 *       thigh L/R > shin > foot
 *
 * Frames. Every joint frame, in the bind, is axis-aligned with the root: +x forward (toward the opponent), +y up,
 * +z the fighter's right (the rig's local frame; core/math frameOf). The root is a rotation about world +y by
 * −yaw, so root +x = (cos yaw, 0, sin yaw) = forward and root +z = (−sin yaw, 0, cos yaw) = right. Limbs hang
 * down local −y in the bind (arms hanging, legs straight), so the bind pose is every local rotation = identity —
 * the rig's inverse bind matrices stay plain translations.
 *
 * Lengths. Every joint has a FIXED offset from its parent, built once from BodyDims (skelDef). The only
 * translations in a pose are the root's floor point and the pelvis offset. Nothing is ever scaled, so a pose can
 * not stretch a bone: lengths hold by construction (scripts/skel_test.mjs checks it to 1e-6 every tick).
 *
 * Limits. Per joint, per axis, degrees in config (`skel*`; left and right share keys: a left joint is mirrored
 * through the sagittal plane, z → −z, before it is decomposed). A joint's local rotation is split by swing-twist
 * about its twist axis (the bone's long axis); the twist angle and the swing's two exponential-map components each
 * have a min and max. Elbow and knee are hinges: flexion only, no hyperextension, no side bend, no twist. clampPose
 * is the last step of every pipeline, sim and rig, and is idempotent.
 */
import type { BodyDims, SkelPose, Stance, Vec3 } from './types';
import type { Config } from './config';
import { angleDelta, handLateralSign } from './math';

export interface Quat { x: number; y: number; z: number; w: number }

/** Joint ids. Limbs are indexed like the sim's: 0 = lead, 1 = rear. */
export const SKJ = {
  pelvis: 0, spine1: 1, spine2: 2, chest: 3, neck: 4, head: 5,
  clav0: 6, upper0: 7, fore0: 8, hand0: 9,
  clav1: 10, upper1: 11, fore1: 12, hand1: 13,
  thigh0: 14, shin0: 15, foot0: 16,
  thigh1: 17, shin1: 18, foot1: 19,
} as const;
export const JOINT_COUNT = 20;
/** Parent of each joint (−1 = the root). Parents always come before their children. */
export const JOINT_PARENT: readonly number[] = [-1, 0, 1, 2, 3, 4, 3, 6, 7, 8, 3, 10, 11, 12, 0, 14, 15, 0, 17, 18];
export const JOINT_NAMES: readonly string[] = [
  'pelvis', 'spine1', 'spine2', 'chest', 'neck', 'head',
  'clavicle0', 'upperArm0', 'forearm0', 'hand0', 'clavicle1', 'upperArm1', 'forearm1', 'hand1',
  'thigh0', 'shin0', 'foot0', 'thigh1', 'shin1', 'foot1',
];
export type JointKind = 'root' | 'lumbar' | 'spine' | 'chest' | 'neck' | 'head' | 'clavicle' | 'shoulder' | 'elbow' | 'wrist' | 'hip' | 'knee' | 'ankle';
export const JOINT_KIND: readonly JointKind[] = [
  'root', 'lumbar', 'spine', 'chest', 'neck', 'head',
  'clavicle', 'shoulder', 'elbow', 'wrist', 'clavicle', 'shoulder', 'elbow', 'wrist',
  'hip', 'knee', 'ankle', 'hip', 'knee', 'ankle',
];
export const skelArm = (i: number): { clav: number; upper: number; fore: number; hand: number } =>
  i === 0 ? { clav: 6, upper: 7, fore: 8, hand: 9 } : { clav: 10, upper: 11, fore: 12, hand: 13 };
export const skelLeg = (i: number): { thigh: number; shin: number; foot: number } =>
  i === 0 ? { thigh: 14, shin: 15, foot: 16 } : { thigh: 17, shin: 18, foot: 19 };

const DEG = Math.PI / 180;

// ── Quaternions (x, y, z, w; unit; Hamilton product, v' = q v q*) ─────────────

export const qId = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export function qMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
export const qConj = (a: Quat): Quat => ({ x: -a.x, y: -a.y, z: -a.z, w: a.w });
export function qNorm(a: Quat): Quat {
  const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l, z: a.z / l, w: a.w / l } : qId();
}
/** Rotate v by q. */
export function qRot(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}
export function qAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(angle / 2) };
}
/** Rotation about a frame axis (0 = x, 1 = y, 2 = z). */
export const qAxis = (axis: number, angle: number): Quat => qAxisAngle(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0, angle);
/** The same rotation with w ≥ 0 (q and −q are one rotation; decompositions want the short one). */
export const qCanon = (q: Quat): Quat => (q.w < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : q);
/** Exponential map: rotation vector (axis × angle, rad) → quaternion. */
export function qFromRotVec(v: Vec3): Quat {
  const a = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (a < 1e-12) return qNorm({ x: v.x / 2, y: v.y / 2, z: v.z / 2, w: 1 });
  const s = Math.sin(a / 2) / a;
  return { x: v.x * s, y: v.y * s, z: v.z * s, w: Math.cos(a / 2) };
}
/** Log map: quaternion → rotation vector, angle in [0, π]. */
export function qToRotVec(q0: Quat): Vec3 {
  const q = qCanon(q0);
  const s = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
  if (s < 1e-12) return { x: 2 * q.x, y: 2 * q.y, z: 2 * q.z };
  const a = 2 * Math.atan2(s, q.w);
  return { x: q.x / s * a, y: q.y / s * a, z: q.z / s * a };
}
/** Shortest rotation taking unit vector u to unit vector v. */
export function qFromTo(u: Vec3, v: Vec3): Quat {
  const d = u.x * v.x + u.y * v.y + u.z * v.z;
  if (d < -1 + 1e-9) {
    // Opposite: half a turn about any axis perpendicular to u.
    let ax = 0, ay = -u.z, az = u.y;
    if (ay * ay + az * az < 1e-8) { ax = u.z; ay = 0; az = -u.x; }
    const l = Math.sqrt(ax * ax + ay * ay + az * az);
    return { x: ax / l, y: ay / l, z: az / l, w: 0 };
  }
  return qNorm({ x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x, w: 1 + d });
}
/** The rotation whose matrix columns are the orthonormal right-handed basis X, Y, Z. */
export function qFromBasis(X: Vec3, Y: Vec3, Z: Vec3): Quat {
  const m00 = X.x, m01 = Y.x, m02 = Z.x, m10 = X.y, m11 = Y.y, m12 = Z.y, m20 = X.z, m21 = Y.z, m22 = Z.z;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s }; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s }; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s }; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s }; }
  return qNorm(q);
}
/** Spherical interpolation, shortest arc. */
export function qSlerp(a: Quat, b0: Quat, t: number): Quat {
  let b = b0;
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (d < 0) { b = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; d = -d; }
  if (d > 0.9995) return qNorm({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, w: a.w + (b.w - a.w) * t });
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return { x: a.x * ka + b.x * kb, y: a.y * ka + b.y * kb, z: a.z * ka + b.z * kb, w: a.w * ka + b.w * kb };
}
/** q to the power t: the same axis, t × the angle (shortest arc). */
export const qPow = (q: Quat, t: number): Quat => qSlerp(qId(), q, t);
/** Mirror a rotation through the sagittal plane (z → −z): how a left joint is read on the right side's limits. */
export const qMirror = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: q.z, w: q.w });

/**
 * Swing-twist decomposition about frame axis `axis`: q = swing · twist, twist a rotation about the axis,
 * swing a rotation about an axis perpendicular to it. Returns the twist angle (rad, (−π, π]) and the swing as a
 * rotation vector (its `axis` component is exactly 0).
 */
export function swingTwist(q0: Quat, axis: number): { twist: number; swing: Vec3 } {
  const q = qCanon(q0);
  const p = axis === 0 ? q.x : axis === 1 ? q.y : q.z;
  const n = Math.sqrt(p * p + q.w * q.w);
  let twist = 0, tw = qId();
  if (n > 1e-9) { tw = { x: axis === 0 ? p / n : 0, y: axis === 1 ? p / n : 0, z: axis === 2 ? p / n : 0, w: q.w / n }; twist = 2 * Math.atan2(p, q.w); }
  const swing = qToRotVec(qMul(q, qConj(tw)));
  if (axis === 0) swing.x = 0; else if (axis === 1) swing.y = 0; else swing.z = 0;
  return { twist, swing };
}

// ── The skeleton definition ───────────────────────────────────────────────────

export interface SkelDef {
  /** Fixed offset of each joint from its parent, in the parent's frame (the pelvis's is 0: the pose places it). */
  off: Vec3[];
  /** Body side of each joint: +1 the fighter's right, −1 left, 0 the midline. */
  side: number[];
  /** Bone length into each joint, |off|. */
  len: number[];
  /** Pelvis height in the bind (the hip joint centre), m. */
  hipY: number;
  /** The head centre sits this far up the head joint's +y, m. */
  headCentre: number;
  /** The shoulder-line centre (the body capsule's top end) sits this far up the chest joint's +y, m. */
  shoulderLine: number;
  upperArm: number; forearm: number; thigh: number; shin: number;
  /** The three spinal joints' shares of the spine's bend and twist, normalised. */
  spineShare: [number, number, number];
}

/** The skeleton of a body. Arm and leg lengths are BodyDims' own, so reach is unchanged (arms_test pins it). */
export function skelDef(body: BodyDims, stance: Stance, cfg: Config): SkelDef {
  const lead = handLateralSign('lead', stance);
  const lat = [lead, -lead];
  const S = body.shoulderY - body.hipY;
  const a1 = S * cfg.skelSpine1At;
  const a2 = Math.max(a1 + 0.01 * S, S * cfg.skelSpine2At);
  const a3 = Math.min(S * 0.98, Math.max(a2 + 0.01 * S, S * cfg.skelChestAt));
  const neckBaseY = body.shoulderY + body.chestLen * cfg.skelNeckBase;
  const headJointY = Math.max(neckBaseY + 0.01, body.headY - body.headR * cfg.skelHeadPivot);
  const halfW = body.shoulderW / 2, inset = cfg.skelClavicleInset;
  const hipJ = body.hipW / 2 * cfg.rigHipJoint;
  const off: Vec3[] = [];
  const side: number[] = [];
  for (let j = 0; j < JOINT_COUNT; j++) { off.push({ x: 0, y: 0, z: 0 }); side.push(0); }
  off[SKJ.spine1] = { x: 0, y: a1, z: 0 };
  off[SKJ.spine2] = { x: 0, y: a2 - a1, z: 0 };
  off[SKJ.chest] = { x: 0, y: a3 - a2, z: 0 };
  off[SKJ.neck] = { x: 0, y: neckBaseY - (body.hipY + a3), z: 0 };
  off[SKJ.head] = { x: 0, y: headJointY - neckBaseY, z: 0 };
  for (let i = 0; i < 2; i++) {
    const a = skelArm(i), l = skelLeg(i), s = lat[i]!;
    off[a.clav] = { x: 0, y: S - a3, z: s * halfW * inset };
    off[a.upper] = { x: 0, y: 0, z: s * halfW * (1 - inset) };
    off[a.fore] = { x: 0, y: -body.upperArm, z: 0 };
    off[a.hand] = { x: 0, y: -body.forearm, z: 0 };
    off[l.thigh] = { x: 0, y: 0, z: s * hipJ };
    off[l.shin] = { x: 0, y: -body.thigh, z: 0 };
    off[l.foot] = { x: 0, y: -body.shin, z: 0 };
    for (const j of [a.clav, a.upper, a.fore, a.hand, l.thigh, l.shin, l.foot]) side[j] = s;
  }
  const sh = [Math.max(0, cfg.skelSpineShare1), Math.max(0, cfg.skelSpineShare2), Math.max(0, cfg.skelSpineShare3)];
  const st = sh[0]! + sh[1]! + sh[2]! || 1;
  return {
    off, side, len: off.map(o => Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z)),
    hipY: body.hipY, headCentre: body.headY - headJointY, shoulderLine: S - a3,
    upperArm: body.upperArm, forearm: body.forearm, thigh: body.thigh, shin: body.shin,
    spineShare: [sh[0]! / st, sh[1]! / st, sh[2]! / st],
  };
}

// ── Limits ────────────────────────────────────────────────────────────────────

/**
 * A joint's limits, radians, for the RIGHT side (a left joint is mirrored first). `twist` is the frame axis the
 * twist is about; lo/hi index by axis (x, y, z): at the twist axis the twist range, at the other two the swing's
 * rotation-vector components. Conventions in the joint's parent frame (+x forward, +y up, +z right):
 *   spine / neck / head (twist y): x + = bend toward the right, y + = turn to the left, z + = extension (back), − = flexion
 *   clavicle (twist z):            x + = depression, − = elevation; y + = protraction, − = retraction
 *   shoulder / hip (twist y):      x + = adduction, − = abduction; y + = internal rotation; z + = flexion (forward)
 *   elbow (twist y):               z = flexion ≥ 0 only (a hinge); x and y fixed at 0
 *   knee (twist y):                z = −flexion ≤ 0 only (the shin folds back); x and y fixed at 0
 *   wrist (twist y):               y + = pronation (forearm twist, carried here); x deviation; z flexion / extension
 *   ankle (twist y):               z + = dorsiflexion, − = plantarflexion; x inversion / eversion; y the foot's turn
 */
export interface JointLimit { twist: number; lo: [number, number, number]; hi: [number, number, number] }

export function skelLimits(cfg: Config): (JointLimit | null)[] {
  const d = (v: number): number => v * DEG;
  const spinal = (flex: number, ext: number, lat: number, rot: number): JointLimit =>
    ({ twist: 1, lo: [-d(lat), -d(rot), -d(flex)], hi: [d(lat), d(rot), d(ext)] });
  const byKind: Record<JointKind, JointLimit | null> = {
    root: null,
    lumbar: spinal(cfg.skelLumbarFlex, cfg.skelLumbarExt, cfg.skelLumbarLat, cfg.skelLumbarRot),
    spine: spinal(cfg.skelSpineFlex, cfg.skelSpineExt, cfg.skelSpineLat, cfg.skelSpineRot),
    chest: spinal(cfg.skelChestFlex, cfg.skelChestExt, cfg.skelChestLat, cfg.skelChestRot),
    neck: spinal(cfg.skelNeckFlex, cfg.skelNeckExt, cfg.skelNeckLat, cfg.skelNeckRot),
    head: spinal(cfg.skelHeadFlex, cfg.skelHeadExt, cfg.skelHeadLat, cfg.skelHeadRot),
    clavicle: { twist: 2, lo: [-d(cfg.skelClavElevate), -d(cfg.skelClavRetract), -d(cfg.skelClavTwist)], hi: [d(cfg.skelClavDepress), d(cfg.skelClavProtract), d(cfg.skelClavTwist)] },
    shoulder: { twist: 1, lo: [-d(cfg.skelShoulderAbd), -d(cfg.skelShoulderExtRot), -d(cfg.skelShoulderExt)], hi: [d(cfg.skelShoulderAdd), d(cfg.skelShoulderIntRot), d(cfg.skelShoulderFlex)] },
    elbow: { twist: 1, lo: [0, 0, 0], hi: [0, 0, d(cfg.skelElbowFlex)] },
    wrist: { twist: 1, lo: [-d(cfg.skelWristDev), -d(cfg.skelForearmSupinate), -d(cfg.skelWristFlex)], hi: [d(cfg.skelWristDev), d(cfg.skelForearmPronate), d(cfg.skelWristFlex)] },
    hip: { twist: 1, lo: [-d(cfg.skelHipAbd), -d(cfg.skelHipRot), -d(cfg.skelHipExt)], hi: [d(cfg.skelHipAdd), d(cfg.skelHipRot), d(cfg.skelHipFlex)] },
    knee: { twist: 1, lo: [0, 0, -d(cfg.skelKneeFlex)], hi: [0, 0, 0] },
    ankle: { twist: 1, lo: [-d(cfg.skelAnkleInv), -d(cfg.skelAnkleRot), -d(cfg.skelAnklePlantar)], hi: [d(cfg.skelAnkleInv), d(cfg.skelAnkleRot), d(cfg.skelAnkleDorsi)] },
  };
  return JOINT_KIND.map(k => byKind[k]);
}

/** A joint's angles as its limits read them: [x, y, z] with the twist at the twist axis (right-side convention). */
export function jointAngles(q: Quat, lim: JointLimit, side: number): [number, number, number] {
  const { twist, swing } = swingTwist(side < 0 ? qMirror(q) : q, lim.twist);
  const out: [number, number, number] = [swing.x, swing.y, swing.z];
  out[lim.twist] = twist;
  return out;
}

/** The largest swing a clamp leaves, rad: just short of a half turn so the log map stays unique (idempotence). */
const SWING_MAX = Math.PI - 1e-4;

/** The two swing axes of a joint whose twist is about `t`. */
const swingAxes = (t: number): [number, number] => (t === 0 ? [1, 2] : t === 1 ? [0, 2] : [0, 1]);

/**
 * The swing's limit is an ELLIPTICAL CONE per quadrant (the shape PhysX-style swing limits use): in the quadrant the
 * swing points into, the semi-axes are that side's limits, and a swing outside is scaled back radially onto the
 * ellipse. So two motions cannot each reach their own maximum at once (a box in exponential-map space let the
 * shoulder be both fully abducted and fully extended, and inflated a 30° horizontal extension at 90° abduction to
 * read as 48° of extension). A zero-width axis (a hinge's side bend) is held at 0. Every range must contain 0.
 * Returns how far outside the swing was (≤ 1 = inside).
 */
function clampSwing(a: [number, number, number], lim: JointLimit): number {
  const [i, j] = swingAxes(lim.twist);
  const A = a[i]! >= 0 ? lim.hi[i]! : -lim.lo[i]!, B = a[j]! >= 0 ? lim.hi[j]! : -lim.lo[j]!;
  if (!(A > 0)) a[i] = 0;
  if (!(B > 0)) a[j] = 0;
  if (!(A > 0) && !(B > 0)) return 0;
  if (!(A > 0)) { const v = a[j]!; a[j] = v < lim.lo[j]! ? lim.lo[j]! : v > lim.hi[j]! ? lim.hi[j]! : v; return Math.abs(v / B); }
  if (!(B > 0)) { const v = a[i]!; a[i] = v < lim.lo[i]! ? lim.lo[i]! : v > lim.hi[i]! ? lim.hi[i]! : v; return Math.abs(v / A); }
  const e = (a[i]! / A) ** 2 + (a[j]! / B) ** 2;
  if (e > 1) { const k = 1 / Math.sqrt(e); a[i] = a[i]! * k; a[j] = a[j]! * k; }
  return Math.sqrt(e);
}

/** Whether a joint rotation is inside its limits, within `eps` (rad): twist range and the swing cone. */
export function withinLimits(q: Quat, lim: JointLimit | null, side: number, eps = 1e-6): boolean {
  if (!lim) return true;
  const a = jointAngles(qNorm(q), lim, side);
  const t = lim.twist;
  if (a[t]! < lim.lo[t]! - eps || a[t]! > lim.hi[t]! + eps) return false;
  const [i, j] = swingAxes(t);
  const A = a[i]! >= 0 ? lim.hi[i]! : -lim.lo[i]!, B = a[j]! >= 0 ? lim.hi[j]! : -lim.lo[j]!;
  if (!(A > 0) && Math.abs(a[i]!) > eps) return false;
  if (!(B > 0) && Math.abs(a[j]!) > eps) return false;
  const ea = A > 0 ? a[i]! / (A + eps) : 0, eb = B > 0 ? a[j]! / (B + eps) : 0;
  return ea * ea + eb * eb <= 1 + 1e-9;
}

/** One local rotation clamped to its joint's limits. Idempotent: clampJoint(clampJoint(q)) = clampJoint(q). */
export function clampJoint(q: Quat, lim: JointLimit | null, side: number): Quat {
  if (!lim) return qNorm(q);
  const a = jointAngles(qNorm(q), lim, side);
  const t = lim.twist;
  a[t] = a[t]! < lim.lo[t]! ? lim.lo[t]! : a[t]! > lim.hi[t]! ? lim.hi[t]! : a[t]!;
  clampSwing(a, lim);
  const sw: Vec3 = { x: t === 0 ? 0 : a[0], y: t === 1 ? 0 : a[1], z: t === 2 ? 0 : a[2] };
  const m = Math.sqrt(sw.x * sw.x + sw.y * sw.y + sw.z * sw.z);
  if (m > SWING_MAX) { const k = SWING_MAX / m; sw.x *= k; sw.y *= k; sw.z *= k; }
  const out = qNorm(qMul(qFromRotVec(sw), qAxis(t, a[t]!)));
  return side < 0 ? qMirror(out) : out;
}

// ── Poses ─────────────────────────────────────────────────────────────────────

export function poseQ(p: SkelPose, j: number): Quat {
  const b = j * 4;
  return { x: p.q[b]!, y: p.q[b + 1]!, z: p.q[b + 2]!, w: p.q[b + 3]! };
}
export function setPoseQ(p: SkelPose, j: number, q: Quat): void {
  const b = j * 4;
  p.q[b] = q.x; p.q[b + 1] = q.y; p.q[b + 2] = q.z; p.q[b + 3] = q.w;
}
/** The root's rotation: about world +y by −yaw, so root +x is forward(yaw). */
export const rootQuat = (yaw: number): Quat => qAxisAngle(0, 1, 0, -yaw);

/** Standing in the bind: every joint unrotated, the pelvis at its bind height over the floor point. */
export function restPose(def: SkelDef, x: number, z: number, yaw: number): SkelPose {
  const q: number[] = [];
  for (let j = 0; j < JOINT_COUNT; j++) q.push(0, 0, 0, 1);
  return { root: [x, z, yaw, 0, def.hipY, 0], q };
}
export const cloneSkel = (p: SkelPose): SkelPose => ({ root: p.root.slice(), q: p.q.slice() });

/** Clamp every joint to its limits (the last step of every pipeline). Mutates and returns `p`. Idempotent. */
export function clampPose(def: SkelDef, p: SkelPose, lim: readonly (JointLimit | null)[]): SkelPose {
  for (let j = 0; j < JOINT_COUNT; j++) setPoseQ(p, j, clampJoint(poseQ(p, j), lim[j] ?? null, def.side[j]!));
  return p;
}

/** Render interpolation between two ticks' poses: root and pelvis lerped (yaw the short way), every joint slerped. */
export function lerpPose(a: SkelPose, b: SkelPose, t: number, out?: SkelPose): SkelPose {
  const o = out ?? { root: a.root.slice(), q: a.q.slice() };
  o.root[0] = a.root[0]! + (b.root[0]! - a.root[0]!) * t;
  o.root[1] = a.root[1]! + (b.root[1]! - a.root[1]!) * t;
  o.root[2] = a.root[2]! + angleDelta(a.root[2]!, b.root[2]!) * t;
  for (let k = 3; k < 6; k++) o.root[k] = a.root[k]! + (b.root[k]! - a.root[k]!) * t;
  for (let j = 0; j < JOINT_COUNT; j++) setPoseQ(o, j, qSlerp(poseQ(a, j), poseQ(b, j), t));
  return o;
}

// ── Forward kinematics ────────────────────────────────────────────────────────

/** World joint positions and orientations. */
export interface SkelFK { p: Vec3[]; r: Quat[] }

/** FK of joints 0 … upTo−1 (parents first, so a prefix is self-contained). */
export function fk(def: SkelDef, pose: SkelPose, upTo: number = JOINT_COUNT, out?: SkelFK): SkelFK {
  const o = out ?? { p: [], r: [] };
  const R0 = rootQuat(pose.root[2]!);
  const pl = qRot(R0, { x: pose.root[3]!, y: pose.root[4]!, z: pose.root[5]! });
  o.p[0] = { x: pose.root[0]! + pl.x, y: pl.y, z: pose.root[1]! + pl.z };
  o.r[0] = qMul(R0, poseQ(pose, 0));
  for (let j = 1; j < upTo; j++) {
    const par = JOINT_PARENT[j]!;
    const rp = o.r[par]!, pp = o.p[par]!;
    const d = qRot(rp, def.off[j]!);
    o.p[j] = { x: pp.x + d.x, y: pp.y + d.y, z: pp.z + d.z };
    o.r[j] = qNorm(qMul(rp, poseQ(pose, j)));
  }
  return o;
}
/** The head centre (the hit sphere's centre) from an FK that reached the head. */
export function skelHeadCentre(def: SkelDef, f: SkelFK): Vec3 {
  const d = qRot(f.r[SKJ.head]!, { x: 0, y: def.headCentre, z: 0 }), p = f.p[SKJ.head]!;
  return { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z };
}
/** The shoulder-line centre (the body capsule's top end) from an FK that reached the chest. */
export function skelShoulderLine(def: SkelDef, f: SkelFK): Vec3 {
  const d = qRot(f.r[SKJ.chest]!, { x: 0, y: def.shoulderLine, z: 0 }), p = f.p[SKJ.chest]!;
  return { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z };
}

// ── Two-bone IK ───────────────────────────────────────────────────────────────

export interface TwoBoneRot {
  /** Local rotation of the upper bone (relative to `parentRot`) and of the lower bone (a pure hinge about local z). */
  upper: Quat; lower: Quat;
  /** World middle joint (elbow / knee) and end (hand / ankle). The end falls short of the target when it is out of reach. */
  mid: Vec3; end: Vec3;
  /** The hinge's flexion, rad (0 = straight). */
  flex: number;
}

/**
 * Analytic two-bone IK returning joint ROTATIONS (SOURCES §8). `root` is the upper joint's world position,
 * `parentRot` the world rotation of its parent's frame, `pole` a world direction the middle joint bends toward
 * (only its part perpendicular to root→target matters). The reach is clamped so the limb never stretches and the
 * hinge stays inside [minFlex, maxFlex]. `fold` = +1 for an arm (the forearm folds toward the upper arm's local +x,
 * the flexor side), −1 for a leg (the shin folds toward −x; +x is the kneecap). Bones hang down local −y; the
 * hinge axis is local +z, the same convention as the rig's bones.
 */
export function solveTwoBone(root: Vec3, parentRot: Quat, target: Vec3, pole: Vec3, l1: number, l2: number, fold: number, minFlex: number, maxFlex: number): TwoBoneRot {
  let dx = target.x - root.x, dy = target.y - root.y, dz = target.z - root.z;
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-9) { const down = qRot(parentRot, { x: 0, y: -1, z: 0 }); dx = down.x; dy = down.y; dz = down.z; d = 0; }
  else { dx /= d; dy /= d; dz /= d; }
  const dMax = Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(minFlex)));
  const dMin = Math.sqrt(Math.max(0, l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(maxFlex)));
  const dc = Math.max(Math.max(dMin, 1e-6), Math.min(dMax, d));
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  // The bend side: the pole's part perpendicular to the reach line (fallback: the parent's back / front).
  let pd = pole.x * dx + pole.y * dy + pole.z * dz;
  let px = pole.x - dx * pd, py = pole.y - dy * pd, pz = pole.z - dz * pd;
  if (px * px + py * py + pz * pz < 1e-10) {
    const fb = qRot(parentRot, { x: -fold, y: 0, z: 0 });
    pd = fb.x * dx + fb.y * dy + fb.z * dz;
    px = fb.x - dx * pd; py = fb.y - dy * pd; pz = fb.z - dz * pd;
    if (px * px + py * py + pz * pz < 1e-10) { px = dy; py = -dx; pz = 0; if (px * px + py * py < 1e-10) { px = 0; py = dz; pz = -dy; } }
  }
  const pl = Math.sqrt(px * px + py * py + pz * pz);
  px /= pl; py /= pl; pz /= pl;
  const mid: Vec3 = { x: root.x + dx * a + px * h, y: root.y + dy * a + py * h, z: root.z + dz * a + pz * h };
  const end: Vec3 = { x: root.x + dx * dc, y: root.y + dy * dc, z: root.z + dz * dc };
  // Upper bone frame: −y along the bone, +x toward the side the lower bone folds to (×fold), +z = x × y (the hinge).
  const u: Vec3 = { x: (mid.x - root.x) / l1, y: (mid.y - root.y) / l1, z: (mid.z - root.z) / l1 };
  const n: Vec3 = { x: (h * dx - a * px) / l1, y: (h * dy - a * py) / l1, z: (h * dz - a * pz) / l1 };
  const X: Vec3 = { x: n.x * fold, y: n.y * fold, z: n.z * fold };
  const Y: Vec3 = { x: -u.x, y: -u.y, z: -u.z };
  const Z: Vec3 = { x: X.y * Y.z - X.z * Y.y, y: X.z * Y.x - X.x * Y.z, z: X.x * Y.y - X.y * Y.x };
  const upperW = qFromBasis(X, Y, Z);
  const cosB = (a * (dc - a) - h * h) / (l1 * l2);   // u · (end − mid)/l2
  const flex = Math.acos(cosB < -1 ? -1 : cosB > 1 ? 1 : cosB);
  return { upper: qNorm(qMul(qConj(parentRot), upperW)), lower: qAxis(2, fold * flex), mid, end, flex };
}

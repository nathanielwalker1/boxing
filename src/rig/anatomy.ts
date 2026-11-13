/**
 * rig/anatomy.ts — the body: torso, arms and legs as lofted skin (overhaul
 * 2026-11-11). Each is a chain of rings authored in the bind pose: a table of
 * stations (how wide, how deep, how square, where the centre sits) with muscle
 * bumps added on top, cut into rings and skinned with blended weights.
 *
 *   torso : crotch → pelvis → waist → ribcage → pecs/lats → shoulder yoke →
 *           trapezius → neck (one skin, hips/spine/chest/neck/head weights;
 *           its top corners follow the shoulder bones)
 *   arm   : deltoid cap (it belongs to the arm, turned half-way to the chest) →
 *           biceps/triceps → elbow → forearm → wrist (under the glove's cuff)
 *   leg   : hip → quad/hamstring → knee → calf (high on the shin) → ankle
 *
 * The numbers in the tables are fractions of the BodyDims / RigDims sizes, so
 * every morph and every height scales them. Shape tables live here; anything
 * a slider should move is a `rig body` config key.
 */
import * as THREE from 'three';
import { addGrid, bump, KIND, rowParams, sampleKeys, sgnPow, smooth01, angDiff, type BW } from './geo';
import { BONE, armBones, legBones, type Ctx } from './skeleton';

const TAU = Math.PI * 2;

/**
 * Anim Phase 1.2: the pelvis / thigh weight field. A point's share of leg `i`'s thigh (0 = the pelvis only, 1 = the thigh only)
 * depends on its depth below the hip joint (a smooth ramp over ± rigHipBlend thigh radii) and, for a surface that is not the
 * leg's own (the torso's lower rings, the trunks' waist panel), on which side of the body it is on. Every surface that passes
 * through this region (skin, trunks) uses it, so two surfaces at the same place always move together and never slide through
 * each other as the thigh swings.
 */
export function thighShare(c: Ctx, i: number, p: THREE.Vector3, ownLeg: boolean): number {
  const J = c.bind[legBones(i).thigh]!;
  const R3 = c.d.thighR, bl = R3 * c.cfg.rigHipBlend;
  const a = smooth01((J.y - p.y + bl) / (2 * bl));
  if (ownLeg) return a;
  const f = smooth01((p.z * Math.sign(J.z) + 0.9 * R3) / (1.9 * R3));
  return a * f;
}

/** Scale `w` by what is left after leg i's share and add the thigh bone with that share. */
function addThigh(c: Ctx, w: BW[], p: THREE.Vector3): void {
  for (let i = 0; i < 2; i++) {
    const s = thighShare(c, i, p, false);
    if (s < 0.01) continue;
    for (const e of w) e[1] *= 1 - s;
    w.push([legBones(i).thigh, s]);
  }
}

/** Muscle relief for this fighter: the config scale, the muscle morph, and fat smoothing it away. */
export function muscleDef(c: Ctx): number {
  const fat = Math.max(0, c.m.bodyFat), lean = Math.max(0, -c.m.bodyFat);
  return Math.max(0, c.cfg.rigMuscleDef * (1 + c.m.muscle * c.cfg.rigMorphMuscleDef + lean * 0.5) * (1 - 0.8 * fat));
}

// ── Torso ────────────────────────────────────────────────────────────────────

export interface TorsoShape {
  /** Surface point of the torso at height y and parameter angle θ (0 = front, π/2 = the fighter's right). */
  point(y: number, th: number, out: THREE.Vector3, inflate?: number): void;
  /** Skin weights for a torso-following point. */
  weights(p: THREE.Vector3): BW[];
  yBottom: number; yTop: number; waistY: number; neckTopY: number;
  keys: number[]; counts: number[];
}

export function torsoShape(c: Ctx): TorsoShape {
  const { body: b, d, m, cfg } = c;
  const hy = b.hipY, sy = b.shoulderY, sp = b.spineLen, cl = b.chestLen, R = b.bodyR;
  // The referee is older and softer: a belly under the shirt whatever his morph says.
  const fat = Math.max(0, m.bodyFat) + (c.spec.outfit ? cfg.rigRefBelly : 0);
  const def = muscleDef(c);
  const sw2 = b.shoulderW / 2;
  const chestHalf = sw2 * cfg.rigChestWidth * (1 + 0.04 * m.muscle);
  const waistHalf = d.waistW / 2;
  const pelvisHalf = b.hipW / 2 * cfg.rigPelvisWidth;
  const yokeHalf = sw2 * 0.98;
  const chestF = d.chestDepth * (1 + 0.1 * fat), chestB = d.chestDepth * 0.9;
  const waistF = R * cfg.rigWaistDepth * (1 + 0.25 * fat), waistB = R * cfg.rigWaistDepth * 0.9 * (1 + 0.15 * fat);
  const nr = d.neckR;
  const trap = 1 + 0.35 * m.muscle + 0.9 * Math.max(0, m.neck) * cfg.rigMorphNeckR;
  const neckTopY = b.headY - b.headR * 0.42;
  const nb = cfg.rigNeckBase;
  const neck0 = sy + cl * nb;

  // Stations: y, half-width, front depth, back depth, squareness.
  const st: number[][] = [
    [hy - R * 0.62, 0, 0, 0, 2],
    [hy - R * 0.5, pelvisHalf * 0.5, R * 0.36, R * 0.42, 2.1],
    [hy - R * 0.25, pelvisHalf * 0.86, R * 0.6, R * 0.72, 2.3],
    [hy + sp * 0.05, pelvisHalf, R * 0.68, R * 0.8, 2.4],
    [hy + sp * 0.36, (pelvisHalf * 0.6 + waistHalf * 0.4), waistF * 0.98, waistB * 1.02, 2.35],
    [hy + sp * 0.64, waistHalf, waistF, waistB, 2.25],
    [hy + sp * 1.0, waistHalf * 0.5 + chestHalf * 0.5, waistF * 0.45 + chestF * 0.55, waistB * 0.4 + chestB * 0.6, 2.35],
    [sy - cl * 0.52, chestHalf * 0.985, chestF * 0.95, chestB * 0.98, 2.5],
    [sy - cl * 0.3, chestHalf, chestF, chestB, 2.6],
    // The yoke reaches the shoulder joints, so the inner half of each deltoid sits inside it; it rounds over
    // (lower squareness) and the trapezius slopes from the corner up into the neck.
    [sy - cl * 0.1, yokeHalf * 1.0, chestF * 0.88, chestB * 1.0, 2.7],
    [sy + cl * 0.035, yokeHalf * 1.0, chestF * 0.7, chestB * 0.92, 2.4],
    // Phase 1.2: the trapezius is a long line from the shoulder tip up into the neck (a real boxer's slopes about 25°), and the neck leaves it
    // low, so a visible neck stands between the ridge and the jaw. The stations are fractions of the way from the yoke's top to the neck base.
    // (Linear down the slope, no shelf: an annulus of near-constant height between the yoke and the neck read as a collar.)
    [sy + cl * (0.035 + (nb - 0.035) * 0.38), Math.max(nr * 2.2, yokeHalf * 0.74 * Math.min(1.15, trap)), Math.max(chestF * 0.5, nr * 1.35), chestB * 0.84, 2.4],
    [sy + cl * (0.035 + (nb - 0.035) * 0.7), Math.max(nr * 1.65, yokeHalf * 0.5 * Math.min(1.25, trap)), nr * 1.25, nr * 1.5 * Math.min(1.2, trap), 2.2],
    [neck0, nr * 1.14, nr * 1.08, nr * 1.2, 2.1],
    [(neck0 + neckTopY) / 2, nr, nr * 0.95, nr * 1.02, 2],
    [neckTopY, nr * 1.02, nr * 0.98, nr * 1.05, 2],
  ];
  for (let k = 1; k < st.length; k++) if (st[k]![0]! < st[k - 1]![0]! + 0.004) st[k]![0] = st[k - 1]![0]! + 0.004;
  const keys = st.map(s => s[0]!);
  const vals = st.map(s => s.slice(1));
  // Denser through the abdomen and ribcage: the abs and obliques are relief a couple of centimetres high and a row every 3 cm lost them.
  const counts = [1, 2, 2, 3, 4, 5, 4, 3, 3, 3, 3, 3, 3, 2, 2];
  const row = [0, 0, 0, 0];

  const absY = [hy + sp * 0.5, hy + sp * 0.78, hy + sp * 1.06];
  const pecY = sy - cl * 0.3;

  /** Muscle relief at (y, lateral z, front/back/side weights), metres along the outward normal. */
  const relief = (y: number, z: number, cf: number, sn: number): number => {
    const front = smooth01((cf + 0.1) / 0.45), back = smooth01((-cf + 0.1) / 0.45), side = smooth01((Math.abs(sn) - 0.55) / 0.35);
    const az = Math.abs(z);
    let h = 0;
    if (front > 0) {
      // Pecs: a slab each side, sharper along its lower edge; the sternum between them.
      const py = y - pecY;
      const pec = bump((az - chestHalf * 0.47) / (chestHalf * 0.6)) * bump(py / (py > 0 ? cl * 0.27 : cl * 0.16));
      h += front * def * R * 0.15 * pec;
      h -= front * def * R * 0.045 * bump(az / (chestHalf * 0.16)) * bump((y - (sy - cl * 0.27)) / (cl * 0.24));
      // Abs: three rows either side of the linea alba.
      for (const ay of absY) h += front * def * R * 0.085 * bump((az - waistHalf * 0.21) / (waistHalf * 0.24)) * bump((y - ay) / (sp * 0.15));
      h -= front * def * R * 0.05 * bump(az / (waistHalf * 0.12)) * bump((y - (hy + sp * 0.85)) / (sp * 0.6));
      // Belly: fat pushes the front out, lowest and furthest just above the waistband.
      h += front * fat * R * cfg.rigMorphFatBelly * bump(az / (waistHalf * 1.7)) * bump((y - (hy + sp * 0.5)) / (sp * 0.95));
    }
    if (side > 0) {
      // Obliques over the hip, and the love handle fat adds.
      h += side * (def * R * 0.03 + fat * R * 0.16) * bump((y - (hy + sp * 0.42)) / (sp * 0.4));
      // Serratus: three small ridges under the armpit.
      for (let k = 0; k < 3; k++) h += side * front * def * R * 0.014 * bump((y - (sy - cl * (0.62 + 0.13 * k))) / (cl * 0.06));
    }
    if (back > 0) {
      // Spine groove with the erectors either side; lats; the shoulder blades under the traps.
      h -= back * (0.6 + 0.4 * def) * R * 0.06 * bump(az / (waistHalf * 0.2)) * bump((y - (hy + sp * 0.9)) / (sp * 1.1));
      h += back * def * R * 0.03 * bump((az - waistHalf * 0.3) / (waistHalf * 0.3)) * bump((y - (hy + sp * 0.55)) / (sp * 0.6));
      h += back * def * R * 0.075 * bump((az - chestHalf * 0.8) / (chestHalf * 0.5)) * bump((y - (sy - cl * 0.5)) / (cl * 0.42));
      h += back * def * R * 0.055 * bump((az - chestHalf * 0.5) / (chestHalf * 0.42)) * bump((y - (sy - cl * 0.16)) / (cl * 0.2));
    }
    return h;
  };

  const point = (y: number, th: number, out: THREE.Vector3, inflate = 0): void => {
    sampleKeys(keys, vals, y, row);
    const cf = Math.cos(th), sn = Math.sin(th);
    // Behind the shoulders the corners are filled (rear deltoid, the muscles over the blade): squarer at the back.
    const n = row[3]! + (cf < 0 ? 1.1 * bump((y - (sy - cl * 0.04)) / (cl * 0.3)) : 0);
    const depth = cf >= 0 ? row[1]! : row[2]!;
    let x = depth * sgnPow(cf, n), z = row[0]! * sgnPow(sn, n);
    const r = Math.hypot(x, z);
    if (r > 1e-6) {
      const h = relief(y, z, cf, sn) + inflate;
      // Along the outward normal of the ellipse, not the radius: a bump on the flank pushes sideways.
      let nx = x / Math.max(1e-6, depth * depth), nz = z / Math.max(1e-6, row[0]! * row[0]!);
      const nl = Math.hypot(nx, nz);
      nx /= nl; nz /= nl;
      x += nx * h; z += nz * h;
    }
    out.set(x, y, z);
  };

  // Weights by height, with the top corners following the shoulder bones.
  const yb = hy + sp * 0.3, ym = (hy + sy) / 2, yc = sy - cl * 0.5;
  const shR = d.upperArmR * 3.0;
  // anim Phase 1.1 (skelOn): the torso rides the real spine — pelvis → lumbar → low thoracic → chest by height, each
  // spinal joint blending its two bones over ± skelSkinBlend × (hips → shoulder line) around it.
  const S = sy - hy, sb = S * cfg.skelSkinBlend;
  const jy = [hy + S * cfg.skelSpine1At, hy + S * cfg.skelSpine2At, hy + S * cfg.skelChestAt];
  const SPINE_BONES = [BONE.hips, BONE.spine, BONE.spine2, BONE.chest];
  const spineWeights = (y: number, w: BW[]): void => {
    // cumulative: c[k] = how far past joint k the point is (0 below its zone, 1 above); bone k gets c[k] − c[k + 1].
    const c = [1, ...jy.map(j => smooth01((y - (j - sb)) / (2 * sb))), 0];
    for (let k = 0; k < 4; k++) { const v = c[k]! - c[k + 1]!; if (v > 1e-4) w.push([SPINE_BONES[k]!, v]); }
  };
  // The chest → neck → head blend runs from a little below the neck base to the top of the neck (the head takes the last third).
  const nStart = neck0 - cl * 0.06;
  const weights = (p: THREE.Vector3): BW[] => {
    const w: BW[] = [];
    const y = p.y;
    if (cfg.skelOn && y <= nStart) spineWeights(y, w);
    else if (y <= yb) w.push([BONE.hips, 1]);
    else if (y <= ym) { const t = smooth01((y - yb) / (ym - yb)); w.push([BONE.hips, 1 - t], [BONE.spine, t]); }
    else if (y <= yc) { const t = smooth01((y - ym) / (yc - ym)); w.push([BONE.spine, 1 - t], [BONE.chest, t]); }
    else if (y <= nStart) w.push([BONE.chest, 1]);
    else {
      const t = Math.min(1, (y - nStart) / Math.max(1e-3, neckTopY - nStart));
      // Three smooth stages: chest → neck over the lower half, neck → head over the upper (the neck bone alone is only the middle).
      const wc = 1 - smooth01(t / 0.5), wh = smooth01((t - 0.5) / 0.5);
      w.push([BONE.chest, wc], [BONE.neck, Math.max(0, 1 - wc - wh)], [BONE.head, wh]);
    }
    if (y < hy + c.d.thighR * cfg.rigHipBlend) addThigh(c, w, p);   // the whole support of the hip field (a shorter cut-off left a step in the weights)
    // The shoulder corner: within shR of a shoulder joint the skin leans toward that arm's shoulder bone.
    for (let i = 0; i < 2; i++) {
      const j = c.bind[armBones(i).shoulder]!;
      const dist = Math.hypot(p.x - j.x, (p.y - j.y) * 1.3, p.z - j.z);
      const s = 0.82 * bump(dist / shR);   // high, so the corner stays with the sim's shoulder while the ribcage blades under it (rigStanceChestYawDeg)
      // skelOn: the corner goes to the CLAVICLE, a child of the chest — the shoulder is on the ribcage now.
      if (s > 0.01) { for (const e of w) e[1] *= 1 - s; w.push([cfg.skelOn ? (i === 0 ? BONE.clav0 : BONE.clav1) : armBones(i).shoulder, s]); }
    }
    return w;
  };

  return { point, weights, yBottom: keys[0]!, yTop: neckTopY, waistY: hy + sp * 0.64, neckTopY, keys, counts };
}

export function buildTorso(c: Ctx, shape: TorsoShape): void {
  const ys = rowParams(shape.keys, shape.counts, c.low);
  const cols = c.low ? 20 : 44;
  const outfit = !!c.spec.outfit;
  addGrid(c.g, {
    rows: ys.length, cols, wrap: true,
    // u = 0.5 is the front (θ = 0), the seam runs down the spine; u grows toward the fighter's LEFT, so paint reads the right way round from in front.
    point: (i, j, out) => shape.point(ys[i]!, (0.5 - j / cols) * TAU, out, outfit ? 0.006 : 0),
    weights: p => shape.weights(p),
    rect: c.rect('torso'),
    kind: outfit ? KIND.cloth : KIND.skin,
    uv: (i, j) => [j / cols, 1 - (ys[i]! - shape.yBottom) / (shape.yTop - shape.yBottom)],
    ao: outfit ? c.cfg.rigAoStrength * 0.4 : c.cfg.rigAoStrength,
  });
}

// ── Limbs ────────────────────────────────────────────────────────────────────

export interface LimbBump { s: number; ss: number; phi: number; sphi: number; amp: number }

/** A limb loft down −y from a joint: stations [s, rx (front/back), rz (lateral), cx, cz], bumps by angle. */
export function limbPoint(keys: readonly number[], vals: readonly (readonly number[])[], bumps: readonly LimbBump[], s: number, phi: number, row: number[], out: THREE.Vector3): void {
  sampleKeys(keys, vals, s, row);
  let k = 1;
  for (const bm of bumps) {
    const a = bump((s - bm.s) / bm.ss);
    if (a > 0) k += bm.amp * a * bump(angDiff(phi, bm.phi) / bm.sphi);
  }
  out.set(row[2]! + row[0]! * k * Math.cos(phi), -s, row[3]! + row[1]! * k * Math.sin(phi));
}

/** Three-bone blend across a hinge at `sj`: upper → helper → lower over ±w. */
function hingeWeights(s: number, sj: number, w: number, upper: number, helper: number, lower: number, out: BW[]): void {
  const t = (s - sj) / w;
  if (t <= -1) out.push([upper, 1]);
  else if (t >= 1) out.push([lower, 1]);
  else {
    const a = smooth01(Math.abs(t));
    out.push([t < 0 ? upper : lower, a], [helper, 1 - a]);
  }
}

/** The arm loft's extent down from the shoulder joint: top of the deltoid cap → the wrist (the painter maps v across it). */
export function armSpan(c: Ctx): { s0: number; s1: number } {
  const delt = c.cfg.rigDeltoid * (1 + 0.08 * c.m.muscle);
  // The referee's hands are bare: the forearm runs to the wrist. A glove's cuff hides the rest.
  return { s0: -c.d.upperArmR * delt * 0.55, s1: c.body.upperArm + c.body.forearm - c.body.gloveR * (c.spec.outfit ? c.cfg.rigHandScale * 0.9 : 0.6) };
}

export function buildArm(c: Ctx, i: number, torso: TorsoShape): void {
  const { body: b, d, cfg } = c;
  const bones = armBones(i);
  const J = c.bind[bones.upper]!;
  const L1 = b.upperArm, L2 = b.forearm, R1 = d.upperArmR, R2 = d.forearmR;
  const def = muscleDef(c);
  const delt = cfg.rigDeltoid * (1 + 0.08 * c.m.muscle);
  const wristS = armSpan(c).s1;
  const tp = 1 - 0.16 * Math.max(0, c.m.bodyFat) - 0.05 * Math.max(0, c.m.muscle);
  const st: number[][] = [
    // The cap is low and broad (a deltoid, not a ball): it tops out just above the joint and its inner half is inside the torso's yoke.
    // Phase 2: the cap's crown is pulled IN under the yoke and kept low, so with the arm hanging the top of the
    // shoulder is the torso's trapezius running out over it — the seam is under the arm, not an epaulette on top.
    [-R1 * delt * 0.55, 0, 0, 0, -R1 * 0.3],
    [-R1 * delt * 0.5, R1 * delt * 0.5, R1 * delt * 0.52, 0, -R1 * 0.26],
    [-R1 * delt * 0.32, R1 * delt * 0.84, R1 * delt * 0.84, 0, -R1 * 0.12],
    [R1 * 0.2, R1 * delt, R1 * delt * 1.0, 0, R1 * 0.03],
    [L1 * 0.26, R1 * delt * 0.97, R1 * delt * 0.97, 0, R1 * 0.04],
    [L1 * 0.46, R1 * 1.07, R1 * 1.0, R1 * 0.02, R1 * 0.02],
    [L1 * 0.66, R1 * 1.04, R1 * 0.93, R1 * 0.02, 0],
    // A heavy arm still has an elbow and a wrist: fat sits on the upper arm, the taper below it is kept (tp).
    [L1 * 0.86, R1 * 0.9 * tp, R1 * 0.86 * tp, 0, 0],
    [L1, R1 * 0.8 * tp * tp, R1 * 0.85 * tp * tp, 0, 0],
    [L1 + L2 * 0.14, R2 * 0.94 * tp, R2 * 1.05 * tp, R2 * 0.04, 0],
    [L1 + L2 * 0.3, R2 * 0.92 * tp, R2 * 1.0 * tp, R2 * 0.03, 0],
    [L1 + L2 * 0.46, R2 * 0.74 * tp * tp, R2 * 0.8 * tp * tp, 0, 0],
    [wristS - (wristS - L1) * 0.12, R2 * 0.54 * tp * tp, R2 * 0.62 * tp * tp, 0, 0],
    [wristS, R2 * 0.5 * tp * tp, R2 * 0.6 * tp * tp, 0, 0],
  ];
  for (let k = 1; k < st.length; k++) if (st[k]![0]! < st[k - 1]![0]! + 0.003) st[k]![0] = st[k - 1]![0]! + 0.003;
  const keys = st.map(s => s[0]!), vals = st.map(s => s.slice(1));
  const counts = [1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1];
  const ss = rowParams(keys, counts, c.low);
  const bumps: LimbBump[] = [
    { s: L1 * 0.62, ss: L1 * 0.3, phi: 0.1, sphi: 1.25, amp: 0.14 * def },                // biceps
    { s: L1 * 0.52, ss: L1 * 0.34, phi: 2.5, sphi: 1.1, amp: 0.11 * def },                 // triceps, lateral head
    { s: L1 * 0.6, ss: L1 * 0.3, phi: -2.7, sphi: 1.0, amp: 0.09 * def },                  // triceps, long head
    { s: L1 * 0.42, ss: L1 * 0.1, phi: 1.5, sphi: 1.2, amp: -0.03 * def },                 // the dip where the deltoid inserts
    { s: L1, ss: L1 * 0.1, phi: Math.PI, sphi: 0.7, amp: 0.07 },                           // elbow point
    { s: L1 + L2 * 0.18, ss: L2 * 0.22, phi: 0.9, sphi: 1.0, amp: 0.1 * def },             // brachioradialis
    { s: L1 + L2 * 0.2, ss: L2 * 0.24, phi: -1.3, sphi: 1.0, amp: 0.08 * def },            // flexors
  ];
  const cols = c.low ? 10 : 16;
  const row = [0, 0, 0, 0];
  const wj = R1 * cfg.rigJointBlend;
  addGrid(c.g, {
    rows: ss.length, cols, wrap: true, mirror: c.lat[i]! < 0,
    point: (r, j, out) => {
      // φ = 0 is the front of the arm (u = 0.25), u = 0.5 the outside; the seam runs down the inside (medial).
      limbPoint(keys, vals, bumps, ss[r]!, (j / cols) * TAU - Math.PI / 2, row, out);
      out.x += J.x; out.y += J.y; out.z += Math.abs(J.z);
    },
    weights: p => {
      const s = J.y - p.y;
      const w: BW[] = [];
      // Deltoid: mostly the shoulder bone at the cap, all upper arm by the insertion.
      const a = smooth01((s + R1 * 0.5) / (L1 * 0.44 + R1 * 0.5));
      if (a < 1) {
        if (cfg.skelOn) {
          // Phase 1.2: above and around the joint the cap IS the torso's skin there: the very same weights at the same place (chest and
          // clavicle), so the yoke and the deltoid move as one surface and no seam opens or creases to a point. Below, it hands over to
          // the arm through the deltoid helper (half-way between the clavicle and the arm), over the length of the muscle.
          for (const e of torso.weights(p)) w.push([e[0], e[1] * (1 - a)]);
          w.push([bones.upper, a * (1 - 0.4 * (1 - a))], [bones.shoulder, a * 0.4 * (1 - a)]);
        } else w.push([bones.shoulder, (1 - a) * 0.8], [bones.upper, 1 - (1 - a) * 0.8]);
      } else hingeWeights(s, L1, wj, bones.upper, bones.elbow, bones.fore, w);
      return w;
    },
    rect: c.rect(c.lat[i]! < 0 ? 'armL' : 'armR'),
    kind: KIND.skin,
    uv: (r, j) => [j / cols, (ss[r]! - keys[0]!) / (keys[keys.length - 1]! - keys[0]!)],
    tint: p => {
      // Elbows run a little redder and darker.
      const e = bump((J.y - p.y - L1) / (R1 * 1.2)) * (p.x < 0 ? 1 : 0.3);
      return [1 - 0.04 * e, 1 - 0.12 * e, 1 - 0.12 * e];
    },
    ao: cfg.rigAoStrength,
  });
}

/** The leg's station table: s down from the hip joint → [rx (front/back), rz (lateral), cx, cz]. Trunks and boots fit themselves to it. */
export function legStations(c: Ctx): { keys: number[]; vals: number[][] } {
  const { body: b, d } = c;
  const L3 = b.thigh, L4 = b.shin, R3 = d.thighR, R4 = d.shinR;
  const fat = Math.max(0, c.m.bodyFat);
  const top = 1 + 0.12 * fat;
  const st: number[][] = [
    [-R3 * 0.9, 0, 0, 0, 0],
    [-R3 * 0.78, R3 * 0.55, R3 * 0.52, 0, 0],
    [-R3 * 0.35, R3 * 1.02 * top, R3 * 0.98 * top, 0, 0],
    [L3 * 0.12, R3 * 1.17 * top, R3 * 1.1 * top, 0, R3 * 0.02],
    [L3 * 0.45, R3 * 1.07, R3 * 0.99, R3 * 0.03, R3 * 0.02],
    [L3 * 0.78, R3 * 0.85, R3 * 0.8, R3 * 0.02, 0],
    [L3, R3 * 0.72, R3 * 0.7, R3 * 0.02, 0],
    [L3 + L4 * 0.1, R4 * 0.88, R4 * 0.88, 0, 0],
    [L3 + L4 * 0.3, R4 * 1.0, R4 * 0.96, -R4 * 0.17, 0],
    [L3 + L4 * 0.55, R4 * 0.72, R4 * 0.68, -R4 * 0.07, 0],
    [L3 + L4 * 0.8, R4 * 0.52, R4 * 0.49, 0, 0],
    [L3 + L4, R4 * 0.5, R4 * 0.48, 0, 0],
  ];
  return { keys: st.map(s => s[0]!), vals: st.map(s => s.slice(1)) };
}

/** The leg's muscle bumps (the fighter's; the trunks' shell is built over the same bumps plus a gap). */
export function legBumps(c: Ctx): LimbBump[] {
  const { body: b } = c;
  const L3 = b.thigh, L4 = b.shin;
  const def = muscleDef(c);
  return [
    { s: L3 * 0.4, ss: L3 * 0.4, phi: 0.15, sphi: 1.0, amp: 0.1 * def },                   // rectus femoris
    { s: L3 * 0.5, ss: L3 * 0.4, phi: 1.25, sphi: 0.9, amp: 0.08 * def },                  // vastus lateralis
    { s: L3 * 0.8, ss: L3 * 0.16, phi: -0.85, sphi: 0.8, amp: 0.13 * def },                // vastus medialis (the teardrop)
    { s: L3 * 0.5, ss: L3 * 0.4, phi: Math.PI, sphi: 1.1, amp: 0.08 * def },               // hamstrings
    { s: L3, ss: L3 * 0.08, phi: 0, sphi: 0.7, amp: 0.1 },                                 // kneecap
    { s: L3 + L4 * 0.27, ss: L4 * 0.22, phi: 2.55, sphi: 0.8, amp: 0.2 * def },           // calf, outer head
    { s: L3 + L4 * 0.3, ss: L4 * 0.24, phi: -2.55, sphi: 0.8, amp: 0.22 * def },           // calf, inner head
    { s: L3 + L4 * 0.5, ss: L4 * 0.4, phi: 0, sphi: 0.5, amp: -0.05 },                     // shin edge
  ];
}

/** The referee's trouser legs: straight, loose, a little narrower toward the hem (no muscle, no calf). Same station keys as the leg. */
function trouserStations(c: Ctx): { keys: number[]; vals: number[][] } {
  const { keys } = legStations(c);
  const L = c.body.thigh + c.body.shin, R3 = c.d.thighR;
  // The top of each leg is narrow (it hangs from the waist, inside the panel) and opens to the full trouser over the first stretch below the hip.
  const vals = keys.map(s => { const r = R3 * c.cfg.rigRefTrouser * (1 - 0.3 * Math.min(1, Math.max(0, s) / L)) * (0.55 + 0.45 * smooth01((s + 0.3 * R3) / (1.6 * R3))); return [r, r, 0, 0]; });
  return { keys, vals };
}

/** Phase 1.2: the leg skin's weights at a bind point: the pelvis → thigh → knee → shin chain in one smooth field (the hip blends over ± rigHipBlend thigh radii). The trunks' shell uses it too. */
export function legSkinWeights(c: Ctx, i: number, p: THREE.Vector3): BW[] {
  const bones = legBones(i);
  const J = c.bind[bones.thigh]!;
  const wj = c.d.thighR * c.cfg.rigJointBlend * 0.85;
  const s = J.y - p.y;
  const a = thighShare(c, i, p, true);
  const hw: BW[] = [];
  hingeWeights(s, c.body.thigh, wj, bones.thigh, bones.knee, bones.shin, hw);
  const w: BW[] = [[BONE.hips, 1 - a]];
  for (const e of hw) w.push([e[0], e[1] * a]);
  return w;
}

export function buildLeg(c: Ctx, i: number): void {
  const { body: b, d, cfg } = c;
  const bones = legBones(i);
  const J = c.bind[bones.thigh]!;
  const L3 = b.thigh, R3 = d.thighR;
  const outfit = !!c.spec.outfit;
  const { keys, vals } = outfit ? trouserStations(c) : legStations(c);
  const counts = [1, 2, 2, 4, 4, 3, 3, 3, 4, 3, 2];
  const ss = rowParams(keys, counts, c.low);
  const bumps: LimbBump[] = outfit ? [] : legBumps(c);
  const cols = c.low ? 10 : 16;
  const row = [0, 0, 0, 0];
  const wj = R3 * cfg.rigJointBlend * 0.85;
  addGrid(c.g, {
    rows: ss.length, cols, wrap: true, mirror: c.lat[i]! < 0,
    point: (r, j, out) => {
      limbPoint(keys, vals, bumps, ss[r]!, (j / cols) * TAU - Math.PI / 2, row, out);
      out.x += J.x; out.y += J.y; out.z += Math.abs(J.z);
    },
    weights: p => legSkinWeights(c, i, p),
    rect: c.rect(c.lat[i]! < 0 ? 'legL' : 'legR'),
    kind: outfit ? KIND.cloth : KIND.skin,
    uv: (r, j) => [j / cols, (ss[r]! - keys[0]!) / (keys[keys.length - 1]! - keys[0]!)],
    tint: p => {
      const e = outfit ? 0 : bump((J.y - p.y - L3) / (R3 * 0.9)) * (p.x > 0 ? 1 : 0.2);
      return [1 - 0.03 * e, 1 - 0.1 * e, 1 - 0.1 * e];
    },
    ao: outfit ? cfg.rigAoStrength * 0.4 : cfg.rigAoStrength,
  });
}

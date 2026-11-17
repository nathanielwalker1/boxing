/**
 * Fit a skeleton-independent mocap Pose (clip.ts) onto our skeleton, at load. Pure TypeScript.
 *
 *   const fit = buildFit(lib.index.source, lib.bones, skeleton);   // once per body
 *   applyFit(fit, pose, out);                                       // per frame: local rotations + Hips position
 *
 * Per mapped bone an alignment A_b takes our rest bone onto the source T-pose bone (world space). Then
 *   world_b = D_b(t) * A_b * ourRestWorld_b,  local_b = inverse(world_parent) * world_b,
 *   Hips position = the source track scaled by leg height (hips over ankles) and anchored at our ankle height
 *   (the plain "normalised * our hip height" sank the feet 3.5 cm: our ankle sits 4 cm lower than Y Bot's).
 * Most bones use a minimal-arc A (bone direction onto bone direction). Where twist matters it is a two-axis
 * fit: Hips (spine up + hip line), spine / neck (direction + body left), ForeArm and Hand (direction + palm
 * line index-to-pinky root), Foot (foot-to-toe + up). Head and ToeBase are leaf bones with no child to aim
 * at; both rests stand upright facing +Z, so their A is the identity.
 */
import { qinv, qmul, qrot, type Pose, type Quat, type SourceRest, type Vec3 } from './clip';

export interface Skeleton {
  names: string[];            // as in the asset ('mixamorig:Hips' or three's 'mixamorigHips')
  parents: number[];          // index into names, -1 = top bone
  restPos: number[][];        // local translation per bone
  restRot: Quat[];            // local rotation per bone
  basePos?: Vec3;             // world transform of the top bones' parent (default identity)
  baseRot?: Quat;
}
export interface Fit {
  skel: Skeleton;
  map: number[];              // source bone index -> our bone index (-1 if absent)
  align: Quat[];              // per source bone
  restWorldRot: Quat[];       // ours, per our bone
  restWorldPos: Vec3[];
  hipHeight: number;          // ours, Hips rest world y
  srcParents: number[];
  ankleY: number;             // ours, mean Foot rest world y
  srcAnkleY: number;          // source's
  srcHipHeight: number;
  legScale: number;           // (our hips - ankles) / (source hips - ankles): scales the Hips track
}
export interface FitOut { localRot: Quat[]; hipsPos: Vec3 }

const strip = (n: string): string => n.replace(/^mixamorig\d*[:_]?/, '');
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Shortest rotation taking unit a onto unit b. */
export function arc(a: Vec3, b: Vec3): Quat {
  const d = dot(a, b);
  if (d < -0.999999) { const ax = unit(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0])); return [ax[0], ax[1], ax[2], 0]; }
  const c = cross(a, b);
  const q: Quat = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** Rotation whose basis is (p, s orthogonalised, p x s): maps the frame's local axes onto world. */
function frameQuat(p: Vec3, s: Vec3): Quat {
  const x = unit(p), z = unit(cross(x, s)), y = cross(z, x);
  // columns x, y, z -> quaternion
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) { const s4 = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s4, (m02 - m20) / s4, (m10 - m01) / s4, 0.25 * s4]; }
  else if (m00 > m11 && m00 > m22) { const s4 = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s4, (m01 + m10) / s4, (m02 + m20) / s4, (m21 - m12) / s4]; }
  else if (m11 > m22) { const s4 = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s4, 0.25 * s4, (m12 + m21) / s4, (m02 - m20) / s4]; }
  else { const s4 = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s4, (m12 + m21) / s4, 0.25 * s4, (m10 - m01) / s4]; }
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
/** Two-axis alignment: rotation taking our frame (pO, sO) onto the source frame (pS, sS). */
const align2 = (pO: Vec3, sO: Vec3, pS: Vec3, sS: Vec3): Quat => qmul(frameQuat(pS, sS), qinv(frameQuat(pO, sO)));

/** Our skeleton's rest in world space (forward kinematics over the local rest). */
export function restWorld(skel: Skeleton): { rot: Quat[]; pos: Vec3[] } {
  const rot: Quat[] = [], pos: Vec3[] = [];
  const baseRot: Quat = skel.baseRot ?? [0, 0, 0, 1], basePos: Vec3 = skel.basePos ?? [0, 0, 0];
  const done = new Array<boolean>(skel.names.length).fill(false);
  const visit = (i: number): void => {
    if (done[i]) return;
    const p = skel.parents[i]!;
    if (p >= 0) visit(p);
    const pr = p >= 0 ? rot[p]! : baseRot, pp = p >= 0 ? pos[p]! : basePos;
    rot[i] = qmul(pr, skel.restRot[i]!);
    pos[i] = add(pp, qrot(pr, skel.restPos[i] as Vec3));
    done[i] = true;
  };
  for (let i = 0; i < skel.names.length; i++) visit(i);
  return { rot, pos };
}

export function buildFit(src: SourceRest, srcBones: string[], srcParents: number[], skel: Skeleton): Fit {
  const ours = skel.names.map(strip);
  const oi = (n: string): number => ours.indexOf(n);
  const map = srcBones.map(n => oi(n));
  const missing = srcBones.filter((_, i) => map[i]! < 0);
  if (missing.length) throw new Error('skeleton lacks bones: ' + missing.join(', '));
  const { rot: restWorldRot, pos: restWorldPos } = restWorld(skel);
  const sHead = (n: string): Vec3 => src.rest[srcBones.indexOf(n)]!.head;
  const oHead = (n: string): Vec3 => restWorldPos[oi(n)]!;
  const srcLm = (n: string): Vec3 => { const v = src.landmarks[n]; if (!v) throw new Error('source landmark missing: ' + n); return v; };
  // the bone each one aims at: its first child in source order (Hips -> Spine, Spine2 -> Neck, Arm -> ForeArm ...)
  const child = (b: number): number => srcParents.indexOf(b);
  const LEFT: Vec3 = [1, 0, 0], UP: Vec3 = [0, 1, 0];
  const align: Quat[] = srcBones.map((n, b) => {
    const side = n.startsWith('Left') ? 'Left' : 'Right';
    if (n === 'Head' || /ToeBase$/.test(n)) return [0, 0, 0, 1] as Quat;
    if (n === 'Hips') return align2(sub(oHead('Spine'), oHead('Hips')), sub(oHead('LeftUpLeg'), oHead('RightUpLeg')), sub(sHead('Spine'), sHead('Hips')), sub(sHead('LeftUpLeg'), sHead('RightUpLeg')));
    if (/Hand$/.test(n) || /ForeArm$/.test(n)) {
      const palmO = sub(oHead(side + 'HandIndex1'), oHead(side + 'HandPinky1')), palmS = sub(srcLm(side + 'HandIndex1'), srcLm(side + 'HandPinky1'));
      const pO = /Hand$/.test(n) ? sub(oHead(side + 'HandMiddle1'), oHead(n)) : sub(oHead(side + 'Hand'), oHead(n));
      const pS = /Hand$/.test(n) ? sub(srcLm(side + 'HandMiddle1'), sHead(n)) : sub(sHead(side + 'Hand'), sHead(n));
      return align2(pO, palmO, pS, palmS);
    }
    // Foot: both rests stand flat on the floor facing +Z, so the identity keeps OUR sole flat where the source's
    // is flat. (Aiming our ankle-to-ball line along Y Bot's steeper one pushed the ball 3-4 cm into the floor.)
    if (/Foot$/.test(n)) return [0, 0, 0, 1] as Quat;
    const c = child(b);
    const dO = sub(oHead(srcBones[c]!), oHead(n)), dS = sub(sHead(srcBones[c]!), sHead(n));
    if (/^(Spine|Spine1|Spine2|Neck)$/.test(n)) return align2(dO, LEFT, dS, LEFT);
    return arc(unit(dO), unit(dS));
  });
  const ankleY = (oHead('LeftFoot')[1] + oHead('RightFoot')[1]) / 2, srcAnkleY = (sHead('LeftFoot')[1] + sHead('RightFoot')[1]) / 2;
  const hipHeight = oHead('Hips')[1];
  return {
    skel, map, align, restWorldRot, restWorldPos, hipHeight, srcParents,
    ankleY, srcAnkleY, srcHipHeight: src.hipHeight, legScale: (hipHeight - ankleY) / (src.hipHeight - srcAnkleY),
  };
}

/** Local rotations for every bone of our skeleton (unmapped bones keep their rest) and the Hips local position. */
export function applyFit(fit: Fit, pose: Pose, out?: FitOut): FitOut {
  const sk = fit.skel, n = sk.names.length;
  const o: FitOut = out ?? { localRot: sk.restRot.map(q => [...q] as Quat), hipsPos: [0, 0, 0] };
  const world: (Quat | undefined)[] = new Array(n);
  const baseRot: Quat = sk.baseRot ?? [0, 0, 0, 1], basePos: Vec3 = sk.basePos ?? [0, 0, 0];
  for (let b = 0; b < fit.map.length; b++) {
    const i = fit.map[b]!;
    const D: Quat = [pose.rot[b * 4]!, pose.rot[b * 4 + 1]!, pose.rot[b * 4 + 2]!, pose.rot[b * 4 + 3]!];
    const w = qmul(D, qmul(fit.align[b]!, fit.restWorldRot[i]!));
    world[i] = w;
    const p = sk.parents[i]!;
    const pw = p < 0 ? baseRot : world[p] ?? fit.restWorldRot[p]!;
    o.localRot[i] = qmul(qinv(pw), w);
    if (b === 0) {
      // scaled by leg height (hips over ankles), anchored at the ankles, so a bent-knee crouch keeps the feet on
      // the floor even though our ankle sits 4 cm lower than the source's (plain hip-height scaling sank them 3.5 cm)
      const s = fit.legScale, h = fit.srcHipHeight;
      const target: Vec3 = [pose.hips[0]! * h * s, fit.ankleY + (pose.hips[1]! * h - fit.srcAnkleY) * s, pose.hips[2]! * h * s];
      const pp = p < 0 ? basePos : fit.restWorldPos[p]!;
      o.hipsPos = qrot(qinv(pw), sub(target, pp));
    }
  }
  return o;
}

/** World positions of our bones for a fitted pose (tests, measurements). */
export function worldPositions(fit: Fit, f: FitOut): Vec3[] {
  const sk = fit.skel, hips = fit.map[0]!;
  const skel: Skeleton = { ...sk, restRot: f.localRot, restPos: sk.restPos.map((p, i) => (i === hips ? f.hipsPos : p)) };
  return restWorld(skel).pos;
}

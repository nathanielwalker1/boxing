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
  closestOnSegment, smoothstep, twoBoneMid,
  clavicleTarget, fitArm, fitLeg, fitTorso, fk, frameOf, handLateralSign, localToWorld, qAxisAngle, qMul, qRot, restPose, rootQuat,
  skelDef, skelLimits, torsoShapes, SKJ,
} from '../core';

/** Pelvis yaw (relative to the root) for a torso twist: skelHipTwistShare of it, more if the spine would pass its rotation limits. */
export function pelvisYawFor(twist: number, cfg: Config): number {
  const cap = (cfg.skelLumbarRot + cfg.skelSpineRot + cfg.skelChestRot) * (Math.PI / 180) * 0.95;
  let py = twist * cfg.skelHipTwistShare;
  if (twist - py > cap) py = twist - cap;
  else if (twist - py < -cap) py = twist + cap;
  return py;
}

export function fitSimTorso(f: FighterState, cfg: Config): void {
  const def = skelDef(f.body, f.stance, cfg), lim = skelLimits(cfg);
  if (!f.skel) f.skel = restPose(def, f.pos.x, f.pos.z, f.yaw);
  const pose = f.skel;
  const R0 = rootQuat(f.yaw);
  const tw = f.torsoTwist, py = pelvisYawFor(tw, cfg);
  fitTorso(def, lim, cfg, pose, {
    rootX: f.pos.x, rootZ: f.pos.z, yaw: f.yaw,
    pelvis: f.bodyBox.a, pelvisRot: qMul(R0, qAxisAngle(0, 1, 0, py)),
    chest: f.bodyBox.b, chestRot: null, chestTwist: tw - py,
    // The head turns with rigHeadFollow of the shoulders' turn (the eyes stay on the man), as the rig drew it.
    head: f.headBox, headRot: qMul(R0, qAxisAngle(0, 1, 0, tw * cfg.rigHeadFollow)),
  });
  // Legs: the sim has no feet yet (Phase 2.3); the skeleton's stand at the rig's stance spots so the pose is whole.
  const fr = frameOf(f.yaw), lead = handLateralSign('lead', f.stance);
  for (let i = 0; i < 2; i++) {
    const s = i === 0 ? lead : -lead;
    const ankle = localToWorld(f.pos, fr, i === 0 ? cfg.rigStanceFwd : -cfg.rigStanceBack, f.body.bootH, s * cfg.rigStanceLat);
    const pole: Vec3 = { x: fr.fwd.x + fr.right.x * s * cfg.rigKneePoleOut, y: 0, z: fr.fwd.z + fr.right.z * s * cfg.rigKneePoleOut };
    fitLeg(def, lim, cfg, pose, i, ankle, pole, R0);
  }
  const t = torsoShapes(def, pose);
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
  const clavT = clavicleTarget(def, fc, i, reach, 0);
  const P = armPole(f, cfg, i, clavT, g.pos, ap);
  const r = fitArm(def, lim, cfg, pose, i, clavT, g.pos, P.pole, 0);
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

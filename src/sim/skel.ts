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
import type { ArmJoints, Config, FighterState, Vec3 } from '../core';
import {
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

/** Fit arm i to its glove; `hint` is solveArm's joints (the elbow is the pole), `reach` the shoulder's forward roll (m). */
export function fitSimArm(f: FighterState, cfg: Config, i: number, hint: ArmJoints, reach: number): void {
  const pose = f.skel!;
  const def = skelDef(f.body, f.stance, cfg), lim = skelLimits(cfg);
  const fc = fk(def, pose, SKJ.chest + 1);
  const g = f.gloves[i]!;
  // solveArm builds its pole in the FIGHTER's floor frame; on a skeleton the elbow's "out" belongs to the chest, so the
  // same pole is turned with the torso twist (a lead hook's chest turns 66°: the unturned pole put the elbow 33°
  // behind the shoulders, past the shoulder's range, and the clamp folded the fist onto the body). LOG_SKELETON.md.
  const pole = qRot(qAxisAngle(0, 1, 0, f.torsoTwist), { x: hint.elbow.x - hint.shoulder.x, y: hint.elbow.y - hint.shoulder.y, z: hint.elbow.z - hint.shoulder.z });
  const r = fitArm(def, lim, cfg, pose, i, clavicleTarget(def, fc, i, reach, 0), g.pos, pole, 0);
  f.arms[i] = { shoulder: r.shoulder, elbow: r.elbow };
  // The glove is the hand. If the fit moved it (out of reach, or a limit), the velocity that carried it there goes.
  const dx = g.pos.x - r.hand.x, dy = g.pos.y - r.hand.y, dz = g.pos.z - r.hand.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d > 1e-9) {
    const vn = (g.vel.x * dx + g.vel.y * dy + g.vel.z * dz) / d;
    if (vn > 0) { g.vel.x -= dx / d * vn; g.vel.y -= dy / d * vn; g.vel.z -= dz / d * vn; }
  }
  g.pos.x = r.hand.x; g.pos.y = r.hand.y; g.pos.z = r.hand.z;
}

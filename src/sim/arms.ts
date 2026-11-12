/**
 * sim/arms.ts — the sim owns the arms (2026-09-18, "arms still go through
 * each other"). Each tick, after the gloves have moved, the shoulder and
 * elbow of each arm are placed with core/arms.ts solveArm: shoulder on the
 * twisted shoulder line (reaching forward with a punch), elbow from the
 * two-bone solve with a pole that lags toward what the punch asks for —
 * down at the guard, level for a hook (rising with the turn), back for an
 * uppercut, flaring as the glove rises. The lags were the rig's elbow
 * springs; they live here now as first-order lags in moveHist so the rig
 * can draw exactly these joints and the contacts can use them: hit
 * geometry = drawn geometry.
 */
import type { Config, FighterState, Hand } from '../core';
import { armFlareTarget, frameOf, solveArm } from '../core';
import { PUNCHES } from './punches';
import { armPose, setArmPose } from './state';

const HANDS: [Hand, Hand] = ['lead', 'rear'];

export function stepArms(f: FighterState, cfg: Config, dt: number): void {
  const fr = frameOf(f.yaw);
  const p = f.punch;
  const leanN = Math.min(1, Math.max(0, f.lean.fwd) / Math.max(1e-6, cfg.rigHeelLiftLean));
  for (let i = 0; i < 2; i++) {
    const hand = HANDS[i]!;
    const mine = p.type !== null && p.hand === hand;
    // The hook's elbow: level through the swing and the hold, but not until
    // the drive — it stays down by the ribs for rigHookElbowRiseAt of the cock.
    let hooking = 0;
    if (p.type === 'hook' && mine) {
      const ph = PUNCHES.hook.phases(cfg);
      const inHold = p.phase !== 'recover' || p.t < ph.hold * ph.recover;
      let rise = 1;
      if (p.phase === 'cock') rise = Math.min(1, Math.max(0, (p.t / Math.max(1e-3, ph.cock) - cfg.rigHookElbowRiseAt) / Math.max(0.05, 1 - cfg.rigHookElbowRiseAt)));
      hooking = inHold ? cfg.rigHookElbowLevel * rise : 0;
    }
    let uppercutting = p.type === 'uppercut' && mine && p.phase !== 'recover' ? 1 : 0;
    // uppercutV2 (polish): MEASURED, the old pole (back through the whole punch, flaring as the fist rose) put the
    // elbow 15 cm ABOVE the shoulder at contact with the arm folded to 18° on the way — a wing. Now the elbow is back
    // only while the body sits; from the leg drive on it comes forward UNDER the fist and may not flare.
    const upV2 = cfg.uppercutV2 && p.type === 'uppercut' && mine;
    if (upV2) {
      const ph = PUNCHES.uppercut.phases(cfg);
      uppercutting = p.progress * ph.total < (ph.cock + ph.extend) * cfg.uppercutChainRiseAt ? 1 : 0;
    }
    const kMul = i === 1 ? 1 + cfg.rigTwinSkew : 1;
    const pose = armPose(f, i);
    // First-order lags at the rig's elbow-spring rates (ω = √K), deterministic.
    const lagFast = 1 - Math.exp(-Math.sqrt(cfg.rigElbowK * kMul * 2) * dt);
    const lagSlow = 1 - Math.exp(-Math.sqrt(cfg.rigElbowK * kMul) * dt);
    pose.level += (hooking - pose.level) * lagFast;
    pose.back += (uppercutting - pose.back) * lagFast;
    const glove = f.gloves[i]!.pos;
    const reach = p.type === null ? 0 : leanN * cfg.rigPunchShoulderReach * (mine ? 1 : -0.5);
    // The flare target needs the shoulder height, which is the chest's.
    const flareRaw = armFlareTarget(pose.level, glove.y, f.bodyBox.b.y, f.body, cfg);
    const flareTarget = upV2 ? Math.min(flareRaw, cfg.uppercutFlareMax) : flareRaw;
    pose.flare += (flareTarget - pose.flare) * lagSlow;
    setArmPose(f, i, pose);
    f.arms[i] = solveArm(f.body, cfg, f.stance, hand, f.bodyBox.b, f.bodyBox.a, fr, f.torsoTwist, reach, glove, pose);
  }
}

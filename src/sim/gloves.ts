/**
 * sim/gloves.ts — the kinetic chain. The sim owns the glove (CONTRACT
 * 2026-09-02): each glove chases a target through a spring-damper, and
 * `gloves[i].pos` IS the hit sphere. Targets: the guard (with a deterministic
 * idle bob so the hands never freeze), the tighter block pose, or the punch
 * trajectory for the throwing hand. The two hands get slightly different
 * constants so they never twin; the throwing hand is much stiffer through
 * cock + extend so the fist arrives when the timing table says it does, then
 * relaxes for the recovery and overshoots on the way back.
 */
import type { Config, FighterState, Hand, Side, Vec3 } from '../core';
import { TAU, frameOf, localToWorld, sin, sqrt } from '../core';
import { PUNCHES, blockLocal, guardLocal, punchLocal, type LocalPose } from './punches';
import { slipLateral } from './slip';

const HANDS: [Hand, Hand] = ['lead', 'rear'];
/**
 * Semi-implicit Euler is only stable while c·dt < 1 and k·dt² < 4. The
 * throwing hand runs at ~10 000 1/s² and ~160 1/s, so the glove springs are
 * integrated in sub-steps of SIM_DT / CHAIN_SUBSTEPS. Integration detail, not
 * a tunable: changing it changes results, not feel.
 */
const CHAIN_SUBSTEPS = 4;
/** Bob phase offsets per hand and per side — shape, so the four gloves desync. */
const BOB_PHASE_HAND = [0, 1.9];
const BOB_PHASE_SIDE = [0, 2.6];

/** `guard`: the hand is at rest or blocking (it rides the shoulders through a slip); a punching hand aims from the fighter's frame. */
function targetLocal(f: FighterState, hand: Hand, cfg: Config): { pose: LocalPose; kMul: number; contact: Vec3 | null; guard: boolean } {
  const p = f.punch;
  if (p.type !== null && p.hand === hand) {
    const def = PUNCHES[p.type];
    if (def) {
      const ph = def.phases(cfg);
      const kMul = p.phase === 'recover' ? cfg.chainRecoverK : cfg.chainPunchK;
      // A glove that hit something rests on it through the hold instead of
      // driving on to the free-air peak.
      const rt = (p.progress * ph.total - ph.cock - ph.extend) / ph.recover;
      const contact = p.contact && p.phase === 'recover' && rt < ph.hold ? p.contact : null;
      return { pose: punchLocal(f.body, f.stance, def, hand, p.progress * ph.total, ph, cfg), kMul, contact, guard: false };
    }
  }
  return { pose: f.block ? blockLocal(f.body, hand, f.stance) : guardLocal(f.body, hand, f.stance), kMul: 1, contact: null, guard: true };
}

/** Compute this tick's targets and advance the springs by dt. */
export function stepGloves(f: FighterState, side: Side, time: number, cfg: Config, dt: number): void {
  const fr = frameOf(f.yaw);
  for (let i = 0; i < 2; i++) {
    const hand = HANDS[i]!;
    const { pose, kMul, contact, guard } = targetLocal(f, hand, cfg);
    const bob = sin(time * TAU * cfg.chainBobHz + BOB_PHASE_HAND[i]! + BOB_PHASE_SIDE[side]!) * cfg.chainBobAmp;
    // The hands ride the body down through a crouch (guard and punch alike).
    // The guard also rides the shoulders sideways through a slip; a punching
    // hand does not — it aims from the fighter's frame, so a slip-and-hook
    // still lands where the hook was thrown.
    const lat = pose.lat + (guard ? slipLateral(f) * cfg.slipShoulderFrac : 0);
    const t = contact ? { x: contact.x, y: contact.y, z: contact.z } : localToWorld(f.pos, fr, pose.fwd, pose.up + bob - f.crouch, lat);
    // The gloves ride the torso's reaction offset, so they travel with the body.
    if (!contact) { t.x += f.reaction.torso.x; t.y += f.reaction.torso.y; t.z += f.reaction.torso.z; }
    const g = f.gloves[i]!;
    g.target = t;

    let k = cfg.chainK * (i === 1 ? cfg.chainRearK : 1);
    let c = cfg.chainC * (i === 1 ? cfg.chainRearC : 1);
    if (kMul !== 1) { k *= kMul; c *= sqrt(kMul); }
    const h = dt / CHAIN_SUBSTEPS;
    for (let n = 0; n < CHAIN_SUBSTEPS; n++) {
      g.vel.x += (k * (t.x - g.pos.x) - c * g.vel.x) * h;
      g.vel.y += (k * (t.y - g.pos.y) - c * g.vel.y) * h;
      g.vel.z += (k * (t.z - g.pos.z) - c * g.vel.z) * h;
      g.pos.x += g.vel.x * h; g.pos.y += g.vel.y * h; g.pos.z += g.vel.z * h;
    }
  }
}

/** Park both gloves exactly on their targets (createState). */
export function settleGloves(f: FighterState, side: Side, time: number, cfg: Config): void {
  stepGloves(f, side, time, cfg, 0);
  for (const g of f.gloves) {
    g.pos = { ...g.target };
    g.vel = { x: 0, y: 0, z: 0 };
  }
}

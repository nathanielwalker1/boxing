/**
 * sim/resources.ts — health, stamina and the knockdown. Port of v1 Stage 6
 * (fighter.js takeDamage / stamina step / knockdown) and Stage 17 part 0d
 * (receiveStaminaChip), on 0..1 bars with impulse in N·s.
 *
 * Every cost derives from the one impulse value the hit already produced
 * (post block reduction) — there is no parallel damage number, so a weak
 * retreating jab and a hard advancing hook differ for free.
 *
 * A knockdown puts the round into the `count` phase: both fighters freeze
 * (inputs are nulled by step) and the clock pauses for the referee's
 * 10-count; the get-up count is rolled from the chin at the knockdown.
 */
import type { Config, FighterState, Side, SimEvent, SimState } from '../core';
import { clamp, lerp, rngRange } from '../core';
import { getUpAt, regenDelay, setGetUpAt, setRegenDelay } from './state';
import { clearPunish } from './vulnerability';

/** Per tick: the guard drains stamina, idling regains it (after any post-hit pause), the canvas freezes it. */
export function stepStamina(f: FighterState, cfg: Config, dt: number): void {
  const delay = Math.max(0, regenDelay(f) - dt);
  setRegenDelay(f, delay);
  if (f.down) return;
  if (f.block) f.stamina = Math.max(0, f.stamina - cfg.staminaBlockDrain * dt);
  else if (f.punch.type === null && delay === 0) f.stamina = Math.min(1, f.stamina + cfg.staminaRegen * dt);
}

/** A punch has landed on `target` with post-block impulse `mag`: chip the stamina, take the damage, maybe go down. */
export function takeHit(s: SimState, target: Side, mag: number, blocked: boolean, cfg: Config, events: SimEvent[]): void {
  const d = s.fighters[target];
  if (d.down) return;
  d.stamina = Math.max(0, d.stamina - mag * cfg.staminaHitCost * (blocked ? cfg.staminaBlockedHitMult : 1));
  setRegenDelay(d, Math.max(regenDelay(d), cfg.staminaRegenDelay));
  d.health = Math.max(0, d.health - mag * cfg.healthDamagePerImpulse);
  if (d.health <= 0) knockDown(s, target, cfg, events);
}

function knockDown(s: SimState, side: Side, cfg: Config, events: SimEvent[]): void {
  const d = s.fighters[side];
  d.down = true;
  d.downT = 0;
  d.knockdowns += 1;
  d.block = false;
  d.blockT = 0;
  d.guard = 'down';
  d.punch = { type: null, hand: d.punch.hand, phase: 'idle', t: 0, progress: 0, resolved: false, contact: null };
  d.lean.fwd = 0; d.lean.lat = 0; d.torsoTwist = 0; d.crouch = 0;
  d.stagger.x = 0; d.stagger.z = 0;
  d.slip = { active: false, dir: 0, t: 0, offset: 0 };
  clearPunish(d);   // the knockdown supersedes any punish window
  events.push({ type: 'knockdown', side, count: d.knockdowns });
  if (d.knockdowns >= cfg.knockdownsForTko) {
    events.push({ type: 'tko', winner: side === 0 ? 1 : 0 });
    s.round.phase = 'over';
  } else {
    // The get-up roll (CONTRACT §8: "get-up chance based on chin/damage"): a
    // chin-100 fighter rises on getUpCountBest, chin-0 on getUpCountWorst,
    // later in the round's second and third knockdowns, ± the seeded jitter.
    // 10 or more = they do not beat the count. Rolled now so the count is
    // deterministic and the rig can be told how long the fall lasts.
    const chin = clamp(d.ratings.chin / 100, 0, 1);
    const count = lerp(cfg.getUpCountWorst, cfg.getUpCountBest, chin)
      + cfg.getUpCountPerKnockdown * (d.knockdowns - 1)
      + rngRange(s.rng, -cfg.getUpJitter, cfg.getUpJitter);
    setGetUpAt(d, count >= 10 ? -1 : Math.max(0, count) * cfg.countTickSeconds);
    s.round.phase = 'count';
    s.round.count = 0;
  }
  s.round.phaseT = 0;
}

/**
 * The referee's count, countTickSeconds per count, both fighters frozen and
 * the clock held. The downed fighter rises at the second their roll said
 * (getUp, part of the bar back, fighting resumes) or hears ten (ko, over).
 */
export function stepCount(s: SimState, cfg: Config, dt: number, events: SimEvent[]): void {
  if (s.round.phase !== 'count') return;
  for (const side of [0, 1] as const) {
    const f = s.fighters[side];
    if (!f.down) continue;
    f.downT += dt;
    const n = Math.min(10, Math.floor(f.downT / cfg.countTickSeconds));
    while (s.round.count < n) { s.round.count += 1; events.push({ type: 'countTick', side, n: s.round.count }); }
    const at = getUpAt(f);
    if (at >= 0 && f.downT >= at && s.round.count < 10) {
      f.down = false;
      f.downT = 0;
      f.guard = 'rest';
      f.health = Math.max(f.health, cfg.knockdownHealthRestore);
      events.push({ type: 'getUp', side });
      s.round.phase = 'fighting';
      s.round.phaseT = 0;
      s.round.count = 0;
    } else if (s.round.count >= 10) {
      events.push({ type: 'ko', winner: side === 0 ? 1 : 0 });
      s.round.phase = 'over';
      s.round.phaseT = 0;
    }
  }
}

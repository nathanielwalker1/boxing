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
 * (inputs are nulled by step) and the clock pauses until the get-up. Stage 3
 * turns this into the real 10-count.
 */
import type { Config, FighterState, Side, SimEvent, SimState } from '../core';
import { regenDelay, setRegenDelay } from './state';

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
  events.push({ type: 'knockdown', side, count: d.knockdowns });
  if (d.knockdowns >= cfg.knockdownsForTko) {
    events.push({ type: 'tko', winner: side === 0 ? 1 : 0 });
    s.round.phase = 'over';
  } else {
    s.round.phase = 'count';
  }
  s.round.phaseT = 0;
}

/** The count: after knockdownDuration on the canvas the fighter gets up with part of the bar back and the fight resumes. */
export function stepCount(s: SimState, cfg: Config, dt: number, events: SimEvent[]): void {
  if (s.round.phase !== 'count') return;
  for (const side of [0, 1] as const) {
    const f = s.fighters[side];
    if (!f.down) continue;
    f.downT += dt;
    if (f.downT < cfg.knockdownDuration) continue;
    f.down = false;
    f.downT = 0;
    f.guard = 'rest';
    f.health = Math.max(f.health, cfg.knockdownHealthRestore);
    events.push({ type: 'getUp', side });
    s.round.phase = 'fighting';
    s.round.phaseT = 0;
  }
}

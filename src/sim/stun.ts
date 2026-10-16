/**
 * sim/stun.ts — ROCKED: the hurt state (2026-10-15, Nate: "one strong punch
 * can stun a boxer… but we need a formula so it's not random; the knockouts
 * out of nowhere are what this game is missing").
 *
 * Deterministic, no dice. A CLEAN HEAD shot from a punch that can rock (not
 * the jab) rocks its target when its impulse clears a threshold that is the
 * target's to carry:
 *
 *   T = stunBase × (stunChinFloor + stunChinSpan × chin)
 *                × (stunHealthFloor + (1 − stunHealthFloor) × health)
 *                × (stunStaminaFloor + (1 − stunStaminaFloor) × stamina)
 *
 * health is read AFTER the shot's own damage. Fresh and chin 70 that is
 * ~370 N·s — an uppercut, a hook with momentum, or anything into a slip's
 * counter window; at half health a stepping cross; at a quarter any clean
 * cross. The bar on the HUD is the risk gauge.
 *
 * Rocked for stunSeconds (+ stunSecondsPerOver × how far the shot cleared
 * T, capped at stunMaxSeconds): legs go (movement.ts × stunMoveScale), the
 * guard sags (gloves.ts, stunGuardDrop) and absorbs less (combat.ts,
 * stunBlockScale), exposure is held at stunVuln so every shot in the window
 * hits for the counter bonus, and no punch starts for the first
 * stunPunchLock seconds. A rocking shot while already rocked extends it.
 *
 * The finish: a second rocking-capable clean head shot while rocked at or
 * above stunFinishFrac × T is a KNOCKDOWN whatever the bar says. A jab can
 * neither rock nor finish (Nate). The flash: a single shot at or above
 * stunFlashFrac × T floors a fighter outright — counters and full-momentum
 * hooks on a worn man.
 */
import type { Config, FighterState, PunchType, Side, SimEvent, SimState } from '../core';
import { clamp } from '../core';
import { knockDown } from './resources';

/** The impulse a clean head shot needs to rock `f` in its current state, N·s. */
export function stunThreshold(f: FighterState, cfg: Config): number {
  const chin = clamp(f.ratings.chin / 100, 0, 1);
  const health = clamp(f.health, 0, 1);
  const stamina = clamp(f.stamina, 0, 1);
  return cfg.stunBase
    * (cfg.stunChinFloor + cfg.stunChinSpan * chin)
    * (cfg.stunHealthFloor + (1 - cfg.stunHealthFloor) * health)
    * (cfg.stunStaminaFloor + (1 - cfg.stunStaminaFloor) * stamina);
}

/** A clean head shot of `mag` N·s from a punch that can rock has landed on `target` (after takeHit). */
export function applyStun(s: SimState, target: Side, by: Side, punch: PunchType, mag: number, cfg: Config, events: SimEvent[]): void {
  const d = s.fighters[target];
  if (d.down || cfg.stunBase <= 0) return;
  const T = stunThreshold(d, cfg);
  if (d.hurt > 0 && mag >= cfg.stunFinishFrac * T) { knockDown(s, target, cfg, events, 'finish'); return; }
  if (mag >= cfg.stunFlashFrac * T) { knockDown(s, target, cfg, events, 'flash'); return; }
  if (mag < T) return;
  const over = clamp((mag - T) / T, 0, 1);
  const seconds = Math.min(cfg.stunMaxSeconds, cfg.stunSeconds + cfg.stunSecondsPerOver * over);
  d.hurt = Math.max(d.hurt, seconds);
  d.hurtMax = Math.max(d.hurtMax, d.hurt);
  events.push({ type: 'rocked', side: target, by, punch, impulse: mag, threshold: T, seconds: d.hurt });
}

export function stepStun(f: FighterState, dt: number): void {
  if (f.hurt <= 0) return;
  f.hurt = Math.max(0, f.hurt - dt);
  if (f.hurt === 0) f.hurtMax = 0;
}

/** No punch starts for the first stunPunchLock seconds of the hurt state. */
export function stunPunchLocked(f: FighterState, cfg: Config): boolean {
  return f.hurt > 0 && f.hurtMax - f.hurt < cfg.stunPunchLock;
}

/** 0..1: how rocked, for the rig and the reads (1 = just rocked, fading to 0 as it clears). */
export function hurtLevel(f: FighterState): number {
  return f.hurt > 0 && f.hurtMax > 0 ? clamp(f.hurt / f.hurtMax, 0, 1) : 0;
}

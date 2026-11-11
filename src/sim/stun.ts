/**
 * sim/stun.ts — the hurt states.
 *
 * ROCKED (2026-10-15, Nate: "one strong punch can stun a boxer… but we need a
 * formula so it's not random; the knockouts out of nowhere are what this game
 * is missing").
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
 *
 * Overhaul 2026-11-11 (brief A5 / A6):
 *   - WINDED (`hurtKind: 'body'`): a clean body shot over the BODY threshold
 *     (bodyHurtBase, lowered by accumulated body damage and by stamina) folds
 *     a fighter: slow feet, the hands come down to the body (the head opens),
 *     the body buckles (real height), no punch for bodyHurtPunchLock,
 *     exposure held at bodyHurtVuln. It does not arm the cheap finish — that
 *     is the head's.
 *   - THE LIVER: a clean hook to the body on the target's right side sets a
 *     fuse (liverDelay); when it burns down he buckles — winded for
 *     liverSeconds, stamina gone — and a big enough one puts him down.
 *   - COUNTER FLASH: a counter (a landing inside a slip's window) needs only
 *     counterFlashScale of the flash threshold.
 *   - SURVIVING: the hurt clock runs faster for a fighter who keeps his feet
 *     moving, and fastest in a clinch.
 */
import type { Config, FighterState, PunchType, Side, SimEvent, SimState } from '../core';
import { clamp, lerp } from '../core';
import { knockDown } from './resources';
import { bodyWear } from './footing';
import { rated } from './ratings';

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

/** The impulse a clean body shot needs to wind `f` in its current state, N·s: lower the more the body has taken and the less wind is left. */
export function bodyThreshold(f: FighterState, cfg: Config): number {
  const stamina = clamp(f.stamina, 0, 1);
  return cfg.bodyHurtBase
    * rated(f, 'chin', cfg.ratingChinBody, cfg)
    * lerp(1, cfg.bodyHurtWornFloor, bodyWear(f, cfg))
    * (cfg.stunStaminaFloor + (1 - cfg.stunStaminaFloor) * stamina);
}

/** A clean head shot of `mag` N·s from a punch that can rock has landed on `target` (after takeHit). `counter`: it landed inside a slip's window. */
export function applyStun(s: SimState, target: Side, by: Side, punch: PunchType, mag: number, cfg: Config, events: SimEvent[], counter = false): void {
  const d = s.fighters[target];
  if (d.down || cfg.stunBase <= 0) return;
  const T = stunThreshold(d, cfg);
  if (d.hurt > 0 && d.hurtKind !== 'body' && mag >= cfg.stunFinishFrac * T) { knockDown(s, target, cfg, events, 'finish'); return; }
  const flash = cfg.stunFlashFrac * (counter && cfg.counterFlashOn ? cfg.counterFlashScale : 1);
  if (mag >= flash * T) { knockDown(s, target, cfg, events, 'flash'); return; }
  if (mag < T) return;
  const over = clamp((mag - T) / T, 0, 1);
  const seconds = Math.min(cfg.stunMaxSeconds, cfg.stunSeconds + cfg.stunSecondsPerOver * over);
  // A head hurt takes over a body hurt: the clock restarts as the rocked state.
  if (d.hurtKind === 'body') { d.hurt = 0; d.hurtMax = 0; }
  d.hurt = Math.max(d.hurt, seconds);
  d.hurtMax = Math.max(d.hurtMax, d.hurt);
  d.hurtKind = 'head';
  events.push({ type: 'rocked', side: target, by, punch, impulse: mag, threshold: T, seconds: d.hurt });
}

/** Put `target` in the winded state for `seconds` (never shortens a hurt already running; never replaces a head hurt). */
function wind(s: SimState, target: Side, by: Side, seconds: number, liver: boolean, events: SimEvent[]): void {
  const d = s.fighters[target];
  if (d.hurt > 0 && d.hurtKind === 'head') return;
  d.hurt = Math.max(d.hurt, seconds);
  d.hurtMax = Math.max(d.hurtMax, d.hurt);
  d.hurtKind = 'body';
  events.push({ type: 'bodyHurt', side: target, by, liver, seconds: d.hurt });
}

/** A clean (not glancing) body shot of `mag` N·s has landed on `target` (after takeHit). `liver`: a hook on the liver side. */
export function applyBodyHurt(s: SimState, target: Side, by: Side, mag: number, liver: boolean, cfg: Config, events: SimEvent[]): void {
  const d = s.fighters[target];
  if (d.down) return;
  if (liver && cfg.liverOn && mag >= cfg.liverMinImpulse && d.liverT === 0) {
    // The fuse: nothing shows yet. He buckles liverDelay later.
    d.liverT = cfg.liverDelay; d.liverMag = mag;
    events.push({ type: 'liverShot', side: target, by, delay: cfg.liverDelay });
  }
  if (cfg.bodyHurtOn && mag >= bodyThreshold(d, cfg)) wind(s, target, by, cfg.bodyHurtSeconds, false, events);
}

/** The liver fuse, per tick. When it burns down: the buckle, or the canvas. */
export function stepLiver(s: SimState, side: Side, cfg: Config, dt: number, events: SimEvent[]): void {
  const d = s.fighters[side];
  if (d.liverT <= 0) return;
  d.liverT = Math.max(0, d.liverT - dt);
  if (d.liverT > 0) return;
  const mag = d.liverMag; d.liverMag = 0;
  if (d.down || s.round.phase !== 'fighting') return;
  const by: Side = side === 0 ? 1 : 0;
  d.stamina = Math.max(0, d.stamina - cfg.liverStaminaLoss);
  if (mag >= cfg.liverDropFrac * bodyThreshold(d, cfg)) { knockDown(s, side, cfg, events, 'body'); return; }
  wind(s, side, by, cfg.liverSeconds, true, events);
}

/** The hurt clock. It runs faster for a fighter who keeps moving, and fastest tied up (overhaul: surviving is a game). */
export function stepStun(f: FighterState, dt: number, cfg?: Config): void {
  if (f.hurt <= 0) { if (f.hurtKind !== 'none') f.hurtKind = 'none'; return; }
  let rate = 1;
  if (cfg && cfg.hurtSurvivalOn) {
    if (f.clinch.active) rate = cfg.clinchHurtRecover;
    else {
      const top = cfg.moveSpeed * (f.hurtKind === 'body' ? cfg.bodyHurtMoveScale : cfg.stunMoveScale);
      const moving = top > 1e-6 ? clamp(Math.hypot(f.vel.x + f.hop.x, f.vel.z + f.hop.z) / top, 0, 1) : 0;
      rate = 1 + cfg.hurtMoveRecover * moving;
    }
  }
  f.hurt = Math.max(0, f.hurt - dt * rate);
  if (f.hurt === 0) { f.hurtMax = 0; f.hurtKind = 'none'; }
}

/** No punch starts for the first stunPunchLock (rocked) / bodyHurtPunchLock (winded) seconds of the hurt state. */
export function stunPunchLocked(f: FighterState, cfg: Config): boolean {
  return f.hurt > 0 && f.hurtMax - f.hurt < (f.hurtKind === 'body' ? cfg.bodyHurtPunchLock : cfg.stunPunchLock);
}

/** 0..1: how hurt, for the rig and the reads (1 = just hurt, fading to 0 as it clears). */
export function hurtLevel(f: FighterState): number {
  return f.hurt > 0 && f.hurtMax > 0 ? clamp(f.hurt / f.hurtMax, 0, 1) : 0;
}

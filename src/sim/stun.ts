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
import type { Config, FallStyle, FighterState, PunchType, Side, SimEvent, SimState } from '../core';
import { clamp, lerp } from '../core';
import { knockDown } from './resources';
import { bodyWear, hurtMods } from './footing';
export { hurtMods } from './footing';
import { rated } from './ratings';
import { seededUnit } from './flow';
import { hurtAfter, setHurtAfter } from './state';

/** The impulse a clean head shot needs to rock `f` in its current state, N·s. */
export function stunThreshold(f: FighterState, cfg: Config): number {
  const chin = clamp(f.ratings.chin / 100, 0, 1);
  const health = clamp(f.health, 0, 1);
  const stamina = clamp(f.stamina, 0, 1);
  // (Phase B: how far lost health lowers the bar. MEASURED: at stunHealthFloor 0.55 the bar of a man at half health —
  // most of every fight — was 78% of fresh, under a plain hook: that, not the bonuses, was most of the rocks.)
  const hf = cfg.hurtRatesOn ? Math.max(cfg.stunHealthFloor, cfg.hurtHealthFloor) : cfg.stunHealthFloor;
  // (Polish phase, the rates: the bar itself, and a raised bar for a while after a hurt state has ended.)
  const after = cfg.hurtRatesOn && cfg.hurtAfterSeconds > 0 ? 1 + (cfg.hurtAfterScale - 1) * clamp(hurtAfter(f) / cfg.hurtAfterSeconds, 0, 1) : 1;
  return cfg.stunBase * (cfg.hurtRatesOn ? cfg.hurtStunBaseScale : 1) * after
    * (cfg.stunChinFloor + cfg.stunChinSpan * chin)
    * (hf + (1 - hf) * health)
    * (cfg.stunStaminaFloor + (1 - cfg.stunStaminaFloor) * stamina);
}

/** The impulse a clean body shot needs to wind `f` in its current state, N·s: lower the more the body has taken and the less wind is left. */
export function bodyThreshold(f: FighterState, cfg: Config): number {
  const stamina = clamp(f.stamina, 0, 1);
  // (Phase B, the rates: the body's bar is scaled, and raised for a while after any hurt state, like the head's.)
  const after = cfg.hurtRatesOn && cfg.hurtAfterSeconds > 0 ? 1 + (cfg.hurtAfterScale - 1) * clamp(hurtAfter(f) / cfg.hurtAfterSeconds, 0, 1) : 1;
  return cfg.bodyHurtBase * (cfg.hurtRatesOn ? cfg.hurtBodyBarScale : 1) * after
    * rated(f, 'chin', cfg.ratingChinBody, cfg)
    * lerp(1, cfg.bodyHurtWornFloor, bodyWear(f, cfg))
    * (cfg.stunStaminaFloor + (1 - cfg.stunStaminaFloor) * stamina);
}

/** A clean head shot of `mag` N·s from a punch that can rock has landed on `target` (after takeHit). `counter`: it landed inside a slip's window. */
export function applyStun(s: SimState, target: Side, by: Side, punch: PunchType, raw: number, cfg: Config, events: SimEvent[], counter = false): void {
  const d = s.fighters[target];
  if (d.down || cfg.stunBase <= 0) return;
  // (Polish phase: for these checks the part of the impulse over stunSoftAt counts at stunSoftKeep — see the key.)
  const mag = cfg.hurtRatesOn && raw > cfg.stunSoftAt ? cfg.stunSoftAt + (raw - cfg.stunSoftAt) * cfg.stunSoftKeep : raw;
  const T = stunThreshold(d, cfg);
  const over0 = T > 1e-6 ? mag / T : 0;
  // How a man who is OUT goes down (polish phase): an uppercut or a shot on a man already gone crumples him; a hook or a
  // cross on a man who was upright drops him stiff. In state and on the event for the rig.
  const fall: FallStyle = punch === 'uppercut' || d.hurt > 0 ? 'crumple' : 'stiff';
  // (Phase 3: the finish needs him to have been rocked for stunFinishGrace already — the next punch of the SAME
  // combination, four ticks behind the one that rocked him, is not a finish. Nobody, person or AI, can answer that.)
  const rates = cfg.hurtRatesOn;
  if (d.hurt > 0 && d.hurtKind !== 'body' && d.hurtMax - d.hurt >= cfg.stunFinishGrace && mag >= cfg.stunFinishFrac * (rates ? cfg.hurtFinishScale : 1) * T) {
    knockDown(s, target, cfg, events, 'finish', cfg.hurtVarietyOn && mag >= cfg.stunOutFinishFrac * T ? { kind: 'out', fall, over: over0 } : { over: over0 });
    return;
  }
  const flash = cfg.stunFlashFrac * (rates ? cfg.hurtFlashScale : 1) * (counter && cfg.counterFlashOn ? cfg.counterFlashScale : 1);
  if (mag >= flash * T) {
    knockDown(s, target, cfg, events, 'flash', cfg.hurtVarietyOn && mag >= cfg.stunOutFrac * T ? { kind: 'out', fall, over: over0 } : { over: over0 });
    return;
  }
  if (mag < T) return;
  const over = clamp((mag - T) / T, 0, 1);
  const seconds = Math.min(cfg.stunMaxSeconds, cfg.stunSeconds + cfg.stunSecondsPerOver * over) * (rates ? cfg.hurtRockSeconds : 1);
  // A head hurt takes over a body hurt: the clock restarts as the rocked state.
  if (d.hurtKind === 'body') { d.hurt = 0; d.hurtMax = 0; }
  d.hurt = Math.max(d.hurt, seconds);
  d.hurtMax = Math.max(d.hurtMax, d.hurt);
  d.hurtKind = 'head';
  d.hurtDelay = 0;
  events.push({ type: 'rocked', side: target, by, punch, impulse: mag, threshold: T, seconds: d.hurt });
  // Which kind of rocked (polish phase): a shot well over the bar takes the legs or leaves him reaching; a lesser one
  // may also just make him cover up. A hook or an uppercut leans toward the legs. Seeded, never the clock.
  if (cfg.hurtVarietyOn) {
    const u = (seededUnit(s.seed, s.tick, 11 + target) + 1) / 2;
    const heavy = punch === 'hook' || punch === 'uppercut' ? 0.15 : 0;
    d.hurtStyle = over >= cfg.hurtOverLegs ? (u < 0.6 + heavy ? 'legs' : 'reach') : u < 0.3 + heavy ? 'legs' : u < 0.65 + heavy * 0.5 ? 'reach' : 'cover';
    events.push({ type: 'hurtStyle', side: target, kind: 'head', style: d.hurtStyle, late: false });
  } else d.hurtStyle = 'none';
}

/** Put `target` in the winded state for `seconds` (never shortens a hurt already running; never replaces a head hurt). `late`: this is a late fold arriving. */
function wind(s: SimState, target: Side, by: Side, seconds: number, liver: boolean, events: SimEvent[], cfg?: Config, late = false): void {
  const d = s.fighters[target];
  if (d.hurt > 0 && d.hurtKind === 'head') return;
  const fresh = !(d.hurt > 0);
  d.hurt = Math.max(d.hurt, seconds);
  d.hurtMax = Math.max(d.hurtMax, d.hurt);
  d.hurtKind = 'body';
  events.push({ type: 'bodyHurt', side: target, by, liver, seconds: d.hurt });
  // Which kind of winded (polish phase): the liver side (or a body already worn there) clamps an elbow down; otherwise
  // he folds, or — worn, or by the seeded number — sinks toward a knee.
  if (cfg && cfg.hurtVarietyOn) {
    if (fresh || d.hurtStyle === 'none') {
      const u = (seededUnit(s.seed, s.tick, 23 + target) + 1) / 2;
      const worn = bodyWear(d, cfg);
      d.hurtStyle = liver ? (u < 0.7 ? 'elbow' : 'knee') : u < 0.5 - 0.2 * worn ? 'fold' : u < 0.75 - 0.1 * worn ? 'elbow' : 'knee';
    }
    events.push({ type: 'hurtStyle', side: target, kind: 'body', style: d.hurtStyle, late });
  } else d.hurtStyle = 'none';
}


/** A clean (not glancing) body shot of `mag` N·s has landed on `target` (after takeHit). `liver`: a hook on the liver side. */
export function applyBodyHurt(s: SimState, target: Side, by: Side, mag: number, liver: boolean, cfg: Config, events: SimEvent[]): void {
  const d = s.fighters[target];
  if (d.down) return;
  if (liver && cfg.liverOn && mag >= cfg.liverMinImpulse * (cfg.hurtRatesOn ? cfg.hurtBodyBarScale : 1) && d.liverT === 0) {
    // The fuse: nothing shows yet. He buckles liverDelay later.
    d.liverT = cfg.liverDelay; d.liverMag = mag;
    events.push({ type: 'liverShot', side: target, by, delay: cfg.liverDelay });
  }
  if (cfg.bodyHurtOn && mag >= bodyThreshold(d, cfg)) {
    // A beat late (polish phase): some body shots do not show at once — he keeps his shape, then folds.
    const lateRoll = (seededUnit(s.seed, s.tick, 37 + target) + 1) / 2;
    if (cfg.hurtVarietyOn && !(d.hurt > 0) && d.hurtDelay === 0 && lateRoll < cfg.bodyHurtLateChance) {
      d.hurtDelay = lerp(cfg.bodyHurtLateMin, cfg.bodyHurtLateMax, clamp(lateRoll / Math.max(1e-6, cfg.bodyHurtLateChance), 0, 1));
    } else wind(s, target, by, cfg.bodyHurtSeconds, false, events, cfg);
  }
}

/** The stick forward past this is "walking in", not "going down" (stepKnee). Shape. */
const KNEE_STICK = 0.2;

/** The late fold, per tick: when the beat is up he is winded (unless he is already down, or rocked — the head takes over). */
export function stepHurtDelay(s: SimState, side: Side, cfg: Config, dt: number, events: SimEvent[]): void {
  const d = s.fighters[side];
  if (d.hurtDelay <= 0) return;
  d.hurtDelay = Math.max(0, d.hurtDelay - dt);
  if (d.hurtDelay > 0 || d.down || s.round.phase !== 'fighting') return;
  wind(s, side, side === 0 ? 1 : 0, cfg.bodyHurtSeconds, false, events, cfg, true);
}

/**
 * Taking a knee (polish phase): a hurt fighter holding block + level with nobody in clinch range goes down by choice
 * after takeKneeHold. It is a knockdown — on the cards, toward the three-knockdown rule — and it ends the hurt state.
 */
export function stepKnee(s: SimState, side: Side, input: { block: boolean; level: boolean; move: { x: number; y: number } }, cfg: Config, dt: number, events: SimEvent[]): void {
  const f = s.fighters[side], o = s.fighters[side === 0 ? 1 : 0];
  const dist = Math.hypot(f.pos.x - o.pos.x, f.pos.z - o.pos.z);
  // Not while walking in (that is a man going to tie up — MEASURED: the AI's walk-in clinch took 169 knees in 40 fights
  // before this), and not with the other man close enough to grab: the knee is for when there is nobody to hold on to.
  const asking = cfg.takeKneeOn && cfg.hurtVarietyOn && f.hurt > 0 && !f.down && input.block && input.level && input.move.y <= KNEE_STICK && !f.clinch.active && f.clinch.reach === 0 && f.punch.type === null
    && dist > cfg.clinchRange + cfg.takeKneeClear;   // (the "nobody in reach" rule holds whether or not the clinch is on: with it off, block + level up close is just a low guard, never a knee)
  if (!asking) { f.kneeT = 0; return; }
  f.kneeT += dt;
  if (f.kneeT >= cfg.takeKneeHold) knockDown(s, side, cfg, events, 'health', { kind: 'knee' });
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
  if (mag >= cfg.liverDropFrac * (cfg.hurtRatesOn ? cfg.hurtBodyDropScale : 1) * bodyThreshold(d, cfg)) { knockDown(s, side, cfg, events, 'body'); return; }
  wind(s, side, by, cfg.liverSeconds, true, events, cfg, true);
}

/** The hurt clock. It runs faster for a fighter who keeps moving, and fastest tied up (overhaul: surviving is a game). */
export function stepStun(f: FighterState, dt: number, cfg?: Config): void {
  if (f.hurt <= 0) {
    if (f.hurtKind !== 'none') f.hurtKind = 'none'; if (f.hurtStyle !== 'none') f.hurtStyle = 'none';
    const t = hurtAfter(f); if (t > 0) setHurtAfter(f, Math.max(0, t - dt));
    return;
  }
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
  if (f.hurt === 0) { f.hurtMax = 0; f.hurtKind = 'none'; f.hurtStyle = 'none'; if (cfg && cfg.hurtRatesOn) setHurtAfter(f, cfg.hurtAfterSeconds); }
}

/** No punch starts for the first stunPunchLock (rocked) / bodyHurtPunchLock (winded) seconds of the hurt state. */
export function stunPunchLocked(f: FighterState, cfg: Config): boolean {
  // (Polish phase: with hitNerfOn the locks are hurtPunchLockScale as long — the hands come back sooner, and what they throw is nerfed.)
  return f.hurt > 0 && f.hurtMax - f.hurt < (f.hurtKind === 'body' ? cfg.bodyHurtPunchLock : cfg.stunPunchLock) * (cfg.hitNerfOn ? cfg.hurtPunchLockScale : 1) * hurtMods(f, cfg).lock;
}

/** 0..1: how hurt, for the rig and the reads (1 = just hurt, fading to 0 as it clears). */
export function hurtLevel(f: FighterState): number {
  return f.hurt > 0 && f.hurtMax > 0 ? clamp(f.hurt / f.hurtMax, 0, 1) : 0;
}

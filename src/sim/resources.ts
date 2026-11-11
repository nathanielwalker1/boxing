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
 *
 * Overhaul 2026-11-11:
 *   - THE BODY (brief A6): head and body damage are tracked separately
 *     (`FighterState.damage`). A body shot takes less health now and much
 *     more stamina, and what it has taken lowers the stamina ceiling, the
 *     feet and the guard for the rest of the fight (footing.ts reads it).
 *   - Stamina regenerates to `staminaCap`, not to 1.
 *   - THE GET-UP (brief A5) is a process: down → stir → knee → (slump → knee)
 *     → rise, on `FighterState.getUp` with a getUpPhase event per change.
 *     WHEN he is on his feet (or that he is not) is still the chin roll made
 *     at the knockdown; the struggle is laid out between the fall and that
 *     moment, and whether the first try fails is rolled on the seeded rng.
 */
import type { BodyPart, Config, FighterState, GetUpPhase, Side, SimEvent, SimState } from '../core';
import { clamp, lerp, rngChance, rngRange } from '../core';
import { getUpAt, healthCap, healthRegenDelay, idlePunch, idleSlip, regenDelay, setGetUpAt, setHealthCap, setHealthRegenDelay, setRegenDelay } from './state';
import { clearPunish } from './vulnerability';
import { rated } from './ratings';

/**
 * Per tick: the guard drains stamina, idling regains it (after any post-hit
 * pause), the canvas freezes it. Health (2026-09-16, Nate: "health should
 * regenerate") comes back at healthRegen per second after healthRegenDelay
 * since the last hit, but only up to the CAP — Fight Night's recoverable
 * health: every hit takes healthCapLoss of its damage off the ceiling for the
 * round, so a fighter who has eaten a lot never gets back to full.
 */
export function stepStamina(f: FighterState, cfg: Config, dt: number): void {
  const delay = Math.max(0, regenDelay(f) - dt);
  setRegenDelay(f, delay);
  const hDelay = Math.max(0, healthRegenDelay(f) - dt);
  setHealthRegenDelay(f, hDelay);
  if (f.down) return;
  // (The stamina rating: the guard costs less to hold and wind comes back faster.)
  if (f.block) f.stamina = Math.max(0, f.stamina - cfg.staminaBlockDrain * rated(f, 'stamina', -cfg.ratingStaminaCost, cfg) * dt);
  else if (f.punch.type === null && delay === 0 && f.stamina < f.staminaCap) f.stamina = Math.min(f.staminaCap, f.stamina + cfg.staminaRegen * rated(f, 'stamina', cfg.ratingStaminaRegen, cfg) * dt);
  if (hDelay === 0 && f.health < healthCap(f)) f.health = Math.min(healthCap(f), f.health + cfg.healthRegen * dt);
}

/**
 * A punch has landed on `target` with post-block impulse `mag`: chip the
 * stamina, take the damage (and the cap), maybe go down. `part`: where it
 * landed. `noHealth`: a light shot on the guard — it costs wind, not health.
 */
export function takeHit(s: SimState, target: Side, mag: number, blocked: boolean, cfg: Config, events: SimEvent[], part: BodyPart = 'head', noHealth = false, light = false): void {
  const d = s.fighters[target];
  if (d.down) return;
  const body = part === 'body' && cfg.bodyDamageOn;
  d.stamina = Math.max(0, d.stamina - mag * cfg.staminaHitCost * (blocked ? cfg.staminaBlockedHitMult : 1) * (body ? cfg.staminaBodyHitMult : 1));
  setRegenDelay(d, Math.max(regenDelay(d), cfg.staminaRegenDelay));
  if (noHealth) return;
  const full = mag * cfg.healthDamagePerImpulse;
  // The ledger is in head-shot health fractions for both, so the two are comparable; a blocked shot's chip counts.
  if (part === 'body') d.damage.body += full; else d.damage.head += full;
  const damage = full * (body ? cfg.bodyHealthScale : 1);
  // A jab never puts a man down by itself (overhaul; it can neither rock nor finish either): it cannot take the bar under jabHealthFloor.
  // (Not when that one jab is worth a whole bar: only a rigged test config does that — referee_check floors its dummy that way.)
  const floor = light && cfg.jabHealthFloor > 0 && damage < 1 ? Math.min(d.health, cfg.jabHealthFloor) : 0;
  d.health = Math.max(floor, d.health - damage);
  setHealthCap(d, Math.max(d.health, healthCap(d) - damage * cfg.healthCapLoss));
  setHealthRegenDelay(d, Math.max(healthRegenDelay(d), cfg.healthRegenDelay));
  if (d.health <= 0) knockDown(s, target, cfg, events, 'health');
}

/** Down: the bar emptied ('health'), a shot finished a rocked fighter ('finish'), one shot was enough ('flash'), or the body gave ('body') — sim/stun.ts. */
export function knockDown(s: SimState, side: Side, cfg: Config, events: SimEvent[], cause: 'health' | 'finish' | 'flash' | 'body'): void {
  const d = s.fighters[side];
  d.down = true;
  d.hurt = 0; d.hurtMax = 0; d.hurtKind = 'none';   // the canvas ends the hurt state; the count is its own thing
  d.downT = 0;
  d.knockdowns += 1;
  d.block = false;
  d.blockT = 0;
  d.guard = 'down';
  d.punch = idlePunch(d.punch.hand);
  d.lean.fwd = 0; d.lean.lat = 0; d.torsoTwist = 0; d.crouch = 0;
  d.stagger.x = 0; d.stagger.z = 0;
  d.slip = idleSlip();
  d.hop = { x: 0, z: 0 }; d.burstT = 0; d.pivot = { t: 0, dir: 0, left: 0, cx: 0, cz: 0 };
  d.level = 0; d.riseT = 0; d.posture = 0; d.buckle = 0; d.liverT = 0; d.liverMag = 0;
  d.blockStun = 0; d.guardBroken = 0; d.loaded = 0; d.loadedT = 0; d.combo = 0; d.comboT = 0;
  for (const f of s.fighters) { f.clinch.active = false; f.clinch.reach = 0; f.clinch.t = 0; f.clinch.by = -1; }
  clearPunish(d);   // the knockdown supersedes any punish window
  events.push({ type: 'knockdown', side, count: d.knockdowns, cause });
  if (d.knockdowns >= cfg.knockdownsForTko) {
    events.push({ type: 'tko', winner: side === 0 ? 1 : 0 });
    s.round.phase = 'over';
    d.getUp = { phase: 'down', t: 0, tries: 0, owed: false };
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
    // The struggle (overhaul): does the first try fail? A fighter who will
    // not beat the count always slumps; otherwise the odds grow with the
    // knockdowns this round and shrink with the chin. One roll, made now.
    const beaten = count >= 10;
    const slump = cfg.getUpOn && (beaten || rngChance(s.rng, clamp(cfg.getUpSlumpChance * (d.knockdowns - chin), 0, 1)));
    d.getUp = { phase: 'down', t: 0, tries: 0, owed: slump };
    s.round.phase = 'count';
    s.round.count = 0;
  }
  s.round.phaseT = 0;
}

/**
 * The struggle on the canvas, laid out against the moment he is up (`at`
 * seconds after the fall) or, if he will not make it, the count of ten:
 * stir at getUpStirFrac of the way, a knee at getUpKneeFrac, the rise over
 * the last getUpRiseSeconds. If a slump is owed, the first knee gives way
 * half-way to the rise, he is down for getUpSlumpSeconds, then back to the
 * knee. A beaten fighter slumps and stays there.
 */
/** How far between getting to a knee and the rise a failing first try gives way. Shape. */
const SLUMP_AT = 0.3;

/**
 * The struggle on the canvas as a pure function of the seconds since the
 * fall, laid out against the moment he is up (`at`; −1 = he will not beat
 * the count, so against the count of ten): stir at getUpStirFrac of the way,
 * a knee at getUpKneeFrac, the rise over the last getUpRiseSeconds. If a
 * slump is owed the first knee gives way, he is down for getUpSlumpSeconds,
 * then back to the knee (tries 2). A beaten fighter slumps and stays there.
 */
export function getUpPhaseAt(t: number, at: number, owed: boolean, cfg: Config): { phase: GetUpPhase; tries: number } {
  const beaten = at < 0;
  const end = beaten ? 10 * cfg.countTickSeconds : at;
  const stirAt = end * cfg.getUpStirFrac, kneeAt = end * cfg.getUpKneeFrac;
  const riseAt = Math.max(kneeAt, end - cfg.getUpRiseSeconds);
  const slumpAt = kneeAt + (riseAt - kneeAt) * SLUMP_AT, slumpEnd = slumpAt + cfg.getUpSlumpSeconds;
  if (t < stirAt) return { phase: 'down', tries: 0 };
  if (t < kneeAt) return { phase: 'stir', tries: 0 };
  // A slump only plays if there is room for it before the rise (a quick get-up has no time to fail).
  const slumps = owed && (beaten || slumpEnd <= riseAt);
  if (!slumps) return { phase: beaten || t < riseAt ? 'knee' : 'rise', tries: 1 };
  if (t < slumpAt) return { phase: 'knee', tries: 1 };
  if (beaten || t < slumpEnd) return { phase: 'slump', tries: 1 };
  return { phase: t < riseAt ? 'knee' : 'rise', tries: 2 };
}

function stepGetUp(f: FighterState, side: Side, cfg: Config, dt: number, events: SimEvent[]): void {
  const g = f.getUp;
  g.t += dt;
  if (!cfg.getUpOn) return;
  const now = getUpPhaseAt(f.downT, getUpAt(f), g.owed, cfg);
  if (now.phase === g.phase) return;
  g.phase = now.phase; g.t = 0; g.tries = now.tries;
  events.push({ type: 'getUpPhase', side, phase: now.phase, tries: now.tries });
}

/**
 * The referee's count, countTickSeconds per count, both fighters frozen; the
 * round clock keeps running (2026-10-15; a round that runs out mid-count
 * ends on the get-up). The downed fighter rises at the second their roll said
 * (getUp, part of the bar back, fighting resumes) or hears ten (ko, over).
 */
export function stepCount(s: SimState, cfg: Config, dt: number, events: SimEvent[]): void {
  if (s.round.phase !== 'count') return;
  for (const side of [0, 1] as const) {
    const f = s.fighters[side];
    if (!f.down) continue;
    f.downT += dt;
    stepGetUp(f, side, cfg, dt, events);
    const n = Math.min(10, Math.floor(f.downT / cfg.countTickSeconds));
    while (s.round.count < n) { s.round.count += 1; events.push({ type: 'countTick', side, n: s.round.count }); }
    const at = getUpAt(f);
    if (at >= 0 && f.downT >= at && s.round.count < 10) {
      f.down = false;
      f.downT = 0;
      f.guard = 'rest';
      f.getUp = { phase: 'none', t: 0, tries: 0, owed: false };
      f.health = Math.max(f.health, cfg.knockdownHealthRestore);
      setHealthCap(f, Math.max(healthCap(f), f.health));
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

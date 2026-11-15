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
import type { BodyPart, Config, FallStyle, FighterState, GetUpPhase, KnockdownKind, Side, SimEvent, SimState } from '../core';
import { clamp, frameOf, handLateralSign, lerp, rngChance, rngRange } from '../core';
import { VARIANTS } from './variants';
import { setFallInfo, getUpAt, healthCap, healthRegenDelay, idlePunch, idleSlip, regenDelay, setGetUpAt, setGetUpCount, setHealthCap, setHeldKnock, setHealthRegenDelay, setRegenDelay } from './state';
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
  const regen = cfg.staminaRegen * (cfg.staminaV2 ? cfg.staminaV2RegenMult : 1) * rated(f, 'stamina', cfg.ratingStaminaRegen, cfg) * dt;
  if (cfg.staminaPolishOn) {
    // Polish phase, item 6: the guard is nearly free to hold and wind comes back behind it (slower); it comes back, slower
    // still, while a punch that touched something is on its way home. A miss, or being hit, is still a held breath.
    if (f.block) f.stamina = Math.max(0, f.stamina - cfg.staminaBlockDrain * cfg.staminaGuardHold * rated(f, 'stamina', -cfg.ratingStaminaCost, cfg) * dt);
    const p = f.punch;
    const rate = f.block ? cfg.staminaGuardRegen : p.type === null ? 1 : p.phase === 'recover' && p.contact !== null && !p.feint ? cfg.staminaPunchRegen : 0;
    if (cfg.staminaV2) {
      // staminaV2: a base breath that never stops (less of it while a punch is out), plus the rest of the rate as a RAMP over the
      // last staminaV2ThrowDelay seconds of the pause. Not a switch: a slightly busier pace costs slightly more wind, never all of it.
      const ramp = cfg.staminaV2ThrowDelay > 0 ? Math.max(0, 1 - delay / cfg.staminaV2ThrowDelay) : delay === 0 ? 1 : 0;
      const base = cfg.staminaV2BaseRegen * (p.type === null ? 1 : cfg.staminaV2BasePunching);
      const k = base + Math.max(0, rate - base) * ramp;
      if (k > 0 && f.stamina < f.staminaCap) f.stamina = Math.min(f.staminaCap, f.stamina + regen * k);
    } else if (rate > 0 && delay === 0 && f.stamina < f.staminaCap) f.stamina = Math.min(f.staminaCap, f.stamina + regen * rate);
  } else if (f.block) f.stamina = Math.max(0, f.stamina - cfg.staminaBlockDrain * rated(f, 'stamina', -cfg.ratingStaminaCost, cfg) * dt);
  else if (f.punch.type === null && delay === 0 && f.stamina < f.staminaCap) f.stamina = Math.min(f.staminaCap, f.stamina + regen);
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
  // (Polish phase, item 6: on the GUARD a light shot costs next to nothing and does not pause the wind; a heavy one costs the arms something.)
  const polish = cfg.staminaPolishOn && blocked;
  const onGuard = !polish ? 1 : noHealth ? cfg.staminaBlockedLight : cfg.staminaBlockedHeavy;
  d.stamina = Math.max(0, d.stamina - mag * cfg.staminaHitCost * (blocked ? cfg.staminaBlockedHitMult : 1) * (body ? cfg.staminaBodyHitMult * (cfg.staminaV2 ? cfg.staminaV2BodyMult : 1) : 1) * onGuard);
  // (Phase 2: a light shot — a jab — pauses the wind for only a fraction of that. At the full pause a man jabbing
  // twice a second held the other's stamina at zero for the whole fight.)
  setRegenDelay(d, Math.max(regenDelay(d), cfg.staminaRegenDelay * (light ? cfg.staminaRegenDelayLight : 1) * (!polish ? 1 : noHealth ? 0 : cfg.staminaBlockedDelay)));
  if (noHealth) return;
  const full = mag * cfg.healthDamagePerImpulse;
  // The ledger is in head-shot health fractions for both, so the two are comparable; a blocked shot's chip counts.
  if (part === 'body') d.damage.body += full; else d.damage.head += full;
  const damage = full * (body ? cfg.bodyHealthScale : 1);
  // A jab never puts a man down by itself (overhaul; it can neither rock nor finish either): it cannot take the bar under jabHealthFloor.
  // (Not when that one jab is worth a whole bar: only a rigged test config does that — referee_check floors its dummy that way.)
  // (Phase 4: nor does any shot under knockdownMinImpulse — a glancing blow, a punch on the guard, an arm punch. The
  // bar running out puts a man down only when something real lands on it. MEASURED before: 3.0 knockdowns a fight,
  // most of them the bar emptied by whatever touched it last.)
  const soft = light || (cfg.knockdownMinImpulse > 0 && mag < cfg.knockdownMinImpulse);
  const floor = soft && cfg.jabHealthFloor > 0 && damage < 1 ? Math.min(d.health, cfg.jabHealthFloor) : 0;
  d.health = Math.max(floor, d.health - damage);
  setHealthCap(d, Math.max(d.health, healthCap(d) - damage * cfg.healthCapLoss));
  setHealthRegenDelay(d, Math.max(healthRegenDelay(d), cfg.healthRegenDelay));
  if (d.health <= 0) knockDown(s, target, cfg, events, 'health');
}

/** Down: the bar emptied ('health'), a shot finished a rocked fighter ('finish'), one shot was enough ('flash'), or the body gave ('body') — sim/stun.ts. */
export function knockDown(s: SimState, side: Side, cfg: Config, events: SimEvent[], cause: 'health' | 'finish' | 'flash' | 'body', opt: { kind?: KnockdownKind; fall?: FallStyle; over?: number } = {}): void {
  const d = s.fighters[side];
  // The kind (polish phase): OUT and a knee are decided by the caller; otherwise a one-shot knockdown of a man with
  // health left is a FLASH (caught, up early) and everything else is HEAVY (hurt, up late or not at all).
  const variety = cfg.hurtVarietyOn;
  const kind: KnockdownKind = opt.kind ?? (cause === 'flash' && d.health >= cfg.knockdownFlashHealth ? 'flash' : 'heavy');
  const fall: FallStyle = kind === 'out' ? (opt.fall ?? 'crumple') : 'none';
  d.downKind = kind; d.fall = fall; d.hurtStyle = 'none'; d.hurtDelay = 0; d.kneeT = 0;
  d.down = true;
  d.hurt = 0; d.hurtMax = 0; d.hurtKind = 'none';   // the canvas ends the hurt state; the count is its own thing
  d.downT = 0;
  if (cfg.knockdownV2) {
    // knockdownV2: which fall — chosen NOW, from the punch that is landing (it is still on the puncher), read by sim/skel.ts fitFall.
    const a = s.fighters[side === 0 ? 1 : 0];
    const pt = a.punch.type;
    const folded = cause === 'body' || pt === 'uppercut' || (pt !== null && !!VARIANTS[a.punch.variant]?.body);
    let px = d.pos.x - a.pos.x, pz = d.pos.z - a.pos.z;
    const pl = Math.hypot(px, pz) || 1; px /= pl; pz /= pl;
    // A hook goes across: from the puncher's hand side toward the other (his hand's side basis vector, turned against it).
    const ra = frameOf(a.yaw).right, hs = handLateralSign(a.punch.hand, a.stance);
    setFallInfo(d, folded ? 3 : pt === 'hook' ? 2 : 1, px, pz, -hs * ra.x, -hs * ra.z);
  }
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
  d.hitT = 0; d.hitSev = 0; setHeldKnock(d, 0, 0);   // (polish phase: nothing held or pending survives the canvas)
  for (const f of s.fighters) { f.clinch.active = false; f.clinch.reach = 0; f.clinch.t = 0; f.clinch.by = -1; }
  clearPunish(d);   // the knockdown supersedes any punish window
  events.push(opt.over === undefined ? { type: 'knockdown', side, count: d.knockdowns, cause, kind, fall } : { type: 'knockdown', side, count: d.knockdowns, cause, kind, fall, over: opt.over });
  if (variety && kind === 'out') {
    // OUT before he lands (polish phase): no count. The referee waves it off.
    events.push({ type: 'ko', winner: side === 0 ? 1 : 0, waved: true });
    s.round.phase = 'over';
    d.getUp = { phase: 'down', t: 0, tries: 0, owed: false };
    setGetUpAt(d, -1);
  } else if (d.knockdowns >= cfg.knockdownsForTko) {
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
    const rolled = lerp(cfg.getUpCountWorst, cfg.getUpCountBest, chin)
      + cfg.getUpCountPerKnockdown * (d.knockdowns - 1)
      + rngRange(s.rng, -cfg.getUpJitter, cfg.getUpJitter);
    // (Polish phase: by the kind. A flash knockdown: up early. A heavy one: late. A knee by choice: he uses the count.)
    const count = !variety ? rolled
      : kind === 'knee' ? clamp(cfg.takeKneeCount + (rolled - Math.floor(rolled) - 0.5), cfg.knockdownFlashMin, 9.4)
      : kind === 'flash' ? Math.max(cfg.knockdownFlashMin, rolled - cfg.knockdownFlashEarly)
      : rolled + cfg.knockdownHeavyLate;
    setGetUpCount(d, count);
    setGetUpAt(d, count >= 10 ? -1 : Math.max(0, count) * cfg.countTickSeconds);
    // The struggle (overhaul): does the first try fail? A fighter who will
    // not beat the count always slumps; otherwise the odds grow with the
    // knockdowns this round and shrink with the chin. One roll, made now.
    const beaten = count >= 10;
    const rolledSlump = cfg.getUpOn && (beaten || rngChance(s.rng, clamp(cfg.getUpSlumpChance * (d.knockdowns - chin), 0, 1)));
    const slump = rolledSlump && !(variety && (kind === 'knee' || kind === 'flash'));   // a man who chose it, or was only caught, does not fail to get up
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
  // The fight is over and a man is on the canvas (phase 4): his clock keeps running, so whatever draws the fall
  // from downT has a fall to draw. A stoppage with no count (the third knockdown of a round goes straight to
  // `over`) left downT at 0 and him frozen upright. He stays down: no count, no get-up, no phases.
  if (s.round.phase === 'over') { for (const f of s.fighters) if (f.down) f.downT += dt; return; }
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
      // The count is a breather (phase 3): he gets up with some wind. Without it a man floored with an empty tank got
      // up with an empty tank — no guard, no punches — and was floored again (measured: 3 knockdowns in 26 s, stamina 0.01 at each get-up).
      f.stamina = Math.max(f.stamina, Math.min(f.staminaCap, cfg.hurtVarietyOn && f.downKind === 'knee' ? cfg.takeKneeStamina : cfg.knockdownStaminaRestore));
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

/**
 * ai/style.ts — a fighting style as DATA (overhaul 2026-11-11).
 *
 * Everything the AI does that could differ between fighters is read from a
 * `StyleParams` object, never from config directly: preferred range, footwork
 * mix, punch mix, tempo, how it reads and defends, how it uses the ring,
 * what it does hurt and how it finishes. There is one instance today —
 * `defaultStyle(cfg)`, built from the `ai…` config keys so the tuning panel
 * still drives it live — and `createAi(side, seed, cfg, style)` takes any
 * other. The per-fighter style table (pressure / counter / outboxer /
 * swarmer / slugger) is this object with other numbers.
 *
 * Plain serialisable data: no functions, no references.
 */
import type { Config } from '../core';

export interface StyleParams {
  // ── Range: where it wants to be ──
  /** Centre-to-centre distance it fights at when pressing, and the hysteresis half-width round it, m. */
  standoff: number; standoffBand: number;
  /** Where it sits when probing (out of range, stepping in to throw) and where it steps out to after an exchange, m. */
  probeDist: number; resetDist: number;
  /** Farthest distance it commits each punch family at, m. */
  engageStraight: number; engageHook: number; engageUppercut: number;
  /** How many bands inside a punch's engage distance it walks to when armed with it. */
  stepIn: number;

  // ── Footwork: how it moves ──
  /** Relative odds of each footwork mode. */
  pressWeight: number; probeWeight: number; circleWeight: number; holdWeight: number;
  modeMin: number; modeMax: number; holdMax: number;
  /** Stick it walks with (× moveSpeed) and circles with. */
  speed: number; circleSpeed: number;
  /** Circle weight multiplier at zero stamina. */
  tiredFootwork: number;
  /** The steer's look-ahead, s. */
  lookahead: number;

  // ── Punch mix ──
  jabWeight: number; crossWeight: number; hookWeight: number; uppercutWeight: number;
  /** Odds an armed punch goes to the body; and when the opponent is holding a block. */
  bodyRate: number; bodyRateHighGuard: number;

  // ── Tempo ──
  attackDelayMin: number; attackDelayMax: number;
  /** Timer drain multiplier per opening (unguarded, gassed, stumbling — they stack). */
  aggression: number;
  comboChance: number; comboMax: number; comboGap: number;
  /** Odds it steps out after throwing / after taking a solid shot. */
  resetChance: number; hitResetChance: number; hitResetDamage: number; resetTime: number;
  /** Odds a reset starts with a burst back; odds a heavy punch is feinted first. */
  burstChance: number; feintChance: number;

  // ── Reads and defence ──
  /** Human reaction time, s. */
  reaction: number;
  /** Odds it defends a punch it has read, how long the guard stays, and the shares of those it slips / (hooks) rolls under instead. */
  blockChance: number; blockWindow: number; slipShare: number; rollShare: number;
  /** The exposure it counts as an opening, and the odds it takes one. */
  counterVuln: number; counterChance: number;
  /** After being stuffed or hit solidly: odds it covers, and for how long. */
  coverChance: number; coverTime: number;
  /** Rushed: the closing speed that counts, odds it gives ground (else it fires), how far and how long, and the cooldown. */
  pressureSpeed: number; giveGroundChance: number; giveGround: number; giveGroundTime: number; pressureCooldown: number;
  /** After the opponent backs off: seconds it lets the space open. */
  chaseDelay: number;
  /** Stagger speed that counts as stumbling. */
  stumbleSpeed: number;

  // ── Ring use ──
  /** How hard it cuts the ring off (0 = follows in a straight line), and how near the ropes the opponent must be, m. */
  cutOff: number; cutOffZone: number;
  /** Per second: pivots off the ropes; pushes off when crowded and wanting space. */
  ropePivotRate: number; pushOffRate: number;

  // ── Hurt, and finishing ──
  /** Hurt with the opponent close: odds it ties up (else it covers and gives ground). */
  hurtClinch: number;
  /** Against a hurt opponent: odds each armed punch becomes a power shot. */
  finishPower: number;

  /** The guard it holds. One shape exists today; the style table will add the others. */
  guard: 'high';
}

/** The one style every fighter uses today: the `ai…` config keys, so the tuning panel drives it. */
export function defaultStyle(cfg: Config): StyleParams {
  const tools = cfg.aiToolsOn;
  return {
    standoff: cfg.aiStandoffDist, standoffBand: cfg.aiStandoffBand,
    probeDist: cfg.aiProbeDist, resetDist: cfg.aiResetDist,
    engageStraight: cfg.aiEngageDist, engageHook: cfg.aiHookEngageDist, engageUppercut: cfg.aiUppercutEngageDist,
    stepIn: cfg.aiStepIn,
    pressWeight: cfg.aiPressWeight, probeWeight: cfg.aiProbeWeight, circleWeight: cfg.aiCircleWeight, holdWeight: cfg.aiHoldWeight,
    modeMin: cfg.aiModeMin, modeMax: cfg.aiModeMax, holdMax: cfg.aiHoldMax,
    speed: cfg.aiSpeedScale, circleSpeed: cfg.aiCircleSpeed,
    tiredFootwork: cfg.aiTiredFootwork,
    lookahead: cfg.aiLookahead,
    jabWeight: cfg.aiJabWeight, crossWeight: cfg.aiCrossWeight, hookWeight: cfg.aiHookWeight, uppercutWeight: cfg.aiUppercutWeight,
    bodyRate: tools ? cfg.aiBodyRate : 0, bodyRateHighGuard: tools ? cfg.aiBodyRateHighGuard : 0,
    attackDelayMin: cfg.aiAttackDelayMin, attackDelayMax: cfg.aiAttackDelayMax,
    aggression: cfg.aiAggressionMult,
    comboChance: cfg.aiComboChance, comboMax: cfg.aiComboMax, comboGap: cfg.aiComboGap,
    resetChance: cfg.aiResetChance, hitResetChance: cfg.aiHitResetChance, hitResetDamage: cfg.aiHitResetDamage, resetTime: cfg.aiResetTime,
    burstChance: tools ? cfg.aiBurstChance : 0, feintChance: tools ? cfg.aiFeintChance : 0,
    reaction: cfg.aiReactionTime,
    blockChance: cfg.aiBlockChance, blockWindow: cfg.aiBlockWindow,
    slipShare: tools ? cfg.aiSlipShare : 0, rollShare: tools ? cfg.aiRollShare : 0,
    counterVuln: cfg.aiCounterVuln, counterChance: cfg.aiCounterChance,
    coverChance: cfg.aiCoverChance, coverTime: cfg.aiCoverTime,
    pressureSpeed: cfg.aiPressureSpeed, giveGroundChance: cfg.aiGiveGroundChance, giveGround: cfg.aiGiveGround, giveGroundTime: cfg.aiGiveGroundTime, pressureCooldown: cfg.aiPressureCooldown,
    chaseDelay: cfg.aiChaseDelay,
    stumbleSpeed: cfg.aiStumbleSpeed,
    cutOff: tools ? cfg.aiCutOff : 0, cutOffZone: cfg.aiCutOffZone,
    ropePivotRate: tools ? cfg.aiRopePivotRate : 0, pushOffRate: tools ? cfg.aiPushOffRate : 0,
    hurtClinch: tools ? cfg.aiHurtClinch : 0,
    finishPower: tools ? cfg.aiFinishPower : 0,
    guard: 'high',
  };
}

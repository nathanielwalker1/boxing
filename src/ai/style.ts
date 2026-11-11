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
import type { AiStyle, Config, FighterSpec, GuardShape, PunchType } from '../core';
import { bodyDims } from '../core';

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
  /** Picked off at range: seconds it then walks in behind a held guard. Taking a combination inside: odds it ties up / shoves off. */
  shellTime: number; crowdClinch: number;
  /** Against a hurt opponent: odds each armed punch becomes a power shot. */
  finishPower: number;

  // ── Phase 2: what makes one style a different fight from another ──
  /** The inside fight: odds (rolled as the opponent gets inside) it keeps its guard up in there between its own punches; odds it defends a punch read at inside range. */
  insideGuard: number; insideBlock: number;
  /** With the opponent inside, its attack timer drains this many times faster (an inside fighter works in there; an outboxer does not). */
  insideTempo: number;
  /** Odds it fires straight back after a punch lands on its guard (as the block stun ends). */
  blockCounter: number;
  /** Under fire at close range (a punch on its guard, or one that got through): odds it SHOVES him off, and what it does with the beat that buys — goes to work, or gets out. */
  crowdPush: number; pushThen: 'work' | 'leave';
  /** Rushed: odds its answer is thrown going BACKWARD (a retreat jab, or a check hook if he is close enough). */
  backFoot: number;
  /** As the opponent gets inside: odds it simply ties him up (the referee then puts the fight back at range). */
  insideClinch: number;
  /** THE STIFF JAB: a man walking in through its jab range gets one at once — no timer — this often (per chance, at most every interceptGap s). A jab on a walker stops him. `interceptWith` is the punch a style that would rather hurt him meets him with. */
  intercept: number; interceptGap: number; interceptWith: PunchType;
  /** Coming in through the jab: per second, in the opponent's jab range and walking in, it moves its head off the line (a slip) without waiting to read anything. */
  approachSlip: number;
  /** Cutting off a mover: seconds ahead of the opponent's walking velocity it steers for. */
  leadPursuit: number;
  /** An opponent starting more punches a second than this is rushing: cover, let him miss, counter everything. */
  wildRate: number;
  /** How it uses the ring: cuts it off, circles AWAY from the opponent's power hand, or holds the centre. */
  ringUse: 'cutOff' | 'circleAway' | 'centre';
  /** SIGNATURE COMBINATIONS and the odds a burst is one of them (else random punches). */
  combos: ComboStep[][]; comboSignature: number;
  /** Odds a cross is thrown as the OVERHAND (it dips and steps in with it). */
  overhandRate: number;
  /** THE TELL: a habit before a lone power punch a player can learn — it dips, or draws back half a step — and how often it shows. */
  tell: 'none' | 'dip' | 'drawBack'; tellRate: number;
  /** Hurt: odds it swings back instead of covering (after the clinch roll). */
  hurtSwing: number;
  /** Tired: its tempo slows to 1 / this at full fatigue; per second, at inside range and tired, it ties up. */
  tiredTempo: number; tiredClinchRate: number;
  /** Odds a defensive decision (block, slip, cover, inside guard) simply is not made — difficulty. */
  mistake: number;
  /** Odds that, set and in range, it does not pull the trigger this time and waits a beat instead — difficulty (phase 3). */
  hesitate: number;
  /**
   * THE READ (phase 4): a punch he has started more than readAfter times lately (fading over ~6 s) is one it is
   * waiting for. When he starts it again, at readChance, it moves on readReaction × its reaction time — a pull (at
   * pullShare, from a jab or an uppercut), a slip away from the hand, a roll under a head hook — and at slipCounter
   * the loaded hand comes back behind it.
   */
  readAfter: number; readChance: number; readReaction: number; pullShare: number; slipCounter: number;

  /** The guard its fighter holds (core/styles.ts) — informational here; the sim reads the fighter's own. */
  guard: GuardShape;
}

/** One punch of a signature combination: the button, the hand for a hook / uppercut (−1 lead, 1 rear), and whether it goes to the body. */
export interface ComboStep { p: PunchType; x?: -1 | 1; body?: boolean }

/** A rate nothing reaches (a serialisable "never"). */
const NEVER = 1e6;

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
    shellTime: tools ? cfg.aiShellTime : 0, crowdClinch: tools ? cfg.aiCrowdClinch : 0,
    finishPower: tools ? cfg.aiFinishPower : 0,
    insideGuard: tools ? cfg.aiInsideGuard : 0, insideBlock: tools ? cfg.aiInsideBlock : cfg.aiBlockChance,
    insideTempo: tools ? 1.5 : 1, blockCounter: tools ? 0.35 : 0, backFoot: 0,
    crowdPush: tools ? 0.45 : 0, pushThen: 'work', approachSlip: 0, insideClinch: 0,
    intercept: tools ? 0.4 : 0, interceptGap: 0.45, interceptWith: 'jab',
    leadPursuit: tools ? cfg.aiLeadPursuit : 0,
    wildRate: tools ? cfg.aiWildRate : NEVER,
    ringUse: 'cutOff',
    combos: tools && cfg.aiCombos ? [[{ p: 'jab' }, { p: 'cross' }], [{ p: 'jab' }, { p: 'cross' }, { p: 'hook', x: -1 }], [{ p: 'jab' }, { p: 'jab' }, { p: 'cross' }]] : [],
    comboSignature: tools && cfg.aiCombos ? 0.6 : 0,
    overhandRate: 0,
    tell: 'none', tellRate: 0,
    hurtSwing: 0,
    tiredTempo: 1.3, tiredClinchRate: 0,
    mistake: 0, hesitate: 0,
    readAfter: NEVER, readChance: 0, readReaction: 0.2, pullShare: 0.5, slipCounter: 0.8,
    guard: 'high',
  };
}

// ── The five styles ──────────────────────────────────────────────────────────
// Each is the default with its own numbers. What the numbers mean is on StyleParams. The fighter's half (guard,
// stance, rhythm, the select-screen text) is core/styles.ts STYLES.

const J: ComboStep = { p: 'jab' }, X: ComboStep = { p: 'cross' };
const LH: ComboStep = { p: 'hook', x: -1 }, RH: ComboStep = { p: 'hook', x: 1 };
const LU: ComboStep = { p: 'uppercut', x: -1 }, RU: ComboStep = { p: 'uppercut', x: 1 };
const bJ: ComboStep = { p: 'jab', body: true }, bX: ComboStep = { p: 'cross', body: true }, bLH: ComboStep = { p: 'hook', x: -1, body: true }, bRH: ComboStep = { p: 'hook', x: 1, body: true };

const STYLE_OVERRIDES: Record<AiStyle, Partial<StyleParams>> = {
  // PRESSURE — walks you down behind the high guard. Cuts the ring off, jabs his way in, works in twos and threes,
  // never takes a step back he does not have to. Beaten by angles and by the body.
  pressure: {
    standoff: 0.72, probeDist: 0.95,
    pressWeight: 8, probeWeight: 1, circleWeight: 0.5, holdWeight: 0.5,
    jabWeight: 4, crossWeight: 3, hookWeight: 3, uppercutWeight: 1, bodyRate: 0.3,
    attackDelayMin: 0.55, attackDelayMax: 1.2, comboChance: 0.7, comboMax: 3,
    combos: [[J, X], [J, J, X], [J, X, LH], [bJ, X], [X, LH, X]], comboSignature: 0.75,
    resetChance: 0.1, hitResetChance: 0.15, burstChance: 0.1, feintChance: 0.08,
    blockChance: 0.5, slipShare: 0.15, rollShare: 0.2, counterChance: 0.5,
    giveGroundChance: 0.15, chaseDelay: 0.15,
    cutOff: 0.9, leadPursuit: 0.45, ringUse: 'cutOff', pushOffRate: 0.2,
    insideGuard: 0.4, insideBlock: 0.6, hurtClinch: 0.5, hurtSwing: 0.2, shellTime: 1.6, wildRate: 0.8,
    speed: 1, insideTempo: 2.6, blockCounter: 0.6, backFoot: 0, approachSlip: 0.5, intercept: 0.5, stumbleSpeed: 1.6,
    tiredTempo: 1.25, guard: 'high',
    readAfter: 2.5, readChance: 0.45, readReaction: 0.2, pullShare: 0, slipCounter: 0.7,   // (phase 4) he times a jab he has seen three times and comes in under it
  },
  // OUTBOXER — long guard, long jab, always leaving. Probes from outside his opponent's reach, circles away from
  // the power hand, resets after every exchange, shoves and ties up when crowded. Beaten by cutting the ring off.
  outboxer: {
    standoff: 0.98, probeDist: 1.08, resetDist: 1.45, engageStraight: 1.0, stepIn: 1,
    pressWeight: 0.5, probeWeight: 6, circleWeight: 5, holdWeight: 0.5, circleSpeed: 0.85, speed: 0.95,
    jabWeight: 8, crossWeight: 2.5, hookWeight: 0.6, uppercutWeight: 0, bodyRate: 0.15,
    attackDelayMin: 0.35, attackDelayMax: 0.9, comboChance: 0.5, comboMax: 2,
    combos: [[J, J], [J, X], [J, bJ], [J, J, X]], comboSignature: 0.8,
    resetChance: 0.75, hitResetChance: 0.8, burstChance: 0.65, feintChance: 0.15,
    blockChance: 0.4, slipShare: 0.4, rollShare: 0.1, counterChance: 0.6,
    giveGroundChance: 0.85, giveGround: 0.4, chaseDelay: 0.8,
    cutOff: 0, leadPursuit: 0, ringUse: 'circleAway', pushOffRate: 2.5, ropePivotRate: 3,
    // (Phase 3: hurt, he holds on — hurtClinch 0.9, was 0.35. On a chin of 52 he was rocked and finished standing:
    // 20 of his 23 knockdowns against the inside-fighter bot were the finish.)
    insideGuard: 0.5, insideBlock: 0.6, crowdClinch: 0.85, hurtClinch: 0.9, hurtSwing: 0, shellTime: 0.6,
    insideTempo: 0.8, blockCounter: 0.25, backFoot: 0.3, crowdPush: 0.85, pushThen: 'leave', insideClinch: 0.8, intercept: 1, interceptGap: 0.3,   // (backFoot 0.8 → 0.3, phase 4: he sets his feet and jabs)
    tiredTempo: 1.5, tiredClinchRate: 0.6, guard: 'long',
    readAfter: 2.5, readChance: 0.5, readReaction: 0.2, pullShare: 0.85, slipCounter: 0.6,   // he pulls from a jab he has seen three times
  },
  // COUNTER — sits in the shell and waits. Throws little; slips and rolls most of what it reads; takes every opening
  // (a whiff, a slipped punch) with the cross and the hook behind it; feints to draw a lead. Beaten by not giving it one.
  counter: {
    standoff: 0.86, probeDist: 1.0,
    pressWeight: 2.5, probeWeight: 4, circleWeight: 2, holdWeight: 1.5, holdMax: 1.2,
    // (Phase 3: he still waits, but not so long that he loses every round on work-rate — the clock was 1.2–2.4 s and
    // he lost to all three legitimate bots on points, out-landed two to one. The jab is his score between counters.)
    jabWeight: 6, crossWeight: 3, hookWeight: 2, uppercutWeight: 1, bodyRate: 0.1,
    attackDelayMin: 0.4, attackDelayMax: 0.95, comboChance: 0.6, comboMax: 2,
    combos: [[X, LH], [J, X], [LH, X], [J, J]], comboSignature: 0.8,
    resetChance: 0.3, hitResetChance: 0.3, burstChance: 0.3, feintChance: 0.3,
    blockChance: 0.85, slipShare: 0.6, rollShare: 0.5, counterChance: 1, counterVuln: 0.4,
    giveGroundChance: 0.3, chaseDelay: 0.6,
    cutOff: 0.2, leadPursuit: 0.1, ringUse: 'centre', pushOffRate: 1.2,
    insideGuard: 0.9, insideBlock: 0.85, crowdClinch: 0.5, hurtClinch: 0.8, hurtSwing: 0, shellTime: 1.2,
    insideTempo: 2.2, blockCounter: 0.9, backFoot: 0.5, crowdPush: 0.6, pushThen: 'work', approachSlip: 0.7, insideClinch: 0.4, intercept: 1, interceptGap: 0.3, stumbleSpeed: 0.9,
    wildRate: 0.8, tiredTempo: 1.2, guard: 'shell',
    reaction: 0.13,   // the one style that reads a cross in time to slip it (tell 0.20 s; a slip needs 0.05)
    // (Phase 4: the read. Show him the same punch twice and he is waiting for the third.)
    readAfter: 1.5, readChance: 0.9, readReaction: 0.15, pullShare: 0.6, slipCounter: 1,
  },
  // SWARMER — peek-a-boo, head on your chest. Comes in under the jab bobbing, lives inside, throws short hooks and
  // uppercuts in bunches, half of them to the body. Beaten by the jab and the feet, and by the uppercut as he comes.
  swarmer: {
    standoff: 0.58, probeDist: 0.8, stepIn: 3,
    pressWeight: 9, probeWeight: 0.3, circleWeight: 0.3, holdWeight: 0.2,
    jabWeight: 1.5, crossWeight: 1, hookWeight: 5, uppercutWeight: 3, bodyRate: 0.5, bodyRateHighGuard: 0.8,
    attackDelayMin: 0.35, attackDelayMax: 0.8, comboChance: 0.85, comboMax: 4,
    combos: [[bLH, LH, RU], [bLH, bRH, LH], [RU, LH, RH], [bRH, LH], [J, bLH, RH]], comboSignature: 0.85,
    resetChance: 0, hitResetChance: 0.05, burstChance: 0, feintChance: 0.05,
    blockChance: 0.45, slipShare: 0.3, rollShare: 0.6, counterChance: 0.4,
    giveGroundChance: 0, chaseDelay: 0.05,
    cutOff: 0.8, leadPursuit: 0.4, ringUse: 'cutOff', pushOffRate: 0,
    insideGuard: 0.6, insideBlock: 0.6, crowdClinch: 0.2, hurtClinch: 0.7, hurtSwing: 0.2, shellTime: 2,
    speed: 1, insideTempo: 2.5, blockCounter: 0.5, backFoot: 0, crowdPush: 0.3, pushThen: 'work', approachSlip: 1.6, intercept: 0.2, stumbleSpeed: 2,
    tiredTempo: 1.7, tiredClinchRate: 0.8, guard: 'peekaboo',
    readAfter: 2, readChance: 0.5, readReaction: 0.2, pullShare: 0, slipCounter: 0.8,   // (phase 4) bobbing in under a jab he has timed
  },
  // SLUGGER — hands low, feet planted, one punch. Slow, throws heavy singles and the overhand, dips before the big
  // one (the tell), swings back when hurt. Beaten by making him miss and never standing in front of him.
  slugger: {
    // (Phase 3: he comes forward and throws from the edge of his own reach — engageStraight 1.0, was the default
    // 0.9 — through whatever touches him (interruptPoise). Standing off at 0.9 behind a 1.9 s clock he started 21
    // punches in a three-round fight against a jabber and lost every one of them on points.)
    standoff: 0.8, probeDist: 0.98, engageStraight: 1.0, speed: 1,
    pressWeight: 6, probeWeight: 2, circleWeight: 0.5, holdWeight: 1,
    jabWeight: 1.5, crossWeight: 4, hookWeight: 4, uppercutWeight: 2.5, bodyRate: 0.15,
    attackDelayMin: 0.55, attackDelayMax: 1.15, comboChance: 0.45, comboMax: 2,
    combos: [[X, LH], [LH, X], [J, X]], comboSignature: 0.7,
    resetChance: 0.15, hitResetChance: 0.1, burstChance: 0, feintChance: 0.02,
    blockChance: 0.25, slipShare: 0.1, rollShare: 0.1, counterChance: 0.7,
    giveGroundChance: 0.1, chaseDelay: 0.3,
    cutOff: 1, leadPursuit: 0.6, ringUse: 'cutOff', pushOffRate: 0.3,
    // (Phase 4: a big slow man with a quick one on his chest leans on him and shoves him off — crowdClinch 0.3 → 0.75,
    // crowdPush 0.45 → 0.8, hurtClinch 0.15 → 0.5. Trading inside he was mid-punch, and so exposed, all the time:
    // stopped 8 times in 8 by the inside-fighter bot.)
    insideGuard: 0.35, insideBlock: 0.4, crowdClinch: 0.75, crowdPush: 0.8, pushThen: 'work', hurtClinch: 0.5, hurtSwing: 0.5, shellTime: 0.5,
    insideTempo: 2, blockCounter: 0.7, backFoot: 0.1, insideClinch: 0.3, intercept: 0.8, interceptGap: 0.7, interceptWith: 'cross', stumbleSpeed: 2.5,
    overhandRate: 0.4, tell: 'dip', tellRate: 0.45, tiredTempo: 1.8, guard: 'low',   // (phase 4: 0.7 → 0.45; a man who reads the dip and leaves was never hit)
  },
};

/** How hard the AI is, as data: scales on a style. A scale of 1 is the style as written. */
export interface Difficulty {
  id: 'easy' | 'medium' | 'hard';
  /** × its reaction time. */
  reaction: number;
  /** × its defence rates (block, inside block / guard, slip and roll shares, cover), capped at 1. */
  defence: number;
  /** × its counter chance, capped at 1. */
  counter: number;
  /** × the gaps between its attacks (bigger = slower tempo). */
  tempo: number;
  /** × its combination chance. */
  combo: number;
  /** Odds a defensive decision is simply not made. */
  mistake: number;
  /** × the answers it gives without waiting for its clock: the stiff jab at a man walking in, the reply off the guard, the shove under fire (capped at 1). */
  offence: number;
  /** Odds that, set and in range, it does not throw and waits a beat instead. */
  hesitate: number;
}
export const DIFFICULTY: readonly Difficulty[] = [
  // (Phase 3, measured on the roster bodies. The first three scales — reaction, defence, tempo — barely moved the
  // matrix: easy 57%, medium 57%, hard 54% for the legitimate bots. What decides a fight is how often the AI throws
  // when it could, so that is what difficulty now turns: hesitate, and the answers it gives off its clock.)
  { id: 'easy', reaction: 1.5, defence: 0.5, counter: 0.4, tempo: 1.8, combo: 0.5, mistake: 0.35, offence: 0.35, hesitate: 0.65 },
  { id: 'medium', reaction: 1.2, defence: 0.8, counter: 0.7, tempo: 1.35, combo: 0.85, mistake: 0.18, offence: 0.7, hesitate: 0.3 },
  { id: 'hard', reaction: 0.85, defence: 1.15, counter: 1.15, tempo: 0.8, combo: 1.2, mistake: 0, offence: 1.2, hesitate: 0 },
];

/** A style with a difficulty applied. */
export function withDifficulty(st: StyleParams, d: Difficulty): StyleParams {
  const cap = (x: number): number => Math.min(1, x);
  return {
    ...st,
    reaction: st.reaction * d.reaction,
    blockChance: cap(st.blockChance * d.defence), insideBlock: cap(st.insideBlock * d.defence), insideGuard: cap(st.insideGuard * d.defence),
    slipShare: cap(st.slipShare * d.defence), rollShare: cap(st.rollShare * d.defence), coverChance: cap(st.coverChance * d.defence),
    counterChance: cap(st.counterChance * d.counter),
    attackDelayMin: st.attackDelayMin * d.tempo, attackDelayMax: st.attackDelayMax * d.tempo,
    comboChance: cap(st.comboChance * d.combo),
    intercept: cap(st.intercept * d.offence), blockCounter: cap(st.blockCounter * d.offence), crowdPush: cap(st.crowdPush * d.offence),
    readChance: cap(st.readChance * d.defence), slipCounter: cap(st.slipCounter * d.counter),
    mistake: d.mistake, hesitate: d.hesitate,
  };
}

/** The style table: a full StyleParams for a style id, at a difficulty (0 easy, 1 medium, 2 hard; default cfg.aiDifficulty). */
export function styleParams(id: AiStyle, cfg: Config, difficulty: number = cfg.aiDifficulty): StyleParams {
  const d = DIFFICULTY[Math.max(0, Math.min(2, Math.round(difficulty)))]!;
  return withDifficulty({ ...defaultStyle({ ...cfg, aiToolsOn: true }), ...STYLE_OVERRIDES[id] }, d);
}

/**
 * The AI style for a fighter: his spec's style at the configured (or given)
 * difficulty. The host calls `createAi(side, seed, cfg, styleFor(spec, cfg))`.
 */
export function styleFor(spec: Pick<FighterSpec, 'style'> & Partial<FighterSpec>, cfg: Config, difficulty: number = cfg.aiDifficulty): StyleParams {
  const st = styleParams(spec.style, cfg, difficulty);
  return spec.heightM !== undefined && spec.reachM !== undefined && spec.massKg !== undefined ? withReach(st, spec as FighterSpec, cfg) : st;
}

/**
 * A style on a body (phase 3): the distances in a StyleParams are written for
 * the reference arm (aiReachRefArm — blue's, the body the AI always had). On
 * another body every range it holds or commits from is scaled by how far its
 * punches actually reach: measured over the roster, a jab's longest landing
 * distance moves aiReachPerArm × the arm-length difference (the 1.63 m man's
 * jab lands to 0.86 m, the 1.98 m man's to 1.20). Without it the short man
 * throws from where he cannot reach and the tall man stands inside his own jab.
 */
const SHORT_HOOK = 0.92;   // the least a hook's or uppercut's range shrinks to on a short arm (shape: see below)
export function withReach(st: StyleParams, spec: FighterSpec, cfg: Config): StyleParams {
  const b = bodyDims(spec, cfg);
  // (× aiReachEager: the written distances sit well inside the reference arm's real reach — 0.9 m against a jab that
  // lands to 1.13 — and measured over the matrix the AI does better the earlier it throws at a man coming in.)
  const q = Math.max(0.6, Math.min(1.4, (1 + cfg.aiReachPerArm * (b.upperArm + b.forearm - cfg.aiReachRefArm)) * cfg.aiReachEager));
  return {
    ...st,
    // (Where it STANDS only grows with the arm: measured, a shorter man made to stand closer — 0.72 → 0.65 m, inside
    // rangeInside — lost every fight to the inside-fighter bot; he steps in to throw instead.)
    standoff: st.standoff * Math.max(1, q), probeDist: st.probeDist * q, resetDist: st.resetDist * q,
    // (Hooks and uppercuts are thrown at bodies that cannot come closer than chest to chest, so their ranges shrink
    // far less than the arm does: measured, the 1.63 m man's hook lands to 0.75 m and his uppercut to 0.55, against
    // 0.84 / 0.65 on the reference arm. Scaled by the arm alone he never came close enough to throw either.)
    engageStraight: st.engageStraight * q, engageHook: st.engageHook * Math.max(q, SHORT_HOOK), engageUppercut: st.engageUppercut * Math.max(q, SHORT_HOOK),
  };
}

export const STYLE_IDS: readonly AiStyle[] = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];

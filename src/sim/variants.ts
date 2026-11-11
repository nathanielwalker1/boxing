/**
 * sim/variants.ts — the contextual punch behind each button (overhaul
 * 2026-11-11, brief A2: "the same four buttons throw different punches
 * depending on range, level and what the feet are doing").
 *
 * The four PunchTypes stay the base table (punches.ts: timing, turn, path).
 * A VARIANT is chosen at the press and rides on top of its base:
 *
 *   button    level held          just came up      stick back      inside range     otherwise
 *   jab       bodyJab             —                 retreatJab      —                stepJab (stick fwd) / jab
 *   cross     overhand (stick     —                 —               —                cross
 *             fwd) / bodyCross
 *   hook      bodyHook            risingHook        checkHook       shovelHook       hook
 *   uppercut  risingUppercut      risingUppercut    —               insideUppercut   uppercut
 *
 * Priority is left to right. What a variant changes: wind-up + recovery time,
 * impulse, how much the feet may move while it is in flight, where the fist
 * is aimed (a body shot's peak is lower; an overhand loops and comes down),
 * its reach, and what the level does through it (a body shot stays down, a
 * rising punch drives up). Hit geometry stays honest: a body shot hits the
 * body because the fist is at body height.
 *
 * Numbers a designer tunes are config keys (group `level`); the shape flags
 * here are authored data, like the PUNCHES table.
 */
import type { Config, FighterState, PunchType, PunchVariant } from '../core';
import type { PunchPath } from './punches';

export interface VariantDef {
  base: PunchType;
  /** Aimed at the body. */
  body: boolean;
  /** The level through the flight: 1 = stays down, −1 = drives up out of the crouch, 0 = follows the input. */
  hold: -1 | 0 | 1;
  /** Wind-up and recovery multiplier. */
  time(cfg: Config): number;
  /** Impulse multiplier. */
  power(cfg: Config): number;
  /** Walking speed while it is in flight, × normal. */
  move(cfg: Config): number;
  /** The peak is lowered this far, m. */
  aimDrop(cfg: Config): number;
  /** Peak reach multiplier (shape). */
  reach: number;
  /** The fist loops this far above its straight line mid-flight, m. */
  arc(cfg: Config): number;
  /** The feet hop BACK this far as it is thrown, m. */
  hop(cfg: Config): number;
  /** Impulse-direction swing override (null = the base punch's). */
  swing(cfg: Config): number | null;
}

const one = (): number => 1;
const zero = (): number => 0;
const none = (): null => null;
const base = (b: PunchType, move: (cfg: Config) => number): VariantDef =>
  ({ base: b, body: false, hold: 0, time: one, power: one, move, aimDrop: zero, reach: 1, arc: zero, hop: zero, swing: none });

export const VARIANTS: Record<PunchVariant, VariantDef> = {
  jab:        base('jab', cfg => cfg.jabMove),
  stepJab:    base('jab', cfg => cfg.stepJabMove),
  retreatJab: { ...base('jab', cfg => cfg.retreatJabMove), time: cfg => cfg.retreatJabTime, power: cfg => cfg.retreatJabPower, hop: cfg => cfg.retreatJabHop },
  bodyJab:    { ...base('jab', cfg => cfg.bodyJabMove), body: true, hold: 1, time: cfg => cfg.bodyJabTime, power: cfg => cfg.bodyJabPower, aimDrop: cfg => cfg.bodyAimDrop },
  cross:      base('cross', cfg => cfg.crossMove),
  bodyCross:  { ...base('cross', cfg => cfg.bodyCrossMove), body: true, hold: 1, time: cfg => cfg.bodyCrossTime, power: cfg => cfg.bodyCrossPower, aimDrop: cfg => cfg.bodyAimDrop },
  overhand:   { ...base('cross', cfg => cfg.overhandMove), hold: -1, time: cfg => cfg.overhandTime, power: cfg => cfg.overhandPower, aimDrop: cfg => cfg.overhandAimDrop, arc: cfg => cfg.overhandArc },
  hook:       base('hook', cfg => cfg.hookMove),
  checkHook:  { ...base('hook', cfg => cfg.checkHookMove), time: cfg => cfg.checkHookTime, power: cfg => cfg.checkHookPower, hop: cfg => cfg.checkHookHop },
  shovelHook: { ...base('hook', cfg => cfg.shovelHookMove), time: cfg => cfg.shovelHookTime, power: cfg => cfg.shovelHookPower, reach: 0.88, swing: cfg => cfg.shovelHookSwing },
  bodyHook:   { ...base('hook', cfg => cfg.bodyHookMove), body: true, hold: 1, time: cfg => cfg.bodyHookTime, power: cfg => cfg.bodyHookPower, aimDrop: cfg => cfg.bodyAimDrop },
  risingHook: { ...base('hook', cfg => cfg.risingHookMove), hold: -1, time: cfg => cfg.risingHookTime, power: cfg => cfg.risingHookPower },
  uppercut:   base('uppercut', cfg => cfg.uppercutMove),
  insideUppercut: { ...base('uppercut', cfg => cfg.insideUppercutMove), time: cfg => cfg.insideUppercutTime, power: cfg => cfg.insideUppercutPower, reach: 0.92 },
  risingUppercut: { ...base('uppercut', cfg => cfg.risingUppercutMove), hold: -1, time: cfg => cfg.risingUppercutTime, power: cfg => cfg.risingUppercutPower },
};

/** Every variant, for tests and probes. */
export const VARIANT_NAMES = Object.keys(VARIANTS) as PunchVariant[];

/**
 * Which variant a press throws. `moveY` is the stick at the press (+ = toward
 * the opponent). Reads the fighter's level, the rise window and the range band
 * the footing step derived last tick.
 */
export function pickVariant(f: FighterState, type: PunchType, moveY: number, cfg: Config): PunchVariant {
  if (!cfg.variantsOn) return type;
  const low = cfg.levelOn && f.level >= cfg.levelAt;
  const rising = cfg.levelOn && !low && f.riseT > 0;
  const back = moveY <= -cfg.variantStick;
  const fwd = moveY > cfg.punchStepInStick;
  const inside = f.range === 'inside';
  switch (type) {
    case 'jab': return low ? 'bodyJab' : fwd && cfg.punchStepIn > 0 ? 'stepJab' : back ? 'retreatJab' : 'jab';
    case 'cross': return low ? (fwd ? 'overhand' : 'bodyCross') : 'cross';
    case 'hook': return low ? 'bodyHook' : rising ? 'risingHook' : back ? 'checkHook' : inside ? 'shovelHook' : 'hook';
    case 'uppercut': return low || rising ? 'risingUppercut' : inside ? 'insideUppercut' : 'uppercut';
  }
}

/**
 * A base punch's path, bent into the variant: the peak (and half of it, the
 * wind-up) lowered by the aim drop, the peak pulled in by `reach`, and for a
 * looping punch a waypoint above the straight line. Works in whichever frame
 * the base path is authored in (a yaw never changes `up`). `drop` is the
 * punch's own aim (PunchState.aim, fixed at the press); it defaults to the
 * variant's nominal drop.
 */
/**
 * How far below its lane a punch of this variant is aimed, fixed at the
 * press. The two punches that answer a low head are thrown at where the head
 * IS at that moment: the overhand comes down on it (to overhandAimDrop), the
 * uppercut comes up under it (to uppercutAimDrop). Straights and hooks keep
 * their lane — that is what ducking is for.
 */
export function aimAtPress(v: VariantDef, opp: FighterState, cfg: Config): number {
  const headDown = Math.max(0, opp.body.headY - opp.headBox.y);
  if (v.arc(cfg) > 0) return Math.min(v.aimDrop(cfg), headDown);
  if (v.base === 'uppercut') return Math.min(cfg.uppercutAimDrop, headDown);
  return v.aimDrop(cfg);
}

/** (see above) */
export function shapePath(path: PunchPath, v: VariantDef, cfg: Config, drop: number = v.aimDrop(cfg)): PunchPath {
  const arc = v.arc(cfg);
  if (drop === 0 && arc === 0 && v.reach === 1) return path;
  const peak = { fwd: path.peak.fwd * v.reach, up: path.peak.up - drop, lat: path.peak.lat * v.reach };
  const cocked = { fwd: path.cocked.fwd, up: path.cocked.up - (v.body ? drop * 0.5 : 0), lat: path.cocked.lat };
  let via = path.via ? { fwd: path.via.fwd * v.reach, up: path.via.up - drop * 0.75, lat: path.via.lat * v.reach } : null;
  if (arc > 0 && !via) via = { fwd: (cocked.fwd + peak.fwd) / 2, up: Math.max(cocked.up, peak.up) + arc, lat: (cocked.lat + peak.lat) / 2 };
  return { cocked, via, peak };
}

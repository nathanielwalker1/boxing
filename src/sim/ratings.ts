/**
 * sim/ratings.ts — the five 0–100 ratings, wired (overhaul phase 2, brief C:
 * "audit which of power, speed, chin, stamina and defense the sim uses and
 * make each one obvious within thirty seconds").
 *
 * Every effect is `1 + span × x`, x = (rating − ratingNeutral) / ratingRange
 * clamped to ±1 — so a fighter rated ratingNeutral (65, about the roster's
 * middle) is exactly the un-rated sim, 100 is +span and 30 is −span. The
 * spans are config keys (group `ratings`); `ratingsOn` off = nobody is rated.
 *
 *   power    impulse of every punch (so damage, stagger, the rock and flash bars it clears)
 *   speed    wind-up and recovery of every punch (never the 3-tick strike itself), walking speed, burst length
 *   stamina  what a punch and the guard cost, how fast wind comes back, how late fatigue starts
 *   defense  guard meter wear, what the block absorbs, block stun taken, how long a slip keeps the head off the line
 *   chin     the rock threshold (stun.ts, as before) and now the body threshold too
 */
import type { Config, FighterState, Ratings } from '../core';
import { clamp } from '../core';

/** −1..1: how far `which` is from neutral. 0 with ratings off. */
export function ratingX(f: FighterState, which: keyof Ratings, cfg: Config): number {
  if (!cfg.ratingsOn || cfg.ratingRange <= 0) return 0;
  return clamp((f.ratings[which] - cfg.ratingNeutral) / cfg.ratingRange, -1, 1);
}

/** The multiplier a rating gives an effect of size `span` (negative span = a cost that falls as the rating rises). */
export function rated(f: FighterState, which: keyof Ratings, span: number, cfg: Config): number {
  return 1 + span * ratingX(f, which, cfg);
}

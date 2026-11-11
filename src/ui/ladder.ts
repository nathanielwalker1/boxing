/**
 * ui/ladder.ts — the seven-fight ladder: pick a fighter, fight the other
 * seven in order of a simple rating sum (weakest first), the difficulty
 * stepping easy → medium → hard up the rungs. Progress is one small record in
 * localStorage; every access is in try/catch, so with storage blocked the
 * ladder still plays and is simply forgotten on reload.
 */
import { generateFighter, type FighterSpec } from '../core';

export interface LadderSave {
  /** Roster id, or `gen-<seed>` for a generated fighter. */
  fighter: string;
  /** Rungs won = the index of the next opponent. */
  wins: number;
  losses: number;
}

const KEY = 'longcount.ladder.v1';

export const ratingSum = (f: FighterSpec): number => f.power + f.speed + f.chin + f.stamina + f.defense;

/** The rungs for `player`: everyone else on the roster, weakest first (id breaks ties so the order is stable). */
export function ladderOrder(player: FighterSpec, roster: readonly FighterSpec[]): FighterSpec[] {
  return roster.filter(f => f.id !== player.id).sort((a, b) => ratingSum(a) - ratingSum(b) || (a.id < b.id ? -1 : 1));
}

/** Difficulty of rung `i` of `n`: the first two easy, the last two hard, the middle medium. */
export function ladderDifficulty(i: number, n: number): 0 | 1 | 2 {
  if (i < 2) return 0;
  if (i >= n - 2) return 2;
  return 1;
}

export const DIFFICULTY_NAMES = ['Easy', 'Medium', 'Hard'] as const;

/** The saved fighter's spec: a roster entry, or the generated fighter rebuilt from its seed. */
export function ladderFighter(save: LadderSave, roster: readonly FighterSpec[]): FighterSpec | null {
  const r = roster.find(f => f.id === save.fighter);
  if (r) return r;
  const m = /^gen-(-?\d+)$/.exec(save.fighter);
  return m ? generateFighter(Number(m[1])) : null;
}

export function loadLadder(): LadderSave | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<LadderSave>;
    if (typeof o.fighter !== 'string' || typeof o.wins !== 'number' || typeof o.losses !== 'number') return null;
    return { fighter: o.fighter, wins: Math.max(0, Math.floor(o.wins)), losses: Math.max(0, Math.floor(o.losses)) };
  } catch { return null; }
}

export function saveLadder(s: LadderSave | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch { /* no storage: the ladder lives for this page load only */ }
}

/**
 * core/record.ts — a fighter's record: wins, losses, draws, how many by knockout, the
 * current streak and the last twenty fights. Pure: the caller passes the time, nothing
 * here reads a clock or a random number. `applyFight` returns a new record.
 *
 * Endings are the sim's own: a knockout, a technical knockout (the referee stops it) or a
 * decision (`ko` / `tko` / `decision` events, core/types.ts). A drawn decision has no winner.
 * A KO or TKO win counts as a "knockout" win in the line.
 */
export type FightResult = 'W' | 'L' | 'D';
export type FightMethod = 'KO' | 'TKO' | 'decision';

export interface FightEntry {
  opponent: string;
  result: FightResult;
  method: FightMethod;
  /** 1-based round the fight ended in. */
  round: number;
  /** Caller's timestamp (ms since the epoch); the record never reads a clock. */
  when: number;
}

export interface FightRecord {
  wins: number; losses: number; draws: number;
  /** Wins by KO or TKO. */
  koWins: number;
  /** Losses by KO or TKO. */
  koLosses: number;
  /** Signed: +3 is three wins running, -2 two losses running, 0 after a draw or before a fight. */
  streak: number;
  /** Newest last, at most RECORD_HISTORY. */
  history: FightEntry[];
}

/** How many recent fights are kept. */
export const RECORD_HISTORY = 20;

export function emptyRecord(): FightRecord {
  return { wins: 0, losses: 0, draws: 0, koWins: 0, koLosses: 0, streak: 0, history: [] };
}

const stopped = (m: FightMethod): boolean => m === 'KO' || m === 'TKO';

export function applyFight(r: FightRecord, e: FightEntry): FightRecord {
  const out: FightRecord = { ...r, history: [...r.history, { ...e }].slice(-RECORD_HISTORY) };
  if (e.result === 'W') {
    out.wins++; if (stopped(e.method)) out.koWins++;
    out.streak = r.streak > 0 ? r.streak + 1 : 1;
  } else if (e.result === 'L') {
    out.losses++; if (stopped(e.method)) out.koLosses++;
    out.streak = r.streak < 0 ? r.streak - 1 : -1;
  } else {
    out.draws++;
    out.streak = 0;
  }
  return out;
}

/** "3-1-0 (2 KO)" style: draws only when there are some, the knockout part only when there are any. "0-0" when empty. */
export function recordLine(r: FightRecord): string {
  const base = r.draws > 0 ? `${r.wins}-${r.losses}-${r.draws}` : `${r.wins}-${r.losses}`;
  return r.koWins > 0 ? `${base} (${r.koWins} KO)` : base;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : NaN);
const isEntry = (v: unknown): v is FightEntry => {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e['opponent'] === 'string' && (e['result'] === 'W' || e['result'] === 'L' || e['result'] === 'D') &&
    (e['method'] === 'KO' || e['method'] === 'TKO' || e['method'] === 'decision') &&
    typeof e['round'] === 'number' && Number.isFinite(e['round']) && typeof e['when'] === 'number' && Number.isFinite(e['when']);
};

/** From a JSON string (or an already parsed value): the record, or an empty one for anything malformed. */
export function parseRecord(json: unknown): FightRecord {
  try {
    const o: unknown = typeof json === 'string' ? JSON.parse(json) : json;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return emptyRecord();
    const r = o as Record<string, unknown>;
    const wins = count(r['wins']), losses = count(r['losses']), draws = count(r['draws']), koWins = count(r['koWins']), koLosses = count(r['koLosses']);
    const streak = r['streak'];
    if ([wins, losses, draws, koWins, koLosses].some(Number.isNaN) || typeof streak !== 'number' || !Number.isFinite(streak) || !Array.isArray(r['history'])) return emptyRecord();
    if (koWins > wins || koLosses > losses) return emptyRecord();
    const history = (r['history'] as unknown[]).filter(isEntry).slice(-RECORD_HISTORY).map(e => ({ ...e }));
    return { wins, losses, draws, koWins, koLosses, streak: Math.trunc(streak), history };
  } catch { return emptyRecord(); }
}

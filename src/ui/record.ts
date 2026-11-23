/**
 * ui/record.ts — the created fighter's record in localStorage (`boxing.record.v1`). The record itself is
 * core/record.ts; this is only the saving. Every access is in try/catch, so with storage blocked the
 * record lives for this page load only (kept in memory below) and is forgotten on reload.
 */
import { emptyRecord, parseRecord, type FightRecord } from '../core';

const KEY = 'boxing.record.v1';
let memory: FightRecord | null = null;   // what storage could not hold

export function loadRecord(): FightRecord {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseRecord(raw) : emptyRecord();
  } catch { return memory ?? emptyRecord(); }
}

export function saveRecord(r: FightRecord): void {
  memory = r;
  try { localStorage.setItem(KEY, JSON.stringify(r)); } catch { /* no storage: kept in memory */ }
}

export function clearRecord(): void {
  memory = null;
  try { localStorage.removeItem(KEY); } catch { /* no storage */ }
}

declare global {
  interface Window {
    /** The saved record of the created fighter, for scripts. */
    __record?: () => FightRecord;
  }
}

export function exposeRecord(): void { window.__record = loadRecord; }

/**
 * core/roster.ts — fighter data. Exempt from the core freeze (data, not
 * interface). Two entries for Stages 1–3; eight by Stage 4 (CONTRACT §5).
 * Names are fictional; no real names, trademarks, or logos.
 */
import type { FighterSpec } from './types';

export const ROSTER: readonly FighterSpec[] = [
  {
    id: 'red', name: 'Ray Castellano', nickname: 'The Anvil', hometown: 'Bayonne',
    stance: 'orthodox',
    heightM: 1.80, reachM: 1.85, massKg: 79, build: 'athletic',
    skin: '#c58c5c', trunksPrimary: '#b8202a', trunksSecondary: '#f2e6c8', trunksStyle: 'short',
    gloves: '#b8202a', boots: '#f2e6c8',
    hair: 'short', facialHair: 'none',
    power: 68, speed: 62, chin: 70, stamina: 65, defense: 60,
    style: 'pressure',
  },
  {
    id: 'blue', name: 'Desmond Okafor', nickname: 'Silk', hometown: 'Peckham',
    stance: 'orthodox',
    heightM: 1.86, reachM: 1.96, massKg: 82, build: 'lean',
    skin: '#6b4226', trunksPrimary: '#2b4a9e', trunksSecondary: '#e8e8ee', trunksStyle: 'long',
    gloves: '#2b4a9e', boots: '#e8e8ee',
    hair: 'none', facialHair: 'goatee',
    power: 58, speed: 74, chin: 62, stamina: 70, defense: 72,
    style: 'outboxer',
  },
];

export function specById(id: string): FighterSpec {
  const s = ROSTER.find(f => f.id === id);
  if (!s) throw new Error(`roster: no fighter '${id}'`);
  return s;
}

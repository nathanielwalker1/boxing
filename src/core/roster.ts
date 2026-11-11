/**
 * core/roster.ts — fighter data. Exempt from the core freeze (data, not
 * interface). Eight fighters (CONTRACT §5; overhaul 2026-11-11), built to be
 * told apart by silhouette alone. Names are fictional; no real names,
 * trademarks, or logos.
 *
 * `red` and `blue` are the first two and their sim numbers are PINNED: ids,
 * height / reach / mass / stance / ratings, and the morph fields that reach
 * core/body.ts (frame, muscle, positive bodyFat, limbLength, neck). The sim
 * tests hold 2 cm margins on those two bodies (scripts/roster_test.mjs).
 */
import type { FighterSpec, HeadMorph } from './types';

export { generateFighter } from './generator';

const head = (h: Partial<HeadMorph>): HeadMorph => ({ width: 0, jaw: 0, chin: 0, brow: 0, nose: 0, ears: 0, height: 0, ...h });

const FIGHTERS: FighterSpec[] = [
  {
    // The baseline athlete: square jaw, cropped hair, classic red.
    id: 'red', name: 'Ray Castellano', nickname: 'The Anvil', hometown: 'Bayonne',
    stance: 'orthodox',
    heightM: 1.80, reachM: 1.85, massKg: 79,
    morph: { frame: 0, muscle: 0, bodyFat: -0.25, limbLength: 0, neck: 0, head: head({ jaw: 0.5, brow: 0.3, chin: 0.2 }) },
    skin: '#c58c5c', trunksPrimary: '#b8202a', trunksSecondary: '#f2e6c8', trunksStyle: 'short', trunksPattern: 'sideStripe',
    gloves: '#b8202a', boots: '#f2e6c8', bootHeight: 'mid', bootTrim: '#b8202a',
    hair: 'short', hairColor: '#1c1612', facialHair: 'stubble',
    power: 68, speed: 62, chin: 70, stamina: 65, defense: 60,
    style: 'pressure',
  },
  {
    // Lean and long: shaved head, goatee, long trunks, tall boots.
    id: 'blue', name: 'Desmond Okafor', nickname: 'Silk', hometown: 'Peckham',
    stance: 'orthodox',
    heightM: 1.86, reachM: 1.96, massKg: 82,
    morph: { frame: 0, muscle: -0.5, bodyFat: -0.6, limbLength: 0, neck: 0, head: head({ width: -0.4, height: 0.4, jaw: -0.2, nose: 0.3 }) },
    skin: '#6b4226', trunksPrimary: '#2b4a9e', trunksSecondary: '#e8e8ee', trunksStyle: 'long', trunksPattern: 'waistStripe',
    gloves: '#2b4a9e', boots: '#e8e8ee', bootHeight: 'high', bootTrim: '#2b4a9e', bootStripes: true,
    hair: 'none', facialHair: 'goatee', hairColor: '#120e0c',
    power: 58, speed: 74, chin: 62, stamina: 70, defense: 72,
    style: 'outboxer',
  },
  {
    // Short and barrel-chested: no neck, a flat-top, a handlebar, a champion's belt-high waistband.
    id: 'boiler', name: 'Benny Brask', nickname: 'The Boiler', hometown: 'Sunderland',
    stance: 'orthodox',
    heightM: 1.63, reachM: 1.62, massKg: 70,
    morph: { frame: 0.85, muscle: 0.8, bodyFat: 0.1, limbLength: -0.9, neck: 1, head: head({ width: 0.7, jaw: 0.9, brow: 0.6, chin: -0.2, height: -0.5, ears: 0.4 }) },
    skin: '#e2b08a', trunksPrimary: '#16161c', trunksSecondary: '#d9b43a', trunksStyle: 'belt', trunksPattern: 'checker',
    gloves: '#d9b43a', gloveCuff: '#16161c', gloveClosure: 'strap', boots: '#16161c', bootHeight: 'low', bootTrim: '#d9b43a',
    hair: 'flatTop', hairColor: '#b0452a', facialHair: 'handlebar',
    tattoos: [{ place: 'forearmL', motif: 'bands', seed: 11 }, { place: 'forearmR', motif: 'bands', seed: 12 }],
    power: 76, speed: 72, chin: 84, stamina: 86, defense: 46,
    style: 'swarmer',
  },
  {
    // 1.98 m of reach: narrow, long-legged, long-necked, slicked blond hair, trunks to the knee.
    id: 'lighthouse', name: 'Ilya Voss', nickname: 'The Lighthouse', hometown: 'Tallinn',
    stance: 'orthodox',
    heightM: 1.98, reachM: 2.11, massKg: 86,
    morph: { frame: -0.55, muscle: -0.7, bodyFat: -0.5, limbLength: 0.95, neck: -0.9, head: head({ width: -0.6, height: 0.7, chin: 0.6, jaw: -0.4, nose: 0.5 }) },
    skin: '#f0c8a4', trunksPrimary: '#eeeae0', trunksSecondary: '#3aa0c8', trunksStyle: 'long', trunksPattern: 'gradient',
    gloves: '#eeeae0', gloveCuff: '#3aa0c8', glovePanel: '#3aa0c8', boots: '#eeeae0', bootHeight: 'high', bootTrim: '#3aa0c8',
    hair: 'slick', hairColor: '#c9a24e', facialHair: 'none', eyeColor: '#48607a',
    power: 60, speed: 70, chin: 52, stamina: 68, defense: 82,
    style: 'outboxer',
  },
  {
    // The slugger: a wide frame under a gut, a bull neck, mutton chops, a receding ginger crop.
    id: 'raffle', name: 'Dunstan Pike', nickname: 'Meat Raffle', hometown: 'Barnsley',
    stance: 'orthodox',
    heightM: 1.88, reachM: 1.90, massKg: 112,
    morph: { frame: 0.9, muscle: 0.45, bodyFat: 1, limbLength: -0.2, neck: 1, head: head({ width: 0.8, jaw: 0.6, brow: 0.4, nose: 0.6, chin: -0.3 }) },
    skin: '#f0c8a4', trunksPrimary: '#1f6b3a', trunksSecondary: '#f0ece2', trunksStyle: 'classic', trunksPattern: 'stars',
    gloves: '#1f6b3a', boots: '#16161c', bootHeight: 'mid', bootTrim: '#f0ece2',
    hair: 'receding', hairColor: '#b0452a', facialHair: 'muttonChops',
    tattoos: [{ place: 'shoulderR', motif: 'rose', seed: 5 }, { place: 'forearmL', motif: 'star', seed: 8 }],
    power: 93, speed: 36, chin: 88, stamina: 44, defense: 40,
    style: 'slugger',
  },
  {
    // The wiry southpaw: all sinew, big ears, a hooked nose, cornrows, split-side trunks with flames.
    id: 'alambre', name: 'Tomás Quiroga', nickname: 'El Alambre', hometown: 'Mendoza',
    stance: 'southpaw',
    heightM: 1.71, reachM: 1.84, massKg: 62,
    morph: { frame: -0.75, muscle: -0.3, bodyFat: -1, limbLength: 0.45, neck: -0.4, head: head({ width: -0.3, nose: 0.9, ears: 0.9, jaw: -0.5, chin: 0.3, brow: 0.2 }) },
    skin: '#a9744a', trunksPrimary: '#5a2a8a', trunksSecondary: '#e8c22e', trunksStyle: 'split', trunksPattern: 'flames',
    gloves: '#e8c22e', gloveThumb: '#5a2a8a', boots: '#5a2a8a', bootHeight: 'low', bootTrim: '#e8c22e', bootTassels: true,
    hair: 'cornrows', hairColor: '#15110e', facialHair: 'soulPatch',
    tattoos: [{ place: 'neck', motif: 'script', seed: 3 }, { place: 'ribs', motif: 'serpent', seed: 21 }],
    power: 52, speed: 90, chin: 56, stamina: 80, defense: 88,
    style: 'counter',
  },
  {
    // The pressure fighter: dreadlocks, a full beard, sleeves of ink, a gladiator skirt.
    id: 'monsoon', name: 'Kofi Adjei-Lund', nickname: 'Monsoon', hometown: 'Tema',
    stance: 'orthodox',
    heightM: 1.78, reachM: 1.84, massKg: 77,
    morph: { frame: 0.3, muscle: 0.65, bodyFat: -0.45, limbLength: 0, neck: 0.4, head: head({ width: 0.2, brow: 0.5, jaw: 0.3 }) },
    skin: '#553320', trunksPrimary: '#16161c', trunksSecondary: '#e0661c', trunksStyle: 'skirt', trunksPattern: 'twoTone',
    gloves: '#e0661c', gloveCuff: '#16161c', boots: '#16161c', bootHeight: 'mid', bootTrim: '#e0661c', bootStripes: true,
    hair: 'dreads', hairColor: '#1c1612', facialHair: 'beard',
    tattoos: [
      { place: 'sleeveL', motif: 'tribal', seed: 31 }, { place: 'sleeveR', motif: 'serpent', seed: 32 }, { place: 'forearmL', motif: 'geometric', seed: 33 },
      { place: 'chest', motif: 'wings', seed: 34 }, { place: 'back', motif: 'geometric', seed: 35 },
    ],
    power: 74, speed: 68, chin: 76, stamina: 92, defense: 54,
    style: 'pressure',
  },
  {
    // The veteran: thick through the middle, a broken nose, grey hair tied back, a long grey beard, long trunks.
    id: 'grandad', name: 'Walt Kowalczyk', nickname: 'Grandad', hometown: 'Scranton',
    stance: 'orthodox',
    heightM: 1.83, reachM: 1.87, massKg: 88,
    morph: { frame: 0.25, muscle: -0.1, bodyFat: 0.5, limbLength: 0.1, neck: 0.35, head: head({ brow: 0.9, nose: 0.8, ears: 0.6, jaw: 0.2, height: -0.2 }) },
    skin: '#d39a70', trunksPrimary: '#6e1f2e', trunksSecondary: '#e9dcc0', trunksStyle: 'long', trunksPattern: 'solid',
    gloves: '#3a2a22', gloveCuff: '#e9dcc0', boots: '#3a2a22', bootHeight: 'mid', bootTrim: '#e9dcc0',
    hair: 'tied', hairColor: '#9a9894', facialHair: 'longBeard',
    tattoos: [{ place: 'forearmR', motif: 'star', seed: 41 }, { place: 'shoulderL', motif: 'cross', seed: 42 }],
    power: 70, speed: 48, chin: 86, stamina: 58, defense: 84,
    style: 'counter',
  },
];

export const ROSTER: readonly FighterSpec[] = FIGHTERS;

/** Add a fighter at runtime (generated opponents; the lookbook's generator sheet). Replaces an entry with the same id. */
export function addToRoster(spec: FighterSpec): void {
  const i = FIGHTERS.findIndex(f => f.id === spec.id);
  if (i >= 0) FIGHTERS[i] = spec; else FIGHTERS.push(spec);
}

/** The third man in the ring (Stage 3). Never a sim fighter: ui/referee.ts drives a FighterState for the rig to draw. */
export const REFEREE: FighterSpec = {
  id: 'referee', name: 'Referee', nickname: '', hometown: '',
  stance: 'orthodox',
  heightM: 1.76, reachM: 1.78, massKg: 74,
  morph: { frame: 0, muscle: -0.5, bodyFat: 0, limbLength: 0, neck: 0, head: head({ nose: 0.3 }) },
  skin: '#d9a57a', trunksPrimary: '#1b1b22', trunksSecondary: '#101014', trunksStyle: 'long',
  gloves: '#d9a57a', boots: '#15151a',
  hair: 'receding', hairColor: '#5a554e', facialHair: 'moustache',
  outfit: { shirt: '#9fb6d8', trousers: '#1b1b22', tie: '#101014' },
  power: 0, speed: 0, chin: 0, stamina: 0, defense: 0,
  style: 'outboxer',
};

export function specById(id: string): FighterSpec {
  const s = ROSTER.find(f => f.id === id);
  if (!s) throw new Error(`roster: no fighter '${id}'`);
  return s;
}

/**
 * core/generator.ts — a believable new fighter from a seed (overhaul
 * 2026-11-11). Deterministic: the same seed is the same FighterSpec, on every
 * engine (core/rng.ts only — no Math.random).
 *
 * The draw is correlated, not independent: a weight class sets the height,
 * a body type sets frame / muscle / fat / limb length together, mass follows
 * from height and build, reach from height and limb length, the ratings from
 * the body (heavy and muscular hits hard, light and long is quick, a thick
 * neck takes a shot, a lean engine lasts), and the style from the ratings.
 * Names are assembled from word lists; none is a real person.
 */
import { rngFloat, rngInt, rngRange, seedRng } from './rng';
import type { AiStyle, BodyMorph, BootHeight, FacialHair, FighterSpec, HairStyle, RngState, Tattoo, TattooMotif, TattooPlace, TrunksCut, TrunksPattern } from './types';

const FIRST = ['Mick', 'Dario', 'Tunde', 'Lev', 'Cal', 'Oskar', 'Rafa', 'Jomo', 'Ezra', 'Paulie', 'Idris', 'Kenji', 'Luca', 'Bram', 'Siosaia', 'Yusuf', 'Dmitri', 'Chidi', 'Arlo', 'Mateus', 'Farid', 'Gus', 'Emeka', 'Nico', 'Hale', 'Joaquín', 'Tavita', 'Sören', 'Kwame', 'Eddie'];
const LAST_A = ['Har', 'Mon', 'Okon', 'Vasil', 'Brad', 'Cas', 'Del', 'Fer', 'Gor', 'Kov', 'Lam', 'Mar', 'Nak', 'Ost', 'Pet', 'Quin', 'Ros', 'Sal', 'Tor', 'Wex', 'Adey', 'Bal', 'Dra', 'Zub'];
const LAST_B = ['low', 'tez', 'kwo', 'enko', 'dock', 'tillo', 'gado', 'rant', 'ski', 'ács', 'bert', 'quez', 'amura', 'berg', 'rov', 'lan', 'setti', 'azar', 'res', 'ford', 'emi', 'dini', 'gan', 'iri'];
const NICK_BY_STYLE: Record<AiStyle, string[]> = {
  pressure: ['The Furnace', 'Steamroller', 'No Reverse', 'The Tide', 'Bulldozer', 'Forward Gear'],
  counter: ['The Mirror', 'Second Thoughts', 'The Trap', 'Receipt', 'The Lawyer', 'Slipknot'],
  outboxer: ['The Compass', 'Long Division', 'The Surveyor', 'Arm\'s Length', 'The Metronome', 'Tape Measure'],
  swarmer: ['The Wasp', 'Hailstorm', 'Buzzsaw', 'The Bee Box', 'Hundred Hands', 'Popcorn'],
  slugger: ['The Sledge', 'One Appointment', 'Lights Out', 'The Wrecking Yard', 'Thunderclap', 'Last Orders'],
};
const TOWNS = ['Dagenham', 'Gdynia', 'Kumasi', 'Paterson', 'Valparaíso', 'Rotorua', 'Sheffield', 'Brăila', 'Durban', 'Osaka', 'Marseille', 'Guadalajara', 'Winnipeg', 'Tbilisi', 'Cebu', 'Port Talbot', 'Belo Horizonte', 'Leipzig', 'Lagos', 'Youngstown'];

const SKINS = ['#f0c8a4', '#e2b08a', '#d39a70', '#c58c5c', '#a9744a', '#8a5a38', '#6b4226', '#553320', '#3f2616'];
const HAIR_COLS = ['#15110e', '#1c1612', '#2b1c12', '#4a2d18', '#6e4322', '#a8742c', '#c9a24e', '#8c8a86', '#b0452a'];
const HAIRS: HairStyle[] = ['none', 'buzz', 'short', 'fade', 'flatTop', 'curls', 'afro', 'cornrows', 'braids', 'dreads', 'long', 'tied', 'mohawk', 'receding', 'slick', 'topKnot'];
const BEARDS: FacialHair[] = ['none', 'none', 'none', 'stubble', 'stubble', 'moustache', 'goatee', 'chinstrap', 'beard', 'longBeard', 'muttonChops', 'soulPatch', 'handlebar'];
const CUTS: TrunksCut[] = ['short', 'classic', 'classic', 'long', 'belt', 'skirt', 'split'];
const PATTERNS: TrunksPattern[] = ['solid', 'sideStripe', 'sideStripe', 'waistStripe', 'twoTone', 'flames', 'stars', 'checker', 'gradient'];
const PLACES: TattooPlace[] = ['chest', 'back', 'sleeveL', 'sleeveR', 'forearmL', 'forearmR', 'shoulderL', 'shoulderR', 'neck', 'ribs'];
const MOTIFS: TattooMotif[] = ['tribal', 'script', 'cross', 'star', 'wings', 'rose', 'bands', 'geometric', 'serpent'];
const BOOT_H: BootHeight[] = ['low', 'mid', 'mid', 'high'];

const pick = <T>(r: RngState, a: readonly T[]): T => a[Math.min(a.length - 1, Math.floor(rngFloat(r) * a.length))]!;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** A roughly bell-shaped draw in −1..1 (the mean of three uniforms). */
const bell = (r: RngState): number => (rngFloat(r) + rngFloat(r) + rngFloat(r)) / 1.5 - 1;
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** HSL (h in degrees, s and l in 0..1) → '#rrggbb'. */
function hsl(h: number, s: number, l: number): string {
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * clamp(c, 0, 1)).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function generateFighter(seed: number): FighterSpec {
  const r = seedRng((seed | 0) ^ 0x5bd1e995);
  // Body type: the four morphs move together.
  const type = pick(r, ['rangy', 'rangy', 'stocky', 'stocky', 'athlete', 'athlete', 'athlete', 'heavy', 'wiry'] as const);
  const base: Record<typeof type, [number, number, number, number]> = {
    //         frame  muscle  fat   limb
    rangy: [-0.4, -0.4, -0.4, 0.6],
    stocky: [0.6, 0.5, 0.1, -0.6],
    athlete: [0.1, 0.3, -0.3, 0.0],
    heavy: [0.7, 0.3, 0.7, -0.1],
    wiry: [-0.6, -0.2, -0.7, 0.2],
  };
  const b = base[type];
  const morph: BodyMorph = {
    frame: round2(clamp(b[0] + 0.3 * bell(r), -1, 1)),
    muscle: round2(clamp(b[1] + 0.35 * bell(r), -1, 1)),
    bodyFat: round2(clamp(b[2] + 0.3 * bell(r), -1, 1)),
    limbLength: round2(clamp(b[3] + 0.3 * bell(r), -1, 1)),
    neck: 0,
    head: {
      width: round2(bell(r)), jaw: round2(bell(r)), chin: round2(bell(r)), brow: round2(bell(r)),
      nose: round2(bell(r)), ears: round2(bell(r)), height: round2(bell(r)),
    },
  };
  morph.neck = round2(clamp(0.5 * morph.frame + 0.4 * morph.muscle + 0.3 * bell(r), -1, 1));
  // Height: stocky and heavy run shorter, rangy taller; 1.62 – 1.98.
  const heightM = round2(clamp(1.8 + 0.07 * morph.limbLength - 0.03 * morph.frame + 0.1 * bell(r), 1.62, 1.98));
  const fat = Math.max(0, morph.bodyFat);
  // Mass from height and build (a fighting-weight BMI of ~23.5 at neutral).
  const massKg = Math.round(23.5 * heightM * heightM * (1 + 0.1 * morph.frame + 0.13 * morph.muscle + 0.28 * fat - 0.04 * Math.max(0, -morph.bodyFat)));
  const reachM = round2(heightM * (1.025 + 0.035 * morph.limbLength + 0.012 * morph.frame + 0.02 * bell(r)));

  // Ratings follow the body, with a little of the fighter's own.
  const heavyness = clamp((massKg - 60) / 55, 0, 1);
  const rate = (x: number): number => Math.round(clamp(x + 9 * bell(r), 25, 97));
  const power = rate(48 + 26 * heavyness + 12 * morph.muscle + 5 * morph.frame);
  const speed = rate(76 - 30 * heavyness - 12 * fat + 6 * morph.limbLength - 4 * morph.frame);
  const chin = rate(60 + 12 * morph.neck + 8 * morph.frame + 8 * heavyness);
  const stamina = rate(68 - 22 * fat - 6 * morph.muscle + 8 * Math.max(0, -morph.bodyFat));
  const defense = rate(58 + 10 * morph.limbLength + 0.25 * (speed - 60) - 6 * fat);
  // Style from the ratings and the reach.
  const ape = reachM / heightM;
  const score: Record<AiStyle, number> = {
    slugger: power * 1.2 - speed * 0.5 + chin * 0.2,
    swarmer: stamina * 0.7 + speed * 0.5 - (heightM - 1.7) * 120,
    outboxer: defense * 0.5 + speed * 0.4 + (ape - 1.02) * 500 + (heightM - 1.78) * 80,
    counter: defense * 1.0 + speed * 0.3 - power * 0.3,
    pressure: stamina * 0.6 + chin * 0.5 + power * 0.2,
  };
  let style: AiStyle = 'pressure', best = -Infinity;
  for (const k of ['pressure', 'counter', 'outboxer', 'swarmer', 'slugger'] as const) {
    const s = score[k] + 6 * bell(r);
    if (s > best) { best = s; style = k; }
  }

  // Look.
  const skin = pick(r, SKINS);
  const hair = pick(r, HAIRS);
  const hairColor = rngFloat(r) < 0.6 ? pick(r, HAIR_COLS.slice(0, 4)) : pick(r, HAIR_COLS);
  const facialHair = pick(r, BEARDS);
  // Kit: one hue for the trunks, a contrast for the trim; gloves usually match one of them.
  const hue = rngRange(r, 0, 360);
  const mono = rngFloat(r) < 0.22;
  const trunksPrimary = mono ? (rngFloat(r) < 0.5 ? '#16161c' : '#eeeae0') : hsl(hue, rngRange(r, 0.55, 0.85), rngRange(r, 0.28, 0.46));
  const second = rngFloat(r);
  const trunksSecondary = second < 0.4 ? '#f0ece2' : second < 0.6 ? '#15151a' : second < 0.8 ? '#d9b43a' : hsl((hue + 150 + rngRange(r, 0, 60)) % 360, 0.7, 0.55);
  const gloves = rngFloat(r) < 0.6 ? (mono ? hsl(hue, 0.75, 0.38) : trunksPrimary) : pick(r, ['#b8202a', '#16161c', '#1f3f9a', '#d9b43a', '#f0ece2']);
  const boots = rngFloat(r) < 0.5 ? '#f0ece2' : rngFloat(r) < 0.5 ? '#16161c' : trunksPrimary;
  const tattoos: Tattoo[] = [];
  const nTat = rngFloat(r) < 0.45 ? 0 : rngInt(r, 1, 4);
  for (let i = 0; i < nTat; i++) {
    const place = pick(r, PLACES);
    if (tattoos.some(t => t.place === place)) continue;
    tattoos.push({ place, motif: pick(r, MOTIFS), seed: rngInt(r, 1, 99999) });
  }
  const name = `${pick(r, FIRST)} ${pick(r, LAST_A)}${pick(r, LAST_B)}`;
  return {
    id: `gen-${seed}`, name, nickname: pick(r, NICK_BY_STYLE[style]), hometown: pick(r, TOWNS),
    stance: rngFloat(r) < 0.22 ? 'southpaw' : 'orthodox',
    heightM, reachM, massKg, morph,
    skin, trunksPrimary, trunksSecondary,
    trunksStyle: pick(r, CUTS), trunksPattern: pick(r, PATTERNS),
    gloves, gloveCuff: rngFloat(r) < 0.6 ? '#f2f2f2' : trunksSecondary, gloveClosure: rngFloat(r) < 0.7 ? 'laces' : 'strap',
    ...(rngFloat(r) < 0.3 ? { glovePanel: trunksSecondary } : {}),
    boots, bootHeight: pick(r, BOOT_H), bootTrim: boots === trunksPrimary ? trunksSecondary : trunksPrimary,
    bootTassels: rngFloat(r) < 0.2, bootStripes: rngFloat(r) < 0.35,
    hair, hairColor, facialHair,
    eyeColor: pick(r, ['#3a2616', '#2a1a10', '#4a3420', '#3d5a4a', '#48607a']),
    tattoos,
    power, speed, chin, stamina, defense,
    style,
  };
}

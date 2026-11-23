/**
 * core/creator.ts — the player's own heavyweight. A pure function from the
 * creation screen's choices (FighterDraft) to a FighterSpec. No DOM, no three.js,
 * no randomness: the same draft is the same spec.
 *
 * There are no attribute points. Height and weight set the ratings (config group
 * `create`): the middle build rates exactly ratingNeutral everywhere, weight trades
 * speed and stamina for power and chin (amounts set by measured fights, scripts/build_ladder.mjs), height trades a little
 * speed and chin for real reach (the sim already reads reach and size from heightM).
 * Defense is the player's own skill and stays neutral.
 */
import type { Config } from './config';
import type { BodyMorph, FighterSpec, Stance } from './types';

export type SkinTone = 'light' | 'dark';

export interface FighterDraft {
  name: string; nickname: string; hometown: string;
  stance: Stance;
  heightM: number; massKg: number;
  skinTone: SkinTone;
  trunksPrimary: string; trunksSecondary: string; gloves: string; boots: string; hairColor: string;
}

export const CREATOR_ID = 'my-fighter';
/** Longest name, nickname and home town. A UI limit, not a tuning number. */
export const CREATOR_TEXT_MAX = 24;
const DEFAULT_NAME = 'The Challenger';
const DEFAULT_NICK = 'The Unknown';
const DEFAULT_TOWN = 'Nowhere, USA';

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const round2 = (x: number): number => Math.round(x * 100) / 100;
const text = (s: unknown, fallback: string): string => {
  const t = (typeof s === 'string' ? s : '').trim().replace(/\s+/g, ' ').slice(0, CREATOR_TEXT_MAX).trim();
  return t || fallback;
};
const finite = (x: unknown, fallback: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/** Whether two specs draw the same body. Ids decide, except the creator's own fighter, whose id never changes while his looks do. */
export function sameFighter(a: FighterSpec, b: FighterSpec): boolean {
  if (a === b) return true;
  return a.id === b.id && (a.id !== CREATOR_ID || JSON.stringify(a) === JSON.stringify(b));
}

export function defaultDraft(cfg: Config): FighterDraft {
  return {
    name: '', nickname: '', hometown: '',
    stance: 'orthodox',
    heightM: round2((cfg.createHeightMin + cfg.createHeightMax) / 2),
    massKg: Math.round((cfg.createMassMin + cfg.createMassMax) / 2),
    skinTone: 'light',
    trunksPrimary: '#b8202a', trunksSecondary: '#f2e6c8', gloves: '#b8202a', boots: '#f2e6c8', hairColor: '#1c1612',
  };
}

/** Height and weight clamped to the ranges, and each normalised to -1..1 across its range. */
export function normalisedBuild(draft: Pick<FighterDraft, 'heightM' | 'massKg'>, cfg: Config): { heightM: number; massKg: number; hN: number; wN: number } {
  const heightM = clamp(finite(draft.heightM, (cfg.createHeightMin + cfg.createHeightMax) / 2), cfg.createHeightMin, cfg.createHeightMax);
  const massKg = clamp(finite(draft.massKg, (cfg.createMassMin + cfg.createMassMax) / 2), cfg.createMassMin, cfg.createMassMax);
  const hN = (2 * (heightM - cfg.createHeightMin)) / (cfg.createHeightMax - cfg.createHeightMin) - 1;
  const wN = (2 * (massKg - cfg.createMassMin)) / (cfg.createMassMax - cfg.createMassMin) - 1;
  return { heightM, massKg, hN, wN };
}

export interface CreatorRatings { power: number; speed: number; chin: number; stamina: number; defense: number }

/** The five ratings a build earns. Used by the spec and, live, by the creation screen's bars. */
export function buildRatings(heightM: number, massKg: number, cfg: Config): CreatorRatings {
  const { hN, wN } = normalisedBuild({ heightM, massKg }, cfg);
  const n = cfg.ratingNeutral;
  const r = (x: number): number => Math.round(clamp(x, cfg.createRatingMin, cfg.createRatingMax));
  return {
    power: r(n + cfg.createWeightPower * wN),
    speed: r(n - cfg.createWeightSpeed * wN - cfg.createHeightSpeed * hN),
    chin: r(n + cfg.createWeightChin * wN - cfg.createHeightChin * hN),
    stamina: r(n - cfg.createWeightStamina * wN),
    defense: r(n),
  };
}

export function draftToSpec(draft: FighterDraft, cfg: Config): FighterSpec {
  const { heightM, massKg } = normalisedBuild(draft, cfg);
  const h = round2(heightM);
  // Weight for the height: 0 at the middle build, -1 / +1 at the ends of the swing.
  const f = clamp((massKg / (h * h) - cfg.createBmiMid) / cfg.createBmiSpan, -1, 1);
  const fat = f <= cfg.createFatStart ? f * 0.4 : cfg.createFatStart * 0.4 + (f - cfg.createFatStart) * cfg.createFatGain;
  const morph: BodyMorph = {
    frame: round2(clamp(f * cfg.createMorphFrame, -1, 1)),
    muscle: round2(clamp(f * cfg.createMorphMuscle, -1, 1)),
    bodyFat: round2(clamp(fat, -1, 1)),
    limbLength: 0, neck: 0,
    head: { width: 0, jaw: 0, chin: 0, brow: 0, nose: 0, ears: 0, height: 0 },
  };
  const skin = draft.skinTone === 'dark' ? cfg.createSkinDark : cfg.createSkinLight;
  const hex = (c: unknown, fb: string): string => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fb);
  const d = defaultDraft(cfg);
  const trunksPrimary = hex(draft.trunksPrimary, d.trunksPrimary);
  const trunksSecondary = hex(draft.trunksSecondary, d.trunksSecondary);
  const boots = hex(draft.boots, d.boots);
  return {
    id: CREATOR_ID,
    name: text(draft.name, DEFAULT_NAME), nickname: text(draft.nickname, DEFAULT_NICK), hometown: text(draft.hometown, DEFAULT_TOWN),
    stance: draft.stance === 'southpaw' ? 'southpaw' : 'orthodox',
    heightM: h, reachM: round2(h * cfg.createReachRatio), massKg: Math.round(massKg),
    morph,
    skin, trunksPrimary, trunksSecondary, trunksStyle: 'classic', trunksPattern: 'sideStripe',
    gloves: hex(draft.gloves, d.gloves), boots, bootHeight: 'mid', bootTrim: trunksPrimary,
    hair: 'short', hairColor: hex(draft.hairColor, d.hairColor), facialHair: 'none',
    ...buildRatings(h, massKg, cfg),
    style: 'pressure',
  };
}

/** One plain sentence on what the build means in the ring. */
export function buildRead(draft: FighterDraft, cfg: Config): string {
  const { hN, wN } = normalisedBuild(draft, cfg);
  const e = cfg.createBandEdge;
  const tall = hN > e, short = hN < -e, heavy = wN > e, light = wN < -e;
  if (tall && light) return 'Tall and light: long reach and quick hands, but easier to hurt.';
  if (tall && heavy) return 'Tall and heavy: reach and real power, but he tires early and is a big target.';
  if (short && heavy) return 'Short and heavy: a sledgehammer with a strong chin, but slow and short on reach.';
  if (short && light) return 'Short and light: fast and hard to find, but light in the hands and short on reach.';
  if (tall) return 'Tall: a long jab and a long reach, a little slower and a bigger target.';
  if (short) return 'Short: quick and compact, but he has to get inside to land.';
  if (heavy) return 'Heavy: hits hard and takes a punch, but slower and quicker to tire.';
  if (light) return 'Light: quick and fresh late in a fight, but easier to hurt and lighter in the hands.';
  return 'Balanced: no real weakness and no real edge. Skill decides it.';
}

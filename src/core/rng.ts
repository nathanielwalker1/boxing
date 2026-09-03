/**
 * core/rng.ts — the only randomness the sim is allowed.
 *
 * xoshiro128** on four uint32 words, seeded through splitmix32. Pure 32-bit
 * integer arithmetic via Math.imul, so it is bit-exact on every JS engine. The
 * state is a plain object that lives inside SimState (serialisable, cloneable).
 *
 * The step functions mutate the state object they are given — callers that
 * need a fresh state (sim.step must not mutate its input) clone first with
 * `rngClone`.
 */
import type { RngState } from './types';

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export function seedRng(seed: number): RngState {
  const sm = splitmix32(seed);
  const r = { s0: sm(), s1: sm(), s2: sm(), s3: sm() };
  // All-zero is the one forbidden state; splitmix never yields it for four
  // consecutive outputs but the guard costs nothing.
  if ((r.s0 | r.s1 | r.s2 | r.s3) === 0) r.s3 = 1;
  return r;
}

export function rngClone(r: RngState): RngState {
  return { s0: r.s0, s1: r.s1, s2: r.s2, s3: r.s3 };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** Next uint32. Mutates `r`. */
export function rngU32(r: RngState): number {
  const result = Math.imul(rotl(Math.imul(r.s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (r.s1 << 9) >>> 0;
  r.s2 = (r.s2 ^ r.s0) >>> 0;
  r.s3 = (r.s3 ^ r.s1) >>> 0;
  r.s1 = (r.s1 ^ r.s2) >>> 0;
  r.s0 = (r.s0 ^ r.s3) >>> 0;
  r.s2 = (r.s2 ^ t) >>> 0;
  r.s3 = rotl(r.s3, 11);
  return result;
}

/** Uniform float in [0, 1). 24 bits of mantissa — enough for gameplay, exact everywhere. */
export function rngFloat(r: RngState): number {
  return (rngU32(r) >>> 8) / 16777216;
}

/** Uniform float in [lo, hi). */
export function rngRange(r: RngState, lo: number, hi: number): number {
  return lo + (hi - lo) * rngFloat(r);
}

/** Uniform integer in [lo, hi] inclusive. */
export function rngInt(r: RngState, lo: number, hi: number): number {
  return lo + Math.floor(rngFloat(r) * (hi - lo + 1));
}

/** True with probability p. */
export function rngChance(r: RngState, p: number): boolean {
  return rngFloat(r) < p;
}

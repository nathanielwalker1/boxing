/**
 * sim/mocap.ts — cfg.mocapGeo: the sim's punching glove IS the drawn mocap glove (core/mocap.ts), the puncher's body
 * lunges with the clip, and the reach-dependent distances are × mocapRangeScale. Everything here is off (and never
 * called) with the toggle off, so the sim is bit-identical to before.
 *
 *   step():      cfg = mocapCfg(cfg) once at the top; stepMocap(f, other, side, cfg) after the punch clocks advance
 *   reaction.ts: computeBoxes places the head / body (and the skeleton) at pos + mocapLunge(f)
 *   gloves.ts:   the guard hand rides the lunge; the punching hand's target is mocapGlove(f), kinematic
 *   skel.ts:     the arm fit does not pull the mocap punching glove back to the procedural arm's reach
 *
 * Scratch, not state: derived from the state every tick before it is read (like skel.ts HEAD_SHIFT).
 */
import type { Config, FighterState, Side, Vec3 } from '../core';
import { GUARDS, frameOf, v2dist } from '../core';
import { makeMocapGeo, mocapLib, mocapPunchGeo, punchCode, punchOfCode, type ChainedFrom, type MocapPunchGeo } from '../core/mocap';
import { PUNCHES, whiffPhases } from './punches';
import { chainCarry } from './state';
import { VARIANTS } from './variants';

/** The distances that follow the reach (config keys), × mocapRangeScale with the toggle on. */
export const MOCAP_SCALED_KEYS = [
  'rangeMax', 'rangeInside', 'rangeOutside',
  'pushRange', 'clinchRange', 'clinchBreakDist', 'pivotRange', 'poseRangeNear', 'poseRangeFar',
  'aiStandoffDist', 'aiEngageDist', 'aiHookEngageDist', 'aiUppercutEngageDist', 'aiProbeDist', 'aiResetDist',
] as const;
/** Body-to-body distances, × mocapCloseScale instead (an uppercut clip reaches only ~0.75 m centre to centre). */
export const MOCAP_CLOSE_KEYS = ['separationDist', 'smotherDist', 'clinchHoldDist'] as const;

const SCALED = new WeakMap<Config, Config>();
const IS_SCALED = new WeakSet<Config>();
/**
 * The config the sim and the AI read with mocapGeo on: a stable copy (one per source config, refreshed on every call
 * so the tuning panel stays live; no allocation after the first) with MOCAP_SCALED_KEYS × mocapRangeScale.
 * Off (or already scaled): the config itself.
 */
export function mocapCfg(cfg: Config): Config {
  if (!cfg.mocapGeo || IS_SCALED.has(cfg)) return cfg;
  let c = SCALED.get(cfg);
  if (!c) { c = { ...cfg }; SCALED.set(cfg, c); IS_SCALED.add(c); }
  const src = cfg as unknown as Record<string, unknown>, dst = c as unknown as Record<string, unknown>;
  for (const k in src) dst[k] = src[k];
  const s = cfg.mocapRangeScale;
  for (const k of MOCAP_SCALED_KEYS) dst[k] = (cfg[k] as number) * s;
  for (const k of MOCAP_CLOSE_KEYS) dst[k] = (cfg[k] as number) * cfg.mocapCloseScale;
  return c;
}

interface MocapTick { owner: FighterState | null; on: boolean; lunge: { x: number; z: number }; glove: Vec3; geo: MocapPunchGeo }
const POOL: [MocapTick, MocapTick] = [0, 1].map(() => ({ owner: null, on: false, lunge: { x: 0, z: 0 }, glove: { x: 0, y: 0, z: 0 }, geo: makeMocapGeo() })) as [MocapTick, MocapTick];
const OF = new WeakMap<FighterState, MocapTick>();
const tickOf = (f: FighterState): MocapTick | null => { const t = OF.get(f); return t && t.owner === f && t.on ? t : null; };

/** Standing lane height (m from the floor) a punch at this fighter goes to: head centre, or mid-body for a body shot. */
function laneY(f: FighterState, body: boolean, cfg: Config): number {
  const crouch = GUARDS[cfg.stylesOn ? f.guardShape : 'high'].crouch;
  return (body ? (f.body.shoulderY + f.body.hipY) / 2 : f.body.headY) - crouch;
}

/**
 * This tick's mocap punch for f (after advancePunch): the glove and the lunge. The aim goes to the opponent's
 * STANDING lane (a head punch less the punch's own aim drop — an overhand at a ducked head), never where his head is
 * this tick, so a slip or a duck still takes the punch away. The lunge never carries f closer than
 * separationDist + mocapLungeGap to the other man.
 */
export function stepMocap(f: FighterState, other: FighterState, side: Side, cfg: Config): void {
  recordChain(f);
  const t = POOL[side];
  t.owner = f;
  OF.set(f, t);
  computeMocap(f, other, cfg, t);
}
/**
 * What the punch in flight was chained FROM (the clip choice plays a combination clip for it): moveHist slots
 * HIST_MOCAP (the punch in flight, as punchCode), +1 (the punch it was chained from, 0 = none), +2 (its progress
 * last tick, to tell a repeat of the same punch). A new punch counts as chained when combat.ts marked it so
 * (chainCarry(f).on: pressed while the last was in flight). Written only here, only with mocapGeo on.
 */
const HIST_MOCAP = 90;
function recordChain(f: FighterState): void {
  const p = f.punch, h = f.moveHist;
  if (p.type === null) return;
  const cur = punchCode(p.type, p.hand), was = h[HIST_MOCAP] ?? 0, last = h[HIST_MOCAP + 2] ?? 0;
  if (cur !== was || p.progress < last - 0.25) {
    h[HIST_MOCAP + 1] = chainCarry(f).on ? was : 0;
    // where the punching glove WAS at the press (his own frame: fwd, up, right), so the clip glove is blended in from
    // there over the wind-up instead of jumping to the clip's first frame (up to 70 cm in one tick on the cross)
    const g = f.gloves[p.hand === 'lead' ? 0 : 1].pos, fr = frameOf(f.yaw), dx = g.x - f.pos.x, dz = g.z - f.pos.z;
    h[HIST_MOCAP + 3] = dx * fr.fwd.x + dz * fr.fwd.z; h[HIST_MOCAP + 4] = g.y; h[HIST_MOCAP + 5] = dx * fr.right.x + dz * fr.right.z;
  }
  h[HIST_MOCAP] = cur;
  h[HIST_MOCAP + 2] = p.progress;
}
/** The punch the one in flight was chained from (as the sim recorded it), or null. */
export function mocapChainedFrom(f: FighterState): ChainedFrom | null {
  return f.punch.type === null ? null : punchOfCode(f.moveHist[HIST_MOCAP + 1] ?? 0);
}

function computeMocap(f: FighterState, other: FighterState, cfg: Config, t: MocapTick): void {
  t.on = false; t.lunge.x = 0; t.lunge.z = 0;
  const lib = mocapLib(), p = f.punch;
  if (!cfg.mocapGeo || !lib || p.type === null || f.down) return;
  const ph = whiffPhases(f, PUNCHES[p.type].phases(cfg));
  const v = VARIANTS[p.variant];
  const low = !!v?.body || p.aim > cfg.humanBodyAim;
  const targetY = laneY(other, low, cfg) - (low ? 0 : p.aim);
  const selfY = laneY(f, low, cfg);
  const g = mocapPunchGeo(lib, cfg, f.body.heightM, f.stance, p.type, p.hand, low, p.progress, ph.cockEnd, ph.peakAt, p.tell, targetY, selfY, t.geo, mocapChainedFrom(f));
  if (!g.ok) return;
  let L = g.lunge;
  if (L > 0) L = Math.min(L, Math.max(0, v2dist(f.pos, other.pos) - cfg.mocapLungeMin));
  const fr = frameOf(f.yaw);
  // (the turn rotated the glove about the lunged origin; a clamped lunge moves that origin, and the glove with it, along the facing)
  let fwd = g.fwd - g.lunge + L, up = g.up, lat = g.lat;
  // in from the glove's place at the press over the wind-up (cockEnd); the clip glove alone from there (contact untouched)
  const h = f.moveHist, s0 = h[HIST_MOCAP + 3];
  if (s0 !== undefined && ph.cockEnd > 1e-6 && p.progress < ph.cockEnd) {
    const k = p.progress / ph.cockEnd, w = k * k * (3 - 2 * k);
    fwd = s0 + (fwd - s0) * w; up = h[HIST_MOCAP + 4]! + (up - h[HIST_MOCAP + 4]!) * w; lat = h[HIST_MOCAP + 5]! + (lat - h[HIST_MOCAP + 5]!) * w;
  }
  t.on = true;
  t.lunge.x = fr.fwd.x * L; t.lunge.z = fr.fwd.z * L;
  t.glove.x = f.pos.x + fr.fwd.x * fwd + fr.right.x * lat;
  t.glove.y = up;
  t.glove.z = f.pos.z + fr.fwd.z * fwd + fr.right.z * lat;
}

/** The body offset (world, on the floor) f lunges by this tick, or null (no mocap punch). */
export function mocapLunge(f: FighterState): { x: number; z: number } | null { const t = tickOf(f); return t ? t.lunge : null; }
/** The mocap punching glove's centre this tick (world), or null. */
export function mocapGlove(f: FighterState): Vec3 | null { const t = tickOf(f); return t ? t.glove : null; }
/** The full mocap punch result this tick (frame, local glove, unclamped lunge, aim), or null. */
export function mocapGeoOf(f: FighterState): MocapPunchGeo | null { const t = tickOf(f); return t ? t.geo : null; }

/**
 * For the drawn side: the same numbers for any state (it calls this with the state it draws). Pure; returns the
 * glove (world), the lunge (world floor offset, clamped as the sim clamps it) and the clip frame, or null.
 */
export function mocapPunchNow(f: FighterState, other: FighterState, cfg: Config): { glove: Vec3; lunge: { x: number; z: number }; frame: number; geo: MocapPunchGeo } | null {
  const t: MocapTick = { owner: null, on: false, lunge: { x: 0, z: 0 }, glove: { x: 0, y: 0, z: 0 }, geo: makeMocapGeo() };
  computeMocap(f, other, mocapCfg(cfg), t);
  return t.on ? { glove: t.glove, lunge: t.lunge, frame: t.geo.frame, geo: t.geo } : null;
}

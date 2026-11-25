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
 * The config the sim and the AI read with mocapGeo on: a stable VIEW of the source config (one per source config, made
 * once). Every key reads through to the source, so the tuning panel stays live; the MOCAP_SCALED_KEYS read
 * × mocapRangeScale and the MOCAP_CLOSE_KEYS × mocapCloseScale. Off (or already scaled): the config itself.
 * (Was a full copy of every key on every call, several calls a tick: half of a headless fight's time, 2026-11-24.)
 * It is a view, not a copy: its own keys are only the scaled ones, so never spread or enumerate it.
 */
export function mocapCfg(cfg: Config): Config {
  if (!cfg.mocapGeo || IS_SCALED.has(cfg)) return cfg;
  let c = SCALED.get(cfg);
  if (c) return c;
  const view = Object.create(cfg) as Config;
  const def = (k: string, get: () => number): void => { Object.defineProperty(view, k, { get, enumerable: true }); };
  for (const k of MOCAP_SCALED_KEYS) def(k, () => (cfg[k] as number) * cfg.mocapRangeScale);
  // outcome first (sim/outcome.ts): the separation is the measured one for two mocap bodies; the straights' ramp starts outside it
  def('separationDist', () => cfg.mocapOutcome ? cfg.mocapSeparation : cfg.separationDist * cfg.mocapCloseScale);
  def('smotherDist', () => cfg.mocapOutcome ? cfg.mocapSeparation + cfg.mocapSmotherSpan : cfg.smotherDist * cfg.mocapCloseScale);
  def('clinchHoldDist', () => cfg.mocapOutcome ? Math.max(cfg.clinchHoldDist * cfg.mocapCloseScale, cfg.mocapSeparation) : cfg.clinchHoldDist * cfg.mocapCloseScale);
  c = view; SCALED.set(cfg, c); IS_SCALED.add(c);
  return c;
}

interface MocapTick { owner: FighterState | null; on: boolean; drawOnly: boolean; lunge: { x: number; z: number }; glove: Vec3; geo: MocapPunchGeo }
const POOL: [MocapTick, MocapTick] = [0, 1].map(() => ({ owner: null, on: false, drawOnly: false, lunge: { x: 0, z: 0 }, glove: { x: 0, y: 0, z: 0 }, geo: makeMocapGeo() })) as [MocapTick, MocapTick];
const OF = new WeakMap<FighterState, MocapTick>();
const tickOf = (f: FighterState): MocapTick | null => { const t = OF.get(f); return t && t.owner === f && t.on ? t : null; };

/** Standing lane height (m from the floor) a punch at this fighter goes to: head centre, or mid-body for a body shot. */
function laneY(f: FighterState, body: boolean, cfg: Config): number {
  const crouch = GUARDS[cfg.stylesOn ? f.guardShape : 'high'].crouch;
  return (body ? (f.body.shoulderY + f.body.hipY) / 2 : f.body.headY) - crouch;
}

// (THE HEAD: with both corners on the `idle` role the drawn head centre stands ~5 cm under the sim's head sphere
//  (core/mocap.ts mocapRest; the other corner's idle_3 stood it 19 cm under). Moving the sphere down by that was
//  tried 2026-11-17 and broke the lead uppercut: its contact frame holds the glove ~2.2 m up, the aim pulls it 64 cm
//  down in front of the chest and the chest capsule stops it. Left for the uppercut contact-frame fix.)
// (The GUARD is not taken from the drawn idle: its mean lead glove sits on the centre line 33 cm in front of the face,
//  and as a solid sim glove it stopped every lead uppercut — measured 2026-11-17. The drawn guard hands follow the
//  sim's guard gloves instead: src/human/view.ts, cfg.humanGuardIK.)

/**
 * This tick's mocap punch for f (after advancePunch): the glove and the lunge. The aim goes to the opponent's
 * STANDING lane (a head punch less the punch's own aim drop — an overhand at a ducked head), never where his head is
 * this tick, so a slip or a duck still takes the punch away. The lunge never carries f closer than
 * separationDist + mocapLungeGap to the other man.
 */
export function stepMocap(f: FighterState, other: FighterState, side: Side, cfg: Config): void {
  const t = POOL[side];
  // the lunge he was carrying last tick (along his facing): a chained punch starts its lunge from there, not from 0
  const fr0 = frameOf(f.yaw);
  recordChain(f, t.on && t.owner !== null ? t.lunge.x * fr0.fwd.x + t.lunge.z * fr0.fwd.z : 0);
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
function recordChain(f: FighterState, lungeNow: number): void {
  const p = f.punch, h = f.moveHist;
  if (p.type === null) return;
  const cur = punchCode(p.type, p.hand), was = h[HIST_MOCAP] ?? 0, last = h[HIST_MOCAP + 2] ?? 0;
  if (cur !== was || p.progress < last - 0.25) {
    h[HIST_MOCAP + 1] = chainCarry(f).on ? was : 0;
    // where the punching glove WAS at the press (his own frame: fwd, up, right), so the clip glove is blended in from
    // there over the wind-up instead of jumping to the clip's first frame (up to 70 cm in one tick on the cross)
    const g = f.gloves[p.hand === 'lead' ? 0 : 1].pos, fr = frameOf(f.yaw), dx = g.x - f.pos.x, dz = g.z - f.pos.z;
    h[HIST_MOCAP + 3] = dx * fr.fwd.x + dz * fr.fwd.z; h[HIST_MOCAP + 4] = g.y; h[HIST_MOCAP + 5] = dx * fr.right.x + dz * fr.right.z;
    // (+6) the lunge carried into this punch (a chain: the last punch's lunge this tick; 0 from the guard)
    h[HIST_MOCAP + 6] = lungeNow;
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
  // the fit: the glove centre's forward distance at the other man's STANDING surface (his pos, not his head this tick,
  // so a slip still takes the punch away), the glove sunk by the contact squash as the hit test expects
  const d = v2dist(f.pos, other.pos);
  const reachTo = d - (low ? other.body.bodyR : other.body.headR) - f.body.gloveR + f.body.gloveR * cfg.contactSquash;
  // outcome first: the clip as authored (no height aim, no body turn, no reach fit); the drawing conforms to the outcome
  const oc = cfg.mocapOutcome;
  const g = mocapPunchGeo(lib, cfg, f.body.heightM, f.stance, p.type, p.hand, low, p.progress, ph.cockEnd, ph.peakAt, p.tell, oc ? null : targetY, oc ? null : selfY, t.geo, mocapChainedFrom(f), oc ? null : reachTo);
  if (!g.ok) return;
  // a chained punch takes over the lunge the last one was carrying and lets it go over its own wind-up and extension
  const L0 = f.moveHist[HIST_MOCAP + 6] ?? 0, kIn = Math.min(1, p.progress / Math.max(1e-6, ph.peakAt));
  let L = g.lunge + L0 * (1 - kIn * kIn * (3 - 2 * kIn));
  // never closer than the body separation (the sim owns pos; the lunge may not overrule it)
  if (L > 0 && !oc) L = Math.min(L, Math.max(0, d - Math.max(cfg.mocapLungeMin, cfg.separationDist)));
  const fr = frameOf(f.yaw);
  // (the turn rotated the glove about the lunged origin; a clamped lunge moves that origin, and the glove with it, along the facing)
  // (outcome first: the lunge is drawn only — the sim's glove and body stay on pos)
  let fwd = g.fwd - g.lunge + (oc ? 0 : L), up = g.up, lat = g.lat;
  // in from the glove's place at the press over the wind-up (cockEnd); the clip glove alone from there (contact untouched)
  const h = f.moveHist, s0 = h[HIST_MOCAP + 3];
  if (s0 !== undefined && ph.cockEnd > 1e-6 && p.progress < ph.cockEnd) {
    const k = p.progress / ph.cockEnd, w = k * k * (3 - 2 * k);
    fwd = s0 + (fwd - s0) * w; up = h[HIST_MOCAP + 4]! + (up - h[HIST_MOCAP + 4]!) * w; lat = h[HIST_MOCAP + 5]! + (lat - h[HIST_MOCAP + 5]!) * w;
  }
  t.on = true;
  t.drawOnly = oc;
  t.lunge.x = fr.fwd.x * L; t.lunge.z = fr.fwd.z * L;
  t.glove.x = f.pos.x + fr.fwd.x * fwd + fr.right.x * lat;
  t.glove.y = up;
  t.glove.z = f.pos.z + fr.fwd.z * fwd + fr.right.z * lat;
}

/** The body offset (world, on the floor) f lunges by this tick, or null (no mocap punch). */
export function mocapLunge(f: FighterState): { x: number; z: number } | null { const t = tickOf(f); return t && !t.drawOnly ? t.lunge : null; }
/** The mocap punching glove's centre this tick (world), or null. */
export function mocapGlove(f: FighterState): Vec3 | null { const t = tickOf(f); return t ? t.glove : null; }
/** The full mocap punch result this tick (frame, local glove, unclamped lunge, aim), or null. */
export function mocapGeoOf(f: FighterState): MocapPunchGeo | null { const t = tickOf(f); return t ? t.geo : null; }

/**
 * For the drawn side: the same numbers for any state (it calls this with the state it draws). Pure; returns the
 * glove (world), the lunge (world floor offset, clamped as the sim clamps it) and the clip frame, or null.
 */
export function mocapPunchNow(f: FighterState, other: FighterState, cfg: Config): { glove: Vec3; lunge: { x: number; z: number }; frame: number; geo: MocapPunchGeo } | null {
  const t: MocapTick = { owner: null, on: false, drawOnly: false, lunge: { x: 0, z: 0 }, glove: { x: 0, y: 0, z: 0 }, geo: makeMocapGeo() };
  computeMocap(f, other, mocapCfg(cfg), t);
  return t.on ? { glove: t.glove, lunge: t.lunge, frame: t.geo.frame, geo: t.geo } : null;
}

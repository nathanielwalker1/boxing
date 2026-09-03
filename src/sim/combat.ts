/**
 * sim/combat.ts — punch start, punch clock, hit resolution and impulse.
 * Port of legacy/src/main.js _resolvePunch / _resolveAttack and the punch
 * timer in fighter.js, in SI.
 */
import type { Config, FighterState, FrameInput, PunchType, Side, SimEvent, SimState, Vec3 } from '../core';
import { clamp, frameOf, sphereCapsuleOverlap, sphereOverlap, triangle, v2dist, v2dot, handLateralSign } from '../core';
import { PUNCHES } from './punches';
import { MASK_CROSS, MASK_JAB, prevPunchMask, punchMask, setPrevPunchMask } from './state';
import { applyReaction } from './reaction';

/**
 * Block and punch input for one fighter this tick. Block is a level and
 * engages whenever no punch is in flight; a punch fires on the rising edge of
 * its flag when the guard is down. Both re-check fresh every tick, which is
 * what makes switching instant.
 */
export function stepActions(f: FighterState, side: Side, input: Readonly<FrameInput>, cfg: Config, dt: number, events: SimEvent[]): void {
  const mask = punchMask(input);
  const pressed = mask & ~prevPunchMask(f);
  setPrevPunchMask(f, mask);

  const guardOpen = f.punch.type === null;
  const wasBlocking = f.block;
  f.block = input.block && guardOpen && !f.down;
  f.blockT = f.block ? (wasBlocking ? f.blockT + dt : 0) : 0;
  f.guard = f.block ? 'block' : 'rest';

  if (f.block || !guardOpen || f.down) return;
  const type: PunchType | null = pressed & MASK_JAB ? 'jab' : pressed & MASK_CROSS ? 'cross' : null;
  if (type === null) return;
  const def = PUNCHES[type];
  if (!def) return;
  f.punch = { type, hand: def.hand, phase: 'cock', t: 0, progress: 0, resolved: false };
  events.push({ type: 'punchStart', side, punch: type, hand: def.hand });
}

/**
 * Advance the punch clock. Returns true on the one tick the punch reaches its
 * resolve moment (peakAt), which is when the hit test runs.
 */
export function advancePunch(f: FighterState, cfg: Config, dt: number): boolean {
  const p = f.punch;
  if (p.type === null) return false;
  const def = PUNCHES[p.type];
  if (!def) { f.punch = { type: null, hand: p.hand, phase: 'idle', t: 0, progress: 0, resolved: false }; return false; }
  const ph = def.phases(cfg);
  const elapsed = Math.min(ph.total, p.progress * ph.total + dt);
  p.progress = elapsed / ph.total;
  if (elapsed < ph.cock) { p.phase = 'cock'; p.t = elapsed; }
  else if (elapsed < ph.cock + ph.extend) { p.phase = 'extend'; p.t = elapsed - ph.cock; }
  else { p.phase = 'recover'; p.t = elapsed - ph.cock - ph.extend; }

  const ext = triangle(p.progress, ph.peakAt);
  f.lean.fwd = cfg.punchLean * ext;
  f.torsoTwist = (p.hand === 'lead' ? 1 : -1) * handLateralSign('lead', f.stance) * def.turn * ext;

  let peak = false;
  if (!p.resolved && p.progress >= ph.peakAt) { p.resolved = true; peak = true; }
  if (elapsed >= ph.total) {
    f.punch = { type: null, hand: p.hand, phase: 'idle', t: 0, progress: 0, resolved: false };
    f.lean.fwd = 0;
    f.torsoTwist = 0;
  }
  return peak;
}

/**
 * The hit test, run once at the resolve moment against the defender's
 * current boxes. Outcomes: too close (straight punches) = smother; beyond
 * rangeMax = whiff; otherwise the attacking glove sphere against head then
 * body — a miss is a whiff, a hit is a land or, if the guard is up, a block.
 */
export function resolvePunch(s: SimState, side: Side, type: PunchType, cfg: Config, events: SimEvent[]): void {
  const def = PUNCHES[type];
  if (!def) return;
  const target: Side = side === 0 ? 1 : 0;
  const a = s.fighters[side], d = s.fighters[target];
  if (d.down) return;

  const dist = v2dist(a.pos, d.pos);
  if (def.smotherable && dist < cfg.smotherDist) { events.push({ type: 'punchSmother', side, target, punch: type }); return; }
  if (dist > cfg.rangeMax) { events.push({ type: 'punchWhiff', side, punch: type }); return; }

  const g = a.gloves[a.punch.hand === 'lead' ? 0 : 1];
  const glove = { x: g.pos.x, y: g.pos.y, z: g.pos.z, r: a.body.gloveR };
  const part = sphereOverlap(glove, d.headBox) ? 'head' : sphereCapsuleOverlap(glove, d.bodyBox) ? 'body' : null;
  if (part === null) { events.push({ type: 'punchWhiff', side, punch: type }); return; }

  // Impulse: base + attacker momentum toward the defender, floored so a
  // retreating punch still lands with something, scaled by lean and per-type.
  let dirX: number, dirZ: number;
  if (dist > 1e-6) { dirX = (d.pos.x - a.pos.x) / dist; dirZ = (d.pos.z - a.pos.z) / dist; }
  else { const fr = frameOf(a.yaw); dirX = fr.fwd.x; dirZ = fr.fwd.z; }
  const approachSpd = v2dot(a.vel, { x: dirX, z: dirZ });
  let mag = cfg.punchImpulseBase + a.body.massKg * approachSpd * cfg.punchMomentumScale;
  mag = Math.max(cfg.punchImpulseBase * cfg.punchImpulseFloor, mag);
  mag *= 1 + a.lean.fwd * cfg.punchLeanScale;
  mag *= def.impulseMult(cfg);
  const blocked = d.block;
  if (blocked) mag *= 1 - cfg.blockReduction;
  const power = mag / cfg.punchImpulseBase;
  const dir: Vec3 = { x: dirX, y: 0, z: dirZ };
  const impulse: Vec3 = { x: dirX * mag, y: 0, z: dirZ * mag };
  const at: Vec3 = { x: g.pos.x, y: g.pos.y, z: g.pos.z };

  if (blocked) events.push({ type: 'punchBlock', side, target, punch: type, at });
  else events.push({ type: 'punchLand', side, target, punch: type, hand: a.punch.hand, part, at, impulse, power, counter: false });
  events.push({ type: 'hurt', side: target, part, impulse });

  d.stagger.x += impulse.x / d.body.massKg;
  d.stagger.z += impulse.z / d.body.massKg;
  applyReaction(d, type, dir, mag, cfg);
  s.hitStop = Math.max(s.hitStop, clamp(cfg.hitStopBase * power, 0, cfg.hitStopMax));
}

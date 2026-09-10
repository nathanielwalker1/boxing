/**
 * sim/combat.ts — punch start, punch clock, hit resolution and impulse.
 * Port of legacy/src/main.js _resolvePunch / _resolveAttack and the punch
 * timer in fighter.js, in SI.
 */
import type { Config, FighterState, FrameInput, PunchType, Side, SimEvent, SimState, Vec3 } from '../core';
import { clamp, closestOnSegment, frameOf, lerp, sphereCapsuleOverlap, sphereOverlap, triangle, v2dist, v2dot, handLateralSign } from '../core';
import { PUNCHES, punchCrouch, punchHand, punchTwist } from './punches';
import { MASK_CROSS, MASK_HOOK, MASK_JAB, MASK_UPPERCUT, prevPunchMask, punchMask, setPrevPunchMask } from './state';
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
  // Two pressed on the same tick: the faster punch wins.
  const type: PunchType | null =
    pressed & MASK_JAB ? 'jab' : pressed & MASK_CROSS ? 'cross' : pressed & MASK_HOOK ? 'hook' : pressed & MASK_UPPERCUT ? 'uppercut' : null;
  if (type === null) return;
  // Hook/uppercut: the joystick at the press picks the hand (x < 0 = lead).
  const hand = punchHand(PUNCHES[type], input.move.x);
  f.punch = { type, hand, phase: 'cock', t: 0, progress: 0, resolved: false, contact: null };
  events.push({ type: 'punchStart', side, punch: type, hand });
}

/**
 * Advance the punch clock. Returns true on the one tick the punch reaches its
 * resolve moment (peakAt), which is when the hit test runs.
 */
export function advancePunch(f: FighterState, cfg: Config, dt: number): boolean {
  const p = f.punch;
  if (p.type === null) return false;
  const def = PUNCHES[p.type];
  const ph = def.phases(cfg);
  const elapsed = Math.min(ph.total, p.progress * ph.total + dt);
  p.progress = elapsed / ph.total;
  if (elapsed < ph.cock) { p.phase = 'cock'; p.t = elapsed; }
  else if (elapsed < ph.cock + ph.extend) { p.phase = 'extend'; p.t = elapsed - ph.cock; }
  else { p.phase = 'recover'; p.t = elapsed - ph.cock - ph.extend; }

  // Whole-body channels the rig draws: forward and lateral weight transfer,
  // torso twist (all peak at the resolve moment) and the body dip.
  const ext = triangle(p.progress, ph.peakAt);
  f.lean.fwd = cfg.punchLean * def.lean * ext;
  f.lean.lat = def.sway * handLateralSign(p.hand, f.stance) * ext;
  f.torsoTwist = (p.hand === 'lead' ? 1 : -1) * handLateralSign('lead', f.stance) * def.turn * punchTwist(def, elapsed, ph);
  f.crouch = punchCrouch(def, elapsed, ph, cfg);

  let peak = false;
  if (!p.resolved && p.progress >= ph.peakAt) { p.resolved = true; peak = true; }
  if (elapsed >= ph.total) {
    f.punch = { type: null, hand: p.hand, phase: 'idle', t: 0, progress: 0, resolved: false, contact: null };
    f.lean.fwd = 0;
    f.lean.lat = 0;
    f.torsoTwist = 0;
    f.crouch = 0;
  }
  return peak;
}

/**
 * The hit test, run once at the resolve moment against the defender's
 * current boxes. Outcomes: beyond rangeMax = whiff; otherwise the attacking
 * glove sphere against head then body — a miss is a whiff, a hit is a land
 * or, if the guard is up, a block. A straight punch thrown inside smotherDist
 * still lands (a cramped jab is still a jab) but loses power, sliding to
 * smotherPowerFloor at the body-separation distance (Stage-1 feel-test,
 * 2026-09-03; supersedes v1's no-contact smother). Hooks and uppercuts keep
 * full power at any distance they can reach.
 */
export function resolvePunch(s: SimState, side: Side, type: PunchType, cfg: Config, events: SimEvent[]): void {
  const def = PUNCHES[type];
  const target: Side = side === 0 ? 1 : 0;
  const a = s.fighters[side], d = s.fighters[target];
  if (d.down) return;

  const dist = v2dist(a.pos, d.pos);
  if (dist > cfg.rangeMax) { events.push({ type: 'punchWhiff', side, punch: type }); return; }

  const g = a.gloves[a.punch.hand === 'lead' ? 0 : 1];
  const glove = { x: g.pos.x, y: g.pos.y, z: g.pos.z, r: a.body.gloveR };
  const part = sphereOverlap(glove, d.headBox) ? 'head' : sphereCapsuleOverlap(glove, d.bodyBox) ? 'body' : null;
  if (part === null) { events.push({ type: 'punchWhiff', side, punch: type }); return; }

  // Impulse: base + attacker momentum toward the defender, floored so a
  // retreating punch still lands with something, scaled by lean and per-type.
  // Momentum is measured along the attacker→defender line; the impulse
  // DIRECTION is that line blended, per type, with the fist's own travel, so
  // a hook that crosses the face sends the head and body sideways.
  let adX: number, adZ: number;
  if (dist > 1e-6) { adX = (d.pos.x - a.pos.x) / dist; adZ = (d.pos.z - a.pos.z) / dist; }
  else { const fr = frameOf(a.yaw); adX = fr.fwd.x; adZ = fr.fwd.z; }
  const approachSpd = v2dot(a.vel, { x: adX, z: adZ });
  let dirX = adX, dirZ = adZ;
  if (def.swing > 0) {
    const vlen = Math.hypot(g.vel.x, g.vel.z);
    if (vlen > 1e-6) {
      dirX = lerp(adX, g.vel.x / vlen, def.swing); dirZ = lerp(adZ, g.vel.z / vlen, def.swing);
      const n = Math.hypot(dirX, dirZ);
      if (n > 1e-6) { dirX /= n; dirZ /= n; } else { dirX = adX; dirZ = adZ; }
    }
  }
  let mag = cfg.punchImpulseBase + a.body.massKg * approachSpd * cfg.punchMomentumScale;
  mag = Math.max(cfg.punchImpulseBase * cfg.punchImpulseFloor, mag);
  mag *= 1 + a.lean.fwd * cfg.punchLeanScale;
  mag *= def.impulseMult(cfg);
  if (def.smotherable && dist < cfg.smotherDist) {
    const span = Math.max(1e-6, cfg.smotherDist - cfg.separationDist);
    mag *= lerp(cfg.smotherPowerFloor, 1, clamp((dist - cfg.separationDist) / span, 0, 1));
  }

  // The glove stops at what it hit: for the rest of the hold its centre rests
  // one glove radius (less the contact squash) off the struck surface, on the
  // side it arrived from — a hook rests on the cheek, an uppercut under the
  // chin. Bodies are flesh and bone, not empty (feel-test 2026-09-03).
  const sink = a.body.gloveR * cfg.contactSquash;
  const centre = part === 'head' ? { x: d.headBox.x, y: d.headBox.y, z: d.headBox.z } : closestOnSegment(d.bodyBox.a, d.bodyBox.b, g.pos);
  const r = (part === 'head' ? d.headBox.r : d.bodyBox.r) + a.body.gloveR - sink;
  let nx = g.pos.x - centre.x, ny = g.pos.y - centre.y, nz = g.pos.z - centre.z;
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen > 1e-6) { nx /= nlen; ny /= nlen; nz /= nlen; } else { nx = -adX; ny = 0; nz = -adZ; }
  a.punch.contact = { x: centre.x + nx * r, y: centre.y + ny * r, z: centre.z + nz * r };
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

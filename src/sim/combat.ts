/**
 * sim/combat.ts — punch start, punch clock, hit resolution and impulse.
 * Port of legacy/src/main.js _resolvePunch / _resolveAttack and the punch
 * timer in fighter.js, in SI.
 */
import type { Config, FighterState, FrameInput, PunchType, Side, SimEvent, SimState, Vec3 } from '../core';
import { clamp, closestOnSegment, frameOf, lerp, sphereCapsuleOverlap, sphereOverlap, triangle, v2dist, v2dot, handLateralSign } from '../core';
import { PUNCHES, punchCrouch, punchHand, punchTwist } from './punches';
import { MASK_CROSS, MASK_HOOK, MASK_JAB, MASK_UPPERCUT, cockMult, prevPunchMask, punchBuffer, punchMask, setCockMult, setPrevPunchMask, setPunchBuffer } from './state';
import { applyReaction } from './reaction';
import { takeHit } from './resources';

/** Two pressed on the same tick: the faster punch wins. */
function fastestOf(mask: number): PunchType | null {
  return mask & MASK_JAB ? 'jab' : mask & MASK_CROSS ? 'cross' : mask & MASK_HOOK ? 'hook' : mask & MASK_UPPERCUT ? 'uppercut' : null;
}
const maskOf = (t: PunchType): number => t === 'jab' ? MASK_JAB : t === 'cross' ? MASK_CROSS : t === 'hook' ? MASK_HOOK : MASK_UPPERCUT;

/**
 * Can a new punch start this tick? With the guard down, yes. With one in
 * flight, once its recover phase is punchChainAt of the way through — the
 * combo window: the next punch cuts the tail of the retraction (1 = never).
 */
function canStartPunch(f: FighterState, cfg: Config): boolean {
  const p = f.punch;
  if (p.type === null) return true;
  return p.phase === 'recover' && p.t >= cfg.punchChainAt * PUNCHES[p.type].phases(cfg).recover;
}

/**
 * Hook/uppercut: the joystick at the press picks the hand (x < 0 = lead).
 * Every punch costs staminaPunchCost, lands or not; thrown gassed (below
 * lowStamina, judged before the cost) its wind-up runs lowStaminaCockMult
 * times slower — a slower pull-back, not a strike in slow motion.
 */
function startPunch(f: FighterState, side: Side, type: PunchType, moveX: number, cfg: Config, events: SimEvent[]): void {
  const hand = punchHand(PUNCHES[type], moveX);
  setCockMult(f, f.stamina < cfg.lowStamina ? cfg.lowStaminaCockMult : 1);
  f.stamina = Math.max(0, f.stamina - cfg.staminaPunchCost);
  f.punch = { type, hand, phase: 'cock', t: 0, progress: 0, resolved: false, contact: null };
  events.push({ type: 'punchStart', side, punch: type, hand });
}

/**
 * Block and punch input for one fighter this tick. Block is a level and
 * engages whenever no punch is in flight; a punch fires on the rising edge of
 * its flag. Both re-check fresh every tick, which is what makes switching
 * instant.
 *
 * A press that cannot fire yet (one in flight, before the chain window) is
 * buffered for punchBuffer seconds — the newest press replaces an older one,
 * the stick at the press is kept for the hand — and fires on the first tick
 * it can. Without this, jab-cross spam lost every press that landed inside
 * the previous punch, and a held key has no edge, so it read as "cross…
 * cross…". The guard coming up, or the canvas, forgets the buffer: block wins.
 */
export function stepActions(f: FighterState, side: Side, input: Readonly<FrameInput>, cfg: Config, dt: number, events: SimEvent[]): void {
  const mask = punchMask(input);
  const pressed = fastestOf(mask & ~prevPunchMask(f));
  setPrevPunchMask(f, mask);

  const guardOpen = f.punch.type === null;
  const wasBlocking = f.block;
  f.block = input.block && guardOpen && !f.down;
  f.blockT = f.block ? (wasBlocking ? f.blockT + dt : 0) : 0;
  f.guard = f.down ? 'down' : f.block ? 'block' : 'rest';

  const buf = punchBuffer(f);
  buf.t = Math.max(0, buf.t - dt);
  if (buf.t === 0) buf.mask = 0;

  if (input.block || f.down) { setPunchBuffer(f, { mask: 0, t: 0, x: 0 }); return; }

  const open = canStartPunch(f, cfg);
  if (pressed !== null) {
    if (open) { startPunch(f, side, pressed, input.move.x, cfg, events); buf.mask = 0; buf.t = 0; }
    else if (cfg.punchBuffer > 0) { buf.mask = maskOf(pressed); buf.t = cfg.punchBuffer; buf.x = input.move.x; }
  } else if (open && buf.mask) {
    startPunch(f, side, fastestOf(buf.mask)!, buf.x, cfg, events);
    buf.mask = 0; buf.t = 0;
  }
  setPunchBuffer(f, buf);
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
  // A gassed throw's cock phase runs slower in real time (the telegraph); the
  // phase table itself is untouched, so every pose still reads off `progress`.
  const was = p.progress * ph.total;
  const rate = was < ph.cock ? 1 / cockMult(f) : 1;
  const elapsed = Math.min(ph.total, was + dt * rate);
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
  takeHit(s, target, mag, blocked, cfg, events);
  s.hitStop = Math.max(s.hitStop, clamp(cfg.hitStopBase * power, 0, cfg.hitStopMax));
}

/**
 * sim/combat.ts — punch start, punch clock, hit resolution and impulse.
 * Port of legacy/src/main.js _resolvePunch / _resolveAttack and the punch
 * timer in fighter.js, in SI.
 */
import type { Config, FighterState, FrameInput, PunchType, Side, SimEvent, SimState, Vec3 } from '../core';
import { clamp, closestOnSegment, frameOf, lerp, sphereCapsuleOverlap, v2dist, v2dot, handLateralSign, worldToLocal } from '../core';
import { PUNCHES, punchCrouch, punchEnvelope, punchHand, punchLean, punchTwist, whiffPhases, whiffRecoveryMult } from './punches';
import { MASK_CROSS, MASK_HOOK, MASK_JAB, MASK_UPPERCUT, cockMult, prevPunchMask, punchBuffer, punchMask, setCockMult, setPrevPunchMask, setPunchBuffer, setWhiffMult, whiffMult } from './state';
import { applyReaction } from './reaction';
import { takeHit } from './resources';
import { slipBack, slipLateral } from './slip';
import { applyPunish } from './vulnerability';

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
function startPunch(f: FighterState, side: Side, type: PunchType, moveX: number, moveY: number, cfg: Config, events: SimEvent[]): void {
  const def = PUNCHES[type];
  const hand = punchHand(def, moveX);
  setCockMult(f, f.stamina < cfg.lowStamina ? cfg.lowStaminaCockMult : 1);
  setWhiffMult(f, 1);
  f.stamina = Math.max(0, f.stamina - cfg.staminaPunchCost);
  f.punch = { type, hand, phase: 'cock', t: 0, progress: 0, resolved: false, contact: null };
  // The step-in (2026-09-16): a straight thrown with the stick pushed forward
  // takes a short lunge step with it — a burst on the stagger channel (it
  // decays on its own, is not capped by walking speed, and counts as approach
  // momentum in the impulse), covering punchStepIn metres by the time the
  // fist lands. Hooks and uppercuts are thrown from where you stand.
  if (def.smotherable && cfg.punchStepIn > 0 && moveY > cfg.punchStepInStick && !f.down) {
    const fr = frameOf(f.yaw);
    // Sized so that punchStepIn metres are covered by the resolve moment
    // whatever the stagger decay is (the burst keeps gliding a little after).
    const ph = def.phases(cfg);
    const k = cfg.staggerDecay, tPeak = ph.cock + ph.extend;
    const covered = 1 - Math.exp(-k * tPeak);
    const v = cfg.punchStepIn * k / Math.max(0.05, covered);
    f.stagger.x += fr.fwd.x * v;
    f.stagger.z += fr.fwd.z * v;
  }
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
  // The guard cannot come up inside a slip window (v1: isBlocking requires
  // slipTimer === 0); the head is committed. It engages the tick the window closes.
  f.block = input.block && guardOpen && !f.down && !f.slip.active;
  f.blockT = f.block ? (wasBlocking ? f.blockT + dt : 0) : 0;
  f.guard = f.down ? 'down' : f.block ? 'block' : 'rest';

  const buf = punchBuffer(f);
  buf.t = Math.max(0, buf.t - dt);
  if (buf.t === 0) buf.mask = 0;

  if (input.block || f.down) { setPunchBuffer(f, { mask: 0, t: 0, x: 0 }); return; }

  const open = canStartPunch(f, cfg);
  if (pressed !== null) {
    if (open) { startPunch(f, side, pressed, input.move.x, input.move.y, cfg, events); buf.mask = 0; buf.t = 0; }
    else if (cfg.punchBuffer > 0) { buf.mask = maskOf(pressed); buf.t = cfg.punchBuffer; buf.x = input.move.x; }
  } else if (open && buf.mask) {
    // A buffered press keeps the hand it chose; the step-in reads the stick as it fires.
    startPunch(f, side, fastestOf(buf.mask)!, buf.x, input.move.y, cfg, events);
    buf.mask = 0; buf.t = 0;
  }
  setPunchBuffer(f, buf);
}

/**
 * Advance the punch clock. Returns true on the one tick the punch reaches its
 * resolve moment (peakAt), which is when the hit test runs.
 */
/** Seconds of slack on a phase boundary so a boundary that falls on a tick is taken on that tick. */
const PHASE_EPS = 1e-6;

export function advancePunch(f: FighterState, cfg: Config, dt: number): boolean {
  const p = f.punch;
  if (p.type === null) return false;
  const def = PUNCHES[p.type];
  const ph = whiffPhases(f, def.phases(cfg));   // a miss drops the hold (fist and body come home together)
  // A gassed throw's cock phase runs slower in real time (the telegraph), and
  // a punch that missed retracts slower (the whiff cost, set at the resolve);
  // the phase table itself is untouched, so every pose still reads off
  // `progress`, and the exposure curve stretches with the recovery for free.
  const was = p.progress * ph.total;
  const rate = was < ph.cock - PHASE_EPS ? 1 / cockMult(f) : was >= ph.cock + ph.extend - PHASE_EPS ? 1 / whiffMult(f) : 1;
  const elapsed = Math.min(ph.total, was + dt * rate);
  p.progress = elapsed / ph.total;
  // Phase boundaries with a float epsilon: twelve ticks of 1/60 sum to a hair
  // under 0.2, and a phase that ends exactly on a tick must end ON that tick,
  // not one later (the whiff stretch and the hit test both key off it).
  if (elapsed < ph.cock - PHASE_EPS) { p.phase = 'cock'; p.t = elapsed; }
  else if (elapsed < ph.cock + ph.extend - PHASE_EPS) { p.phase = 'extend'; p.t = elapsed - ph.cock; }
  else { p.phase = 'recover'; p.t = Math.max(0, elapsed - ph.cock - ph.extend); }

  // Whole-body channels the rig draws: forward and lateral weight transfer,
  // torso twist (all peak at the resolve moment and hold with the fist) and
  // the body dip.
  const ext = punchEnvelope(elapsed, ph);
  f.lean.fwd = cfg.punchLean * def.lean * punchLean(def, elapsed, ph, cfg);
  f.lean.lat = def.sway * handLateralSign(p.hand, f.stance) * ext;
  f.torsoTwist = (p.hand === 'lead' ? 1 : -1) * handLateralSign('lead', f.stance) * def.turn * punchTwist(def, elapsed, ph);
  f.crouch = punchCrouch(def, elapsed, ph, cfg);

  let peak = false;
  if (!p.resolved && p.progress >= ph.peakAt - PHASE_EPS / ph.total) { p.resolved = true; peak = true; }
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
  // A miss is paid for in the recovery: the arm comes back whiffRecoveryMult
  // (weighted per type) times slower, the next punch and the guard wait for
  // it, and the exposure curve decays over the longer window.
  if (dist > cfg.rangeMax) { events.push({ type: 'punchWhiff', side, punch: type }); setWhiffMult(a, whiffRecoveryMult(def, cfg)); return; }

  const g = a.gloves[a.punch.hand === 'lead' ? 0 : 1];
  const glove = { x: g.pos.x, y: g.pos.y, z: g.pos.z, r: a.body.gloveR };
  // Swept (2026-09-16): the glove is tested along the last punchSweepLen of
  // its LINE — the attacker's forward axis, ending where the fist is — not
  // only where it stopped. A cramped straight at body contact now reaches
  // PAST the head (the lean carries the shoulders forward) and still lands.
  // Along the forward axis only, so the sweep never drifts sideways into a
  // head that slipped just clear of the fist (the slip-into-the-hand body
  // shot stays a body shot).
  const afr = frameOf(a.yaw);
  const sweep = { a: { x: g.pos.x - afr.fwd.x * cfg.punchSweepLen, y: g.pos.y, z: g.pos.z - afr.fwd.z * cfg.punchSweepLen }, b: { x: g.pos.x, y: g.pos.y, z: g.pos.z }, r: a.body.gloveR };
  const bodyHit = (): boolean => {
    for (const t of [1, 0.5, 0]) {
      const p = { x: lerp(sweep.a.x, sweep.b.x, t), y: lerp(sweep.a.y, sweep.b.y, t), z: lerp(sweep.a.z, sweep.b.z, t), r: glove.r };
      if (sphereCapsuleOverlap(p, d.bodyBox)) return true;
    }
    return false;
  };
  const part = sphereCapsuleOverlap(d.headBox, sweep) ? 'head' : bodyHit() ? 'body' : null;
  if (part === null) {
    events.push({ type: 'punchWhiff', side, punch: type });
    setWhiffMult(a, whiffRecoveryMult(def, cfg));
    // Slip classification (legacy main.js Stage 19 part 1): a punch that missed
    // because the defender READ it and one that missed because the attacker
    // was out of range are the same whiff to every other system, and must not
    // earn the same reward. The test is the head test again, at the head's
    // UN-slipped position: if the glove would have found it there, the slip is
    // the only thing that took the punch away. A classification layered on,
    // not a new outcome — the whiff above still stands for recovery and stamina.
    if (d.slip.active && d.slip.dir !== 0) {
      const fr = frameOf(d.yaw), lat = slipLateral(d), back = slipBack(d);
      const home = { x: d.headBox.x - fr.right.x * lat + fr.fwd.x * back, y: d.headBox.y, z: d.headBox.z - fr.right.z * lat + fr.fwd.z * back, r: d.headBox.r };
      if (sphereCapsuleOverlap(home, sweep)) {
        events.push({ type: 'slip', side: target, dir: d.slip.dir, dodged: true });
        // The slip punish: the attacker is pinned exposed, and the counter
        // machinery does the rest. Survives the stretched recovery above —
        // the spike is a floor under the curve, on its own clock.
        applyPunish(a, cfg.slipPunishVuln, cfg.slipPunishDuration);
      }
    }
    return;
  }

  // Impulse: base + attacker momentum toward the defender, floored so a
  // retreating punch still lands with something, scaled by lean and per-type.
  // Momentum is measured along the attacker→defender line; the impulse
  // DIRECTION is that line blended, per type, with the fist's own travel, so
  // a hook that crosses the face sends the head and body sideways.
  let adX: number, adZ: number;
  if (dist > 1e-6) { adX = (d.pos.x - a.pos.x) / dist; adZ = (d.pos.z - a.pos.z) / dist; }
  else { const fr = frameOf(a.yaw); adX = fr.fwd.x; adZ = fr.fwd.z; }
  // Walking plus the stagger channel: a step-in lunge (and, fairly, a shove
  // toward the defender) is momentum behind the fist too.
  const approachSpd = v2dot({ x: a.vel.x + a.stagger.x, z: a.vel.z + a.stagger.z }, { x: adX, z: adZ });
  let dirX = adX, dirZ = adZ;
  if (def.swing > 0) {
    // The fist's travel direction. A torso-frame punch (hook) travels on the
    // TANGENT of the body's turn — perpendicular to the line from the
    // fighter's axis to the fist, in the turn's direction — which is the
    // analytic version of what the glove was doing (2026-09-16; the glove
    // spring has settled by the resolve, so its own velocity no longer says).
    let tx = 0, tz = 0;
    if (def.torsoFrame) {
      const afr = frameOf(a.yaw);
      const loc = worldToLocal(a.pos, afr, g.pos);
      const sgn = a.torsoTwist >= 0 ? 1 : -1;
      const lf = loc.lateral * sgn, ll = -loc.forward * sgn;   // d/dθ of a yawed point: (z, −x) × sign(θ)
      tx = afr.fwd.x * lf + afr.right.x * ll; tz = afr.fwd.z * lf + afr.right.z * ll;
    } else { tx = g.vel.x; tz = g.vel.z; }
    const vlen = Math.hypot(tx, tz);
    if (vlen > 1e-6) {
      dirX = lerp(adX, tx / vlen, def.swing); dirZ = lerp(adZ, tz / vlen, def.swing);
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

  // Counter: the target's exposure this tick (0 while blocking, by
  // construction) scales the ONE impulse value damage, stagger, reaction and
  // hit-stop all read, so a counter is harder, pushes further and reacts
  // bigger without three separate multipliers.
  const targetVuln = d.vuln;
  const counter = targetVuln > 0;
  mag *= 1 + targetVuln * cfg.counterImpulseBonus;

  // Perfect block: a guard younger than perfectBlockWindow at the impact —
  // and younger than perfectBlockLateFrac of the punch's flight, so it read
  // the ARRIVAL, not the start (see config). It absorbs the punch (stagger
  // and reaction stay) but costs nothing, and the attacker is pinned exposed.
  const blocked = d.block;
  const ph = def.phases(cfg);
  const flight = ph.cock * cockMult(a) + ph.extend;
  const perfect = blocked && d.blockT <= Math.min(cfg.perfectBlockWindow, cfg.perfectBlockLateFrac * flight);
  if (blocked) mag *= 1 - cfg.blockReduction;
  const power = mag / cfg.punchImpulseBase;
  const dir: Vec3 = { x: dirX, y: 0, z: dirZ };
  const impulse: Vec3 = { x: dirX * mag, y: 0, z: dirZ * mag };
  const at: Vec3 = { x: g.pos.x, y: g.pos.y, z: g.pos.z };

  if (perfect) events.push({ type: 'perfectBlock', side, target, punch: type, at });
  else if (blocked) events.push({ type: 'punchBlock', side, target, punch: type, at });
  else {
    events.push({ type: 'punchLand', side, target, punch: type, hand: a.punch.hand, part, at, impulse, power, counter });
    // The judges see clean lands and how hard they were (round.ts scoring).
    s.round.landed[side] += 1;
    s.round.power[side] += mag;
  }
  events.push({ type: 'hurt', side: target, part, impulse });
  if (counter && !blocked) events.push({ type: 'counter', side, target, punch: type });

  d.stagger.x += impulse.x / d.body.massKg;
  d.stagger.z += impulse.z / d.body.massKg;
  applyReaction(d, type, dir, mag, cfg);
  if (perfect) {
    applyPunish(a, cfg.perfectBlockPunishVuln, cfg.perfectBlockPunishDuration);
    s.hitStop = Math.max(s.hitStop, cfg.perfectBlockHitStop);
  } else {
    takeHit(s, target, mag, blocked, cfg, events);
    s.hitStop = Math.max(s.hitStop, clamp(cfg.hitStopBase * power, 0, cfg.hitStopMax) + targetVuln * cfg.counterHitStopBonus);
  }
}

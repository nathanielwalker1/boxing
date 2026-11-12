/**
 * sim/clinch.ts — the two things a fighter does WITH the other fighter that
 * are not punches (overhaul 2026-11-11, brief A2 "the taller fighter can push
 * off, tie up or pivot out", A5 "surviving by … tying up").
 *
 * PUSH-OFF — block held + a forward flick (slip.ts raises the request). In
 * reach it shoves the other fighter back on the stagger channel (scaled by
 * the two masses), rocks the pusher back a little, holds the shoved fighter
 * out of punching for pushStun, smothers a wind-up that has not committed,
 * denies a clinch attempt and breaks a clinch. No damage.
 *
 * CLINCH — block + level held together inside clinchRange for clinchReach
 * seconds. Both fighters are tied up: no walking, no punches, no slips. The
 * hurt clock runs clinchHurtRecover times faster (stun.ts) — this is what a
 * hurt fighter is buying. The referee breaks it after clinchSeconds and the
 * two are sent apart to clinchBreakDist; the fighter who tied up cannot do
 * it again for clinchCooldown. A clean shot taken during the reach breaks
 * the attempt (combat.ts zeroes `clinch.reach`).
 */
import type { Config, FighterState, FrameInput, Side, SimEvent, SimState } from '../core';
import { clamp, frameOf, handLateralSign, smoothstep, v2angle, v2dist } from '../core';
import type { FlickRequest } from './slip';
import { addHop } from './footing';
import { idlePunch, setStuffed, stuffed } from './state';

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/** The unit vector from `side` to the other fighter on the floor (its facing if they are co-located). */
function toward(s: SimState, side: Side): { x: number; z: number; dist: number } {
  const f = s.fighters[side], o = s.fighters[other(side)];
  const dist = v2dist(f.pos, o.pos);
  if (dist > 1e-6) return { x: (o.pos.x - f.pos.x) / dist, z: (o.pos.z - f.pos.z) / dist, dist };
  const fr = frameOf(f.yaw);
  return { x: fr.fwd.x, z: fr.fwd.z, dist };
}

function breakClinch(s: SimState, side: Side, reason: 'referee' | 'pushOff' | 'denied', cfg: Config, events: SimEvent[]): void {
  const u = toward(s, 0);
  const gap = Math.max(0, cfg.clinchBreakDist - u.dist) / 2;
  for (const sd of [0, 1] as const) {
    const f = s.fighters[sd];
    f.clinch.active = false; f.clinch.reach = 0; f.clinch.by = -1;
    // clinchV2: the lean and the turned shoulder come back over clinchRelease (t runs up from −clinchRelease to 0, see releaseClinch).
    f.clinch.t = cfg.clinchV2 && reason !== 'denied' ? -cfg.clinchRelease : 0;
    if (cfg.clinchV2) { f.hop.x = 0; f.hop.z = 0; }
    const sign = sd === 0 ? -1 : 1;
    if (reason !== 'denied') addHop(f, u.x * sign, u.z * sign, gap, cfg);
  }
  events.push({ type: 'clinchBreak', side, reason });
}

function pushOff(s: SimState, side: Side, cfg: Config, events: SimEvent[]): void {
  const f = s.fighters[side], o = s.fighters[other(side)];
  if (f.down || f.pushCd > 0) return;
  f.pushCd = cfg.pushCooldown;
  f.stamina = Math.max(0, f.stamina - cfg.pushStaminaCost);
  const u = toward(s, side);
  const tied = f.clinch.active;
  const hit = !o.down && (tied || u.dist <= cfg.pushRange);
  events.push({ type: 'pushOff', side, target: other(side), hit });
  if (!hit) return;
  if (tied) breakClinch(s, side, 'pushOff', cfg, events);
  else if (o.clinch.reach > 0) { o.clinch.reach = 0; o.clinch.cd = Math.max(o.clinch.cd, cfg.pushCooldown); events.push({ type: 'clinchBreak', side, reason: 'denied' }); }
  const mass = Math.min(PUSH_MASS_MAX, Math.max(1 / PUSH_MASS_MAX, f.body.massKg / o.body.massKg));
  const v = cfg.pushSpeed * mass;
  o.stagger.x += u.x * v; o.stagger.z += u.z * v;
  f.stagger.x -= u.x * v * cfg.pushRecoil; f.stagger.z -= u.z * v * cfg.pushRecoil;
  o.blockStun = Math.max(o.blockStun, cfg.pushStun);
  // A wind-up that has not committed is smothered: it rewinds home like a stuffed punch.
  const p = o.punch;
  if (p.type !== null && !p.resolved && p.phase === 'cock' && !stuffed(o) && !p.feint) {
    setStuffed(o, true);
    events.push({ type: 'punchStuffed', side: other(side), by: side, punch: p.type });
  }
}
/** The mass ratio's effect on a shove is capped at this (and its inverse). Shape. */
const PUSH_MASS_MAX = 1.4;

/** Push-offs, clinch attempts and the clinch in progress, for the pair. Runs after the flick detector and the actions. */
export function stepClinch(s: SimState, inputs: readonly [Readonly<FrameInput>, Readonly<FrameInput>], reqs: readonly [FlickRequest, FlickRequest], cfg: Config, dt: number, events: SimEvent[]): void {
  for (const side of [0, 1] as const) if (reqs[side].push && cfg.pushOffOn) pushOff(s, side, cfg, events);

  const [a, b] = s.fighters;
  if (cfg.clinchV2) for (const f of s.fighters) releaseClinch(f, cfg, dt);
  if (a.clinch.active && b.clinch.active) {
    a.clinch.t += dt; b.clinch.t += dt;
    if (cfg.clinchV2) holdClinch(s, cfg, dt);
    if (a.clinch.t >= cfg.clinchSeconds) breakClinch(s, a.clinch.by === 1 ? 1 : 0, 'referee', cfg, events);
    return;
  }
  const dist = v2dist(a.pos, b.pos);
  for (const side of [0, 1] as const) {
    const f = s.fighters[side], o = s.fighters[other(side)], input = inputs[side];
    const wants = cfg.clinchOn && cfg.levelOn && input.block && input.level && !f.down && !o.down
      // (Phase 4: a HURT man can always hold on — the cooldown does not apply to him. It is the oldest way to survive.)
      && (f.clinch.cd === 0 || (cfg.clinchHurtFree && f.hurt > 0)) && f.punch.type === null && f.pivot.dir === 0 && dist <= cfg.clinchRange;
    f.clinch.reach = wants ? f.clinch.reach + dt : 0;
    if (!wants || f.clinch.reach < cfg.clinchReach || o.clinch.active) continue;
    // Tied up: whatever either was doing stops.
    for (const g of [f, o]) {
      g.clinch.active = true; g.clinch.reach = 0; g.clinch.t = 0; g.clinch.by = side;
      if (cfg.clinchV2) { g.lean.lat = 0; g.torsoTwist = 0; g.crouch = 0; }
      // A punch still on its way out is smothered: it rewinds home the way a feint does (no pose pop); one that has
      // already landed or missed just finishes coming back.
      if (g.punch.type !== null && !g.punch.resolved && !stuffed(g)) g.punch.feint = true;
      g.vel.x = 0; g.vel.z = 0; g.hop.x = 0; g.hop.z = 0;
      g.block = false; g.blockT = 0;
    }
    f.clinch.cd = cfg.clinchCooldown + cfg.clinchSeconds;
    f.stamina = Math.max(0, f.stamina - cfg.clinchStaminaCost);
    events.push({ type: 'clinch', side, target: other(side) });
    return;
  }
}

// ── clinchV2 (polish phase 2026-11-11, item 7: "it's like they're making out") ──────────────────────────────
// MEASURED on the old clinch (docs/POLISH_RIG.md): the two stood wherever they were when it took (0.6 m in the
// strip), square to each other, and the DRAWING leaned each chest in 22° and slid each head 9 cm — the faces ended
// 6 cm apart, nose to nose, and the drawn arms went round through the other body. Nothing of it was the sim's.
//
// Here the tie-up is the sim's, so what is drawn is where the bodies are:
//   · THE PULL: over clinchEntry the pair close (or open) to clinchHoldDist at no more than clinchPullSpeed.
//   · THE BLADE: both turn clinchBladeDeg the same way round — lead shoulder into the other man's chest.
//   · THE LEAN: lean.fwd goes to clinchLean, so head and shoulders go in (punchLeanShift) and the hips stay back.
//     Turned and leaning, each head is carried PAST the other on its own side: over his shoulder, ear to ear.
//   · THE TURN: the pair walk round their midpoint at clinchTurnRate (the man who tied up leads it).
//   · the hands go to the other man's flank and shoulder (gloves.ts clinchLocal) and stop on him (solid bodies).
// The break is what it was (the referee after clinchSeconds, or a push-off): a hop apart to clinchBreakDist, and the
// lean and the turn come back over clinchRelease. Everything moves on the hop channel, so the ring still clamps it
// and nobody "walks" (vel stays 0).

/** One tick of the tie-up for the pair (both active). */
function holdClinch(s: SimState, cfg: Config, dt: number): void {
  const [a, b] = s.fighters;
  const u = toward(s, 0);
  const k = smoothstep(Math.min(1, a.clinch.t / Math.max(1e-6, cfg.clinchEntry)));
  // The pull along the line (each man half), and the turn about the midpoint.
  const pull = clamp((u.dist - cfg.clinchHoldDist) / Math.max(1e-6, dt), -cfg.clinchPullSpeed, cfg.clinchPullSpeed) / 2;
  const by = a.clinch.by === 1 ? b : a;
  const sense = -handLateralSign('lead', by.stance);   // the world sense that puts the initiator's LEAD shoulder in; both men turn the same way round, so their heads pass on opposite sides
  const around = sense * cfg.clinchTurnRate * (u.dist / 2) * k;
  const tx = -u.z, tz = u.x;
  a.hop.x = u.x * pull + tx * around; a.hop.z = u.z * pull + tz * around;
  b.hop.x = -u.x * pull - tx * around; b.hop.z = -u.z * pull - tz * around;
  for (const sd of [0, 1] as const) {
    const f = s.fighters[sd];
    f.lean.fwd = cfg.clinchLean * k;
    // The blade: stepFacing (later this tick) turns him back toward the line at its own rate, so the angle set here
    // is the angle wanted PLUS that step — what reaches the boxes is exactly clinchBladeDeg × k off the line.
    const line = v2angle({ x: sd === 0 ? u.x : -u.x, z: sd === 0 ? u.z : -u.z });
    const back = cfg.turnRate * (f.turned > 0 ? cfg.pivotTurnScale : 1) * dt;
    const off = cfg.clinchBladeDeg * (Math.PI / 180) * k;
    f.yaw = line + sense * (off > 1e-6 ? off + back : 0);
  }
}

/** After a break: the lean eases out over clinchRelease (clinch.t counts up from −clinchRelease to 0). A punch thrown meanwhile owns the lean. */
function releaseClinch(f: FighterState, cfg: Config, dt: number): void {
  if (f.clinch.active || f.clinch.t >= 0) return;
  f.clinch.t = Math.min(0, f.clinch.t + dt);
  if (f.punch.type === null) f.lean.fwd = f.clinch.t < 0 ? cfg.clinchLean * smoothstep(-f.clinch.t / Math.max(1e-6, cfg.clinchRelease)) : 0;
}

/** How tied up a fighter is, 0..1 — for the glove targets and the rig: in over clinchEntry, out over clinchRelease. */
export function clinchAmount(f: FighterState, cfg: Config): number {
  if (!cfg.clinchV2) return f.clinch.active ? 1 : 0;
  if (f.clinch.active) return smoothstep(Math.min(1, f.clinch.t / Math.max(1e-6, cfg.clinchEntry)));
  return f.clinch.t < 0 ? smoothstep(-f.clinch.t / Math.max(1e-6, cfg.clinchRelease)) : 0;
}

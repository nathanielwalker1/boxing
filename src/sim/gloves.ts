/**
 * sim/gloves.ts — the kinetic chain. The sim owns the glove (CONTRACT
 * 2026-09-02): each glove chases a target through a spring-damper, and
 * `gloves[i].pos` IS the hit sphere. Targets: the guard (with a deterministic
 * idle bob so the hands never freeze), the tighter block pose, or the punch
 * trajectory for the throwing hand. The two hands get slightly different
 * constants so they never twin; the throwing hand is much stiffer through
 * cock + extend so the fist arrives when the timing table says it does, then
 * relaxes for the recovery and overshoots on the way back.
 */
import type { Config, FighterState, GloveState, Hand, Side, Vec3 } from '../core';
import { TAU, closestOnSegment, frameOf, handLateralSign, localToWorld, sin, sqrt, twoBoneMid } from '../core';
import { PUNCHES, blockLocal, guardLocal, punchLocal, whiffPhases, type LocalPose } from './punches';
import { slipBack, slipLateral } from './slip';
import { setTouchedBlock } from './state';

const HANDS: [Hand, Hand] = ['lead', 'rear'];
/**
 * Semi-implicit Euler is only stable while c·dt < 1 and k·dt² < 4. The
 * throwing hand runs at ~10 000 1/s² and ~160 1/s, so the glove springs are
 * integrated in sub-steps of SIM_DT / CHAIN_SUBSTEPS. Integration detail, not
 * a tunable: changing it changes results, not feel.
 */
const CHAIN_SUBSTEPS = 4;
/** Bob phase offsets per hand and per side — shape, so the four gloves desync. */
const BOB_PHASE_HAND = [0, 1.9];
const BOB_PHASE_SIDE = [0, 2.6];

/** `guard`: the hand is at rest or blocking (it rides the shoulders through a slip); a punching hand aims from the fighter's frame. */
function targetLocal(f: FighterState, hand: Hand, cfg: Config): { pose: LocalPose; kMul: number; contact: Vec3 | null; guard: boolean } {
  const p = f.punch;
  if (p.type !== null && p.hand === hand) {
    const def = PUNCHES[p.type];
    if (def) {
      const ph = whiffPhases(f, def.phases(cfg));
      const kMul = p.phase === 'recover' ? def.recoverK(cfg) : cfg.chainPunchK;
      // With solid bodies (clampGloves) the target stays on the free-air peak
      // through the hold: the fist presses on what it hit and follows it. The
      // old way — the target moved to the contact point — is kept for
      // contactSolid 0, where it is all that stops the fist floating inside.
      const rt = (p.progress * ph.total - ph.cock - ph.extend) / ph.recover;
      const contact = cfg.contactSolid <= 0 && p.contact && p.phase === 'recover' && rt < ph.hold ? p.contact : null;
      return { pose: punchLocal(f.body, f.stance, def, hand, p.progress * ph.total, ph, cfg, f.torsoTwist), kMul, contact, guard: false };
    }
  }
  return { pose: f.block ? blockLocal(f.body, hand, f.stance) : guardLocal(f.body, hand, f.stance), kMul: 1, contact: null, guard: true };
}

/** Is the glove-centre point `p` inside `other`'s head or body, inflated by the glove less its give? */
function insideOther(p: Vec3, other: FighterState, gloveR: number, sink: number): boolean {
  const rh = other.headBox.r + gloveR - sink;
  const dx = p.x - other.headBox.x, dy = p.y - other.headBox.y, dz = p.z - other.headBox.z;
  if (dx * dx + dy * dy + dz * dz < rh * rh) return true;
  const c = closestOnSegment(other.bodyBox.a, other.bodyBox.b, p);
  const rb = other.bodyBox.r + gloveR - sink;
  const ex = p.x - c.x, ey = p.y - c.y, ez = p.z - c.z;
  return ex * ex + ey * ey + ez * ez < rb * rb;
}

/**
 * The target a glove may actually be pulled to: `t`, or `t` pulled back
 * along the attacker's FORWARD axis until it is outside the other fighter.
 * A spring aimed at a target behind a head slides the fist round the skull
 * to get there (measured: 15–25 cm past the head centre at close range); a
 * target cut on the fist's own line sticks an uppercut under the chest. Cut
 * along the forward axis only, the fist stops on the face with a bent arm
 * and is still free to rise (uppercut) or sweep (hook) along the surface.
 * If no forward pull-back short of the glove's current depth clears the
 * body (the fist is entering sideways), the target is left alone and the
 * position clamp does the rest. Sampled then bisected.
 */
function cutTarget(from: Vec3, t: Vec3, fwd: { x: number; z: number }, other: FighterState, gloveR: number, sink: number): Vec3 {
  // "Blocked": the target is inside the other fighter, or the path from the
  // fist to it passes through them (a jab's spring covers 30 cm a tick, and
  // a target BEHIND the head is outside it — the fist tunnelled). The path
  // test allows TUNNEL_TOL deeper than the endpoint, so a fist sliding along
  // a curved surface (its chord dips a few mm) is not held back.
  const blocked = (p: Vec3): boolean => {
    if (insideOther(p, other, gloveR, sink)) return true;
    for (let i = 1; i < CONTACT_SAMPLES; i++) {
      const u = i / CONTACT_SAMPLES;
      if (insideOther({ x: from.x + (p.x - from.x) * u, y: from.y + (p.y - from.y) * u, z: from.z + (p.z - from.z) * u }, other, gloveR, sink + TUNNEL_TOL)) return true;
    }
    return false;
  };
  if (!blocked(t)) return t;
  const depth = (t.x - from.x) * fwd.x + (t.z - from.z) * fwd.z;   // the target's advance past the fist, along fwd
  if (depth <= 0) return t;
  const at = (s: number): Vec3 => ({ x: t.x - fwd.x * s, y: t.y, z: t.z - fwd.z * s });
  // Search back past the fist's own depth too: the fist may already sit
  // inside the inflated radius at the target's height and side, and a
  // target a little behind it is what holds it on the surface.
  const reach = depth + CUT_BACK_MAX;
  if (blocked(at(reach))) return t;
  let lo = 0, hi = reach;   // lo = blocked, hi = clear
  for (let i = 1; i < CONTACT_SAMPLES; i++) {
    const s = reach * i / CONTACT_SAMPLES;
    if (blocked(at(s))) lo = s; else { hi = s; break; }
  }
  for (let i = 0; i < CONTACT_BISECTIONS; i++) {
    const s = (lo + hi) / 2;
    if (blocked(at(s))) lo = s; else hi = s;
  }
  return at(hi);
}
const CONTACT_SAMPLES = 8, CONTACT_BISECTIONS = 6;
/** Extra depth (m) the fist→target path may dip into a body before it counts as passing through — a chord along a curved surface, not a tunnel. */
const TUNNEL_TOL = 0.015;
/** How far behind the fist's current depth (m) the cut may pull a target before giving up. */
const CUT_BACK_MAX = 0.3;

/** Compute this tick's targets and advance the springs by dt. `other` is the fighter the gloves may not enter. */
export function stepGloves(f: FighterState, other: FighterState, side: Side, time: number, cfg: Config, dt: number): void {
  const fr = frameOf(f.yaw);
  const solid = cfg.contactSolid > 0;
  const sink = f.body.gloveR * cfg.contactSquash;
  for (let i = 0; i < 2; i++) {
    const hand = HANDS[i]!;
    const { pose, kMul, contact, guard } = targetLocal(f, hand, cfg);
    const bob = sin(time * TAU * cfg.chainBobHz + BOB_PHASE_HAND[i]! + BOB_PHASE_SIDE[side]!) * cfg.chainBobAmp;
    // The hands ride the body down through a crouch (guard and punch alike).
    // The guard also rides the shoulders sideways through a slip; a punching
    // hand does not — it aims from the fighter's frame, so a slip-and-hook
    // still lands where the hook was thrown.
    const lat = pose.lat + (guard ? slipLateral(f) * cfg.slipShoulderFrac : 0);
    // …and forward with the weight transfer (the shoulders move; computeBoxes
    // moves the body by the same shift), back with a pull.
    const fwd = pose.fwd + f.lean.fwd * cfg.punchLeanShift - (guard ? slipBack(f) * cfg.slipShoulderFrac : 0);
    let t = contact ? { x: contact.x, y: contact.y, z: contact.z } : localToWorld(f.pos, fr, fwd, pose.up + bob - f.crouch, lat);
    // The gloves ride the torso's reaction offset, so they travel with the body.
    if (!contact) { t.x += f.reaction.torso.x; t.y += f.reaction.torso.y; t.z += f.reaction.torso.z; }
    const g = f.gloves[i]!;
    if (solid) t = cutTarget(g.pos, t, fr.fwd, other, f.body.gloveR, sink);
    g.target = t;

    let k = cfg.chainK * (i === 1 ? cfg.chainRearK : 1);
    let c = cfg.chainC * (i === 1 ? cfg.chainRearC : 1);
    if (kMul !== 1) { k *= kMul; c *= sqrt(kMul); }
    const h = dt / CHAIN_SUBSTEPS;
    for (let n = 0; n < CHAIN_SUBSTEPS; n++) {
      g.vel.x += (k * (t.x - g.pos.x) - c * g.vel.x) * h;
      g.vel.y += (k * (t.y - g.pos.y) - c * g.vel.y) * h;
      g.vel.z += (k * (t.z - g.pos.z) - c * g.vel.z) * h;
      g.pos.x += g.vel.x * h; g.pos.y += g.vel.y * h; g.pos.z += g.vel.z * h;
    }
  }
}

/**
 * Solid bodies (2026-09-18, "fists go through the head like it's
 * translucent… exchanges feel light and cheap"): after the springs step,
 * every glove of `f` is pushed out of the other fighter's head sphere, body
 * capsule and glove spheres — to contactSquash × gloveR inside the surface,
 * the leather's give — and its inward velocity is killed. So a fist stops
 * dead at the skull and, with its target still on the free-air peak, presses
 * on and rides the head back as the reaction moves it: the follow-through.
 * Runs before the hit test, which still sees the overlap it needs (the sink).
 * Measured before: a jab at 0.85 m sat 11 cm inside the head through the hold.
 */
export function clampGloves(f: FighterState, other: FighterState, cfg: Config): void {
  if (cfg.contactSolid <= 0) return;
  const sink = f.body.gloveR * cfg.contactSquash;
  const arms = simArms(other, cfg);
  for (const g of f.gloves) {
    // Head and body overlap at the chin, so a push out of one can land in
    // the other; a few passes settle it (measured: one pass left 4–5 cm).
    for (let pass = 0; pass < CLAMP_PASSES; pass++) {
      pushOut(g, other.headBox, other.headBox.r + f.body.gloveR - sink);
      const c = closestOnSegment(other.bodyBox.a, other.bodyBox.b, g.pos);
      pushOut(g, c, other.bodyBox.r + f.body.gloveR - sink);
      // The upper arms hang off the shoulders: solid, like the body.
      for (const arm of arms) pushOut(g, closestOnSegment(arm.shoulder, arm.elbow, g.pos), arm.upperR + f.body.gloveR - sink);
    }
  }
}
/** Constraint passes per glove per tick — integration detail, not a tunable. */
const CLAMP_PASSES = 3;

/**
 * Arms and gloves are SOFT (2026-09-18, "punches still go through my
 * opponent's arms"): the other fighter's gloves and forearms are obstacles
 * too, but a relaxed guard is not a wall — a jab through it knocks the guard
 * hand aside (the fist takes contactPunchShare of the separation, the guard
 * glove the rest, and the forearm, drawn from that glove by the rig, goes
 * with it). A BLOCKING glove is stiff (contactBlockShare) so a fist stops at
 * it; two punching fists split the push. A punching glove that met a block
 * glove or forearm is flagged for the hit test (a stopped fist is a blocked
 * punch, not a whiff). Runs once per tick for the pair, after clampGloves.
 */
export function resolveGloveContacts(a: FighterState, b: FighterState, cfg: Config): void {
  for (const f of [a, b]) { setTouchedBlock(f, 0, false); setTouchedBlock(f, 1, false); }
  if (cfg.contactSolid <= 0) return;
  const armsA = simArms(a, cfg), armsB = simArms(b, cfg);
  for (let pass = 0; pass < CLAMP_PASSES; pass++) {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const ga = a.gloves[i]!, gb = b.gloves[j]!;
      const sink = Math.min(a.body.gloveR, b.body.gloveR) * cfg.contactSquash;
      // Glove vs glove.
      if (pushApart(ga, gb, gb.pos, a.body.gloveR + b.body.gloveR - sink, share(a, i, cfg), share(b, j, cfg))) touched(a, i, b);
      // A glove vs the other's forearm (dragged by the glove at its end).
      const cb = closestOnSegment(armsB[j]!.elbow, gb.pos, ga.pos);
      if (pushApart(ga, gb, cb, armsB[j]!.foreR + a.body.gloveR - sink, share(a, i, cfg), share(b, j, cfg))) touched(a, i, b);
      const ca = closestOnSegment(armsA[i]!.elbow, ga.pos, gb.pos);
      if (pushApart(gb, ga, ca, armsA[i]!.foreR + b.body.gloveR - sink, share(b, j, cfg), share(a, i, cfg))) touched(b, j, a);
    }
    // A hand never enters its own head or body (a shoved guard glove stops at the face).
    for (const f of [a, b]) {
      const sink = f.body.gloveR * cfg.contactSquash;
      for (const g of f.gloves) {
        pushOut(g, f.headBox, f.headBox.r + f.body.gloveR - sink);
        pushOut(g, closestOnSegment(f.bodyBox.a, f.bodyBox.b, g.pos), f.bodyBox.r + f.body.gloveR - sink);
      }
    }
  }
}
function touched(f: FighterState, hand: number, other: FighterState): void {
  if (other.block) setTouchedBlock(f, hand, true);
}
/**
 * How much of a separation this glove yields: a blocking glove least, a
 * punching fist (through the hold) little, a guard hand more, and a
 * RETRACTING arm most — it is relaxed, so it slides round a guard hand it
 * meets on the way home rather than shoving it.
 */
function share(f: FighterState, hand: number, cfg: Config): number {
  if (f.block) return cfg.contactBlockShare;
  if (armActive(f, hand, cfg)) return cfg.contactPunchShare;
  const p = f.punch;
  if (p.type !== null && (p.hand === 'lead') === (hand === 0)) return 1;   // coming home: gives way
  return cfg.contactGuardShare;
}
/** Force behind this arm: a block, or a punch through its cock, extend and hold. */
function armActive(f: FighterState, hand: number, cfg: Config): boolean {
  if (f.block) return true;
  const p = f.punch;
  if (p.type === null || (p.hand === 'lead') !== (hand === 0)) return false;
  if (p.phase !== 'recover') return true;
  const ph = PUNCHES[p.type].phases(cfg);
  return p.t < ph.hold * ph.recover;
}

/**
 * Separate glove `g` from the point `p` (on `other`'s glove or forearm) to
 * `minDist`, `g` moving its share and `other`'s glove the rest, both losing
 * the velocity that closes the gap. Returns whether they were in contact.
 */
function pushApart(g: GloveState, other: GloveState, p: Vec3, minDist: number, sg: number, so: number): boolean {
  let nx = g.pos.x - p.x, ny = g.pos.y - p.y, nz = g.pos.z - p.z;
  const d = sqrt(nx * nx + ny * ny + nz * nz);
  if (d >= minDist || d < 1e-6) return false;
  nx /= d; ny /= d; nz /= d;
  const push = minDist - d, tot = sg + so;
  const mg = push * sg / tot, mo = push * so / tot;
  g.pos = { x: g.pos.x + nx * mg, y: g.pos.y + ny * mg, z: g.pos.z + nz * mg };
  other.pos = { x: other.pos.x - nx * mo, y: other.pos.y - ny * mo, z: other.pos.z - nz * mo };
  const vin = g.vel.x * nx + g.vel.y * ny + g.vel.z * nz;
  if (vin < 0) g.vel = { x: g.vel.x - vin * nx, y: g.vel.y - vin * ny, z: g.vel.z - vin * nz };
  const von = other.vel.x * nx + other.vel.y * ny + other.vel.z * nz;
  if (von > 0) other.vel = { x: other.vel.x - von * nx, y: other.vel.y - von * ny, z: other.vel.z - von * nz };
  return true;
}

export interface SimArm { shoulder: Vec3; elbow: Vec3; upperR: number; foreR: number }
/**
 * The sim's own arms (2026-09-18): shoulder joints on the twisted shoulder
 * line, elbows from the same analytic two-bone solve the rig uses with its
 * guard pole (down, a little out, a little forward). Radii from the rig's
 * config so hit geometry stays drawn geometry within a few cm — the rig's
 * pole springs and hook/uppercut poles are not reproduced, so a punching
 * arm's own elbow may sit further out than this; the OTHER fighter's guard
 * arms, which fists were passing through, match.
 */
export function simArms(f: FighterState, cfg: Config): [SimArm, SimArm] {
  const fr = frameOf(f.yaw);
  const b = f.body;
  const c = Math.cos(f.torsoTwist), s = Math.sin(f.torsoTwist);
  const upperR = b.bodyR * cfg.rigUpperArmR, foreR = b.bodyR * cfg.rigForearmR;
  const out: SimArm[] = [];
  for (let i = 0; i < 2; i++) {
    const side = handLateralSign(i === 0 ? 'lead' : 'rear', f.stance) * b.shoulderW / 2;
    // The shoulder line turns with the torso (yawPose convention: +twist turns fwd toward the fighter's left).
    const fwdOff = side * s, latOff = side * c;
    const sh: Vec3 = {
      x: f.bodyBox.b.x + fr.fwd.x * fwdOff + fr.right.x * latOff,
      y: f.bodyBox.b.y,
      z: f.bodyBox.b.z + fr.fwd.z * fwdOff + fr.right.z * latOff,
    };
    const outSign = handLateralSign(i === 0 ? 'lead' : 'rear', f.stance);
    const pole: Vec3 = {
      x: fr.fwd.x * -cfg.rigElbowPoleBack + fr.right.x * outSign * cfg.rigElbowPoleOut * 0.7,
      y: -cfg.rigElbowPoleDown,
      z: fr.fwd.z * -cfg.rigElbowPoleBack + fr.right.z * outSign * cfg.rigElbowPoleOut * 0.7,
    };
    out.push({ shoulder: sh, elbow: twoBoneMid(sh, f.gloves[i]!.pos, b.upperArm, b.forearm, pole, cfg.rigArmStretchMax), upperR, foreR });
  }
  return out as [SimArm, SimArm];
}

/** Move `g` so its centre is at least `minDist` from `p`, and drop the velocity component heading into `p`. */
function pushOut(g: GloveState, p: Vec3, minDist: number): void {
  let nx = g.pos.x - p.x, ny = g.pos.y - p.y, nz = g.pos.z - p.z;
  const d = sqrt(nx * nx + ny * ny + nz * nz);
  if (d >= minDist || d < 1e-6) return;
  nx /= d; ny /= d; nz /= d;
  const push = minDist - d;
  g.pos = { x: g.pos.x + nx * push, y: g.pos.y + ny * push, z: g.pos.z + nz * push };
  const vin = g.vel.x * nx + g.vel.y * ny + g.vel.z * nz;
  if (vin < 0) g.vel = { x: g.vel.x - vin * nx, y: g.vel.y - vin * ny, z: g.vel.z - vin * nz };
}

/** Park both gloves exactly on their targets (createState). */
export function settleGloves(f: FighterState, other: FighterState, side: Side, time: number, cfg: Config): void {
  stepGloves(f, other, side, time, cfg, 0);
  for (const g of f.gloves) {
    g.pos = { ...g.target };
    g.vel = { x: 0, y: 0, z: 0 };
  }
}

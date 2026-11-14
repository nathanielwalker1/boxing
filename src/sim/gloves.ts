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
import { GUARDS, TAU, closestOnSegment, closestSegSeg, frameOf, handLateralSign, lerp, localToWorld, sin, sqrt, worldToLocal } from '../core';
import { clinchAmount } from './clinch';
import { PUNCHES, blockLocal, guardLocal, punchEnvelope, punchLocal, whiffPhases, type LocalPose } from './punches';
import { slipBack, slipLateral } from './slip';
import { reachNerf, setTargetCut, setTouchedBlock } from './state';
import { stepArms } from './arms';
import { hurtLevel } from './stun';
import { VARIANTS } from './variants';
import { hurtMods, stanceDrop } from './footing';
import { hitBody } from './reaction';
import { aimPoint, keyedOn, simKeyedPose } from './skel';
import { fk, keyedHandTarget, skelDef, SKJ } from '../core';

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
function targetLocal(f: FighterState, hand: Hand, cfg: Config, other: FighterState): { pose: LocalPose; kMul: number; contact: Vec3 | null; guard: boolean } {
  const p = f.punch;
  const shape = cfg.stylesOn ? f.guardShape : 'high';   // the fighter's guard (phase 2, core/styles.ts)
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
      const pose = punchLocal(f.body, f.stance, def, hand, p.progress * ph.total, ph, cfg, f.torsoTwist, VARIANTS[p.variant], p.aim, shape, (p.type === 'jab' ? GUARDS[shape].jabReach : 1) * (1 - cfg.hitNerfReach * reachNerf(f)));   // (a nerfed punch — thrown while being hit — falls short: polish phase)
      // Aim (overhaul): punch paths are authored at the thrower's own height. The lane is lifted (or lowered) by
      // punchAimTrack of the difference to the OPPONENT's standing height — head lane to head, body lane to body —
      // riding the punch's own envelope, so the guard is untouched and the fist arrives on his lane, not mine.
      // His standing height, never where his head is now: a duck or a slip still takes it away.
      if (cfg.punchAimTrack > 0) {
        const v = VARIANTS[p.variant];
        // (Standing as he STANDS: the crouch of his guard — the peek-a-boo sits 4 cm down — is part of his height, and of mine.)
        const sit = GUARDS[shape].crouch - GUARDS[cfg.stylesOn ? other.guardShape : 'high'].crouch;
        const raw = sit + (v.body
          ? (other.body.shoulderY + other.body.hipY - f.body.shoulderY - f.body.hipY) / 2
          : other.body.headY - f.body.headY - cfg.punchAimChin);   // the chin, not the middle of the head
        // Inside the dead band the difference is the matchup (a slightly taller man's chin sits higher on your fist).
        const dy = Math.sign(raw) * Math.max(0, Math.abs(raw) - cfg.punchAimDeadband);
        pose.up += dy * cfg.punchAimTrack * punchEnvelope(p.progress * ph.total, ph);
      }
      return { pose, kMul, contact, guard: false };
    }
  }
  // clinchV2: tied up, the hands go to the other man — the lead hand under his arm to his flank, the rear hand over his arm onto
  // the back of his shoulder — blended in and out with the tie-up. They stop ON him (solid bodies), so nothing goes through.
  const tie = cfg.clinchV2 ? clinchAmount(f, cfg) : 0;
  if (tie > 0) {
    const g0 = guardLocal(f.body, hand, f.stance, shape), c = clinchLocal(f, hand, cfg, other);
    return { pose: { fwd: lerp(g0.fwd, c.fwd, tie), up: lerp(g0.up, c.up, tie), lat: lerp(g0.lat, c.lat, tie) }, kMul: 1, contact: null, guard: false };
  }
  if (f.block) return { pose: blockLocal(f.body, hand, f.stance, shape), kMul: 1, contact: null, guard: true };
  const g = guardLocal(f.body, hand, f.stance, shape);
  // Rocked: the resting guard sags by stunGuardDrop × how rocked (sim/stun.ts) — the chin is open.
  // Overhaul: it also hangs by guardDroop (fatigue, body wear, winded) and, through a guard break, is knocked down and apart.
  const broken = f.guardBroken > 0 ? cfg.guardBreakDrop : 0;
  const sag = guardSag(f, cfg);
  return { pose: sag > 0 ? { fwd: g.fwd, up: g.up - sag, lat: g.lat + Math.sign(g.lat) * broken * 0.5 } : g, kMul: 1, contact: null, guard: true };
}

/** How far the resting guard hangs: rocked, droop (fatigue, wear, winded), a broken guard. */
function guardSag(f: FighterState, cfg: Config): number {
  const broken = f.guardBroken > 0 ? cfg.guardBreakDrop : 0;
  return (f.hurt > 0 && f.hurtKind !== 'body' ? cfg.stunGuardDrop * hurtLevel(f) * hurtMods(f, cfg).guard : 0) + f.guardDroop + broken;   // (× the kind of rocked: reaching = further, covering up = not at all — polish phase)
}

/**
 * clinchV2: where a hand goes in the tie-up, in the fighter's local frame. The side of the other man it is on is the
 * side this hand's shoulder is on. LEAD hand = the underhook: his flank at clinchUnderAt of the way up his torso, a
 * glove clear of his ribs and clinchWrap behind his axis. REAR hand = the overhook: over his arm onto the back of that
 * shoulder. (Both orthodox, my rear hand and his lead hand are on the same side: one over, one under.) stepGloves adds
 * the lean's shift and the stance drop to every target; they are taken off here so the hand goes to the POINT.
 */
function clinchLocal(f: FighterState, hand: Hand, cfg: Config, other: FighterState): LocalPose {
  const i = hand === 'lead' ? 0 : 1;
  const ofr = frameOf(other.yaw), hb = other.bodyBox;
  const my = f.arms[i]!.shoulder;
  const side = (my.x - hb.b.x) * ofr.right.x + (my.z - hb.b.z) * ofr.right.z >= 0 ? 1 : -1;
  const out = other.body.bodyR + f.body.gloveR + cfg.clinchHandClear;
  let x: number, y: number, z: number;
  if (hand === 'lead') {
    const u = cfg.clinchUnderAt;
    x = lerp(hb.a.x, hb.b.x, u) + ofr.right.x * side * out - ofr.fwd.x * cfg.clinchWrap;
    y = lerp(hb.a.y, hb.b.y, u);
    z = lerp(hb.a.z, hb.b.z, u) + ofr.right.z * side * out - ofr.fwd.z * cfg.clinchWrap;
  } else {
    const j = handLateralSign('lead', other.stance) === side ? 0 : 1;
    const sh = other.arms[j]!.shoulder;
    const axis = Math.max(0, out - other.body.shoulderW / 2);   // far enough out that the hand is clear of his chest
    x = sh.x + ofr.right.x * side * axis - ofr.fwd.x * cfg.clinchOverBack;
    y = sh.y - cfg.clinchOverDrop;
    z = sh.z + ofr.right.z * side * axis - ofr.fwd.z * cfg.clinchOverBack;
  }
  const l = worldToLocal(f.pos, frameOf(f.yaw), { x, y, z });
  return { fwd: l.forward - f.lean.fwd * cfg.punchLeanShift, up: l.up + stanceDrop(f, cfg), lat: l.lateral };
}

/** Is the glove-centre point `p` inside `other`'s head, body or upper arms (the solid parts), inflated by the glove less its give? */
function insideOther(p: Vec3, other: FighterState, gloveR: number, sink: number, hb: FighterState['bodyBox']): boolean {
  const rh = other.headBox.r + gloveR - sink;
  const dx = p.x - other.headBox.x, dy = p.y - other.headBox.y, dz = p.z - other.headBox.z;
  if (dx * dx + dy * dy + dz * dz < rh * rh) return true;
  const c = closestOnSegment(hb.a, hb.b, p);
  const rb = hb.r + gloveR - sink;
  const ex = p.x - c.x, ey = p.y - c.y, ez = p.z - c.z;
  return ex * ex + ey * ey + ez * ez < rb * rb;
  // Not the arms: cutting targets against the upper arms stopped a
  // close-range jab from ever reaching the chin (measured 2026-09-19).
  // Arms are resolved by the position contacts alone.
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
function cutTarget(from: Vec3, t: Vec3, fwd: { x: number; z: number }, other: FighterState, gloveR: number, sink: number, hb: FighterState['bodyBox'], endpointOnly = false): Vec3 {
  // "Blocked": the target is inside the other fighter, or the path from the
  // fist to it passes through them (a jab's spring covers 30 cm a tick, and
  // a target BEHIND the head is outside it — the fist tunnelled). The path
  // test allows TUNNEL_TOL deeper than the endpoint, so a fist sliding along
  // a curved surface (its chord dips a few mm) is not held back.
  // (Phase 1.4: a KEYED punching hand's path is authored, not a spring's — only its endpoint is cut; cut on the path
  // from a fist out to the side, a cross stopped 13 cm short of the face with the elbow still bent 110°: measured.)
  const blocked = (p: Vec3): boolean => {
    if (insideOther(p, other, gloveR, sink, hb)) return true;
    if (endpointOnly) return false;
    for (let i = 1; i < CONTACT_SAMPLES; i++) {
      const u = i / CONTACT_SAMPLES;
      if (insideOther({ x: from.x + (p.x - from.x) * u, y: from.y + (p.y - from.y) * u, z: from.z + (p.z - from.z) * u }, other, gloveR, sink + TUNNEL_TOL, hb)) return true;
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
  // Phase 1.4, punch keys: the hands go to the KEYED spots — the chest-frame spot on the fitted skeleton (so they ride
  // the body through a slip, a dip, a hit), blended toward the aim point by the key. The clinch keeps its own.
  const keyed = keyedOn(cfg) && !!f.skel && !(cfg.clinchV2 && clinchAmount(f, cfg) > 0);
  const rp = keyed ? simKeyedPose(f, cfg) : null;
  const kf = keyed ? fk(skelDef(f.body, f.stance, cfg), f.skel!) : null;
  for (let i = 0; i < 2; i++) {
    const hand = HANDS[i]!;
    const tl = targetLocal(f, hand, cfg, other);
    const { pose, contact, guard } = tl;
    // Keyed: the punching hand keeps the punch's stiffness home too — the KEY times the retraction (no slower than the
    // drive); the legacy soft recovery spring floated it back over twice that. Exposure reads the punch clock, not the glove.
    const kMul = keyed && f.punch.type !== null && f.punch.hand === hand ? cfg.chainPunchK : tl.kMul;
    let t: Vec3;
    {
    const bob = sin(time * TAU * cfg.chainBobHz + BOB_PHASE_HAND[i]! + BOB_PHASE_SIDE[side]!) * cfg.chainBobAmp;
    // The hands ride the body down through a crouch (guard and punch alike).
    // The guard also rides the shoulders sideways through a slip; a punching
    // hand does not — it aims from the fighter's frame, so a slip-and-hook
    // still lands where the hook was thrown.
    const lat = pose.lat + (guard ? slipLateral(f) * cfg.slipShoulderFrac : 0);
    // …and forward with the weight transfer (the shoulders move; computeBoxes
    // moves the body by the same shift), back with a pull.
    const fwd = pose.fwd + f.lean.fwd * cfg.punchLeanShift - (guard ? slipBack(f) * cfg.slipShoulderFrac : 0);
    t = contact ? { x: contact.x, y: contact.y, z: contact.z } : localToWorld(f.pos, fr, fwd, pose.up + bob - stanceDrop(f, cfg), lat);
    // The gloves ride the torso's reaction offset, so they travel with the body.
    if (!contact) { t.x += f.reaction.torso.x; t.y += f.reaction.torso.y; t.z += f.reaction.torso.z; }
    }
    // Punch keys: the PUNCHING hand goes where its key puts it; the guard hands keep the legacy targets (each style's
    // guard spot is gameplay — exposure, what a glove covers — and styles_test pins it). The keyed target is held no
    // further from the shoulder than the legacy target, nor past poseReachMax of the arm: reach is gameplay too (the
    // keys aimed at the head landed punches the legacy whiffs — punch_test), and an out-of-reach glove settled by the
    // contacts was pulled back by the arm fit into the other man's forearm (measured).
    if (rp && kf && !(f.punch.type !== null && f.punch.hand === hand)) {
      // (The guard hands keyed too, held at the face against the punch's turn: with the legacy spots instead the rear
      // glove drifted 9 cm through the jab and the lead forearm folded onto its stop through the cross — measured.
      // That moves the style guard spots: styles_test passes only with the keys off; LOG_PUNCHES.md.)
      const counter = f.punch.type !== null ? (rp.pelYaw + rp.spTwist - rp.yawRef) * cfg.poseOffhandHold : 0;
      t = keyedHandTarget(kf, rp.hand[i]!, handLateralSign(hand, f.stance), null, fr.fwd, counter);
      if (guard) t.y -= guardSag(f, cfg);
    } else if (rp && kf) {
      const legacy = t;
      t = keyedHandTarget(kf, rp.hand[i]!, handLateralSign(hand, f.stance), aimPoint(f, other, cfg), fr.fwd, 0);
      const sh = kf.p[i === 0 ? SKJ.upper0 : SKJ.upper1]!;
      const arm = f.body.upperArm + f.body.forearm;
      // (Floored at poseReachMin of the arm: held closer, the forearm folded onto its stop — measured.)
      const reach = Math.max(arm * cfg.poseReachMin, Math.min(arm * cfg.poseReachMax, Math.hypot(legacy.x - sh.x, legacy.y - sh.y, legacy.z - sh.z)));
      const dx = t.x - sh.x, dy = t.y - sh.y, dz = t.z - sh.z, dl = Math.hypot(dx, dy, dz);
      if (dl > reach) { const s = reach / dl; t = { x: sh.x + dx * s, y: sh.y + dy * s, z: sh.z + dz * s }; }
    }
    const g = f.gloves[i]!;
    const free = t;
    if (solid) t = cutTarget(g.pos, t, fr.fwd, other, f.body.gloveR, sink, hitBody(other, cfg), keyed && f.punch.type !== null && f.punch.hand === hand);
    // Remember whether the other fighter's head or body clipped this target:
    // the hit test reads it (a fist stopped on a pinned guard hand is only
    // "absorbed" if the punch was going to arrive).
    setTargetCut(f, i, t !== free);
    g.target = t;

    let k = cfg.chainK * (i === 1 ? cfg.chainRearK : 1);
    let c = cfg.chainC * (i === 1 ? cfg.chainRearC : 1);
    if (kMul !== 1) { k *= kMul; c *= sqrt(kMul); }
    // Phase 1.4: the keyed PUNCHING glove is kinematic — it is where its key puts it this tick (a spring chasing a hand
    // that is fastest at arrival lagged it 13–18 cm short of the face on the hit tick: measured). The contacts below
    // still stop it on a body and push it off a guard.
    const kin = keyed && f.punch.type !== null && f.punch.hand === hand;
    springs(f)[i] = { k, c, kin, sx: g.pos.x, sy: g.pos.y, sz: g.pos.z };
  }
  void dt;
}

/** Per-fighter spring constants for this tick, set by stepGloves and read by integrateGloves. Scratch, not state. */
interface GloveDrive { k: number; c: number; kin: boolean; sx: number; sy: number; sz: number }
const SPRINGS = new WeakMap<FighterState, [GloveDrive, GloveDrive]>();
function springs(f: FighterState): [GloveDrive, GloveDrive] {
  let s = SPRINGS.get(f);
  if (!s) { s = [{ k: 0, c: 0, kin: false, sx: 0, sy: 0, sz: 0 }, { k: 0, c: 0, kin: false, sx: 0, sy: 0, sz: 0 }]; SPRINGS.set(f, s); }
  return s;
}

/**
 * Advance both fighters' glove springs by dt in sub-steps, resolving the
 * contacts (head, body, arms, gloves) INSIDE each sub-step (2026-09-19): a
 * stiff spring — the jab snaps home at 5× — re-drove a fist 10 cm into an
 * incoming forearm every tick when the contacts ran once after the step.
 * The arms are re-placed from the moved gloves before each contact pass.
 */
export function integrateGloves(a: FighterState, b: FighterState, cfg: Config, dt: number): void {
  const h = dt / CHAIN_SUBSTEPS;
  resetContactFlags(a, b);
  for (let n = 0; n < CHAIN_SUBSTEPS; n++) {
    for (const f of [a, b]) {
      const sp = springs(f);
      for (let i = 0; i < 2; i++) {
        const g = f.gloves[i]!, t = g.target, { k, c, kin, sx, sy, sz } = sp[i]!;
        if (kin) {
          // Along the line from where it started the tick to its key target, a sub-step at a time.
          const u = (n + 1) / CHAIN_SUBSTEPS;
          const nx = sx + (t.x - sx) * u, ny = sy + (t.y - sy) * u, nz = sz + (t.z - sz) * u;
          g.vel.x = (nx - g.pos.x) / h; g.vel.y = (ny - g.pos.y) / h; g.vel.z = (nz - g.pos.z) / h;
          g.pos.x = nx; g.pos.y = ny; g.pos.z = nz;
          continue;
        }
        g.vel.x += (k * (t.x - g.pos.x) - c * g.vel.x) * h;
        g.vel.y += (k * (t.y - g.pos.y) - c * g.vel.y) * h;
        g.vel.z += (k * (t.z - g.pos.z) - c * g.vel.z) * h;
        g.pos.x += g.vel.x * h; g.pos.y += g.vel.y * h; g.pos.z += g.vel.z * h;
      }
    }
    if (cfg.contactSolid > 0) {
      stepArms(a, cfg, 0); stepArms(b, cfg, 0);
      clampGloves(a, b, cfg); clampGloves(b, a, cfg);
      resolveGloveContacts(a, b, cfg);
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
  const upperR = other.body.bodyR * cfg.rigUpperArmR;
  const hb = hitBody(other, cfg);
  for (const g of f.gloves) {
    // Head and body overlap at the chin, so a push out of one can land in
    // the other; a few passes settle it (measured: one pass left 4–5 cm).
    for (let pass = 0; pass < CLAMP_PASSES; pass++) {
      pushOut(g, other.headBox, other.headBox.r + f.body.gloveR - sink);
      const c = closestOnSegment(hb.a, hb.b, g.pos);
      pushOut(g, c, hb.r + f.body.gloveR - sink);
      // The upper arms hang off the shoulders: solid, like the body.
      for (const arm of other.arms) pushOut(g, closestOnSegment(arm.shoulder, arm.elbow, g.pos), upperR + f.body.gloveR - sink);
    }
  }
}
/** Constraint passes per contact call — integration detail, not a tunable. Called once per spring sub-step (CHAIN_SUBSTEPS), so 2 passes × 4 sub-steps a tick. */
const CLAMP_PASSES = 2;

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
/** One contact pass with no spring step — after a land's impact pose moved a body under the gloves. Keeps the tick's guard-touch flags. */
export function settleContacts(a: FighterState, b: FighterState, cfg: Config): void {
  if (cfg.contactSolid <= 0) return;
  clampGloves(a, b, cfg); clampGloves(b, a, cfg);
  resolveGloveContacts(a, b, cfg);
}

/** Clear the per-tick contact flags (guard touches accumulate over the sub-steps). */
function resetContactFlags(a: FighterState, b: FighterState): void {
  for (const f of [a, b]) { setTouchedBlock(f, 0, false); setTouchedBlock(f, 1, false); pinned.set(f, [false, false]); }
}
export function resolveGloveContacts(a: FighterState, b: FighterState, cfg: Config): void {
  if (cfg.contactSolid <= 0) return;
  const foreA = a.body.bodyR * cfg.rigForearmR, foreB = b.body.bodyR * cfg.rigForearmR;
  const upA = a.body.bodyR * cfg.rigUpperArmR, upB = b.body.bodyR * cfg.rigUpperArmR;
  for (let pass = 0; pass < CLAMP_PASSES; pass++) {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const ga = a.gloves[i]!, gb = b.gloves[j]!;
      const armA = a.arms[i]!, armB = b.arms[j]!;
      const sink = Math.min(a.body.gloveR, b.body.gloveR) * cfg.contactSquash;
      const sa = share(a, i, cfg), sb = share(b, j, cfg);
      // Glove vs glove.
      if (pushApart(ga, gb, gb.pos, a.body.gloveR + b.body.gloveR - sink, sa, sb)) { touched(a, i, b, j); touched(b, j, a, i); }
      // A glove vs the other's forearm (dragged by the glove at its end).
      const cb = closestOnSegment(armB.elbow, gb.pos, ga.pos);
      if (pushApartAt(ga, gb, ga.pos, cb, foreB + a.body.gloveR - sink, sa, sb, null, armB.elbow)) touched(a, i, b, j);
      const ca = closestOnSegment(armA.elbow, ga.pos, gb.pos);
      if (pushApartAt(gb, ga, gb.pos, ca, foreA + b.body.gloveR - sink, sb, sa, null, armA.elbow)) touched(b, j, a, i);
      // Forearm vs forearm (arms crossing in an exchange): the closest
      // points on the two bones, separated by the shares, each forearm moved
      // by moving the glove at its end (the elbow follows next solve).
      const ff = closestSegSeg(armA.elbow, ga.pos, armB.elbow, gb.pos);
      if (pushApartAt(ga, gb, ff.p, ff.q, foreA + foreB - sink * 0.5, sa, sb, armA.elbow, armB.elbow)) { touched(a, i, b, j); touched(b, j, a, i); }
      // Not forearm vs the other's UPPER arm: a cross to the chin runs along
      // the lead shoulder, and any deflection there, iterated, threw it off
      // the head (measured 2026-09-19: the cross at 0.5 m whiffed). Gloves
      // are kept out of upper arms (clampGloves); a forearm sliding a few cm
      // into a deltoid is the give of the shoulder.
    }
    // A hand never enters its own head or body (a shoved guard glove stops at the face).
    for (const f of [a, b]) {
      const sink = f.body.gloveR * cfg.contactSquash;
      const pin = pinned.get(f) ?? [false, false];
      for (let i = 0; i < 2; i++) {
        const g = f.gloves[i]!;
        const h = pushOut(g, f.headBox, f.headBox.r + f.body.gloveR - sink);
        const bd = pushOut(g, closestOnSegment(f.bodyBox.a, f.bodyBox.b, g.pos), f.bodyBox.r + f.body.gloveR - sink);
        pin[i] = h || bd;
      }
      pinned.set(f, pin);
    }
  }
}
/**
 * This glove met the other fighter's glove `oh` or its forearm this tick,
 * and that guard could not give way: it is a held block, or the guard hand
 * is pinned against its own head or body (a fist on the gloves on the
 * face). The hit test reads it: a fist stopped there is blocked, not a
 * miss. A guard hand that is knocked freely aside sets nothing — the
 * punch goes on to land (or, slipped, to miss).
 */
function touched(f: FighterState, hand: number, other: FighterState, oh: number): void {
  // Any guard contact counts; the hit test pairs it with the target cut
  // (the punch was going to arrive) so a knocked-aside hand that let the
  // punch through and a slipped head (no cut) are untouched by it.
  void oh;
  setTouchedBlock(f, hand, true);
}
/** Per resolve: which of a fighter's gloves the own-body clamp had to push this pass — a guard hand with nowhere left to go. (The resting guard already touches the big head, so "near the head" is no test.) */
const pinned = new WeakMap<FighterState, [boolean, boolean]>();
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
  // In contact (for the guard-touch flag) a little before a push is needed:
  // a fist resting inside the give on a pinned guard hand is touching it.
  if (d >= minDist || d < 1e-6) return d < minDist + CONTACT_MARGIN;
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

/**
 * Separate two bones touching at their closest points `pa` (on the bone
 * ending at glove `g`) and `pb` (on the bone ending at `other`): the
 * gap between the points is opened to `minDist`, each glove moved by its
 * share along the normal. Returns whether they were in contact.
 */
function pushApartAt(g: GloveState, other: GloveState, pa: Vec3, pb: Vec3, minDist: number, sg: number, so: number, ea: Vec3 | null = null, eb: Vec3 | null = null, resist = 0): boolean {
  let nx = pa.x - pb.x, ny = pa.y - pb.y, nz = pa.z - pb.z;
  const d = sqrt(nx * nx + ny * ny + nz * nz);
  if (d >= minDist || d < 1e-6) return d < minDist + CONTACT_MARGIN;
  nx /= d; ny /= d; nz /= d;
  // `resist`: a share for something that cannot move (an upper arm), so the
  // mover takes only sg / (sg + resist) of the separation per pass.
  const push = minDist - d, tot = Math.max(1e-6, sg + so + resist);
  // The lever: moving the glove moves a point a fraction `t` along the
  // elbow→glove bone by only t of that, so the glove moves push / t
  // (floored — a contact right at the elbow cannot be fixed from the hand).
  const lever = (e: Vec3 | null, p: Vec3, gl: Vec3): number => {
    if (!e) return 1;
    const bl = v3distSq(e, gl); if (bl < 1e-8) return 1;
    const t = ((p.x - e.x) * (gl.x - e.x) + (p.y - e.y) * (gl.y - e.y) + (p.z - e.z) * (gl.z - e.z)) / bl;
    return Math.min(LEVER_MAX, 1 / Math.max(LEVER_MIN, Math.min(1, t)));
  };
  const mg = push * sg / tot * lever(ea, pa, g.pos), mo = push * so / tot * lever(eb, pb, other.pos);
  g.pos = { x: g.pos.x + nx * mg, y: g.pos.y + ny * mg, z: g.pos.z + nz * mg };
  other.pos = { x: other.pos.x - nx * mo, y: other.pos.y - ny * mo, z: other.pos.z - nz * mo };
  const vin = g.vel.x * nx + g.vel.y * ny + g.vel.z * nz;
  if (vin < 0 && sg > 0) g.vel = { x: g.vel.x - vin * nx, y: g.vel.y - vin * ny, z: g.vel.z - vin * nz };
  const von = other.vel.x * nx + other.vel.y * ny + other.vel.z * nz;
  if (von > 0 && so > 0) other.vel = { x: other.vel.x - von * nx, y: other.vel.y - von * ny, z: other.vel.z - von * nz };
  return true;
}

/** Gloves/forearms this close beyond their resting separation still count as touching (the guard-touch flag), m. */
const CONTACT_MARGIN = 0.015;
/** Smallest bone fraction a forearm contact is levered from — below this the hand cannot fix it, so it is treated as here. */
const LEVER_MIN = 0.35;
/** Cap on the lever gain: ×2.9 threw a cross off the chin when its forearm brushed an upper arm near the elbow (2026-09-19). */
const LEVER_MAX = 1.5;
const v3distSq = (a: Vec3, b: Vec3): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

/** Move `g` so its centre is at least `minDist` from `p`, and drop the velocity component heading into `p`. Returns whether it had to. */
function pushOut(g: GloveState, p: Vec3, minDist: number): boolean {
  let nx = g.pos.x - p.x, ny = g.pos.y - p.y, nz = g.pos.z - p.z;
  const d = sqrt(nx * nx + ny * ny + nz * nz);
  if (d >= minDist || d < 1e-6) return false;
  nx /= d; ny /= d; nz /= d;
  const push = minDist - d;
  g.pos = { x: g.pos.x + nx * push, y: g.pos.y + ny * push, z: g.pos.z + nz * push };
  const vin = g.vel.x * nx + g.vel.y * ny + g.vel.z * nz;
  if (vin < 0) g.vel = { x: g.vel.x - vin * nx, y: g.vel.y - vin * ny, z: g.vel.z - vin * nz };
  return true;
}

/** Park both gloves exactly on their targets (createState). */
export function settleGloves(f: FighterState, other: FighterState, side: Side, time: number, cfg: Config): void {
  stepGloves(f, other, side, time, cfg, 0);
  for (const g of f.gloves) {
    g.pos = { ...g.target };
    g.vel = { x: 0, y: 0, z: 0 };
  }
}

/**
 * sim/state.ts — cloning and the sim-private scratch fields.
 *
 * `step` must not mutate its input (CONTRACT §4), so every tick starts by
 * cloning the parts it will write: both fighters (deep), the round, the rng.
 * Config and body dims are never written and are shared structurally.
 *
 * `FighterState.moveHist` is documented in core/types as opaque outside the
 * sim, so it doubles as the sim's scratch area until core grows the fields
 * (requested in the Stage-1 report):
 *   moveHist[0]  previous tick's punch-flag bitmask (edge-triggering)
 *   moveHist[1]  reaction stiffness multiplier of the last punch that landed
 *   moveHist[2]  buffered punch (one mask bit, 0 = none) — pressed while a punch was in flight
 *   moveHist[3]  seconds the buffered press is still honoured
 *   moveHist[4]  move.x at the buffered press (hook/uppercut hand)
 *   moveHist[5]  cock-phase time multiplier of the punch in flight (>1 = thrown gassed)
 *   moveHist[6]  seconds of stamina-regen pause left after a hit
 *   moveHist[7]  seconds the stick has been pushed past slipInputThreshold (0 = not pushed)
 *   moveHist[8]  slip direction captured when that push began (-1 lead / +1 rear / 0 = not a lateral push)
 *   moveHist[9]  1 once the push outlived slipFlickMax — it is footwork now, not a flick
 *   moveHist[10] the punish spike's level: vulnerability floor while counterWindow > 0
 *   moveHist[11] recover-phase time multiplier of the punch in flight (>1 = it missed)
 *   moveHist[12] seconds on the canvas at which this fighter gets up (rolled at the knockdown; -1 = never, a KO)
 *   moveHist[13] health cap: the ceiling health regenerates toward (1 at the bell; every hit lowers it)
 *   moveHist[14] seconds of health-regen pause left after a hit
 *   moveHist[15] second buffered punch (queued behind [2]; 0 = none)
 *   moveHist[16] move.x at that second press
 *   moveHist[17] lead glove met the other fighter's blocking glove/forearm this tick (1) — the hit test reads it
 *   moveHist[18] the same for the rear glove
 *   moveHist[19..21] lead arm's elbow pole lags: level, back, flare (sim/arms.ts)
 *   moveHist[22..24] the same for the rear arm
 *   moveHist[25] lead glove's target was clipped by the other's head/body this tick (the punch was going to arrive)
 *   moveHist[26] the same for the rear glove
 *   moveHist[27] 1 while the punch in flight is STUFFED: it was hit mid-flight and is rewinding home (combat.ts)
 *   moveHist[28] impulse multiplier of the punch in flight (<1 = it was hit late in its flight and lands weakened)
 *   moveHist[29] 1 if the punch in flight was CHAINED off another (its wind-up blends from that punch's body pose)
 *   moveHist[30..33] the body pose carried into the chain: torso twist, lean.fwd, lean.lat, crouch at the chained start
 *   moveHist[34] what opened the punish window: 0 none, 1 a SLIP (the only source that makes a landing a COUNTER), 2 a perfect block
 */
import type { FighterState, FrameInput, GloveState, Hand, PunchState, ReactionState, SimState, SlipState, Spring1, Spring3, Vec3 } from '../core';
import { rngClone } from '../core';

const HIST_PREV_MASK = 0;
const HIST_SNAP = 1;
const HIST_BUF_MASK = 2;
const HIST_BUF_T = 3;
const HIST_BUF_X = 4;
const HIST_COCK_MULT = 5;
const HIST_REGEN_DELAY = 6;
const HIST_PUSH_T = 7;
const HIST_PUSH_DIR = 8;
const HIST_PUSH_HOLD = 9;
const HIST_PUNISH_LEVEL = 10;
const HIST_WHIFF_MULT = 11;
const HIST_GET_UP_AT = 12;
const HIST_HEALTH_CAP = 13;
const HIST_HEALTH_DELAY = 14;
const HIST_BUF2_MASK = 15;
const HIST_BUF2_X = 16;
const HIST_TOUCH_BLOCK = 17;   // +hand (0 lead, 1 rear): 1 if that glove met the other's BLOCKING glove/forearm this tick

export function touchedBlock(f: FighterState, hand: number): boolean { return (f.moveHist[HIST_TOUCH_BLOCK + hand] ?? 0) !== 0; }
export function setTouchedBlock(f: FighterState, hand: number, on: boolean): void { f.moveHist[HIST_TOUCH_BLOCK + hand] = on ? 1 : 0; }

const HIST_TARGET_CUT = 25;   // + hand: 1 if the other's head/body clipped this glove's target this tick (the punch was going to arrive)
export function targetCut(f: FighterState, hand: number): boolean { return (f.moveHist[HIST_TARGET_CUT + hand] ?? 0) !== 0; }
export function setTargetCut(f: FighterState, hand: number, on: boolean): void { f.moveHist[HIST_TARGET_CUT + hand] = on ? 1 : 0; }

const HIST_STUFFED = 27;      // 1 while the punch in flight is rewinding after a hit broke it
const HIST_BROKEN_MULT = 28;  // impulse multiplier of the punch in flight (a hit late in the flight bleeds it)
export function stuffed(f: FighterState): boolean { return (f.moveHist[HIST_STUFFED] ?? 0) !== 0; }
export function setStuffed(f: FighterState, on: boolean): void { f.moveHist[HIST_STUFFED] = on ? 1 : 0; }
export function brokenMult(f: FighterState): number { const v = f.moveHist[HIST_BROKEN_MULT]; return v === undefined ? 1 : v; }
export function setBrokenMult(f: FighterState, m: number): void { f.moveHist[HIST_BROKEN_MULT] = m; }

const HIST_CHAINED = 29;      // 1 if the punch in flight was chained off another
const HIST_CARRY = 30;        // + 0..3: twist, lean.fwd, lean.lat, crouch carried into the chain
/** The body pose the previous punch left behind at a chained start (combat.ts blends the new wind-up out of it). */
export interface ChainCarry { on: boolean; twist: number; fwd: number; lat: number; crouch: number }
export function chainCarry(f: FighterState): ChainCarry {
  return { on: (f.moveHist[HIST_CHAINED] ?? 0) !== 0, twist: f.moveHist[HIST_CARRY] ?? 0, fwd: f.moveHist[HIST_CARRY + 1] ?? 0, lat: f.moveHist[HIST_CARRY + 2] ?? 0, crouch: f.moveHist[HIST_CARRY + 3] ?? 0 };
}
export function setChainCarry(f: FighterState, c: ChainCarry): void {
  f.moveHist[HIST_CHAINED] = c.on ? 1 : 0;
  f.moveHist[HIST_CARRY] = c.twist; f.moveHist[HIST_CARRY + 1] = c.fwd; f.moveHist[HIST_CARRY + 2] = c.lat; f.moveHist[HIST_CARRY + 3] = c.crouch;
}

const HIST_ARM_POSE = 19;   // + hand × 3: level, back, flare (the elbow pole lags, sim/arms.ts)
export function armPose(f: FighterState, hand: number): { level: number; back: number; flare: number } {
  const b = HIST_ARM_POSE + hand * 3;
  return { level: f.moveHist[b] ?? 0, back: f.moveHist[b + 1] ?? 0, flare: f.moveHist[b + 2] ?? 0 };
}
export function setArmPose(f: FighterState, hand: number, p: { level: number; back: number; flare: number }): void {
  const b = HIST_ARM_POSE + hand * 3;
  f.moveHist[b] = p.level; f.moveHist[b + 1] = p.back; f.moveHist[b + 2] = p.flare;
}

export const MASK_JAB = 1, MASK_CROSS = 2, MASK_HOOK = 4, MASK_UPPERCUT = 8;

export function punchMask(i: Readonly<FrameInput>): number {
  return (i.jab ? MASK_JAB : 0) | (i.cross ? MASK_CROSS : 0) | (i.hook ? MASK_HOOK : 0) | (i.uppercut ? MASK_UPPERCUT : 0);
}
export function prevPunchMask(f: FighterState): number { return f.moveHist[HIST_PREV_MASK] ?? 0; }
export function setPrevPunchMask(f: FighterState, m: number): void { f.moveHist[HIST_PREV_MASK] = m; }
export function reactionSnap(f: FighterState): number { return f.moveHist[HIST_SNAP] ?? 1; }
export function setReactionSnap(f: FighterState, s: number): void { f.moveHist[HIST_SNAP] = s; }

/** The queue of buffered presses, oldest first (`mask` fires next; `mask2` behind it, 0 = empty); `t` is the head's remaining life. */
export interface PunchBuffer { mask: number; t: number; x: number; mask2: number; x2: number }
export function punchBuffer(f: FighterState): PunchBuffer {
  return { mask: f.moveHist[HIST_BUF_MASK] ?? 0, t: f.moveHist[HIST_BUF_T] ?? 0, x: f.moveHist[HIST_BUF_X] ?? 0, mask2: f.moveHist[HIST_BUF2_MASK] ?? 0, x2: f.moveHist[HIST_BUF2_X] ?? 0 };
}
export function setPunchBuffer(f: FighterState, b: PunchBuffer): void {
  f.moveHist[HIST_BUF_MASK] = b.mask; f.moveHist[HIST_BUF_T] = b.t; f.moveHist[HIST_BUF_X] = b.x;
  f.moveHist[HIST_BUF2_MASK] = b.mask2; f.moveHist[HIST_BUF2_X] = b.x2;
}
export const EMPTY_BUFFER: Readonly<PunchBuffer> = { mask: 0, t: 0, x: 0, mask2: 0, x2: 0 };

export function cockMult(f: FighterState): number { return f.moveHist[HIST_COCK_MULT] || 1; }
export function setCockMult(f: FighterState, m: number): void { f.moveHist[HIST_COCK_MULT] = m; }
export function regenDelay(f: FighterState): number { return f.moveHist[HIST_REGEN_DELAY] ?? 0; }
export function setRegenDelay(f: FighterState, t: number): void { f.moveHist[HIST_REGEN_DELAY] = t; }

/** The flick-vs-hold detector's memory of the current stick push (slip.ts). */
export interface PushState { t: number; dir: -1 | 0 | 1 | 2 | 3; hold: boolean }   // 3 = forward (overhaul: the push-off and the forward burst read it)
export function pushState(f: FighterState): PushState {
  const d = f.moveHist[HIST_PUSH_DIR] ?? 0;
  return { t: f.moveHist[HIST_PUSH_T] ?? 0, dir: d === 3 ? 3 : d === 2 ? 2 : d < 0 ? -1 : d > 0 ? 1 : 0, hold: (f.moveHist[HIST_PUSH_HOLD] ?? 0) !== 0 };
}
export function setPushState(f: FighterState, p: PushState): void {
  f.moveHist[HIST_PUSH_T] = p.t; f.moveHist[HIST_PUSH_DIR] = p.dir; f.moveHist[HIST_PUSH_HOLD] = p.hold ? 1 : 0;
}

export function punishLevel(f: FighterState): number { return f.moveHist[HIST_PUNISH_LEVEL] ?? 0; }
export function setPunishLevel(f: FighterState, v: number): void { f.moveHist[HIST_PUNISH_LEVEL] = v; }
const HIST_PUNISH_SRC = 34;
export const PUNISH_NONE = 0, PUNISH_SLIP = 1, PUNISH_BLOCK = 2;
/** What opened the current punish window (PUNISH_NONE once it has closed). A landing is a COUNTER only inside a SLIP's window (2026-09-22). */
export function punishSource(f: FighterState): number { return f.moveHist[HIST_PUNISH_SRC] ?? PUNISH_NONE; }
export function setPunishSource(f: FighterState, s: number): void { f.moveHist[HIST_PUNISH_SRC] = s; }
export function whiffMult(f: FighterState): number { return f.moveHist[HIST_WHIFF_MULT] || 1; }
export function setWhiffMult(f: FighterState, m: number): void { f.moveHist[HIST_WHIFF_MULT] = m; }

export function getUpAt(f: FighterState): number { return f.moveHist[HIST_GET_UP_AT] ?? 0; }
export function setGetUpAt(f: FighterState, t: number): void { f.moveHist[HIST_GET_UP_AT] = t; }

/** The scratch layout a fresh fighter starts with. */
export function initialMoveHist(): number[] { return [0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]; }
/** The ceiling health regenerates toward this round (Fight Night's recoverable health); every hit lowers it. */
export function healthCap(f: FighterState): number { const v = f.moveHist[HIST_HEALTH_CAP]; return v === undefined ? 1 : v; }
export function setHealthCap(f: FighterState, c: number): void { f.moveHist[HIST_HEALTH_CAP] = c; }
export function healthRegenDelay(f: FighterState): number { return f.moveHist[HIST_HEALTH_DELAY] ?? 0; }
export function setHealthRegenDelay(f: FighterState, t: number): void { f.moveHist[HIST_HEALTH_DELAY] = t; }

/** No punch in flight (every punch field at rest). */
export function idlePunch(hand: Hand): PunchState {
  return { type: null, hand, phase: 'idle', t: 0, progress: 0, resolved: false, contact: null, variant: 'jab', tell: 0, timeMult: 1, powerMult: 1, moveScale: 1, loaded: false, aim: 0, feint: false, nerf: 0 };
}

// ── Polish phase scratch (sim-private; a missing slot reads as its rest value, so older states stay valid) ──
const HIST_CARRY_REF = 35;    // how nerfed the punch in flight was at the press (0..1): its reach is shortened by this
const HIST_HELD_KNOCK = 36;   // +0 x, +1 z: knockback (m/s on the stagger channel) held back while a combination runs on this fighter
const HIST_STUN_AGE = 38;     // seconds the current block stun has been running (the punch lock is only its first hitLockMax)
const HIST_NECK = 39;         // multiplier on the neck clamp for the reaction in progress (a flush shot lets the head travel further)
const HIST_REACT_VARY = 40;   // −1..1: the seeded variation of the reaction in progress
const HIST_GETUP_COUNT = 41;  // the count he was rolled to rise on (for the knockdown's kind)
const HIST_HURT_AFTER = 42;   // seconds left of the raised stun bar after a hurt state ended
export function hurtAfter(f: FighterState): number { return f.moveHist[HIST_HURT_AFTER] ?? 0; }
export function setHurtAfter(f: FighterState, t: number): void { f.moveHist[HIST_HURT_AFTER] = t; }
export function getUpCount(f: FighterState): number { return f.moveHist[HIST_GETUP_COUNT] ?? 0; }
export function setGetUpCount(f: FighterState, n: number): void { f.moveHist[HIST_GETUP_COUNT] = n; }
/** How nerfed the punch in flight was AT THE PRESS (its reach is shortened by this; a hit taken in flight does not shorten an arm already on its way). */
export function reachNerf(f: FighterState): number { return f.moveHist[HIST_CARRY_REF] ?? 0; }
export function setReachNerf(f: FighterState, n: number): void { f.moveHist[HIST_CARRY_REF] = n; }
export function heldKnock(f: FighterState): { x: number; z: number } { return { x: f.moveHist[HIST_HELD_KNOCK] ?? 0, z: f.moveHist[HIST_HELD_KNOCK + 1] ?? 0 }; }
export function setHeldKnock(f: FighterState, x: number, z: number): void { f.moveHist[HIST_HELD_KNOCK] = x; f.moveHist[HIST_HELD_KNOCK + 1] = z; }
export function stunAge(f: FighterState): number { return f.moveHist[HIST_STUN_AGE] ?? 0; }
export function setStunAge(f: FighterState, t: number): void { f.moveHist[HIST_STUN_AGE] = t; }
export function neckMult(f: FighterState): number { return f.moveHist[HIST_NECK] || 1; }
export function setNeckMult(f: FighterState, m: number): void { f.moveHist[HIST_NECK] = m; }
export function reactVary(f: FighterState): number { return f.moveHist[HIST_REACT_VARY] ?? 0; }
export function setReactVary(f: FighterState, v: number): void { f.moveHist[HIST_REACT_VARY] = v; }
/** The head at home. */
export function idleSlip(): SlipState {
  return { active: false, dir: 0, t: 0, offset: 0, kind: 'slip', from: 0, chain: 0, dip: 0 };
}

const v3c = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
const s3c = (s: Spring3): Spring3 => ({ x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz });
const s1c = (s: Spring1): Spring1 => ({ x: s.x, v: s.v });
const gc = (g: GloveState): GloveState => ({ pos: v3c(g.pos), vel: v3c(g.vel), target: v3c(g.target) });
const rc = (r: ReactionState): ReactionState => ({ head: s3c(r.head), torso: s3c(r.torso), tilt: s1c(r.tilt), spin: s1c(r.spin ?? { x: 0, v: 0 }), sink: s1c(r.sink ?? { x: 0, v: 0 }) });

export function cloneFighter(f: FighterState): FighterState {
  return {
    specId: f.specId,
    body: f.body,                 // derived once from the spec; never written
    stance: f.stance,
    ratings: f.ratings,           // from the spec; never written
    pos: { x: f.pos.x, z: f.pos.z },
    vel: { x: f.vel.x, z: f.vel.z },
    yaw: f.yaw,
    lean: { fwd: f.lean.fwd, lat: f.lean.lat },
    torsoTwist: f.torsoTwist,
    crouch: f.crouch,
    health: f.health,
    stamina: f.stamina,
    block: f.block,
    blockT: f.blockT,
    guard: f.guard,
    punch: { ...f.punch },
    slip: { ...f.slip },
    moveHist: f.moveHist.slice(),
    vuln: f.vuln,
    counterWindow: f.counterWindow,
    gloves: [gc(f.gloves[0]), gc(f.gloves[1])],
    reaction: rc(f.reaction),
    stagger: { x: f.stagger.x, z: f.stagger.z },
    down: f.down,
    downT: f.downT,
    knockdowns: f.knockdowns,
    hurt: f.hurt,
    hurtMax: f.hurtMax,
    styleId: f.styleId, guardShape: f.guardShape,
    level: f.level, riseT: f.riseT, range: f.range, posture: f.posture,
    stillT: f.stillT, flat: f.flat, ropes: f.ropes, cornered: f.cornered, angle: f.angle, turned: f.turned,
    hop: { x: f.hop.x, z: f.hop.z }, burstT: f.burstT, burstCd: f.burstCd,
    pivot: { ...f.pivot },
    tap: { ...f.tap },
    guardHp: f.guardHp, guardBroken: f.guardBroken, blockStun: f.blockStun, guardDroop: f.guardDroop,
    fatigue: f.fatigue, punchSlow: f.punchSlow, staminaCap: f.staminaCap, wear: f.wear, guardRest: f.guardRest,
    damage: { ...f.damage },
    hurtKind: f.hurtKind, buckle: f.buckle, liverT: f.liverT, liverMag: f.liverMag,
    clinch: { ...f.clinch },
    pushCd: f.pushCd,
    getUp: { ...f.getUp },
    loaded: f.loaded, loadedT: f.loadedT, combo: f.combo, comboT: f.comboT,
    hitT: f.hitT ?? 0, hitSev: f.hitSev ?? 0, hurtStyle: f.hurtStyle ?? 'none', hurtDelay: f.hurtDelay ?? 0, downKind: f.downKind ?? 'flash', fall: f.fall ?? 'none', kneeT: f.kneeT ?? 0,
    headBox: { ...f.headBox },
    bodyBox: { a: v3c(f.bodyBox.a), b: v3c(f.bodyBox.b), r: f.bodyBox.r },
    arms: [{ shoulder: v3c(f.arms[0].shoulder), elbow: v3c(f.arms[0].elbow) }, { shoulder: v3c(f.arms[1].shoulder), elbow: v3c(f.arms[1].elbow) }],
  };
}

/** A writable draft of `s`: everything the tick touches is copied. */
export function cloneState(s: SimState): SimState {
  return {
    seed: s.seed,
    tick: s.tick,
    time: s.time,
    hitStop: s.hitStop,
    stopUsed: s.stopUsed ?? 0,
    rng: rngClone(s.rng),
    round: {
      ...s.round,
      score: s.round.score.map(p => [p[0], p[1]] as [number, number]),
      landed: [s.round.landed[0], s.round.landed[1]],
      power: [s.round.power[0], s.round.power[1]],
      control: [s.round.control[0], s.round.control[1]],
    },
    fighters: [cloneFighter(s.fighters[0]), cloneFighter(s.fighters[1])],
  };
}

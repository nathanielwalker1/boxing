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
 */
import type { FighterState, FrameInput, GloveState, ReactionState, SimState, Spring1, Spring3, Vec3 } from '../core';
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

export const MASK_JAB = 1, MASK_CROSS = 2, MASK_HOOK = 4, MASK_UPPERCUT = 8;

export function punchMask(i: Readonly<FrameInput>): number {
  return (i.jab ? MASK_JAB : 0) | (i.cross ? MASK_CROSS : 0) | (i.hook ? MASK_HOOK : 0) | (i.uppercut ? MASK_UPPERCUT : 0);
}
export function prevPunchMask(f: FighterState): number { return f.moveHist[HIST_PREV_MASK] ?? 0; }
export function setPrevPunchMask(f: FighterState, m: number): void { f.moveHist[HIST_PREV_MASK] = m; }
export function reactionSnap(f: FighterState): number { return f.moveHist[HIST_SNAP] ?? 1; }
export function setReactionSnap(f: FighterState, s: number): void { f.moveHist[HIST_SNAP] = s; }

export interface PunchBuffer { mask: number; t: number; x: number }
export function punchBuffer(f: FighterState): PunchBuffer {
  return { mask: f.moveHist[HIST_BUF_MASK] ?? 0, t: f.moveHist[HIST_BUF_T] ?? 0, x: f.moveHist[HIST_BUF_X] ?? 0 };
}
export function setPunchBuffer(f: FighterState, b: PunchBuffer): void {
  f.moveHist[HIST_BUF_MASK] = b.mask; f.moveHist[HIST_BUF_T] = b.t; f.moveHist[HIST_BUF_X] = b.x;
}

export function cockMult(f: FighterState): number { return f.moveHist[HIST_COCK_MULT] || 1; }
export function setCockMult(f: FighterState, m: number): void { f.moveHist[HIST_COCK_MULT] = m; }
export function regenDelay(f: FighterState): number { return f.moveHist[HIST_REGEN_DELAY] ?? 0; }
export function setRegenDelay(f: FighterState, t: number): void { f.moveHist[HIST_REGEN_DELAY] = t; }

/** The flick-vs-hold detector's memory of the current stick push (slip.ts). */
export interface PushState { t: number; dir: -1 | 0 | 1; hold: boolean }
export function pushState(f: FighterState): PushState {
  const d = f.moveHist[HIST_PUSH_DIR] ?? 0;
  return { t: f.moveHist[HIST_PUSH_T] ?? 0, dir: d < 0 ? -1 : d > 0 ? 1 : 0, hold: (f.moveHist[HIST_PUSH_HOLD] ?? 0) !== 0 };
}
export function setPushState(f: FighterState, p: PushState): void {
  f.moveHist[HIST_PUSH_T] = p.t; f.moveHist[HIST_PUSH_DIR] = p.dir; f.moveHist[HIST_PUSH_HOLD] = p.hold ? 1 : 0;
}

/** The scratch layout a fresh fighter starts with. */
export function initialMoveHist(): number[] { return [0, 1, 0, 0, 0, 1, 0, 0, 0, 0]; }

const v3c = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
const s3c = (s: Spring3): Spring3 => ({ x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz });
const s1c = (s: Spring1): Spring1 => ({ x: s.x, v: s.v });
const gc = (g: GloveState): GloveState => ({ pos: v3c(g.pos), vel: v3c(g.vel), target: v3c(g.target) });
const rc = (r: ReactionState): ReactionState => ({ head: s3c(r.head), torso: s3c(r.torso), tilt: s1c(r.tilt) });

export function cloneFighter(f: FighterState): FighterState {
  return {
    specId: f.specId,
    body: f.body,                 // derived once from the spec; never written
    stance: f.stance,
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
    headBox: { ...f.headBox },
    bodyBox: { a: v3c(f.bodyBox.a), b: v3c(f.bodyBox.b), r: f.bodyBox.r },
  };
}

/** A writable draft of `s`: everything the tick touches is copied. */
export function cloneState(s: SimState): SimState {
  return {
    seed: s.seed,
    tick: s.tick,
    time: s.time,
    hitStop: s.hitStop,
    rng: rngClone(s.rng),
    round: { ...s.round, score: s.round.score.map(p => [p[0], p[1]] as [number, number]) },
    fighters: [cloneFighter(s.fighters[0]), cloneFighter(s.fighters[1])],
  };
}

/**
 * sim/round.ts — the fight state machine (CONTRACT §8 fight loop, SIM half).
 *
 *   fighting ─clock 0─▶ roundEnd (scored) ─▶ between ─betweenRoundSeconds─▶ fighting (next round)
 *       │                                └─ last round ─▶ decision ─▶ over
 *       └─knockdown─▶ count ─get-up─▶ fighting
 *                          └─ count reaches 10 ─▶ ko ─▶ over
 *                          └─ knockdownsForTko in the round ─▶ tko ─▶ over (resources.ts)
 *
 * The intro (fighters to corners, name cards) is presentation: the UI holds
 * the sim before its first step. Between rounds the sim only runs the rest
 * timer; at the next roundStart both fighters are put back in their corners
 * with part of the missing health and stamina restored and the round's
 * knockdown pips cleared.
 *
 * Scoring is 10-point-must from the round's tallies (combat.ts counts clean
 * lands and their impulse): the side with more landed + impulse × weight
 * takes 10, the other 9 (10-10 if level), then −1 per knockdown suffered,
 * floored at 6. Control is not scored (flagged). A decision sums the cards;
 * equal = draw (winner null).
 */
import type { Config, FighterState, Side, SimEvent, SimState, Vec2 } from '../core';
import { healthCap, idlePunch, idleSlip, initialMoveHist, setHealthCap } from './state';
import { computeBoxes } from './reaction';
import { settleGloves } from './gloves';
import { stepArms } from './arms';

/** Where the fighters start every round (createState uses the same). */
export const CORNER_X = 1.2;
export function cornerOf(side: Side): { pos: Vec2; yaw: number } {
  return side === 0 ? { pos: { x: -CORNER_X, z: 0 }, yaw: 0 } : { pos: { x: CORNER_X, z: 0 }, yaw: Math.PI };
}

/** Put a fighter back in the corner for a new round: every dynamic field to rest, health/stamina partly restored. */
function toCorner(f: FighterState, side: Side, time: number, cfg: Config): void {
  const c = cornerOf(side);
  f.pos = { x: c.pos.x, z: c.pos.z };
  f.vel = { x: 0, z: 0 };
  f.yaw = c.yaw;
  f.lean = { fwd: 0, lat: 0 };
  f.torsoTwist = 0;
  f.crouch = 0;
  f.block = false; f.blockT = 0; f.guard = 'rest';
  f.punch = idlePunch('lead');
  f.slip = idleSlip();
  // Overhaul: the transient states clear; what the fight has done to him does not (damage; the body's share of the
  // stamina ceiling). The work-rate wear comes back by wearRestore on the stool, the guard meter fully.
  f.level = 0; f.riseT = 0; f.range = 'outside'; f.posture = 0;
  f.stillT = 0; f.flat = 0; f.ropes = 0; f.cornered = false; f.angle = 0; f.turned = 0;
  f.hop = { x: 0, z: 0 }; f.burstT = 0; f.burstCd = 0;
  f.pivot = { t: 0, dir: 0, left: 0, cx: 0, cz: 0 };
  f.tap = { dir: 0, t: 0 };
  f.guardHp = 1; f.guardBroken = 0; f.blockStun = 0; f.guardRest = 0;
  f.wear *= 1 - cfg.wearRestore;
  f.hurtKind = 'none'; f.buckle = 0; f.liverT = 0; f.liverMag = 0;
  f.clinch = { active: false, reach: 0, t: 0, by: -1, cd: 0 };
  f.pushCd = 0;
  f.getUp = { phase: 'none', t: 0, tries: 0, owed: false };
  f.loaded = 0; f.loadedT = 0; f.combo = 0; f.comboT = 0;
  // The health cap survives the rest (it is what the round did to him), raised by the same fraction as the health.
  const cap = healthCap(f);
  f.moveHist = initialMoveHist();
  setHealthCap(f, Math.min(1, cap + (1 - cap) * cfg.betweenRoundHealthRestore));
  f.vuln = 0; f.counterWindow = 0;
  f.reaction = { head: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, torso: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }, tilt: { x: 0, v: 0 }, spin: { x: 0, v: 0 }, sink: { x: 0, v: 0 } };
  f.stagger = { x: 0, z: 0 };
  f.down = false; f.downT = 0; f.knockdowns = 0;
  f.hurt = 0; f.hurtMax = 0;
  f.health = Math.min(healthCap(f), f.health + (1 - f.health) * cfg.betweenRoundHealthRestore);
  f.stamina = Math.min(1, f.stamina + (1 - f.stamina) * cfg.betweenRoundStaminaRestore);
  computeBoxes(f, cfg);
}

export function startRound(s: SimState, index: number, cfg: Config, events: SimEvent[]): void {
  s.round.index = index;
  s.round.clock = cfg.roundSeconds;
  s.round.phase = 'fighting';
  s.round.phaseT = 0;
  s.round.landed = [0, 0];
  s.round.power = [0, 0];
  s.round.control = [0, 0];
  s.round.iqScore = [0, 0];
  s.round.reached = [0, 0];
  s.round.count = 0;
  if (index > 0) {
    for (const side of [0, 1] as const) toCorner(s.fighters[side], side, s.time, cfg);
    // Both sets of boxes first: a glove settles clear of the OTHER fighter.
    for (const side of [0, 1] as const) settleGloves(s.fighters[side], s.fighters[side === 0 ? 1 : 0], side, s.time, cfg);
    for (const side of [0, 1] as const) stepArms(s.fighters[side], cfg, 0);
  }
  events.push({ type: 'roundStart', index });
  events.push({ type: 'bell' });
}

/**
 * iqScoring: who loses the round (0, 1, or null for 10-10) before knockdowns, and whether the tie-break (work) decided it.
 * Judges score what a punch DOES (iqScore); a close or quiet round goes to the man who made the fight, if he clearly did.
 */
export function iqCall(r: SimState['round'], cfg: Config): { loser: Side | null; tieBreak: boolean } {
  const q0 = r.iqScore[0], q1 = r.iqScore[1], big = Math.max(q0, q1);
  const close = Math.abs(q0 - q1) <= cfg.iqScoreCloseShare * big || big < cfg.iqScoreQuietFloor;
  if (!close) return { loser: q0 > q1 ? 1 : 0, tieBreak: false };
  const work = (side: Side) => r.reached[side] + r.control[side] * cfg.scoreControlWeight;
  const w0 = work(0), w1 = work(1);
  if (w0 > 0 && w0 > w1 * cfg.iqScoreWorkLead) return { loser: 1, tieBreak: true };
  if (w1 > 0 && w1 > w0 * cfg.iqScoreWorkLead) return { loser: 0, tieBreak: true };
  return { loser: null, tieBreak: false };
}

/** The judges' card for the round just fought. */
export function scoreRound(s: SimState, cfg: Config): [number, number] {
  const r = s.round;
  // Landed (a glancing one counts scoreGlancing of a clean one), power, and control: what he made the other man miss.
  // (Control is credit for hitting and not being hit: it counts only up to what he landed himself. MEASURED without
  // that cap: the turtle, who never throws, took 6 of 8 decisions from the outboxer on his misses alone.)
  const pts = (side: Side) => r.landed[side] + r.power[side] * cfg.scorePowerWeight + Math.min(r.control[side], r.landed[side]) * cfg.scoreControlWeight;
  let a = 10, b = 10;
  if (cfg.iqScoring) {
    const c = iqCall(r, cfg);
    if (c.loser === 0) a = 9; else if (c.loser === 1) b = 9;
  } else {
    const p0 = pts(0), p1 = pts(1);
    if (p0 > p1 + 1e-9) b = 9; else if (p1 > p0 + 1e-9) a = 9;
  }
  a = Math.max(6, a - s.fighters[0].knockdowns);
  b = Math.max(6, b - s.fighters[1].knockdowns);
  return [a, b];
}

export function endRound(s: SimState, cfg: Config, events: SimEvent[]): void {
  const score = scoreRound(s, cfg);
  s.round.score.push(score);
  s.round.phaseT = 0;
  // The bell stops the feet (a punch already in flight finishes on its own).
  for (const f of s.fighters) { f.vel = { x: 0, z: 0 }; f.stagger = { x: 0, z: 0 }; }
  events.push({ type: 'bell' });
  events.push({ type: 'roundEnd', index: s.round.index, score });
  if (s.round.index + 1 >= cfg.roundCount) {
    const cards = s.round.score.map(p => [p[0], p[1]] as [number, number]);
    let t0 = 0, t1 = 0;
    for (const [a, b] of cards) { t0 += a; t1 += b; }
    s.round.phase = 'over';
    events.push({ type: 'decision', winner: t0 > t1 ? 0 : t1 > t0 ? 1 : null, cards });
  } else {
    s.round.phase = 'between';
  }
}

/** The rest between rounds: nothing moves; the next round starts when the stool time is up. */
export function stepBetween(s: SimState, cfg: Config, dt: number, events: SimEvent[]): void {
  if (s.round.phase !== 'between') return;
  if (s.round.phaseT + dt >= cfg.betweenRoundSeconds) startRound(s, s.round.index + 1, cfg, events);
}

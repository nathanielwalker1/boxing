/**
 * sim/index.ts — the sim's public surface (CONTRACT §4). SIM workstream owns
 * this folder. Stage 1: movement, jab, cross, block, range gating, hit
 * reaction, hit-stop, the kinetic chain that owns the gloves, and the round
 * clock. Side 1 is driven by whatever input it is given (NULL_INPUT = the
 * frozen-guard dummy: it still turns, holds guard, takes hits and reacts).
 * The fight state machine (rounds, rest, the 10-count, scoring, the
 * decision) is round.ts + resources.ts; the round starts on tick 0 — the
 * intro is presentation, the UI holds the sim until the bell.
 *
 * Tick order (every system reads positions the previous system settled):
 *   slip → actions → stamina → locomotion → separation → facing → punch clock +
 *   vulnerability → reaction springs + boxes → gloves → hit resolution → count
 *   → rest timer → clock / hit-stop.
 */
import {
  NULL_INPUT, SIM_DT, restFighterState, seedRng,
  type Config, type FighterSpec, type FrameInput, type PunchType, type Side, type SimEvent, type SimState,
} from '../core';
import { cloneState, initialMoveHist } from './state';
import { resolveSeparation, stepFacing, stepLocomotion } from './movement';
import { advancePunch, resolvePunch, stepActions } from './combat';
import { computeBoxes, stepReaction } from './reaction';
import { integrateGloves, settleContacts, settleGloves, stepGloves } from './gloves';
import { stepArms } from './arms';
import { stepCount, stepStamina } from './resources';
import { stepSlip } from './slip';
import { stepVulnerability } from './vulnerability';
import { cornerOf, endRound, startRound, stepBetween } from './round';

export { healthCap, PUNISH_SLIP, punishSource } from './state';
export { canStartPunch } from './combat';

const SIDES: [Side, Side] = [0, 1];

export function createState(specs: [FighterSpec, FighterSpec], cfg: Config, seed: number): SimState {
  const c0 = cornerOf(0), c1 = cornerOf(1);
  const s: SimState = {
    seed,
    tick: 0,
    time: 0,
    hitStop: 0,
    rng: seedRng(seed),
    round: { index: 0, clock: cfg.roundSeconds, phase: 'fighting', phaseT: 0, score: [], landed: [0, 0], power: [0, 0], count: 0 },
    fighters: [
      restFighterState(specs[0], cfg, c0.pos, c0.yaw),
      restFighterState(specs[1], cfg, c1.pos, c1.yaw),
    ],
  };
  for (const side of SIDES) {
    const f = s.fighters[side];
    f.moveHist = initialMoveHist();
    computeBoxes(f, cfg);
  }
  for (const side of SIDES) settleGloves(s.fighters[side], s.fighters[side === 0 ? 1 : 0], side, 0, cfg);
  for (const side of SIDES) stepArms(s.fighters[side], cfg, 0);
  return s;
}

export function step(state: SimState, inputs: [FrameInput, FrameInput], cfg: Config): { state: SimState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  const s = cloneState(state);
  // Hit-stop: the whole sim advances at the scaled rate; the stop itself
  // counts down in real ticks (CONTRACT addition 2026-09-02).
  const dt = s.hitStop > 0 ? SIM_DT * cfg.hitStopScale : SIM_DT;
  s.hitStop = Math.max(0, s.hitStop - SIM_DT);

  if (s.tick === 0) startRound(s, 0, cfg, events);
  const fighting = s.round.phase === 'fighting';
  const ins: [Readonly<FrameInput>, Readonly<FrameInput>] = fighting ? inputs : [NULL_INPUT, NULL_INPUT];

  // Slip before actions: the block reads this tick's window, so it comes up
  // on the very tick the window closes; the flick reads the held block level.
  for (const side of SIDES) stepSlip(s.fighters[side], side, ins[side], cfg, dt, events);
  for (const side of SIDES) stepActions(s.fighters[side], side, ins[side], cfg, dt, events);
  for (const side of SIDES) stepStamina(s.fighters[side], cfg, dt);
  for (const side of SIDES) stepLocomotion(s.fighters[side], ins[side], cfg, dt);
  resolveSeparation(s.fighters[0], s.fighters[1], cfg);
  stepFacing(s.fighters[0], s.fighters[1], cfg, dt);
  stepFacing(s.fighters[1], s.fighters[0], cfg, dt);

  const peaked: [PunchType | null, PunchType | null] = [null, null];
  for (const side of SIDES) {
    const f = s.fighters[side];
    const type = f.punch.type;
    if (advancePunch(f, cfg, dt)) peaked[side] = type;
    // Exposure is read off this tick's punch progress, so the hit test below
    // sees the same number a readout would show for this tick.
    stepVulnerability(f, cfg, dt);
  }
  for (const side of SIDES) { stepReaction(s.fighters[side], cfg, dt); computeBoxes(s.fighters[side], cfg); }
  // Glove targets, then the springs integrated with the contacts (head,
  // body, arms, gloves) resolved inside each sub-step; the arm joints the
  // rig draws are placed from the final gloves. Before the hit test, which
  // sees the surface contact all this leaves.
  for (const side of SIDES) stepGloves(s.fighters[side], s.fighters[side === 0 ? 1 : 0], side, s.time, cfg, dt);
  for (const side of SIDES) stepArms(s.fighters[side], cfg, dt);   // the elbow-pole lags advance once a tick
  integrateGloves(s.fighters[0], s.fighters[1], cfg, dt);
  for (const side of SIDES) stepArms(s.fighters[side], cfg, 0);
  for (const side of SIDES) { const t = peaked[side]; if (t !== null) resolvePunch(s, side, t, cfg, events); }
  // A land applies the impact pose at once (reaction.ts): the struck body's
  // boxes and arms move on the land tick, so re-derive them and re-settle
  // the contacts, so the frame the rig draws (and the freeze holds) is clean.
  if (peaked[0] !== null || peaked[1] !== null) {
    for (const side of SIDES) { computeBoxes(s.fighters[side], cfg); stepArms(s.fighters[side], cfg, 0); }
    settleContacts(s.fighters[0], s.fighters[1], cfg);
    for (const side of SIDES) stepArms(s.fighters[side], cfg, 0);
  }
  stepCount(s, cfg, dt, events);
  stepBetween(s, cfg, dt, events);

  s.round.phaseT += dt;
  // The clock only runs while fighting: it holds through the count (a
  // knockdown at the bell still gets its count) and stops at the round's end.
  if (fighting && s.round.phase === 'fighting') {
    s.round.clock = Math.max(0, s.round.clock - dt);
    if (s.round.clock <= 0) endRound(s, cfg, events);
  }
  s.tick += 1;
  s.time += dt;
  return { state: s, events };
}

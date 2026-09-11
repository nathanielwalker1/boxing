/**
 * sim/index.ts — the sim's public surface (CONTRACT §4). SIM workstream owns
 * this folder. Stage 1: movement, jab, cross, block, range gating, hit
 * reaction, hit-stop, the kinetic chain that owns the gloves, and the round
 * clock. Side 1 is driven by whatever input it is given (NULL_INPUT = the
 * frozen-guard dummy: it still turns, holds guard, takes hits and reacts).
 *
 * Tick order (every system reads positions the previous system settled):
 *   actions → locomotion → separation → facing → punch clock → reaction
 *   springs + boxes → gloves → hit resolution → clock / hit-stop.
 */
import {
  NULL_INPUT, SIM_DT, restFighterState, seedRng,
  type Config, type FighterSpec, type FrameInput, type PunchType, type Side, type SimEvent, type SimState,
} from '../core';
import { cloneState, initialMoveHist } from './state';
import { resolveSeparation, stepFacing, stepLocomotion } from './movement';
import { advancePunch, resolvePunch, stepActions } from './combat';
import { computeBoxes, stepReaction } from './reaction';
import { settleGloves, stepGloves } from './gloves';
import { stepCount, stepStamina } from './resources';

const SIDES: [Side, Side] = [0, 1];

export function createState(specs: [FighterSpec, FighterSpec], cfg: Config, seed: number): SimState {
  const start = 1.2;
  const s: SimState = {
    seed,
    tick: 0,
    time: 0,
    hitStop: 0,
    rng: seedRng(seed),
    round: { index: 0, clock: cfg.roundSeconds, phase: 'fighting', phaseT: 0, score: [] },
    fighters: [
      restFighterState(specs[0], cfg, { x: -start, z: 0 }, 0),
      restFighterState(specs[1], cfg, { x: start, z: 0 }, Math.PI),
    ],
  };
  for (const side of SIDES) {
    const f = s.fighters[side];
    f.moveHist = initialMoveHist();
    computeBoxes(f);
    settleGloves(f, side, 0, cfg);
  }
  return s;
}

export function step(state: SimState, inputs: [FrameInput, FrameInput], cfg: Config): { state: SimState; events: SimEvent[] } {
  const events: SimEvent[] = [];
  const s = cloneState(state);
  // Hit-stop: the whole sim advances at the scaled rate; the stop itself
  // counts down in real ticks (CONTRACT addition 2026-09-02).
  const dt = s.hitStop > 0 ? SIM_DT * cfg.hitStopScale : SIM_DT;
  s.hitStop = Math.max(0, s.hitStop - SIM_DT);

  if (s.tick === 0) { events.push({ type: 'roundStart', index: s.round.index }); events.push({ type: 'bell' }); }
  const fighting = s.round.phase === 'fighting';
  const ins: [Readonly<FrameInput>, Readonly<FrameInput>] = fighting ? inputs : [NULL_INPUT, NULL_INPUT];

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
  }
  for (const side of SIDES) { stepReaction(s.fighters[side], cfg, dt); computeBoxes(s.fighters[side]); }
  for (const side of SIDES) stepGloves(s.fighters[side], side, s.time, cfg, dt);
  for (const side of SIDES) { const t = peaked[side]; if (t !== null) resolvePunch(s, side, t, cfg, events); }
  stepCount(s, cfg, dt, events);

  s.round.phaseT += dt;
  if (fighting) {
    s.round.clock = Math.max(0, s.round.clock - dt);
    if (s.round.clock <= 0) {
      const score: [number, number] = [10, 10];
      s.round.score.push(score);
      s.round.phase = 'over';
      s.round.phaseT = 0;
      events.push({ type: 'bell' });
      events.push({ type: 'roundEnd', index: s.round.index, score });
    }
  }
  s.tick += 1;
  s.time += dt;
  return { state: s, events };
}

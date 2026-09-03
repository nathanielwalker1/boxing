/**
 * sim/index.ts — the sim's public surface (CONTRACT §4). SIM workstream owns
 * this folder. This is the Stage-1 STUB: it holds two fighters at rest and
 * advances the clock. SIM replaces the bodies of createState/step; the
 * signatures are the contract and do not change.
 */
import {
  SIM_DT, restFighterState, seedRng, type Config, type FighterSpec, type FrameInput, type SimEvent, type SimState,
} from '../core';

export function createState(specs: [FighterSpec, FighterSpec], cfg: Config, seed: number): SimState {
  const start = 1.2;
  return {
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
}

export function step(state: SimState, _inputs: [FrameInput, FrameInput], _cfg: Config): { state: SimState; events: SimEvent[] } {
  return { state: { ...state, tick: state.tick + 1, time: state.time + SIM_DT }, events: [] };
}

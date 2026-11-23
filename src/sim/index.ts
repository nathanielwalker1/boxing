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
  NULL_INPUT, SIM_DT, restFighterState, seedRng, v2dist,
  type Config, type FighterSpec, type FrameInput, type PunchType, type Side, type SimEvent, type SimState,
} from '../core';
import { cloneState, initialMoveHist } from './state';
import { resolveSeparation, stepFacing, stepLocomotion } from './movement';
import { advancePunch, resolvePunch, stepActions } from './combat';
import { computeBoxes, stepReaction } from './reaction';
import { integrateGloves, settleContacts, settleGloves, stepGloves } from './gloves';
import { stepArms } from './arms';
import { applyInertia, restoreInertia, restoreRaw, snapInertia } from './inertia';
import { stepCount, stepStamina } from './resources';
import { stepSlip, type FlickRequest } from './slip';
import { stepVulnerability } from './vulnerability';
import { stepHurtDelay, stepKnee, stepLiver, stepStun } from './stun';
import { cornerOf, endRound, startRound, stepBetween } from './round';
import { stepFooting } from './footing';
import { stepClinch } from './clinch';
import { stepHitStopBudget, stepHold } from './flow';
import { mocapCfg, stepMocap } from './mocap';

export { healthCap, PUNISH_SLIP, punishSource } from './state';
export { canStartPunch, guardCover } from './combat';
export { stunThreshold, bodyThreshold, hurtLevel } from './stun';
export { VARIANTS, VARIANT_NAMES, pickVariant } from './variants';
export { stanceDrop, rangeBand, bodyWear, angleExposure } from './footing';
export { punchReach, probe as gradeProbe } from './grade';
export { getUpPhaseAt } from './resources';
export { scoreRound } from './round';
export { hitNerf, hitZone, seededUnit } from './flow';

const SIDES: [Side, Side] = [0, 1];

export function createState(specs: [FighterSpec, FighterSpec], cfg: Config, seed: number): SimState {
  const c0 = cornerOf(0), c1 = cornerOf(1);
  const s: SimState = {
    seed,
    tick: 0,
    time: 0,
    hitStop: 0,
    rng: seedRng(seed),
    round: { index: 0, clock: cfg.roundSeconds, phase: 'fighting', phaseT: 0, score: [], landed: [0, 0], power: [0, 0], control: [0, 0], iqScore: [0, 0], reached: [0, 0], count: 0 },
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

export function step(state: SimState, inputs: [FrameInput, FrameInput], cfgIn: Config): { state: SimState; events: SimEvent[] } {
  // mocapGeo (sim/mocap.ts): the reach-dependent distances × mocapRangeScale; off = cfgIn itself.
  const cfg = mocapCfg(cfgIn);
  const events: SimEvent[] = [];
  const s = cloneState(state);
  // Hit-stop: the whole sim advances at the scaled rate; the stop itself
  // counts down in real ticks (CONTRACT addition 2026-09-02).
  const dt = s.hitStop > 0 ? SIM_DT * cfg.hitStopScale : SIM_DT;
  // hitStopV2 (anim 2.4): a stop of N ticks is exactly N stopped ticks (the float residue is snapped to 0), and a press
  // during it is held in the buffer instead of starting a punch whose clock would crawl at hitStopScale.
  const stopped = s.hitStop > 0;
  s.hitStop = cfg.hitStopV2 && s.hitStop - SIM_DT < 1e-6 ? 0 : Math.max(0, s.hitStop - SIM_DT);

  for (const side of SIDES) restoreRaw(s.fighters[side], cfg);
  if (s.tick === 0) startRound(s, 0, cfg, events);
  const fighting = s.round.phase === 'fighting';
  const ins: [Readonly<FrameInput>, Readonly<FrameInput>] = fighting ? inputs : [NULL_INPUT, NULL_INPUT];

  // Slip before actions: the block reads this tick's window, so it comes up
  // on the very tick the window closes; the flick reads the held block level.
  // Overhaul: a flick may also be a pivot, a burst (both started in slip.ts /
  // footing.ts) or a push-off, which needs the other fighter — it is raised
  // as a request and resolved for the pair in stepClinch, with the tie-up.
  const reqs: [FlickRequest, FlickRequest] = [{ push: false }, { push: false }];
  const nEv = events.length;
  for (const side of SIDES) stepSlip(s.fighters[side], side, ins[side], cfg, dt, events, reqs[side]);
  // Pivoted on: an opponent in range is slow to turn for a beat (his feet have to reset).
  for (let i = nEv; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== 'pivot') continue;
    const o = s.fighters[e.side === 0 ? 1 : 0];
    if (v2dist(s.fighters[e.side].pos, o.pos) <= cfg.pivotRange) o.turned = Math.max(o.turned, cfg.pivotTurnLag);
  }
  for (const side of SIDES) stepActions(s.fighters[side], side, ins[side], cfg, dt, events, s.fighters[side === 0 ? 1 : 0], cfg.hitStopV2 && stopped);
  if (fighting) stepClinch(s, ins, reqs, cfg, dt, events);
  for (const side of SIDES) stepStamina(s.fighters[side], cfg, dt);
  // Footing: level, range and posture, flat-footed, ropes, the angle, fatigue — derived before anything moves.
  for (const side of SIDES) stepFooting(s.fighters[side], s.fighters[side === 0 ? 1 : 0], ins[side], cfg, dt);
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
    // sees the same number a readout would show for this tick. The hurt
    // state ticks first so a cleared one no longer holds the exposure.
    stepStun(f, dt, cfg);
    stepVulnerability(f, cfg, dt);
  }
  // mocapGeo: this tick's mocap glove and lunge, from the punch clocks just advanced (read by computeBoxes and stepGloves).
  if (cfg.mocapGeo) for (const side of SIDES) stepMocap(s.fighters[side], s.fighters[side === 0 ? 1 : 0], side, cfg);
  // The liver fuse: a clean liver shot buckles him a beat later (or puts him down).
  if (fighting) for (const side of SIDES) stepLiver(s, side, cfg, dt, events);
  // Polish phase (item 3): a body hurt that lands a beat late; a hurt fighter taking a knee by choice.
  if (fighting) for (const side of SIDES) { stepHurtDelay(s, side, cfg, dt, events); if (s.round.phase === 'fighting') stepKnee(s, side, ins[side], cfg, dt, events); }
  for (const side of SIDES) { stepReaction(s.fighters[side], cfg, dt); computeBoxes(s.fighters[side], cfg); }
  // Glove targets, then the springs integrated with the contacts (head,
  // body, arms, gloves) resolved inside each sub-step; the arm joints the
  // rig draws are placed from the final gloves. Before the hit test, which
  // sees the surface contact all this leaves.
  for (const side of SIDES) stepGloves(s.fighters[side], s.fighters[side === 0 ? 1 : 0], side, s.time, cfg, dt);
  for (const side of SIDES) stepArms(s.fighters[side], cfg, dt);   // the elbow-pole lags advance once a tick
  integrateGloves(s.fighters[0], s.fighters[1], cfg, dt);
  for (const side of SIDES) stepArms(s.fighters[side], cfg, 0);
  // Joint inertialization (inertia.ts): the pose is final; no joint starts or stops in one tick. The hit shapes are
  // rewritten from the smoothed pose before the hit test. (Snapshot: a land tick re-fits the pose below and redoes this.)
  const inSnap = SIDES.map(side => snapInertia(s.fighters[side]));
  for (const side of SIDES) applyInertia(s.fighters[side], cfg, false, stopped);
  const evMark = events.length;
  for (const side of SIDES) { const t = peaked[side]; if (t !== null) resolvePunch(s, side, t, cfg, events); }
  // A land applies the impact pose at once (reaction.ts): the struck body's
  // boxes and arms move on the land tick, so re-derive them and re-settle
  // the contacts, so the frame the rig draws (and the freeze holds) is clean.
  if (peaked[0] !== null || peaked[1] !== null) {
    for (const side of SIDES) { computeBoxes(s.fighters[side], cfg); stepArms(s.fighters[side], cfg, 0); }
    settleContacts(s.fighters[0], s.fighters[1], cfg);
    for (const side of SIDES) stepArms(s.fighters[side], cfg, 0);
    // The re-fit overwrote the smoothed pose: the struck man (a hit or a block on him) takes the pose as it is, the other
    // man is smoothed again from the state he had before this tick.
    for (const side of SIDES) {
      const f = s.fighters[side];
      const struck = events.slice(evMark).some(e => (e.type === 'punchLand' || e.type === 'punchBlock') && e.target === side);
      restoreInertia(f, inSnap[side]);
      applyInertia(f, cfg, struck, stopped);
    }
  }
  // Polish phase (flow.ts): knockback held while a combination ran is let go once it is over; the hit-stop bucket refills.
  stepHold(s.fighters[0], s.fighters[1], cfg);
  stepHold(s.fighters[1], s.fighters[0], cfg);
  stepHitStopBudget(s, cfg);
  stepCount(s, cfg, dt, events);
  stepBetween(s, cfg, dt, events);

  s.round.phaseT += dt;
  // The clock runs while fighting AND through the count (2026-10-15, Nate:
  // "the round time should still keep going"). A count is never cut short:
  // a clock that runs out during it holds at 0 and the round ends on the
  // get-up (stepCount above puts the phase back to fighting the same tick).
  const ph = s.round.phase;
  if ((fighting && ph === 'fighting') || ph === 'count') s.round.clock = Math.max(0, s.round.clock - dt);
  if (s.round.phase === 'fighting' && s.round.clock <= 0) endRound(s, cfg, events);
  s.tick += 1;
  s.time += dt;
  return { state: s, events };
}

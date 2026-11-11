/**
 * ui/drills.ts — the gym's drill list: SIM's seven drills (`src/ai/drills.ts`:
 * placement, a pure opponent policy, setup, a metric over every event since
 * the start) mapped onto what the flow runs, plus the built-in free sparring.
 * What this file adds is the part a person needs on screen: for each drill,
 * the exact controls it trains, for keyboard, gamepad and touch (the bindings
 * are ui/input.ts's; the moves are docs/OVERHAUL_SIM.md's input tables).
 *
 * Directions: the fight camera keeps the opponent to your right, so "toward
 * him" is right (D / stick right), "away" is left, and "to the side" is up or
 * down (W or S / stick up or down).
 */
import { NULL_INPUT, cloneInput, type Config, type FighterSpec, type FrameInput, type SimEvent, type SimState, type Vec2 } from '../core';
import { DRILLS } from '../ai/drills';

export interface DrillMetric { progress: number; stat: string }
/** One thing to do in a drill, and how on each device. */
export interface DrillControl { move: string; keys: string; pad: string; touch: string }
export interface Drill {
  id: string;
  title: string;
  /** One sentence: what to do. */
  goal: string;
  /** The controls it trains. */
  controls: readonly DrillControl[];
  /** Suggested length, s (0 = no clock). */
  seconds: number;
  placement: { dist?: number; player?: Vec2; opponent?: Vec2 };
  /** Changes to the partner's spec for this drill (a taller man, a style). */
  opponentSpec?: Partial<FighterSpec>;
  /** The partner's input for a tick counted from the drill's start; null = let the normal AI drive him. */
  opponent: ((s: SimState, tick: number) => FrameInput) | null;
  setup: ((s: SimState) => void) | null;
  /** Config the drill runs under (put back when it ends): the free-sparring partner is a bag that does not fall over. */
  tune?: (cfg: Config) => Partial<Config>;
  /** `events` = this frame's; `acc` = the drill run's own memory. */
  metric: ((s: SimState, events: readonly SimEvent[], acc: Record<string, unknown>) => DrillMetric) | null;
}

const c = (move: string, keys: string, pad: string, touch: string): DrillControl => ({ move, keys, pad, touch });
const MOVE = c('Move', 'W A S D', 'Left stick', 'Drag, left half');
const JAB = c('Jab', 'J', 'Y', 'JAB');
const BLOCK = c('Block (hold)', 'Space', 'RB', 'BLOCK');
const SLIP = c('Slip', 'Tap W or S', 'Flick stick up / down', 'Flick up / down');
const ROLL = c('Roll under', 'Shift + tap W or S', 'LT + flick up / down', 'LOW + flick up / down');

const CONTROLS: Record<string, readonly DrillControl[]> = {
  'jab-and-move': [
    JAB,
    c('Step back out', 'Hold A', 'Stick left', 'Drag left'),
    c('Circle', 'Hold W or S', 'Stick up / down', 'Drag up / down'),
    c('Jab on the retreat', 'A + J', 'Stick left + Y', 'Drag left + JAB'),
  ],
  'cut-off': [
    c('Step across his path', 'Hold W or S', 'Stick up / down', 'Drag up / down'),
    c('Close the gap', 'Hold D', 'Stick right', 'Drag right'),
    c('Burst (quick hop)', 'Double-tap a direction', 'Flick, then push again', 'Flick, then push again'),
  ],
  'get-inside': [
    c('Walk in behind the guard', 'Space + D', 'RB + stick right', 'BLOCK + drag right'),
    c('Slip the jab', 'Tap W or S', 'Flick stick up / down', 'Flick up / down'),
    c('Go under it', 'Hold Shift', 'Hold LT', 'Hold LOW'),
    c('Inside: hook, uppercut', 'L  ;', 'X  A', 'HOK  UPP'),
  ],
  'slip-timing': [
    SLIP,
    c('Pull back', 'Tap A', 'Flick stick left', 'Flick left'),
    ROLL,
  ],
  'slip-counter': [
    SLIP,
    c('Then punch at once', 'K or L', 'B or X', 'CRS or HOK'),
    c('Which hand', 'The side you slipped to', 'The side you slipped to', 'The side you slipped to'),
  ],
  'body-work': [
    c('Go low (hold)', 'Shift', 'LT', 'LOW'),
    c('Body jab / cross / hook', 'Shift + J / K / L', 'LT + Y / B / X', 'LOW + JAB / CRS / HOK'),
    c('Close the gap', 'Hold D', 'Stick right', 'Drag right'),
  ],
  'survive': [
    BLOCK,
    c('Get off the ropes', 'W A S D', 'Left stick', 'Drag'),
    c('Tie him up (chest to chest)', 'Space + Shift', 'RB + LT', 'BLOCK + LOW'),
    c('Pivot out', 'Space + tap W or S', 'RB + flick up / down', 'BLOCK + flick up / down'),
    c('Shove him off', 'Space + tap D', 'RB + flick right', 'BLOCK + flick right'),
  ],
  'free-sparring': [
    MOVE,
    c('Jab / cross / hook / uppercut', 'J  K  L  ;', 'Y  B  X  A', 'JAB  CRS  HOK  UPP'),
    BLOCK,
    c('Go low (hold)', 'Shift', 'LT', 'LOW'),
    SLIP,
  ],
};

/** The seed SIM's drill policies hash their cadences from (fixed: a drill replays the same way every time). */
const DRILL_SEED = 7;

/** SIM's drills as the flow runs them. */
export function simDrills(cfg: Config): Drill[] {
  return DRILLS.map(d => {
    const place = d.placement(cfg);
    return {
      id: d.id, title: d.title, goal: d.goal, seconds: d.seconds,
      controls: CONTROLS[d.id] ?? [MOVE],
      placement: { player: place.player, opponent: place.opponent },
      ...(d.opponent ? { opponentSpec: d.opponent } : {}),
      opponent: (s: SimState, tick: number) => d.policy(s, tick, DRILL_SEED, cfg),
      setup: d.setup ? (s: SimState) => d.setup!(s, cfg) : null,
      // SIM's metric is a pure function of EVERY event since the start: the run keeps them.
      metric: (s: SimState, events: readonly SimEvent[], acc: Record<string, unknown>) => {
        const all = (acc['events'] ??= []) as SimEvent[];
        for (const e of events) all.push(e);
        return d.metric(all, s, cfg);
      },
    };
  });
}

/** The built-in drill: a man who stands in his guard and does nothing. */
export const FREE_SPARRING: Drill = {
  id: 'free-sparring',
  title: 'Free sparring',
  goal: 'A passive partner who stands in front of you: try every punch and every move with nothing coming back.',
  controls: CONTROLS['free-sparring']!,
  seconds: 0,
  placement: { dist: 1.3 },
  // A partner who never hits back loses his whole bar to six clean punches and spends the drill being counted over:
  // here a punch takes a fifth of the health it would in a fight, so he is still standing after thirty.
  tune: cfg => ({ healthDamagePerImpulse: cfg.healthDamagePerImpulse * 0.2 }),
  opponent: () => cloneInput(NULL_INPUT),
  setup: null,
  metric: (_s, events, acc) => {
    let n = typeof acc['landed'] === 'number' ? acc['landed'] : 0;
    for (const e of events) if (e.type === 'punchLand' && e.side === 0 && e.grade !== 'glancing') n++;
    acc['landed'] = n;
    return { progress: Math.min(1, n / 20), stat: `${n} / 20 clean punches landed` };
  },
};

/** Every drill, in the order to meet them. */
export function drillList(cfg: Config): Drill[] { return [...simDrills(cfg), FREE_SPARRING]; }

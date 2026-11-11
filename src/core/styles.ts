/**
 * core/styles.ts — what a STYLE is for the fighter himself (overhaul phase 2,
 * brief C). Shared data: the sim reads the guard, the rig draws the stance
 * and rhythm, the select screen prints the description and how to beat him.
 * The AI's half of a style (what it DOES — range, punch mix, combinations,
 * ring use, hurt / tired behaviour, tells) is `StyleParams` in src/ai/style.ts.
 *
 * A fighter's style comes from `FighterSpec.style` and applies to the PLAYER's
 * fighter as much as the AI's: pick the swarmer and you hold the peek-a-boo,
 * sit lower and jab shorter.
 *
 * GUARDS — five shapes, each real in the sim:
 *   rest / block   where the two gloves are (so what is physically in the way)
 *   arcFull/None   how far round the head a held block covers (hooks come round it)
 *   headCover      how much of a straight to the head a held block meets
 *   bodyCover      how much of a body shot it meets
 *   uppercutCover  how much of an uppercut it meets (under guardThroughAt = it splits)
 *   wear / stun    guard-meter wear and block stun taken, × the base
 *   raise          seconds a block raised from this guard takes to cover fully
 *   jabTime        the jab's wind-up from this guard, × (the long guard's lead hand is already out there)
 *   jabReach       the jab's reach from it, ×
 *   crouch         metres of real height the stance sits down
 *   expose         exposure (0..1) the resting hands leave: every shot on him is that much nearer flush
 *   move / slip    walking speed and slip window, ×
 * Poses are fractions: fwd × upper-arm length, up × head radius from the head
 * centre (−3 ≈ the solar plexus), lat × shoulder width out to the hand's own
 * side (negative = across the centre line). `high` is exactly the guard every
 * fighter held before styles existed.
 */
import type { AiStyle, GuardShape, RangeBand } from './types';

export interface HandPose { fwd: number; up: number; lat: number }

export interface GuardDef {
  rest: { lead: HandPose; rear: HandPose };
  block: { lead: HandPose; rear: HandPose };
  arcFullDeg: number; arcNoneDeg: number;
  headCover: number; bodyCover: number; uppercutCover: number;
  wear: number; stun: number; raise: number;
  jabTime: number; jabReach: number;
  crouch: number; expose: number; move: number; slip: number;
}

const HIGH_REST = { lead: { fwd: 0.7, up: -0.75, lat: 0.42 }, rear: { fwd: 0.35, up: -0.35, lat: 0.4 } };
const HIGH_BLOCK = { lead: { fwd: 0.4, up: 0.1, lat: 0.15 }, rear: { fwd: 0.32, up: 0.1, lat: 0.15 } };

export const GUARDS: Record<GuardShape, GuardDef> = {
  // The textbook guard: balanced. (arc / body / uppercut values equal the guardArc…, guardBodyCover, guardUppercutCover config defaults.)
  high: {
    rest: HIGH_REST, block: HIGH_BLOCK,
    arcFullDeg: 50, arcNoneDeg: 85, headCover: 1, bodyCover: 0.6, uppercutCover: 0.6,
    wear: 1, stun: 1, raise: 0, jabTime: 1, jabReach: 1, crouch: 0, expose: 0, move: 1, slip: 1,
  },
  // The shell (philly): lead hand low across the body, rear hand by the chin, lead shoulder up. Straights roll off it
  // (little wear, little stun) and the body is covered; the head is open to anything that comes round, and the jab
  // comes up from the hip.
  shell: {
    rest: { lead: { fwd: 0.55, up: -3.3, lat: -0.05 }, rear: { fwd: 0.3, up: -0.5, lat: 0.3 } },
    block: { lead: { fwd: 0.5, up: -2.7, lat: -0.1 }, rear: { fwd: 0.3, up: -0.1, lat: 0.12 } },
    arcFullDeg: 35, arcNoneDeg: 70, headCover: 0.9, bodyCover: 0.85, uppercutCover: 0.6,
    wear: 0.6, stun: 0.7, raise: 0, jabTime: 1.12, jabReach: 1, crouch: 0, expose: 0.1, move: 1, slip: 1.1,
  },
  // Peek-a-boo: both gloves on the cheeks, elbows in, crouched. Hooks meet it all the way round; an uppercut comes
  // straight up between the forearms; the jab starts from the face, so it is short.
  peekaboo: {
    rest: { lead: { fwd: 0.32, up: -0.35, lat: 0.22 }, rear: { fwd: 0.3, up: -0.35, lat: 0.22 } },
    block: { lead: { fwd: 0.3, up: -0.1, lat: 0.16 }, rear: { fwd: 0.3, up: -0.1, lat: 0.16 } },
    arcFullDeg: 65, arcNoneDeg: 100, headCover: 1, bodyCover: 0.35, uppercutCover: 0.3,
    wear: 1, stun: 1, raise: 0, jabTime: 1.05, jabReach: 0.93, crouch: 0.04, expose: 0, move: 1, slip: 1.15,
  },
  // The long guard: lead arm out, measuring. The jab is already half thrown — quicker and longer — but the block is
  // made a long way from the head (it wears fast) and the body is wide open under the arm.
  long: {
    rest: { lead: { fwd: 1.15, up: -0.6, lat: 0.25 }, rear: { fwd: 0.32, up: -0.3, lat: 0.36 } },
    block: { lead: { fwd: 0.75, up: -0.1, lat: 0.12 }, rear: { fwd: 0.32, up: 0.05, lat: 0.14 } },
    arcFullDeg: 45, arcNoneDeg: 80, headCover: 1, bodyCover: 0.3, uppercutCover: 0.45,
    wear: 1.25, stun: 1, raise: 0, jabTime: 0.82, jabReach: 1.05, crouch: 0, expose: 0, move: 1, slip: 1,
  },
  // Hands low: he relies on his feet and his head. Quicker feet, a longer slip, a jab from nowhere — and a chin that
  // is open until the hands get up, which takes a beat.
  low: {
    rest: { lead: { fwd: 0.5, up: -2.6, lat: 0.4 }, rear: { fwd: 0.4, up: -2.2, lat: 0.38 } },
    block: HIGH_BLOCK,
    arcFullDeg: 50, arcNoneDeg: 85, headCover: 1, bodyCover: 0.6, uppercutCover: 0.6,
    wear: 1, stun: 1.15, raise: 0.12, jabTime: 0.95, jabReach: 1, crouch: 0, expose: 0.2, move: 1.07, slip: 1.2,
  },
};

/** The fighter's half of a style. */
export interface FighterStyle {
  id: AiStyle;
  /** The guard he holds (GUARDS). */
  guard: GuardShape;
  /** Stance: foot spread × the rig's default (wide = planted, narrow = on his toes). For the rig. */
  stanceWidth: number;
  /** Rhythm: the bounce's rate and depth × the rig's default (rigRhythmHz / rigRhythmBob). For the rig. */
  bounceHz: number; bounceAmp: number;
  /** The range he wants (A2). */
  range: RangeBand;
  /** One line for the select screen. */
  desc: string;
  /** Three lines: how to beat him. */
  beat: [string, string, string];
}

export const STYLES: Record<AiStyle, FighterStyle> = {
  pressure: {
    id: 'pressure', guard: 'high', stanceWidth: 1, bounceHz: 0.9, bounceAmp: 0.8, range: 'mid',
    desc: 'Walks you down behind a high guard and does not let you rest.',
    beat: ['Do not back straight up: jab, then step off to the side.', 'Go to the body under the high guard.', 'Pivot off the ropes before he sets his feet.'],
  },
  outboxer: {
    id: 'outboxer', guard: 'long', stanceWidth: 0.92, bounceHz: 1.2, bounceAmp: 1.15, range: 'outside',
    desc: 'Long guard, long jab, always moving. Wins rounds from where you cannot reach.',
    beat: ['Cut the ring off; do not follow him round it.', 'Come in behind a block or under the jab, never straight through it.', 'Once inside, stay there: body, then head.'],
  },
  counter: {
    id: 'counter', guard: 'shell', stanceWidth: 1.05, bounceHz: 0.8, bounceAmp: 0.7, range: 'mid',
    desc: 'Sits in the shell and waits for you to miss. Every mistake costs.',
    beat: ['Do not lead with the big punch: feint, then throw.', 'Hooks come round the shell; straights roll off it.', 'Make him lead: jab and step away.'],
  },
  swarmer: {
    id: 'swarmer', guard: 'peekaboo', stanceWidth: 1.1, bounceHz: 1.4, bounceAmp: 1.1, range: 'inside',
    desc: 'Peek-a-boo, head on your chest, short hooks in bunches.',
    beat: ['Keep him on the end of the jab and move; do not let him set.', 'The uppercut splits the peek-a-boo as he comes in.', 'Tie him up or shove him off when he gets inside.'],
  },
  slugger: {
    id: 'slugger', guard: 'low', stanceWidth: 1.15, bounceHz: 0.6, bounceAmp: 0.6, range: 'mid',
    desc: 'Hands low, feet planted, one punch to end it. Slow to start, slower to miss.',
    beat: ['Make him miss: his big shots take a long time to come home.', 'His chin is open until his hands come up: straight punches first.', 'Do not trade. Ever.'],
  },
};

/** The fighter-side style of a spec's style id. */
export function fighterStyle(id: AiStyle): FighterStyle { return STYLES[id]; }

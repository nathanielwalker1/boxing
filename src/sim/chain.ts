/**
 * sim/chain.ts — the kinetic chain in time (polish phase 2026-11-11, item 4:
 * "hooks and uppercuts look goofy and the body doesn't work together").
 *
 * MEASURED BEFORE (scripts/chain_probe.mjs, docs/POLISH_RIG.md): the shoulder
 * line and the forward weight ran on one curve, and the drawn hips FOLLOWED
 * the shoulders through a spring — so the order was shoulders, then hips,
 * then the foot, the reverse of a punch; the heel came up with the forward
 * lean (late); and the dip of an uppercut bottomed at the last tick of the
 * wind-up and came all the way up inside the 4-tick extension — a pop, not a
 * leg drive.
 *
 * Here each punch has a TIMING in fractions of its flight (press → hit test):
 *
 *   0 ───── load ───── hips come through ──────── hit test
 *           └ weight on the punching-side foot, body coiled, sat down
 *                      └ the foot pushes, the hips turn (they are done at hipEnd)
 *                            └ the shoulders start `shoulderAt`, arrive AT the hit test
 *                                  └ the fist leaves in the extension (punchLocal), last
 *
 * Every curve ends where the old one did AT THE HIT TEST (twist 1, dip
 * −0.4 × dip) and is the old one after it (hold, unwind), so reach, timing
 * and the hit geometry at contact are untouched; what changes is how the
 * body gets there. The sim uses `chainShoulder` (the shoulder line — arms and
 * torso-frame fists ride it) and `chainDip`; the rig draws hips, feet and
 * knees from `chainHip`, `chainPush` and `chainLoad` (non-hitbox).
 *
 * Pure: no state, no config reads — the timing is handed in (punches.ts
 * builds it from config, one toggle per punch family).
 */
import { lerp, smoothstep } from '../core';

export interface ChainTiming {
  /** The load is complete (weight on the foot, coil, the hook's sit) by this fraction of the flight. */
  loadEnd: number;
  /** The hips have come all the way through by this fraction (before the fist arrives). */
  hipEnd: number;
  /** The shoulders start to follow at this fraction; they arrive at 1 (the hit test). */
  shoulderAt: number;
  /** The body is at the bottom of its dip by this fraction… */
  sitEnd: number;
  /** …and the legs start to drive up at this one (they arrive at the hit test). */
  riseAt: number;
  /** How far the body sits down in the load, m (the old curve used the punch's own `dip`). */
  loadDip: number;
  /** The shoulder line's turn at the hit test, rad, and the counter-turn in the load as a fraction of it (replace the punch table's `turn` / `coil` while the chain is on). */
  turn: number;
  coil: number;
  /**
   * The SIM keeps its old twist and dip for this punch; only the rig's hips, feet and knees use the chain. The
   * straights: moving their dip or their shoulder timing changed which guard glove a cross met inside smothering
   * range (punch_test, stun_test, heights_test) — hit outcomes the tests pin.
   */
  rigOnly: boolean;
}

/** The slice of a phase table these curves need. */
export interface ChainPhases { cock: number; extend: number; recover: number; hold: number }

const frac = (elapsed: number, ph: ChainPhases): number => elapsed / Math.max(1e-6, ph.cock + ph.extend);
const ramp = (u: number, a: number, b: number): number => smoothstep(Math.min(1, Math.max(0, (u - a) / Math.max(1e-6, b - a))));

/** After the hit test: 1 through the hold, then the unwind — the same shape as punchEnvelope's tail. */
function tail(elapsed: number, ph: ChainPhases): number {
  const rt = ph.recover > 0 ? (elapsed - ph.cock - ph.extend) / ph.recover : 1;
  if (rt < ph.hold) return 1;
  return Math.max(0, 1 - smoothstep((rt - ph.hold) / Math.max(1e-6, 1 - ph.hold)));
}

/** The HIPS' turn as a fraction of the punch's turn: coil in the load, then through — done by `hipEnd`, ahead of the shoulders. */
export function chainHip(coil: number, elapsed: number, ph: ChainPhases, tm: ChainTiming): number {
  const u = frac(elapsed, ph);
  if (u >= 1) return tail(elapsed, ph);
  if (u < tm.loadEnd) return -coil * ramp(u, 0, tm.loadEnd);
  return lerp(-coil, 1, ramp(u, tm.loadEnd, tm.hipEnd));
}

/** The SHOULDER line's turn (the sim's torso twist) as a fraction of the punch's turn: coils with the hips, waits while they start, follows, arrives at the hit test. */
export function chainShoulder(coil: number, elapsed: number, ph: ChainPhases, tm: ChainTiming): number {
  const u = frac(elapsed, ph);
  if (u >= 1) return tail(elapsed, ph);
  if (u < tm.loadEnd) return -coil * ramp(u, 0, tm.loadEnd);
  return lerp(-coil, 1, ramp(u, Math.max(tm.loadEnd, tm.shoulderAt), 1));
}

/** The body dip, m (+ = down): sits to `loadDip` by `sitEnd`, stays, drives up from `riseAt` to 0.4 × `dip` above rest at the hit test, settles through the recovery. */
export function chainDip(dip: number, elapsed: number, ph: ChainPhases, tm: ChainTiming): number {
  const u = frac(elapsed, ph);
  if (u >= 1) return lerp(-0.4 * dip, 0, smoothstep(Math.min(1, (elapsed - ph.cock - ph.extend) / Math.max(1e-6, ph.recover))));
  if (u < tm.riseAt) return tm.loadDip * ramp(u, 0, tm.sitEnd);
  return lerp(tm.loadDip, -0.4 * dip, ramp(u, tm.riseAt, 1));
}

/** The leg drive, 0..1: nothing through the load, then the foot pushes as the hips go (heel up, foot turning on its ball, knee in); held and released with the fist. */
export function chainPush(elapsed: number, ph: ChainPhases, tm: ChainTiming): number {
  const u = frac(elapsed, ph);
  if (u >= 1) return tail(elapsed, ph);
  return ramp(u, tm.loadEnd, tm.hipEnd);
}

/** The weight on the punching-side foot, 0..1: goes onto it through the load, comes off it as the hips drive. 0 from the hit test on. */
export function chainLoad(elapsed: number, ph: ChainPhases, tm: ChainTiming): number {
  const u = frac(elapsed, ph);
  if (u >= 1) return 0;
  if (u < tm.loadEnd) return ramp(u, 0, tm.loadEnd);
  return 1 - ramp(u, tm.loadEnd, tm.hipEnd);
}

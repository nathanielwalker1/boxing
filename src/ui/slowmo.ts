/**
 * ui/slowmo.ts — which events start host-side slow motion (main.ts feeds the sim a fraction of each frame).
 * Pure and DOM-free so a Node test and scripts/anim_measure.mjs exercise the very rule the game runs.
 * Anim 2.4 (hitStopV2): in live play there is NO slow motion on a counter, a rock, a finisher or a slip's read
 * window — their weight comes from the sim's frame-based hit-stop. A knockdown keeps its slow fall; the replay
 * is a separate mechanism (main.ts). The sim never sees any of this.
 */
import type { Config, SimEvent } from '../core';

export interface SlowMo { t: number; scale: number }

/** The slow motion running after this frame's events. The slowest wins; none of it stacks. */
export function slowMoAfter(cur: SlowMo, events: readonly SimEvent[], cfg: Config): SlowMo {
  let slowMo = cur;
  const slowTo = (t: number, scale: number): void => { if (t > 0 && (slowMo.t <= 0 || scale <= slowMo.scale)) slowMo = { t, scale }; };
  if (!cfg.hitStopV2) {
    for (const e of events) {
      if (e.type === 'counter') slowTo(cfg.readCounterSlowMoSeconds, cfg.readCounterSlowMo);
      else if (e.type === 'rocked') slowTo(cfg.readRockedSlowMoSeconds, cfg.readRockedSlowMo);
      else if (e.type === 'punchLand' && e.finisher === true && cfg.showFinisherOn) slowTo(cfg.showFinisherSlowMoSeconds, cfg.showFinisherSlowMo);
    }
  }
  if (events.some(e => e.type === 'knockdown')) slowMo = { t: cfg.knockdownSlowMoSeconds, scale: cfg.knockdownSlowMo };
  return slowMo;
}

/** The read window's time scale (ui/read.ts) as the host may use it: off under hitStopV2. */
export function readWindowScale(cfg: Config, readScale: number): number {
  return cfg.hitStopV2 ? 1 : readScale;
}

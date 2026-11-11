/**
 * ui/replay.ts — the knockdown replay's memory. main.ts pushes one frame per
 * sim tick (the state `step` returned — a fresh plain object, never mutated
 * afterwards — that tick's events, and a copy of the referee's drawn state);
 * `clipAround` cuts the seconds round the last knockdown out of it and
 * `ReplayPlayer` walks that clip at a fraction of real time. Nothing here
 * touches the sim: the clip is drawn through the views while the sim waits.
 */
import type { FighterState, SimEvent, SimState } from '../core';

export interface ReplayFrame { state: SimState; events: readonly SimEvent[]; ref: FighterState | null }

export class ReplayBuffer {
  private frames: ReplayFrame[] = [];
  constructor(private cap = 360) {}

  push(f: ReplayFrame): void {
    this.frames.push(f);
    if (this.frames.length > this.cap) this.frames.splice(0, this.frames.length - this.cap);
  }

  clear(): void { this.frames = []; }

  /** `before` ticks up to the most recent knockdown and `after` ticks past it; null when there is none in memory. */
  clipAround(before: number, after: number): { frames: ReplayFrame[]; at: number } | null {
    let k = -1;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i]!.events.some(e => e.type === 'knockdown')) { k = i; break; }
    }
    if (k < 0) return null;
    const from = Math.max(0, k - before), to = Math.min(this.frames.length - 1, k + after);
    return { frames: this.frames.slice(from, to + 1), at: k - from };
  }
}

export class ReplayPlayer {
  /** Position in the clip, in ticks. */
  t = 0;
  private fed = 0;
  constructor(readonly frames: readonly ReplayFrame[], readonly at: number) {}

  get done(): boolean { return this.t >= this.frames.length - 1; }

  /** Advance `ticks` (a fraction) and return the pair to draw, the blend between them, and the events crossed since the last call. */
  advance(ticks: number): { prev: ReplayFrame; next: ReplayFrame; alpha: number; events: SimEvent[] } {
    this.t = Math.min(this.frames.length - 1, this.t + ticks);
    const i = Math.min(this.frames.length - 2, Math.floor(this.t));
    const events: SimEvent[] = [];
    while (this.fed <= i + 1 && this.fed < this.frames.length) events.push(...this.frames[this.fed++]!.events);
    return { prev: this.frames[i]!, next: this.frames[i + 1]!, alpha: Math.min(1, this.t - i), events };
  }
}

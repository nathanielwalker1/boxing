/**
 * ui/fps.ts — frame-time overlay. CONTRACT §11: 60 fps is measured, not
 * assumed; CLAUDE.md rule 9 makes this number part of every render change's
 * report. Exposes `window.__fps` so scripts can read it.
 */

export interface FpsSample { fps: number; msAvg: number; msMax: number; calls: number; tris: number }

declare global {
  interface Window { __fps?: FpsSample }
}

export class FpsOverlay {
  private el: HTMLElement;
  private times: number[] = [];
  private last = performance.now();
  private maxMs = 0;
  sample: FpsSample = { fps: 0, msAvg: 0, msMax: 0, calls: 0, tris: 0 };

  constructor(el: HTMLElement) { this.el = el; }

  set visible(v: boolean) { this.el.hidden = !v; }

  /** Call once per rendered frame with the renderer's info counters. */
  tick(calls: number, tris: number): void {
    const now = performance.now();
    const ms = now - this.last;
    this.last = now;
    this.times.push(ms);
    if (ms > this.maxMs) this.maxMs = ms;
    if (this.times.length >= 60) {
      const avg = this.times.reduce((a, b) => a + b, 0) / this.times.length;
      this.sample = { fps: Math.round(1000 / avg), msAvg: +avg.toFixed(2), msMax: +this.maxMs.toFixed(1), calls, tris };
      window.__fps = this.sample;
      if (!this.el.hidden) {
        this.el.textContent = `${this.sample.fps} fps  ${this.sample.msAvg} ms (max ${this.sample.msMax})\n${calls} calls  ${(tris / 1000).toFixed(1)}k tris`;
      }
      this.times.length = 0;
      this.maxMs = 0;
    }
  }
}

/**
 * ui/read.ts — THE READS (UI workstream): how the player is told what the
 * sim just decided, without words, flashes or frames (Nate, 2026-09-22:
 * "remove the words, the flashing on the screen — too arcadey; Fight Night's
 * is way more subtle"). Everything here is in the world, in time, or at the
 * edge of the eye:
 *
 *   The counter window — the fighter a SLIP has left exposed catches a warm
 *   rim light (the rig draws it, `FighterView.highlight`) at the window's
 *   remaining fraction, and while it is the PLAYER's slip the whole scene
 *   runs at readWindowSlowMo (`timeScale`, read by main.ts) — the beat to
 *   see the opening and step in. The counter landing gets its own slow
 *   motion, a bigger camera push and the sting (main.ts / stage / audio).
 *
 *   Rocked — when YOU are rocked (sim/stun.ts) the frame's edges warm to
 *   red and blur a little, fading as it clears (a DOM radial over the
 *   canvas, no post pass), and the camera's handheld drift grows (main.ts
 *   sets `Stage.wobble` from the same level). The rig sells the rest.
 *
 * Nothing here decides anything: it reads the state every frame.
 * `window.__read` exposes the live values so a browser check can assert on them.
 */
import type { Config, EventBus, FighterView, SimState } from '../core';
import { PUNISH_SLIP, hurtLevel, punishSource } from '../sim';

export interface ReadProbe { glow: [number, number]; hurt: number; timeScale: number; log: string[] }

const CSS = `
#read-hurt { position: fixed; inset: 0; pointer-events: none; z-index: 11; opacity: 0;
  background: radial-gradient(ellipse at 50% 50%, #0000 38%, #7a101088 72%, #a01414cc 100%); }
`;

export class ReadOverlay {
  private glow: [number, number] = [0, 0];
  private hurt = 0;
  private scale = 1;
  private log: string[] = [];   // 'slip' / 'counter' / 'rocked' events seen, in order (tests)
  private hurtEl: HTMLElement;

  constructor(private cfg: Config, bus: EventBus, private views: readonly FighterView[]) {
    bus.on('slip', e => { if (e.dodged) this.log.push(`slip${e.side}`); });
    bus.on('counter', e => this.log.push(`counter${e.side}`));
    bus.on('rocked', e => this.log.push(`rocked${e.side}`));
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.hurtEl = document.createElement('div');
    this.hurtEl.id = 'read-hurt';
    this.hurtEl.hidden = true;
    document.body.appendChild(this.hurtEl);
    window.__read = () => ({ glow: [this.glow[0], this.glow[1]], hurt: this.hurt, timeScale: this.scale, log: [...this.log] });
  }

  /** Per rendered frame: each fighter's exposure-by-slip as the window's remaining fraction; the player's hurt level on the frame. */
  update(s: SimState, off = false): void {
    const c = this.cfg;
    // A menu, a card or a replay is on screen instead of the live fight: no rim, no tint, no slow motion from a state nobody is looking at.
    if (off) {
      for (const v of this.views) { this.glow[v.side] = 0; v.highlight(0); }
      this.scale = 1; this.hurt = 0;
      if (!this.hurtEl.hidden) { this.hurtEl.hidden = true; this.hurtEl.style.backdropFilter = ''; }
      return;
    }
    const span = Math.max(1e-3, c.slipPunishDuration);
    for (const v of this.views) {
      const f = s.fighters[v.side];
      const open = c.readEnabled && !f.down && f.counterWindow > 0 && punishSource(f) === PUNISH_SLIP;
      const g = open ? Math.min(1, f.counterWindow / span) : 0;
      this.glow[v.side] = g;
      v.highlight(g);
    }
    // The player's own slip opened the opponent's window: slow the scene for it.
    this.scale = c.readEnabled && this.glow[1] > 0 && !s.fighters[0].down ? c.readWindowSlowMo : 1;
    // You are rocked.
    const h = c.readEnabled ? hurtLevel(s.fighters[0]) : 0;
    this.hurt = h;
    if (h > 0) {
      this.hurtEl.hidden = false;
      this.hurtEl.style.opacity = String(Math.min(1, h * c.readHurtTint));
      const blur = c.readHurtBlur * h;
      this.hurtEl.style.backdropFilter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
    } else if (!this.hurtEl.hidden) {
      this.hurtEl.hidden = true;
      this.hurtEl.style.backdropFilter = '';
    }
  }

  /** The host time scale the reads ask for this frame (1 = real time). */
  get timeScale(): number { return this.scale; }
}

declare global {
  interface Window { __read: () => ReadProbe }
}

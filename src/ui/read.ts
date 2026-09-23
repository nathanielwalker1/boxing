/**
 * ui/read.ts — THE READ (UI workstream): how the player is told a slip took
 * a punch away and the counter window is open. Second cut (2026-09-22, after
 * Nate's verdict on the first: "remove the words, the flashing on the screen
 * — too arcadey; the yellow frame looks really ugly; Fight Night's is way
 * more subtle"): nothing on the screen at all. The fighter a SLIP has left
 * exposed catches a warm rim light (the rig draws it, `FighterView.highlight`)
 * at the window's remaining fraction, so it fades as the window closes. The
 * sim's freeze on the whiff (slipDodgeHitStop) and the audio (slipNear +
 * counterOpen; the counter sting on the land) are the rest of it.
 *
 * Nothing here decides anything: it reads the punish window off the state
 * (`counterWindow`, and whether a slip opened it) every frame. Both fighters:
 * when the AI slips the player, the player's own rig warms — the same
 * information, the other way round.
 * `window.__read` exposes the live values so a browser check can assert on them.
 */
import type { Config, EventBus, FighterView, SimState } from '../core';
import { PUNISH_SLIP, punishSource } from '../sim';

export interface ReadProbe { glow: [number, number]; log: string[] }

export class ReadOverlay {
  private glow: [number, number] = [0, 0];
  private log: string[] = [];   // 'slip' / 'counter' events seen, in order (tests)

  constructor(private cfg: Config, bus: EventBus, private views: readonly FighterView[]) {
    bus.on('slip', e => { if (e.dodged) this.log.push(`slip${e.side}`); });
    bus.on('counter', e => this.log.push(`counter${e.side}`));
    window.__read = () => ({ glow: [this.glow[0], this.glow[1]], log: [...this.log] });
  }

  /** Per rendered frame: each fighter's exposure-by-slip, as the window's remaining fraction. */
  update(s: SimState): void {
    const c = this.cfg;
    const span = Math.max(1e-3, c.slipPunishDuration);
    for (const v of this.views) {
      const f = s.fighters[v.side];
      const open = c.readEnabled && !f.down && f.counterWindow > 0 && punishSource(f) === PUNISH_SLIP;
      const g = open ? Math.min(1, f.counterWindow / span) : 0;
      this.glow[v.side] = g;
      v.highlight(g);
    }
  }
}

declare global {
  interface Window { __read: () => ReadProbe }
}

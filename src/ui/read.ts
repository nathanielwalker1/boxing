/**
 * ui/read.ts — THE READ (UI workstream): the on-screen cues that tell the
 * player what the sim just decided about a slip, a perfect block and a
 * counter. Fight Night Champion's model (2026-09-22 research): the missed
 * punch freezes for a beat (the sim's slipDodgeHitStop), the counter window
 * is marked, and a landed counter flashes the screen white. Nothing here
 * decides anything: it subscribes to the bus and reads the opponent's
 * counterWindow off the state.
 *
 * Three DOM layers, all pointer-events: none, all hidden when idle so an
 * idle frame costs nothing:
 *   #read-flash  a full-screen white wash that decays over readFlashDecay
 *   #read-glow   an inset edge glow, amber, at the counter window's remaining
 *                fraction — the clock you can see
 *   #read-tag    SLIPPED / PERFECT BLOCK / COUNTER! popped at screen centre
 * Player-centric: side 0's slips, blocks and counters. The AI countering the
 * player already has the sting; a red wash for it is a later call.
 * `window.__read` exposes the live values so a browser check can assert on them.
 */
import type { Config, EventBus, Side, SimState } from '../core';

const PLAYER: Side = 0;

const CSS = `
#read-flash, #read-glow { position: fixed; inset: 0; pointer-events: none; display: none; }
#read-flash { background: #fff; }
#read-glow { box-shadow: inset 0 0 0 0 #ffb43c; }
#read-tag { position: fixed; left: 50%; top: 21%; transform: translate(-50%, -50%) scale(1); pointer-events: none; display: none;
  font: 800 34px/1 system-ui, sans-serif; letter-spacing: 0.12em; color: #fff; text-shadow: 0 0 12px #ffb43c, 0 2px 4px #000c; white-space: nowrap; }
`;

/** `log` is every tag popped in order; `alphas` the wash each one asked for (before decay — a headless frame can be longer than the decay). */
export interface ReadProbe { flash: number; glow: number; tag: string; tagAge: number; log: string[]; alphas: number[] }

export class ReadOverlay {
  private flashEl: HTMLElement;
  private glowEl: HTMLElement;
  private tagEl: HTMLElement;
  private flash = 0;        // current white-wash alpha
  private glow = 0;         // current edge-glow strength 0..1
  private tag = '';
  private tagAge = 0;       // seconds since the tag was popped
  private log: string[] = [];   // every tag popped, in order (tests)
  private alphas: number[] = [];

  constructor(parent: HTMLElement, private cfg: Config, bus: EventBus) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.flashEl = document.createElement('div'); this.flashEl.id = 'read-flash';
    this.glowEl = document.createElement('div'); this.glowEl.id = 'read-glow';
    this.tagEl = document.createElement('div'); this.tagEl.id = 'read-tag';
    parent.append(this.flashEl, this.glowEl, this.tagEl);

    // The slip's second event (dodged: true) is the one that took a punch away.
    bus.on('slip', e => { if (e.side === PLAYER && e.dodged) this.pop(this.cfg.readSlipFlash, 'SLIPPED'); });
    bus.on('perfectBlock', e => { if (e.target === PLAYER) this.pop(this.cfg.readSlipFlash, 'PERFECT BLOCK'); });
    bus.on('counter', e => { if (e.side === PLAYER) this.pop(this.cfg.readCounterFlash, 'COUNTER!'); });

    window.__read = () => this.probe();
  }

  private pop(alpha: number, tag: string): void {
    if (!this.cfg.readEnabled) return;
    this.flash = Math.max(this.flash, alpha);
    this.tag = tag;
    this.tagAge = 0;
    this.log.push(tag);
    this.alphas.push(alpha);
  }

  probe(): ReadProbe { return { flash: this.flash, glow: this.glow, tag: this.tag, tagAge: this.tagAge, log: [...this.log], alphas: [...this.alphas] }; }

  /** Per rendered frame: decay the wash, read the window off the state, age the tag. */
  update(s: SimState, dt: number): void {
    const c = this.cfg;
    if (!c.readEnabled) { this.flash = 0; this.glow = 0; this.tag = ''; this.apply(); return; }
    this.flash = this.flash > 0.002 ? this.flash * Math.exp(-dt / Math.max(0.01, c.readFlashDecay)) : 0;
    // The player's counter window IS the opponent's punish window: the pin the
    // slip (or perfect block) put on their exposure, counting down.
    const opp = s.fighters[PLAYER === 0 ? 1 : 0];
    const span = Math.max(1e-3, Math.max(c.slipPunishDuration, c.perfectBlockPunishDuration));
    const target = opp.counterWindow > 0 && !opp.down ? Math.min(1, opp.counterWindow / span) : 0;
    // Snap up when the window opens, fall with it as it closes.
    this.glow = target > this.glow ? target : target;
    this.tagAge += dt;
    this.apply();
  }

  private apply(): void {
    const c = this.cfg;
    if (this.flash > 0) { this.flashEl.style.display = 'block'; this.flashEl.style.opacity = String(this.flash); }
    else this.flashEl.style.display = 'none';
    if (this.glow > 0) {
      const px = Math.round(c.readGlowWidth * this.glow);
      this.glowEl.style.display = 'block';
      this.glowEl.style.boxShadow = `inset 0 0 ${px * 2}px ${px}px #ffb43c`;
      this.glowEl.style.opacity = String(c.readGlowAlpha * (0.35 + 0.65 * this.glow));
    } else this.glowEl.style.display = 'none';
    const showTag = this.tag !== '' && this.tagAge < c.readTagTime;
    if (showTag) {
      const u = this.tagAge / Math.max(0.01, c.readTagTime);
      const scale = u < 0.15 ? 0.7 + 0.3 * (u / 0.15) : 1;
      const fade = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
      this.tagEl.style.display = 'block';
      this.tagEl.textContent = this.tag;
      this.tagEl.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      this.tagEl.style.opacity = String(fade);
    } else this.tagEl.style.display = 'none';
  }
}

declare global {
  interface Window { __read: () => ReadProbe }
}

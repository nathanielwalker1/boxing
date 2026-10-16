/**
 * ui/hud.ts — the broadcast HUD (CONTRACT §8, Stage 3 restyle). A Fight Night
 * style bar along the bottom of the frame: each fighter's name over a health
 * bar in their trunks colour and a thin stamina bar, a gold plaque in the
 * middle with the clock and "ROUND 1 OF 3", knockdown pips under the names.
 * DOM, not three.js: it never costs a draw call. Reads the sim state each
 * frame; nothing here decides anything.
 *
 * On touch the diamond and joystick own the bottom of the screen, so the
 * same bar sits along the top instead (`layout: 'top'`).
 *
 * The only words it shows are the plaque's state (COUNT n until the referee
 * performs the count, REST, the final KO / TKO / DECISION) — no tags on the
 * fighters; a knockdown reads from the fighter and the camera.
 */
import type { Config, FighterSpec, SimState } from '../core';
import { healthCap } from '../sim';

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; font-family: "Helvetica Neue", Arial, system-ui, sans-serif; color: #f4f1e8; --gold: #d8b45a; --gold-dim: #8a7338; }
#hud .band { position: absolute; left: 0; right: 0; height: 150px; }
#hud.bottom .band { bottom: 0; background: linear-gradient(#0000, #0007 45%, #000c); }
#hud.top .band { top: 0; background: linear-gradient(#000c, #0007 55%, #0000); }
#hud .side { position: absolute; width: min(36vw, 380px); }
#hud.bottom .side { bottom: 26px; } #hud.top .side { top: 18px; }
#hud .side.l { left: 28px; } #hud .side.r { right: 28px; text-align: right; }
#hud .name { font-size: 24px; font-weight: 900; font-style: italic; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1; text-shadow: 0 2px 3px #000c, 0 0 12px #0008; }
#hud .nick { display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); margin: 4px 0 6px; }
#hud .pips { display: inline-block; margin-left: 8px; font-size: 9px; letter-spacing: 3px; color: var(--gold); vertical-align: top; }
#hud .r .pips { margin-left: 0; margin-right: 8px; }
#hud .bar { position: relative; height: 11px; background: #0009; border: 1px solid #fff4; transform: skewX(-14deg); overflow: hidden; }
#hud .bar.stamina { height: 5px; margin-top: 4px; width: 72%; }
#hud .r .bar.stamina { margin-left: auto; }
#hud .fill { position: absolute; inset: 0; transform-origin: left; background: linear-gradient(#fff6, #0000 40%), var(--c, #d8323c); }
#hud .cap { position: absolute; inset: 0; transform-origin: left; background: #ffffff22; }
#hud .r .fill, #hud .r .cap { transform-origin: right; }
#hud .stamina .fill { background: linear-gradient(#fff5, #0000 50%), var(--gold); }
#hud .centre { position: absolute; left: 50%; transform: translateX(-50%); text-align: center; min-width: 118px;
  padding: 6px 18px 7px; background: linear-gradient(#3a2d0c, #15100a 70%, #0a0806); border: 1px solid var(--gold); box-shadow: 0 0 0 1px #000c, 0 4px 14px #000a; }
#hud.bottom .centre { bottom: 30px; } #hud.top .centre { top: 16px; }
#hud .clock { font-size: 26px; font-weight: 800; line-height: 1; color: #f3dc8f; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; text-shadow: 0 1px 0 #000; }
#hud .round { font-size: 9px; font-weight: 700; letter-spacing: 0.2em; color: #e4cf8e; margin-top: 4px; text-transform: uppercase; }
#hud .centre.alert { border-color: #f0e0a0; box-shadow: 0 0 0 1px #000c, 0 0 18px #d8b45a66; }
@media (max-width: 640px) {
  #hud .side { width: 38vw; } #hud .side.l { left: 12px; } #hud .side.r { right: 12px; }
  #hud .name { font-size: 15px; } #hud .nick { display: none; }
  #hud .centre { min-width: 84px; padding: 4px 10px 5px; } #hud .clock { font-size: 18px; }
}
`;

interface SidePanel { health: HTMLElement; cap: HTMLElement; stamina: HTMLElement; pips: HTMLElement }

export class Hud {
  private el: HTMLElement;
  private sides: [SidePanel, SidePanel];
  private centre: HTMLElement;
  private clock: HTMLElement;
  private round: HTMLElement;

  constructor(parent: HTMLElement, specs: readonly [FighterSpec, FighterSpec], private cfg: Config, layout: 'bottom' | 'top' = 'bottom') {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.className = layout;
    const band = document.createElement('div');
    band.className = 'band';
    this.el.appendChild(band);
    const panel = (cls: string, spec: FighterSpec): SidePanel => {
      const root = document.createElement('div');
      root.className = `side ${cls}`;
      root.style.setProperty('--c', spec.trunksPrimary);
      root.innerHTML = `<div class="name">${spec.name}</div>` +
        `<div><span class="nick">"${spec.nickname}"</span><span class="pips"></span></div>` +
        `<div class="bar health"><div class="cap"></div><div class="fill"></div></div>` +
        `<div class="bar stamina"><div class="fill"></div></div>`;
      this.el.appendChild(root);
      return {
        health: root.querySelector('.health .fill')!,
        cap: root.querySelector('.health .cap')!,
        stamina: root.querySelector('.stamina .fill')!,
        pips: root.querySelector('.pips')!,
      };
    };
    this.sides = [panel('l', specs[0]), panel('r', specs[1])];
    this.centre = document.createElement('div');
    this.centre.className = 'centre';
    this.centre.innerHTML = '<div class="clock"></div><div class="round"></div>';
    this.el.appendChild(this.centre);
    this.clock = this.centre.querySelector('.clock')!;
    this.round = this.centre.querySelector('.round')!;
    parent.appendChild(this.el);
  }

  set visible(v: boolean) { this.el.hidden = !v; }

  update(s: SimState): void {
    for (let i = 0; i < 2; i++) {
      const f = s.fighters[i]!, p = this.sides[i]!;
      p.health.style.transform = `scaleX(${f.health})`;
      p.cap.style.transform = `scaleX(${healthCap(f)})`;   // the dim part: what can still come back
      p.stamina.style.transform = `scaleX(${f.stamina})`;
      p.pips.textContent = '●'.repeat(f.knockdowns);
    }
    const ph = s.round.phase;
    // Between rounds the plaque counts the rest down; otherwise it is the round clock.
    const t = Math.max(0, ph === 'between' ? this.cfg.betweenRoundSeconds - s.round.phaseT : s.round.clock);
    this.clock.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    // A fighter still down when the fight is over was counted out (KO) or
    // stopped (TKO): the referee's count tells them apart.
    const down = s.fighters.some(f => f.down);
    const end = down ? (s.round.count >= 10 ? 'KO' : 'TKO') : 'DECISION';
    this.round.textContent =
      ph === 'count' ? `COUNT ${s.round.count}` :
      ph === 'between' ? `REST · ROUND ${s.round.index + 2} NEXT` :
      ph === 'over' ? end :
      `ROUND ${s.round.index + 1} OF ${this.cfg.roundCount}`;
    this.centre.classList.toggle('alert', ph === 'count' || (ph === 'fighting' && s.round.clock <= 10));
  }
}

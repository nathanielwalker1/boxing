/**
 * ui/hud.ts — the fight HUD (CONTRACT §8: minimal). Health + stamina bars in
 * the top corners, round + clock top centre, knockdown pips, and a state tag
 * (DOWN / TKO). DOM, not three.js: it never costs a draw call. Reads the sim
 * state each frame; nothing here decides anything. Stage 3 restyles it.
 */
import type { SimState } from '../core';

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; font: 600 13px/1.2 system-ui, sans-serif; color: #f2f2f2; text-shadow: 0 1px 2px #000a; }
#hud .side { position: absolute; top: 14px; width: min(38vw, 340px); }
#hud .side.l { left: 16px; } #hud .side.r { right: 16px; text-align: right; }
#hud .name { font-size: 14px; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 4px; }
#hud .row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
#hud .r .row { flex-direction: row-reverse; }
#hud .lbl { flex: 0 0 56px; font-size: 9px; letter-spacing: 0.12em; color: #fffb; }
#hud .r .lbl { text-align: left; }
#hud .bar { position: relative; flex: 1 1 auto; height: 10px; background: #0008; border: 1px solid #fff5; border-radius: 2px; overflow: hidden; }
#hud .bar.stamina { height: 6px; }
#hud .fill { position: absolute; inset: 0; transform-origin: left; background: #d8323c; }
#hud .r .fill { transform-origin: right; }
#hud .stamina .fill { background: #e9c14a; }
#hud .pips { height: 8px; font-size: 9px; letter-spacing: 3px; color: #fff9; }
#hud .tag { display: inline-block; margin-top: 4px; padding: 1px 6px; background: #d8323c; color: #fff; border-radius: 2px; font-size: 11px; }
#hud .tag:empty { display: none; }
#hud .centre { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); text-align: center; }
#hud .clock { font-size: 22px; font-variant-numeric: tabular-nums; }
#hud .round { font-size: 11px; letter-spacing: 0.1em; color: #fffb; }
`;

interface SidePanel { root: HTMLElement; health: HTMLElement; stamina: HTMLElement; pips: HTMLElement; tag: HTMLElement }

export class Hud {
  private el: HTMLElement;
  private sides: [SidePanel, SidePanel];
  private clock: HTMLElement;
  private round: HTMLElement;

  constructor(parent: HTMLElement, names: readonly [string, string]) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.id = 'hud';
    const panel = (cls: string, name: string): SidePanel => {
      const root = document.createElement('div');
      root.className = `side ${cls}`;
      root.innerHTML = `<div class="name">${name}</div>` +
        `<div class="row"><span class="lbl">HEALTH</span><div class="bar health"><div class="fill"></div></div></div>` +
        `<div class="row"><span class="lbl">STAMINA</span><div class="bar stamina"><div class="fill"></div></div></div>` +
        `<div class="pips"></div><span class="tag"></span>`;
      this.el.appendChild(root);
      return {
        root,
        health: root.querySelector('.health .fill')!,
        stamina: root.querySelector('.stamina .fill')!,
        pips: root.querySelector('.pips')!,
        tag: root.querySelector('.tag')!,
      };
    };
    this.sides = [panel('l', names[0]), panel('r', names[1])];
    const centre = document.createElement('div');
    centre.className = 'centre';
    centre.innerHTML = '<div class="clock"></div><div class="round"></div>';
    this.el.appendChild(centre);
    this.clock = centre.querySelector('.clock')!;
    this.round = centre.querySelector('.round')!;
    parent.appendChild(this.el);
  }

  set visible(v: boolean) { this.el.hidden = !v; }

  update(s: SimState): void {
    const tko = s.round.phase === 'over' && s.fighters.some(f => f.down);
    for (let i = 0; i < 2; i++) {
      const f = s.fighters[i]!, p = this.sides[i]!;
      p.health.style.transform = `scaleX(${f.health})`;
      p.stamina.style.transform = `scaleX(${f.stamina})`;
      p.pips.textContent = '●'.repeat(f.knockdowns);
      p.tag.textContent = f.down ? (tko ? 'TKO' : 'DOWN') : f.stamina < 0.25 ? 'GASSED' : '';
    }
    const t = Math.max(0, s.round.clock);
    this.clock.textContent = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    this.round.textContent = s.round.phase === 'count' ? 'COUNT' : s.round.phase === 'over' ? 'OVER' : `ROUND ${s.round.index + 1}`;
  }
}

/**
 * ui/flow.ts — the fight flow (CONTRACT §8 fight loop, UI half; Stage 3).
 * The screens around a fight, as DOM overlays on the live scene:
 *
 *   menu ─▶ select ─▶ intro (tale of the tape, sim held) ─bell─▶ fight
 *   fight: the sim runs; a lower-third marks the end of each round
 *   fight ─over + a beat─▶ results (winner, method, the scorecard) ─▶ rematch | menu
 *
 * `holdsSim` is true on every screen but the fight. main.ts owns the sim and
 * the views: the flow asks it to start a fight through `hooks.start` and
 * rings the first bell through `hooks.bell`. Keyboard: arrows / A D move,
 * Enter / Space / J confirm, Escape back. Touch: the buttons.
 *
 * The method of victory (KO / TKO / decision) comes from the sim's events,
 * not from guessing at the state.
 */
import type { Config, FighterSpec, SimEvent, SimState } from '../core';
import type { EventBus } from '../core';

export type Screen = 'menu' | 'select' | 'intro' | 'fight' | 'results';

const CSS = `
#flow { position: fixed; inset: 0; z-index: 12; pointer-events: none; font-family: "Helvetica Neue", Arial, system-ui, sans-serif; color: #f4f1e8; --gold: #d8b45a; }
#flow .screen { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; }
#flow .screen.on { display: flex; }
#flow .dim { background: radial-gradient(ellipse at 50% 40%, #0008, #000d); pointer-events: auto; }
#flow .wordmark { font-size: clamp(44px, 9vw, 96px); font-weight: 900; font-style: italic; letter-spacing: 0.02em; line-height: 0.95; text-shadow: 0 4px 0 #000, 0 0 40px #d8b45a55; }
#flow .wordmark small { display: block; font-size: 0.18em; font-style: normal; letter-spacing: 0.5em; color: var(--gold); margin-top: 10px; }
#flow .btns { display: flex; gap: 14px; margin-top: 36px; }
#flow .btn { pointer-events: auto; cursor: pointer; min-width: 180px; padding: 12px 26px; text-align: center; font-size: 15px; font-weight: 800; letter-spacing: 0.22em; text-transform: uppercase;
  background: linear-gradient(#3a2d0c, #15100a 70%, #0a0806); border: 1px solid var(--gold); color: #f3dc8f; box-shadow: 0 0 0 1px #000c, 0 4px 14px #000a; user-select: none; }
#flow .btn.sel, #flow .btn:hover { background: linear-gradient(#e9cf7a, #c9a24a 60%, #a8842f); color: #1a1206; border-color: #fff2c0; }
#flow .hint { margin-top: 22px; font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase; color: #fff8; }
#flow .cards { display: flex; gap: 22px; align-items: stretch; }
#flow .card { pointer-events: auto; cursor: pointer; width: min(300px, 40vw); padding: 18px 20px 16px; border: 1px solid #fff3; background: #0a0a0ccc; box-shadow: 0 10px 30px #000a; transition: transform .12s; }
#flow .card.sel { border-color: var(--gold); box-shadow: 0 0 0 1px var(--gold), 0 10px 30px #000a; transform: translateY(-6px); }
#flow .card .swatch { height: 6px; margin: -18px -20px 14px; background: var(--c); }
#flow .fname { font-size: 22px; font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.03em; line-height: 1; }
#flow .fnick { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--gold); margin-top: 5px; }
#flow .fmeta { font-size: 11px; color: #fffa; margin-top: 10px; line-height: 1.6; }
#flow .ratings { margin-top: 10px; display: grid; grid-template-columns: 34px 1fr; gap: 3px 8px; font-size: 9px; letter-spacing: 0.15em; color: #fff9; align-items: center; }
#flow .ratings .bar { height: 5px; background: #0009; border: 1px solid #fff3; }
#flow .ratings .fill { height: 100%; background: var(--gold); }
#flow .title { font-size: 12px; letter-spacing: 0.4em; text-transform: uppercase; color: var(--gold); margin-bottom: 18px; }
#flow .tape { display: grid; grid-template-columns: 1fr 120px 1fr; align-items: center; gap: 6px 18px; width: min(820px, 94vw); padding: 22px 28px 20px; background: linear-gradient(#000c, #000e); border-top: 1px solid var(--gold); border-bottom: 1px solid var(--gold); }
#flow .tape .l { text-align: right; } #flow .tape .r { text-align: left; }
#flow .tape .fname { font-size: clamp(18px, 3.4vw, 34px); }
#flow .tape .vs { text-align: center; font-size: 30px; font-weight: 900; font-style: italic; color: var(--gold); }
#flow .tape .lbl { text-align: center; font-size: 9px; letter-spacing: 0.3em; color: #fff8; }
#flow .tape .val { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
#flow .tape .hometown { font-size: 11px; color: #fffa; letter-spacing: 0.1em; margin-top: 4px; }
#flow .tape .bout { grid-column: 1 / -1; text-align: center; font-size: 10px; letter-spacing: 0.3em; color: var(--gold); margin-top: 10px; }
#flow .third { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); padding: 10px 34px; background: linear-gradient(#000c, #000e); border-top: 1px solid var(--gold); border-bottom: 1px solid var(--gold);
  font-size: 18px; font-weight: 900; font-style: italic; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0; transition: opacity .35s; white-space: nowrap; }
#flow .third.on { opacity: 1; }
#flow .winner { font-size: clamp(30px, 6vw, 60px); font-weight: 900; font-style: italic; text-transform: uppercase; letter-spacing: 0.02em; line-height: 1; text-align: center; text-shadow: 0 4px 0 #000; }
#flow .method { margin-top: 10px; font-size: 13px; letter-spacing: 0.35em; text-transform: uppercase; color: var(--gold); text-align: center; }
#flow table { margin-top: 26px; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
#flow th, #flow td { padding: 5px 12px; text-align: center; border-bottom: 1px solid #fff2; }
#flow th { font-size: 9px; letter-spacing: 0.25em; color: #fff8; font-weight: 700; }
#flow td.n { text-align: left; font-weight: 800; font-style: italic; text-transform: uppercase; }
#flow td.t { font-weight: 800; color: var(--gold); }
@media (max-width: 640px) {
  #flow .cards { flex-direction: column; gap: 10px; } #flow .card { width: 86vw; padding: 12px 16px; } #flow .ratings { display: none; }
  #flow .tape { grid-template-columns: 1fr 60px 1fr; padding: 12px 10px; } #flow .tape .vs { font-size: 18px; }
  #flow .btns { flex-direction: column; gap: 8px; } #flow .btn { min-width: 220px; }
}
`;

export interface FlowHooks {
  /** Start a fresh fight, the player as side 0. */
  start(player: FighterSpec, opponent: FighterSpec): void;
  /** The opening bell (the sim emits bells for later rounds; the first is the flow's). */
  bell(): void;
}

type Method = { kind: 'ko' | 'tko'; winner: 0 | 1; round: number } | { kind: 'decision'; winner: 0 | 1 | null; cards: [number, number][] };

export class FightFlow {
  screen: Screen = 'menu';
  private el: HTMLElement;
  private screens: Record<Screen, HTMLElement>;
  private third: HTMLElement;
  private cursor = 0;          // the selected button / card on the current screen
  private pick = 0;            // roster index of the player's fighter
  private fighters: [FighterSpec, FighterSpec];
  private introT = 0;
  private overT = 0;
  private thirdT = 0;
  private lastRound = -1;
  private method: Method | null = null;
  private seenPhase: SimState['round']['phase'] = 'fighting';

  constructor(parent: HTMLElement, private roster: readonly FighterSpec[], private cfg: Config, bus: EventBus, private hooks: FlowHooks) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.id = 'flow';
    const mk = (cls: string): HTMLElement => { const d = document.createElement('div'); d.className = `screen ${cls}`; this.el.appendChild(d); return d; };
    this.screens = { menu: mk('dim menu'), select: mk('dim select'), intro: mk('intro'), fight: mk('fight'), results: mk('dim results') };
    this.third = document.createElement('div');
    this.third.className = 'third';
    this.screens.fight.appendChild(this.third);
    parent.appendChild(this.el);
    this.fighters = [roster[0]!, roster[1 % roster.length]!];

    bus.on('ko', e => { this.method = { kind: 'ko', winner: e.winner, round: this.lastRound }; });
    bus.on('tko', e => { this.method = { kind: 'tko', winner: e.winner, round: this.lastRound }; });
    bus.on('decision', e => { this.method = { kind: 'decision', winner: e.winner, cards: e.cards }; });
    window.addEventListener('keydown', e => this.onKey(e));
    this.show('menu');
  }

  /** True on every screen but the fight: main.ts does not step the sim. */
  get holdsSim(): boolean { return this.screen !== 'fight'; }
  /** The HUD belongs to the fight and the results only. */
  get showHud(): boolean { return this.screen === 'fight' || this.screen === 'results'; }

  // ── Screens ────────────────────────────────────────────────────────────────

  private show(screen: Screen): void {
    this.screen = screen;
    this.cursor = 0;
    for (const k of Object.keys(this.screens) as Screen[]) this.screens[k].classList.toggle('on', k === screen);
    if (screen === 'menu') this.renderMenu();
    else if (screen === 'select') this.renderSelect();
    else if (screen === 'intro') { this.introT = 0; this.renderIntro(); }
    else if (screen === 'results') this.renderResults();
  }

  private button(label: string, onPick: () => void): HTMLElement {
    const b = document.createElement('div');
    b.className = 'btn';
    b.textContent = label;
    b.addEventListener('pointerdown', e => { e.preventDefault(); onPick(); });
    return b;
  }

  private renderMenu(): void {
    const s = this.screens.menu;
    s.innerHTML = '<div class="wordmark">BOXING<small>MAIN EVENT</small></div><div class="btns"></div><div class="hint">Enter to select</div>';
    s.querySelector('.btns')!.append(this.button('Fight', () => this.show('select')));
    this.syncCursor(s, '.btn');
  }

  private renderSelect(): void {
    const s = this.screens.select;
    s.innerHTML = '<div class="title">Choose your fighter</div><div class="cards"></div><div class="btns"></div><div class="hint">← → to choose · Enter to confirm · Esc back</div>';
    const cards = s.querySelector('.cards')!;
    this.roster.forEach((f, i) => {
      const c = document.createElement('div');
      c.className = 'card';
      c.style.setProperty('--c', f.trunksPrimary);
      c.innerHTML = `<div class="swatch"></div><div class="fname">${f.name}</div><div class="fnick">"${f.nickname}"</div>` +
        `<div class="fmeta">${f.hometown} · ${f.stance} · ${styleName(f.style)}<br>${f.heightM.toFixed(2)} m · ${Math.round(f.reachM * 100)} cm reach · ${f.massKg} kg</div>` +
        `<div class="ratings">${(['power', 'speed', 'chin', 'stamina', 'defense'] as const).map(k => `<span>${k.slice(0, 3).toUpperCase()}</span><div class="bar"><div class="fill" style="width:${f[k]}%"></div></div>`).join('')}</div>`;
      c.addEventListener('pointerdown', e => { e.preventDefault(); this.pick = i; this.confirmPick(); });
      cards.appendChild(c);
    });
    this.cursor = this.pick;
    s.querySelector('.btns')!.append(this.button('Back', () => this.show('menu')));
    this.syncCursor(s, '.card');
  }

  private confirmPick(): void {
    const n = this.roster.length;
    this.fighters = [this.roster[this.pick]!, this.roster[(this.pick + 1) % n]!];
    this.method = null;
    this.lastRound = 0;
    this.hooks.start(this.fighters[0], this.fighters[1]);
    this.show('intro');
  }

  private renderIntro(): void {
    const [a, b] = this.fighters;
    const s = this.screens.intro;
    const col = (f: FighterSpec, side: 'l' | 'r') => `<div class="${side}"><div class="fname">${f.name}</div><div class="fnick">"${f.nickname}"</div><div class="hometown">${f.hometown.toUpperCase()}</div></div>`;
    const row = (lbl: string, va: string, vb: string) => `<div class="l val">${va}</div><div class="lbl">${lbl}</div><div class="r val">${vb}</div>`;
    s.innerHTML = `<div class="title">Tale of the tape</div><div class="tape">` +
      col(a, 'l') + '<div class="vs">VS</div>' + col(b, 'r') +
      row('HEIGHT', `${a.heightM.toFixed(2)} m`, `${b.heightM.toFixed(2)} m`) +
      row('REACH', `${Math.round(a.reachM * 100)} cm`, `${Math.round(b.reachM * 100)} cm`) +
      row('WEIGHT', `${a.massKg} kg`, `${b.massKg} kg`) +
      row('STYLE', styleName(a.style), styleName(b.style)) +
      `<div class="bout">${this.cfg.roundCount} ROUNDS · ${clockText(this.cfg.roundSeconds)} EACH</div></div>` +
      '<div class="hint">Enter to skip</div>';
  }

  private startFight(): void {
    this.show('fight');
    this.hooks.bell();
  }

  private renderResults(): void {
    const [a, b] = this.fighters;
    const s = this.screens.results;
    const m = this.method;
    const winner = m ? m.winner : null;
    const name = winner === null ? 'DRAW' : this.fighters[winner].name;
    let how = '';
    if (!m) how = '';
    else if (m.kind === 'ko') how = `WINS BY KNOCKOUT · ROUND ${m.round + 1}`;
    else if (m.kind === 'tko') how = `WINS BY TKO · ROUND ${m.round + 1}`;
    else how = winner === null ? 'THE JUDGES SCORE IT EVEN' : 'WINS ON POINTS';
    const cards = m && m.kind === 'decision' ? m.cards : null;
    let table = '';
    if (cards && cards.length) {
      const tot = cards.reduce((t, c) => [t[0] + c[0], t[1] + c[1]], [0, 0]);
      table = `<table><tr><th></th>${cards.map((_, i) => `<th>R${i + 1}</th>`).join('')}<th>TOTAL</th></tr>` +
        `<tr><td class="n">${a.name}</td>${cards.map(c => `<td>${c[0]}</td>`).join('')}<td class="t">${tot[0]}</td></tr>` +
        `<tr><td class="n">${b.name}</td>${cards.map(c => `<td>${c[1]}</td>`).join('')}<td class="t">${tot[1]}</td></tr></table>`;
    }
    s.innerHTML = `<div class="winner">${name}</div><div class="method">${how}</div>${table}<div class="btns"></div><div class="hint">Enter to select</div>`;
    s.querySelector('.btns')!.append(
      this.button('Rematch', () => this.confirmPick()),
      this.button('Main menu', () => this.show('menu')),
    );
    this.syncCursor(s, '.btn');
  }

  private syncCursor(s: HTMLElement, sel: string): void {
    s.querySelectorAll(sel).forEach((n, i) => n.classList.toggle('sel', i === this.cursor));
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    if (this.screen === 'fight') return;
    const confirm = e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyJ' || e.code === 'NumpadEnter';
    const back = e.code === 'Escape';
    const dir = e.code === 'ArrowLeft' || e.code === 'KeyA' ? -1 : e.code === 'ArrowRight' || e.code === 'KeyD' ? 1 : 0;
    if (!confirm && !back && !dir) return;
    e.preventDefault();
    if (this.screen === 'menu') {
      if (confirm) this.show('select');
    } else if (this.screen === 'select') {
      if (dir) { this.pick = (this.pick + dir + this.roster.length) % this.roster.length; this.cursor = this.pick; this.syncCursor(this.screens.select, '.card'); }
      else if (confirm) this.confirmPick();
      else if (back) this.show('menu');
    } else if (this.screen === 'intro') {
      if (confirm) this.startFight();
      else if (back) this.show('select');
    } else if (this.screen === 'results') {
      if (dir) { this.cursor = (this.cursor + dir + 2) % 2; this.syncCursor(this.screens.results, '.btn'); }
      else if (confirm) { if (this.cursor === 0) this.confirmPick(); else this.show('menu'); }
      else if (back) this.show('menu');
    }
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(s: SimState, dt: number, events: readonly SimEvent[]): void {
    if (this.screen === 'intro') {
      this.introT += dt;
      if (this.introT >= this.cfg.introSeconds) this.startFight();
      return;
    }
    if (this.screen !== 'fight') return;
    const ph = s.round.phase;
    if (ph === 'fighting') this.lastRound = s.round.index;
    // The lower-third: the end of a round, the next round's start, the count.
    for (const e of events) {
      if (e.type === 'roundEnd') this.lowerThird(`End of round ${e.index + 1}`);
      else if (e.type === 'roundStart' && e.index > 0) this.lowerThird(`Round ${e.index + 1}`);
    }
    this.thirdT -= dt;
    if (this.thirdT <= 0 && this.third.classList.contains('on')) this.third.classList.remove('on');
    // The results come a beat after the fight ends, so the last moment plays out.
    if (ph === 'over') {
      if (this.seenPhase !== 'over') this.overT = 0;
      this.overT += dt;
      if (this.overT >= this.cfg.resultsDelaySeconds) this.show('results');
    }
    this.seenPhase = ph;
  }

  private lowerThird(text: string): void {
    this.third.textContent = text;
    this.third.classList.add('on');
    this.thirdT = this.cfg.lowerThirdSeconds;
  }
}

function styleName(s: FighterSpec['style']): string {
  return { pressure: 'Pressure', counter: 'Counter-puncher', outboxer: 'Out-boxer', swarmer: 'Swarmer', slugger: 'Slugger' }[s];
}

function clockText(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

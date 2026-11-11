/**
 * ui/flow.ts — everything round a fight (CONTRACT §8, UI half; overhaul
 * 2026-11-11, docs/OVERHAUL_UI.md). DOM over the live 3D scene; the ring is
 * the background of every screen.
 *
 *   title ─▶ select ─▶ opponent ─▶ walk (ring walk, name cards, stare-down) ─bell─▶ fight
 *   title ─▶ ladder (select first time) ─▶ walk ─▶ fight ─▶ results ─▶ ladder … ─▶ champion
 *   title ─▶ gym ─▶ fight (a drill, no cards) ─Esc─▶ gym
 *   title ─▶ controls
 *   fight: pause (Esc / Start) · the corner card between rounds · the REPLAY bug
 *   fight ─over + a beat─▶ results ─▶ rematch | new fight | menu
 *
 * main.ts owns the sim, the views and the replay; the flow asks for things
 * through `FlowHooks`, says whether the sim is held (`holdsSim`), and hands
 * back what to draw on a menu (`scene`, from ui/director.ts). It never writes
 * sim state. Keyboard: arrows / WASD, Enter / Space, Esc, R. Pad: d-pad /
 * stick, A, B, Start. Touch and mouse: every button and plate.
 *
 * During the fight itself it shows no words about the action: the round
 * lower-third at a bell, the corner card in the rest, and the replay bug.
 */
import { NULL_INPUT, cloneInput, generateFighter, seedRng, type Config, type EventBus, type FighterSpec, type FrameInput, type RngState, type SimEvent, type SimState } from '../core';
import { step } from '../sim';
import { FLOW_CSS } from './flowCss';
import { Director, type Scene, type WalkBeat } from './director';
import { styleInfo } from './styleInfo';
import { FREE_SPARRING, loadDrills, type Drill, type DrillMetric } from './drills';
import { FightStats, PUNCHES, advice, landedOf, thrownOf, type SideStats } from './stats';
import { DIFFICULTY_NAMES, ladderDifficulty, ladderFighter, ladderOrder, loadLadder, saveLadder, type LadderSave } from './ladder';
import { controlsHtml } from './controls';
import { accent } from './accent';

export type Screen = 'title' | 'select' | 'opponent' | 'ladder' | 'gym' | 'controls' | 'walk' | 'fight' | 'results' | 'champion';
export type Mode = 'fight' | 'ladder' | 'gym';

export interface StartOpts {
  /** 0 easy, 1 medium, 2 hard. */
  difficulty: number;
  /** Drives the opponent instead of the AI (a drill); may return null to hand a tick back to the AI. */
  driver: ((s: SimState) => FrameInput | null) | null;
  /** Runs on the fresh state before the first live tick (a drill's placement and setup). */
  prepare: ((s: SimState) => SimState) | null;
}

export interface FlowHooks {
  /** Start a fresh fight, the player as side 0. */
  start(player: FighterSpec, opponent: FighterSpec, opts: StartOpts): void;
  /** Build this fighter's body in view slot 0 (the turntable). */
  preview(spec: FighterSpec): void;
  /** The opening bell (the sim emits bells for later rounds; the first is the flow's). */
  bell(): void;
  /** Run the sim's rest between rounds off now (the corner card has gone). */
  skipRest(): void;
  /** Stop the knockdown replay now. */
  skipReplay(): void;
  /** Pin the crowd's excitement (null = hand it back to the fight); `cheer` adds a roar now. */
  crowd(level: number | null, cheer: boolean): void;
}

declare global {
  interface Window {
    /** The flow's state, for scripts (flow_check, flow_look). */
    __flow?: { state: () => { screen: Screen; mode: Mode | null; paused: boolean; card: boolean; replay: boolean; beat: WalkBeat; drill: string | null; drillStat: string; player: string; opponent: string; ladder: LadderSave | null; /** Whose body is in view slot 0 (the turntable). */ shown: string };
      /** Scripts only: the next fights use `count` rounds of `seconds` whatever the menu says (count 0 = back to the menu's choice). */
      rounds: (count: number, seconds: number) => void;
    };
  }
}

type Method = { kind: 'ko' | 'tko'; winner: 0 | 1; round: number } | { kind: 'decision'; winner: 0 | 1 | null; cards: [number, number][] };
type Act = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'r' | 'any' | 'start';
interface Btn { el: HTMLElement; act: () => void }

const ROUNDS: readonly (readonly [number, number])[] = [[3, 30], [3, 60], [6, 60]];
const SCREENS: readonly Screen[] = ['title', 'select', 'opponent', 'ladder', 'gym', 'controls', 'walk', 'fight', 'results', 'champion'];
const RATINGS = ['power', 'speed', 'chin', 'stamina', 'defense'] as const;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clockText = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const lastName = (f: FighterSpec): string => f.name.split(' ').slice(1).join(' ') || f.name;

const tapeLine = (f: FighterSpec): string => `${f.heightM.toFixed(2)} m · ${Math.round(f.reachM * 100)} cm reach · ${f.massKg} kg · ${styleInfo(f).name}`;

export class FightFlow {
  screen: Screen = 'title';
  mode: Mode | null = null;
  /** Set by main.ts each frame: the knockdown replay is on screen / is about to be. */
  replaying = false;
  replayDue = false;

  private el: HTMLElement;
  private screens = {} as Record<Screen, HTMLElement>;
  private director: Director;
  private stats = new FightStats();
  private btns: Btn[] = [];
  private cursor = 0;

  private player: FighterSpec;
  private opp: FighterSpec;
  private sel = 0;                      // index into entries() on select / opponent
  private seeds: [number, number] = [2026, 4051];   // the random slot's seed, as player and as opponent
  private optRow = 0;                   // opponent screen: 0 the strip, 1 difficulty, 2 rounds
  private difficulty = 1;
  private roundsIdx = 1;                // 3 × 60 s
  private previewWant: FighterSpec | null = null;
  private previewT = 0;

  private ladder: LadderSave | null = null;
  private ladderWon = false;
  private drills: Drill[] = [FREE_SPARRING];
  private drill: { def: Drill; rng: RngState; tick: number; acc: Record<string, unknown>; doneT: number; last: DrillMetric } | null = null;
  private keptRounds: [number, number] | null = null;

  private method: Method | null = null;
  private last: SimState | null = null;
  private lastRound = 0;
  private overT = 0;
  private seenPhase: SimState['round']['phase'] = 'fighting';
  private third!: HTMLElement;
  private thirdT = 0;
  private cardEl!: HTMLElement;
  private card = false;
  private cardT = 0;
  private cardRound = -1;
  private paused = false;
  private pauseView: 'menu' | 'controls' = 'menu';
  private pauseEl!: HTMLElement;
  private bug!: HTMLElement;
  private skipzone!: HTMLElement;
  private drillEl!: HTMLElement;
  private pauseBtn!: HTMLElement;
  private beat: WalkBeat = 'done';
  private controlsBack: Screen = 'title';
  private pad: Record<string, boolean> = {};
  private menuClass = false;
  private roundsOverride: [number, number] | null = null;   // scripts only: short rounds

  constructor(parent: HTMLElement, private roster: readonly FighterSpec[], private cfg: Config, bus: EventBus, private hooks: FlowHooks, touch = false) {
    const style = document.createElement('style');
    style.textContent = FLOW_CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.id = 'flow';
    if (touch) this.el.classList.add('touch');
    for (const k of SCREENS) {
      const d = document.createElement('div');
      d.className = `screen ${k}`;
      this.el.appendChild(d);
      this.screens[k] = d;
    }
    this.buildFight();
    this.screens.walk.addEventListener('pointerdown', e => { e.preventDefault(); this.act('ok'); });
    parent.appendChild(this.el);
    this.player = roster[0]!;
    this.opp = roster[1 % roster.length]!;
    this.director = new Director(cfg, [this.player, this.opp]);

    bus.on('ko', e => { this.method = { kind: 'ko', winner: e.winner, round: this.lastRound }; });
    bus.on('tko', e => { this.method = { kind: 'tko', winner: e.winner, round: this.lastRound }; });
    bus.on('decision', e => { this.method = { kind: 'decision', winner: e.winner, cards: e.cards }; });
    window.addEventListener('keydown', e => this.onKey(e));
    void loadDrills().then(d => { this.drills = [...d, FREE_SPARRING]; if (this.screen === 'gym') this.show('gym'); });
    window.__flow = {
      state: () => ({
        screen: this.screen, mode: this.mode, paused: this.paused, card: this.card, replay: this.replaying, beat: this.beat,
        drill: this.drill ? this.drill.def.id : null, drillStat: this.drill ? this.drill.last.stat : '',
        player: this.player.id, opponent: this.opp.id, ladder: this.ladder ? { ...this.ladder } : null,
        shown: this.director.slots[0].id,
      }),
      rounds: (count, seconds) => { this.roundsOverride = count > 0 ? [count, seconds] : null; },
    };
    this.show('title');
  }

  // ── What main.ts reads ─────────────────────────────────────────────────────

  /** True whenever the sim must wait: every screen but the fight, the pause, the corner card. */
  get holdsSim(): boolean { return this.screen !== 'fight' || this.paused || this.card; }
  /** The HUD belongs to the fight alone (the cards carry their own numbers). */
  get showHud(): boolean { return this.screen === 'fight' && !this.card; }
  /** A knockdown may be replayed (a real fight, not a drill, nothing else up). */
  get wantsReplay(): boolean { return this.screen === 'fight' && this.mode !== 'gym' && !this.paused && !this.card; }
  /** A drill has no referee: he only gets in the way of what is being practised. */
  get hidesReferee(): boolean { return this.drill !== null; }
  /** The round and the clock belong on the hanging scoreboard. */
  get inFight(): boolean { return this.screen === 'fight' || this.screen === 'results'; }

  /** What to draw instead of the live fight (a menu, the walk, the corner card), or null. */
  scene(dt: number): Scene | null {
    switch (this.screen) {
      case 'title': case 'gym': case 'controls': return this.director.wide(dt);
      case 'select': case 'opponent': case 'ladder': case 'champion': return this.director.turntable(dt);
      case 'walk': return this.director.walkScene(dt);
      case 'fight': return this.card ? this.director.corners(this.paused ? 0 : dt) : null;
      default: return null;
    }
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  private show(screen: Screen): void {
    this.screen = screen;
    this.cursor = 0;
    this.btns = [];
    for (const k of SCREENS) this.screens[k].classList.toggle('on', k === screen);
    if (screen !== 'fight') { this.paused = false; this.card = false; this.syncFight(); }
    if (screen === 'title') this.renderTitle();
    else if (screen === 'select' || screen === 'opponent') this.renderSelect();
    else if (screen === 'ladder') this.renderLadder();
    else if (screen === 'gym') this.renderGym();
    else if (screen === 'controls') this.renderControls();
    else if (screen === 'results') this.renderResults();
    else if (screen === 'champion') this.renderChampion();
  }

  private setBtns(box: Element, defs: readonly (readonly [string, () => void, boolean?])[], keep = false): void {
    if (!keep) this.btns = [];
    for (const [label, act, quiet] of defs) {
      const b = document.createElement('div');
      b.className = quiet ? 'btn quiet' : 'btn';
      b.textContent = label;
      b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); act(); });
      box.appendChild(b);
      this.btns.push({ el: b, act });
    }
    this.syncBtns();
  }

  private syncBtns(): void { this.btns.forEach((b, i) => b.el.classList.toggle('sel', i === this.cursor)); }

  private renderTitle(): void {
    this.mode = null;
    const s = this.screens.title;
    s.innerHTML = '<div class="titlebox"><div class="wordmark">LONG<br>COUNT<small>MAIN EVENT BOXING</small></div><div class="menu"></div><div class="foot">Arrows to choose · Enter to select</div></div>';
    this.setBtns(s.querySelector('.menu')!, [
      ['Fight', () => { this.mode = 'fight'; this.show('select'); }],
      ['Ladder', () => this.openLadder()],
      ['Gym', () => this.show('gym')],
      ['Controls', () => { this.controlsBack = 'title'; this.show('controls'); }],
    ]);
  }

  // ── Select / opponent ──────────────────────────────────────────────────────

  private get picking(): 0 | 1 { return this.screen === 'opponent' ? 1 : 0; }
  private entries(): FighterSpec[] { return [...this.roster, generateFighter(this.seeds[this.picking])]; }
  private isOff(f: FighterSpec): boolean { return this.screen === 'opponent' && f.id === this.player.id; }

  private infoHtml(f: FighterSpec): string {
    const st = styleInfo(f);
    return `<div class="fname">${esc(f.name)}</div><div class="fnick">"${esc(f.nickname)}"</div>` +
      `<div class="fmeta">${esc(f.hometown)} · ${cap(f.stance)}</div>` +
      `<div class="vitals"><div><b>${f.heightM.toFixed(2)} m</b><span>Height</span></div><div><b>${Math.round(f.reachM * 100)} cm</b><span>Reach</span></div><div><b>${f.massKg} kg</b><span>Weight</span></div></div>` +
      `<div class="ratings">${RATINGS.map(k => `<span>${k}</span><div class="bar"><div class="fill" style="width:${f[k]}%"></div></div><i>${f[k]}</i>`).join('')}</div>` +
      `<div class="style"><div class="sname">${esc(st.name)}</div><div class="blurb">${esc(st.blurb)}</div><ul>${st.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
  }

  private setAccent(el: HTMLElement, f: FighterSpec): void {
    const [c, c2] = accent(f);
    el.style.setProperty('--c', c); el.style.setProperty('--c2', c2);
  }

  private renderSelect(): void {
    const s = this.screens[this.screen];
    const opp = this.screen === 'opponent';
    if (opp) {
      while (this.seeds[1] === this.seeds[0] || this.player.id === `gen-${this.seeds[1]}`) this.seeds[1] = this.reroll(this.seeds[1]);
    }
    const list = this.entries();
    if (opp) { this.optRow = 0; this.sel = Math.max(0, list.findIndex(f => f.id === this.opp.id)); if (this.isOff(list[this.sel]!)) this.sel = (this.sel + 1) % list.length; }
    else this.sel = Math.max(0, list.findIndex(f => f.id === this.player.id));
    s.innerHTML = `<div class="head">${opp ? 'Choose your opponent' : this.mode === 'ladder' ? 'Ladder · choose your fighter' : 'Choose your fighter'}</div>` +
      '<div class="panel info"></div><div class="strip"></div>' +
      `<div class="hint">${opp ? '← → fighter · ↑ ↓ difficulty and rounds · Enter fight · Esc back' : '← → choose · Enter select · R re-roll the random fighter · Esc back'}</div>`;
    const strip = s.querySelector('.strip')!;
    list.forEach((f, i) => {
      const p = document.createElement('div');
      const random = i === list.length - 1;
      p.className = `plate${this.isOff(f) ? ' off' : ''}`;
      this.setAccent(p, f);
      p.innerHTML = `<div class="sw"></div><div class="pn">${random ? 'Random' : esc(lastName(f))}</div><div class="ps">${random ? 'A new fighter' : esc(styleInfo(f).name)}</div>`;
      p.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (this.isOff(f)) return;
        if (this.sel === i) this.confirmSelect(); else { this.sel = i; this.optRow = 0; this.fillSelect(); }
      });
      strip.appendChild(p);
    });
    this.fillSelect();
  }

  /** The info panel, the plate highlight and the turntable for the current pick. */
  private fillSelect(): void {
    const s = this.screens[this.screen];
    const opp = this.screen === 'opponent';
    const list = this.entries();
    const f = list[this.sel]!;
    const random = this.sel === list.length - 1;
    s.querySelectorAll('.plate').forEach((n, i) => {
      n.classList.toggle('sel', i === this.sel);
      if (i === this.sel) n.scrollIntoView?.({ inline: 'center', block: 'nearest' });
      if (i === list.length - 1) this.setAccent(n as HTMLElement, f.id === list[i]!.id ? f : list[i]!);
    });
    s.querySelector('.strip')!.classList.toggle('row', !opp || this.optRow === 0);
    const info = s.querySelector<HTMLElement>('.info')!;
    this.setAccent(info, f);
    const opt = (row: number, label: string, names: readonly string[], cur: number): string =>
      `<div class="opt${this.optRow === row ? ' row' : ''}"><span>${label}</span><div class="choices">${names.map((n, i) => `<div class="ch${i === cur ? ' sel' : ''}" data-row="${row}" data-i="${i}">${n}</div>`).join('')}</div></div>`;
    info.innerHTML = `<div class="scroll">${this.infoHtml(f)}</div><div class="foot">` +
      (opp ? `<div class="opts">${opt(1, 'Difficulty', DIFFICULTY_NAMES, this.difficulty)}${opt(2, 'Rounds', ROUNDS.map(r => `${r[0]} × ${clockText(r[1])}`), this.roundsIdx)}</div>` : '') +
      '<div class="btns"></div></div>';
    info.querySelectorAll<HTMLElement>('.ch').forEach(ch => ch.addEventListener('pointerdown', e => {
      e.preventDefault();
      const row = Number(ch.dataset['row']), i = Number(ch.dataset['i']);
      if (row === 1) this.difficulty = i; else this.roundsIdx = i;
      this.optRow = row;
      this.fillSelect();
    }));
    const defs: [string, () => void, boolean?][] = [[opp ? 'Fight' : 'Select', () => this.confirmSelect()]];
    if (random) defs.push(['Re-roll', () => this.rerollRandom(), true]);
    defs.push(['Back', () => this.back(), true]);
    this.setBtns(info.querySelector('.btns')!, defs);
    this.wantPreview(f);
  }

  private reroll(seed: number): number { return (Math.imul(seed, 1664525) + 1013904223 >>> 0) % 1000000; }
  private rerollRandom(): void {
    const k = this.picking;
    do this.seeds[k] = this.reroll(this.seeds[k]); while (k === 1 && this.player.id === `gen-${this.seeds[1]}`);
    this.fillSelect();
  }

  private moveSel(dir: number): void {
    const list = this.entries();
    let i = this.sel;
    for (let n = 0; n < list.length; n++) { i = (i + dir + list.length) % list.length; if (!this.isOff(list[i]!)) break; }
    this.sel = i;
    this.fillSelect();
  }

  private confirmSelect(): void {
    const f = this.entries()[this.sel]!;
    if (this.isOff(f)) return;
    if (this.screen === 'select') {
      this.player = f;
      if (this.mode === 'ladder') { this.ladder = { fighter: f.id, wins: 0, losses: 0 }; saveLadder(this.ladder); this.show('ladder'); }
      else this.show('opponent');
    } else {
      this.opp = f;
      this.beginFight();
    }
  }

  /** Ask for `f`'s body on the turntable once the highlight has rested on him. */
  private wantPreview(f: FighterSpec): void {
    if (this.director.slots[0].id === f.id) { this.previewWant = null; return; }
    this.previewWant = f;
    this.previewT = this.cfg.flowPreviewDelay;
  }

  // ── Ladder ─────────────────────────────────────────────────────────────────

  private rungs(): FighterSpec[] { return ladderOrder(this.player, this.roster).slice(-7); }

  private openLadder(): void {
    this.mode = 'ladder';
    this.ladder = loadLadder() ?? this.ladder;
    const f = this.ladder ? ladderFighter(this.ladder, this.roster) : null;
    if (!this.ladder || !f) { this.ladder = null; this.show('select'); return; }
    this.player = f;
    this.show('ladder');
  }

  private renderLadder(): void {
    const save = this.ladder!;
    const rungs = this.rungs();
    if (save.wins >= rungs.length) { this.show('champion'); return; }
    const next = rungs[save.wins]!;
    const diff = ladderDifficulty(save.wins, rungs.length);
    const s = this.screens.ladder;
    s.innerHTML = `<div class="head">The ladder · ${esc(this.player.name)} · <span class="rec">Record ${save.wins} – ${save.losses}</span></div>` +
      `<div class="panel info"><div class="scroll"><div class="tag">Next · fight ${save.wins + 1} of ${rungs.length} · ${DIFFICULTY_NAMES[diff]}</div>${this.infoHtml(next)}</div><div class="foot"><div class="btns"></div></div></div>` +
      '<div class="strip row">' + rungs.map((f, i) => {
        const [c, c2] = accent(f);
        const what = i < save.wins ? 'Beaten' : DIFFICULTY_NAMES[ladderDifficulty(i, rungs.length)];
        return `<div class="plate rung${i < save.wins ? ' won' : i === save.wins ? ' next sel' : ''}" style="--c:${c};--c2:${c2}"><div class="sw"></div><div class="pn"><i>${i + 1}</i>${esc(lastName(f))}</div><div class="ps">${what}</div></div>`;
      }).join('') + '</div>' +
      '<div class="hint">← → choose · Enter select · Esc menu</div>';
    this.setAccent(s.querySelector<HTMLElement>('.info')!, next);
    this.setBtns(s.querySelector('.btns')!, [
      ['Fight', () => { this.opp = next; this.difficulty = diff; this.beginFight(); }],
      ['New ladder', () => { this.ladder = null; saveLadder(null); this.show('select'); }, true],
      ['Menu', () => this.show('title'), true],
    ]);
    this.wantPreview(next);
  }

  private renderChampion(): void {
    const s = this.screens.champion;
    const save = this.ladder;
    s.innerHTML = `<div class="panel champ"><div class="tag">The ladder is yours</div><div class="big">Champion</div><div class="fname" style="margin-top:12px">${esc(this.player.name)}</div><div class="fnick">"${esc(this.player.nickname)}"</div>` +
      `<div class="fmeta">Seven fights, seven wins${save && save.losses ? `, ${save.losses} defeat${save.losses === 1 ? '' : 's'} on the way` : ', never beaten'}.</div><div class="btns"></div></div>`;
    this.setAccent(s.querySelector<HTMLElement>('.champ')!, this.player);
    this.setBtns(s.querySelector('.btns')!, [
      ['New ladder', () => { this.ladder = null; saveLadder(null); this.mode = 'ladder'; this.show('select'); }],
      ['Menu', () => this.show('title'), true],
    ]);
    this.wantPreview(this.player);
  }

  // ── Gym ────────────────────────────────────────────────────────────────────

  private renderGym(): void {
    this.endDrill();
    const s = this.screens.gym;
    s.innerHTML = '<div class="panel sheet"><h2>Gym</h2><div class="sub">One drill, one feeling. A drill starts again when you finish it. R restarts it, Esc comes back here.</div><div class="drills"></div><div class="btns"></div></div>';
    const box = s.querySelector('.drills')!;
    this.btns = [];
    this.drills.forEach((d, i) => {
      const it = document.createElement('div');
      it.className = 'ditem';
      it.innerHTML = `<div class="n">${i + 1}</div><div class="t">${esc(d.title)}</div><div class="g">${esc(d.goal)}</div>${d.controls ? `<div class="c">${esc(d.controls)}</div>` : ''}`;
      const act = (): void => this.startDrill(d);
      it.addEventListener('pointerdown', e => { e.preventDefault(); act(); });
      box.appendChild(it);
      this.btns.push({ el: it, act });
    });
    this.setBtns(s.querySelector('.btns')!, [['Back', () => this.show('title'), true]], true);
  }

  private startDrill(d: Drill): void {
    this.mode = 'gym';
    // A drill is one long round: the round clock must not end it.
    this.keptRounds ??= [this.cfg.roundCount, this.cfg.roundSeconds];
    this.cfg.roundCount = 1; this.cfg.roundSeconds = 180;
    const opp = this.roster.find(f => f.id !== this.player.id)!;
    this.opp = this.opp.id !== this.player.id ? this.opp : opp;
    const run = { def: d, rng: seedRng(7), tick: 0, acc: {} as Record<string, unknown>, doneT: -1, last: { progress: 0, stat: '' } };
    this.drill = run;
    this.drillEl.innerHTML = '';
    this.method = null; this.overT = 0; this.seenPhase = 'fighting'; this.cardRound = -1;
    this.stats.reset();
    this.hooks.crowd(null, false);
    this.hooks.start(this.player, this.opp, {
      difficulty: this.cfg.difficulty,
      driver: d.opponent ? s => d.opponent!(s, run.tick++, run.rng) : null,
      prepare: s => this.placeDrill(s, d),
    });
    this.director.setSlots(this.player, this.opp);
    this.previewWant = null;
    this.show('fight');
    this.syncFight();
  }

  /** The drill's start: the two men where it wants them, hands settled, then its own setup. */
  private placeDrill(s: SimState, d: Drill): SimState {
    const p = d.placement;
    if (p.dist !== undefined || p.player || p.opponent) {
      const half = (p.dist ?? 1.6) / 2;
      const a = p.player ?? (p.opponent ? { x: p.opponent.x - 2 * half, z: p.opponent.z } : { x: -half, z: 0 });
      const b = p.opponent ?? { x: a.x + 2 * half, z: a.z };
      const yaw = Math.atan2(b.z - a.z, b.x - a.x);
      s.fighters[0].pos = { x: a.x, z: a.z }; s.fighters[0].yaw = yaw;
      s.fighters[1].pos = { x: b.x, z: b.z }; s.fighters[1].yaw = yaw + Math.PI;
      const idle = cloneInput(NULL_INPUT);
      for (let i = 0; i < 30; i++) s = step(s, [idle, idle], this.cfg).state;
    }
    if (d.setup) d.setup(s);
    return s;
  }

  private endDrill(): void {
    this.drill = null;
    if (this.keptRounds) { [this.cfg.roundCount, this.cfg.roundSeconds] = this.keptRounds; this.keptRounds = null; }
  }

  private renderControls(): void {
    const s = this.screens.controls;
    s.innerHTML = `<div class="panel sheet"><div class="shead"><h2>Controls</h2><div class="btns"></div></div>${controlsHtml()}</div>`;
    this.setBtns(s.querySelector('.btns')!, [['Back', () => this.show(this.controlsBack), true]]);
  }

  // ── The fight ──────────────────────────────────────────────────────────────

  private buildFight(): void {
    const s = this.screens.fight;
    const mk = (cls: string): HTMLElement => { const d = document.createElement('div'); d.className = cls; s.appendChild(d); return d; };
    this.third = mk('third');
    this.bug = mk('bug'); this.bug.textContent = 'REPLAY';
    this.skipzone = mk('skipzone');
    this.skipzone.addEventListener('pointerdown', e => { e.preventDefault(); this.act('ok'); });
    this.drillEl = mk('panel drill');
    this.cardEl = mk('panel corner');
    this.cardEl.addEventListener('pointerdown', e => { e.preventDefault(); this.act('ok'); });
    this.pauseBtn = mk('pausebtn'); this.pauseBtn.textContent = 'II';
    this.pauseBtn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); this.act('back'); });
    this.pauseEl = mk('pause');
  }

  /** The fight screen's overlays follow the flags. */
  private syncFight(): void {
    this.cardEl.classList.toggle('on', this.card);
    this.pauseEl.classList.toggle('on', this.paused);
    this.bug.classList.toggle('on', this.replaying);
    this.skipzone.classList.toggle('on', this.replaying && !this.paused);
    this.drillEl.classList.toggle('on', this.drill !== null && this.screen === 'fight');
    this.pauseBtn.classList.toggle('on', this.screen === 'fight' && !this.paused && !this.card);
    if (this.drill && this.screen === 'fight' && !this.drillEl.firstChild) {
      const d = this.drill.def;
      this.drillEl.innerHTML = `<div class="t">${esc(d.title)}</div><div class="g">${esc(d.goal)}</div><div class="prog"><div></div></div><div class="s"></div><div class="k">R restart · Esc back to gym</div>`;
    } else if (!this.drill && this.drillEl.firstChild) this.drillEl.innerHTML = '';
  }

  private beginFight(): void {
    this.endDrill();
    if (this.mode !== 'ladder') this.mode = 'fight';
    const r = this.roundsOverride ?? ROUNDS[this.roundsIdx]!;
    this.cfg.roundCount = r[0]; this.cfg.roundSeconds = r[1];
    this.cfg.difficulty = this.difficulty;
    this.method = null; this.lastRound = 0; this.overT = 0; this.seenPhase = 'fighting'; this.cardRound = -1; this.ladderWon = false;
    this.stats.reset();
    this.previewWant = null;
    this.hooks.start(this.player, this.opp, { difficulty: this.difficulty, driver: null, prepare: null });
    this.director.setSlots(this.player, this.opp);
    this.director.startWalk();
    this.beat = 'done';
    this.hooks.crowd(this.cfg.flowWalkCrowd, false);
    this.show('walk');
  }

  private renderWalk(beat: WalkBeat): void {
    const s = this.screens.walk;
    const [a, b] = [this.player, this.opp];
    if (beat === 'walk0' || beat === 'walk1') {
      const f = beat === 'walk0' ? a : b;
      s.innerHTML = `<div class="namecard"><div class="fname">${esc(f.name)}</div><div class="fnick">"${esc(f.nickname)}" · ${esc(f.hometown)}</div><div class="line">${esc(tapeLine(f))}</div></div><div class="hint">Any button skips</div>`;
      this.setAccent(s.querySelector<HTMLElement>('.namecard')!, f);
      this.hooks.crowd(this.cfg.flowWalkCrowd, true);
    } else {
      const col = (f: FighterSpec, side: 'l' | 'r'): string => `<div class="${side}"><div class="fname">${esc(f.name)}</div></div>`;
      const row = (lbl: string, va: string, vb: string): string => `<div class="l val">${va}</div><div class="lbl">${lbl}</div><div class="r val">${vb}</div>`;
      s.innerHTML = '<div class="tapecard">' + col(a, 'l') + '<div class="vs">VS</div>' + col(b, 'r') +
        row('HEIGHT', `${a.heightM.toFixed(2)} m`, `${b.heightM.toFixed(2)} m`) +
        row('REACH', `${Math.round(a.reachM * 100)} cm`, `${Math.round(b.reachM * 100)} cm`) +
        row('WEIGHT', `${a.massKg} kg`, `${b.massKg} kg`) +
        row('STYLE', esc(styleInfo(a).name), esc(styleInfo(b).name)) +
        `<div class="bout">${this.cfg.roundCount} ROUNDS · ${clockText(this.cfg.roundSeconds)} EACH${this.mode === 'ladder' ? ` · ${DIFFICULTY_NAMES[this.difficulty]!.toUpperCase()}` : ''}</div></div><div class="hint">Any button skips</div>`;
      const t = s.querySelector<HTMLElement>('.tapecard')!;
      t.style.setProperty('--ca', accent(a)[0]); t.style.setProperty('--cb', accent(b)[0]);
    }
  }

  private toFight(): void {
    this.director.endWalk();
    this.hooks.crowd(null, false);
    this.show('fight');
    this.syncFight();
    this.hooks.bell();
  }

  private statRow(lbl: string, a: string | number, b: string | number): string {
    return `<div class="l v">${a}</div><div class="lbl">${lbl}</div><div class="r v">${b}</div>`;
  }

  private openCard(s: SimState): void {
    const i = s.round.index;
    this.card = true; this.cardRound = i; this.cardT = this.cfg.flowCornerSeconds;
    const [ra, rb] = this.stats.round(i);
    const [fa, fb] = s.fighters;
    const cond = (lbl: string, va: number, vb: number, bad = false): string => {
      const bar = (v: number, side: 'l' | 'r'): string => `<div class="cond ${side}${bad ? ' bad' : ''}"><div class="bar"><div class="fill" style="width:${Math.round(Math.min(1, Math.max(0, v)) * 100)}%"></div></div></div>`;
      return bar(va, 'l') + `<div class="lbl">${lbl}</div>` + bar(vb, 'r');
    };
    const lt = (r: SideStats): string => `${landedOf(r)} / ${thrownOf(r)}`;
    this.cardEl.innerHTML =
      `<div class="top"><div class="big">End of round ${i + 1}</div><div class="nextup">Round ${i + 2} of ${this.cfg.roundCount} next</div></div>` +
      '<div class="cgrid">' +
      `<div class="nm l" style="--c:${accent(this.player)[0]}">${esc(this.player.name)}</div><div class="lbl">Round ${i + 1}</div><div class="nm r" style="--c:${accent(this.opp)[0]}">${esc(this.opp.name)}</div>` +
      this.statRow('Landed / thrown', lt(ra), lt(rb)) +
      this.statRow('Clean', ra.clean, rb.clean) + this.statRow('Flush', ra.flush, rb.flush) +
      this.statRow('To the head', ra.head, rb.head) + this.statRow('To the body', ra.body, rb.body) +
      this.statRow('Knockdowns', ra.knockdowns, rb.knockdowns) +
      '<div class="gap"></div>' +
      `<div style="--c:${accent(this.player)[0]};display:contents">` +
      cond('Health', fa.health, fb.health) + cond('Stamina ceiling', fa.staminaCap ?? 1, fb.staminaCap ?? 1) + '</div>' +
      cond('Head damage', fa.damage?.head ?? 0, fb.damage?.head ?? 0, true) + cond('Body damage', fa.damage?.body ?? 0, fb.damage?.body ?? 0, true) +
      '</div>' +
      `<div class="advice"><span>Your corner</span>${esc(advice([ra, rb], s, 0))}</div>` +
      '<div class="foot"><span>Any button: next round</span><span class="count"></span></div>';
    // Each man's bars in his own colour.
    this.cardEl.querySelectorAll<HTMLElement>('.cond.r:not(.bad)').forEach(n => n.style.setProperty('--c', accent(this.opp)[0]));
    this.cardEl.querySelectorAll<HTMLElement>('.cond.l:not(.bad)').forEach(n => n.style.setProperty('--c', accent(this.player)[0]));
    this.syncFight();
  }

  private closeCard(): void {
    if (!this.card) return;
    this.card = false;
    this.hooks.skipRest();
    this.syncFight();
  }

  private setPaused(on: boolean): void {
    this.paused = on;
    this.pauseView = 'menu';
    if (on) this.renderPause(); else this.btns = [];
    this.syncFight();
  }

  private renderPause(): void {
    this.cursor = 0;
    if (this.pauseView === 'controls') {
      this.pauseEl.innerHTML = `<div class="panel sheet"><div class="shead"><h2>Controls</h2><div class="btns"></div></div>${controlsHtml()}</div>`;
      this.setBtns(this.pauseEl.querySelector('.btns')!, [['Back', () => { this.pauseView = 'menu'; this.renderPause(); }, true]]);
      return;
    }
    this.pauseEl.innerHTML = '<div class="panel box"><h2>Paused</h2><div class="menu"></div></div>';
    this.setBtns(this.pauseEl.querySelector('.menu')!, [
      ['Resume', () => this.setPaused(false)],
      ['Controls', () => { this.pauseView = 'controls'; this.renderPause(); }],
      ['Quit', () => this.quitFight()],
    ]);
  }

  private quitFight(): void {
    this.hooks.skipReplay();
    this.hooks.crowd(null, false);
    this.show(this.mode === 'ladder' ? 'ladder' : 'title');
  }

  // ── Results ────────────────────────────────────────────────────────────────

  private renderResults(): void {
    const [a, b] = [this.player, this.opp];
    const s = this.screens.results;
    const m = this.method;
    const winner = m ? m.winner : null;
    const name = winner === null ? 'Draw' : (winner === 0 ? a : b).name;
    let how = '';
    if (m?.kind === 'ko') how = `Wins by knockout · round ${m.round + 1}`;
    else if (m?.kind === 'tko') how = `Wins by TKO · round ${m.round + 1}`;
    else if (m) how = winner === null ? 'The judges score it even' : 'Wins on points';
    const cards = m?.kind === 'decision' ? m.cards : this.last ? this.last.round.score : [];
    let table = '';
    if (cards.length) {
      const tot = cards.reduce((t, c) => [t[0] + c[0], t[1] + c[1]], [0, 0]);
      table = `<table class="cards"><tr><th></th>${cards.map((_, i) => `<th>R${i + 1}</th>`).join('')}<th>TOTAL</th></tr>` +
        `<tr><td class="n">${esc(a.name)}</td>${cards.map(c => `<td>${c[0]}</td>`).join('')}<td class="t">${tot[0]}</td></tr>` +
        `<tr><td class="n">${esc(b.name)}</td>${cards.map(c => `<td>${c[1]}</td>`).join('')}<td class="t">${tot[1]}</td></tr></table>`;
    }
    const note = m && m.kind !== 'decision'
      ? `<div class="cardnote">${cards.length ? 'The cards at the stoppage (completed rounds only).' : 'Stopped before a round was scored.'}</div>` : '';
    const [ta, tb] = this.stats.total;
    const fam = PUNCHES.map(p => this.statRow(p === 'jab' ? 'Jabs' : p === 'cross' ? 'Crosses' : p === 'hook' ? 'Hooks' : 'Uppercuts', `${ta.landed[p]} / ${ta.thrown[p]}`, `${tb.landed[p]} / ${tb.thrown[p]}`)).join('');
    const stats = `<div class="sgrid"><div class="nm l">${esc(lastName(a))}</div><div class="lbl">Landed / thrown</div><div class="nm r">${esc(lastName(b))}</div>` + fam +
      '<div class="rule"></div>' +
      this.statRow('Total', `${landedOf(ta)} / ${thrownOf(ta)}`, `${landedOf(tb)} / ${thrownOf(tb)}`) +
      this.statRow('Clean', ta.clean, tb.clean) + this.statRow('Flush', ta.flush, tb.flush) +
      this.statRow('To the head', ta.head, tb.head) + this.statRow('To the body', ta.body, tb.body) +
      this.statRow('Counters', ta.counters, tb.counters) + this.statRow('Knockdowns', ta.knockdowns, tb.knockdowns) + '</div>';
    s.innerHTML = `<div class="panel sheet"><div><div class="winner">${esc(name)}</div><div class="method">${how}</div>${table}${note}<div class="btns"></div></div>${stats}</div>`;
    const sheet = s.querySelector<HTMLElement>('.sheet')!;
    if (winner !== null) this.setAccent(sheet, winner === 0 ? a : b);
    const box = s.querySelector('.btns')!;
    if (this.mode === 'ladder' && this.ladder) {
      // The result is written once, when the screen first comes up.
      if (!this.ladderWon && this.overT >= 0) {
        if (winner === 0) { this.ladder.wins++; this.ladderWon = true; } else this.ladder.losses++;
        saveLadder(this.ladder);
        this.overT = -1;
      }
      if (this.ladderWon) this.setBtns(box, [['Continue', () => this.show('ladder')], ['Menu', () => this.show('title'), true]]);
      else this.setBtns(box, [['Try again', () => this.beginFight()], ['Quit', () => this.show('title'), true]]);
    } else {
      this.setBtns(box, [
        ['Rematch', () => this.beginFight()],
        ['New fight', () => { this.mode = 'fight'; this.show('select'); }, true],
        ['Menu', () => this.show('title'), true],
      ]);
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const c = e.code;
    const a: Act | null =
      c === 'ArrowUp' || c === 'KeyW' ? 'up' : c === 'ArrowDown' || c === 'KeyS' ? 'down' :
      c === 'ArrowLeft' || c === 'KeyA' ? 'left' : c === 'ArrowRight' || c === 'KeyD' ? 'right' :
      c === 'Enter' || c === 'NumpadEnter' || c === 'Space' ? 'ok' : c === 'Escape' ? 'back' : c === 'KeyR' ? 'r' :
      c === 'KeyJ' || c === 'KeyK' || c === 'KeyL' || c === 'Semicolon' ? 'any' : null;
    if (!a) return;
    const dir = a === 'up' || a === 'down' || a === 'left' || a === 'right';
    if (e.repeat && !dir) return;
    if (this.act(a)) e.preventDefault();
  }

  /** A menu action from any device. Returns whether it was used. */
  private act(a: Act): boolean {
    const ok = a === 'ok', back = a === 'back';
    const skip = ok || a === 'any';
    if (this.screen === 'fight') {
      if (this.paused) {
        if (back || a === 'start') { if (this.pauseView === 'controls') { this.pauseView = 'menu'; this.renderPause(); } else this.setPaused(false); return true; }
        if (this.pauseView === 'controls' && (a === 'up' || a === 'down')) { this.pauseEl.querySelector('.sheet')?.scrollBy(0, a === 'down' ? 140 : -140); return true; }
        return this.navBtns(a);
      }
      if (this.replaying) { if (skip || back) { this.hooks.skipReplay(); return true; } return false; }
      if (this.card) { if (skip) { this.closeCard(); return true; } if (back || a === 'start') { this.setPaused(true); return true; } return false; }
      if (this.drill) {
        if (back || a === 'start') { this.show('gym'); return true; }
        if (a === 'r') { this.startDrill(this.drill.def); return true; }
        return false;
      }
      if (back || a === 'start') { this.setPaused(true); return true; }
      return false;
    }
    if (a === 'start') a = 'ok';
    if (this.screen === 'walk') {
      if (skip || a === 'ok') { this.director.skipBeat(); return true; }
      if (back) { this.director.endWalk(); this.hooks.crowd(null, false); this.show(this.mode === 'ladder' ? 'ladder' : 'opponent'); return true; }
      return false;
    }
    if (this.screen === 'select' || this.screen === 'opponent') {
      const opp = this.screen === 'opponent';
      if (a === 'ok') { this.confirmSelect(); return true; }
      if (back) { this.back(); return true; }
      if (a === 'r') { if (this.sel === this.entries().length - 1) this.rerollRandom(); return true; }
      if (a === 'up' || a === 'down') {
        if (opp) { this.optRow = (this.optRow + (a === 'down' ? 1 : 2)) % 3; this.fillSelect(); }
        return true;
      }
      if (a === 'left' || a === 'right') {
        const d = a === 'right' ? 1 : -1;
        if (!opp || this.optRow === 0) this.moveSel(d);
        else if (this.optRow === 1) { this.difficulty = (this.difficulty + d + 3) % 3; this.fillSelect(); }
        else { this.roundsIdx = (this.roundsIdx + d + ROUNDS.length) % ROUNDS.length; this.fillSelect(); }
        return true;
      }
      return false;
    }
    if (back) { this.back(); return true; }
    if (this.screen === 'controls' && (a === 'up' || a === 'down')) { this.screens.controls.querySelector('.sheet')?.scrollBy(0, a === 'down' ? 140 : -140); return true; }
    return this.navBtns(a);
  }

  private navBtns(a: Act): boolean {
    if (!this.btns.length) return false;
    if (a === 'ok') { this.btns[this.cursor]?.act(); return true; }
    const d = a === 'up' || a === 'left' ? -1 : a === 'down' || a === 'right' ? 1 : 0;
    if (!d) return false;
    this.cursor = (this.cursor + d + this.btns.length) % this.btns.length;
    this.syncBtns();
    this.btns[this.cursor]!.el.scrollIntoView?.({ block: 'nearest' });
    return true;
  }

  private back(): void {
    switch (this.screen) {
      case 'select': this.show('title'); break;
      case 'opponent': this.show('select'); break;
      case 'controls': this.show(this.controlsBack); break;
      case 'results': if (this.mode === 'ladder') this.show('ladder'); else this.show('title'); break;
      case 'title': break;
      default: this.show('title');
    }
  }

  /** Gamepad on the menus: edges of the d-pad / stick, A, B, Start. In the fight only Start (and, on a card or a replay, any face button). */
  private pollPad(): void {
    if (typeof navigator.getGamepads !== 'function') return;
    let g: Gamepad | null = null;
    for (const p of navigator.getGamepads()) if (p && p.connected) { g = p; break; }
    if (!g) return;
    const ax = g.axes[0] ?? 0, ay = g.axes[1] ?? 0;
    const now: Record<string, boolean> = {
      up: !!g.buttons[12]?.pressed || ay < -0.6, down: !!g.buttons[13]?.pressed || ay > 0.6,
      left: !!g.buttons[14]?.pressed || ax < -0.6, right: !!g.buttons[15]?.pressed || ax > 0.6,
      ok: !!g.buttons[0]?.pressed, back: !!g.buttons[1]?.pressed, any: !!g.buttons[2]?.pressed || !!g.buttons[3]?.pressed, start: !!g.buttons[9]?.pressed,
    };
    const live = this.screen === 'fight' && !this.paused && !this.card && !this.replaying;
    for (const k of Object.keys(now)) {
      if (now[k] && !this.pad[k]) {
        if (live && k !== 'start') continue;
        // On a card or a replay B is a punch button like the others: it skips, it does not pause.
        const skipCtx = this.screen === 'fight' && !this.paused && (this.card || this.replaying);
        this.act(skipCtx && k === 'back' ? 'any' : k as Act);
      }
    }
    this.pad = now;
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  update(s: SimState, dt: number, events: readonly SimEvent[]): void {
    this.last = s;
    this.pollPad();
    const menu = this.holdsSim;
    if (menu !== this.menuClass) { this.menuClass = menu; document.body.classList.toggle('flow-menu', menu); }
    if (this.previewWant) {
      this.previewT -= dt;
      if (this.previewT <= 0) {
        const f = this.previewWant;
        this.previewWant = null;
        this.hooks.preview(f);
        this.director.setSlots(f, this.director.slots[1]);
      }
    }
    if (this.screen === 'walk') {
      const beat = this.director.beat;
      if (beat === 'done') { this.toFight(); return; }
      if (beat !== this.beat) { this.beat = beat; this.renderWalk(beat); }
      return;
    }
    if (this.screen !== 'fight') return;
    if (this.bug.classList.contains('on') !== this.replaying) this.syncFight();
    if (this.paused) return;
    const ph = s.round.phase;
    if (ph === 'fighting') this.lastRound = s.round.index;
    this.stats.add(events, s.round.index);

    if (this.drill) {
      const d = this.drill;
      const m = d.def.metric ? d.def.metric(s, events, d.acc) : { progress: 0, stat: '' };
      const ended = ph === 'over' || ph === 'between';
      const stat = d.doneT >= 0 ? `${m.stat}${m.stat ? ' · ' : ''}${m.progress >= 1 ? 'Done' : 'Over'}: starting again` : m.stat;
      if (stat !== d.last.stat || m.progress !== d.last.progress) {
        d.last = { progress: m.progress, stat };
        const bar = this.drillEl.querySelector<HTMLElement>('.prog div'), st = this.drillEl.querySelector('.s');
        if (bar) bar.style.width = `${Math.round(Math.min(1, Math.max(0, m.progress)) * 100)}%`;
        if (st) st.textContent = stat;
      }
      if (d.doneT < 0 && (m.progress >= 1 || ended)) d.doneT = this.cfg.flowDrillRestartSeconds;
      else if (d.doneT >= 0) { d.doneT -= dt; if (d.doneT <= 0) this.startDrill(d.def); }
      this.seenPhase = ph;
      return;
    }

    // The rest between rounds: the corner card, the sim held behind it.
    if (this.card) {
      this.cardT -= dt;
      const c = this.cardEl.querySelector('.count');
      if (c) c.textContent = String(Math.max(0, Math.ceil(this.cardT)));
      if (this.cardT <= 0) this.closeCard();
    } else if (ph === 'between' && this.cardRound !== s.round.index) this.openCard(s);

    for (const e of events) {
      if (e.type === 'roundStart' && e.index > 0) this.lowerThird(`Round ${e.index + 1}`);
    }
    this.thirdT -= dt;
    if (this.thirdT <= 0 && this.third.classList.contains('on')) this.third.classList.remove('on');
    // The results come a beat after the fight ends (and after the replay), so the last moment plays out.
    if (ph === 'over') {
      if (this.seenPhase !== 'over') this.overT = 0;
      if (!this.replaying && !this.replayDue) this.overT += dt;
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

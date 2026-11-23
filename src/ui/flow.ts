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
 * sim state. Keyboard: arrows / WASD, Enter / Space, Esc, R, N / P (drills).
 * Pad: d-pad / stick, A, B, Start, Select (next drill). Touch and mouse: every
 * button, plate and option, a pause button, and the drill panel's own.
 *
 * During the fight itself it shows no words about the action: the round
 * lower-third at a bell, the corner card in the rest, and the replay bug. A
 * drill is a training screen and has a panel.
 */
import { NULL_INPUT, cloneInput, generateFighter, sameFighter, type Config, type EventBus, type FighterSpec, type FrameInput, type SimEvent, type SimState } from '../core';
import { step } from '../sim';
import { FLOW_CSS } from './flowCss';
import { Director, type Scene, type WalkBeat } from './director';
import { styleInfo } from './styleInfo';
import { drillList, type Drill, type DrillMetric } from './drills';
import { FightStats, PUNCHES, advice, landedOf, thrownOf, type SideStats } from './stats';
import { DIFFICULTY_NAMES, ladderDifficulty, ladderFighter, ladderOrder, loadLadder, saveLadder, type LadderSave } from './ladder';
import { controlsHtml } from './controls';
import { accent } from './accent';
import { wordmarkSvg } from './wordmark';
import { CreateScreen, registerFighter } from './create';
import { exposeRecord, loadRecord, saveRecord } from './record';
import { CREATOR_ID, applyFight, recordLine, type FightRecord } from '../core';

export type Screen = 'title' | 'select' | 'opponent' | 'ladder' | 'gym' | 'controls' | 'walk' | 'fight' | 'results' | 'champion' | 'create';
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
  /** The pause came up / went: quiet the house. */
  audioPaused(on: boolean): void;
}

interface FlowProbe {
  screen: Screen; mode: Mode | null; paused: boolean; card: boolean; replay: boolean; beat: WalkBeat;
  drill: string | null; drillStat: string; drillProgress: number; drillDone: string;
  player: string; opponent: string; ladder: LadderSave | null;
  /** Whose body is in view slot 0 (the turntable). */
  shown: string;
  /** The guard shape he is standing in there. */
  turnGuard: string;
}

declare global {
  interface Window {
    /** The flow's state, for scripts (flow_check, flow_look). */
    __flow?: {
      state: () => FlowProbe;
      /** Scripts only: the next fights use `count` rounds of `seconds` whatever the menu says (count 0 = back to the menu's choice). */
      rounds: (count: number, seconds: number) => void;
      /** Scripts only: start a drill by id (as picking it in the gym does). */
      drill: (id: string) => boolean;
    };
  }
}

type Method = { kind: 'ko' | 'tko'; winner: 0 | 1; round: number } | { kind: 'decision'; winner: 0 | 1 | null; cards: [number, number][] };
type Act = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back' | 'r' | 'any' | 'start' | 'next' | 'prev';
interface Btn { el: HTMLElement; act: () => void }
interface DrillRun { def: Drill; tick: number; acc: Record<string, unknown>; t0: number; done: string; doneT: number; last: DrillMetric; shown: string }

const ROUNDS: readonly (readonly [number, number])[] = [[3, 30], [3, 60], [6, 60]];
const SCREENS: readonly Screen[] = ['title', 'select', 'opponent', 'ladder', 'gym', 'controls', 'walk', 'fight', 'results', 'champion', 'create'];
const RATINGS = ['power', 'speed', 'chin', 'stamina', 'defense'] as const;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clockText = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const lastName = (f: FighterSpec): string => f.name.split(' ').slice(1).join(' ') || f.name;
const tapeLine = (f: FighterSpec): string => `${f.heightM.toFixed(2)} m · ${Math.round(f.reachM * 100)} cm reach · ${f.massKg} kg · ${styleInfo(f).name}`;
const pct = (a: number, b: number): string => (b > 0 ? `${Math.round(a / b * 100)}%` : '–');

/** The matchup in plain words: what the other man has on you, or you on him. */
function matchupLines(me: FighterSpec, him: FighterSpec): string[] {
  const line = (d: number, unit: string, his: string, mine: string, same: string): string =>
    d >= 1 ? `He ${his} by ${d} ${unit}.` : d <= -1 ? `You ${mine} by ${-d} ${unit}.` : same;
  return [
    line(Math.round((him.reachM - me.reachM) * 100), 'cm', 'out-reaches you', 'out-reach him', 'Your reach is the same.'),
    line(Math.round((him.heightM - me.heightM) * 100), 'cm', 'is taller', 'are taller', 'You are the same height.'),
    line(Math.round(him.massKg - me.massKg), 'kg', 'is heavier', 'are heavier', 'You weigh the same.'),
  ];
}

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
  private difficulty: number;
  private roundsIdx = 1;                // 3 × 60 s
  private previewWant: FighterSpec | null = null;
  private previewT = 0;

  private ladder: LadderSave | null = null;
  private ladderWon = false;
  private drills: Drill[];
  private drill: DrillRun | null = null;
  private keptRounds: [number, number] | null = null;
  private keptTune: Record<string, unknown> | null = null;

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
  private create: CreateScreen;
  private recorded = false;            // this fight's result has been written to the created fighter's record
  private recordNow: FightRecord | null = null;   // his record after this fight (the results line), null when he did not fight
  private revealing = false;          // the fight-poster card after "Step into the ring" (a state of the create screen)
  private gymBack: Screen = 'title';    // where leaving the gym goes (the create screen's "Try him in the gym" sets 'create')

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
    this.difficulty = Math.max(0, Math.min(2, Math.round(cfg.aiDifficulty)));
    this.drills = drillList(cfg);
    this.director = new Director(cfg, [this.player, this.opp]);
    this.create = new CreateScreen(cfg, spec => this.previewNow(spec));
    exposeRecord();

    bus.on('ko', e => { this.method = { kind: 'ko', winner: e.winner, round: this.lastRound }; });
    bus.on('tko', e => { this.method = { kind: 'tko', winner: e.winner, round: this.lastRound }; });
    bus.on('decision', e => { this.method = { kind: 'decision', winner: e.winner, cards: e.cards }; });
    window.addEventListener('keydown', e => this.onKey(e));
    window.__flow = {
      state: () => ({
        screen: this.screen, mode: this.mode, paused: this.paused, card: this.card, replay: this.replaying, beat: this.beat,
        drill: this.drill ? this.drill.def.id : null, drillStat: this.drill ? this.drill.last.stat : '',
        drillProgress: this.drill ? this.drill.last.progress : 0, drillDone: this.drill ? this.drill.done : '',
        player: this.player.id, opponent: this.opp.id, ladder: this.ladder ? { ...this.ladder } : null,
        shown: this.director.slots[0].id, turnGuard: this.director.turnGuard,
      }),
      rounds: (count, seconds) => { this.roundsOverride = count > 0 ? [count, seconds] : null; },
      drill: id => { const d = this.drills.find(x => x.id === id); if (d) this.startDrill(d); return !!d; },
    };
    this.show('title');
  }

  // ── What main.ts reads ─────────────────────────────────────────────────────

  /** True whenever the sim must wait: every screen but the fight, the pause, the corner card. */
  get holdsSim(): boolean { return this.screen !== 'fight' || this.paused || this.card; }
  /** The pause menu is up (the audio goes quiet). */
  get isPaused(): boolean { return this.paused; }
  /** The HUD belongs to the fight alone (the cards carry their own numbers). */
  get showHud(): boolean { return this.screen === 'fight' && !this.card; }
  /** A knockdown may be replayed (a real fight, not a drill, nothing else up). */
  get wantsReplay(): boolean { return this.screen === 'fight' && this.mode !== 'gym' && !this.paused && !this.card; }
  /** A drill has no referee: he only gets in the way of what is being practised. */
  get hidesReferee(): boolean { return this.drill !== null; }
  /** The round and the clock belong on the hanging scoreboard. */
  get inFight(): boolean { return this.screen === 'fight' || this.screen === 'results'; }

  /** What to draw instead of the live fight (a menu, the walk, the corner card), or a shot to draw the live fight under, or null. `liveAz`: the camera's orbit now. */
  scene(dt: number, liveAz: number): Scene | null {
    switch (this.screen) {
      case 'title': return this.director.sparring(dt);
      case 'gym': case 'controls': return this.director.wide(dt);
      case 'select': case 'opponent': case 'ladder': case 'champion': case 'create': return this.director.turntable(dt);
      case 'walk': return this.director.walkScene(dt);
      case 'fight': return this.card ? this.director.corners(this.paused ? 0 : dt) : null;
      case 'results': return this.last ? this.director.results(liveAz, this.last.fighters[0].pos, this.last.fighters[1].pos) : null;
      default: return null;
    }
  }

  // ── Screens ────────────────────────────────────────────────────────────────

  private show(screen: Screen): void {
    const focus = document.activeElement as HTMLElement | null;
    if (focus && this.el.contains(focus) && focus.tagName === 'INPUT') focus.blur();   // a field of the create screen: the keys go back to the menu
    this.revealing = false;
    this.screen = screen;
    this.cursor = 0;
    this.btns = [];
    this.director.cut();
    for (const k of SCREENS) this.screens[k].classList.toggle('on', k === screen);
    if (screen !== 'fight') { if (this.paused) this.hooks.audioPaused(false); this.paused = false; this.card = false; this.syncFight(); }
    if (screen === 'title') this.renderTitle();
    else if (screen === 'select' || screen === 'opponent') this.renderSelect();
    else if (screen === 'ladder') this.renderLadder();
    else if (screen === 'gym') this.renderGym();
    else if (screen === 'controls') this.renderControls();
    else if (screen === 'create') this.renderCreate();
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
    this.endDrill();
    const s = this.screens.title;
    s.innerHTML = `<div class="titlebox"><div class="wordmark">${wordmarkSvg('LONG', 'COUNT', 'MAIN EVENT BOXING')}</div><div class="menu"></div><div class="foot">Arrows to choose · Enter to select</div></div>`;
    this.setBtns(s.querySelector('.menu')!, [
      ['Fight', () => { this.mode = 'fight'; this.show('select'); }],
      ['Ladder', () => this.openLadder()],
      ['Gym', () => { this.gymBack = 'title'; this.show('gym'); }],
      ['Controls', () => { this.controlsBack = 'title'; this.show('controls'); }],
      [this.create.saved ? 'Edit fighter' : 'Create fighter', () => this.show('create')],
    ]);
  }

  // ── Create your fighter (fields in ui/create.ts) ───────────────────────────

  private renderCreate(): void {
    const s = this.screens.create;
    s.innerHTML = '<div class="head">Create your fighter</div><div class="panel info mk"><div class="scroll"></div><div class="foot"><div class="btns"></div></div></div>';
    this.previewWant = null;
    this.create.mount(s.querySelector('.scroll')!);
    this.setBtns(s.querySelector('.btns')!, [
      ['Step into the ring', () => this.finishCreate()],
      ['Try him in the gym', () => this.tryInGym(), true],
      ['Back', () => this.show('title'), true],
    ]);
    this.previewNow(this.create.spec());
  }

  /** Show this draft's man in the ring now (the fields call it on a slider's release or a click). */
  private previewNow(spec: FighterSpec): void {
    this.setAccent(this.screens.create.querySelector<HTMLElement>('.info') ?? this.screens.create, spec);
    if (sameFighter(this.director.slots[0], spec)) return;
    this.hooks.preview(spec);
    this.director.setSlots(spec, this.director.slots[1]);
  }

  /** Save him and open the gym with him as the player; leaving the gym comes back here. */
  private tryInGym(): void {
    const spec = this.create.commit();
    registerFighter(spec);
    this.player = spec;
    this.gymBack = 'create';
    this.show('gym');
  }

  /** Save him, put him first on the roster, and go where Fight goes, with him picked. */
  private finishCreate(): void {
    const spec = this.create.commit();
    registerFighter(spec);
    this.player = spec;
    this.mode = 'fight';
    const focus = document.activeElement as HTMLElement | null;
    if (focus && focus.tagName === 'INPUT') focus.blur();
    this.btns = [];
    this.revealing = true;
    this.setAccent(this.screens.create, spec);
    this.create.reveal(this.screens.create, spec, () => this.endReveal());
  }

  private endReveal(): void {
    if (!this.revealing) return;
    this.show('select');
  }

  // ── Select / opponent ──────────────────────────────────────────────────────

  private get picking(): 0 | 1 { return this.screen === 'opponent' ? 1 : 0; }
  private entries(): FighterSpec[] { return [...this.roster, generateFighter(this.seeds[this.picking])]; }
  private isOff(f: FighterSpec): boolean { return this.screen === 'opponent' && f.id === this.player.id; }

  /** A measurement as a small bar against the roster's range, so 1.63 m against 1.98 m is seen, not read. */
  private sizeRow(label: string, text: string, v: number, key: 'heightM' | 'reachM' | 'massKg'): string {
    let lo = Infinity, hi = -Infinity;
    for (const r of this.roster) { lo = Math.min(lo, r[key]); hi = Math.max(hi, r[key]); }
    const u = hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0.5;
    return `<span>${label}</span><div class="bar"><div class="fill" style="width:${Math.round(6 + u * 94)}%"></div></div><i>${text}</i>`;
  }

  /** The fighter's sheet. `as`: 'pick' shows how he fights (you are choosing him), 'opponent' how to beat him and the matchup against `me`. */
  private infoHtml(f: FighterSpec, as: 'pick' | 'opponent', me: FighterSpec | null = null): string {
    const st = styleInfo(f);
    const lines = as === 'pick' ? st.fights : st.beat;
    const match = as === 'opponent' && me
      ? `<div class="matchup"><span class="lhead">The matchup</span>${esc(matchupLines(me, f).join(' '))}</div>` : '';
    return `<div class="fname">${esc(f.name)}</div><div class="fnick">"${esc(f.nickname)}"</div>` +
      `<div class="fmeta">${esc(f.hometown)} · ${cap(f.stance)}</div>` +
      (f.id === CREATOR_ID ? `<div class="fmeta recline"><span>Record</span> <b>${esc(recordLine(loadRecord()))}</b></div>` : '') +
      `<div class="sr"><div class="sizes">${this.sizeRow('Height', `${f.heightM.toFixed(2)} m`, f.heightM, 'heightM')}${this.sizeRow('Reach', `${Math.round(f.reachM * 100)} cm`, f.reachM, 'reachM')}${this.sizeRow('Weight', `${f.massKg} kg`, f.massKg, 'massKg')}</div>` +
      `<div class="ratings">${RATINGS.map(k => `<span>${k}</span><div class="bar"><div class="fill" style="width:${f[k]}%"></div></div><i>${f[k]}</i>`).join('')}</div></div>` +
      match +
      `<div class="style"><div class="sname">${esc(st.name)}</div>` +
      `<div class="sfacts"><span>Guard</span>${esc(st.guard)}<span>Range</span>${esc(st.range)}</div>` +
      `<div class="blurb">${esc(st.blurb)}</div>` +
      `<div class="lhead">${as === 'pick' ? 'How he fights' : 'How to beat him'}</div><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul></div>`;
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
      if (i === list.length - 1) this.setAccent(n as HTMLElement, list[i]!);
    });
    s.querySelector('.strip')!.classList.toggle('row', !opp || this.optRow === 0);
    const info = s.querySelector<HTMLElement>('.info')!;
    this.setAccent(info, f);
    const opt = (row: number, label: string, names: readonly string[], cur: number): string =>
      `<div class="opt${this.optRow === row ? ' row' : ''}"><span>${label}</span><div class="choices">${names.map((n, i) => `<div class="ch${i === cur ? ' sel' : ''}" data-row="${row}" data-i="${i}">${n}</div>`).join('')}</div></div>`;
    info.innerHTML = `<div class="scroll">${this.infoHtml(f, opp ? 'opponent' : 'pick', opp ? this.player : null)}</div><div class="foot">` +
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
    if (sameFighter(this.director.slots[0], f)) { this.previewWant = null; return; }
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
    s.innerHTML = `<div class="ladhead"><small>The ladder</small><b>${esc(this.player.name)}</b><span class="rec">Record ${save.wins} – ${save.losses}</span></div>` +
      `<div class="panel info"><div class="scroll"><div class="tag">Next · fight ${save.wins + 1} of ${rungs.length} · ${DIFFICULTY_NAMES[diff]}</div>${this.infoHtml(next, 'opponent', this.player)}</div><div class="foot"><div class="btns"></div></div></div>` +
      '<div class="strip row">' + rungs.map((f, i) => {
        const [c, c2] = accent(f);
        const what = i < save.wins ? 'Beaten' : DIFFICULTY_NAMES[ladderDifficulty(i, rungs.length)];
        return `<div class="plate rung${i < save.wins ? ' won' : i === save.wins ? ' next sel' : ''}" style="--c:${c};--c2:${c2}"><div class="sw"></div><div class="pn"><i>${i + 1}</i>${esc(lastName(f))}</div><div class="ps">${what}</div></div>`;
      }).join('') + '</div>' +
      '<div class="hint">← → choose · Enter select · Esc menu</div>';
    this.setAccent(s.querySelector<HTMLElement>('.info')!, next);
    this.setAccent(s.querySelector<HTMLElement>('.ladhead')!, this.player);
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
    s.innerHTML = '<div class="panel sheet"><div class="shead"><h2>Gym</h2><div class="btns"></div></div><div class="sub">One drill, one feeling, in the order to meet them. In a drill: R starts it again, N and P go to the next and the previous one, Esc comes back here.</div><div class="drills"></div></div>';
    const box = s.querySelector('.drills')!;
    this.btns = [];
    this.drills.forEach((d, i) => {
      const it = document.createElement('div');
      it.className = 'ditem';
      it.innerHTML = `<div class="n">${i + 1}</div><div class="t">${esc(d.title)}${d.seconds ? `<small>${d.seconds} s</small>` : ''}</div><div class="g">${esc(d.goal)}</div><div class="c">${esc(d.controls.map(c => c.move).join(' · '))}</div>`;
      const act = (): void => this.startDrill(d);
      it.addEventListener('pointerdown', e => { e.preventDefault(); act(); });
      box.appendChild(it);
      this.btns.push({ el: it, act });
    });
    this.setBtns(s.querySelector('.btns')!, [['Back', () => this.show(this.gymBack), true]], true);
  }

  private startDrill(d: Drill): void {
    this.mode = 'gym';
    // A drill is one long round: the round clock must not end it.
    this.keptRounds ??= [this.cfg.roundCount, this.cfg.roundSeconds];
    this.cfg.roundCount = 1; this.cfg.roundSeconds = 180;
    this.untune();
    if (d.tune) {
      const patch = d.tune(this.cfg) as Record<string, unknown>, live = this.cfg as unknown as Record<string, unknown>;
      this.keptTune = {};
      for (const k of Object.keys(patch)) { this.keptTune[k] = live[k]; live[k] = patch[k]; }
    }
    const opp = this.roster.find(f => f.id !== this.player.id)!;
    this.opp = this.opp.id !== this.player.id ? this.opp : opp;
    const run: DrillRun = { def: d, tick: 0, acc: {}, t0: -1, done: '', doneT: 0, last: { progress: 0, stat: '' }, shown: '' };
    this.drill = run;
    this.drillEl.innerHTML = '';
    this.method = null; this.overT = 0; this.seenPhase = 'fighting'; this.cardRound = -1;
    this.stats.reset();
    this.hooks.crowd(null, false);
    // A drill may change the partner (a taller man, a style): a spec of its own, so the body is rebuilt for it.
    const partner: FighterSpec = d.opponentSpec ? { ...this.opp, ...d.opponentSpec, id: `${this.opp.id}~${d.id}` } : this.opp;
    this.hooks.start(this.player, partner, {
      difficulty: this.cfg.aiDifficulty,
      driver: d.opponent ? s => d.opponent!(s, run.tick++) : null,
      prepare: s => this.placeDrill(s, d),
    });
    this.director.setSlots(this.player, partner);
    this.previewWant = null;
    this.show('fight');
    this.syncFight();
  }

  /**
   * The drill's start: the two men where it wants them, 30 idle ticks so the hands are on the guard (a moved fighter's
   * gloves are still where he was), then its own setup — so a drill that starts you hurt starts you hurt.
   */
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

  private stepDrill(by: number): void {
    if (!this.drill) return;
    const i = this.drills.findIndex(d => d.id === this.drill!.def.id);
    this.startDrill(this.drills[(i + by + this.drills.length) % this.drills.length]!);
  }

  /** Put back whatever config the last drill ran under. */
  private untune(): void {
    if (!this.keptTune) return;
    const live = this.cfg as unknown as Record<string, unknown>;
    for (const k of Object.keys(this.keptTune)) live[k] = this.keptTune[k];
    this.keptTune = null;
  }

  private endDrill(): void {
    this.drill = null;
    this.untune();
    if (this.keptRounds) { [this.cfg.roundCount, this.cfg.roundSeconds] = this.keptRounds; this.keptRounds = null; }
  }

  private renderControls(): void {
    const s = this.screens.controls;
    s.innerHTML = `<div class="panel sheet wide"><div class="shead"><h2>Controls</h2><div class="btns"></div></div>${controlsHtml()}</div>`;
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
    // (A drill has no pause: its strip has its own Gym button, and on a phone the pause button would sit on the strip.)
    this.pauseBtn.classList.toggle('on', this.screen === 'fight' && !this.paused && !this.card && !this.replaying && !this.drill);
    if (this.drill && this.screen === 'fight' && !this.drillEl.firstChild) this.buildDrillPanel(this.drill.def);
    else if (!this.drill && this.drillEl.firstChild) this.drillEl.innerHTML = '';
  }

  /** The drill panel: what to do, the exact controls for it on each device, the live stat, the clock, and the ways on. */
  private buildDrillPanel(d: Drill): void {
    const i = this.drills.findIndex(x => x.id === d.id);
    this.drillEl.innerHTML =
      `<div class="dl"><div class="t"><i>${i + 1} / ${this.drills.length}</i>${esc(d.title)}<span class="clk"></span></div><div class="g">${esc(d.goal)}</div>` +
      '<div class="prog"><div></div></div><div class="s"></div>' +
      '<div class="k">R again · N next · P previous · Esc gym</div><div class="dbtns"></div></div>' +
      `<table class="dc"><tr><th></th><th class="kb">Keys</th><th class="pd">Pad</th><th class="tc">Touch</th></tr>${d.controls.map(c => `<tr><td>${esc(c.move)}</td><td class="kb">${esc(c.keys)}</td><td class="pd">${esc(c.pad)}</td><td class="tc">${esc(c.touch)}</td></tr>`).join('')}</table>`;
    const box = this.drillEl.querySelector('.dbtns')!;
    for (const [label, act] of [['‹ Previous', () => this.stepDrill(-1)], ['Again', () => this.startDrill(d)], ['Next ›', () => this.stepDrill(1)], ['Gym', () => this.show('gym')]] as const) {
      const b = document.createElement('div');
      b.className = 'dbtn';
      b.textContent = label;
      b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); act(); });
      box.appendChild(b);
    }
  }

  private beginFight(): void {
    this.endDrill();
    if (this.mode !== 'ladder') this.mode = 'fight';
    const r = this.roundsOverride ?? ROUNDS[this.roundsIdx]!;
    this.cfg.roundCount = r[0]; this.cfg.roundSeconds = r[1];
    this.cfg.aiDifficulty = this.difficulty;   // the menu's choice is the one difficulty key
    this.method = null; this.lastRound = 0; this.overT = 0; this.seenPhase = 'fighting'; this.cardRound = -1; this.ladderWon = false;
    this.recorded = false; this.recordNow = null;
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
      // A strip along the bottom, not a card: the two men stand above it.
      const col = (f: FighterSpec, side: 'l' | 'r'): string => `<div class="${side}"><div class="fname">${esc(f.name)}</div><div class="tl">${esc(tapeLine(f))}</div></div>`;
      s.innerHTML = '<div class="tapecard">' + col(a, 'l') +
        `<div class="vs">VS<small>${this.cfg.roundCount} × ${clockText(this.cfg.roundSeconds)}${this.mode === 'ladder' ? ` · ${DIFFICULTY_NAMES[this.difficulty]}` : ''}</small></div>` + col(b, 'r') +
        '</div><div class="hint top">Any button skips</div>';
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
    // The judges' cards are hidden until the results unless flowShowScores is on.
    let scores = '';
    if (this.cfg.flowShowScores && s.round.score.length) {
      const tot = s.round.score.reduce((t, c) => [t[0] + c[0], t[1] + c[1]], [0, 0]);
      scores = '<div class="gap"></div>' + s.round.score.map((c, n) => this.statRow(`Judges · round ${n + 1}`, c[0], c[1])).join('') + this.statRow('Judges · total', tot[0], tot[1]);
    }
    this.cardEl.innerHTML =
      '<div class="scroll">' +
      `<div class="big">End of round ${i + 1}</div><div class="nextup">Round ${i + 2} of ${this.cfg.roundCount} next</div>` +
      '<div class="cgrid">' +
      `<div class="nm l" style="--c:${accent(this.player)[0]}">${esc(lastName(this.player))}</div><div class="lbl">Round ${i + 1}</div><div class="nm r" style="--c:${accent(this.opp)[0]}">${esc(lastName(this.opp))}</div>` +
      this.statRow('Landed / thrown', lt(ra), lt(rb)) +
      this.statRow('Clean', ra.clean, rb.clean) + this.statRow('Flush', ra.flush, rb.flush) +
      this.statRow('To the head', ra.head, rb.head) + this.statRow('To the body', ra.body, rb.body) +
      this.statRow('Knockdowns', ra.knockdowns, rb.knockdowns) +
      scores +
      '<div class="gap"></div>' +
      cond('Health', fa.health, fb.health) + cond('Stamina ceiling', fa.staminaCap ?? 1, fb.staminaCap ?? 1) +
      cond('Head damage', fa.damage?.head ?? 0, fb.damage?.head ?? 0, true) + cond('Body damage', fa.damage?.body ?? 0, fb.damage?.body ?? 0, true) +
      '</div>' +
      `<div class="advice"><span>Your corner</span>${esc(advice([ra, rb], s, 0))}</div>` +
      '</div><div class="foot"><span>Any button: next round</span><span class="count"></span></div>';
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
    this.hooks.audioPaused(on);
    if (on) this.renderPause(); else this.btns = [];
    this.syncFight();
  }

  private renderPause(): void {
    this.cursor = 0;
    if (this.pauseView === 'controls') {
      this.pauseEl.innerHTML = `<div class="panel sheet wide"><div class="shead"><h2>Controls</h2><div class="btns"></div></div>${controlsHtml()}</div>`;
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

  /** The created fighter's result goes into his record once per fight (a real fight or the ladder, never a drill). A rematch starts a new fight and clears the flag. */
  private writeRecord(m: Method | null): void {
    if (this.recorded || !m || this.player.id !== CREATOR_ID || (this.mode !== 'fight' && this.mode !== 'ladder')) return;
    this.recorded = true;
    const kind = m.kind === 'ko' ? 'KO' : m.kind === 'tko' ? 'TKO' : 'decision';
    const rounds = m.kind === 'decision' ? m.cards.length || this.lastRound + 1 : m.round + 1;
    this.recordNow = applyFight(loadRecord(), { opponent: this.opp.name, result: m.winner === null ? 'D' : m.winner === 0 ? 'W' : 'L', method: kind, round: rounds, when: Date.now() });
    saveRecord(this.recordNow);
  }

  private renderResults(): void {
    const [a, b] = [this.player, this.opp];
    const s = this.screens.results;
    const m = this.method;
    const winner = m ? m.winner : null;
    const name = winner === null ? 'Draw' : (winner === 0 ? a : b).name;
    this.writeRecord(m);
    let how = '';
    if (m?.kind === 'ko') how = `Wins by knockout · round ${m.round + 1}`;
    else if (m?.kind === 'tko') how = `Wins by TKO · round ${m.round + 1}`;
    else if (m) how = winner === null ? 'The judges score it even' : 'Wins on points';
    const cards = m?.kind === 'decision' ? m.cards : this.last ? this.last.round.score : [];
    let table = '';
    if (cards.length) {
      const tot = cards.reduce((t, c) => [t[0] + c[0], t[1] + c[1]], [0, 0]);
      table = `<div class="lhead">The judges</div><table class="cards"><tr><th></th>${cards.map((_, i) => `<th>R${i + 1}</th>`).join('')}<th>TOTAL</th></tr>` +
        `<tr><td class="n">${esc(lastName(a))}</td>${cards.map(c => `<td>${c[0]}</td>`).join('')}<td class="t">${tot[0]}</td></tr>` +
        `<tr><td class="n">${esc(lastName(b))}</td>${cards.map(c => `<td>${c[1]}</td>`).join('')}<td class="t">${tot[1]}</td></tr></table>`;
    }
    const note = m && m.kind !== 'decision'
      ? `<div class="cardnote">${cards.length ? 'The cards at the stoppage (completed rounds only).' : 'Stopped before a round was scored.'}</div>` : '';
    // Round by round: what each man landed, how much of it was clean or flush, how much went to the body, knockdowns scored.
    const rr = this.stats.rounds;
    const cell = (r: SideStats): string => `<td>${landedOf(r)}</td><td>${r.clean + r.flush}</td><td>${r.body}</td><td>${r.knockdowns}</td>`;
    const rounds = rr.length ? '<div class="lhead">Round by round</div><table class="rounds"><tr><th></th><th></th><th>Landed</th><th>Clean</th><th>Body</th><th>KD</th></tr>' +
      rr.map((r, i) => `<tr><td class="rn" rowspan="2">R${i + 1}</td><td class="n">${esc(lastName(a))}</td>${cell(r[0])}</tr><tr class="b"><td class="n">${esc(lastName(b))}</td>${cell(r[1])}</tr>`).join('') + '</table>' : '';
    const [ta, tb] = this.stats.total;
    const fam = PUNCHES.map(p => this.statRow(p === 'jab' ? 'Jabs' : p === 'cross' ? 'Crosses' : p === 'hook' ? 'Hooks' : 'Uppercuts', `${ta.landed[p]} / ${ta.thrown[p]}`, `${tb.landed[p]} / ${tb.thrown[p]}`)).join('');
    const stats = `<div class="lhead">The fight</div><div class="sgrid"><div class="nm l">${esc(lastName(a))}</div><div class="lbl">Landed / thrown</div><div class="nm r">${esc(lastName(b))}</div>` + fam +
      '<div class="rule"></div>' +
      this.statRow('Total', `${landedOf(ta)} / ${thrownOf(ta)}`, `${landedOf(tb)} / ${thrownOf(tb)}`) +
      this.statRow('Accuracy', pct(landedOf(ta), thrownOf(ta)), pct(landedOf(tb), thrownOf(tb))) +
      this.statRow('Clean', ta.clean, tb.clean) + this.statRow('Flush', ta.flush, tb.flush) +
      this.statRow('To the head', ta.head, tb.head) + this.statRow('To the body', ta.body, tb.body) +
      this.statRow('Counters', ta.counters, tb.counters) + this.statRow('Knockdowns', ta.knockdowns, tb.knockdowns) + '</div>';
    s.innerHTML = `<div class="panel info resultp"><div class="scroll"><div class="winner">${esc(name)}</div><div class="method">${how}</div>${this.recordNow ? `<div class="fmeta recline"><span>Record</span> <b>${esc(recordLine(this.recordNow))}</b></div>` : ''}${table}${note}${rounds}${stats}</div><div class="foot"><div class="btns"></div></div></div>`;
    const sheet = s.querySelector<HTMLElement>('.resultp')!;
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
    if (this.revealing) {   // the poster: any key but a bare modifier moves on
      if (!e.repeat && !/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(c)) { this.endReveal(); e.preventDefault(); }
      return;
    }
    const a: Act | null =
      c === 'ArrowUp' || c === 'KeyW' ? 'up' : c === 'ArrowDown' || c === 'KeyS' ? 'down' :
      c === 'ArrowLeft' || c === 'KeyA' ? 'left' : c === 'ArrowRight' || c === 'KeyD' ? 'right' :
      c === 'Enter' || c === 'NumpadEnter' || c === 'Space' ? 'ok' : c === 'Escape' ? 'back' : c === 'KeyR' ? 'r' :
      c === 'KeyN' || c === 'BracketRight' ? 'next' : c === 'KeyP' || c === 'BracketLeft' ? 'prev' :
      c === 'KeyJ' || c === 'KeyK' || c === 'KeyL' || c === 'Semicolon' ? 'any' : null;
    if (!a) return;
    const dir = a === 'up' || a === 'down' || a === 'left' || a === 'right';
    if (e.repeat && !dir) return;
    if (this.act(a)) e.preventDefault();
  }

  /** A menu action from any device. Returns whether it was used. */
  private act(a: Act): boolean {
    if (this.revealing) { this.endReveal(); return true; }   // a pad button
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
        if (a === 'next') { this.stepDrill(1); return true; }
        if (a === 'prev') { this.stepDrill(-1); return true; }
        return false;
      }
      if (back || a === 'start') { this.setPaused(true); return true; }
      return false;
    }
    if (a === 'next' || a === 'prev') return false;
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
      case 'gym': this.show(this.gymBack); break;
      case 'results': if (this.mode === 'ladder') this.show('ladder'); else this.show('title'); break;
      case 'title': break;
      default: this.show('title');
    }
  }

  /** Gamepad on the menus: edges of the d-pad / stick, A, B, Start, Select. In the fight only Start (Select too in a drill; on a card or a replay, any face button). */
  private pollPad(): void {
    if (typeof navigator.getGamepads !== 'function') return;
    let g: Gamepad | null = null;
    for (const p of navigator.getGamepads()) if (p && p.connected) { g = p; break; }
    if (!g) return;
    const ax = g.axes[0] ?? 0, ay = g.axes[1] ?? 0;
    const now: Record<string, boolean> = {
      up: !!g.buttons[12]?.pressed || ay < -0.6, down: !!g.buttons[13]?.pressed || ay > 0.6,
      left: !!g.buttons[14]?.pressed || ax < -0.6, right: !!g.buttons[15]?.pressed || ax > 0.6,
      ok: !!g.buttons[0]?.pressed, back: !!g.buttons[1]?.pressed, any: !!g.buttons[2]?.pressed || !!g.buttons[3]?.pressed,
      start: !!g.buttons[9]?.pressed, next: !!g.buttons[8]?.pressed,
    };
    const live = this.screen === 'fight' && !this.paused && !this.card && !this.replaying;
    for (const k of Object.keys(now)) {
      if (now[k] && !this.pad[k]) {
        if (live && k !== 'start' && k !== 'next') continue;
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

    if (this.drill) { this.updateDrill(this.drill, s, dt, events); this.seenPhase = ph; return; }

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

  /**
   * A drill, per frame: its metric, its clock, and its end — the metric reaching 1 ("Done"), the suggested length
   * running out ("Time"), the player going down, or the fight ending ("Over"). The partner going down does not end it. It then shows the result for
   * flowDrillRestartSeconds and starts again; N / P move on or back at any time.
   */
  private updateDrill(d: DrillRun, s: SimState, dt: number, events: readonly SimEvent[]): void {
    if (d.t0 < 0) d.t0 = s.time;
    const secs = d.def.seconds;
    const left = secs > 0 ? Math.max(0, secs - (s.time - d.t0)) : -1;
    if (!d.done) {
      const m = d.def.metric ? d.def.metric(s, events, d.acc) : { progress: 0, stat: '' };
      d.last = m;
      const down = events.some(e => e.type === 'knockdown' && e.side === 0);
      const ph = s.round.phase;
      if (m.progress >= 1) d.done = 'Done';
      else if (down) d.done = 'You went down';
      // Putting HIM down does not end it: the count runs, he gets up, the drill and its tally go on. Only a fight that is over does.
      else if (ph === 'over' || ph === 'between') d.done = 'Over';
      else if (left === 0) d.done = 'Time';
      if (d.done) d.doneT = this.cfg.flowDrillRestartSeconds;
    } else {
      d.doneT -= dt;
      if (d.doneT <= 0) { this.startDrill(d.def); return; }
    }
    const stat = d.done ? `${d.done}. ${d.last.stat}` : d.last.stat;
    const clk = d.done ? `again in ${Math.max(1, Math.ceil(d.doneT))}` : left >= 0 ? `${Math.ceil(left)} s` : '';
    const key = `${stat}|${clk}|${d.last.progress.toFixed(2)}`;
    if (key === d.shown) return;
    d.shown = key;
    const bar = this.drillEl.querySelector<HTMLElement>('.prog div'), st = this.drillEl.querySelector('.s'), ck = this.drillEl.querySelector('.clk');
    if (bar) bar.style.width = `${Math.round(Math.min(1, Math.max(0, d.last.progress)) * 100)}%`;
    if (st) st.textContent = stat;
    if (ck) ck.textContent = clk;
    this.drillEl.classList.toggle('done', d.done !== '');
  }

  private lowerThird(text: string): void {
    this.third.textContent = text;
    this.third.classList.add('on');
    this.thirdT = this.cfg.lowerThirdSeconds;
  }
}

/**
 * ui/create.ts — the "create your fighter" fields (the DOM and the save). The flow owns the
 * screen, the buttons and the keyboard cursor; this owns the text boxes, the two sliders, the
 * five rating bars (live), the build sentence and the colour swatches, and the saved draft.
 *
 * Height and weight are the only things that move the ratings (core/creator.ts). The ring
 * preview rebuilds on a slider's release or a click, never per drag step; the bars and the
 * numbers move live. The draft is one JSON record in localStorage; every access is in
 * try/catch, so with storage blocked it plays on and is forgotten on reload.
 */
import { addToRoster, buildRatings, buildRead, CREATOR_ID, CREATOR_TEXT_MAX, defaultDraft, draftToSpec, ROSTER, type Config, type FighterDraft, type FighterSpec } from '../core';

import { wordmarkSvg } from './wordmark';
import { clearRecord, loadRecord } from './record';
import { recordLine, withBodyLock } from '../core';

const KEY = 'boxing.fighter.v1';
const RATINGS = ['power', 'speed', 'chin', 'stamina', 'defense'] as const;
const KIT = ['#b8202a', '#d9531e', '#e0b020', '#2f8f4e', '#1f6b6b', '#2b4a9e', '#5a2a8a', '#d0457a', '#16161c', '#eeeae0'] as const;
type KitKey = 'trunksPrimary' | 'trunksSecondary' | 'gloves' | 'boots';
const KIT_ROWS: readonly (readonly [KitKey, string])[] = [['trunksPrimary', 'Trunks'], ['trunksSecondary', 'Trim'], ['gloves', 'Gloves'], ['boots', 'Boots']];
const LB_PER_KG = 2.20462;

const HEX = /^#[0-9a-f]{6}$/i;
const str = (v: unknown, fb: string): string => (typeof v === 'string' ? v.slice(0, CREATOR_TEXT_MAX) : fb);
const col = (v: unknown, fb: string): string => (typeof v === 'string' && HEX.test(v) ? v : fb);

export function loadDraft(cfg: Config): FighterDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<FighterDraft> | null;
    if (!o || typeof o !== 'object') return null;
    const d = defaultDraft(cfg);
    return {
      name: str(o.name, d.name), nickname: str(o.nickname, d.nickname), hometown: str(o.hometown, d.hometown),
      stance: o.stance === 'southpaw' ? 'southpaw' : 'orthodox',
      heightM: typeof o.heightM === 'number' && Number.isFinite(o.heightM) ? o.heightM : d.heightM,
      massKg: typeof o.massKg === 'number' && Number.isFinite(o.massKg) ? o.massKg : d.massKg,
      skinTone: o.skinTone === 'dark' ? 'dark' : 'light',
      trunksPrimary: col(o.trunksPrimary, d.trunksPrimary), trunksSecondary: col(o.trunksSecondary, d.trunksSecondary),
      gloves: col(o.gloves, d.gloves), boots: col(o.boots, d.boots), hairColor: col(o.hairColor, d.hairColor),
      // A save from before the lock existed counts as locked if he already has fights on his record.
      locked: o.locked === true || (o.locked === undefined && (r => r.wins + r.losses + r.draws > 0)(loadRecord())),
    };
  } catch { return null; }
}

export function saveDraft(d: FighterDraft): void {
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* no storage: the fighter lives for this page load only */ }
}

export function clearDraft(): void {
  try { localStorage.removeItem(KEY); } catch { /* no storage */ }
}

/** Take the created fighter off the roster (retired). */
export function unregisterFighter(): void {
  const r = ROSTER as FighterSpec[];
  const i = r.findIndex(f => f.id === CREATOR_ID);
  if (i >= 0) r.splice(i, 1);
}

/** Put the player's fighter on the roster, first, so he is the default player and the first plate on the select screen. */
export function registerFighter(spec: FighterSpec): void {
  addToRoster(spec);
  const r = ROSTER as FighterSpec[];   // the roster is one live array (core/roster.ts); the creator's man leads it
  const i = r.findIndex(f => f.id === CREATOR_ID);
  if (i > 0) r.unshift(r.splice(i, 1)[0]!);
}

/** On game start: the saved fighter (if any) joins the roster. */
export function loadSavedFighter(cfg: Config): FighterSpec | null {
  const d = loadDraft(cfg);
  if (!d) return null;
  const spec = draftToSpec(d, cfg);
  registerFighter(spec);
  return spec;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const ftIn = (m: number): string => { const inch = Math.round(m / 0.0254); return `${Math.floor(inch / 12)}'${inch % 12}"`; };

export class CreateScreen {
  private d: FighterDraft;
  private bars = {} as Record<(typeof RATINGS)[number], { fill: HTMLElement; num: HTMLElement }>;
  private hOut!: HTMLElement; private wOut!: HTMLElement; private reachOut!: HTMLElement; private readOut!: HTMLElement;
  private stanceEls: HTMLElement[] = []; private skinEls: HTMLElement[] = [];
  private kitEls = {} as Record<KitKey, HTMLElement[]>;

  /** `onPreview(spec)`: the ring should show this man now. */
  constructor(private cfg: Config, private onPreview: (spec: FighterSpec) => void, private onRetire: () => void = () => undefined) { this.d = loadDraft(cfg) ?? defaultDraft(cfg); }

  get saved(): boolean { return loadDraft(this.cfg) !== null; }
  /** The draft as it will be saved: a locked save keeps its height and weight whatever this edit says. */
  private effective(lock = false): FighterDraft { return withBodyLock(loadDraft(this.cfg), this.d, lock); }
  get locked(): boolean { return this.effective().locked; }
  spec(): FighterSpec { return draftToSpec(this.effective(), this.cfg); }
  /** Save the draft and hand back the finished fighter. `lock`: he is stepping into the ring, so his body is set for good. */
  commit(lock = false): FighterSpec {
    const d = this.effective(lock);
    this.d = d; saveDraft(d);
    return draftToSpec(d, this.cfg);
  }

  /** Retire him: the saved draft, his record and his place on the roster go; the next create screen starts from the default draft. */
  private retire(): void {
    clearDraft(); clearRecord(); unregisterFighter();
    this.d = defaultDraft(this.cfg);
    this.onRetire();
  }

  /** Build the fields into `box` (cleared first). The draft is re-read from storage, so Back-then-return keeps what was saved. */
  mount(box: HTMLElement): void {
    const c = this.cfg;
    this.d = loadDraft(c) ?? this.d;
    box.textContent = '';
    box.appendChild(el('div', 'lhead', 'Tale of the tape'));
    const rec = el('div', 'reach recline'); rec.innerHTML = '<span>Record</span> <b></b>';
    rec.querySelector('b')!.textContent = recordLine(loadRecord());
    box.appendChild(rec);
    for (const [key, label, ph] of [['name', 'Name', 'The Challenger'], ['nickname', 'Nickname', 'The Unknown'], ['hometown', 'Home town', 'Nowhere, USA']] as const) {
      const row = el('label', 'field'); row.appendChild(el('span', undefined, label));
      const inp = el('input'); inp.type = 'text'; inp.maxLength = CREATOR_TEXT_MAX; inp.placeholder = ph; inp.value = this.d[key];
      inp.autocomplete = 'off'; inp.spellcheck = false; inp.setAttribute('autocapitalize', 'words'); inp.setAttribute('enterkeyhint', 'done');
      inp.addEventListener('input', () => { this.d[key] = inp.value; });
      this.leaveOnKey(inp);
      row.appendChild(inp); box.appendChild(row);
    }
    // Stance and skin tone: two buttons each.
    const two = (label: string, names: readonly [string, string], cur: number, pick: (i: number) => void, keep: HTMLElement[]): void => {
      const row = el('div', 'opt'); row.appendChild(el('span', undefined, label));
      const ch = el('div', 'choices'); row.appendChild(ch);
      names.forEach((n, i) => {
        const b = el('div', `ch${i === cur ? ' sel' : ''}`, n);
        b.addEventListener('pointerdown', e => { e.preventDefault(); pick(i); keep.forEach((x, j) => x.classList.toggle('sel', j === i)); });
        keep.push(b); ch.appendChild(b);
      });
      box.appendChild(row);
    };
    this.stanceEls = []; this.skinEls = [];
    two('Stance', ['Orthodox', 'Southpaw'], this.d.stance === 'southpaw' ? 1 : 0, i => { this.d.stance = i ? 'southpaw' : 'orthodox'; this.preview(); }, this.stanceEls);
    two('Skin', ['Light', 'Dark'], this.d.skinTone === 'dark' ? 1 : 0, i => { this.d.skinTone = i ? 'dark' : 'light'; this.preview(); }, this.skinEls);

    // The two sliders. Dragging moves the numbers and the bars; the ring rebuilds on release.
    const slider = (label: string, lo: number, hi: number, val: number, set: (v: number) => void): HTMLElement => {
      const row = el('div', 'slide'); row.appendChild(el('span', undefined, label));
      const out = el('b'); const inp = el('input'); inp.type = 'range';
      inp.min = String(lo); inp.max = String(hi); inp.step = '1'; inp.value = String(Math.round(val)); inp.disabled = this.d.locked;
      inp.addEventListener('input', () => { set(Number(inp.value)); this.refresh(); });
      inp.addEventListener('change', () => this.preview());
      this.leaveOnKey(inp);
      row.appendChild(out); row.appendChild(inp); box.appendChild(row);
      return out;
    };
    this.hOut = slider('Height', Math.round(c.createHeightMin * 100), Math.round(c.createHeightMax * 100), this.d.heightM * 100, v => { this.d.heightM = v / 100; });
    this.wOut = slider('Weight', Math.round(c.createMassMin), Math.round(c.createMassMax), this.d.massKg, v => { this.d.massKg = v; });
    box.appendChild(el('div', 'lockline', this.d.locked ? 'His body is set. His look can still change.' : 'Height and weight are set for good once he steps into the ring.'));
    this.reachOut = el('div', 'reach'); box.appendChild(this.reachOut);

    const rat = el('div', 'ratings');
    for (const k of RATINGS) {
      rat.appendChild(el('span', undefined, k));
      const bar = el('div', 'bar'); const fill = el('div', 'fill'); bar.appendChild(fill); rat.appendChild(bar);
      const num = el('i'); rat.appendChild(num);
      this.bars[k] = { fill, num };
    }
    box.appendChild(rat);
    this.readOut = el('div', 'read'); box.appendChild(this.readOut);

    box.appendChild(el('div', 'lhead', 'Kit'));
    for (const [key, label] of KIT_ROWS) {
      const row = el('div', 'swrow'); row.appendChild(el('span', undefined, label));
      const sws = el('div', 'sws'); row.appendChild(sws);
      this.kitEls[key] = [];
      for (const hex of KIT) {
        const s = el('div', 'swc'); s.style.background = hex; s.title = hex;
        s.addEventListener('pointerdown', e => { e.preventDefault(); this.d[key] = hex; this.markKit(key); this.preview(); });
        this.kitEls[key].push(s); sws.appendChild(s);
      }
      this.markKit(key);
      box.appendChild(row);
    }
    if (this.d.locked) this.retireBlock(box);
    this.refresh();
  }

  /** Low-key retire link at the foot of the panel; it asks once, in the panel. */
  private retireBlock(box: HTMLElement): void {
    const wrap = el('div', 'retire'); box.appendChild(wrap);
    const link = (): void => {
      wrap.textContent = '';
      const a = el('div', 'retlink', 'Retire him and start a new fighter');
      a.addEventListener('pointerdown', e => { e.preventDefault(); ask(); });
      wrap.appendChild(a);
    };
    const ask = (): void => {
      wrap.textContent = '';
      const q = el('div', 'retq'); q.textContent = `Retire ${this.spec().name}? His record (${recordLine(loadRecord())}) goes with him.`;
      const row = el('div', 'retbtns');
      const yes = el('div', 'retlink danger', 'Retire'), no = el('div', 'retlink', 'Keep him');
      yes.addEventListener('pointerdown', e => { e.preventDefault(); this.retire(); });
      no.addEventListener('pointerdown', e => { e.preventDefault(); link(); });
      row.appendChild(yes); row.appendChild(no);
      wrap.appendChild(q); wrap.appendChild(row);
    };
    link();
  }

  /** The fight poster after "Step into the ring": fills `box` (the screen) with the card; `onDone` runs on a tap or click. Text goes in as text, never as markup. */
  reveal(box: HTMLElement, spec: FighterSpec, onDone: () => void): void {
    box.textContent = '';
    const poster = el('div', 'poster');
    const card = el('div', 'pcard'); poster.appendChild(card);
    card.appendChild(el('div', 'pw', wordmarkSvg('LONG', 'COUNT', 'MAIN EVENT BOXING')));
    card.appendChild(el('div', 'lhead', 'Introducing'));
    const name = el('div', 'fname'); name.textContent = spec.name; card.appendChild(name);
    const nick = el('div', 'fnick'); nick.textContent = `"${spec.nickname}"`; card.appendChild(nick);
    const out = el('div', 'fmeta'); out.textContent = `fighting out of ${spec.hometown}`; card.appendChild(out);
    const tape = el('div', 'ptape');
    for (const [k, v] of [['Height', `${ftIn(spec.heightM)} · ${Math.round(spec.heightM * 100)} cm`], ['Weight', `${Math.round(spec.massKg * LB_PER_KG)} lb · ${spec.massKg} kg`], ['Reach', `${Math.round(spec.reachM * 100)} cm`]] as const) {
      tape.appendChild(el('span', undefined, k)); tape.appendChild(el('b', undefined, v));
    }
    card.appendChild(tape);
    const rec = el('div', 'prec'); rec.innerHTML = '<span>Record</span><i></i>'; rec.querySelector('i')!.textContent = recordLine(loadRecord()); card.appendChild(rec);
    card.appendChild(el('div', 'pgo', 'Press any key or tap to continue'));
    poster.addEventListener('pointerdown', e => { e.preventDefault(); onDone(); });
    box.appendChild(poster);
  }

  private markKit(key: KitKey): void { this.kitEls[key].forEach((s, i) => s.classList.toggle('sel', KIT[i] === this.d[key].toLowerCase())); }

  /** Enter or Escape in a field hands the keyboard back to the menu (the flow ignores keys while a field has focus). */
  private leaveOnKey(inp: HTMLInputElement): void {
    inp.addEventListener('keydown', e => { if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Escape') { inp.blur(); e.preventDefault(); } });
  }

  /** The numbers, the bars and the sentence: live while a slider drags. */
  private refresh(): void {
    const c = this.cfg, d = this.d;
    const r = buildRatings(d.heightM, d.massKg, c);
    const spec = draftToSpec(d, c);
    this.hOut.textContent = `${ftIn(spec.heightM)} · ${Math.round(spec.heightM * 100)} cm`;
    this.wOut.textContent = `${Math.round(spec.massKg * LB_PER_KG)} lb · ${spec.massKg} kg`;
    this.reachOut.innerHTML = `Reach <b>${Math.round(spec.reachM * 100)} cm</b> · follows his height`;
    for (const k of RATINGS) { this.bars[k].fill.style.width = `${r[k]}%`; this.bars[k].num.textContent = String(r[k]); }
    this.readOut.textContent = buildRead(d, c);
  }

  private preview(): void { this.onPreview(this.spec()); }
}

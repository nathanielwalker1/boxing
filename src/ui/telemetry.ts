/**
 * ui/telemetry.ts — DEV TELEMETRY (UI workstream). A developer's tool, not a read: the shipping game shows no words
 * (docs/FEEL.md, "no arcade reads"), so this is OFF by default (cfg.devTelemetry, tuning panel, ?tune=1). It tells
 * the owner whether a mechanic fired before he judges how it feels: each fighter's last punch landed (type, hand,
 * target, zone, grade, counter, damage, impulse, hit-stop, blocked), live health / stamina / hurt / punch phase, the
 * last 8 events, and running tallies (so a counter's damage multiplier can be read off the average).
 *
 * Nothing here decides anything and nothing is added to the sim: damage is the target's health delta over the tick
 * of the event, hit-stop is the global freeze the tick granted (seconds x 60 = ticks), stamina spent is the drop over
 * the tick of the punchStart. Off, `tick` returns at once and no element exists. On, the text is rebuilt only on an
 * event or every few ticks and written to the DOM only when it changed. `window.__telemetry` exposes the same numbers.
 */
import type { Config, FighterState, SimEvent, SimState } from '../core';

export interface LastHit {
  tick: number; kind: 'land' | 'block' | 'perfectBlock'; punch: string; hand: string; part: string; zone: string;
  grade: string; counter: boolean; counterRule: string; blocked: boolean; damage: number; damagePct: number;
  impulse: number; hitStopTicks: number;
}
export interface Tally { thrown: number; landed: number; blocked: number; counters: number; counterDmg: number; normalLanded: number; normalDmg: number; avgCounter: number; avgNormal: number }
export interface FighterTelemetry {
  health: number; stamina: number; staminaSpent: number; hurt: number; hurtKind: string; hurtStyle: string; down: boolean; punch: string; phase: string;
  last: LastHit | null; tally: Tally;
}
export interface TelemetryProbe { on: boolean; tick: number; fighters: [FighterTelemetry, FighterTelemetry]; log: string[]; text: string; reset: () => void }

const CSS = `
#dev-telemetry { position: fixed; left: 8px; bottom: 8px; z-index: 30; pointer-events: none; margin: 0; padding: 6px 8px;
  width: 520px; max-width: calc(100vw - 16px); box-sizing: border-box; background: #000b; color: #9fe8a8;
  font: 10px/1.25 ui-monospace, Menlo, Consolas, monospace; white-space: pre; overflow: hidden; border-radius: 3px; }
`;
const EVERY = 6;   // ticks between rebuilds when no event happened (live bars)

const emptyTally = (): Tally => ({ thrown: 0, landed: 0, blocked: 0, counters: 0, counterDmg: 0, normalLanded: 0, normalDmg: 0, avgCounter: 0, avgNormal: 0 });
const emptyFighter = (): FighterTelemetry => ({ health: 1, stamina: 1, staminaSpent: 0, hurt: 0, hurtKind: '-', hurtStyle: '-', down: false, punch: '-', phase: '-', last: null, tally: emptyTally() });
const pct = (v: number): string => (v * 100).toFixed(1) + '%';

export class TelemetryOverlay {
  private el: HTMLElement | null = null;
  private style: HTMLStyleElement | null = null;
  private shown = '';
  private since = 0;
  private logRing: string[] = [];
  readonly probe: TelemetryProbe;

  constructor(private cfg: Config) {
    this.probe = { on: false, tick: 0, fighters: [emptyFighter(), emptyFighter()], log: [], text: '', reset: () => this.reset() };
    window.__telemetry = this.probe;
  }

  private reset(): void {
    this.probe.fighters = [emptyFighter(), emptyFighter()];
    this.logRing.length = 0; this.probe.log = this.logRing;
    this.shown = '';
  }

  /** Once per sim tick, after the step: `before` is the state going in, `after` the state coming out. */
  tick(before: SimState, after: SimState, events: readonly SimEvent[]): void {
    const p = this.probe;
    if (!this.cfg.devTelemetry) {
      if (p.on) { p.on = false; this.el?.remove(); this.el = null; this.shown = ''; }
      return;
    }
    if (!p.on) { p.on = true; this.since = EVERY; }
    p.tick = after.tick;
    let changed = false;
    // The freeze this tick granted: hitStop counts down by itself, so a rise is a new request (its seconds x 60 = ticks).
    const stopTicks = after.hitStop > before.hitStop ? Math.round(after.hitStop * 60) : 0;
    for (const e of events) {
      switch (e.type) {
        case 'punchStart': {
          const f = p.fighters[e.side];
          f.tally.thrown++;
          f.staminaSpent = Math.max(0, before.fighters[e.side].stamina - after.fighters[e.side].stamina);
          this.log(after.tick, `P${e.side} ${e.punch}/${e.hand} start ${e.variant}  -${pct(f.staminaSpent)} sta`);
          changed = true; break;
        }
        case 'punchLand': {
          const lost = Math.max(0, before.fighters[e.target].health - after.fighters[e.target].health);
          const f = p.fighters[e.side];
          const imp = Math.hypot(e.impulse.x, e.impulse.y, e.impulse.z);
          f.last = {
            tick: after.tick, kind: 'land', punch: e.punch, hand: e.hand, part: e.part, zone: e.zone ?? '-', grade: e.grade, counter: e.counter,
            counterRule: e.counter ? 'slip window' : '', blocked: false,
            damage: lost, damagePct: lost * 100, impulse: imp, hitStopTicks: stopTicks,
          };
          f.tally.landed++;
          if (e.counter) { f.tally.counters++; f.tally.counterDmg += lost; f.tally.avgCounter = f.tally.counterDmg / f.tally.counters; }
          else { f.tally.normalLanded++; f.tally.normalDmg += lost; f.tally.avgNormal = f.tally.normalDmg / f.tally.normalLanded; }
          this.log(after.tick, `P${e.side} ${e.punch}/${e.hand} LAND ${e.part}${e.zone ? '.' + e.zone : ''} ${e.grade}${e.counter ? ' COUNTER' : ''} -${pct(lost)} hs${stopTicks}`);
          changed = true; break;
        }
        case 'punchBlock': case 'perfectBlock': {
          const lost = Math.max(0, before.fighters[e.target].health - after.fighters[e.target].health);
          const f = p.fighters[e.side];
          const perfect = e.type === 'perfectBlock';
          f.last = {
            tick: after.tick, kind: perfect ? 'perfectBlock' : 'block', punch: e.punch, hand: '-', part: e.type === 'punchBlock' ? e.part : '-', zone: '-', grade: '-',
            counter: false, counterRule: '', blocked: true, damage: lost, damagePct: lost * 100, impulse: 0, hitStopTicks: stopTicks,
          };
          f.tally.blocked++;
          this.log(after.tick, `P${e.side} ${e.punch} ${perfect ? 'PERFECT-BLOCKED' : 'blocked'} chip -${pct(lost)}`);
          changed = true; break;
        }
        case 'punchWhiff': this.log(after.tick, `P${e.side} ${e.punch} whiff`); changed = true; break;
        case 'slip': if (e.dodged) { this.log(after.tick, `P${e.side} slip dodged`); changed = true; } break;
        case 'counter': this.log(after.tick, `P${e.side} counter event (${e.punch})`); changed = true; break;
        case 'rocked': this.log(after.tick, `P${e.side} ROCKED by P${e.by} ${e.seconds.toFixed(1)}s`); changed = true; break;
        case 'hurtStyle': this.log(after.tick, `P${e.side} hurt ${e.kind}/${e.style}`); changed = true; break;
        case 'knockdown': this.log(after.tick, `P${e.side} KNOCKDOWN #${e.count} ${e.cause}`); changed = true; break;
        case 'guardBreak': this.log(after.tick, `P${e.side} guard break by P${e.by}`); changed = true; break;
        default: break;
      }
    }
    for (let i = 0; i < 2; i++) this.live(p.fighters[i]!, after.fighters[i]!);
    if (!changed && ++this.since < EVERY) return;
    this.since = 0;
    this.draw();
  }

  private live(t: FighterTelemetry, f: FighterState): void {
    t.health = f.health; t.stamina = f.stamina; t.hurt = f.hurt; t.hurtKind = f.hurt > 0 ? f.hurtKind : '-'; t.hurtStyle = f.hurt > 0 ? f.hurtStyle : '-';
    t.down = f.down; t.punch = f.punch.type ?? '-'; t.phase = f.punch.type ? f.punch.phase : '-';
  }

  private log(tick: number, s: string): void {
    this.logRing.push(`t${tick} ${s}`);
    if (this.logRing.length > 8) this.logRing.shift();
    this.probe.log = this.logRing;
  }

  private draw(): void {
    const p = this.probe;
    let out = '';
    for (let i = 0; i < 2; i++) {
      const f = p.fighters[i]!, l = f.last, t = f.tally;
      out += `P${i}${i === 0 ? ' (you)' : ' (opp)'}  hp ${pct(f.health)}  sta ${pct(f.stamina)} (last act -${pct(f.staminaSpent)})  hurt ${f.hurt > 0 ? `${f.hurtKind}/${f.hurtStyle} ${f.hurt.toFixed(2)}s` : '-'}${f.down ? '  DOWN' : ''}  punch ${f.punch}:${f.phase}\n`;
      out += l
        ? `  last t${l.tick} ${l.punch}/${l.hand} ${l.kind} ${l.part}${l.zone !== '-' ? '.' + l.zone : ''} grade ${l.grade} counter ${l.counter ? 'YES' + ' [' + l.counterRule + ']' : 'no'} dmg ${l.damage.toFixed(4)} (${l.damagePct.toFixed(2)}%) imp ${l.impulse.toFixed(0)} hitstop ${l.hitStopTicks}t blocked ${l.blocked ? 'YES' : 'no'}\n`
        : '  last -\n';
      out += `  thrown ${t.thrown} landed ${t.landed} blocked ${t.blocked} counters ${t.counters}  avg dmg counter ${t.counters ? (t.avgCounter * 100).toFixed(2) + '%' : '-'} vs normal ${t.normalLanded ? (t.avgNormal * 100).toFixed(2) + '%' : '-'}\n`;
    }
    out += '--- events ---\n' + this.logRing.join('\n');
    p.text = out;
    if (out === this.shown) return;
    this.shown = out;
    if (!this.el) {
      if (!this.style) { this.style = document.createElement('style'); this.style.textContent = CSS; document.head.appendChild(this.style); }
      this.el = document.createElement('pre');
      this.el.id = 'dev-telemetry';
      document.body.appendChild(this.el);
    }
    this.el.textContent = out;
  }
}

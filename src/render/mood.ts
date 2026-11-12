/**
 * render/mood.ts — the crowd's mood: ONE excitement value (0..1, fast attack,
 * slow decay) plus discrete reactions, derived from sim events. The stands
 * (arena.ts), the camera flashes and the crowd audio (ui/audio/crowd.ts) all
 * read this one object, so what the house does and what it sounds like can
 * never disagree.
 *
 * Feedback rule (FEEL.md, Nate's standing verdict): outcomes are told through
 * bodies, sound, the crowd and the camera — never words or flashes on the
 * screen. This module is where "the crowd" half of that is decided.
 *
 * Nothing here feeds the sim. Stage owns the clock: `handle(events)` then
 * `update(dt)` once per rendered frame. Unknown event types are ignored, and
 * fields SIM is still adding (`grade` on punchLand) are read defensively.
 */
import type { Config, SimEvent } from '../core';

export type ReactionKind =
  | 'land'        // a clean punch
  | 'flush'       // a flush one: the house answers out loud
  | 'body'        // a clean / flush body shot (a lower "ooh")
  | 'counter'
  | 'rocked'
  | 'knockdown'
  | 'ko'
  | 'nearMiss'    // a slipped punch: the gasp
  | 'getUp'
  | 'bell'
  | 'decision'
  // Phase 2: the new fight events.
  | 'escape'      // off the ropes by craft: appreciation
  | 'guardBreak'  // a guard knocked apart: the house rises
  | 'liver'       // the liver shot lands: a wince before anything shows
  | 'bodyHurt'    // …and he folds: the long "oooh"
  | 'grumble'     // too much holding
  | 'ole'         // a chain of slips (strength rises with the chain)
  | 'knee'        // the downed man gets to a knee: a swell
  | 'slump'       // …and falls back: a groan
  | 'rise'        // …and stands: a roar
  | 'wince'       // a knockdown from the body: a groan, not an eruption
  | 'shock'       // a flash knockdown: a gasp, then the roar
  // Polish phase: the tiers and the kinds.
  | 'bodyFlush'   // a flush body shot: the intake, then a bigger "oof"
  | 'finisher'    // the last punch of a clean combination: the house pops
  | 'flashDown'   // knockdown.kind flash: a shout and surprise that settles fast
  | 'kneeDown'    // knockdown.kind knee: a murmur
  | 'out'         // knockdown.kind out: a gasp, a roar, then it drops away
  | 'hurtLegs'    // rocked and the legs are gone
  | 'hurtReach'   // rocked and reaching for balance
  | 'lateFold'    // the body shot that shows a beat late
  | 'hurtKnee';   // winded and sinking toward a knee

export interface Reaction {
  kind: ReactionKind;
  /** 0..1+: how big, against the kind's own normal (a hard flush hook > a flush jab). */
  strength: number;
  /** Where on the floor it happened (the side of the ring the ripple starts from), or null. */
  pos: { x: number; z: number } | null;
}

type Listener = (r: Reaction) => void;
export type Grade = 'glancing' | 'clean' | 'flush';

/** `grade` off a punchLand, before and after SIM adds the field. */
export function gradeOf(e: SimEvent): Grade {
  const g = (e as { grade?: string }).grade;
  return g === 'glancing' || g === 'flush' ? g : 'clean';
}

export class CrowdMood {
  /** Smoothed excitement, 0..1. */
  value = 0;
  /** 0..1: the house holding its breath while the referee counts. */
  hush = 0;
  /** True while a rocked fighter is being chased (the rising roar). */
  get chasing(): boolean { return this.hurtT > 0; }

  private energy = 0;
  private sinceLand = 0;
  private hurtT = 0;
  private countT = -1;          // seconds since the knockdown while a count runs, else -1
  private settleT = 0;          // seconds left of fast settling (a flash knockdown: he is straight back up)
  private outT = -1;            // seconds since a man went out cold, else -1 (the roar, then the house drops away)
  private bellAgo = 99;
  private clock = 0;
  private clinches: number[] = [];   // mood-clock times of recent clinches
  private lastPos: { x: number; z: number } | null = null;
  private listeners = new Set<Listener>();
  private forced: number | null = null;

  on(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  /** Tell the listeners (the stands, the flashes, the crowd audio). */
  private emit(kind: ReactionKind, strength = 1, pos: { x: number; z: number } | null = null): void {
    const r: Reaction = { kind, strength, pos: pos ?? this.lastPos };
    for (const fn of this.listeners) fn(r);
  }

  /** Fire a reaction by hand (tests, the host's ring walk later): lifts excitement as the real event would, then tells the listeners. */
  react(kind: ReactionKind, strength = 1, pos: { x: number; z: number } | null = null): void {
    const c = this.cfg;
    if (c) {
      const gain: Record<ReactionKind, number> = {
        land: c.exciteLand, flush: c.exciteLand * c.exciteFlush, body: c.exciteLand, counter: c.exciteCounter, rocked: c.exciteRocked,
        knockdown: 1, ko: 1, nearMiss: c.exciteNearMiss, getUp: c.exciteGetUp, bell: c.exciteBell, decision: c.exciteBell,
        escape: c.exciteEscape, guardBreak: c.exciteGuardBreak, liver: c.exciteLand * c.exciteFlush, bodyHurt: c.exciteBodyHurt,
        grumble: 0, ole: c.exciteOle, knee: c.exciteGetUp * 0.6, slump: 0, rise: c.exciteGetUp, wince: c.exciteBodyHurt, shock: 1,
        bodyFlush: c.exciteLand * c.exciteFlush, finisher: c.exciteFinisher, flashDown: c.exciteFlashKd, kneeDown: c.exciteKneeKd, out: 1,
        hurtLegs: 0, hurtReach: 0, lateFold: 0, hurtKnee: 0,
      };
      this.add(gain[kind] * strength);
    }
    if (pos) this.lastPos = pos;
    this.emit(kind, strength, pos);
  }
  private cfg: Config | null = null;

  /** Pin excitement to `v` (0..1), or null to hand it back to the events. */
  force(v: number | null): void { this.forced = v === null ? null : Math.min(1, Math.max(0, v)); }

  private lift(to: number): void { if (to > this.energy) this.energy = Math.min(1, to); }
  private add(by: number): void { this.energy = Math.min(1, this.energy + by); }

  handle(events: readonly SimEvent[], c: Config): void {
    this.cfg = c;
    for (const e of events) {
      switch (e.type) {
        case 'punchLand': {
          const grade = gradeOf(e);
          const tiers = c.showCrowdTiersOn;
          this.lastPos = { x: e.at.x, z: e.at.z };
          if (tiers && grade === 'glancing') break;   // a miss that touched is nothing to the house: no nudge, no sound, and the lull keeps running
          const scale = grade === 'glancing' ? c.exciteGlance : grade === 'flush' ? c.exciteFlush : 1;
          const chase = this.hurtT > 0 ? c.exciteChaseLand : 1;
          // A combination builds in the stands too: each later clean punch counts for more.
          const build = tiers ? 1 + c.exciteComboStep * Math.min(4, Math.max(0, ((e as { combo?: number }).combo ?? 1) - 1)) : 1;
          this.add(c.exciteLand * scale * chase * build * Math.max(0.3, e.power));
          this.sinceLand = 0;
          if (c.showFinisherOn && (e as { finisher?: boolean }).finisher === true) { this.add(c.exciteFinisher); this.emit('finisher', Math.min(1.5, e.power)); }
          else if (grade === 'flush') this.emit(e.part === 'body' ? (tiers ? 'bodyFlush' : 'body') : 'flush', Math.min(1.5, e.power));
          else if (grade === 'clean') this.emit(e.part === 'body' ? 'body' : 'land', Math.min(1.5, e.power) * 0.5);
          break;
        }
        case 'counter': this.add(c.exciteCounter); this.emit('counter'); break;
        case 'rocked':
          this.add(c.exciteRocked); this.hurtT = Math.max(this.hurtT, e.seconds);
          this.emit('rocked');
          break;
        case 'slip':
          if (e.dodged) {
            // One slip is a gasp; a chain of them is the house starting to sing along.
            const chain = (e as { chain?: number }).chain ?? 1;
            if (chain >= 2) { this.add(c.exciteOle * chain); this.emit('ole', Math.min(1.5, chain / 3)); }
            else { this.add(c.exciteNearMiss); this.emit('nearMiss', 0.6); }
          }
          break;
        case 'punchWhiff': if (this.hurtT > 0) this.add(c.exciteNearMiss); break;
        case 'knockdown': {
          this.hurtT = 0; this.countT = 0;
          // The kind of knockdown (polish phase) decides the house: read `kind` first, the overhaul's `cause` for a heavy one.
          const kind = c.showKindsOn ? (e as { kind?: string }).kind : undefined;
          if (kind === 'out') { this.lift(1); this.countT = -1; this.outT = 0; this.emit('out'); }                        // no count: no hush for one — the drop comes from outT
          else if (kind === 'knee') { this.lift(c.exciteKneeKd); this.emit('kneeDown'); }                                // a murmur, and the house waits out the count
          else if (kind === 'flash') { this.lift(c.exciteFlashKd); this.countT = -1; this.settleT = c.showFlashSettleSeconds; this.emit('flashDown'); }   // he is up at two: no hush
          else if (e.cause === 'body') { this.lift(c.exciteWince); this.emit('wince'); }
          else if (e.cause === 'flash' && kind === undefined) { this.lift(1); this.emit('shock'); }
          else { this.lift(1); this.emit('knockdown'); }
          break;
        }
        case 'hurtStyle': {
          if (!c.showKindsOn) break;
          const h = e as { kind?: string; style?: string; late?: boolean };
          if (h.kind === 'head' && h.style === 'legs') this.emit('hurtLegs');
          else if (h.kind === 'head' && h.style === 'reach') this.emit('hurtReach');
          else if (h.kind === 'body') { if (h.late) this.emit('lateFold'); if (h.style === 'knee') this.emit('hurtKnee'); }
          break;
        }
        case 'escape': this.add(c.exciteEscape); this.emit('escape'); break;
        case 'guardBreak': this.add(c.exciteGuardBreak); this.emit('guardBreak'); break;
        case 'liverShot': this.add(c.exciteLand * c.exciteFlush); this.emit('liver'); break;
        case 'bodyHurt':
          this.add(c.exciteBodyHurt); this.hurtT = Math.max(this.hurtT, e.seconds);   // a winded man is chased like a rocked one
          this.emit('bodyHurt');
          break;
        case 'clinch':
          // Holding once is boxing; holding again and again inside the window is a grumble, and the house cools.
          this.clinches = this.clinches.filter(t => this.clock - t < c.clinchGrumbleWindow);
          this.clinches.push(this.clock);
          if (this.clinches.length >= c.clinchGrumbleCount) { this.energy = Math.max(0, this.energy - c.exciteEscape); this.emit('grumble', Math.min(1.5, this.clinches.length / c.clinchGrumbleCount)); }
          break;
        case 'getUpPhase':
          if (e.phase === 'knee') { this.lift(c.exciteGetUp * 0.8); this.emit('knee'); }
          else if (e.phase === 'slump') this.emit('slump');
          else if (e.phase === 'rise') { this.lift(c.exciteGetUp); this.emit('rise'); }
          break;
        case 'getUp': this.countT = -1; this.lift(c.exciteGetUp); this.emit('getUp'); break;
        case 'ko': case 'tko':
          this.countT = -1; this.lift(1);
          // Waved off (he was out before he landed): the 'out' reaction is the house's whole answer — no ovation over a man who is not moving.
          if (!(c.showKindsOn && e.type === 'ko' && (e as { waved?: boolean }).waved === true)) this.emit('ko');
          break;
        case 'decision': this.lift(c.exciteBell); this.emit('decision'); break;
        case 'roundStart': this.outT = -1; this.settleT = 0; this.bell(c); break;
        case 'roundEnd': case 'bell': this.bell(c); break;
        default: break;   // events this module has no opinion on, and ones SIM adds later
      }
    }
  }

  /** The bell reaches here by two roads (sim events, and the flow's own bell on the bus): one applause per bell. */
  bell(c: Config): void {
    if (this.bellAgo < 0.6) return;
    this.bellAgo = 0;
    this.sinceLand = 0;
    this.lift(c.exciteBell);
    this.emit('bell');
  }

  update(dt: number, c: Config): void {
    this.cfg = c;
    this.clock += dt;
    this.bellAgo += dt;
    this.sinceLand += dt;
    if (this.hurtT > 0) { this.hurtT -= dt; this.add(c.exciteChase * dt); }
    if (this.countT >= 0) this.countT += dt;
    const base = this.sinceLand > c.exciteLullSeconds ? c.exciteLull : c.exciteBase;
    if (this.settleT > 0) this.settleT -= dt;
    this.energy += (base - this.energy) * (1 - Math.exp(-c.exciteDecay * (this.settleT > 0 ? c.showFlashSettle : 1) * dt));
    // Out cold: the gasp and the roar run, then the house drops away to near silence and stays there.
    if (this.outT >= 0) this.outT += dt;
    const dropped = this.outT > c.showOutDropAfter;
    if (dropped) this.energy += (c.showOutDrop - this.energy) * (1 - Math.exp(-2.5 * dt));
    const target = this.forced ?? this.energy;
    const rate = target > this.value ? c.exciteAttack : Math.max(c.exciteDecay, 2);
    this.value += (target - this.value) * (1 - Math.exp(-rate * dt));
    const hushTarget = this.countT >= c.countHushDelay || dropped ? 1 : 0;
    this.hush += (hushTarget - this.hush) * (1 - Math.exp(-(hushTarget ? 1.5 : 4) * dt));
  }
}

/** The one mood in the room. Stage drives it; the arena and the crowd audio follow it. */
export const mood = new CrowdMood();

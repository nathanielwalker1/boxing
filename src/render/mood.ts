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
  | 'decision';

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
  private bellAgo = 99;
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
          const scale = grade === 'glancing' ? c.exciteGlance : grade === 'flush' ? c.exciteFlush : 1;
          const chase = this.hurtT > 0 ? c.exciteChaseLand : 1;
          this.add(c.exciteLand * scale * chase * Math.max(0.3, e.power));
          this.lastPos = { x: e.at.x, z: e.at.z };
          this.sinceLand = 0;
          if (grade === 'flush') this.emit(e.part === 'body' ? 'body' : 'flush', Math.min(1.5, e.power));
          else if (grade === 'clean') this.emit(e.part === 'body' ? 'body' : 'land', Math.min(1.5, e.power) * 0.5);
          break;
        }
        case 'counter': this.add(c.exciteCounter); this.emit('counter'); break;
        case 'rocked':
          this.add(c.exciteRocked); this.hurtT = Math.max(this.hurtT, e.seconds);
          this.emit('rocked');
          break;
        case 'slip': if (e.dodged) { this.add(c.exciteNearMiss); this.emit('nearMiss', 0.6); } break;
        case 'punchWhiff': if (this.hurtT > 0) this.add(c.exciteNearMiss); break;
        case 'knockdown': this.lift(1); this.hurtT = 0; this.countT = 0; this.emit('knockdown'); break;
        case 'getUp': this.countT = -1; this.lift(c.exciteGetUp); this.emit('getUp'); break;
        case 'ko': case 'tko': this.countT = -1; this.lift(1); this.emit('ko'); break;
        case 'decision': this.lift(c.exciteBell); this.emit('decision'); break;
        case 'roundStart': case 'roundEnd': case 'bell': this.bell(c); break;
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
    this.bellAgo += dt;
    this.sinceLand += dt;
    if (this.hurtT > 0) { this.hurtT -= dt; this.add(c.exciteChase * dt); }
    if (this.countT >= 0) this.countT += dt;
    const base = this.sinceLand > c.exciteLullSeconds ? c.exciteLull : c.exciteBase;
    this.energy += (base - this.energy) * (1 - Math.exp(-c.exciteDecay * dt));
    const target = this.forced ?? this.energy;
    const rate = target > this.value ? c.exciteAttack : Math.max(c.exciteDecay, 2);
    this.value += (target - this.value) * (1 - Math.exp(-rate * dt));
    const hushTarget = this.countT >= c.countHushDelay ? 1 : 0;
    this.hush += (hushTarget - this.hush) * (1 - Math.exp(-(hushTarget ? 1.5 : 4) * dt));
  }
}

/** The one mood in the room. Stage drives it; the arena and the crowd audio follow it. */
export const mood = new CrowdMood();

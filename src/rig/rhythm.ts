/**
 * rig/rhythm.ts — the living rhythm of a fighter who is not punching (cfg.rhythmV2). DRAWN ONLY: nothing here reaches
 * src/sim, so hit shapes, reach and fight outcomes are identical with it on or off.
 *
 * What it makes, per frame (rig-local: x forward, y up, z toward the fighter's right, metres):
 *   hip / shoulder / head / glove offsets, each reading the same beat at a later moment (phase lag down the body: hips
 *   first, shoulders, head, gloves last); a front-to-back weight rock; the rear / lead heel lift; and little re-placing
 *   steps of each foot (world-space offsets on top of the foot planter, lifted and replanted; a planted foot never moves).
 * Irregular on purpose: every beat gets its own period and size (a few per cent either way) and every few seconds there
 * is a hitch. All of it derived from a counter-based hash of (side, draw index): no Math.random, no clocks.
 * Quiet: `q` (0..1) is the rig's rhythm gate (0 while punching / blocking / hurt / tired), applied to every amplitude.
 */
import type { Config } from '../core';
import { smoothstep } from '../core';

const TAU = Math.PI * 2;
const STYLE_KEY: Record<string, string> = { outboxer: 'Outboxer', swarmer: 'Swarmer', pressure: 'Pressure', slugger: 'Slugger', counter: 'Counter' };

/** Counter-based hash to [0, 1): same (a, b) → same number on every engine. */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export interface Vec3o { x: number; y: number; z: number }
const v3 = (): Vec3o => ({ x: 0, y: 0, z: 0 });

/** The style's multipliers (cfg.rhythm<Style><Param>), read once per call. */
interface Prof { hz: number; bob: number; step: number; weave: number; paw: number; sink: number; breath: number; back: number; leadDrop: number }
function profile(c: Config, id: string | undefined): Prof {
  const s = STYLE_KEY[id ?? ''] ?? 'Outboxer';
  const g = (p: string): number => (c as unknown as Record<string, number>)[`rhythm${s}${p}`] ?? 1;
  return { hz: g('Hz'), bob: g('Bob'), step: g('Step'), weave: g('Weave'), paw: g('Paw'), sink: g('Sink'), breath: g('Breath'), back: s === 'Counter' ? c.rhythmCounterBack : 0, leadDrop: s === 'Counter' ? c.rhythmCounterLeadDrop : 0 };
}

interface Foot { off: Vec3o; from: Vec3o; to: Vec3o; t: number; dur: number; wait: number; follow: number }
const foot = (): Foot => ({ off: v3(), from: v3(), to: v3(), t: 1, dur: 0.2, wait: 0, follow: -1 });

export class Rhythm {
  readonly hip = v3();
  readonly shoulder = v3();
  readonly head = v3();
  readonly glove = [v3(), v3()] as const;
  /** Weight rock, −1 (back on the rear foot) … +1 (forward on the lead foot), at the hips' moment. */
  rock = 0;
  /** Heel lifts off the floor, m (0 = down). */
  heelRear = 0; heelLead = 0;
  /** The extra body sink, m (down +): the posture, and the settle before a punch. */
  sink = 0;
  /** The hips' set-back, m (posture; the counter-puncher keeps his weight further back). */
  backX = 0;
  /** Foot offsets from the planter, WORLD x / z, and the lift, y. Index 0 = lead foot. */
  readonly feet = [v3(), v3()] as const;
  /** How many re-placing steps have started, and the last one's length (m), for probes. */
  stepsTaken = 0; lastStepLen = 0;

  private t = 0; private phase = 0; private n = 0;
  private pm = 1; private am = 1; private amT = 1; private boost = false;
  private breakIn: number; private breakDue = false;
  private swayPh: number; private pawPh = [0, 0]; private breathPh = 0;
  private cycle = 1;
  private foots = [foot(), foot()] as const;

  constructor(private readonly side: number) {
    this.swayPh = side * 2.1;
    this.breakIn = 4 + this.rnd() * 4;
    this.foots[0].wait = 0.8 + this.rnd() * 1.2;
    this.foots[1].wait = 2 + this.rnd() * 2;
    this.phase = side * 1.9;
  }

  private rnd(): number { return hash01(this.side * 7919 + 13, this.n++); }

  /**
   * dt s; q the rhythm gate 0..1; moving 0..1 (walking: the bounce shrinks); canStep (nothing else is moving the feet);
   * (fx, fz) and (rx, rz) the fighter's forward and right axes in the world; leadSign the lead side's lateral sign.
   */
  update(dt: number, c: Config, styleId: string | undefined, q: number, moving: number, canStep: boolean, fx: number, fz: number, rx: number, rz: number, leadSign: number, breathRatio: number, breathPh: number): void {
    const P = profile(c, styleId);
    this.t += dt;
    // ── The beat, with a new period and size every cycle, and a hitch every few seconds ──
    const hz = c.rhythmHz * P.hz;
    this.phase += dt * TAU * hz / this.pm;
    if (this.phase >= this.cycle * TAU) {
      this.cycle++;
      const J = c.rhythmJitter;
      if (this.breakDue) { this.pm = c.rhythmBreakStretch; this.amT = 0.55; this.breakDue = false; this.boost = true; }
      else { this.pm = 1 + J * (this.rnd() * 2 - 1); this.amT = (this.boost ? 1.2 : 1) * (1 + J * (this.rnd() * 2 - 1)); this.boost = false; }
    }
    this.breakIn -= dt;
    if (this.breakIn <= 0 && !this.breakDue) { this.breakDue = true; this.breakIn = c.rhythmBreakMin + this.rnd() * (c.rhythmBreakMax - c.rhythmBreakMin); }
    this.am += (this.amT - this.am) * Math.min(1, dt * 8);
    const hzEff = hz / this.pm;
    const A = this.am * q * (1 - 0.4 * moving);
    const lagPh = (lag: number): number => this.phase - TAU * hzEff * lag;
    const dipAt = (lag: number): number => 0.5 - 0.5 * Math.cos(lagPh(lag));
    const rockAt = (lag: number): number => Math.sin(lagPh(lag) * 0.5);

    // ── Head sway and bob-and-weave: its own slow clock, 10 % wobble in rate ──
    const W = P.weave;
    this.swayPh += dt * TAU / (c.rhythmSwayPeriod * Math.sqrt(1 / Math.max(0.2, P.hz))) * (1 + c.rhythmJitter * Math.sin(this.t * 0.9 + this.side * 1.7));
    const sw = Math.sin(this.swayPh) + 0.3 * Math.sin(this.swayPh * 1.7 + 0.8);
    const swZ = c.rhythmSwayAmp * W * sw * q;
    const swDip = c.rhythmWeaveDip * Math.max(0, W - 1) * (0.5 + 0.5 * Math.cos(this.swayPh * 2)) * q;
    const swX = c.rhythmSwayFwd * W * Math.sin(this.swayPh * 0.5 + 1.9) * q;

    // ── Body, each level reading the beat a little later ──
    const rk = c.rhythmRock * P.bob;
    this.rock = rockAt(0) * Math.min(1, A);
    this.hip.x = rk * rockAt(0) * A;
    this.hip.y = -c.rhythmDip * P.bob * dipAt(0) * A;
    this.hip.z = c.rhythmLatSway * P.bob * Math.sin(lagPh(0) * 0.5 + 1.3) * A * leadSign;
    this.head.x = rk * 1.3 * rockAt(c.rhythmHeadLag) * A + swX;
    this.head.y = -c.rhythmHeadDip * P.bob * dipAt(c.rhythmHeadLag) * A - swDip;
    this.head.z = c.rhythmLatSway * 1.5 * P.bob * Math.sin(lagPh(c.rhythmHeadLag) * 0.5 + 1.3) * A * leadSign + swZ;
    const br = Math.sin(breathPh) * 0.5 + 0.5;
    const lift = c.rhythmBreathLift * P.breath * Math.min(4, Math.max(0.5, breathRatio)) * br;
    this.shoulder.x = rk * 0.7 * rockAt(c.rhythmShoulderLag) * A + swX * 0.5;
    this.shoulder.y = -c.rhythmDip * P.bob * 0.6 * dipAt(c.rhythmShoulderLag) * A + lift * (0.5 + 0.5 * q) - swDip * 0.5;
    this.shoulder.z = c.rhythmLatSway * P.bob * Math.sin(lagPh(c.rhythmShoulderLag) * 0.5 + 1.3) * A * leadSign + swZ * 0.55;

    // ── Gloves: carried by the body a moment later, plus a pawing circle (lead bigger, rear smaller and slower) ──
    const gx = rk * 0.8 * rockAt(c.rhythmGloveLag) * A, gy = -c.rhythmDip * P.bob * 0.8 * dipAt(c.rhythmGloveLag) * A + lift * (0.5 + 0.5 * q) - swDip * 0.5, gz = swZ * 0.5;
    for (let i = 0; i < 2; i++) {
      const lead = i === 0;
      const hzP = (lead ? c.rhythmPawLeadHz : c.rhythmPawRearHz) * (1 + c.rhythmJitter * Math.sin(this.t * (lead ? 0.7 : 0.5) + this.side));
      this.pawPh[i] = this.pawPh[i]! + dt * TAU * hzP;
      const env = (0.65 + 0.35 * Math.sin(this.t * (lead ? 0.9 : 0.6) + this.side * 2.3)) * P.paw * Math.min(1, q + 0.15);
      const R = (lead ? c.rhythmPawLead : c.rhythmPawRear) * env, p = this.pawPh[i]!;
      const gl = this.glove[i]!;
      gl.x = gx + R * Math.cos(p) + (lead ? 0 : 0.4 * R * Math.sin(p * 0.5));
      gl.y = gy + R * 0.85 * Math.sin(p) - (lead ? P.leadDrop * q : 0);
      gl.z = gz + R * 0.5 * Math.sin(p * 1.3 + 0.9) * leadSign;
    }

    // ── Heels: the rear one stays off the floor and pumps; the lead one lifts as the weight goes back ──
    const back = Math.max(0, -rockAt(0));
    this.heelRear = (c.rhythmHeel + c.rhythmHeelPump * Math.sin(lagPh(0) - 0.4)) * q * (1 - 0.5 * moving) * Math.min(1.2, P.bob + 0.4);
    this.heelLead = c.rhythmLeadHeel * back * back * q * P.bob;
    // ── Posture + the settle: sunk and back; sinks further as the rhythm drops out (a punch winding up) ──
    this.sink = c.rhythmSink * P.sink + c.rhythmSettleSink * (1 - Math.min(1, q * 1.15));
    this.backX = c.rhythmBack * (0.4 + 0.6 * Math.min(1, P.sink)) + P.back;

    // ── Feet: small steps, lead more often, the rear following, a real lift and plant ──
    for (let i = 0; i < 2; i++) {
      const f = this.foots[i]!;
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / f.dur);
        const s = smoothstep(f.t);
        f.off.x = f.from.x + (f.to.x - f.from.x) * s; f.off.z = f.from.z + (f.to.z - f.from.z) * s;
        f.off.y = c.rhythmStepLift * Math.sin(Math.PI * f.t) * (i === 0 ? 1 : 0.8);
        if (f.t >= 1) f.off.y = 0;
      } else if (canStep && q > 0.7) {
        f.wait -= dt;
        if (f.wait <= 0) {
          const other = this.foots[1 - i]!;
          if (other.t < 1 && i === 0) continue;   // never both airborne
          this.begin(i, c, P, fx, fz, rx, rz, false);
          // the lead foot's step is followed a beat later by the rear (step-drag)
          if (i === 0 && hash01(this.side + 5, this.n++) < 0.75) this.foots[1].follow = c.rhythmStepDrag * (0.7 + 0.6 * this.rnd());
        }
      }
      if (i === 1 && this.foots[1].follow >= 0) {
        this.foots[1].follow -= dt;
        if (this.foots[1].follow < 0) {
          if (this.foots[1].t >= 1) { this.begin(1, c, P, fx, fz, rx, rz, true); this.foots[1].follow = -1; } else this.foots[1].follow = 0;
        }
      }
      const o = this.feet[i]!;
      o.x = f.off.x; o.z = f.off.z; o.y = f.off.y;
    }
  }

  /** Start a step of foot i. The target pulls the offset back toward zero and adds a new little move, so the foot averages out under him. */
  private begin(i: number, c: Config, P: Prof, fx: number, fz: number, rx: number, rz: number, drag: boolean): void {
    const f = this.foots[i]!;
    const len = c.rhythmStepMin + (c.rhythmStepMax - c.rhythmStepMin) * this.rnd();
    const fwdSign = this.rnd() < 0.5 ? 1 : -1, latDir = (this.rnd() * 2 - 1) * 0.5;
    let tx: number, tz: number;
    if (drag) {   // the rear foot comes to where the lead one went: same move, a little shorter
      const lead = this.foots[0]!;
      tx = lead.to.x * 0.8; tz = lead.to.z * 0.8;
    } else {
      const dx = (fwdSign * fx + latDir * rx) * len, dz = (fwdSign * fz + latDir * rz) * len;
      tx = -f.off.x * 0.7 + dx; tz = -f.off.z * 0.7 + dz;
    }
    const m = Math.hypot(tx, tz), cap = c.rhythmStepMaxOff;
    if (m > cap) { tx *= cap / m; tz *= cap / m; }
    const sx = tx - f.off.x, sz = tz - f.off.z, sl = Math.hypot(sx, sz);   // no step longer than the brief's
    if (sl > c.rhythmStepMax) { tx = f.off.x + sx * c.rhythmStepMax / sl; tz = f.off.z + sz * c.rhythmStepMax / sl; }
    f.from.x = f.off.x; f.from.z = f.off.z; f.to.x = tx; f.to.z = tz;
    f.t = 0; f.dur = c.rhythmStepDur * (0.85 + 0.3 * this.rnd());
    this.lastStepLen = Math.hypot(tx - f.off.x, tz - f.off.z);
    this.stepsTaken++;
    const every = (i === 0 ? c.rhythmStepEvery : c.rhythmStepEveryRear) / Math.max(0.2, P.step);
    f.wait = every * (1 + c.rhythmJitter * 2 * (this.rnd() * 2 - 1));
  }

  get stepping(): boolean { return this.foots[0].t < 1 || this.foots[1].t < 1; }
}

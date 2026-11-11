/**
 * ui/director.ts — what is in the ring and where the lens is while a menu or
 * a card is up. Presentation only. It never touches the game's SimState: the
 * figures it shows are FighterStates from small private sims of its own
 * (`createState` + `step`, the same way the pose hooks do it), handed to
 * main.ts as a `Scene` that the views and the camera draw instead of the
 * live fight.
 *
 *   wide       — the empty lit ring, the lens circling slowly (title, gym, controls)
 *   turntable  — one fighter in a sim-settled rest guard at ring centre, the
 *                lens circling HIM inside the ropes (select, opponent, ladder)
 *   walk       — the ring walk: each fighter in turn walks from his side of
 *                the ring to his mark while the lens pushes in, then the
 *                two-shot at centre with the referee
 *   corner     — between rounds: both men stood in opposite corners, wide shot
 *
 * The two view slots (main.ts `views`) always hold the bodies of `slots`;
 * the flow tells the director whenever it asks main.ts to rebuild one.
 */
import { NULL_INPUT, SIM_DT, cloneInput, frameOf, restFighterState, type Config, type FighterSpec, type FighterState, type FrameInput, type SimState, type Vec2 } from '../core';
import { createState, step } from '../sim';
import type { CameraShot } from '../render/stage';

export interface Scene {
  /** The two figures to draw (prev / next / blend, as the live loop does). */
  fighters: { prev: readonly [FighterState, FighterState]; next: readonly [FighterState, FighterState]; alpha: number };
  shot: CameraShot;
  /** The state the referee reads (he walks to it), or null = no referee in this scene. */
  refSim: SimState | null;
}

export type WalkBeat = 'walk1' | 'walk0' | 'stare' | 'done';

const PARK: Vec2 = { x: 60, z: 60 };   // out of sight, as the lookbook parks the second fighter
const DEG = Math.PI / 180;

export class Director {
  slots: [FighterSpec, FighterSpec];
  /** Wall seconds on menus: the orbit's clock. */
  private t = 0;
  private parked: [FighterState, FighterState] | null = null;
  private turn: FighterState | null = null;
  private corner: [FighterState, FighterState] | null = null;
  private walk: { prev: SimState; next: SimState; acc: number; t: number; marks: [Vec2, Vec2] } | null = null;

  constructor(private cfg: Config, slots: readonly [FighterSpec, FighterSpec]) { this.slots = [slots[0], slots[1]]; }

  /** main.ts rebuilt a view: everything cached for the old bodies is stale. */
  setSlots(a: FighterSpec, b: FighterSpec): void {
    this.slots = [a, b];
    this.parked = null; this.turn = null; this.corner = null; this.walk = null;
  }

  private get aspect(): number { return innerWidth / Math.max(1, innerHeight); }

  private park(): [FighterState, FighterState] {
    this.parked ??= [restFighterState(this.slots[0], this.cfg, PARK, 0), restFighterState(this.slots[1], this.cfg, PARK, 0)];
    return this.parked;
  }

  /** A fresh private sim with the two men stood at `a` and `b`, facing each other, hands settled on the guard. */
  private settled(a: Vec2, b: Vec2): SimState {
    let s = createState([this.slots[0], this.slots[1]], this.cfg, 1);
    const yaw = Math.atan2(b.z - a.z, b.x - a.x);
    s.fighters[0].pos = { x: a.x, z: a.z }; s.fighters[0].yaw = yaw;
    s.fighters[1].pos = { x: b.x, z: b.z }; s.fighters[1].yaw = yaw + Math.PI;
    const idle = cloneInput(NULL_INPUT);
    for (let i = 0; i < 40; i++) s = step(s, [idle, idle], this.cfg).state;
    return s;
  }

  private wideShot(): CameraShot {
    const c = this.cfg;
    // A tall, narrow screen sees less of the ring's width: back the lens off until the ring fits.
    const half = 4.2;
    const fit = half / (Math.tan(20 * DEG) * Math.min(1.6, this.aspect));
    return {
      key: 'wide', cut: true, focus: { x: 0, z: 0 }, lookY: 1.1, fov: 40, lambda: 30,
      azimuth: 0.6 + this.t * c.flowTitleOrbitDegPerSec * DEG,
      dist: Math.min(13, Math.max(c.flowTitleDist, fit)), elevationDeg: c.flowTitleElevationDeg,
    };
  }

  /** The empty ring. */
  wide(dt: number): Scene {
    this.t += dt;
    const p = this.park();
    return { fighters: { prev: p, next: p, alpha: 1 }, shot: this.wideShot(), refSim: null };
  }

  /** Slot 0's fighter at ring centre, the lens circling him. */
  turntable(dt: number): Scene {
    this.t += dt;
    const c = this.cfg;
    this.turn ??= this.settled({ x: 0, z: 0 }, { x: 1.6, z: 0 }).fighters[0];
    const f: [FighterState, FighterState] = [this.turn, this.park()[1]];
    const portrait = this.aspect < 0.8;
    // He faces +x; the orbit starts in front of him and a little to his lead side.
    const az = 0.45 + this.t * c.flowTurntableDegPerSec * DEG;
    // Look to his screen-right so he stands left of centre (the panel has the right). Screen-right on the floor is (sin az, −cos az).
    const off = portrait ? 0 : c.flowTurntableOffset;
    return {
      fighters: { prev: f, next: f, alpha: 1 },
      shot: {
        key: 'turn', cut: true, lambda: 30, azimuth: az,
        focus: { x: Math.sin(az) * off, z: -Math.cos(az) * off },
        dist: c.flowTurntableDist, elevationDeg: c.flowTurntableElevationDeg,
        lookY: portrait ? c.flowTurntablePortraitLookY : c.flowTurntableLookY,
        fov: portrait ? c.flowTurntablePortraitFov : c.flowTurntableFov,
      },
      refSim: null,
    };
  }

  /** Both men stood in opposite corners under the wide shot (the corner card). */
  corners(dt: number): Scene {
    this.t += dt;
    if (!this.corner) { const s = this.settled({ x: -2.05, z: -2.05 }, { x: 2.05, z: 2.05 }); this.corner = [s.fighters[0], s.fighters[1]]; }
    return { fighters: { prev: this.corner, next: this.corner, alpha: 1 }, shot: this.wideShot(), refSim: null };
  }

  // ── The ring walk ───────────────────────────────────────────────────────────

  /** Begin the walk: both men at their side of the ring (or already on their marks when the walk is off). */
  startWalk(): void {
    const fresh = createState([this.slots[0], this.slots[1]], this.cfg, 1);
    const marks: [Vec2, Vec2] = [{ ...fresh.fighters[0].pos }, { ...fresh.fighters[1].pos }];
    const on = this.cfg.flowWalkOn;
    const s = on ? this.settled({ x: -2.5, z: -0.9 }, { x: 2.5, z: 0.9 }) : this.settled(marks[0], marks[1]);
    this.walk = { prev: s, next: s, acc: 0, t: on ? 0 : 2 * this.cfg.flowWalkSeconds, marks };
  }

  /** Which beat the walk is in. */
  get beat(): WalkBeat {
    const w = this.walk, c = this.cfg;
    if (!w) return 'done';
    if (w.t < c.flowWalkSeconds) return 'walk1';
    if (w.t < 2 * c.flowWalkSeconds) return 'walk0';
    if (w.t < 2 * c.flowWalkSeconds + c.flowStareSeconds) return 'stare';
    return 'done';
  }

  /** Jump to the next beat (a skip press). */
  skipBeat(): void {
    const w = this.walk, c = this.cfg;
    if (!w) return;
    const b = this.beat;
    w.t = b === 'walk1' ? c.flowWalkSeconds : b === 'walk0' ? 2 * c.flowWalkSeconds : 2 * c.flowWalkSeconds + c.flowStareSeconds;
  }

  /** Stick input that walks `f` toward `to` on the floor (zero once he is there). */
  private toward(f: FighterState, to: Vec2): FrameInput {
    const i = cloneInput(NULL_INPUT);
    const dx = to.x - f.pos.x, dz = to.z - f.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.1) return i;
    const fr = frameOf(f.yaw);
    const sp = Math.min(0.62, 0.2 + d * 0.8);   // a walk, easing to a stop on the mark
    i.move.y = (dx * fr.fwd.x + dz * fr.fwd.z) / d * sp;
    i.move.x = (dx * fr.right.x + dz * fr.right.z) / d * sp;
    return i;
  }

  walkScene(dt: number): Scene {
    this.t += dt;
    if (!this.walk) this.startWalk();
    const w = this.walk!, c = this.cfg;
    w.t += dt;
    w.acc += Math.min(0.1, dt);
    const beat = this.beat;
    while (w.acc >= SIM_DT) {
      const f = w.next.fighters;
      // The opponent walks first; once a man has walked he keeps to his mark. From the stare on, both are sent to their marks (a skipped walk finishes here).
      const go1 = beat !== 'walk1' || w.t > 0.5, go0 = beat === 'stare' || beat === 'done' || (beat === 'walk0' && w.t > c.flowWalkSeconds + 0.5);
      const inputs: [FrameInput, FrameInput] = [go0 ? this.toward(f[0], w.marks[0]) : cloneInput(NULL_INPUT), go1 ? this.toward(f[1], w.marks[1]) : cloneInput(NULL_INPUT)];
      w.prev = w.next;
      w.next = step(w.next, inputs, c).state;
      w.acc -= SIM_DT;
    }
    let shot: CameraShot;
    if (beat === 'walk1' || beat === 'walk0') {
      const side = beat === 'walk1' ? 1 : 0;
      const u = Math.min(1, (w.t - (side === 1 ? 0 : c.flowWalkSeconds)) / Math.max(0.1, c.flowWalkSeconds));
      const p = w.next.fighters[side].pos;
      // In front of him and off his shoulder, inside the ropes; the lens closes as he comes.
      const narrow = this.aspect < 0.8 ? 1.25 : 1;
      shot = {
        key: beat, cut: true, lambda: 3, focus: { x: p.x, z: p.z }, lookY: 1.2, fov: 38,
        azimuth: (side === 0 ? 0 : Math.PI) + 0.6,
        dist: (c.flowWalkDist + (c.flowWalkDistEnd - c.flowWalkDist) * u) * narrow, elevationDeg: c.flowWalkElevationDeg,
      };
    } else {
      // The two-shot: side-on, as close as still holds both men.
      const fov = 46;
      const fit = 1.95 / (Math.tan(fov / 2 * DEG) * this.aspect);
      shot = { key: 'stare', cut: true, lambda: 3, focus: { x: 0, z: 0 }, lookY: 1.12, fov, azimuth: Math.PI / 2, dist: Math.max(2.95, fit), elevationDeg: c.flowWalkElevationDeg };
    }
    return { fighters: { prev: w.prev.fighters, next: w.next.fighters, alpha: w.acc / SIM_DT }, shot, refSim: w.next };
  }

  endWalk(): void { this.walk = null; }
}

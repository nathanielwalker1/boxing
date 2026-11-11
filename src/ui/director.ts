/**
 * ui/director.ts — what is in the ring and where the lens is while a menu or
 * a card is up. Presentation only. It never touches the game's SimState: the
 * figures it shows are FighterStates from small private sims of its own
 * (`createState` + `step`, the same way the pose hooks do it), handed to
 * main.ts as a `Scene` that the views and the camera draw instead of the
 * live fight.
 *
 *   spar       — the title: the two men in view sparring slowly (the AI on
 *                both sides, easy and unhurried, in a private sim that makes
 *                no sound), the referee with them, the lens circling wide
 *   wide       — the empty lit ring from the same orbit (gym, controls)
 *   turntable  — one fighter in a sim-settled rest guard (HIS guard: the sim
 *                gives him his style's) at ring centre, the lens circling HIM
 *                inside the ropes, starting in front of him
 *   walk       — the ring walk: each fighter in turn walks from his side of
 *                the ring to his mark while the lens pushes in, then the
 *                two-shot at centre with the referee
 *   corners    — between rounds: both men stood in opposite corners, the ring
 *                pushed to the left of the frame so the card has the right
 *   results    — the LIVE fight under a directed shot: the pair left of
 *                centre, closer, so the results panel has the right
 *
 * The two view slots (main.ts `views`) always hold the bodies of `slots`;
 * the flow tells the director whenever it asks main.ts to rebuild one.
 */
import { NULL_INPUT, SIM_DT, cloneInput, frameOf, restFighterState, type Config, type FighterSpec, type FighterState, type FrameInput, type SimEvent, type SimState, type Vec2 } from '../core';
import { createState, step } from '../sim';
import { aiStep, createAi, styleFor, type AiState } from '../ai';
import type { CameraShot } from '../render/stage';

export interface Scene {
  /** The two figures to draw (prev / next / blend, as the live loop does); null = the live fight, under `shot`. */
  fighters: { prev: readonly [FighterState, FighterState]; next: readonly [FighterState, FighterState]; alpha: number } | null;
  shot: CameraShot;
  /** The state the referee reads (he walks to it), or null = no referee in this scene. Ignored when `fighters` is null. */
  refSim: SimState | null;
  /** Put the referee on his spot this frame instead of walking him there (a cut). */
  refSnap?: boolean;
  /** Sim events for the VIEWS only (the title spar's hits move the bodies; nothing hears them). */
  events?: readonly SimEvent[];
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
  private turnT0 = 0;          // the orbit clock when this fighter came onto the turntable: he is first seen from the front
  private corner: [FighterState, FighterState] | null = null;
  private walk: { prev: SimState; next: SimState; acc: number; t: number; marks: [Vec2, Vec2]; beat: WalkBeat } | null = null;
  private spar: { prev: SimState; next: SimState; acc: number; ai: [AiState, AiState]; n: number } | null = null;
  private resultsAz: number | null = null;

  constructor(private cfg: Config, slots: readonly [FighterSpec, FighterSpec]) { this.slots = [slots[0], slots[1]]; }

  /** main.ts rebuilt a view: everything cached for the old bodies is stale. */
  setSlots(a: FighterSpec, b: FighterSpec): void {
    this.slots = [a, b];
    this.parked = null; this.turn = null; this.corner = null; this.walk = null; this.spar = null;
    this.turnT0 = this.t;
  }

  /** The guard the man on the turntable is standing in (scripts). */
  get turnGuard(): string { return this.turn ? this.turn.guardShape : ''; }

  /** A screen change: the turntable starts again from the front, a results shot is taken afresh. */
  cut(): void { this.turnT0 = this.t; this.resultsAz = null; }

  private get aspect(): number { return innerWidth / Math.max(1, innerHeight); }
  private get portrait(): boolean { return this.aspect < 0.8; }

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

  /** The wide orbit. `right`: metres the look point sits to the ring's screen-right, so the ring stands left of centre. */
  private wideShot(right = 0, dist = this.cfg.flowTitleDist): CameraShot {
    const c = this.cfg;
    // A tall, narrow screen sees less of the ring's width: back the lens off, but not into the fog.
    const fit = 4.2 / (Math.tan(20 * DEG) * Math.min(1.6, this.aspect));
    const az = 0.6 + this.t * c.flowTitleOrbitDegPerSec * DEG;
    return {
      key: 'wide', cut: true, focus: { x: Math.sin(az) * right, z: -Math.cos(az) * right }, lookY: 1.1, fov: 40, lambda: 30,
      azimuth: az, dist: Math.min(13, Math.max(dist, fit)), elevationDeg: c.flowTitleElevationDeg,
    };
  }

  /** The empty ring. */
  wide(dt: number): Scene {
    this.t += dt;
    const p = this.park();
    return { fighters: { prev: p, next: p, alpha: 1 }, shot: this.wideShot(), refSim: null };
  }

  /**
   * The title: the two men in view spar, slowly. A private sim with the AI on both sides at easy difficulty and half
   * the work rate; its events go to the views only, so it is silent. A fresh spar every 45 s or when one ends.
   */
  sparring(dt: number): Scene {
    this.t += dt;
    const c = this.cfg;
    let fresh = false;
    if (!this.spar || this.spar.next.round.phase !== 'fighting' || this.spar.next.tick > 45 * 60) {
      const n = (this.spar?.n ?? 0) + 1;
      const s = createState([this.slots[0], this.slots[1]], c, 100 + n);
      const easy = (side: 0 | 1): AiState => {
        const st = styleFor(this.slots[side], c, 0);
        return createAi(side, 200 + n * 2 + side, c, { ...st, aggression: st.aggression * 0.5, attackDelayMin: st.attackDelayMin * 2, attackDelayMax: st.attackDelayMax * 2.5 });
      };
      this.spar = { prev: s, next: s, acc: 0, ai: [easy(0), easy(1)], n };
      fresh = true;
    }
    const w = this.spar;
    const events: SimEvent[] = [];
    w.acc += Math.min(0.1, dt);
    while (w.acc >= SIM_DT) {
      const a = aiStep(w.ai[0], w.next, c), b = aiStep(w.ai[1], w.next, c);
      w.ai = [a.ai, b.ai];
      const r = step(w.next, [a.input, b.input], c);
      w.prev = w.next; w.next = r.state;
      for (const e of r.events) events.push(e);
      w.acc -= SIM_DT;
    }
    // A touch closer than the empty ring would be: there are people to look at.
    return { fighters: { prev: w.prev.fighters, next: w.next.fighters, alpha: w.acc / SIM_DT }, shot: this.wideShot(0, c.flowTitleDist - 1.5), refSim: w.next, refSnap: fresh, events };
  }

  /** Slot 0's fighter at ring centre, the lens circling him. */
  turntable(dt: number): Scene {
    this.t += dt;
    const c = this.cfg;
    this.turn ??= this.settled({ x: 0, z: 0 }, { x: 1.6, z: 0 }).fighters[0];
    const f: [FighterState, FighterState] = [this.turn, this.park()[1]];
    // He faces +x: the orbit starts squarely in front of him, a little to his lead side, every time he changes.
    const az = 0.3 + (this.t - this.turnT0) * c.flowTurntableDegPerSec * DEG;
    // Look to his screen-right so he stands left of centre (the panel has the right). Screen-right on the floor is (sin az, −cos az).
    const off = this.portrait ? 0 : c.flowTurntableOffset;
    return {
      fighters: { prev: f, next: f, alpha: 1 },
      shot: {
        key: 'turn', cut: true, lambda: 30, azimuth: az,
        focus: { x: Math.sin(az) * off, z: -Math.cos(az) * off },
        dist: c.flowTurntableDist, elevationDeg: c.flowTurntableElevationDeg,
        lookY: this.portrait ? c.flowTurntablePortraitLookY : c.flowTurntableLookY,
        fov: this.portrait ? c.flowTurntablePortraitFov : c.flowTurntableFov,
      },
      refSim: null,
    };
  }

  /** Both men stood in opposite corners, the ring left of centre on a wide screen (the corner card has the right). */
  corners(dt: number): Scene {
    this.t += dt;
    if (!this.corner) { const s = this.settled({ x: -2.05, z: -2.05 }, { x: 2.05, z: 2.05 }); this.corner = [s.fighters[0], s.fighters[1]]; }
    // Square on to the diagonal the two corners are on (a slow sway, not the full orbit), so neither man leaves the frame.
    const shot = this.wideShot(this.portrait ? 0 : 1.9, 9.2);
    const az = Math.PI * 0.75 + Math.sin(this.t * 0.25) * 0.14;
    const right = this.portrait ? 0 : 1.9;
    return { fighters: { prev: this.corner, next: this.corner, alpha: 1 }, shot: { ...shot, key: 'corners', azimuth: az, focus: { x: Math.sin(az) * right, z: -Math.cos(az) * right } }, refSim: null };
  }

  /**
   * The results: the live fight, from where the fight camera was when the screen came up, moved in and with the
   * pair left of centre (lifted, on a tall screen) so the panel does not cover them.
   */
  results(liveAz: number, a: Vec2, b: Vec2): Scene {
    this.resultsAz ??= liveAz;
    const az = this.resultsAz;
    const right = this.portrait ? 0 : 1.15;
    return {
      fighters: null, refSim: null,
      shot: {
        key: 'results', lambda: 2.5, azimuth: az,
        focus: { x: (a.x + b.x) / 2 + Math.sin(az) * right, z: (a.z + b.z) / 2 - Math.cos(az) * right },
        dist: this.portrait ? 6.5 : 4.9, elevationDeg: 9, lookY: this.portrait ? 0.35 : 1.0, fov: this.portrait ? 50 : 40,
      },
    };
  }

  // ── The ring walk ───────────────────────────────────────────────────────────

  /** Begin the walk: both men at their side of the ring (or already on their marks when the walk is off). */
  startWalk(): void {
    const fresh = createState([this.slots[0], this.slots[1]], this.cfg, 1);
    const marks: [Vec2, Vec2] = [{ ...fresh.fighters[0].pos }, { ...fresh.fighters[1].pos }];
    const on = this.cfg.flowWalkOn;
    const s = on ? this.settled({ x: -2.5, z: -0.9 }, { x: 2.5, z: 0.9 }) : this.settled(marks[0], marks[1]);
    this.walk = { prev: s, next: s, acc: 0, t: on ? 0 : 2 * this.cfg.flowWalkSeconds, marks, beat: 'done' };
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
    const cutTo = beat !== w.beat;   // a new beat is a cut: the referee is put on his spot for it, never caught walking
    if (cutTo && beat === 'stare') {
      // A skipped walk: both men are put on their marks for the two-shot rather than seen hurrying to them.
      const far = (i: 0 | 1): boolean => Math.hypot(w.next.fighters[i].pos.x - w.marks[i].x, w.next.fighters[i].pos.z - w.marks[i].z) > 0.25;
      if (far(0) || far(1)) { const s = this.settled(w.marks[0], w.marks[1]); w.prev = s; w.next = s; w.acc = 0; }
    }
    w.beat = beat;
    while (w.acc >= SIM_DT) {
      const f = w.next.fighters;
      // The opponent walks first; once a man has walked he keeps to his mark. From the stare on, both are held on their marks.
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
      const narrow = this.portrait ? 1.25 : 1;
      shot = {
        key: beat, cut: true, lambda: 3, focus: { x: p.x, z: p.z }, lookY: 1.2, fov: 38,
        azimuth: (side === 0 ? 0 : Math.PI) + 0.6,
        dist: (c.flowWalkDist + (c.flowWalkDistEnd - c.flowWalkDist) * u) * narrow, elevationDeg: c.flowWalkElevationDeg,
      };
    } else {
      // The two-shot: side-on, as close as still holds both men, looking low so they stand above the tape strip.
      const fov = 46;
      const fit = 1.95 / (Math.tan(fov / 2 * DEG) * this.aspect);
      shot = { key: 'stare', cut: true, lambda: 3, focus: { x: 0, z: 0 }, lookY: 0.86, fov, azimuth: Math.PI / 2, dist: Math.max(2.95, fit), elevationDeg: c.flowWalkElevationDeg };
    }
    return { fighters: { prev: w.prev.fighters, next: w.next.fighters, alpha: w.acc / SIM_DT }, shot, refSim: w.next, refSnap: cutTo };
  }

  endWalk(): void { this.walk = null; }
}

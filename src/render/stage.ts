/**
 * render/stage.ts — the three.js scene: renderer, ring, arena, lights,
 * broadcast camera, optional post pass. The `Stage` surface main.ts relies on:
 * constructor(container, cfg), `scene`, `resize()`, `drawHitboxes(states)`,
 * `handleEvents(events)`, `frame(a, b, closeness, t, dt)`, `info`.
 *
 * Geometry lives in ring.ts / arena.ts and is rebuilt whole when one of its
 * config keys changes (dev sliders); per-frame work here is lights, fog,
 * camera and the flash sparkles.
 */
import * as THREE from 'three';
import { TAU, type Config, type FighterState, type SimEvent, type Vec2 } from '../core';
import { buildRing, ringKey } from './ring';
import { Arena, arenaKey } from './arena';
import { PostPass } from './post';
import { disposeTree } from './util';
import { mood, type ReactionKind } from './mood';
import { additiveGain } from './atmos';
import { qualityTier, noteRenderer, type Tier } from './tier';
import { paintRoom, updatePaint, PaintGlow } from './paint';
import { clearSeat, type ClearSeat } from './camclear';

/** A framing the host asks for instead of the two-fighter default: the knockdown count, looking at the downed fighter. */
export interface CameraShot {
  focus: Vec2;
  // ── Directed shots (overhaul UI, 2026-11-11): menus, the ring walk, the replay. Every field is optional; a
  //    bare `{ focus }` is the knockdown shot exactly as before (it holds the orbit and uses the camCount… keys). ──
  /** Names the shot. A change of key into or out of a `cut` shot snaps the lens instead of easing it. */
  key?: string;
  /** Orbit angle, radians: the lens sits at (cos, sin) of this from the look point. Absent = hold the orbit where it is. The follow camera's own angle is put back when the shot ends. */
  azimuth?: number;
  /** Lens distance from the look point, m (default camCountDist). */
  dist?: number;
  /** Elevation, degrees (default camCountElevationDeg). */
  elevationDeg?: number;
  /** Look-at height, m (default camCountLookY). */
  lookY?: number;
  /** Vertical field of view, degrees (default camFovMin). */
  fov?: number;
  /** Ease rate toward the shot, 1/s (default camCountLambda). */
  lambda?: number;
  /** A cut, not a move: the lens is placed on the first frame of the shot and placed back on the first frame after it. */
  cut?: boolean;
}

declare global {
  interface Window {
    /** The show, for scripts (arena_look, audio_check): the crowd's mood, a reaction by hand, the tier in force, the scoreboard. */
    __show?: {
      excitement: () => number;
      react: (kind: ReactionKind, strength?: number, pos?: { x: number; z: number }) => void;
      setExcitement: (v: number | null) => void;
      tier: () => Tier;
      post: () => boolean;
      /** Seats built and people seated (the crowd's instance count). */
      crowd: () => { seats: number; people: number };
      /** Draw calls and triangles of the last rendered frame (no 60-frame fps window to wait for). */
      info: () => { calls: number; triangles: number };
      setBoardText: (lines: readonly string[] | null) => void;
      /** The lens's reaction to hits right now: punch-in, shake and jolt offsets (m) and its position. */
      cam: () => { punchIn: number; shake: number; jolt: number; pos: [number, number, number] };
      /** The crowd's hush, 0..1 (the count; a man out cold). */
      hush: () => number;
    };
  }
}

/** What one landed punch asks of the lens: a dolly-in (m, and how long it takes to come back), a shake amplitude (m) and a jolt along the punch (m). */
export interface LandKick { punchIn: number; recover: number; shake: number; jolt: number }

/**
 * The camera's answer to a landed punch, by grade (pure: the stage plays it,
 * scripts/audio_render.mjs prints it).
 *
 * showCamTiersOn (polish phase): glancing = nothing at all; clean = a push in
 * proportion to the punch's power; flush = a bigger push, twice the shake and a
 * jolt along the punch; the finisher = the biggest of all three a land can make.
 * Off = the overhaul: `impulse × camPunchIn` capped at camPunchInMax — which
 * EVERY land reached (impulse is in N·s, a glancing jab is 117), so a clean jab
 * and a clean hook pushed in by the same 25 cm — times flowKickGlancing / Flush.
 */
export function landKick(e: Extract<SimEvent, { type: 'punchLand' }>, c: Config): LandKick {
  const fin = c.showFinisherOn && e.finisher === true && e.grade !== 'glancing';
  let k: LandKick;
  if (!c.showCamTiersOn) {
    const mag = Math.hypot(e.impulse.x, e.impulse.y, e.impulse.z);
    const kick = e.grade === 'glancing' ? c.flowKickGlancing : e.grade === 'flush' ? c.flowKickFlush : 1;
    k = { punchIn: Math.min(c.camPunchInMax, mag * c.camPunchIn) * kick, recover: c.camPunchRecover, shake: Math.min(0.06, e.power * c.camShake) * kick, jolt: 0 };
  } else if (e.grade === 'glancing') {
    k = { punchIn: 0, recover: c.camPunchRecover, shake: 0, jolt: 0 };
  } else {
    const soft = 1 - 0.5 * Math.max(0, Math.min(1, e.nerf ?? 0));   // an arm punch thrown while being hit moves the lens less
    const flush = e.grade === 'flush';
    k = {
      punchIn: c.camPunchInMax * Math.min(1, e.power / Math.max(0.1, c.camPunchPowerRef)) * (flush ? c.camFlushPunchIn : 1) * soft,
      recover: c.camPunchRecover,
      shake: Math.min(0.06, e.power * c.camShake * (flush ? c.camFlushShake : 1)) * soft,
      jolt: flush ? c.camJolt * Math.min(2, e.power) * soft : 0,
    };
  }
  if (fin) k = { punchIn: Math.max(k.punchIn, c.camFinisherPunchIn), recover: c.camFinisherRecover, shake: Math.max(k.shake, c.camFinisherShake), jolt: Math.max(k.jolt, c.camFinisherJolt) };
  return k;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private ring = new THREE.Group();
  private ringKey = '';
  private arena: Arena;
  private arenaKey = '';
  private fog: THREE.Fog;
  private paintGlow = new PaintGlow();
  private key: THREE.SpotLight;
  private fill: THREE.HemisphereLight;
  private rim: THREE.DirectionalLight;
  private backA: THREE.DirectionalLight;   // warm, from the truss corner over the red corner
  private backB: THREE.DirectionalLight;   // cool, from the truss corner over the blue corner
  private koT = 1e6;                       // seconds since the last knockdown / KO (the post pass's aberration envelope)
  private hitboxes = new THREE.Group();
  private hitboxMat = new THREE.MeshBasicMaterial({ color: 0x33ff88, wireframe: true });
  private look = new THREE.Vector3(0, 1, 0);
  private lookTarget = new THREE.Vector3(0, 1, 0);
  private post: PostPass | null = null;
  private aniso: number;
  private software: boolean;   // WebGL is a CPU rasteriser (headless): post runs without MSAA
  private govSum = 0; private govN = 0;   // the post governor's frame-time window
  private govDrop = 0;                    // pixel ratio the governor has taken off postPixelRatio
  private govNoMsaa = false;              // ...and its last resort

  // camera state (smoothed dolly/FOV + impact punch-in)
  private dist = -1;
  private fov = -1;
  private punchAmp = 0;
  private punchT = 0;
  private punchDur = 1;
  private shakeAmp = 0;   // camera shake on a landed punch, m (decays over camShakeRecover)
  private shakeT = 0;
  private joltAmp = 0;    // the jolt along a flush punch, m (polish phase)
  private joltT = 1e6;
  private joltDir = { x: 0, z: 0 };
  private az = NaN;       // smoothed follow-camera azimuth, radians (NaN = not yet placed)
  private el = NaN;       // smoothed elevation, radians (the knockdown shot drops it)
  private clearPick: ClearSeat = { liftDeg: 0, scale: 1, blocked: 0 };   // the clear line's chosen seat (camclear.ts)
  private clearLift = 0;  // eased lift it adds to the elevation, radians
  private clearScale = 1; // eased dolly scale (FOV widened to match)
  /** Extra handheld drift amplitude this frame, m (the hurt read: the host sets it from the player's hurt level). */
  wobble = 0;
  private following = false;   // last frame rode the fighters' line (vs the fixed seat)
  // Directed shots (CameraShot.azimuth / cut): the last shot's key, whether it was a cut, and the follow camera's orbit to put back.
  private shotKey: string | null = null;
  private shotCut = false;
  private azHome = NaN;
  private azSaved = false;

  /**
   * The azimuth the stick/keys map against (ui/input.ts), radians. While
   * following, the side-on angle of the fighters' line (the orbit less
   * camBehindDeg): stick right = toward the opponent, stick up = away from
   * the camera's side, exactly the fixed seat's feel at its default. Fixed
   * seat: camAzimuthDeg. Screen-relative at the over-the-shoulder angle
   * turned "forward" into forward-and-sideways (2026-09-17 feel-test).
   */
  /** The lens's current distance from the look point after the punch-in, m (probes). */
  get dollyDistance(): number { return Math.max(1, this.dist - this.punchIn); }

  /** The camera's current orbit angle, radians: the lens sits at (cos, sin) of this from the look point on the floor. */
  get orbitAzimuth(): number { return Number.isNaN(this.az) ? this.cfg.camAzimuthDeg * Math.PI / 180 : this.az; }

  /** The camera's current elevation, radians (probes: the knockdown shot drops it). */
  get elevation(): number { return Number.isNaN(this.el) ? this.cfg.camElevationDeg * Math.PI / 180 : this.el + this.clearLift; }

  get inputAzimuth(): number {
    if (this.following && !Number.isNaN(this.az)) return this.az - this.cfg.camBehindDeg * Math.PI / 180;
    return this.cfg.camAzimuthDeg * Math.PI / 180;
  }

  constructor(container: HTMLElement, private cfg: Config) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The post pass issues several render() calls per frame; count the whole frame ourselves.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.software = noteRenderer(this.renderer.getContext());

    if (new URLSearchParams(location.search).get('look') === 'old') cfg.paintLook = false;   // ?look=old: the picture before the paint look
    this.fog = new THREE.Fog(new THREE.Color(cfg.fogColor), cfg.fogNear, cfg.fogFar);
    this.scene.fog = this.fog;
    this.scene.background = this.fog.color;

    this.key = new THREE.SpotLight(0xffffff, cfg.keyIntensity, 0, 1, 0.5, 1);
    this.key.castShadow = true;
    this.key.shadow.mapSize.setScalar(this.shadowSize);
    this.key.shadow.bias = -0.0005;
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 20;
    this.key.target.position.set(0, 0, 0);
    this.scene.add(this.key, this.key.target);

    this.fill = new THREE.HemisphereLight(0xbfd4ff, 0x2a1d14, cfg.fillIntensity);
    this.scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xdfe8ff, cfg.rimIntensity);
    this.scene.add(this.rim, this.rim.target);

    // The rig's two coloured back lights: fixed in the room on the truss
    // corners over the red and blue corners, so the edge light on a fighter
    // changes as the pair circles (the camera-riding rim above does not).
    this.backA = new THREE.DirectionalLight(0xffffff, cfg.backIntensity);
    this.backB = new THREE.DirectionalLight(0xffffff, cfg.backIntensity);
    this.scene.add(this.backA, this.backA.target, this.backB, this.backB.target);

    this.arena = new Arena(cfg, this.aniso);
    this.arenaKey = arenaKey(cfg);
    this.scene.add(this.arena.group, this.ring, this.hitboxes);
    paintRoom(this.arena.group, cfg, 'arena');
    this.scene.add(this.paintGlow.group);
    this.rebuildRing();
    this.resize();

    // The crowd's mood → the stands (ripple, flashes). The crowd audio listens to the same object.
    mood.on(r => this.arena.react(r, this.cfg));
    window.__show = {
      excitement: () => mood.value,
      react: (kind, strength = 1, pos) => this.react(kind, strength, pos),
      setExcitement: v => this.setExcitement(v),
      tier: () => this.tier,
      post: () => this.postOn,
      crowd: () => this.arena.stats,
      info: () => this.info,
      setBoardText: lines => this.setBoardText(lines),
      cam: () => this.reaction,
      hush: () => mood.hush,
    };
  }

  // ── The show (overhaul 2026-11-11) ──────────────────────────────────────────

  /** The quality tier in force (render/tier.ts). */
  get tier(): Tier { return qualityTier(this.cfg); }
  /** Post runs when the master toggle is on AND the tier is high. */
  private get postOn(): boolean { return this.cfg.postEnabled && this.tier === 2 && !(this.cfg.paintLook && this.cfg.paintAblate < 4); }
  private get shadowSize(): number { return this.tier === 2 ? this.cfg.shadowMapSize : Math.min(this.cfg.shadowMapSize, this.cfg.lowShadowMapSize); }

  /** A crowd reaction by hand — the host's ring walk, an intro, a test. Sim events reach the crowd through `handleEvents` already. */
  react(kind: ReactionKind, strength = 1, worldPos?: { x: number; z: number }): void { mood.react(kind, strength, worldPos ?? null); }
  /** Pin the crowd's excitement (0..1), or null to hand it back to the fight. */
  setExcitement(v: number | null): void { mood.force(v); }
  /** The crowd's excitement right now, 0..1. */
  get excitement(): number { return mood.value; }
  /** Text for the hanging scoreboard (round, clock…), or null for the sponsor card. */
  setBoardText(lines: readonly string[] | null): void { this.arena.setBoardText(lines); }

  private get size(): [number, number] {
    const el = this.renderer.domElement.parentElement;
    return [el?.clientWidth ?? innerWidth, el?.clientHeight ?? innerHeight];
  }

  resize(): void {
    const [w, h] = this.size;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
  }

  // ── Ring ────────────────────────────────────────────────────────────────────

  private rebuildRing(): void {
    this.ringKey = ringKey(this.cfg);
    disposeTree(this.ring);
    this.ring.add(buildRing(this.cfg, this.aniso));
    paintRoom(this.ring, this.cfg, 'ring');
  }

  // ── Hitbox debug (CONTRACT §5: what the sim tests against, drawn exactly) ───

  private hitboxSphere = new THREE.SphereGeometry(1, 10, 8);
  private hitboxCyl = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);

  drawHitboxes(states: readonly FighterState[]): void {
    this.hitboxes.clear();
    if (!this.cfg.debugHitboxes) return;
    for (const s of states) {
      const spheres = [s.headBox, { ...s.gloves[0].pos, r: s.body.gloveR }, { ...s.gloves[1].pos, r: s.body.gloveR }];
      for (const sp of spheres) {
        const m = new THREE.Mesh(this.hitboxSphere, this.hitboxMat);
        m.position.set(sp.x, sp.y, sp.z);
        m.scale.setScalar(sp.r);
        this.hitboxes.add(m);
      }
      const { a, b, r } = s.bodyBox;
      const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const cyl = new THREE.Mesh(this.hitboxCyl, this.hitboxMat);
      cyl.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      cyl.scale.set(r, len, r);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize());
      this.hitboxes.add(cyl);
      for (const end of [a, b]) {
        const m = new THREE.Mesh(this.hitboxSphere, this.hitboxMat);
        m.position.set(end.x, end.y, end.z);
        m.scale.setScalar(r);
        this.hitboxes.add(m);
      }
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  /** Sim events since the last frame (main.ts calls this before `frame`).
   *  punchLand → dolly punch-in scaled by |impulse|; knockdown/ko/tko → a
   *  longer one. Never a hard cut: the punch-in is a smooth envelope on top
   *  of the tracked dolly distance. */
  handleEvents(events: readonly SimEvent[]): void {
    const c = this.cfg;
    mood.handle(events, c);   // the crowd: excitement + reactions (stands, flashes, crowd audio)
    for (const e of events) {
      if (e.type === 'knockdown' || e.type === 'ko' || e.type === 'tko') this.koT = 0;
      if (e.type === 'punchLand') {
        const k = landKick(e, c);
        this.pushPunchIn(k.punchIn, k.recover);
        // A bigger hit restarts the shake; a smaller one inside a bigger one's decay is left out.
        if (k.shake > 0 && k.shake >= this.shakeAmp * Math.exp(-this.shakeT / Math.max(0.02, c.camShakeRecover))) { this.shakeAmp = k.shake; this.shakeT = 0; }
        // The jolt: the lens shoved along the punch and let back (flush lands and finishers only).
        if (k.jolt > 0 && k.jolt >= this.joltNow()) {
          const mag = Math.hypot(e.impulse.x, e.impulse.z);
          if (mag > 1e-6) { this.joltAmp = k.jolt; this.joltT = 0; this.joltDir.x = e.impulse.x / mag; this.joltDir.z = e.impulse.z / mag; }
        }
      } else if (e.type === 'knockdown' || e.type === 'ko' || e.type === 'tko') {
        this.pushPunchIn(c.camKoPunchIn, c.camKoRecover);
        this.shakeAmp = Math.min(0.08, c.camShake * 3); this.shakeT = 0;
      } else if (e.type === 'counter') {
        // The counter read: a bigger push than any plain land can make.
        this.pushPunchIn(c.camCounterPunchIn, c.camKoRecover);
        this.shakeAmp = Math.min(0.08, c.camShake * 2); this.shakeT = 0;
      } else if (e.type === 'rocked') {
        this.pushPunchIn(c.camRockedPunchIn, c.camKoRecover);
        this.shakeAmp = Math.min(0.08, c.camShake * 2.5); this.shakeT = 0;
      }
    }
  }

  /** The jolt's offset right now, m: rises to its amplitude over camJoltSeconds and eases back (u·e^(1−u): no step at either end). */
  private joltNow(): number {
    const u = this.joltT / Math.max(0.01, this.cfg.camJoltSeconds);
    return u > 12 ? 0 : this.joltAmp * u * Math.exp(1 - u);
  }

  /** What the lens is doing about the last hits, right now (probes: a camera that stalls through a hit-stop shows here as frames with no change). */
  get reaction(): { punchIn: number; shake: number; jolt: number; pos: [number, number, number] } {
    const shake = this.shakeAmp * Math.exp(-this.shakeT / Math.max(0.02, this.cfg.camShakeRecover)) * Math.sin(this.shakeT * this.cfg.camShakeHz * TAU);
    return { punchIn: this.punchIn, shake, jolt: this.joltNow(), pos: [this.camera.position.x, this.camera.position.y, this.camera.position.z] };
  }

  private pushPunchIn(amp: number, dur: number): void {
    if (amp <= 0) return;
    const remaining = this.punchAmp * this.envelope();
    if (amp < remaining) return;          // a smaller hit inside a bigger one's recovery: keep the bigger
    this.punchAmp = amp; this.punchT = 0; this.punchDur = Math.max(0.02, dur);
  }

  /** 0..1: snaps in over the first 8% of the recovery, then eases back out. */
  private envelope(): number {
    const u = this.punchT / this.punchDur;
    if (u >= 1) return 0;
    return Math.min(1, u / 0.08) * (1 - u) * (1 - u);
  }

  /** Current punch-in dolly offset, metres (tests / the fps overlay may read it). */
  get punchIn(): number { return this.punchAmp * this.envelope(); }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  /**
   * `a`, `b`: the two fighters' floor positions (or the ring centre twice).
   * `closeness` 0..1 = how near the fighters are (drives dolly + FOV).
   * `t`: wall seconds for the handheld drift. `dt`: frame seconds.
   */
  frame(a: Vec2, b: Vec2, closeness: number, t: number, dt: number, shot: CameraShot | null = null): void {
    const c = this.cfg;
    this.renderer.info.reset();
    if (ringKey(c) !== this.ringKey) this.rebuildRing();
    if (arenaKey(c) !== this.arenaKey) { this.arena.rebuild(c); this.arenaKey = arenaKey(c); paintRoom(this.arena.group, c, 'arena'); }
    updatePaint(c);
    this.paintGlow.update(c);
    // the paint look swaps these lights and the fog for its own (render/paint.ts); off = the old values.
    // paintAblate (debug) holds back the paint fog below step 3 and the paint lights below step 5.
    const PF = c.paintLook && c.paintAblate >= 3;
    const P = c.paintLook && c.paintAblate >= 5;

    this.fog.color.set(PF ? c.paintFogColor : c.fogColor);
    this.fog.near = PF ? c.paintFogNear : c.fogNear;
    this.fog.far = PF ? c.paintFogFar : c.fogFar;

    this.key.intensity = P ? c.paintKeyIntensity : c.keyIntensity;
    this.key.color.set(P ? c.paintKeyColor : c.keyColor);
    this.key.position.set(0, c.keyHeight, 0);
    this.key.angle = (P ? c.paintKeyAngleDeg : c.keyAngleDeg) * Math.PI / 180;
    this.key.shadow.radius = c.shadowRadius;
    const shadowSize = this.shadowSize;
    if (this.key.shadow.mapSize.x !== shadowSize) {
      this.key.shadow.mapSize.setScalar(shadowSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.fill.intensity = P ? c.paintFill : c.fillIntensity;
    this.fill.color.set(c.fillSkyColor);
    this.fill.groundColor.set(c.fillGroundColor);
    this.rim.intensity = P ? c.paintRim : c.rimIntensity;
    this.rim.color.set(c.rimColor);
    const backI = P ? c.paintBack : c.backIntensity;
    const back = backI > 0;   // both tiers: they light the fighters, and a tier must not change how a fighter reads
    const S = c.trussSize / 2;
    this.backA.visible = this.backB.visible = back;
    this.backA.intensity = this.backB.intensity = backI;
    this.backA.color.set(c.backColorA); this.backA.position.set(S, c.trussHeight, S);
    this.backB.color.set(c.backColorB); this.backB.position.set(-S, c.trussHeight, -S);
    mood.update(dt, c);
    this.koT += dt;

    // Follow camera (2026-09-17, Fight Night Champion): the orbit angle rides
    // the player→opponent line, camBehindDeg round from side-on toward the
    // player's back, so the player is always seen from the same angle and
    // never stands between the lens and the opponent. The azimuth chases the
    // line through a rate-capped lambda so circling swings the room, never
    // whips it. Fixed broadcast seat (camAzimuthDeg) when following is off or
    // a single fighter is focused (a and b coincide — pose grids, filmstrips).
    // Dolly and FOV chase `closeness`; the punch-in envelope rides on the dolly.
    const abx = b.x - a.x, abz = b.z - a.z;
    this.following = c.camFollow > 0 && abx * abx + abz * abz > 1e-4;
    let azTarget = c.camAzimuthDeg * Math.PI / 180;
    if (this.following) {
      // Camera at (cos az, sin az) from the look point; bearing + 90° is the
      // side view with the player screen-left, + camBehindDeg goes round behind.
      azTarget = Math.atan2(abz, abx) + (90 + c.camBehindDeg) * Math.PI / 180;
    }
    // Directed shots (menus, ring walk, replay): the host names the orbit. The follow camera's own angle is kept
    // aside and put back when the shot ends, so the band below picks up where it was.
    const directed = shot !== null && shot.azimuth !== undefined;
    const key = shot ? shot.key ?? '' : null;
    const snap = key !== this.shotKey && ((shot?.cut ?? false) || this.shotCut);
    this.shotKey = key; this.shotCut = shot?.cut ?? false;
    if (directed && !this.azSaved) { this.azHome = this.az; this.azSaved = true; }
    else if (!directed && this.azSaved) { this.az = this.azHome; this.azSaved = false; }
    if (shot !== null && shot.azimuth !== undefined) {
      const want = shot.azimuth;
      if (snap || Number.isNaN(this.az)) this.az = want;
      else {
        const off = Math.atan2(Math.sin(want - this.az), Math.cos(want - this.az));
        this.az += off * (1 - Math.exp(-(shot.lambda ?? c.camCountLambda) * dt));
      }
    }
    else if (Number.isNaN(this.az) || !this.following) this.az = azTarget;   // the fixed seat is placed, not chased
    else if (shot) { /* the knockdown shot holds its orbit: nothing circles while a man is down */ }
    else {
      // The band (2026-09-17, "still too much panning… and still blocked"):
      // the camera sits wherever the line last left it, and is dragged only
      // when the line would push it more than camOrbitBandDeg from the
      // over-the-shoulder centre — a hard clamp, so it can never fall far
      // enough behind either fighter for one to cover the other, however
      // fast the pair circles. Inside the band an optional slow recentre.
      let off = this.az - azTarget;
      off = Math.atan2(Math.sin(off), Math.cos(off));   // shortest way round
      const band = c.camOrbitBandDeg * Math.PI / 180;
      if (off > band) off = band;
      else if (off < -band) off = -band;
      else if (c.camOrbitLambda > 0) off *= Math.exp(-c.camOrbitLambda * dt);
      this.az = azTarget + off;
    }
    const az = this.az;
    // The knockdown shot (Stage 3): the lens drops to the canvas and pushes
    // in on the downed fighter while the referee counts, then eases back to
    // the ringside seat. Same orbit, so it is a push, never a cut.
    // the paint look's framing keys: a closer dolly and a small lift, on the play camera only (never a directed shot)
    const tight = c.paintLook && !shot ? 1 - 0.3 * c.paintCamTighten : 1;
    const lift = c.paintLook && !shot ? c.paintCamLiftDeg : 0;
    const elTarget = (shot ? shot.elevationDeg ?? c.camCountElevationDeg : c.camElevationDeg + lift) * Math.PI / 180;
    const distTarget = (shot ? shot.dist ?? c.camCountDist : c.camDistMax + (c.camDistMin - c.camDistMax) * closeness) * tight;
    const fovTarget = shot ? shot.fov ?? c.camFovMin : c.camFovMax + (c.camFovMin - c.camFovMax) * closeness;
    if (this.dist < 0 || snap) { this.dist = distTarget; this.fov = fovTarget; }
    if (Number.isNaN(this.el) || snap) this.el = elTarget;
    const easing = shot !== null || Math.abs(this.el - elTarget) > 0.003;   // into the shot, and back out of it, at the shot's rate
    const dl = 1 - Math.exp(-(easing ? shot?.lambda ?? c.camCountLambda : c.camDollyLambda) * dt);
    this.dist += (distTarget - this.dist) * dl;
    this.fov += (fovTarget - this.fov) * dl;
    this.el += (elTarget - this.el) * dl;
    this.punchT += dt;

    if (shot) this.lookTarget.set(shot.focus.x, shot.lookY ?? c.camCountLookY, shot.focus.z);
    else this.lookTarget.set((a.x + b.x) / 2, c.camLookY, (a.z + b.z) / 2);
    const lam = 1 - Math.exp(-c.camFollowLambda * dt);
    if (snap) this.look.copy(this.lookTarget);
    else this.look.lerp(this.lookTarget, lam);

    // The clear line (camclear.ts): on the play camera only, the seat that keeps posts and ropes off both fighters,
    // eased toward at camClearLambda. Directed shots, the fixed seat and camClear off all ease back to no change.
    // (flowReplayClear, Nate 2026-11-25: the knockdown replay's low lens sat "behind and under the ropes, most of the
    //  action is missed because the rope is in the way" — the replay shot takes the same clear seat, lifted over the top rope)
    const clearOn = c.camClear && ((!shot && this.following) || (shot?.key === 'replay' && c.flowReplayClear));
    if (clearOn) this.clearPick = clearSeat(this.lookTarget, az, this.el, this.dist, [a, b], this.clearPick, c);
    const wantLift = clearOn ? this.clearPick.liftDeg * Math.PI / 180 : 0, wantScale = clearOn ? this.clearPick.scale : 1;
    const cl = snap ? 1 : 1 - Math.exp(-c.camClearLambda * dt);
    this.clearLift += (wantLift - this.clearLift) * cl;
    this.clearScale += (wantScale - this.clearScale) * cl;
    const el = this.el + this.clearLift;
    const dist = Math.max(1, this.dist * this.clearScale - this.punchIn);
    const halfTan = Math.tan(this.fov * Math.PI / 360) * (1 + (1 / this.clearScale - 1) * c.camClearFovKeep);
    const fovNow = Math.atan(halfTan) * 360 / Math.PI;
    const drift = c.camDriftAmp + this.wobble;   // the handheld drift grows while the player is rocked (main.ts sets it)
    this.shakeT += dt;
    const shake = this.shakeAmp * Math.exp(-this.shakeT / Math.max(0.02, c.camShakeRecover));
    const dx = Math.sin(t * c.camDriftHz * TAU) * drift + Math.sin(this.shakeT * c.camShakeHz * TAU) * shake;
    const dy = Math.sin(t * c.camDriftHz * TAU * 1.37 + 1.1) * drift * 0.6 + Math.sin(this.shakeT * c.camShakeHz * TAU * 1.3 + 0.9) * shake * 0.7;
    this.joltT += dt;
    const jolt = this.joltNow();
    this.camera.position.set(
      this.look.x + dist * Math.cos(el) * Math.cos(az) + dx + this.joltDir.x * jolt,
      this.look.y + dist * Math.sin(el) + dy,
      this.look.z + dist * Math.cos(el) * Math.sin(az) + this.joltDir.z * jolt,
    );
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - fovNow) > 1e-3) { this.camera.fov = fovNow; this.camera.updateProjectionMatrix(); }

    // Rim comes from behind the far ropes relative to the camera.
    this.rim.position.set(-Math.cos(az) * 6, 3.5, -Math.sin(az) * 6);
    this.rim.target.position.copy(this.look);

    // Post is paid per pixel: while it runs, the frame is drawn at no more than postPixelRatio (MSAA covers the
    // difference). The governor: if frames stay over postBudgetMs with post on, post gives ground — resolution a
    // quarter-step at a time down to 1, then MSAA. It only ever steps down (no hunting); a tier change resets it.
    if (this.postOn && c.postBudgetMs > 0 && dt > 0 && dt < 0.1) {
      this.govSum += dt; this.govN++;
      if (this.govN >= 120) {
        if (this.govSum / this.govN > c.postBudgetMs / 1000) {
          if (c.postPixelRatio - this.govDrop > 1) this.govDrop += 0.25; else this.govNoMsaa = true;
        }
        this.govSum = 0; this.govN = 0;
      }
    }
    const wantPr = Math.min(devicePixelRatio, this.postOn ? Math.max(1, c.postPixelRatio - this.govDrop) : 2);
    if (Math.abs(this.renderer.getPixelRatio() - wantPr) > 1e-3) { this.renderer.setPixelRatio(wantPr); this.resize(); }
    additiveGain.value = (this.postOn ? 1 : c.noPostAdditive) * (P ? c.paintAtmos : 1);
    const pr = this.renderer.getPixelRatio();
    this.arena.update(c, dt, this.camera, this.fog, this.size[1] * pr, mood.value);

    if (this.postOn) {
      const samples = this.software || this.govNoMsaa ? 0 : c.postMsaa;
      if (this.post && this.post.samples !== samples) { this.post.dispose(); this.post = null; }
      if (!this.post) {
        const [w, h] = this.size;
        this.post = new PostPass(this.renderer, this.scene, this.camera, w * pr, h * pr, c, samples);
      }
      // Chromatic aberration is the KO's alone: it snaps on with the knockdown and clears over postKoSeconds.
      const ko = Math.max(0, 1 - this.koT / Math.max(0.05, c.postKoSeconds));
      this.post.render(c, t, ko * ko);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  get info(): { calls: number; triangles: number } {
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }
}

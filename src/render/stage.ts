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

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private ring = new THREE.Group();
  private ringKey = '';
  private arena: Arena;
  private arenaKey = '';
  private fog: THREE.Fog;
  private key: THREE.SpotLight;
  private fill: THREE.HemisphereLight;
  private rim: THREE.DirectionalLight;
  private hitboxes = new THREE.Group();
  private hitboxMat = new THREE.MeshBasicMaterial({ color: 0x33ff88, wireframe: true });
  private look = new THREE.Vector3(0, 1, 0);
  private lookTarget = new THREE.Vector3(0, 1, 0);
  private post: PostPass | null = null;
  private aniso: number;

  // camera state (smoothed dolly/FOV + impact punch-in)
  private dist = -1;
  private fov = -1;
  private punchAmp = 0;
  private punchT = 0;
  private punchDur = 1;
  private shakeAmp = 0;   // camera shake on a landed punch, m (decays over camShakeRecover)
  private shakeT = 0;
  private az = NaN;       // smoothed follow-camera azimuth, radians (NaN = not yet placed)

  constructor(container: HTMLElement, private cfg: Config) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The post pass issues several render() calls per frame; count the whole frame ourselves.
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    this.fog = new THREE.Fog(new THREE.Color(cfg.fogColor), cfg.fogNear, cfg.fogFar);
    this.scene.fog = this.fog;
    this.scene.background = this.fog.color;

    this.key = new THREE.SpotLight(0xffffff, cfg.keyIntensity, 0, 1, 0.5, 1);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
    this.key.shadow.bias = -0.0005;
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 20;
    this.key.target.position.set(0, 0, 0);
    this.scene.add(this.key, this.key.target);

    this.fill = new THREE.HemisphereLight(0xbfd4ff, 0x2a1d14, cfg.fillIntensity);
    this.scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xdfe8ff, cfg.rimIntensity);
    this.scene.add(this.rim, this.rim.target);

    this.arena = new Arena(cfg);
    this.arenaKey = arenaKey(cfg);
    this.scene.add(this.arena.group, this.ring, this.hitboxes);
    this.rebuildRing();
    this.resize();
  }

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
    for (const e of events) {
      if (e.type === 'punchLand') {
        const mag = Math.hypot(e.impulse.x, e.impulse.y, e.impulse.z);
        this.pushPunchIn(Math.min(c.camPunchInMax, mag * c.camPunchIn), c.camPunchRecover);
        // Shake scales with the punch's power (jab ≈ 0.7, hook ≈ 1.4), a bigger hit restarts it.
        const shake = Math.min(0.06, e.power * c.camShake);
        if (shake >= this.shakeAmp * Math.exp(-this.shakeT / Math.max(0.02, c.camShakeRecover))) { this.shakeAmp = shake; this.shakeT = 0; }
      } else if (e.type === 'knockdown' || e.type === 'ko' || e.type === 'tko') {
        this.pushPunchIn(c.camKoPunchIn, c.camKoRecover);
        this.shakeAmp = Math.min(0.08, c.camShake * 3); this.shakeT = 0;
      }
    }
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
  frame(a: Vec2, b: Vec2, closeness: number, t: number, dt: number): void {
    const c = this.cfg;
    this.renderer.info.reset();
    if (ringKey(c) !== this.ringKey) this.rebuildRing();
    if (arenaKey(c) !== this.arenaKey) { this.arena.rebuild(c); this.arenaKey = arenaKey(c); }

    this.fog.color.set(c.fogColor);
    this.fog.near = c.fogNear;
    this.fog.far = c.fogFar;

    this.key.intensity = c.keyIntensity;
    this.key.position.set(0, c.keyHeight, 0);
    this.key.angle = c.keyAngleDeg * Math.PI / 180;
    this.key.shadow.radius = c.shadowRadius;
    if (this.key.shadow.mapSize.x !== c.shadowMapSize) {
      this.key.shadow.mapSize.set(c.shadowMapSize, c.shadowMapSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.fill.intensity = c.fillIntensity;
    this.rim.intensity = c.rimIntensity;

    // Follow camera (2026-09-17, Fight Night Champion): the orbit angle rides
    // the player→opponent line, camBehindDeg round from side-on toward the
    // player's back, so the player is always seen from the same angle and
    // never stands between the lens and the opponent. The azimuth chases the
    // line through a rate-capped lambda so circling swings the room, never
    // whips it. Fixed broadcast seat (camAzimuthDeg) when following is off or
    // a single fighter is focused (a and b coincide — pose grids, filmstrips).
    // Dolly and FOV chase `closeness`; the punch-in envelope rides on the dolly.
    const abx = b.x - a.x, abz = b.z - a.z;
    let azTarget = c.camAzimuthDeg * Math.PI / 180;
    if (c.camFollow > 0 && abx * abx + abz * abz > 1e-4) {
      // Camera at (cos az, sin az) from the look point; bearing + 90° is the
      // side view with the player screen-left, + camBehindDeg goes round behind.
      azTarget = Math.atan2(abz, abx) + (90 + c.camBehindDeg) * Math.PI / 180;
    }
    if (Number.isNaN(this.az)) this.az = azTarget;
    let dAz = azTarget - this.az;
    dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));   // shortest way round
    const maxStep = c.camOrbitMaxRate * Math.PI / 180 * dt;
    const step = dAz * (1 - Math.exp(-c.camOrbitLambda * dt));
    this.az += Math.max(-maxStep, Math.min(maxStep, step));
    const az = this.az;
    const el = c.camElevationDeg * Math.PI / 180;
    const distTarget = c.camDistMax + (c.camDistMin - c.camDistMax) * closeness;
    const fovTarget = c.camFovMax + (c.camFovMin - c.camFovMax) * closeness;
    if (this.dist < 0) { this.dist = distTarget; this.fov = fovTarget; }
    const dl = 1 - Math.exp(-c.camDollyLambda * dt);
    this.dist += (distTarget - this.dist) * dl;
    this.fov += (fovTarget - this.fov) * dl;
    this.punchT += dt;
    const dist = Math.max(1, this.dist - this.punchIn);

    this.lookTarget.set((a.x + b.x) / 2, c.camLookY, (a.z + b.z) / 2);
    const lam = 1 - Math.exp(-c.camFollowLambda * dt);
    this.look.lerp(this.lookTarget, lam);
    const drift = c.camDriftAmp;
    this.shakeT += dt;
    const shake = this.shakeAmp * Math.exp(-this.shakeT / Math.max(0.02, c.camShakeRecover));
    const dx = Math.sin(t * c.camDriftHz * TAU) * drift + Math.sin(this.shakeT * c.camShakeHz * TAU) * shake;
    const dy = Math.sin(t * c.camDriftHz * TAU * 1.37 + 1.1) * drift * 0.6 + Math.sin(this.shakeT * c.camShakeHz * TAU * 1.3 + 0.9) * shake * 0.7;
    this.camera.position.set(
      this.look.x + dist * Math.cos(el) * Math.cos(az) + dx,
      this.look.y + dist * Math.sin(el) + dy,
      this.look.z + dist * Math.cos(el) * Math.sin(az),
    );
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 1e-3) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }

    // Rim comes from behind the far ropes relative to the camera.
    this.rim.position.set(-Math.cos(az) * 6, 3.5, -Math.sin(az) * 6);
    this.rim.target.position.copy(this.look);

    this.arena.update(c, t, this.camera);

    if (c.postEnabled) {
      if (!this.post) {
        const [w, h] = this.size;
        const pr = this.renderer.getPixelRatio();
        this.post = new PostPass(this.renderer, this.scene, this.camera, w * pr, h * pr);
      }
      this.post.render(c);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  get info(): { calls: number; triangles: number } {
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }
}

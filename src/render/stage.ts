/**
 * render/stage.ts — the three.js scene: renderer, ring, lights, broadcast
 * camera. Stage 0 placeholder for the RENDER workstream: enough ring to judge
 * framing and frame-time, rebuilt live from config. RENDER replaces the
 * geometry; the `Stage` interface (create / resize / frame / hitbox debug) is
 * what main.ts relies on.
 */
import * as THREE from 'three';
import { RING_HALF, APRON_W, TAU, type Config, type FighterState, type SimEvent, type Vec2 } from '../core';

const RING_KEYS = ['ropeCount', 'ropeTopY', 'ropeSag', 'postR', 'matColor', 'matLineColor', 'apronColor',
  'ropeColorA', 'ropeColorB', 'ropeColorC', 'padColorRed', 'padColorBlue'] as const;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private ring = new THREE.Group();
  private ringKey = '';
  private key: THREE.SpotLight;
  private fill: THREE.HemisphereLight;
  private rim: THREE.DirectionalLight;
  private hitboxes = new THREE.Group();
  private hitboxMat = new THREE.MeshBasicMaterial({ color: 0x33ff88, wireframe: true });
  private look = new THREE.Vector3(0, 1, 0);
  private lookTarget = new THREE.Vector3(0, 1, 0);

  constructor(container: HTMLElement, private cfg: Config) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0a0a0c);
    this.scene.fog = new THREE.Fog(0x0a0a0c, 12, 30);

    // Arena floor far below the ring, so the platform reads as raised.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x141418, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.0;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.key = new THREE.SpotLight(0xffffff, cfg.keyIntensity, 0, 1, 0.5, 1);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
    this.key.shadow.bias = -0.0005;
    this.key.target.position.set(0, 0, 0);
    this.scene.add(this.key, this.key.target);

    this.fill = new THREE.HemisphereLight(0xbfd4ff, 0x2a1d14, cfg.fillIntensity);
    this.scene.add(this.fill);

    this.rim = new THREE.DirectionalLight(0xdfe8ff, cfg.rimIntensity);
    this.scene.add(this.rim, this.rim.target);

    this.scene.add(this.ring, this.hitboxes);
    this.rebuildRing();
    this.resize();
  }

  resize(): void {
    const w = this.renderer.domElement.parentElement?.clientWidth ?? innerWidth;
    const h = this.renderer.domElement.parentElement?.clientHeight ?? innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ── Ring ────────────────────────────────────────────────────────────────────

  private rebuildRing(): void {
    const c = this.cfg;
    this.ringKey = RING_KEYS.map(k => String(c[k])).join('|');
    this.ring.clear();

    const outer = RING_HALF + APRON_W;
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(outer * 2, 1.0, outer * 2),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(c.apronColor), roughness: 0.95 }),
    );
    platform.position.y = -0.5;
    platform.receiveShadow = true;
    this.ring.add(platform);

    const mat = new THREE.Mesh(
      new THREE.PlaneGeometry(RING_HALF * 2, RING_HALF * 2),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(c.matColor), roughness: 1 }),
    );
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.004;
    mat.receiveShadow = true;
    this.ring.add(mat);

    // Canvas trim: a thin square line just inside the ropes.
    const trim = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-RING_HALF, 0.006, -RING_HALF), new THREE.Vector3(RING_HALF, 0.006, -RING_HALF),
        new THREE.Vector3(RING_HALF, 0.006, RING_HALF), new THREE.Vector3(-RING_HALF, 0.006, RING_HALF),
      ]),
      new THREE.LineBasicMaterial({ color: new THREE.Color(c.matLineColor) }),
    );
    this.ring.add(trim);

    // Posts + pads. Red corner (+x,+z), blue corner (-x,-z); the other two neutral.
    const postH = c.ropeTopY + 0.25;
    const postGeo = new THREE.CylinderGeometry(c.postR, c.postR, postH, 12);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xe9e9f2, roughness: 0.4, metalness: 0.3 });
    const padGeo = new THREE.BoxGeometry(c.postR * 4, c.ropeTopY * 0.9, c.postR * 4);
    const corners: [number, number, string][] = [
      [1, 1, c.padColorRed], [-1, -1, c.padColorBlue], [1, -1, '#e9e9f2'], [-1, 1, '#e9e9f2'],
    ];
    const pOff = RING_HALF + c.postR + 0.05;
    for (const [sx, sz, padCol] of corners) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sx * pOff, postH / 2, sz * pOff);
      post.castShadow = true;
      this.ring.add(post);
      const pad = new THREE.Mesh(padGeo, new THREE.MeshStandardMaterial({ color: new THREE.Color(padCol), roughness: 0.8 }));
      pad.position.set(sx * pOff, c.ropeTopY * 0.55, sz * pOff);
      this.ring.add(pad);
    }

    // Ropes: `ropeCount` strands per side, evenly spaced up to ropeTopY, with sag.
    const ropeCols = [c.ropeColorA, c.ropeColorB, c.ropeColorC, c.ropeColorA];
    const ropeR = 0.022;
    for (let i = 0; i < c.ropeCount; i++) {
      const y = c.ropeTopY * (i + 1) / c.ropeCount;
      const rmat = new THREE.MeshStandardMaterial({ color: new THREE.Color(ropeCols[i % ropeCols.length]), roughness: 0.7 });
      for (const side of [0, 1, 2, 3]) {
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        const h = RING_HALF + c.postR;
        if (side === 0) { a.set(-h, y, -h); b.set(h, y, -h); }
        else if (side === 1) { a.set(h, y, -h); b.set(h, y, h); }
        else if (side === 2) { a.set(h, y, h); b.set(-h, y, h); }
        else { a.set(-h, y, h); b.set(-h, y, -h); }
        const mid = a.clone().lerp(b, 0.5); mid.y -= c.ropeSag;
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        const rope = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, ropeR, 6, false), rmat);
        rope.castShadow = true;
        this.ring.add(rope);
      }
    }
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

  /** Sim events since the last frame (main.ts calls this before `frame`). RENDER
   *  reacts here: camera punch-in on punchLand, flash sparkles, etc. */
  handleEvents(_events: readonly SimEvent[]): void {}

  // ── Per-frame ───────────────────────────────────────────────────────────────

  /**
   * `a`, `b`: the two fighters' floor positions (or the ring centre twice).
   * `closeness` 0..1 = how near the fighters are (drives dolly + FOV).
   * `t`: wall seconds for the handheld drift. `dt`: frame seconds.
   */
  frame(a: Vec2, b: Vec2, closeness: number, t: number, dt: number): void {
    const c = this.cfg;
    const k = RING_KEYS.map(k => String(c[k])).join('|');
    if (k !== this.ringKey) this.rebuildRing();

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

    // Broadcast camera: orbit at azimuth/elevation around the fighters' midpoint.
    const az = c.camAzimuthDeg * Math.PI / 180;
    const el = c.camElevationDeg * Math.PI / 180;
    const dist = c.camDistMax + (c.camDistMin - c.camDistMax) * closeness;
    const fov = c.camFovMax + (c.camFovMin - c.camFovMax) * closeness;
    this.lookTarget.set((a.x + b.x) / 2, c.camLookY, (a.z + b.z) / 2);
    const lam = 1 - Math.exp(-c.camFollowLambda * dt);
    this.look.lerp(this.lookTarget, lam);
    const drift = c.camDriftAmp;
    const dx = Math.sin(t * c.camDriftHz * TAU) * drift;
    const dy = Math.sin(t * c.camDriftHz * TAU * 1.37 + 1.1) * drift * 0.6;
    this.camera.position.set(
      this.look.x + dist * Math.cos(el) * Math.cos(az) + dx,
      this.look.y + dist * Math.sin(el) + dy,
      this.look.z + dist * Math.cos(el) * Math.sin(az),
    );
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - fov) > 1e-3) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    // Rim comes from behind the far ropes relative to the camera.
    this.rim.position.set(-Math.cos(az) * 6, 3.5, -Math.sin(az) * 6);
    this.rim.target.position.copy(this.look);

    this.renderer.render(this.scene, this.camera);
  }

  get info(): { calls: number; triangles: number } {
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }
}

/**
 * render/crowd.ts — the crowd as two instanced draws (full bodies near the
 * ring, lighter ones in the upper deck) animated ENTIRELY in the vertex
 * shader: per-person attributes + a handful of uniforms, no per-frame CPU
 * matrices. Each person sways at their own rate, stands when their arousal
 * crosses their own threshold, claps just under it, throws their arms up
 * above it. Arousal = the room's excitement (mood.ts) scaled by the person's
 * zeal, plus up to four ripples that travel outward from where a reaction
 * happened.
 *
 * Lighting is analytic (the ring's spill light as a point above the canvas,
 * wrap-lambert, plus house ambient) rather than scene lights: thousands of
 * people through the light loop would cost more than the fighters, and the
 * value ladder (lit ring → dim ringside → mid stands → dark upper deck) is
 * easier to hold when it is one formula shared with the baked structure.
 *
 * Also here: the camera-flash sparkles (Points; the CPU only writes a start
 * time when one fires).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Config } from '../core';
import { additive } from './atmos';

/** Where a person sits. `zone`: 0 ringside floor, 1 lower bowl, 2 upper deck. */
export interface Seat {
  x: number; y: number; z: number;
  /** Yaw so local +z faces the ring. */
  yaw: number;
  zone: 0 | 1 | 2;
  /** fan: the full repertoire; press: seated, never stands; corner: always standing, arms down. */
  role: 'fan' | 'press' | 'corner';
}

export const MAX_WAVES = 4;
const SHOULDER_Y = 0.98, SHOULDER_X = 0.26, ARM_LEN = 0.52;

/**
 * One person, seated, feet at the origin, facing +z. Three levels by how close
 * the play camera gets: 0 ringside (a real sphere for a head, five-sided arms,
 * ~100 tris), 1 lower bowl (icosahedron head, 48 tris), 2 upper deck (32 tris).
 * `aSkin`: 0 cloth, 1 skin, 2 hair.
 */
function personGeometry(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const tag = (g: THREE.BufferGeometry, part: number, pivot: [number, number, number], skin: (y: number) => number): THREE.BufferGeometry => {
    const out = g.index ? g.toNonIndexed() : g;
    out.deleteAttribute('uv');
    const pos = out.attributes['position']!;
    const n = pos.count;
    const aPart = new Float32Array(n).fill(part);
    const aPivot = new Float32Array(n * 3);
    const aSkin = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      aPivot[i * 3] = pivot[0]; aPivot[i * 3 + 1] = pivot[1]; aPivot[i * 3 + 2] = pivot[2];
      aSkin[i] = skin(pos.getY(i));
    }
    out.setAttribute('aPart', new THREE.BufferAttribute(aPart, 1));
    out.setAttribute('aPivot', new THREE.BufferAttribute(aPivot, 3));
    out.setAttribute('aSkin', new THREE.BufferAttribute(aSkin, 1));
    return out;
  };
  // Torso: hips at seat height, shoulders a touch wider than the waist.
  const torso = new THREE.BoxGeometry(0.46, 0.58, 0.25);
  {
    const p = torso.attributes['position']!;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setX(i, p.getX(i) * 0.82);
    torso.translate(0, 0.73, 0);
    torso.computeVertexNormals();
  }
  // Head: smooth normals so a 20- or 8-face solid reads round, not as a gem.
  const HEAD_Y = 1.17;
  const head0 = lod === 0 ? new THREE.SphereGeometry(0.125, 8, 6) : lod === 1 ? new THREE.IcosahedronGeometry(0.125, 0) : new THREE.OctahedronGeometry(0.13, 0);
  const head = head0.index ? head0.toNonIndexed() : head0;
  head.deleteAttribute('uv');
  const hairOf = new Float32Array(head.attributes['position']!.count);
  {
    const p = head.attributes['position']!, nrm = head.attributes['normal']!;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).normalize(); nrm.setXYZ(i, v.x, v.y, v.z);
      hairOf[i] = v.y > 0.3 || v.z < -0.35 ? 2 : 1;     // crown and back of the head are hair; the face is skin
    }
    head.scale(0.92, 1.14, 0.98).translate(0, HEAD_Y, 0.01);
  }
  let hi = 0;
  const arm = (side: -1 | 1): THREE.BufferGeometry => {
    const g = new THREE.CylinderGeometry(0.055, 0.045, ARM_LEN, lod === 0 ? 5 : lod === 1 ? 4 : 3, 1, true);
    g.translate(side * SHOULDER_X, SHOULDER_Y - ARM_LEN / 2, 0);
    return tag(g, side < 0 ? 2 : 3, [side * SHOULDER_X, SHOULDER_Y, 0], y => (y < SHOULDER_Y - ARM_LEN / 2 ? 1 : 0));
  };
  const parts = [
    tag(torso, 0, [0, 0, 0], () => 0),
    tag(head, 1, [0, 0, 0], () => hairOf[hi++]!),
    arm(-1), arm(1),
  ];
  // Ringside only (the first rows the play camera sits behind): a neck and rounded shoulders, so the figure reads
  // as a seated person from a few metres rather than a box with a ball on it.
  if (lod === 0) {
    parts.push(tag(new THREE.CylinderGeometry(0.05, 0.065, 0.12, 5, 1, true).translate(0, 1.05, 0), 0, [0, 0, 0], () => 1));
    for (const side of [-1, 1] as const) {
      const cap = new THREE.SphereGeometry(0.088, 5, 3).scale(1, 0.85, 1.05).translate(side * (SHOULDER_X - 0.02), SHOULDER_Y - 0.01, 0);
      parts.push(tag(cap, 0, [0, 0, 0], () => 0));
    }
    // A lap: the thighs coming forward from the hips (people in front hide it in the bowl; at ringside it shows).
    parts.push(tag(new THREE.BoxGeometry(0.4, 0.14, 0.42).translate(0, 0.47, 0.2), 0, [0, 0, 0], () => 0));
  }
  return mergeGeometries(parts);
}

const VERT = /* glsl */`
  uniform float uTime, uExcite, uRestless, uWaveSpeed, uWaveLife, uSway, uStandLift, uStandAt, uArmsAt, uSpread;
  uniform vec4 uWave[${MAX_WAVES}];
  uniform vec3 uLightPos;
  uniform float uSpill, uSpillR0, uSpillFalloff, uAmbient, uSkinTone, uClapAt, uBackLevel, uBackR2, uFlash;
  uniform vec3 uKeyCol, uCoolCol, uBackA, uBackB, uBackACol, uBackBCol;
  attribute vec3 aPivot;
  attribute float aPart, aSkin;
  attribute vec3 iPos, iColor, iSkin;
  attribute vec4 iA;   // yaw, width scale, height scale, phase 0..1
  attribute vec4 iB;   // stand offset -1..1 (or ±9 = never/always), arms offset, zeal 0..1, claps 0|1
  varying vec3 vColor;
  varying float vDepth;

  void main() {
    float phase = iA.w, zeal = iB.z;
    float wave = 0.0;
    for (int i = 0; i < ${MAX_WAVES}; i++) {
      vec4 w = uWave[i];
      float d = distance(iPos.xz, w.xy);
      float t = uTime - w.z - d / uWaveSpeed;
      if (t > 0.0) wave += w.w / (1.0 + d / 30.0) * smoothstep(0.0, 0.15, t) * exp(-t / uWaveLife);
    }
    float arousal = uExcite * (0.7 + 0.6 * zeal) + wave;
    float overStand = arousal - (uStandAt + iB.x * uSpread);
    float stand = smoothstep(0.0, 0.12, overStand);
    float arms = smoothstep(0.0, 0.15, arousal - (uArmsAt + iB.y * uSpread));
    // Applause is for a moment (a ripple passing) or a hot house — never the resting state.
    float clap = smoothstep(0.02, 0.15, (wave * 1.5 + max(0.0, uExcite - uClapAt)) * (0.4 + zeal)) * (1.0 - arms) * iB.w;

    vec3 p = position, n = normal;
    if (aPart > 1.5) {
      float side = aPart > 2.5 ? 1.0 : -1.0;
      float pump = sin(uTime * (5.0 + 4.0 * zeal) + phase * 57.0);
      float ang = arms * (2.5 + 0.3 * pump + 0.25 * sin(phase * 31.0 + side)) + clap * (1.15 + 0.12 * sin(uTime * 15.0 + phase * 40.0));
      float cs = cos(ang), sn = sin(ang);
      vec3 v = p - aPivot;
      v = vec3(v.x, v.y * cs + v.z * sn, -v.y * sn + v.z * cs);
      n = vec3(n.x, n.y * cs + n.z * sn, -n.y * sn + n.z * cs);
      v.x += side * arms * 0.3 * max(v.y, 0.0) - side * clap * 0.45 * max(v.z, 0.0);
      p = aPivot + v;
    }
    float h = p.y;
    float calm = 1.0 - 0.6 * stand;
    p.x += sin(uTime * (0.5 + 0.9 * zeal) + phase * 6.2832) * uSway * (1.0 + 1.6 * uRestless) * calm * h;
    p.z += sin(uTime * (0.21 + 0.3 * zeal) + phase * 71.0) * uSway * (0.4 + 1.2 * uRestless) * calm * h;
    p.y += stand * (uStandLift + abs(sin(uTime * (3.2 + 2.0 * zeal) + phase * 25.0)) * 0.07 * min(arousal, 1.2));
    p.x *= iA.y; p.y *= iA.z;

    float c = cos(iA.x), s = sin(iA.x);
    vec3 wp = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c) + iPos;
    vec3 wn = normalize(vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c));

    vec3 L = normalize(uLightPos - wp);
    float r = length(wp.xz);
    float q = max(r - uSpillR0, 0.0) / uSpillFalloff;
    float spill = uSpill / (1.0 + q * q);
    float lam = max(dot(wn, L) * 0.65 + 0.35, 0.0);
    float top = 0.6 + 0.4 * wn.y;
    float hk = fract(phase * 13.7);
    vec3 hair = hk < 0.55 ? vec3(0.012, 0.01, 0.01) : hk < 0.82 ? vec3(0.09, 0.05, 0.025) : hk < 0.93 ? vec3(0.32, 0.22, 0.1) : vec3(0.3, 0.3, 0.32);
    vec3 skin = iSkin * uSkinTone;
    vec3 base = aSkin <= 1.0 ? mix(iColor, skin, aSkin) : mix(skin, hair, aSkin - 1.0);
    // Warm key spill over cool house light, then the two coloured back lights on whoever sits nearest them, and
    // the camera flashes' own light on the rows the spill reaches. Each person also sits a little warm or cool.
    vec3 light = uCoolCol * (uAmbient * top) + uKeyCol * (spill * lam);
    vec3 dA = uBackA - wp, dB = uBackB - wp;
    light += uBackACol * (max(dot(wn, normalize(dA)) * 0.6 + 0.4, 0.0) / (1.0 + dot(dA, dA) / uBackR2)) * uBackLevel;
    light += uBackBCol * (max(dot(wn, normalize(dB)) * 0.6 + 0.4, 0.0) / (1.0 + dot(dB, dB) / uBackR2)) * uBackLevel;
    light += vec3(0.9, 0.95, 1.0) * (uFlash * spill * top);
    light *= mix(vec3(1.07, 1.0, 0.9), vec3(0.9, 1.0, 1.1), fract(phase * 3.7));
    vColor = base * light;

    vec4 mv = viewMatrix * vec4(wp, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */`
  uniform vec3 uFogColor;
  uniform float uFogNear, uFogFar;
  varying vec3 vColor;
  varying float vDepth;
  void main() {
    float f = smoothstep(uFogNear, uFogFar, vDepth);
    gl_FragColor = vec4(mix(vColor, uFogColor, f), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

const SKIN = ['#f1c9a5', '#e0ac69', '#c68642', '#8d5524', '#5c3a21', '#f5d7c2', '#a9744f'];

export class Crowd {
  readonly group = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private waves: THREE.Vector4[] = [];
  private waveNext = 0;

  constructor(seats: readonly Seat[], c: Config, rng: () => number, rich = true) {
    for (let i = 0; i < MAX_WAVES; i++) this.waves.push(new THREE.Vector4(0, 0, -1e6, 0));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 }, uExcite: { value: 0 }, uRestless: { value: 0 },
        uWave: { value: this.waves }, uWaveSpeed: { value: 20 }, uWaveLife: { value: 2 },
        uSway: { value: 0 }, uStandLift: { value: 0.4 }, uStandAt: { value: 0.5 }, uArmsAt: { value: 0.75 }, uSpread: { value: 0.3 },
        uLightPos: { value: new THREE.Vector3(0, 4.5, 0) },
        uSpill: { value: 1 }, uSpillR0: { value: 4 }, uSpillFalloff: { value: 5 }, uAmbient: { value: 0.05 },
        uSkinTone: { value: 0.6 }, uClapAt: { value: 0.3 },
        uBackLevel: { value: 0.5 }, uBackR2: { value: 60 }, uFlash: { value: 0 },
        uKeyCol: { value: new THREE.Color() }, uCoolCol: { value: new THREE.Color() },
        uBackA: { value: new THREE.Vector3() }, uBackB: { value: new THREE.Vector3() }, uBackACol: { value: new THREE.Color() }, uBackBCol: { value: new THREE.Color() },
        uFogColor: { value: new THREE.Color() }, uFogNear: { value: 10 }, uFogFar: { value: 40 },
      },
    });
    const base = new THREE.Color(c.crowdColor);
    const hsl = { h: 0, s: 0, l: 0 };
    base.getHSL(hsl);
    const col = new THREE.Color();
    for (const lod of [0, 1, 2] as const) {
      const mine = seats.filter(s => s.zone === lod);
      if (!mine.length) continue;
      // The detailed ringside figure is a high-tier thing: on low, ringside wears the lower bowl's body (the low
      // tier's triangle budget is the original 150k, and it now has two fighters in it).
      const src = personGeometry(lod === 0 && !rich ? 1 : lod);
      const geo = new THREE.InstancedBufferGeometry();
      for (const [name, attr] of Object.entries(src.attributes)) geo.setAttribute(name, attr);
      const n = mine.length;
      const iPos = new Float32Array(n * 3), iA = new Float32Array(n * 4), iB = new Float32Array(n * 4);
      const iColor = new Float32Array(n * 3), iSkin = new Float32Array(n * 3);
      mine.forEach((s, i) => {
        iPos.set([s.x, s.y, s.z], i * 3);
        iA.set([s.yaw, 0.88 + rng() * 0.28, 0.9 + rng() * 0.2, rng()], i * 4);
        const standOff = s.role === 'press' ? 9 : s.role === 'corner' ? -9 : rng() * 2 - 1;
        const armsOff = s.role === 'fan' ? Math.max(standOff, rng() * 2 - 1) : 9;
        iB.set([standOff, armsOff, rng(), s.role === 'corner' ? 0 : 1], i * 4);
        // Clothes: mostly the base value with hue scatter; one in eight wears something light.
        const light = rng() < 0.1;
        const l = Math.min(0.85, Math.max(0.03, (light ? Math.min(0.6, hsl.l * 2.2) : hsl.l) * (1 + (rng() * 2 - 1) * c.crowdVariance)));
        col.setHSL(rng(), c.crowdSaturation * (0.3 + 0.7 * rng()) * (light ? 0.5 : 1), l);
        iColor.set([col.r, col.g, col.b], i * 3);
        col.set(SKIN[Math.floor(rng() * SKIN.length)]!);
        iSkin.set([col.r, col.g, col.b], i * 3);
      });
      geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
      geo.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 4));
      geo.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 4));
      geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 3));
      geo.setAttribute('iSkin', new THREE.InstancedBufferAttribute(iSkin, 3));
      geo.instanceCount = n;
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /** Start a ripple at floor position (x, z): people there react first, the rest as it reaches them. */
  wave(x: number, z: number, strength: number, t: number): void {
    // Reuse the weakest / oldest slot.
    this.waves[this.waveNext]!.set(x, z, t, strength);
    this.waveNext = (this.waveNext + 1) % MAX_WAVES;
  }

  update(c: Config, t: number, excite: number, fog: THREE.Fog, spillR0: number, flash: number): void {
    const u = this.mat.uniforms;
    const S = c.trussSize / 2;
    (u['uKeyCol']!.value as THREE.Color).set(c.keyColor);
    (u['uCoolCol']!.value as THREE.Color).set(c.fillSkyColor);
    (u['uBackA']!.value as THREE.Vector3).set(S, c.trussHeight, S);
    (u['uBackB']!.value as THREE.Vector3).set(-S, c.trussHeight, -S);
    (u['uBackACol']!.value as THREE.Color).set(c.backColorA);
    (u['uBackBCol']!.value as THREE.Color).set(c.backColorB);
    u['uBackLevel']!.value = c.crowdBackLight;
    u['uBackR2']!.value = c.crowdBackReach * c.crowdBackReach;
    u['uFlash']!.value = flash * c.crowdFlashLight;
    u['uTime']!.value = t;
    u['uExcite']!.value = excite;
    u['uRestless']!.value = Math.min(1, Math.max(0, (c.exciteBase - excite) / Math.max(0.01, c.exciteBase - c.exciteLull)));
    u['uWaveSpeed']!.value = c.crowdWaveSpeed;
    u['uWaveLife']!.value = c.crowdWaveSeconds;
    u['uSway']!.value = c.crowdSway;
    u['uStandLift']!.value = c.crowdStandLift;
    u['uStandAt']!.value = c.crowdStandAt;
    u['uArmsAt']!.value = c.crowdArmsAt;
    u['uSpread']!.value = c.crowdSpread;
    u['uSpill']!.value = c.spillIntensity;
    u['uSpillR0']!.value = spillR0;
    u['uSpillFalloff']!.value = c.spillFalloff;
    u['uAmbient']!.value = c.bowlAmbient;
    u['uSkinTone']!.value = c.crowdSkinTone;
    u['uClapAt']!.value = c.crowdClapAt;
    (u['uFogColor']!.value as THREE.Color).copy(fog.color);
    u['uFogNear']!.value = fog.near;
    u['uFogFar']!.value = fog.far;
  }

  dispose(): void {
    this.group.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
    this.mat.dispose();
    this.group.clear();
  }
}

// ── Camera flashes ───────────────────────────────────────────────────────────

const FLASH_LIFE = 0.16;

const FLASH_VERT = /* glsl */`
  uniform float uTime, uSize, uPx;
  attribute float aStart;
  varying float vA;
  void main() {
    float u = (uTime - aStart) / ${FLASH_LIFE.toFixed(3)};
    vA = u >= 0.0 && u < 1.0 ? 1.0 - u * u : 0.0;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = vA > 0.0 ? max(3.0, uSize * uPx / max(0.1, -mv.z)) : 0.0;
    gl_Position = vA > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  }`;
const FLASH_FRAG = /* glsl */`
  varying float vA;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = length(p);
    float core = smoothstep(0.45, 0.0, d);
    float star = max(0.0, 1.0 - abs(p.y) * 9.0) * max(0.0, 1.0 - abs(p.x)) + max(0.0, 1.0 - abs(p.x) * 9.0) * max(0.0, 1.0 - abs(p.y));
    float a = (core * 2.2 + star * 0.7) * vA;
    gl_FragColor = vec4(vec3(0.92, 0.96, 1.0) * a, 1.0);
    #include <colorspace_fragment>
  }`;

export class CrowdFlashes {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;
  private pos: THREE.BufferAttribute;
  private start: THREE.BufferAttribute;
  private next = 0;
  private owed = 0;          // fractional flashes carried between frames
  private burstLeft = 0;     // flashes still to fire from a burst
  private burstRate = 0;     // per second
  /** 0..1: how much flash light is in the room right now (each flash adds, it dies in a fraction of a second). The crowd's nearest rows take it. */
  pulse = 0;

  constructor(private seats: readonly Seat[], private count: number) {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    this.start = new THREE.BufferAttribute(new Float32Array(count).fill(-1e6), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage); this.start.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aStart', this.start);
    this.mat = new THREE.ShaderMaterial(additive({
      vertexShader: FLASH_VERT, fragmentShader: FLASH_FRAG,
      uniforms: { uTime: { value: 0 }, uSize: { value: 0.4 }, uPx: { value: 800 } },
    }));
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 12;
  }

  /** `n` flashes over the next `seconds`. */
  burst(n: number, seconds = 1): void {
    if (n <= 0) return;
    this.burstLeft += n;
    this.burstRate = Math.max(this.burstRate, this.burstLeft / Math.max(0.1, seconds));
  }

  private fire(t: number): void {
    if (!this.count || !this.seats.length) return;
    const seat = this.seats[Math.floor(Math.random() * this.seats.length)]!;   // render-local, never the sim RNG
    const i = this.next; this.next = (this.next + 1) % this.count;
    this.pos.setXYZ(i, seat.x, seat.y + 1.25, seat.z);
    this.start.setX(i, t);
    this.pulse = Math.min(1, this.pulse + 0.2);
    this.pos.needsUpdate = true; this.start.needsUpdate = true;
  }

  update(c: Config, t: number, dt: number, excite: number, pxPerM: number): void {
    const u = this.mat.uniforms;
    u['uTime']!.value = t; u['uSize']!.value = c.flashSize; u['uPx']!.value = pxPerM;
    this.pulse *= Math.exp(-Math.min(dt, 0.1) * 7);
    let rate = c.flashRate + c.flashExciteRate * excite * excite;
    if (this.burstLeft > 0) rate += this.burstRate; else this.burstRate = 0;
    this.owed += rate * Math.min(dt, 0.1);
    while (this.owed >= 1) {
      this.owed -= 1;
      if (this.burstLeft > 0) this.burstLeft -= 1;
      this.fire(t - Math.random() * dt);
    }
  }

  dispose(): void { this.points.geometry.dispose(); this.mat.dispose(); }
}

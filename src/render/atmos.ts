/**
 * render/atmos.ts — the air in the room: light shafts, the haze layer, dust
 * motes in the key, and every small practical light as one Points draw.
 *
 * Cost notes (memory: a full-screen blended quad is ~1.4 ms on the integrated
 * GPU). Beams are additive cones whose edges fade with the view angle
 * (|N·V|), so they read as shafts of lit haze and cover far fewer bright
 * pixels than a solid cone; they fade to nothing where they reach the ring,
 * so they never wash the fighters. The haze is ONE back-face cylinder between
 * the ringside rows and the lower bowl — whichever way the camera orbits, the
 * far half of it veils the stands behind the fighters and nothing sits in
 * front of them. Both are skipped or thinned on the low tier.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Config } from '../core';

/**
 * Additive light is authored in LINEAR values, which is what the post pass's
 * HDR target wants. Without post the frame buffer is display-encoded, where
 * the three.js colour-space chunk would turn a 0.04 add into 0.22 on top of
 * whatever is there — a lavender wash over the whole room (seen 2026-11-11).
 * So additive materials skip the encode and take this one shared gain
 * instead: 1 into the HDR target, `noPostAdditive` straight to the screen.
 */
export const additiveGain = { value: 1 };

/** Make a ShaderMaterial's parameters additive in the sense above: shared `uAdd` gain in place of the colour-space encode. */
export function additive(p: THREE.ShaderMaterialParameters): THREE.ShaderMaterialParameters {
  return {
    ...p,
    uniforms: { ...p.uniforms, uAdd: additiveGain },
    fragmentShader: 'uniform float uAdd;\n' + (p.fragmentShader ?? '').replace('#include <colorspace_fragment>', 'gl_FragColor.rgb *= uAdd;'),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  };
}

/**
 * Drifting-haze noise: two fetches of one small tiling texture on crossed
 * planes, instead of procedural 3D value noise (eight sin-hashes a pixel —
 * that was most of a frame on a CPU rasteriser, and not free on a phone).
 */
let noiseTex: THREE.DataTexture | null = null;
function noiseTexture(): THREE.DataTexture {
  if (noiseTex) return noiseTex;
  const n = 64, data = new Uint8Array(n * n * 4);
  // Smooth value noise, tiling: a coarse random lattice, bilinearly upsampled with wrap.
  const lat = 8, g = new Float32Array(lat * lat);
  let s = 12345;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const fx = x / n * lat, fy = y / n * lat, x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ux = fx - x0, uy = fy - y0, sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy);
    const at = (i: number, j: number): number => g[(j % lat) * lat + (i % lat)]!;
    const v = (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
    data.fill(Math.round(v * 255), (y * n + x) * 4, (y * n + x) * 4 + 4);
  }
  noiseTex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = noiseTex.minFilter = THREE.LinearFilter;
  noiseTex.needsUpdate = true;
  return noiseTex;
}
const NOISE = /* glsl */`
  uniform sampler2D uNoiseTex;
  float vnoise(vec3 p) {
    return 0.5 * (texture2D(uNoiseTex, p.xz * 0.125 + p.y * 0.031).r + texture2D(uNoiseTex, p.xy * 0.125 + vec2(0.37, 0.11) - p.z * 0.043).r);
  }`;

// ── Beams ────────────────────────────────────────────────────────────────────

export interface BeamSpec { from: THREE.Vector3; to: THREE.Vector3; r0: number; r1: number; color: THREE.Color; level: number }

const UP = new THREE.Vector3(0, 1, 0);

export class Beams {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(specs: readonly BeamSpec[]) {
    const cones: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    for (const s of specs) {
      const len = s.from.distanceTo(s.to);
      const g = new THREE.CylinderGeometry(s.r0, s.r1, len, 20, 1, true);   // +y (uv.y = 1) is the lamp end
      const n = g.attributes['position']!.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = s.color.r * s.level; col[i * 3 + 1] = s.color.g * s.level; col[i * 3 + 2] = s.color.b * s.level; }
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      q.setFromUnitVectors(UP, s.from.clone().sub(s.to).normalize());
      g.applyMatrix4(m.compose(s.from.clone().lerp(s.to, 0.5), q, one));
      cones.push(g);
    }
    this.mat = new THREE.ShaderMaterial(additive({
      uniforms: { uTime: { value: 0 }, uNoise: { value: 0.4 }, uLevel: { value: 1 }, uNoiseTex: { value: noiseTexture() } },
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        varying vec3 vCol, vN, vV, vW;
        varying float vT;
        void main() {
          vCol = aColor; vT = 1.0 - uv.y; vW = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = -mv.xyz; vN = normalMatrix * normal;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uNoise, uLevel;
        varying vec3 vCol, vN, vV, vW;
        varying float vT;
        ${NOISE}
        void main() {
          float edge = abs(dot(normalize(vN), normalize(vV)));
          float soft = edge * edge;                                  // silhouette edges fade out: a shaft, not a cone
          float along = pow(1.0 - vT, 1.4) * smoothstep(0.0, 0.03, vT);   // bright at the lamp, gone where it lands
          float n = vnoise(vW * vec3(0.8, 0.45, 0.8) + vec3(uTime * 0.06, -uTime * 0.035, uTime * 0.045));
          float a = soft * along * (1.0 - uNoise + uNoise * n * 1.7);
          a *= smoothstep(0.4, 2.5, length(vV));                     // never a wall of light when the lens passes through one
          gl_FragColor = vec4(vCol * a * uLevel, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
    }));
    this.mesh = new THREE.Mesh(cones.length ? mergeGeometries(cones) : new THREE.BufferGeometry(), this.mat);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.mesh.visible = cones.length > 0;
  }

  update(c: Config, t: number): void {
    this.mat.uniforms['uTime']!.value = t;
    this.mat.uniforms['uNoise']!.value = c.beamNoise;
  }

  dispose(): void { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ── Haze ─────────────────────────────────────────────────────────────────────

export class Haze {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(radius: number, yBottom: number, yTop: number) {
    const h = yTop - yBottom;
    const geo = new THREE.CylinderGeometry(radius, radius, h, 48, 1, true).translate(0, yBottom + h / 2, 0);
    this.mat = new THREE.ShaderMaterial(additive({
      uniforms: { uTime: { value: 0 }, uDensity: { value: 0.05 }, uScroll: { value: 0.01 }, uColor: { value: new THREE.Color() }, uNoiseTex: { value: noiseTexture() } },
      vertexShader: /* glsl */`
        varying vec3 vW; varying float vH, vDist;
        void main() {
          vW = position; vH = uv.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uDensity, uScroll;
        uniform vec3 uColor;
        varying vec3 vW; varying float vH, vDist;
        ${NOISE}
        void main() {
          vec3 p = vec3(vW.x * 0.3, vW.y * 0.55, vW.z * 0.3) + vec3(uTime * uScroll, -uTime * uScroll * 0.6, uTime * uScroll * 0.7);
          float n = vnoise(p) * 0.65 + vnoise(p * 2.7 + 11.0) * 0.35;
          float prof = smoothstep(0.0, 0.18, vH) * (1.0 - smoothstep(0.3, 1.0, vH));   // hangs low-mid, thins upward
          float a = uDensity * prof * (0.45 + 1.1 * n) * smoothstep(3.0, 7.5, vDist);
          gl_FragColor = vec4(uColor * a, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
    }));
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 9;
  }

  update(c: Config, t: number, scale = 1): void {
    const u = this.mat.uniforms;
    u['uTime']!.value = t; u['uDensity']!.value = c.hazeDensity * scale; u['uScroll']!.value = c.hazeScroll;
    (u['uColor']!.value as THREE.Color).set(c.hazeColor);
  }

  dispose(): void { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ── Dust motes in the key light ──────────────────────────────────────────────

export class Motes {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(count: number, radius: number, yMin: number, yMax: number, rng: () => number) {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(rng()) * radius, a = rng() * Math.PI * 2;
      pos.set([Math.cos(a) * r, yMin + rng() * (yMax - yMin), Math.sin(a) * r], i * 3);
      seed[i] = rng();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.mat = new THREE.ShaderMaterial(additive({
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.2 }, uPx: { value: 800 }, uColor: { value: new THREE.Color() }, uYMin: { value: yMin }, uYSpan: { value: yMax - yMin } },
      vertexShader: /* glsl */`
        uniform float uTime, uPx, uYMin, uYSpan;
        attribute float aSeed;
        varying float vA;
        void main() {
          vec3 p = position;
          float s = aSeed * 6.2832;
          p.x += sin(uTime * 0.11 + s * 3.0) * 0.35;
          p.z += cos(uTime * 0.09 + s * 5.0) * 0.35;
          p.y = uYMin + mod(p.y - uYMin - uTime * (0.015 + 0.03 * aSeed), uYSpan);   // they sink, slowly
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = max(0.1, -mv.z);
          gl_PointSize = clamp((0.012 + 0.014 * aSeed) * uPx / d, 1.0, 5.0);
          float edge = smoothstep(0.0, 0.12, (p.y - uYMin) / uYSpan) * smoothstep(1.0, 0.8, (p.y - uYMin) / uYSpan);
          vA = edge * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed) + s * 7.0)) * smoothstep(1.2, 3.0, d);   // they turn in and out of the light
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform vec3 uColor;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord * 2.0 - 1.0);
          gl_FragColor = vec4(uColor * uOpacity * vA * smoothstep(1.0, 0.2, d), 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 11;
  }

  update(c: Config, t: number, pxPerM: number): void {
    const u = this.mat.uniforms;
    u['uTime']!.value = t; u['uOpacity']!.value = c.moteOpacity; u['uPx']!.value = pxPerM;
    (u['uColor']!.value as THREE.Color).set(c.keyColor);
  }

  dispose(): void { this.points.geometry.dispose(); this.mat.dispose(); }
}

// ── Practical lights ─────────────────────────────────────────────────────────

/** One small light: where, what colour, how big (m), and whether it twinkles (0 = steady, else a phase). */
export interface Practical { x: number; y: number; z: number; color: THREE.Color; size: number; twinkle: number }

export class Practicals {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(list: readonly Practical[]) {
    const n = list.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), meta = new Float32Array(n * 2);
    list.forEach((p, i) => {
      pos.set([p.x, p.y, p.z], i * 3);
      col.set([p.color.r, p.color.g, p.color.b], i * 3);
      meta.set([p.size, p.twinkle], i * 2);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMeta', new THREE.BufferAttribute(meta, 2));
    this.mat = new THREE.ShaderMaterial(additive({
      uniforms: { uTime: { value: 0 }, uLevel: { value: 1 }, uPx: { value: 800 }, uFogNear: { value: 10 }, uFogFar: { value: 50 } },
      vertexShader: /* glsl */`
        uniform float uTime, uPx, uLevel, uFogNear, uFogFar;
        attribute vec3 aColor; attribute vec2 aMeta;
        varying vec3 vCol;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = max(0.1, -mv.z);
          float px = aMeta.x * uPx / d;
          gl_PointSize = max(2.0, px);
          float keep = min(1.0, px * px / 4.0);                       // a light smaller than the 2 px floor dims instead of growing
          float tw = aMeta.y > 0.0 ? 0.55 + 0.45 * sin(uTime * (1.3 + fract(aMeta.y * 7.3) * 2.5) + aMeta.y * 40.0) : 1.0;
          float fog = 1.0 - 0.75 * smoothstep(uFogNear, uFogFar, d);  // lights carry through haze further than surfaces
          vCol = aColor * uLevel * keep * tw * fog;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol;
        void main() {
          float d = length(gl_PointCoord * 2.0 - 1.0);
          gl_FragColor = vec4(vCol * smoothstep(1.0, 0.25, d), 1.0);
          #include <colorspace_fragment>
        }`,
    }));
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
  }

  update(c: Config, t: number, pxPerM: number, fog: THREE.Fog): void {
    const u = this.mat.uniforms;
    u['uTime']!.value = t; u['uLevel']!.value = c.practicalBrightness; u['uPx']!.value = pxPerM;
    u['uFogNear']!.value = fog.near; u['uFogFar']!.value = fog.far;
  }

  dispose(): void { this.points.geometry.dispose(); this.mat.dispose(); }
}

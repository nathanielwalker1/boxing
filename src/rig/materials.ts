/**
 * rig/materials.ts — the toy-figure look. One MeshToonMaterial shared by every
 * fighter (colour comes from vertex colours), with a code-generated stepped
 * gradient map (cfg.toonBands) and a view-space rim term injected through
 * onBeforeCompile (cfg.rimStrength, cfg.rigRimPower). The rim is resolved in
 * view space in the shader, so it is correct for any yaw — the v1 mirroring
 * constraint has nothing to flip here.
 *
 * Outlines are a second material: an inverted hull (BackSide) that pushes each
 * vertex along its skinned normal by cfg.outlineWidth. Built always, drawn only
 * while cfg.outlines is on.
 */
import * as THREE from 'three';
import type { Config } from '../core';

// ── Gradient map ─────────────────────────────────────────────────────────────
// 32 texels across dotNL ∈ [-1, 1], quantised into `bands` levels between the
// terminator (dotNL ≈ -0.4) and full light (dotNL ≈ 0.6). A 1-texel-per-band
// map would put the only step at dotNL = 0, which reads as a lit hemisphere.

const GRAD_W = 32;
const gradCache = new Map<number, THREE.DataTexture>();

export function gradientMap(bands: number): THREE.DataTexture {
  const n = Math.max(1, Math.round(bands));
  const cached = gradCache.get(n);
  if (cached) return cached;
  const data = new Uint8Array(GRAD_W);
  for (let i = 0; i < GRAD_W; i++) {
    const u = (i + 0.5) / GRAD_W;                       // 0..1 == dotNL -1..1
    const f = Math.min(0.9999, Math.max(0, (u - 0.3) / 0.5));
    const b = Math.floor(f * n);
    const v = n === 1 ? 1 : 0.38 + 0.62 * b / (n - 1);
    data[i] = Math.round(255 * v);
  }
  const t = new THREE.DataTexture(data, GRAD_W, 1, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  gradCache.set(n, t);
  return t;
}

// ── Toon + rim ───────────────────────────────────────────────────────────────

const rimUniforms = {
  uRimStrength: { value: 0.6 },
  uRimPower: { value: 3 },
  uRimColor: { value: new THREE.Color(0xffffff) },
};

const RIM_GLSL = `
{
  float rimF = pow( 1.0 - saturate( dot( normalize( normal ), normalize( vViewPosition ) ) ), uRimPower );
  outgoingLight += uRimColor * ( rimF * uRimStrength );
}
#include <opaque_fragment>`;

let toon: THREE.MeshToonMaterial | null = null;

export function toonMaterial(cfg: Config): THREE.MeshToonMaterial {
  if (toon) return toon;
  toon = new THREE.MeshToonMaterial({
    color: 0xffffff,
    vertexColors: true,
    gradientMap: gradientMap(cfg.toonBands),
  });
  toon.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, rimUniforms);
    shader.fragmentShader = 'uniform float uRimStrength;\nuniform float uRimPower;\nuniform vec3 uRimColor;\n'
      + shader.fragmentShader.replace('#include <opaque_fragment>', RIM_GLSL);
  };
  toon.customProgramCacheKey = () => 'rigToonRim';
  return toon;
}

// ── Outline (inverted hull) ──────────────────────────────────────────────────

const outlineUniforms = { uOutlineWidth: { value: 0.012 } };
let outline: THREE.MeshBasicMaterial | null = null;
let outlineColorKey = '';

export function outlineMaterial(cfg: Config): THREE.MeshBasicMaterial {
  if (outline) return outline;
  outline = new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.rigOutlineColor), side: THREE.BackSide });
  outlineColorKey = cfg.rigOutlineColor;
  outline.onBeforeCompile = shader => {
    shader.uniforms.uOutlineWidth = outlineUniforms.uOutlineWidth;
    shader.vertexShader = 'uniform float uOutlineWidth;\n' + shader.vertexShader.replace(
      '#include <skinning_vertex>',
      '#include <skinning_vertex>\n\ttransformed += normalize( objectNormal ) * uOutlineWidth;',
    );
  };
  outline.customProgramCacheKey = () => 'rigOutlineHull';
  return outline;
}

/** Push live config into the shared materials. Cheap; call once per frame per view. */
export function updateMaterials(cfg: Config): void {
  if (toon) {
    rimUniforms.uRimStrength.value = cfg.rimStrength;
    rimUniforms.uRimPower.value = cfg.rigRimPower;
    const gm = gradientMap(cfg.toonBands);
    if (toon.gradientMap !== gm) toon.gradientMap = gm;
  }
  if (outline) {
    outlineUniforms.uOutlineWidth.value = cfg.outlineWidth;
    if (outlineColorKey !== cfg.rigOutlineColor) { outlineColorKey = cfg.rigOutlineColor; outline.color.set(cfg.rigOutlineColor); }
  }
}

/**
 * render/paint.ts — the Bellows x Sifu look test. MATERIAL AND LIGHT ONLY.
 *
 * One switch (cfg.paintLook). Everything here is gated by the shared `uPaint` uniform, so off = the old picture
 * exactly and the switch works live. Three jobs:
 *   1. fighters: banded diffuse (soft edges, warm lit / cool shade), skin pulled toward neutral while saturated kit
 *      (gloves, trunks) is kept, plus an inverted-hull ink outline on the skinned mesh (shares its skeleton);
 *   2. the room: desaturated, dimmed, with big brush strokes from a canvas texture sampled in WORLD space;
 *   3. the crowd: its own shader reads the same uniforms (dark, flat, smeared).
 * No time input anywhere: with the camera still nothing here changes.
 */
import * as THREE from 'three';
import type { Config } from '../core';

/** Uniforms shared by every patched shader; Stage refreshes them once a frame (`updatePaint`). */
export const paintU = {
  uPaint: { value: 1 },
  uBandTop: { value: 1 }, uBands: { value: 3 }, uBandSoft: { value: 0.1 }, uBandFloor: { value: 0.15 },
  uLitCol: { value: new THREE.Color() }, uShadeCol: { value: new THREE.Color() }, uTintMix: { value: 0.8 },
  uSkinDesat: { value: 0.3 }, uKitMask: { value: null as THREE.Texture | null },
  uRoomDesat: { value: 0.85 }, uBrushScale: { value: 3 },
  uPool: { value: new THREE.Vector3(3.8, 9, 0.1) },
  uBrush: { value: null as THREE.Texture | null },
  uCrowdDim: { value: 0.45 }, uCrowdDesat: { value: 0.9 }, uCrowdFlat: { value: 0.55 }, uCrowdBrush: { value: 0.9 },
  uOutline: { value: 0.01 },
  uBandOn: { value: 1 }, uDesatOn: { value: 1 }, uBandMix: { value: 0.35 }, uMaskDbg: { value: 0 },
  uRimCol: { value: new THREE.Color() }, uRimStr: { value: 0.5 }, uRimPow: { value: 3 },
};

const hulls = new Set<THREE.Mesh>();
let brushSeed = -1;
let maskFile = -1;
let outlineCol = '';
const outlineMat = new THREE.MeshBasicMaterial({ color: 0x0a0706, side: THREE.BackSide });

/** Seeded generator for the brush texture (render-local, never the sim's). */
function mulberry(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A tileable canvas of big, soft, mostly horizontal strokes — a handful of tones, no fine detail (it must survive a phone's compression). */
function makeBrush(seed: number): THREE.Texture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const rnd = mulberry(seed);
  g.fillStyle = '#808080';
  g.fillRect(0, 0, S, S);
  g.lineCap = 'round';
  for (let i = 0; i < 70; i++) {
    const x = rnd() * S, y = rnd() * S, len = 140 + rnd() * 260, w = 38 + rnd() * 60, ang = (rnd() - 0.5) * 0.5;
    const v = 70 + rnd() * 120, warm = (rnd() - 0.5) * 26;
    g.strokeStyle = `rgba(${Math.round(v + warm)},${Math.round(v)},${Math.round(v - warm)},0.55)`;
    g.lineWidth = w;
    const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {   // wrapped copies: the tile has no seam
      g.beginPath(); g.moveTo(x + ox, y + oy); g.quadraticCurveTo(x + ox + dx / 2, y + oy + dy / 2 + (rnd() - 0.5) * 20, x + ox + dx, y + oy + dy); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Once a frame: the switch, the live tunables, the brush texture (rebuilt only when its seed changes). */
export function updatePaint(c: Config): void {
  const u = paintU;
  u.uPaint.value = c.paintLook ? 1 : 0;
  for (const h of hulls) { h.visible = c.paintLook && c.paintOutline; if (!h.parent) hulls.delete(h); }
  if (!c.paintLook) return;
  if (brushSeed !== c.paintBrushSeed) {
    u.uBrush.value?.dispose();
    u.uBrush.value = makeBrush(c.paintBrushSeed);
    brushSeed = c.paintBrushSeed;
  }
  u.uBandTop.value = c.paintBandTop; u.uBands.value = c.paintBands; u.uBandSoft.value = c.paintBandSoft; u.uBandFloor.value = c.paintBandFloor;
  u.uLitCol.value.set(c.paintLitColor); u.uShadeCol.value.set(c.paintShadeColor); u.uTintMix.value = c.paintTintMix;
  u.uSkinDesat.value = c.paintSkinDesat;
  u.uBandOn.value = c.paintAblate >= 1 ? 1 : 0;   // paintAblate: see config
  u.uDesatOn.value = c.paintAblate >= 2 ? 1 : 0;
  u.uBandMix.value = c.paintBandMix;
  u.uMaskDbg.value = c.paintDebugMask ? 1 : 0;
  u.uRimCol.value.set(c.paintRimColor); u.uRimStr.value = c.paintAblate >= 5 ? c.paintRimStr : 0; u.uRimPow.value = c.paintRimPow;
  if (maskFile !== c.humanBodyFile) {   // the body's region mask (R trunks, G gloves), same UVs as its colour map; body files 1 and 2 are the Meshy ones
    maskFile = c.humanBodyFile;
    u.uKitMask.value = null;
    if (c.humanBodyFile === 1 || c.humanBodyFile === 2) {
      new THREE.TextureLoader().load(`/fighter/boxer_m${c.humanBodyFile}_mask.webp`, t => { t.flipY = false; t.colorSpace = THREE.NoColorSpace; if (maskFile === c.humanBodyFile) u.uKitMask.value = t; });
    }
  }
  u.uPool.value.set(c.paintPoolR0, c.paintPoolR1, c.paintPoolFloor);
  u.uRoomDesat.value = c.paintRoomDesat; u.uBrushScale.value = c.paintBrushScale;
  u.uCrowdDim.value = c.paintCrowdDim; u.uCrowdDesat.value = c.paintCrowdDesat; u.uCrowdFlat.value = c.paintCrowdFlat; u.uCrowdBrush.value = c.paintCrowdBrush;
  u.uOutline.value = c.paintOutlineM;
  if (outlineCol !== c.paintOutlineColor) { outlineMat.color.set(c.paintOutlineColor); outlineCol = c.paintOutlineColor; }
}

const LUMA = 'const vec3 pLuma = vec3(0.2126, 0.7152, 0.0722);';

/** Chain onto a material's existing onBeforeCompile / cache key (ring.ts fades posts that way). */
function chain(mat: THREE.Material, tag: string, patch: (s: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (s, r) => { prev.call(mat, s, r); patch(s); };
  mat.customProgramCacheKey = () => `${prevKey.call(mat)}|${tag}`;
  mat.needsUpdate = true;
}

/** Room surfaces: grey them, dim the unlit ones, brush them in world space. Instanced and plain meshes alike. */
export function paintRoomMaterial(mat: THREE.Material, brush: number, dim: number): void {
  if (mat.userData['painted'] || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
  if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(mat as THREE.MeshBasicMaterial).isMeshBasicMaterial) return;
  mat.userData['painted'] = true;
  chain(mat, `room`, shader => {
    Object.assign(shader.uniforms, { uPaint: paintU.uPaint, uPool: paintU.uPool, uRoomDesat: paintU.uRoomDesat, uBrushScale: paintU.uBrushScale, uBrush: paintU.uBrush, uBrushAmt: { value: brush }, uRoomDim: { value: dim } });
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying vec3 vPaintW;\nvoid main() {')
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 pw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
          pw = instanceMatrix * pw;
          #endif
          vPaintW = (modelMatrix * pw).xyz; }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uPaint, uRoomDesat, uBrushScale, uBrushAmt, uRoomDim;
        uniform sampler2D uBrush;
        uniform vec3 uPool;
        varying vec3 vPaintW;
        ${LUMA}
        void main() {`)
      .replace('#include <opaque_fragment>', `
        if (uPaint > 0.5) {
          float l = dot(outgoingLight, pLuma);
          outgoingLight = mix(outgoingLight, vec3(l), uRoomDesat) * uRoomDim;
          // the pool of light: full inside the ring, falling to the floor value outside it, in world space
          outgoingLight *= mix(1.0, uPool.z, smoothstep(uPool.x, uPool.y, max(abs(vPaintW.x), abs(vPaintW.z))));
          vec3 gn = abs(normalize(cross(dFdx(vPaintW), dFdy(vPaintW)) + 1e-9));
          vec2 buv = gn.y > max(gn.x, gn.z) ? vPaintW.xz : (gn.x > gn.z ? vPaintW.zy : vPaintW.xy);
          vec3 br = texture2D(uBrush, buv / uBrushScale).rgb;
          outgoingLight *= 1.0 + (br - 0.5) * 2.0 * uBrushAmt;
        }
        #include <opaque_fragment>`);
  });
}

/** Patch every mesh material under `root` as a room surface. Re-patching is a no-op. */
export function paintRoom(root: THREE.Object3D, c: Config, kind: 'arena' | 'ring'): void {
  const brush = kind === 'arena' ? c.paintBrushRoom : c.paintBrushRing;
  const dim = kind === 'arena' ? c.paintRoomDim : 1;
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => {
      // Lit materials are already lit by the dimmed key; only unlit (Basic) surfaces get the extra dim.
      paintRoomMaterial(mt, brush, (mt as THREE.MeshBasicMaterial).isMeshBasicMaterial ? dim : 1);
    });
  });
}

/** Fighter material: banded diffuse, warm lit / cool shade, skin toward neutral, kit kept saturated. */
function paintFighterMaterial(mat: THREE.Material, kitAll: number): void {
  if (mat.userData['painted']) return;
  mat.userData['painted'] = true;
  chain(mat, 'fighter', shader => {
    for (const k of ['uPaint', 'uBandTop', 'uBands', 'uBandSoft', 'uBandFloor', 'uLitCol', 'uShadeCol', 'uTintMix', 'uSkinDesat', 'uKitMask',
      'uBandOn', 'uDesatOn', 'uBandMix', 'uMaskDbg', 'uRimCol', 'uRimStr', 'uRimPow'] as const) shader.uniforms[k] = paintU[k];
    shader.uniforms['uKitAll'] = { value: kitAll };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uPaint, uBandTop, uBands, uBandSoft, uBandFloor, uTintMix, uSkinDesat, uKitAll;
        uniform float uBandOn, uDesatOn, uBandMix, uMaskDbg, uRimStr, uRimPow;
        uniform vec3 uLitCol, uShadeCol, uRimCol;
        uniform sampler2D uKitMask;
        ${LUMA}
        void main() {`)
      .replace('#include <opaque_fragment>', `
        if (uPaint > 0.5) {
          float lum = dot(outgoingLight, pLuma);
          // band the LIGHT (lit luminance over albedo luminance), so dark skin stays dark under the same band
          float alb = max(dot(diffuseColor.rgb, pLuma), 0.02);
          float lit = lum / alb;
          float s = clamp(lit / uBandTop, 0.0, 1.0) * uBands;
          float f = min(floor(s), uBands - 1.0);
          float q = (f + smoothstep(0.5 - uBandSoft, 0.5 + uBandSoft, fract(s)) * step(f, uBands - 1.5)) / (uBands - 1.0);
          if (s >= uBands) q = 1.0;
          float lq = mix(uBandFloor, 1.0, q) * uBandTop;
          // the band MODULATES the smooth light (uBandMix of the way to the banded level), so the normal-map /
          // faceted planes inside a band survive; at uBandMix 1 every texel in a band is one flat level
          vec3 col = outgoingLight * mix(1.0, lq / max(lit, 1e-4), uBandMix * uBandOn);
          vec3 tint = mix(uShadeCol, uLitCol, q);
          col *= mix(vec3(1.0), tint / max(dot(tint, pLuma), 1e-4), uTintMix * uBandOn);
          // kit = the body texture's region mask (R trunks, G gloves), or the whole material (named kit / a glove mesh)
          float kit = uKitAll;
          float bootM = 0.0;
          #ifdef USE_MAP
          vec4 km = texture2D(uKitMask, vMapUv);
          kit = max(kit, max(km.r, km.g));
          bootM = km.b;
          #endif
          col = mix(col, vec3(dot(col, pLuma)), uSkinDesat * uDesatOn * (1.0 - kit));
          // cool fresnel rim on the (normal-mapped) grazing edges: separates the figure from the black room
          float fr = pow(1.0 - clamp(dot(normal, geometryViewDir), 0.0, 1.0), uRimPow);
          col += uRimCol * (fr * uRimStr * alb);
          outgoingLight = col;
          if (uMaskDbg > 0.5) outgoingLight = kit > 0.5 ? vec3(1.0, 0.0, 0.0) : (bootM > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0));
        }
        #include <opaque_fragment>`);
  });
}

/**
 * Give a spawned fighter the painted look: patch its materials and add an inverted-hull outline to each skinned mesh
 * (same geometry, same skeleton, pushed out along the skinned normal). The hulls are hidden when the switch is off.
 */
export function paintFighter(model: THREE.Object3D, c: Config): void {
  const skinned: THREE.SkinnedMesh[] = [];
  model.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const glove = /^glove/i.test(m.name);   // a separate glove mesh opts in by name
    const fix = (mt: THREE.Material): THREE.Material => {
      if (!(mt as THREE.MeshStandardMaterial).isMeshStandardMaterial) return mt;
      let mm = mt;
      if (glove && !mt.userData['kitMat']) { mm = mt.clone(); mm.userData['painted'] = false; mm.userData['kitMat'] = true; }   // never share the body's material
      paintFighterMaterial(mm, glove || /^(glove|trunks|trim|boot)$/.test(mm.name) ? 1 : 0);
      return mm;
    };
    m.material = Array.isArray(m.material) ? m.material.map(fix) : fix(m.material);
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(m as THREE.SkinnedMesh);
  });
  for (const m of skinned) {
    const hullMat = outlineMat.clone();
    hullMat.userData['painted'] = true;
    hullMat.onBeforeCompile = shader => {
      shader.uniforms['uOutline'] = paintU.uOutline;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform float uOutline;\nvoid main() {')
        .replace('#include <skinning_vertex>', `#include <skinning_vertex>
          transformed += normalize(objectNormal) * uOutline;`);
    };
    hullMat.customProgramCacheKey = () => 'paintHull';
    hullMat.polygonOffset = true; hullMat.polygonOffsetFactor = 2; hullMat.polygonOffsetUnits = 2;   // pushed back: no dots where the shell meets the body
    const hull = new THREE.SkinnedMesh(m.geometry, hullMat);
    hull.name = `${m.name}_ink`;
    hull.frustumCulled = false;
    hull.castShadow = false; hull.receiveShadow = false;
    hull.visible = c.paintLook && c.paintOutline;
    hull.bind(m.skeleton, m.bindMatrix);
    hull.renderOrder = m.renderOrder;
    m.parent?.add(hull);
    hull.matrixAutoUpdate = m.matrixAutoUpdate;
    hull.position.copy(m.position); hull.quaternion.copy(m.quaternion); hull.scale.copy(m.scale);
    hulls.add(hull);
  }
}

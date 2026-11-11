/**
 * rig/materials.ts — how the fighter is shaded (overhaul 2026-11-11: the flat
 * toon look is retired for skin that reads as skin under a ring light).
 *
 * One material per fighter (its own atlas and damage layer, its own sweat /
 * redden / glow uniforms), all sharing one program. It is a MeshPhongMaterial
 * whose lighting chunk is replaced, so the scene's lights, the shadow map,
 * fog, skinning and morph targets all work as stock. Each vertex carries a
 * material KIND (geo.ts) and the response is chosen per kind:
 *
 *   skin    wrap diffuse; the light the wrap adds past the terminator is
 *           tinted warm red (a cheap subsurface look); a broad sheen and a
 *           tight highlight that both grow with `sweat`, plus sweat beads on
 *           the high tier; `redden` blotches, bruises and cuts from the
 *           damage layer (paint.ts)
 *   cloth   soft wrap, a satin sheen
 *   leather glossy: a tight bright highlight (gloves, boots)
 *   hair    matte with a soft sheen
 *   eye     glossy
 *
 * The view-space rim term is kept (cfg.rimStrength, cfg.rigRimPower), and on
 * top of it the per-fighter warm rim the read uses (FighterView.highlight).
 *
 * Outlines are a second material: an inverted hull (BackSide) that pushes each
 * vertex along its skinned normal by cfg.outlineWidth. Built always, drawn only
 * while cfg.outlines is on. Kept: with smooth normals the hull is cleaner than
 * it was on the faceted figure.
 */
import * as THREE from 'three';
import type { Config } from '../core';

const shared = {
  uRimStrength: { value: 0.6 },
  uRimPower: { value: 3 },
  uRimColor: { value: new THREE.Color(0xffffff) },
  uScatter: { value: 0.6 },
  uScatterColor: { value: new THREE.Color(0xff5a3c) },
  uSkinWrap: { value: 0.45 },
  uSkinSheen: { value: 0.07 },
  uSweatSheen: { value: 0.3 },
  uSweatGloss: { value: 0.9 },
  uLeatherGloss: { value: 0.7 },
  uClothSheen: { value: 0.1 },
};

export interface RigUniforms {
  uGlow: { value: number };
  uGlowColor: { value: THREE.Color };
  uSweat: { value: number };
  /** x = head, y = body. */
  uRedden: { value: THREE.Vector3 };
  uDamage: { value: THREE.Texture | null };
}

export interface RigMaterial {
  material: THREE.MeshPhongMaterial;
  uniforms: RigUniforms;
  dispose(): void;
}

const VERT_PARS = `
attribute float aKind;
varying float vKind;
`;

const FRAG_PARS = `
varying float vKind;
uniform float uRimStrength;
uniform float uRimPower;
uniform vec3 uRimColor;
uniform float uGlow;
uniform vec3 uGlowColor;
uniform float uSweat;
uniform vec3 uRedden;
uniform sampler2D uDamage;
uniform float uScatter;
uniform vec3 uScatterColor;
uniform float uSkinWrap;
uniform float uSkinSheen;
uniform float uSweatSheen;
uniform float uSweatGloss;
uniform float uLeatherGloss;
uniform float uClothSheen;
float gWrap;
vec3 gScatter;
float gSheen;
float gGloss;
float gGlossPow;
float gRim;
float rigHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float rigNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rigHash( i ), rigHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( rigHash( i + vec2( 0.0, 1.0 ) ), rigHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
`;

// Replaces <lights_phong_pars_fragment>: same struct and hooks, our response.
const LIGHT_PARS = `
varying vec3 vViewPosition;
struct BlinnPhongMaterial {
  vec3 diffuseColor;
  vec3 specularColor;
  float specularShininess;
  float specularStrength;
};
void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
  float ndl = dot( geometryNormal, directLight.direction );
  float hard = saturate( ndl );
  float wrapped = saturate( ( ndl + gWrap ) / ( 1.0 + gWrap ) );
  // What the wrap adds past the terminator is light that came through the skin: tint it.
  vec3 irradiance = directLight.color * ( hard + ( wrapped - hard ) * mix( vec3( 1.0 ), gScatter, step( 0.001, dot( gScatter, vec3( 1.0 ) ) ) ) );
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
  vec3 halfDir = normalize( directLight.direction + geometryViewDir );
  float ndh = saturate( dot( geometryNormal, halfDir ) );
  float spec = gSheen * pow( ndh, 10.0 ) + gGloss * pow( ndh, gGlossPow );
  reflectedLight.directSpecular += directLight.color * wrapped * spec * material.specularColor;
}
void RE_IndirectDiffuse_BlinnPhong( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_BlinnPhong
#define RE_IndirectDiffuse RE_IndirectDiffuse_BlinnPhong
`;

// Replaces <lights_phong_fragment>: pick the response for this fragment's kind.
const LIGHT_SETUP = `
BlinnPhongMaterial material;
float kSkin = 1.0 - step( 1.5, vKind );
float kFace = kSkin * step( 0.5, vKind );
float kCloth = step( 1.5, vKind ) * ( 1.0 - step( 2.5, vKind ) );
float kLeather = step( 2.5, vKind ) * ( 1.0 - step( 3.5, vKind ) );
float kHair = step( 3.5, vKind ) * ( 1.0 - step( 4.5, vKind ) );
float kEye = step( 4.5, vKind ) * ( 1.0 - step( 5.5, vKind ) );
vec3 albedo = diffuseColor.rgb;
float sweat = uSweat * kSkin;
#ifdef USE_MAP
  vec3 dmg = texture2D( uDamage, vMapUv ).rgb;
  // Reddening: blotchy, strongest where the damage layer says the skin marks.
  float blotch = 0.55 + 0.45 * rigNoise( vMapUv * 90.0 );
  // uRedden = (head, the torso's right side, its left). The torso is the atlas's top-left block (atlas.ts) and its
  // u runs from the fighter's right (0) round the front to his left, so the liver side can be redder than the other.
  float inTorso = step( vMapUv.x, 0.5 ) * step( 0.594, vMapUv.y );
  float onRight = 1.0 - smoothstep( 0.19, 0.31, vMapUv.x );
  float bodyRed = mix( 0.5 * ( uRedden.y + uRedden.z ), mix( uRedden.z, uRedden.y, onRight ), inTorso );
  float red = kSkin * saturate( mix( bodyRed, uRedden.x, kFace ) * ( 0.35 + 0.65 * dmg.r ) * blotch );
  albedo = mix( albedo, albedo * vec3( 1.22, 0.52, 0.5 ) + vec3( 0.05, 0.0, 0.0 ), red * 0.8 );
  // Bruise / swelling: purple-red, darker.
  albedo = mix( albedo, albedo * vec3( 0.62, 0.3, 0.45 ) + vec3( 0.05, 0.0, 0.02 ), kSkin * saturate( dmg.g ) * 0.85 );
  // Cut: dark wet red.
  float cut = kSkin * saturate( dmg.b );
  albedo = mix( albedo, vec3( 0.32, 0.015, 0.02 ), cut );
#else
  float cut = 0.0;
#endif
// Wet skin is a little darker and richer.
albedo *= 1.0 - 0.1 * sweat;
material.diffuseColor = albedo;
material.specularColor = vec3( 1.0 );
material.specularShininess = 30.0;
material.specularStrength = 1.0;
gWrap = kSkin * uSkinWrap + kCloth * 0.3 + kLeather * 0.12 + kHair * 0.4 + kEye * 0.2;
gScatter = kSkin * mix( vec3( 1.0 ), uScatterColor, uScatter );
gSheen = kSkin * ( uSkinSheen + uSweatSheen * sweat ) + kCloth * uClothSheen + kLeather * 0.22 + kHair * 0.05;
gGloss = kSkin * uSweatGloss * sweat * 0.35 + kLeather * uLeatherGloss + kEye * 1.2 + cut * 0.8;
gGlossPow = mix( 70.0, 48.0, kLeather );
gRim = kSkin * 0.55 + kCloth * 0.7 + kLeather * 1.0 + kHair * 0.25 + kEye * 0.2;
#ifdef RIG_HIGH
  #ifdef USE_MAP
    // Sweat beads: sparse bright points that only show once the fighter is wet.
    float bead = step( 0.965, rigHash( floor( vMapUv * 1400.0 ) ) ) * smoothstep( 0.35, 1.0, uSweat ) * kSkin;
    gGloss += bead * 3.0 * uSweatGloss;
  #endif
#endif
`;

const RIM_GLSL = `
{
  float rimF = pow( 1.0 - saturate( dot( normalize( normal ), normalize( vViewPosition ) ) ), uRimPower );
  // The rim is tinted by the surface (skin catches a skin-coloured edge, not a white one); the read's glow stays additive.
  outgoingLight += uRimColor * mix( albedo * 1.6, vec3( 1.0 ), 0.12 ) * ( rimF * uRimStrength * gRim * ( 1.0 + 0.6 * sweat ) ) + uGlowColor * ( rimF * uGlow );
}
#include <opaque_fragment>`;

export function createRigMaterial(cfg: Config): RigMaterial {
  const high = cfg.rigQuality >= 0.5;
  const material = new THREE.MeshPhongMaterial({ color: 0xffffff, vertexColors: true });
  const uniforms: RigUniforms = {
    uGlow: { value: 0 }, uGlowColor: { value: new THREE.Color(0xffb070) },
    uSweat: { value: 0 }, uRedden: { value: new THREE.Vector3(0, 0, 0) }, uDamage: { value: null },
  };
  if (high) material.defines = { RIG_HIGH: '' };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, shared, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvKind = aKind;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <lights_phong_pars_fragment>', LIGHT_PARS)
      .replace('#include <lights_phong_fragment>', LIGHT_SETUP)
      .replace('#include <opaque_fragment>', RIM_GLSL);
  };
  material.customProgramCacheKey = () => (high ? 'rigSkinHigh' : 'rigSkinLow');
  return { material, uniforms, dispose: () => material.dispose() };
}

/** Set this material's warm rim (the read) for the next draw. */
export function setGlow(m: RigMaterial, strength: number, colorHex: string): void {
  m.uniforms.uGlow.value = strength;
  if (m.uniforms.uGlowColor.value.getHexString() !== colorHex.replace('#', '').toLowerCase()) m.uniforms.uGlowColor.value.set(colorHex);
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

/** Push live config into the shared uniforms. Cheap; call once per frame per view. */
export function updateMaterials(cfg: Config): void {
  shared.uRimStrength.value = cfg.rimStrength;
  shared.uRimPower.value = cfg.rigRimPower;
  shared.uScatter.value = cfg.rigSkinScatter;
  if (shared.uScatterColor.value.getHexString() !== cfg.rigSkinScatterColor.replace('#', '').toLowerCase()) shared.uScatterColor.value.set(cfg.rigSkinScatterColor);
  shared.uSkinWrap.value = cfg.rigSkinWrap;
  shared.uSkinSheen.value = cfg.rigSkinSheen;
  shared.uSweatSheen.value = cfg.rigSweatSheen;
  shared.uSweatGloss.value = cfg.rigSweatGloss;
  shared.uLeatherGloss.value = cfg.rigLeatherGloss;
  shared.uClothSheen.value = cfg.rigClothSheen;
  if (outline) {
    outlineUniforms.uOutlineWidth.value = cfg.outlineWidth;
    if (outlineColorKey !== cfg.rigOutlineColor) { outlineColorKey = cfg.rigOutlineColor; outline.color.set(cfg.rigOutlineColor); }
  }
}

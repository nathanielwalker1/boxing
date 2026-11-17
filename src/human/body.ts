/**
 * Shared loader for the realistic boxer (public/fighter/boxer.glb). One place for runtime material setup.
 *
 *   const assets = await loadBoxer();                       // once: glb + skin_dark.webp + skin_normal.webp
 *   const v2 = await loadBoxer('/fighter/', 'boxer_v2.glb'); // the art-pass build (kit detail textures)
 *   const root = assets.spawn('dark', KIT_RED);             // per fighter: skinned clone, own materials
 *   // root is the glb scene (Armature + Body/Trunks/Boots/Gloves/Hair/Eyes/...); native size ~1.76 m, faces +Z.
 *   // Bones are named 'mixamorigHips' etc. (GLTFLoader strips the colon). Scale/position the parent Group.
 *
 * spawn(tone, kit): tone 'light' | 'dark' picks the skin diffuse; kit sets glove/trunks/trim/boot/hair colours
 * (CSS strings). A glb whose asset.extras.look >= 2 (built by tools/blender/build.mjs with a name argument) also
 * gets the generated kit textures (<name><suffix>.webp next to it): leather albedo / normal / roughness for gloves
 * and boots, satin folds for the trunks, a sweat mask for the skin. Their albedo is a neutral grey that multiplies
 * the kit colour, so every fighter stays tintable.
 *
 * addFighterLights(scene) adds the light the fighters need on top of the arena rig (a warm key from the camera's
 * side and two cool rim lights behind them); call its update(camera, focus) every frame.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

export type SkinTone = 'light' | 'dark';
export interface KitColors { glove: string; trunks: string; trim: string; boot: string; hair: string }

export interface BoxerAssets {
  spawn(tone: SkinTone, kit: KitColors): THREE.Object3D;
}

/** Tunables of the runtime look (kept here, not in sim config: this module is render-only). */
const LOOK = {
  skinRoughness: 0.58,
  normalScale: 0.9,
  clearcoat: 0.22,          // sweat sheen (v1: uniform)
  clearcoatRoughness: 0.32,
  // look 2
  skinIor: 1.4,             // skin F0 ~0.028, specular stays white
  skinNormalScale: 0.5,     // pores read as fabric weave above this at play distance
  sweatClearcoat: 0.35,     // clearcoat strength where the sweat mask is 1 (shoulders, chest, forehead, nose)
  sweatClearcoatRoughness: 0.24,
  darkSweatBoost: 1.3,      // sweat highlights read stronger on the dark tone
  leatherNormal: 1.0,
  leatherClearcoat: 0.12,   // satin top coat on the gloves / boots
  leatherClearcoatRoughness: 0.38,
  trunksRoughness: 0.4,     // satin
  trunksSheen: 0.8,
  trunksSheenRoughness: 0.35,
  trimRoughness: 0.8,       // ribbed elastic, piping, heel panel: matte
  eyeTint: '#5a4840',       // dark warm sclera: the eyes read as dark shapes with a small highlight
  eyeRoughness: 0.06,       // wet cornea highlight
};

const KIT_TEX = ['glove_c', 'glove_n', 'glove_r', 'trunks_c', 'trunks_n', 'boot_c', 'boot_n', 'boot_r', 'skin_rough'] as const;
type KitTex = Record<(typeof KIT_TEX)[number], THREE.Texture>;

export async function loadBoxer(base = '/fighter/', file = 'boxer.glb'): Promise<BoxerAssets> {
  const tl = new THREE.TextureLoader();
  const gltf = await new GLTFLoader().loadAsync(base + file);
  const extras = (gltf.asset as { extras?: { look?: number; suffix?: string } }).extras ?? {};
  const look = extras.look ?? 1;
  const sfx = look >= 2 ? extras.suffix ?? '' : '';
  const prep = (t: THREE.Texture, srgb: boolean): THREE.Texture => {
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const [dark, normal] = await Promise.all([
    tl.loadAsync(`${base}skin_dark${sfx}.webp`),
    tl.loadAsync(`${base}skin_normal${sfx}.webp`),
  ]);
  prep(dark, true);
  prep(normal, false);
  let kt: KitTex | null = null;
  if (look >= 2) {
    const loaded = await Promise.all(KIT_TEX.map(n => tl.loadAsync(`${base}${n}${sfx}.webp`)));
    kt = Object.fromEntries(KIT_TEX.map((n, i) => [n, prep(loaded[i]!, n.endsWith('_c'))])) as KitTex;
  }

  return {
    spawn(tone, kit) {
      const root = cloneSkinned(gltf.scene) as THREE.Object3D;
      root.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        const src = m.material as THREE.MeshStandardMaterial;
        const k = kit[src.name as keyof KitColors];
        if (src.name === 'skin') {
          m.material = kt ? skinV2(src, tone, dark, normal, kt) : new THREE.MeshPhysicalMaterial({
            name: 'skin',
            map: tone === 'dark' ? dark : src.map,
            normalMap: normal,
            normalScale: new THREE.Vector2(LOOK.normalScale, LOOK.normalScale),
            roughness: LOOK.skinRoughness,
            metalness: 0,
            clearcoat: LOOK.clearcoat,
            clearcoatRoughness: LOOK.clearcoatRoughness,
          });
          return;
        }
        if (kt && src.name === 'hair') {
          // look 2: the cap's border is triangle-jagged; the painted stubble's soft fade is the hairline instead
          m.visible = false;
          return;
        }
        if (kt) {
          const v2 = kitV2(src, kt);
          if (v2) {
            if (k) v2.color.set(k);
            m.material = v2;
            return;
          }
        }
        const own = src.clone();
        m.material = own;
        if (k) own.color.set(k);
      });
      return root;
    },
  };
}

function skinV2(src: THREE.MeshStandardMaterial, tone: SkinTone, dark: THREE.Texture, normal: THREE.Texture,
  kt: KitTex): THREE.MeshPhysicalMaterial {
  const boost = tone === 'dark' ? LOOK.darkSweatBoost : 1;
  return new THREE.MeshPhysicalMaterial({
    name: 'skin',
    map: tone === 'dark' ? dark : src.map,
    normalMap: normal,
    normalScale: new THREE.Vector2(LOOK.skinNormalScale, LOOK.skinNormalScale),
    roughness: 1,
    roughnessMap: kt.skin_rough,          // G channel
    metalness: 0,
    ior: LOOK.skinIor,
    specularColor: new THREE.Color(1, 1, 1),
    clearcoat: Math.min(1, LOOK.sweatClearcoat * boost),
    clearcoatMap: kt.skin_rough,          // R channel = sweat mask
    clearcoatRoughness: LOOK.sweatClearcoatRoughness,
  });
}

/** The look-2 material for a kit / eye part, or null to keep the glb's own (cloned). */
function kitV2(src: THREE.MeshStandardMaterial, kt: KitTex): THREE.MeshPhysicalMaterial | null {
  const leather = (c: THREE.Texture, n: THREE.Texture, r: THREE.Texture) => new THREE.MeshPhysicalMaterial({
    name: src.name, map: c, normalMap: n, normalScale: new THREE.Vector2(LOOK.leatherNormal, LOOK.leatherNormal),
    roughness: 1, roughnessMap: r, metalness: 0,
    clearcoat: LOOK.leatherClearcoat, clearcoatRoughness: LOOK.leatherClearcoatRoughness,
    side: THREE.DoubleSide,   // mirrored (right-hand) pieces are wound the other way; cuff and boot openings show inside
  });
  switch (src.name) {
    case 'glove': return leather(kt.glove_c, kt.glove_n, kt.glove_r);
    case 'boot': return leather(kt.boot_c, kt.boot_n, kt.boot_r);
    case 'trunks': return new THREE.MeshPhysicalMaterial({
      name: 'trunks', map: kt.trunks_c, normalMap: kt.trunks_n, roughness: LOOK.trunksRoughness, metalness: 0,
      sheen: LOOK.trunksSheen, sheenRoughness: LOOK.trunksSheenRoughness, sheenColor: new THREE.Color(0.75, 0.75, 0.75),
      side: THREE.DoubleSide,
    });
    case 'trim': return new THREE.MeshPhysicalMaterial({
      name: 'trim', roughness: LOOK.trimRoughness, metalness: 0, sheen: 0.3, sheenRoughness: 0.6, side: THREE.DoubleSide,
    });
    case 'eye': {
      const e = new THREE.MeshPhysicalMaterial({ name: 'eye', map: src.map, roughness: LOOK.eyeRoughness, metalness: 0 });
      e.color.set(LOOK.eyeTint);
      return e;
    }
    default: return null;
  }
}

export interface FighterLights {
  /** Re-aim the lights from the current camera at the fighters' midpoint (world). Call once per frame. */
  update(camera: THREE.Camera, focus: THREE.Vector3): void;
  readonly lights: THREE.Object3D[];
}

/** Tunables of the fighter lights (render-only). Key:fill ~3:1 with the arena fill; rim ~1.7x the key. */
const LIGHTS = {
  keyColor: '#ffd8b4', keyIntensity: 1.2, keySideDeg: 40, keyUpDeg: 35,
  rimColor: '#d6e4ff', rimIntensity: 2.6, rimSideDeg: 60, rimUpDeg: 28,
};

/**
 * Lights that belong to the fighters rather than the arena: a warm key from 40 degrees off the camera and a little
 * above, and two hot, slightly cool rim lights from behind-left / behind-right of the pair (relative to the camera)
 * that separate shoulders, arms and gloves from a dark background. No shadows (the arena key casts them).
 */
export function addFighterLights(scene: THREE.Scene): FighterLights {
  const key = new THREE.DirectionalLight(new THREE.Color(LIGHTS.keyColor), LIGHTS.keyIntensity);
  const rimL = new THREE.DirectionalLight(new THREE.Color(LIGHTS.rimColor), LIGHTS.rimIntensity);
  const rimR = new THREE.DirectionalLight(new THREE.Color(LIGHTS.rimColor), LIGHTS.rimIntensity);
  const all = [key, rimL, rimR];
  for (const l of all) scene.add(l, l.target);
  const d = new THREE.Vector3();
  const place = (l: THREE.DirectionalLight, focus: THREE.Vector3, az: number, upDeg: number) => {
    const up = (upDeg * Math.PI) / 180;
    const c = Math.cos(az), s = Math.sin(az);
    const x = d.x * c - d.z * s, z = d.x * s + d.z * c;
    l.position.set(focus.x + x * 5 * Math.cos(up), focus.y + 5 * Math.sin(up), focus.z + z * 5 * Math.cos(up));
    l.target.position.copy(focus);
  };
  return {
    lights: all,
    update(camera, focus) {
      d.copy(camera.position).sub(focus);
      d.y = 0;
      if (d.lengthSq() < 1e-8) d.set(0, 0, 1);
      d.normalize();
      const deg = Math.PI / 180;
      place(key, focus, LIGHTS.keySideDeg * deg, LIGHTS.keyUpDeg);
      place(rimL, focus, (180 - LIGHTS.rimSideDeg) * deg, LIGHTS.rimUpDeg);
      place(rimR, focus, (180 + LIGHTS.rimSideDeg) * deg, LIGHTS.rimUpDeg);
    },
  };
}

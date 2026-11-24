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
  const extras = (gltf.asset as { extras?: { look?: number; suffix?: string; kind?: string; stem?: string } }).extras ?? {};
  if (extras.kind === 'meshy') return loadMeshy(gltf.scene, base, extras.stem ?? file.replace(/\.glb$/, ''));
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

/** Tunables of the Meshy-built body (render-only). */
const MESHY = {
  metalness: 0,             // the build zeroes the metal map (Meshy's ~0.5 metal on the trunks read as vinyl)
  normalScale: 0.75,        // fine pores at full strength gave hard white streaks on the back
  darkSkin: [88, 56, 40] as const,   // sRGB target mean of the skin for the 'dark' tone (the baked skin's mean maps here)
  gloveGain: 0.85,          // kit glove colour lands at this x the glove's mean shading (keeps the leather deep)
  gloveContrast: 0.75,      // exponent on the glove's shading ratio: crease detail kept, grain not turned to speckle
  gloveRoughness: 0.45,     // the separate glove part (glove_<name>): satin leather, one value (it has no roughness map)
  trunksGain: 0.95,         // kit trunks colour at the trunks' mean shading
  trunksContrast: 1.0,      // the baked folds multiply through the tint unchanged
  kitDesaturate: 0.15,      // kit colours pulled this far towards their own grey: satin, not flat plastic
};

/**
 * A Meshy-built body (tools/blender/build_meshy.py): one skinned mesh, one baked texture set next to the glb:
 * <stem>_c (base colour), _n (normal), _r (G roughness, B metalness), _mask (R trunks, G gloves, B boots),
 * _skin (R skin, G hair). spawn() recolours a copy of the base colour on a canvas, once per tone + kit, keeping the
 * baked shading: trunks and gloves take the kit colour scaled by each texel's luminance over the region's mean
 * (white cloth and red leather both tint cleanly), skin is scaled per channel towards the dark tone. Boots stay.
 */
async function loadMeshy(scene: THREE.Object3D, base: string, stem: string): Promise<BoxerAssets> {
  const tl = new THREE.TextureLoader();
  const il = new THREE.ImageLoader();
  const [cImg, maskImg, skinImg, normal, rm] = await Promise.all([
    il.loadAsync(`${base}${stem}_c.webp`), il.loadAsync(`${base}${stem}_mask.webp`), il.loadAsync(`${base}${stem}_skin.webp`),
    tl.loadAsync(`${base}${stem}_n.webp`), tl.loadAsync(`${base}${stem}_r.webp`),
  ]);
  for (const t of [normal, rm]) { t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; }
  const W = cImg.width, Hh = cImg.height;
  const pixels = (img: HTMLImageElement): Uint8ClampedArray => {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = Hh;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, W, Hh);   // masks are 1024: upscaled (bilinear) to the base colour's size
    return g.getImageData(0, 0, W, Hh).data;
  };
  const src = pixels(cImg), mask = pixels(maskImg), skin = pixels(skinImg);
  // the swappable glove part (build_meshy.py 6b): meshes named glove_*, material named after its texture stem
  // (glove_<name>), textures <stem>_c / _n next to the glb; all of it is glove, so the kit tint needs no mask
  let gloveStem = '';
  scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.name.startsWith('glove') && !gloveStem) gloveStem = (m.material as THREE.Material).name; });
  let gSrc: Uint8ClampedArray | null = null, gNormal: THREE.Texture | null = null, gloveW = 0, gloveH = 0, gMeanY = 1;
  if (gloveStem) {
    const [gImg, gn] = await Promise.all([il.loadAsync(`${base}${gloveStem}_c.webp`), tl.loadAsync(`${base}${gloveStem}_n.webp`)]);
    gn.flipY = false; gn.colorSpace = THREE.NoColorSpace; gn.anisotropy = 8;
    gNormal = gn; gloveW = gImg.width; gloveH = gImg.height;
    const cv = document.createElement('canvas');
    cv.width = gloveW; cv.height = gloveH;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(gImg, 0, 0);
    gSrc = g.getImageData(0, 0, gloveW, gloveH).data;
    let s = 0, n = 0;
    for (let i = 0; i < gSrc.length; i += 4) {
      const y = 0.2126 * gSrc[i]! + 0.7152 * gSrc[i + 1]! + 0.0722 * gSrc[i + 2]!;
      if (y > 2) { s += y; n++; }   // skip the black gutter between UV islands
    }
    gMeanY = n ? s / n : 1;
  }
  // region statistics, mask-weighted: mean luminance of trunks and gloves, mean skin colour
  let tY = 0, tW = 0, gY = 0, gW = 0, sR = 0, sG = 0, sB = 0, sW = 0;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i]!, g = src[i + 1]!, b = src[i + 2]!, y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mt = mask[i]! / 255, mg = mask[i + 1]! / 255, ms = skin[i]! / 255;
    tY += y * mt; tW += mt; gY += y * mg; gW += mg;
    sR += r * ms; sG += g * ms; sB += b * ms; sW += ms;
  }
  tY /= tW || 1; gY /= gW || 1;
  const skinMean = [sR / (sW || 1), sG / (sW || 1), sB / (sW || 1)];
  const cache = new Map<string, THREE.Texture>();
  const rgb = (css: string): [number, number, number] => {
    const h = new THREE.Color(css).getHex(), c = [(h >> 16) & 255, (h >> 8) & 255, h & 255] as const;
    const g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], d = MESHY.kitDesaturate;
    return [c[0] + d * (g - c[0]), c[1] + d * (g - c[1]), c[2] + d * (g - c[2])];
  };
  /** The glove part's material per kit glove colour: every texel tinted, baked shading kept (as the body's gloves). */
  const gloveMats = new Map<string, THREE.MeshStandardMaterial>();
  const gloveMat = (kit: KitColors): THREE.MeshStandardMaterial | null => {
    if (!gSrc || !gNormal) return null;
    const hit = gloveMats.get(kit.glove);
    if (hit) return hit;
    const kg = rgb(kit.glove), out = new Uint8ClampedArray(gSrc);
    for (let i = 0; i < out.length; i += 4) {
      const y = 0.2126 * gSrc[i]! + 0.7152 * gSrc[i + 1]! + 0.0722 * gSrc[i + 2]!;
      const f = Math.pow(y / gMeanY, MESHY.gloveContrast) * MESHY.gloveGain;
      out[i] = kg[0] * f; out[i + 1] = kg[1] * f; out[i + 2] = kg[2] * f;
    }
    const cv = document.createElement('canvas');
    cv.width = gloveW; cv.height = gloveH;
    cv.getContext('2d')!.putImageData(new ImageData(out, gloveW, gloveH), 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    const m = new THREE.MeshStandardMaterial({
      name: 'meshy_glove', map: t, normalMap: gNormal, normalScale: new THREE.Vector2(MESHY.normalScale, MESHY.normalScale),
      roughness: MESHY.gloveRoughness, metalness: 0,
    });
    gloveMats.set(kit.glove, m);
    return m;
  };
  const colourMap = (tone: SkinTone, kit: KitColors): THREE.Texture => {
    const key = `${tone}|${kit.trunks}|${kit.glove}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const out = new Uint8ClampedArray(src);
    const kt = rgb(kit.trunks), kg = rgb(kit.glove);
    const dark = tone === 'dark';
    const sk = MESHY.darkSkin.map((v, k) => v / skinMean[k]!);
    for (let i = 0; i < out.length; i += 4) {
      const r = src[i]!, g = src[i + 1]!, b = src[i + 2]!;
      const mt = mask[i]! / 255, mg = mask[i + 1]! / 255, ms = dark ? skin[i]! / 255 : 0;
      if (mt + mg + ms < 0.004) continue;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let R = r, G = g, B = b;
      if (mt > 0) { const f = Math.pow(y / tY, MESHY.trunksContrast) * MESHY.trunksGain; R += mt * (kt[0] * f - R); G += mt * (kt[1] * f - G); B += mt * (kt[2] * f - B); }
      if (mg > 0) { const f = Math.pow(y / gY, MESHY.gloveContrast) * MESHY.gloveGain; R += mg * (kg[0] * f - R); G += mg * (kg[1] * f - G); B += mg * (kg[2] * f - B); }
      if (ms > 0) { R += ms * (r * sk[0]! - R); G += ms * (g * sk[1]! - G); B += ms * (b * sk[2]! - B); }
      out[i] = R; out[i + 1] = G; out[i + 2] = B;
    }
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = Hh;
    cv.getContext('2d')!.putImageData(new ImageData(out, W, Hh), 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    cache.set(key, t);
    return t;
  };
  return {
    spawn(tone, kit) {
      const root = cloneSkinned(scene) as THREE.Object3D;
      const mat = new THREE.MeshStandardMaterial({
        name: 'meshy', map: colourMap(tone, kit), normalMap: normal,
        normalScale: new THREE.Vector2(MESHY.normalScale, MESHY.normalScale),
        roughness: 1, roughnessMap: rm, metalness: MESHY.metalness, metalnessMap: rm,
        side: THREE.DoubleSide,   // single-shell cloth: the trunks' side slits open in knee lifts and show the inside
      });
      const gmat = gloveMat(kit);
      root.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        m.material = gmat && m.name.startsWith('glove') ? gmat : mat;
      });
      return root;
    },
  };
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

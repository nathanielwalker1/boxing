/**
 * Shared loader for the realistic boxer (public/fighter/boxer.glb). One place for runtime material setup.
 *
 *   const assets = await loadBoxer();                       // once: glb + skin_dark.webp + skin_normal.webp
 *   const root = assets.spawn('dark', KIT_RED);             // per fighter: skinned clone, own materials
 *   // root is the glb scene (Armature + Body/Trunks/Boots/Gloves/Hair/Eyes/...); native size ~1.76 m, faces +Z.
 *   // Bones are named 'mixamorigHips' etc. (GLTFLoader strips the colon). Scale/position the parent Group.
 *
 * spawn(tone, kit): tone 'light' | 'dark' picks the skin diffuse; kit sets glove/trunks/trim/boot/hair colours
 * (CSS strings). Skin gets a normal map, a sheen (clearcoat) for sweat, and a gamma lift already baked in the
 * dark texture at build time (tools/blender/build_boxer.py).
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
  clearcoat: 0.22,          // sweat sheen
  clearcoatRoughness: 0.32,
};

export async function loadBoxer(base = '/fighter/'): Promise<BoxerAssets> {
  const tl = new THREE.TextureLoader();
  const [gltf, dark, normal] = await Promise.all([
    new GLTFLoader().loadAsync(base + 'boxer.glb'),
    tl.loadAsync(base + 'skin_dark.webp'),
    tl.loadAsync(base + 'skin_normal.webp'),
  ]);
  dark.flipY = false;
  dark.colorSpace = THREE.SRGBColorSpace;
  dark.anisotropy = 8;
  normal.flipY = false;
  normal.colorSpace = THREE.NoColorSpace;
  normal.anisotropy = 8;

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
        if (src.name === 'skin') {
          const p = new THREE.MeshPhysicalMaterial({
            name: 'skin',
            map: tone === 'dark' ? dark : src.map,
            normalMap: normal,
            normalScale: new THREE.Vector2(LOOK.normalScale, LOOK.normalScale),
            roughness: LOOK.skinRoughness,
            metalness: 0,
            clearcoat: LOOK.clearcoat,
            clearcoatRoughness: LOOK.clearcoatRoughness,
          });
          m.material = p;
          return;
        }
        const own = src.clone();
        m.material = own;
        const k = kit[own.name as keyof KitColors];
        if (k) own.color.set(k);
      });
      return root;
    },
  };
}

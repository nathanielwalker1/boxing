/**
 * render/util.ts — small helpers shared by the render modules: a seeded RNG
 * that is LOCAL TO RENDER (the sim never touches it — CONTRACT §3), a
 * recursive dispose, and a canvas-texture factory.
 */
import * as THREE from 'three';

/** mulberry32 — good enough for crowd layout; deterministic per seed so
 *  screenshots are comparable run to run. */
export function seededRng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Dispose every geometry, material and texture under `root`, then empty it. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      const std = mat as THREE.MeshStandardMaterial;
      std.map?.dispose();
      std.emissiveMap?.dispose();
      mat.dispose();
    }
  });
  root.clear();
}

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d context unavailable');
  return [c, g];
}

/** Wrap a painted canvas as a colour texture (sRGB, mipmapped, anisotropic). */
export function canvasTexture(c: HTMLCanvasElement, anisotropy = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** Orient a unit-y-axis geometry instance from `a` to `b`; returns the matrix. */
export function segmentMatrix(a: THREE.Vector3, b: THREE.Vector3, radiusScale = 1, out = new THREE.Matrix4()): THREE.Matrix4 {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return out.compose(a.clone().lerp(b, 0.5), q, new THREE.Vector3(radiusScale, len, radiusScale));
}

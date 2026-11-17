// Realistic-boxer body proof (standalone page, human.html). No gameplay code, no sim imports.
// Loads public/fighter/boxer.glb, lights it with the game's rig (values from createConfig), poses two
// boxers into an orthodox guard by setting bone rotations, and offers two cameras (keys 1 and 2).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createConfig } from '../core/config';
import { guard, type KitColors } from './pose';

const c = createConfig();
const app = document.getElementById('app') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;

// ---- renderer + room (same set-up and light rig as render/stage.ts) ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const fog = new THREE.Fog(new THREE.Color(c.fogColor), c.fogNear, c.fogFar);
scene.fog = fog;
scene.background = fog.color;
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);

const key = new THREE.SpotLight(0xffffff, c.keyIntensity, 0, 1, 0.5, 1);
key.color.set(c.keyColor);
key.position.set(0, c.keyHeight, 0);
key.angle = (c.keyAngleDeg * Math.PI) / 180;
key.castShadow = true;
key.shadow.mapSize.setScalar(c.shadowMapSize);
key.shadow.bias = -0.0005;
key.shadow.radius = c.shadowRadius;
key.shadow.camera.near = 1;
key.shadow.camera.far = 20;
key.target.position.set(0, 0, 0);
const fill = new THREE.HemisphereLight(new THREE.Color(c.fillSkyColor), new THREE.Color(c.fillGroundColor), c.fillIntensity);
const rim = new THREE.DirectionalLight(new THREE.Color(c.rimColor), c.rimIntensity);
const S = c.trussSize / 2;
const backA = new THREE.DirectionalLight(new THREE.Color(c.backColorA), c.backIntensity);
const backB = new THREE.DirectionalLight(new THREE.Color(c.backColorB), c.backIntensity);
backA.position.set(S, c.trussHeight, S);
backB.position.set(-S, c.trussHeight, -S);
scene.add(key, key.target, fill, rim, rim.target, backA, backA.target, backB, backB.target);

// plain floor (canvas-ish), receives the key light's shadows
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(6, 64),
  new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.92 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ---- cameras ----
const LOOK = new THREE.Vector3(0, c.camLookY, 0);
function place(az: number, el: number, dist: number, fov: number): void {
  camera.position.set(
    LOOK.x + dist * Math.cos(el) * Math.cos(az),
    LOOK.y + dist * Math.sin(el),
    LOOK.z + dist * Math.cos(el) * Math.sin(az),
  );
  camera.lookAt(LOOK);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  rim.position.set(-Math.cos(az) * 6, 3.5, -Math.sin(az) * 6);
  rim.target.position.copy(LOOK);
}
const deg = Math.PI / 180;
// Play camera = stage.ts's follow camera with the pair clinched on the x axis (closeness 1):
// azimuth = bearing + (90 + camBehindDeg), elevation camElevationDeg, dolly camDistMin, fov camFovMin.
const PRESETS: Record<string, () => void> = {
  '1': () => place((90 + c.camBehindDeg) * deg, c.camElevationDeg * deg, c.camDistMin, c.camFovMin),
  '2': () => place(90 * deg, 4 * deg, 3.4, 30),
};

function resize(): void {
  const w = app.clientWidth || innerWidth, h = app.clientHeight || innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
addEventListener('keydown', e => { PRESETS[e.key]?.(); });

// ---- boxers ----
const KIT: Record<'red' | 'blue', KitColors> = {
  red: { glove: '#c4141c', trunks: '#c4141c', trim: '#f2efe8', boot: '#1a1a1c', hair: '#1c140f' },
  blue: { glove: '#1c4fc4', trunks: '#1c4fc4', trim: '#f2efe8', boot: '#1a1a1c', hair: '#0b0b0c' },
};
const HALF_GAP = 0.425;   // 0.85 m apart, centre to centre
const SCALE = 1.8 / 1.759;   // the game's POSE_REF_HEIGHT over the body's native height

function makeBoxer(src: THREE.Object3D, side: 'red' | 'blue', skinMap: THREE.Texture | null): THREE.Group {
  const root = cloneSkinned(src) as THREE.Object3D;
  const mats = new Map<string, THREE.Material>();
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    const own = (m.material as THREE.Material).clone();
    m.material = own;
    mats.set(own.name, own);
  });
  const k = KIT[side];
  for (const n of ['glove', 'trunks', 'trim', 'boot', 'hair'] as const) {
    (mats.get(n) as THREE.MeshStandardMaterial | undefined)?.color.set(k[n]);
  }
  const skin = mats.get('skin') as THREE.MeshStandardMaterial | undefined;
  if (skin && skinMap) { skin.map = skinMap; skin.needsUpdate = true; }
  const g = new THREE.Group();
  g.add(root);
  g.updateMatrixWorld(true);
  guard(root);   // posed in metres at the body's native size, then scaled as a whole
  g.scale.setScalar(SCALE);
  g.position.set(side === 'red' ? -HALF_GAP : HALF_GAP, 0, 0);
  g.rotation.y = side === 'red' ? Math.PI / 2 : -Math.PI / 2;
  return g;
}

let frames = 0, last = performance.now(), fps = 0;
const loader = new GLTFLoader();
Promise.all([
  loader.loadAsync('/fighter/boxer.glb'),
  new THREE.TextureLoader().loadAsync('/fighter/skin_dark.webp'),
]).then(([gltf, dark]) => {
  dark.flipY = false;
  dark.colorSpace = THREE.SRGBColorSpace;
  dark.anisotropy = 8;
  const a = makeBoxer(gltf.scene, 'red', null);
  const b = makeBoxer(gltf.scene, 'blue', dark);
  scene.add(a, b);
  let tris = 0;
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  });
  (window as unknown as { __human: unknown }).__human = {
    ready: true,
    tris,
    get fps() { return fps; },
    preset: (k: string) => PRESETS[k]?.(),
  };
  console.log('boxer ready, triangles in scene:', Math.round(tris));
}).catch(e => console.error('load failed', e));

resize();
PRESETS['1']();
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - last >= 1000) {
    fps = Math.round((frames * 1000) / (now - last));
    hud.textContent = `1 play camera   2 ringside side-on\n${fps} fps`;
    frames = 0; last = now;
  }
});

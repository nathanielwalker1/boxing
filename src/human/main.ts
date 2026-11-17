// Realistic-boxer body proof (standalone page, human.html). No gameplay code, no sim imports.
// Loads public/fighter/boxer.glb, lights it with the game's rig (values from createConfig), poses two
// boxers into an orthodox guard by setting bone rotations, and offers two cameras (keys 1 and 2).
import * as THREE from 'three';
import { createConfig } from '../core/config';
import { guard, type PoseName } from './pose';
import { loadBoxer, type BoxerAssets, type KitColors } from './body';

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
function place(az: number, el: number, dist: number, fov: number, look?: THREE.Vector3): void {
  LOOK.set(0, c.camLookY, 0);
  if (look) LOOK.copy(look);
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
  // 3: upper-body close-up of the dark boxer (blue, +x side), from his front-left
  '3': () => place(205 * deg, 5 * deg, 1.9, 30, new THREE.Vector3(0.425, 1.3, 0)),
  // 5: the light boxer's head from behind and above (scalp, hairline)
  '5': () => place(190 * deg, 30 * deg, 1.0, 30, new THREE.Vector3(-0.425, 1.65, 0)),
  // 4: lower-body close-up of the light boxer (red): trunks, legs, boots
  '4': () => place(60 * deg, 12 * deg, 2.1, 30, new THREE.Vector3(-0.425, 0.55, 0)),
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

function makeBoxer(assets: BoxerAssets, side: 'red' | 'blue', pose: PoseName): THREE.Group {
  const root = assets.spawn(side === 'red' ? 'light' : 'dark', KIT[side]);
  const g = new THREE.Group();
  g.add(root);
  g.updateMatrixWorld(true);
  guard(root, pose);   // posed in metres at the body's native size, then scaled as a whole
  g.scale.setScalar(SCALE);
  g.position.set(side === 'red' ? -HALF_GAP : HALF_GAP, 0, 0);
  g.rotation.y = side === 'red' ? Math.PI / 2 : -Math.PI / 2;
  return g;
}

let frames = 0, last = performance.now(), fps = 0;
let boxers: THREE.Group[] = [];
function setPose(assets: BoxerAssets, pose: PoseName): void {
  boxers.forEach(b => scene.remove(b));
  boxers = [makeBoxer(assets, 'red', pose), makeBoxer(assets, 'blue', pose)];
  scene.add(...boxers);
}
loadBoxer().then(assets => {
  setPose(assets, (new URLSearchParams(location.search).get('pose') as PoseName) || 'guard');
  let tris = 0;
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry && m !== floor) tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position!.count) / 3;
  });
  (window as unknown as { __human: unknown }).__human = {
    ready: true,
    tris: tris / 2,   // per boxer
    get fps() { return fps; },
    preset: (k: string) => PRESETS[k]?.(),
    pose: (p: PoseName) => setPose(assets, p),
  };
  console.log('boxer ready, triangles per boxer:', Math.round(tris / 2));
}).catch(e => console.error('load failed', e));

resize();
PRESETS['1']!();
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

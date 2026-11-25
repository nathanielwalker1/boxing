// Realistic-boxer body proof (standalone page, human.html). No gameplay code, no sim imports.
// Loads public/fighter/boxer.glb, lights it with the game's rig (values from createConfig), poses two
// boxers into an orthodox guard by setting bone rotations, and offers two cameras (keys 1 and 2).
import * as THREE from 'three';
import { createConfig } from '../core/config';
import { guard, type PoseName } from './pose';
import { loadBoxer, addFighterLights, type BoxerAssets, type KitColors } from './body';
import { decode, makePose, sample, type BakeIndex, type ClipLib, type Roles } from './clip';
import { applyFit, buildFit, type Fit, type Skeleton } from './retarget';

// ?v=2 loads the art-pass build (boxer_v2.glb + _v2 textures) and adds the fighter lights;
// ?v=m1 loads a Meshy-built body (boxer_m1.glb, tools/blender/build_meshy.py; T-pose rest, so it is posed from the
// baked clips: idle by default). ?role=<roles.json key>&f=<frame | contact | impact | settle | mid> poses both
// boxers from that clip at that frame (role2= gives the blue boxer another one). ?tm=agx|neutral|aces tries a tone
// mapping (the game renders without one).
const params = new URLSearchParams(location.search);
const VP = params.get('v') ?? '';
const MESHY = /^m\d+$/.test(VP);
const V2 = VP === '2' || MESHY;
const c = createConfig();
const app = document.getElementById('app') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;

// ---- renderer + room (same set-up and light rig as render/stage.ts) ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const TM: Record<string, THREE.ToneMapping> = { agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping };
renderer.toneMapping = TM[params.get('tm') ?? ''] ?? THREE.NoToneMapping;
app.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const fighterLights = V2 ? addFighterLights(scene) : null;
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
  fighterLights?.update(camera, new THREE.Vector3(0, 1.2, 0));
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
  // 6: the light boxer's gloves, close, from his front-right
  '6': () => place(55 * deg, 8 * deg, 0.85, 30, new THREE.Vector3(-0.17, 1.38, 0)),
  // 7: the dark boxer's face, close, from his front-left
  '7': () => place(200 * deg, 3 * deg, 0.75, 30, new THREE.Vector3(0.40, 1.53, 0)),
  // 8: the light boxer's face, close
  '8': () => place(62 * deg, 2 * deg, 0.8, 30, new THREE.Vector3(-0.40, 1.53, 0)),
  // 9: the light boxer's boots, close
  '9': () => place(50 * deg, 10 * deg, 1.0, 30, new THREE.Vector3(-0.425, 0.12, 0)),
  // b: both boxers' backs / silhouettes from behind the light boxer
  'b': () => place(180 * deg, 6 * deg, 3.6, 30, new THREE.Vector3(0, 1.0, 0)),
  // c: the light (red, -x) boxer close, from his front-right; d: the same from behind-left (back skin, trunks seat)
  'c': () => place(40 * deg, 6 * deg, 1.7, 30, new THREE.Vector3(-HALF_GAP, 1.1, 0)),
  'd': () => place(200 * deg, 8 * deg, 1.7, 30, new THREE.Vector3(-HALF_GAP, 1.1, 0)),
  // e: the light boxer's shoulders and arms, close, from his front-right (deltoids, armpits, elbows)
  'e': () => place(30 * deg, 12 * deg, 1.0, 30, new THREE.Vector3(-HALF_GAP + 0.1, 1.35, 0)),
  // f: the light boxer's hips and knees from the side (trunk hem, crotch)
  'f': () => place(80 * deg, 4 * deg, 1.3, 30, new THREE.Vector3(-HALF_GAP, 0.6, 0)),
  // g: the light boxer on the floor (knockdown settle), from above-front
  'g': () => place(20 * deg, 35 * deg, 2.4, 35, new THREE.Vector3(-HALF_GAP + 0.3, 0.3, 0)),
};

/** Set one face morph (hitWince, jawOpen, cheekL, cheekR) to 1 on every skin mesh, or clear them all (null). */
function setMorph(name: string | null): void {
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.morphTargetDictionary || !m.morphTargetInfluences) return;
    m.morphTargetInfluences.fill(0);
    const i = name ? m.morphTargetDictionary[name] : undefined;
    if (i !== undefined) m.morphTargetInfluences[i] = 1;
  });
}

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
const HALF_GAP = MESHY ? 0.5 : 0.425;   // centre to centre 0.85 m (1.0 m for clip poses: root motion steps in)
const SCALE = MESHY ? 1 : 1.8 / 1.759;   // the game's POSE_REF_HEIGHT over the body's native height (Meshy: built at 1.80)

// ---- clip posing (the proof page's path: sample the baked clip, fit it onto this skeleton at load) ----
interface Clips { lib: ClipLib; index: BakeIndex; roles: Roles }
let clips: Clips | null = null;
async function loadClips(): Promise<Clips> {
  const [index, bin, roles] = await Promise.all([
    fetch('/fighter/clips/index.json').then(r => r.json() as Promise<BakeIndex>),
    fetch('/fighter/clips/clips.bin').then(r => r.arrayBuffer()),
    fetch('/fighter/clips/roles.json').then(r => r.json() as Promise<Roles>),
  ]);
  return { lib: decode(index, bin), index, roles };
}
function skeletonOf(root: THREE.Object3D): { skel: Skeleton; bones: THREE.Bone[] } {
  const bones: THREE.Bone[] = [];
  root.traverse(o => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
  const top = bones.find(b => !(b.parent as THREE.Bone).isBone)!;
  root.updateMatrixWorld(true);
  const rel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(top.parent!.matrixWorld);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  rel.decompose(p, q, s);
  return {
    bones,
    skel: {
      names: bones.map(b => b.name), parents: bones.map(b => bones.indexOf(b.parent as THREE.Bone)),
      restPos: bones.map(b => [b.position.x, b.position.y, b.position.z]),
      restRot: bones.map(b => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]),
      basePos: [p.x, p.y, p.z], baseRot: [q.x, q.y, q.z, q.w],
    },
  };
}
const fits = new WeakMap<THREE.Object3D, { fit: Fit; bones: THREE.Bone[] }>();
/** Pose root from roles[role] at frame f (a number or the role's contact / impact / settle mark, or mid). */
function poseFromClip(root: THREE.Object3D, role: string, f: string): string {
  const C = clips!;
  const r = C.roles[role];
  if (!r) throw new Error(`no clip for role ${role}`);
  let fb = fits.get(root);
  if (!fb) {
    const { skel, bones } = skeletonOf(root);
    fb = { fit: buildFit(C.index.source, C.index.bones, C.index.parents, skel), bones };
    fits.set(root, fb);
  }
  const clip = C.lib.clips.get(r.slug)!;
  const marks = r as unknown as Record<string, number | undefined>;
  const frame = /^\d+(\.\d+)?$/.test(f) ? Number(f) : f === 'mid' ? (r.from + r.to) / 2 : marks[f] ?? r.from;
  const pose = makePose(C.index.bones.length);
  sample(C.lib, clip, frame / clip.fps, { root: 'full', loop: false }, pose);
  const out = applyFit(fb.fit, pose);
  fb.bones.forEach((b, i) => { const q = out.localRot[i]!; b.quaternion.set(q[0], q[1], q[2], q[3]); });
  fb.bones.find(b => /Hips$/.test(b.name))!.position.set(out.hipsPos[0], out.hipsPos[1], out.hipsPos[2]);
  return `${role} (${r.slug}) frame ${frame}`;
}

type ClipPose = { role: string; f: string; role2?: string | undefined; f2?: string | undefined };
function makeBoxer(assets: BoxerAssets, side: 'red' | 'blue', pose: PoseName, cp: ClipPose | null): THREE.Group {
  // ?trunks=t2 (red) and ?trunks2=t3 (blue): which trunks part each wears (Meshy bodies; default the body's first)
  const trunksStyle = params.get(side === 'red' ? 'trunks' : 'trunks2') ?? params.get('trunks');
  const hairStyle = params.get(side === 'red' ? 'hair' : 'hair2');   // ?hair=h1 / ?hair2=h1: the hair part; none = bald
  const root = assets.spawn(side === 'red' ? 'light' : 'dark', { ...KIT[side], ...(trunksStyle ? { trunksStyle } : {}), ...(hairStyle ? { hairStyle } : {}) });
  const g = new THREE.Group();
  g.add(root);
  g.updateMatrixWorld(true);
  if (cp) {
    const what = side === 'red' ? poseFromClip(root, cp.role, cp.f) : poseFromClip(root, cp.role2 ?? cp.role, cp.f2 ?? cp.f);
    console.log(`${side}: ${what}`);
  } else guard(root, pose);   // posed in metres at the body's native size, then scaled as a whole
  g.scale.setScalar(SCALE);
  g.position.set(side === 'red' ? -HALF_GAP : HALF_GAP, 0, 0);
  g.rotation.y = side === 'red' ? Math.PI / 2 : -Math.PI / 2;
  return g;
}

let frames = 0, last = performance.now(), fps = 0;
let boxers: THREE.Group[] = [];
function setPose(assets: BoxerAssets, pose: PoseName, cp: ClipPose | null = null): void {
  boxers.forEach(b => scene.remove(b));
  boxers = [makeBoxer(assets, 'red', pose, cp), makeBoxer(assets, 'blue', pose, cp)];
  scene.add(...boxers);
}
const urlClip = (): ClipPose | null => {
  const role = params.get('role') ?? (MESHY ? 'idle' : null);
  if (!role) return null;
  return { role, f: params.get('f') ?? '0', role2: params.get('role2') ?? undefined, f2: params.get('f2') ?? undefined };
};
Promise.all([
  MESHY ? loadBoxer('/fighter/', `boxer_${VP}.glb`) : V2 ? loadBoxer('/fighter/', 'boxer_v2.glb') : loadBoxer(),
  urlClip() ? loadClips() : Promise.resolve(null),
]).then(([assets, cl]) => {
  clips = cl;
  setPose(assets, (params.get('pose') as PoseName) || 'guard', urlClip());
  setMorph(params.get('morph'));
  let morphNames: string[] = [];
  scene.traverse(o => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.morphTargetDictionary && !morphNames.length) morphNames = Object.keys(m.morphTargetDictionary);
  });
  console.log('face morphs:', morphNames.join(', ') || 'none');
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
    /** Pose both boxers from a clip (role, frame), optionally the blue one from another (role2, f2). */
    clip: async (role: string, f: string, role2?: string, f2?: string) => {
      clips ??= await loadClips();
      setPose(assets, 'guard', { role, f, role2, f2 });
    },
    morph: (n: string | null) => setMorph(n),
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

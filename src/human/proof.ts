// Mocap proof (proof.html): two real bodies playing the baked Mixamo clips raw, through the load-time fit
// (clip.ts + retarget.ts). A scripted, looping exchange, then the same with B punching on MIRRORED clips.
// Keys: 1 play camera, 2 side-on, space pause, , . step a frame, R root motion. Dropdown: any clip on A.
// URL: ?cam=1|2&t=<seconds>&clip=<slug>&root=0. window.__proofSeek(s) renders exactly time s.
import * as THREE from 'three';
import { createConfig } from '../core/config';
import { loadBoxer, type KitColors } from './body';
import { crossfade, decode, makePose, sample, type Clip, type ClipLib, type Pose, type Roles, type BakeIndex } from './clip';
import { applyFit, buildFit, type Fit, type Skeleton } from './retarget';

const c = createConfig();
const app = document.getElementById('app') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;
const labelEl = document.getElementById('label') as HTMLElement;
const pick = document.getElementById('pick') as HTMLSelectElement;
const params = new URLSearchParams(location.search);

// ---- renderer + room: the same light rig as human.html / render/stage.ts ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
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
const fill = new THREE.HemisphereLight(new THREE.Color(c.fillSkyColor), new THREE.Color(c.fillGroundColor), c.fillIntensity);
const rim = new THREE.DirectionalLight(new THREE.Color(c.rimColor), c.rimIntensity);
const S = c.trussSize / 2;
const backA = new THREE.DirectionalLight(new THREE.Color(c.backColorA), c.backIntensity);
const backB = new THREE.DirectionalLight(new THREE.Color(c.backColorB), c.backIntensity);
backA.position.set(S, c.trussHeight, S);
backB.position.set(-S, c.trussHeight, -S);
scene.add(key, key.target, fill, rim, rim.target, backA, backA.target, backB, backB.target);
const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0x8a8478, roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// ---- cameras ----
const deg = Math.PI / 180;
let gap = 1.0;   // centre-to-centre distance, set once the clips are fitted
let camKey = params.get('cam') === '2' ? '2' : '1';
function place(az: number, el: number, dist: number, fov: number, lookY: number): void {
  const look = new THREE.Vector3(0, lookY, 0);
  camera.position.set(dist * Math.cos(el) * Math.cos(az), lookY + dist * Math.sin(el), dist * Math.cos(el) * Math.sin(az));
  camera.lookAt(look);
  camera.fov = fov;
  camera.updateProjectionMatrix();
  rim.position.set(-Math.cos(az) * 6, 3.5, -Math.sin(az) * 6);
  rim.target.position.copy(look);
}
function setCamera(k: string): void {
  camKey = k;
  if (k === '1') {
    // the game's follow camera (render/stage.ts frame(); closeness as main.ts computes it), A = player at -x
    const closeness = 1 - Math.min(1, Math.max(0, (gap - 0.6) / 3.0));
    const dist = c.camDistMax + (c.camDistMin - c.camDistMax) * closeness;
    const fov = c.camFovMax + (c.camFovMin - c.camFovMax) * closeness;
    place(Math.atan2(0, 1) + (90 + c.camBehindDeg) * deg, c.camElevationDeg * deg, dist, fov, c.camLookY);
  } else place(90 * deg, 4 * deg, 3.4, 30, 1.0);
}
function resize(): void {
  const w = app.clientWidth || innerWidth, h = app.clientHeight || innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---- fighters ----
const KIT: Record<'red' | 'blue', KitColors> = {
  red: { glove: '#c4141c', trunks: '#c4141c', trim: '#f2efe8', boot: '#1a1a1c', hair: '#1c140f' },
  blue: { glove: '#1c4fc4', trunks: '#1c4fc4', trim: '#f2efe8', boot: '#1a1a1c', hair: '#0b0b0c' },
};
const SCALE = 1.8 / 1.759;   // the game's POSE_REF_HEIGHT over the body's native height (as human.html)

interface Fighter { group: THREE.Group; bones: THREE.Bone[]; fit: Fit; hips: THREE.Bone; side: 1 | -1 }

function skeletonOf(root: THREE.Object3D): { skel: Skeleton; bones: THREE.Bone[] } {
  const bones: THREE.Bone[] = [];
  root.traverse(o => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
  const top = bones.find(b => !(b.parent as THREE.Bone).isBone)!;
  // world transform of the top bone's parent (the Armature node) relative to the glb root
  root.updateMatrixWorld(true);
  const rel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(top.parent!.matrixWorld);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  rel.decompose(p, q, s);
  return {
    bones,
    skel: {
      names: bones.map(b => b.name),
      parents: bones.map(b => bones.indexOf(b.parent as THREE.Bone)),
      restPos: bones.map(b => [b.position.x, b.position.y, b.position.z]),
      restRot: bones.map(b => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]),
      basePos: [p.x, p.y, p.z], baseRot: [q.x, q.y, q.z, q.w],
    },
  };
}

function poseFighter(f: Fighter, pose: Pose): void {
  const out = applyFit(f.fit, pose);
  for (let i = 0; i < f.bones.length; i++) { const r = out.localRot[i]!; f.bones[i]!.quaternion.set(r[0], r[1], r[2], r[3]); }
  f.hips.position.set(out.hipsPos[0], out.hipsPos[1], out.hipsPos[2]);
}

// ---- the script ----
interface Seg { start: number; slug: string; from: number; mirror: boolean; loop: boolean; what: string }
interface Beat { name: string; start: number; end: number; contact: number }
const FADE = 0.1;

function build(lib: ClipLib, roles: Roles): { A: Seg[]; B: Seg[]; beats: Beat[]; total: number; noBlock: boolean } {
  const A: Seg[] = [], B: Seg[] = [], beats: Beat[] = [];
  const idle = roles.idle!.slug;
  const clipOf = (s: string): Clip => lib.clips.get(s)!;
  const idleSeg = (t: number): Seg => ({ start: t, slug: idle, from: 0, mirror: false, loop: true, what: 'idle' });
  let t = 0;
  A.push(idleSeg(0)); B.push(idleSeg(0));
  beats.push({ name: 'idle', start: 0, end: 1.2, contact: 0.6 });
  t = 1.2;
  const exchange = (name: string, puncher: Seg[], taker: Seg[], punchRole: string, takeRole: string, mirror: boolean): void => {
    const p = roles[punchRole];
    if (!p) return;
    const h = p.body && takeRole.startsWith('hit_') ? roles.hit_body ?? null : roles[takeRole];   // a body-level stand-in lands on the body
    const pc = clipOf(p.slug), pFrom = p.from / pc.fps, pDur = (p.to - p.from) / pc.fps;
    const toContact = ((p.contact ?? p.from) - p.from) / pc.fps;
    if (h) {   // a reaction whose mark comes later than the punch's contact starts first: push the beat back
      const hc = clipOf(h.slug);
      t += Math.max(0, ((h.impact ?? h.contact ?? h.from) - h.from) / hc.fps - toContact);
    }
    const contact = t + toContact;
    puncher.push({ start: t, slug: p.slug, from: pFrom, mirror, loop: false, what: punchRole });
    puncher.push({ ...idleSeg(t + pDur), mirror });
    let end = t + pDur;
    if (h) {
      const hc = clipOf(h.slug);
      const mark = (h.impact ?? h.contact ?? h.from) as number;
      const hStart = contact - (mark - h.from) / hc.fps;
      const hDur = (h.to - h.from) / hc.fps;
      taker.push({ start: hStart, slug: h.slug, from: h.from / hc.fps, mirror, loop: false, what: takeRole });
      taker.push({ ...idleSeg(hStart + hDur), mirror });
      end = Math.max(end, hStart + hDur);
    }
    beats.push({ name, start: t, end, contact });
    t = end + 0.5;
  };
  for (const mirror of [false, true]) {
    const [P, T] = mirror ? [B, A] : [A, B];
    const pre = mirror ? 'mirror_' : '';
    exchange(pre + 'jab', P, T, 'jab', 'hit_head_light', mirror);
    exchange(pre + 'cross', P, T, 'cross', 'hit_head_medium', mirror);
    exchange(pre + 'hook', P, T, 'lead_hook', 'hit_head_heavy', mirror);
    exchange(pre + 'block', T, P, 'jab', 'block', mirror);
  }
  // keep segment lists time-ordered (hit segments can start before the punch segment pushed before them)
  A.sort((a, b) => a.start - b.start); B.sort((a, b) => a.start - b.start);
  return { A, B, beats, total: t + 0.5, noBlock: roles.block === null };
}

function sampleSegs(lib: ClipLib, segs: Seg[], t: number, root: 'full' | 'inPlace', a: Pose, b: Pose): string {
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1]!.start <= t) i++;
  const cur = segs[i]!;
  const at = (s: Seg, out: Pose): void => {
    const clip = lib.clips.get(s.slug)!;
    sample(lib, clip, s.loop ? t : s.from + (t - s.start), { mirror: s.mirror, root, loop: s.loop }, out);
  };
  at(cur, a);
  const prev = segs[i - 1];
  const w = (t - cur.start) / FADE;
  if (prev && w < 1) { at(prev, b); crossfade(b, a, w, a); }
  return `${cur.what}${cur.what === 'idle' ? '' : ' (' + cur.slug + ')'}${cur.mirror ? ' mirrored' : ''}`;
}

// ---- boot ----
async function boot(): Promise<void> {
  const [assets, index, bin, roles] = await Promise.all([
    loadBoxer(),
    fetch('/fighter/clips/index.json').then(r => r.json() as Promise<BakeIndex>),
    fetch('/fighter/clips/clips.bin').then(r => r.arrayBuffer()),
    fetch('/fighter/clips/roles.json').then(r => r.json() as Promise<Roles>),
  ]);
  const lib = decode(index, bin);
  const mk = (tone: 'light' | 'dark', kit: KitColors, side: 1 | -1): Fighter => {
    const root = assets.spawn(tone, kit);
    const { skel, bones } = skeletonOf(root);
    const fit = buildFit(index.source, index.bones, index.parents, skel);
    const g = new THREE.Group();
    g.add(root);
    g.scale.setScalar(SCALE);
    g.rotation.y = side === 1 ? Math.PI / 2 : -Math.PI / 2;   // clips face +Z; A faces +x, B faces -x
    scene.add(g);
    return { group: g, bones, fit, hips: bones.find(b => /Hips$/.test(b.name))!, side };
  };
  const A = mk('light', KIT.red, 1), B = mk('dark', KIT.blue, -1);

  // gap: the jab's glove just reaches the idle head (wrist + 10 cm glove, full root motion)
  const pa = makePose(index.bones.length), pb = makePose(index.bones.length);
  const jab = roles.jab!, jc = lib.clips.get(jab.slug)!;
  sample(lib, jc, (jab.contact ?? 0) / jc.fps, { root: 'full' }, pa);
  poseFighter(A, pa);
  sample(lib, lib.clips.get(roles.idle!.slug)!, 0, { loop: true }, pb);
  poseFighter(B, pb);
  A.group.position.set(0, 0, 0); B.group.position.set(0, 0, 0);
  A.group.rotation.y = 0; B.group.rotation.y = 0;
  scene.updateMatrixWorld(true);
  const hand = A.bones.find(b => /LeftHand$/.test(b.name))!.getWorldPosition(new THREE.Vector3());
  const head = B.bones.find(b => /Head$/.test(b.name))!.getWorldPosition(new THREE.Vector3());
  gap = hand.z + 0.1 + head.z;   // both measured in clip space (+Z forward); B is turned to face A
  A.group.rotation.y = Math.PI / 2; B.group.rotation.y = -Math.PI / 2;
  A.group.position.x = -gap / 2; B.group.position.x = gap / 2;

  const script = build(lib, roles);
  let T = Number(params.get('t') ?? 0), paused = params.has('t'), root: 'full' | 'inPlace' = params.get('root') === '0' ? 'inPlace' : 'full';
  let browse: string | null = params.get('clip');
  const tmpA = makePose(index.bones.length), tmpB = makePose(index.bones.length);
  const pA = makePose(index.bones.length), pB = makePose(index.bones.length);

  pick.add(new Option('scripted sequence', ''));
  for (const ci of index.clips) pick.add(new Option(`${ci.slug} — ${ci.label}`, ci.slug));
  pick.value = browse ?? '';
  pick.onchange = () => { browse = pick.value || null; T = 0; pick.blur(); dirty = true; };

  const render = (): void => {
    let la: string, lb: string;
    if (browse) {
      const clip = lib.clips.get(browse)!;
      sample(lib, clip, T, { root, loop: true }, pA);
      sample(lib, lib.clips.get(roles.idle!.slug)!, T, { loop: true, root }, pB);
      la = `${browse} (${clip.label})  ${(T % clip.duration).toFixed(2)} / ${clip.duration.toFixed(2)} s`; lb = 'idle';
    } else {
      const t = T % script.total;
      la = sampleSegs(lib, script.A, t, root, pA, tmpA);
      lb = sampleSegs(lib, script.B, t, root, pB, tmpB);
      const beat = script.beats.find(b => t >= b.start && t < b.end + 0.5);
      if (beat?.name.endsWith('block') && script.noBlock) la += '  (no block clip yet)';
    }
    poseFighter(A, pA); poseFighter(B, pB);
    labelEl.textContent = `A red: ${la}\nB blue: ${lb}\nt ${(browse ? T : T % script.total).toFixed(2)} s  root ${root}${paused ? '  paused' : ''}`;
    renderer.render(scene, camera);
  };

  addEventListener('keydown', e => {
    dirty = true;
    if (e.key === '1' || e.key === '2') setCamera(e.key);
    else if (e.key === ' ') paused = !paused;
    else if (e.key === ',') { paused = true; T = Math.max(0, T - 1 / 60); }
    else if (e.key === '.') { paused = true; T += 1 / 60; }
    else if (e.key === 'r' || e.key === 'R') root = root === 'full' ? 'inPlace' : 'full';
  });
  setCamera(camKey);

  let frames = 0, last = performance.now(), fps = 0, prev = performance.now(), dirty = true;
  (window as unknown as { __proofSeek: (s: number) => void }).__proofSeek = (s: number) => { paused = true; T = s; render(); };
  (window as unknown as { __proof: unknown }).__proof = {
    ready: true, beats: script.beats, total: script.total, gap, roles,
    get fps() { return fps; },
    camera: (k: string) => { setCamera(k); render(); },
    play: () => { paused = false; },
  };
  hud.textContent = '1 play cam  2 side  space pause  , . step  R root';
  console.log(`proof ready: ${lib.clips.size} clips, gap ${gap.toFixed(2)} m, loop ${script.total.toFixed(1)} s`);
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(1 / 20, (now - prev) / 1000);
    prev = now;
    if (!paused) { T += dt; dirty = true; }
    if (dirty) { render(); dirty = false; }   // paused = no re-render (keeps seeks / screenshots cheap on software GL)
    frames++;
    if (now - last >= 1000) {
      fps = Math.round((frames * 1000) / (now - last));
      hud.textContent = `1 play cam  2 side  space pause  , . step  R root   ${fps} fps`;
      frames = 0; last = now;
    }
  });
}

resize();
setCamera(camKey);
boot().catch(e => console.error('proof failed', e));

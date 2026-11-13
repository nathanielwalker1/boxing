/**
 * mesh_view.mjs — the fighter mesh alone, bind pose or a hand-set extreme pose, on its own canvas (anim Phase 1.2).
 *
 *   PORT=5195 node scripts/mesh_view.mjs <outDir> <id[,id…]> [pose[,pose…]] [view[,view…]]
 *   poses : bind elbow140 overhead across crouch twist45 head60 hookL, and face_calm face_wince face_mouthOpen face_grimace face_slack face_swellL (head close-ups)
 *   views : front 34 side back (default: front side back)
 *   ids   : any roster id, or `referee`
 *
 * Why it exists: the game's rig driver re-poses every bone each frame (and another workstream is rewriting it), so a pose cannot be
 * held through it. This builds the SAME mesh (buildRigMesh) with a plain light, sets the bones' LOCAL rotations directly (the bind is
 * every rotation = identity, limbs hanging down −y, +z the lateral axis: flexion is a rotation about z), moves the half-way helper
 * bones the way the driver does (slerp from identity), and draws one PNG per id × pose × view. It shows the skinning and the shapes,
 * not the game's materials. One capture per state; read them at full size.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { DEV_URL } from './devUrl.js';

const [outArg, idsArg, posesArg, viewsArg] = process.argv.slice(2);
if (!outArg || !idsArg) { console.error('usage: node scripts/mesh_view.mjs <outDir> <id[,id]> [pose[,pose]] [view[,view]]'); process.exit(2); }
const OUT = resolve(outArg);
mkdirSync(OUT, { recursive: true });
const ids = idsArg.split(',');
const POSES = (posesArg ?? 'bind,elbow140,overhead,across,crouch,twist45,head60,hookL').split(',');
const VIEWS = (viewsArg ?? 'front,side,back').split(',');
const AZ = { front: 0, '34': 38, side: 90, back: 180 };
const W = 480, H = 640;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForFunction(() => !!(window.__tick && window.__tick.ready && window.__tick.frames >= 5 && window.__cfg && window.__THREE), null, { timeout: 120_000 });

for (const id of ids) {
  const shots = await page.evaluate(async ({ id, POSES, VIEWS, AZ, W, H }) => {
    const THREE = window.__THREE;
    const core = await import('/src/core/index.ts');
    const meshMod = await import('/src/rig/mesh.ts');
    const cfg = window.__cfg;
    cfg.rigQuality = 1;   // the desktop mesh (headless software GL picks the low tier)
    const spec = id === 'referee' ? core.REFEREE : core.ROSTER.find(f => f.id === id);
    if (!spec) throw new Error(`no fighter ${id}`);
    const body = core.bodyDims(spec, cfg);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
    const rig = meshMod.buildRigMesh(spec, body, cfg, [-1, 1], mat, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }));
    mat.map = rig.atlas.texture;
    rig.outline.visible = false;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(W, H, false);
    renderer.setClearColor(0x9aa0a8);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555560, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 3, 2); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8); fill.position.set(-2, 1, -2); scene.add(fill);
    scene.add(rig.group);
    const B = meshMod.BONE;
    const bones = rig.bones;
    const rest = bones.map(b => ({ p: b.position.clone(), q: b.quaternion.clone() }));
    const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
    const R = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(axis, deg * Math.PI / 180);
    const set = (bone, ...qs) => { const q = new THREE.Quaternion(); for (const x of qs) q.multiply(x); bones[bone].quaternion.copy(q); };
    const I = new THREE.Quaternion();
    const half = (q, t = 0.5) => I.clone().slerp(q, t);
    const arm = (i, upper, fore) => {
      const a = i === 0 ? [B.upperArm0, B.forearm0, B.elbow0, B.shoulder0] : [B.upperArm1, B.forearm1, B.elbow1, B.shoulder1];
      set(a[0], upper); set(a[1], fore ?? I);
      bones[a[2]].quaternion.copy(half(fore ?? I)); bones[a[3]].quaternion.copy(half(upper, cfg.rigShoulderFollow ?? 0.5));
    };
    const leg = (i, thigh, shin) => {
      const a = i === 0 ? [B.thigh0, B.shin0, B.knee0] : [B.thigh1, B.shin1, B.knee1];
      set(a[0], thigh); set(a[1], shin ?? I); bones[a[2]].quaternion.copy(half(shin ?? I));
    };
    const apply = pose => {
      bones.forEach((b, k) => { b.position.copy(rest[k].p); b.quaternion.copy(rest[k].q); });
      if (pose === 'elbow140') { arm(0, R(Z, 40), R(Z, 140)); arm(1, R(Z, 20), R(Z, 100)); }
      if (pose === 'overhead') { arm(0, R(Z, 170)); arm(1, R(Z, 150), R(Z, 20)); }
      // across: the arm swung forward and then in over the chest (rotation about the vertical axis, inward on each side), elbows bent
      if (pose === 'across') { arm(0, R(Y, 70).multiply(R(Z, 70)), R(Z, 100)); arm(1, R(Y, -70).multiply(R(Z, 70)), R(Z, 100)); }
      if (pose === 'crouch') {
        bones[B.hips].position.y -= body.hipY * 0.22;
        leg(0, R(Z, 100), R(Z, -125)); leg(1, R(Z, 80), R(Z, -105));
        set(B.spine, R(Z, 25)); set(B.chest, R(Z, 15));
      }
      if (pose === 'twist45') { set(B.hips, R(Y, 12)); set(B.spine, R(Y, 8)); set(B.spine2, R(Y, 14)); set(B.chest, R(Y, 22)); arm(0, R(Z, 30), R(Z, 90)); arm(1, R(Z, 30), R(Z, 90)); }
      if (pose === 'head60') { set(B.neck, R(Y, 25)); set(B.head, R(Y, 35)); }
      if (pose === 'hookL') { arm(0, R(Y, 0).multiply(R(X, 80)).multiply(R(Z, 10)), R(Z, 95)); arm(1, R(Z, 45), R(Z, 120)); set(B.chest, R(Y, 25)); }
      // face_<morph>: a close-up of the head with that morph target at 1 (face_calm = none).
      const inf = rig.body.morphTargetInfluences; if (inf) inf.fill(0);
      if (pose.startsWith('face_') && inf) { const k = rig.body.morphTargetDictionary?.[pose.slice(5)]; if (k !== undefined) inf[k] = 1; }
      rig.group.updateMatrixWorld(true);
    };
    const hgt = body.heightM;
    const out = [];
    for (const pose of POSES) {
      apply(pose);
      for (const view of VIEWS) {
        const az = AZ[view] * Math.PI / 180;
        const face = pose.startsWith('face_');
        const dist = face ? 1.0 : hgt * 2.0;
        const cam = new THREE.PerspectiveCamera(face ? 24 : 28, W / H, 0.1, 50);
        const ty = face ? body.headY : pose === 'crouch' ? hgt * 0.45 : hgt * 0.52;
        cam.position.set(Math.cos(az) * dist, ty + (face ? 0.02 : 0.15), Math.sin(az) * dist);
        cam.lookAt(0, ty, 0);
        renderer.render(scene, cam);
        out.push({ name: `${id}_${pose}_${view}`, data: canvas.toDataURL('image/png') });
      }
    }
    const tris = rig.triangles;
    scene.remove(rig.group); rig.dispose(); renderer.dispose();
    return { out, tris };
  }, { id, POSES, VIEWS, AZ, W, H });
  for (const s of shots.out) writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(s.data.split(',')[1], 'base64'));
  console.log(`${id}: ${shots.out.length} images, ${shots.tris} triangles (one body mesh) → ${OUT}`);
}
await browser.close();
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
console.log('console clean');

/**
 * fighter.js — the procedural rig, as a real Object3D hierarchy.
 *
 *   root ─┬─ pelvis ─ spine ─ chest ─┬─ clavicleL ─ upperArmL ─ forearmL ─ gloveL
 *         │                          ├─ clavicleR ─ upperArmR ─ forearmR ─ gloveR
 *         │                          └─ neck ─ head
 *         ├─ thighL ─ shinL ─ footL
 *         └─ thighR ─ shinR ─ footR
 *
 * Two structural decisions worth stating, because both are load-bearing:
 *
 * 1. THE LEGS HANG OFF THE ROOT, NOT OFF THE PELVIS. So rotating the pelvis
 *    (hip drive) or bending the spine (slip) physically cannot move the feet.
 *    The "whole rig tips over like a plank" failure mode is unreachable from
 *    here — not fixed, unreachable.
 *
 * 2. NOTHING IN THIS FILE DOES WORLD-SPACE MATH. Every joint is placed by a
 *    local transform on its parent. Where a glove ends up is a consequence of
 *    the chain, never a coordinate someone has to reinterpret at draw time.
 *    That is the whole difference from rig.js, where a rear glove at "-x" is a
 *    number that means depth in one file and screen-left in another.
 *
 * The only world-space read is the ground clamp at the end of pose(), which
 * offsets root.y so the lower foot sits on the mat. That is a ground contact
 * solve, not rig math, and it converges in one step because nothing in the pose
 * depends on root.y.
 */
import * as THREE from 'three';

const JOINTS = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavicleL', 'upperArmL', 'forearmL', 'gloveL',
  'clavicleR', 'upperArmR', 'forearmR', 'gloveR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
];

/** Parent of each joint, for the skeleton overlay and the bind-pose walk. */
export const PARENT = {
  pelvis: 'root', spine: 'pelvis', chest: 'spine', neck: 'chest', head: 'neck',
  clavicleL: 'chest', upperArmL: 'clavicleL', forearmL: 'upperArmL', gloveL: 'forearmL',
  clavicleR: 'chest', upperArmR: 'clavicleR', forearmR: 'upperArmR', gloveR: 'forearmR',
  thighL: 'root', shinL: 'thighL', footL: 'shinL',
  thighR: 'root', shinR: 'thighR', footR: 'shinR',
};

export const JOINT_NAMES = JOINTS;

const hex = s => new THREE.Color(s);

function mat(color) {
  return new THREE.MeshLambertMaterial({ color: hex(color), flatShading: true });
}

/** A capsule running from the joint origin down its local -Y. */
function limbGeo(len, r) {
  return new THREE.CapsuleGeometry(r, Math.max(len - 2 * r, 0.001), 3, 10);
}

/**
 * @param {object} body   config.body
 * @param {object} colors { body, skin, glove }
 */
export function buildFighter(body, colors) {
  const J = {};
  for (const n of JOINTS) { J[n] = new THREE.Object3D(); J[n].name = n; }

  for (const [child, parent] of Object.entries(PARENT)) J[parent].add(J[child]);

  // ── Bind offsets: pure geometry, no stance ────────────────────────────────
  J.pelvis.position.set(0, body.hipY, 0);
  J.spine.position.set(0, body.spineY, 0);
  J.chest.position.set(0, body.chestY, 0);
  J.neck.position.set(0, body.neckY, 0);
  J.head.position.set(0, body.neckLen, 0);

  J.clavicleL.position.set(+body.shoulderX, body.shoulderY, 0);
  J.clavicleR.position.set(-body.shoulderX, body.shoulderY, 0);
  J.forearmL.position.set(0, -body.upperArmLen, 0);
  J.forearmR.position.set(0, -body.upperArmLen, 0);
  J.gloveL.position.set(0, -body.forearmLen, 0);
  J.gloveR.position.set(0, -body.forearmLen, 0);

  J.thighL.position.set(+body.hipX, body.hipY, 0);
  J.thighR.position.set(-body.hipX, body.hipY, 0);
  J.shinL.position.set(0, -body.thighLen, 0);
  J.shinR.position.set(0, -body.thighLen, 0);
  J.footL.position.set(0, -body.shinLen, 0);
  J.footR.position.set(0, -body.shinLen, 0);

  // ── Meshes ────────────────────────────────────────────────────────────────
  const mBody  = mat(colors.body);
  const mSkin  = mat(colors.skin);
  const mGlove = mat(colors.glove);
  const mDark  = mat('#2a2c33');
  const owned  = [mBody, mSkin, mGlove, mDark];

  const add = (joint, geo, material, x, y, z) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    J[joint].add(m);
    return m;
  };

  add('pelvis', new THREE.BoxGeometry(body.waistW, body.waistH, body.waistD), mDark, 0, 0.04, 0);
  add('spine',  new THREE.BoxGeometry(body.waistW * 1.05, 0.22, body.waistD * 1.02), mBody, 0, 0.05, 0);
  add('chest',  new THREE.BoxGeometry(body.chestW, body.chestH, body.chestD), mBody, 0, 0.10, 0);
  add('neck',   new THREE.CylinderGeometry(body.neckR, body.neckR * 1.15, body.neckLen, 8), mSkin, 0, body.neckLen / 2, 0);

  const headMesh = add('head', new THREE.SphereGeometry(body.headR, 12, 9), mSkin, 0, body.headR * 0.92, 0);
  // A brow block so the head's facing is legible from any camera angle — without
  // it a sphere gives the viewer no way to tell which way the fighter is looking.
  add('head', new THREE.BoxGeometry(body.headR * 1.25, body.headR * 0.42, body.headR * 0.5),
      mDark, 0, body.headR * 1.15, body.headR * 0.82);

  for (const s of ['L', 'R']) {
    add(`clavicle${s}`, new THREE.SphereGeometry(body.upperArmR * 1.5, 9, 7), mBody, 0, 0, 0);
    add(`upperArm${s}`, limbGeo(body.upperArmLen, body.upperArmR), mSkin, 0, -body.upperArmLen / 2, 0);
    add(`forearm${s}`,  limbGeo(body.forearmLen, body.forearmR),  mSkin, 0, -body.forearmLen / 2, 0);
    const g = add(`glove${s}`, new THREE.SphereGeometry(body.gloveR, 10, 8), mGlove, 0, 0, 0);
    g.scale.set(0.95, 0.92, 1.12);

    add(`thigh${s}`, limbGeo(body.thighLen, body.thighR), mDark, 0, -body.thighLen / 2, 0);
    add(`shin${s}`,  limbGeo(body.shinLen, body.shinR),  mSkin, 0, -body.shinLen / 2, 0);
  }

  const footGeo = new THREE.BoxGeometry(body.footW, body.footH, body.footLen);
  const footL = add('footL', footGeo, mDark, 0, -body.footH / 2, body.footLen * 0.26);
  const footR = add('footR', footGeo, mDark, 0, -body.footH / 2, body.footLen * 0.26);

  // ── Bind snapshot, taken before any stance is applied ──────────────────────
  const bind = {};
  for (const n of JOINTS) {
    bind[n] = {
      px: J[n].position.x, py: J[n].position.y, pz: J[n].position.z,
      rx: J[n].rotation.x, ry: J[n].rotation.y, rz: J[n].rotation.z,
    };
  }

  const rig = {
    root: J.root,
    joints: J,
    bind,
    body,
    headMesh,
    feet: [
      { mesh: footL, hw: body.footW / 2, hh: body.footH / 2, hd: body.footLen / 2 },
      { mesh: footR, hw: body.footW / 2, hh: body.footH / 2, hd: body.footLen / 2 },
    ],
    /** The torso as two oriented boxes — what assertion (b) tests against. */
    torso: [
      { obj: J.chest,  cy: 0.10, half: new THREE.Vector3(body.chestW / 2, body.chestH / 2, body.chestD / 2) },
      { obj: J.pelvis, cy: 0.04, half: new THREE.Vector3(body.waistW / 2, body.waistH / 2, body.waistD / 2) },
    ],
    dispose() {
      rig.root.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
      for (const m of owned) m.dispose();
    },
  };

  return rig;
}

// ── Pose application ────────────────────────────────────────────────────────
// A pose is a flat dict of 'joint.prop.axis' -> number, added on top of bind.

const PATH_CACHE = new Map();
function parsePath(path) {
  let p = PATH_CACHE.get(path);
  if (!p) {
    const [joint, prop, axis] = path.split('.');
    p = { joint, prop, axis };
    PATH_CACHE.set(path, p);
  }
  return p;
}

/** Reset every joint to its bind transform. Cheap, and it means no pose leaks. */
export function toBind(rig) {
  for (const n of JOINT_NAMES) {
    const b = rig.bind[n];
    const j = rig.joints[n];
    j.position.set(b.px, b.py, b.pz);
    j.rotation.set(b.rx, b.ry, b.rz);
  }
}

/** Add a dict of channel values on top of whatever the joints currently hold. */
export function addDict(rig, dict, scale = 1) {
  if (!dict || scale === 0) return;
  for (const path in dict) {
    const v = dict[path];
    if (!v) continue;
    const { joint, prop, axis } = parsePath(path);
    const j = rig.joints[joint];
    if (!j) continue;
    j[prop][axis] += v * scale;
  }
}

/**
 * Drop the rig so its lower foot rests on y=0.
 *
 * The legs are rooted at a fixed hip height, so bending the knees lifts the feet
 * instead of lowering the hips. This puts them back, which turns a knee bend into
 * a crouch — the thing you actually wanted. Reads world space, writes root.y
 * only, and converges in a single pass because no joint below depends on root.y.
 */
const _v = new THREE.Vector3();
export function groundClamp(rig) {
  rig.root.updateMatrixWorld(true);
  let minY = Infinity;
  for (const f of rig.feet) {
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? f.hw : -f.hw, i & 2 ? f.hh : -f.hh, i & 4 ? f.hd : -f.hd);
      f.mesh.localToWorld(_v);
      if (_v.y < minY) minY = _v.y;
    }
  }
  if (minY !== Infinity) rig.root.position.y -= minY;
  rig.root.updateMatrixWorld(true);
}

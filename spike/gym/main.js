/**
 * main.js — the gym.
 *
 * Per-frame order is deliberate and worth reading once:
 *
 *   toBind -> rest pose -> punch deltas -> slip deltas -> ground clamp
 *
 * Every frame rebuilds the pose from scratch on top of the bind transforms, so
 * no state can leak between frames and every contributor is purely additive.
 * The punch does not need to know the stance is bladed; the slip does not need
 * to know a punch is in flight.
 */
import * as THREE from 'three';
import { config, punchDuration } from './config.js';
import { buildFighter, toBind, addDict, groundClamp } from './fighter.js';
import { PunchPlayer, SlipDriver } from './anim.js';
import { Reaction, testContact } from './dummy.js';
import { GymCamera } from './camera.js';
import { Trail, Skeleton } from './debug.js';
import { buildGui } from './gui.js';

const TRAIL_CAP = 400;

// ── Renderer / scene ────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(config.colors.bg);

const ambient = new THREE.AmbientLight(0xffffff, config.colors.ambient);
const key = new THREE.DirectionalLight(0xffffff, config.colors.keyLight);
key.position.set(2.4, 4.0, 1.8);
scene.add(ambient, key);

const floorMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(config.colors.floor) });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.001;
scene.add(floor);

const grid = new THREE.GridHelper(14, 28, 0x6c7486, 0x474d5c);
grid.position.y = 0.001;
scene.add(grid);

// ── Fighters ────────────────────────────────────────────────────────────────
// carrier = where the fighter stands and which way it faces (world).
// rig.root = animation-owned translation + the ground clamp (local to carrier).
// Splitting them is what lets a punch translate the root FORWARD rather than
// along world +Z, without a single line of manual world-space math.
const pCarrier = new THREE.Group();
const dCarrier = new THREE.Group();
scene.add(pCarrier, dCarrier);

let player = null, dummy = null, skel = null;

function build() {
  if (player) { pCarrier.remove(player.root); player.dispose(); }
  if (dummy)  { dCarrier.remove(dummy.root);  dummy.dispose(); }
  player = buildFighter(config.body, {
    body: config.colors.playerBody, skin: config.colors.playerSkin, glove: config.colors.playerGlove,
  });
  dummy = buildFighter(config.body, {
    body: config.colors.dummyBody, skin: config.colors.dummySkin, glove: config.colors.dummyGlove,
  });
  pCarrier.add(player.root);
  dCarrier.add(dummy.root);
  if (skel) { for (const o of skel.group) scene.remove(o); }
  skel = new Skeleton(scene, player, config.colors.skeleton);
  skel.visible = config.gym.skeleton;
}
build();

dCarrier.position.set(0, 0, config.dummy.z);
dCarrier.rotation.y = Math.PI;                 // faces back down the depth axis

const punch = new PunchPlayer(config.punches);
const slip = new SlipDriver(config.slip);
const reaction = new Reaction(config.dummy);

// ── Camera / overlays ───────────────────────────────────────────────────────
const gymCam = new GymCamera(config.camera, renderer, innerWidth / innerHeight);
const trailL = new Trail(scene, config.colors.trail, TRAIL_CAP);
const trailR = new Trail(scene, '#66d0ff', TRAIL_CAP);

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  pos: new THREE.Vector2(0, 0),
  vel: new THREE.Vector2(0, 0),
  hit: false,                    // one contact per punch
  gloveW: { L: new THREE.Vector3(), R: new THREE.Vector3() },
  glovePrev: { L: new THREE.Vector3(), R: new THREE.Vector3() },
  gloveSpeed: { L: 0, R: 0 },
  gloveVel: { L: new THREE.Vector3(), R: new THREE.Vector3() },
  headRest: new THREE.Vector3(),
  headNow: new THREE.Vector3(),
  stepOnce: 0,
  lastHit: '—',
  faceOverride: null,   // assertion (c) pins the facing so it survives re-posing
};
const keys = Object.create(null);
const pose = Object.create(null);

// ── Posing ──────────────────────────────────────────────────────────────────
function posePlayer() {
  toBind(player);
  pCarrier.position.set(state.pos.x, 0, state.pos.y);
  const dx = dCarrier.position.x - state.pos.x;
  const dz = dCarrier.position.z - state.pos.y;
  pCarrier.rotation.y = state.faceOverride === null ? Math.atan2(dx, dz) : state.faceOverride;

  addDict(player, config.rest);
  addDict(player, punch.evaluate());
  addDict(player, slip.dict, slip.amount);
  groundClamp(player);
}

function poseDummy() {
  toBind(dummy);
  addDict(dummy, config.rest);
  for (const k in pose) delete pose[k];
  addDict(dummy, reaction.writeDict(pose));
  groundClamp(dummy);
}

/**
 * Head world displacement caused by the slip — measured, not declared.
 *
 * There is no second "hurtbox lean" number to fall out of step with the visible
 * one: the head bone is the head, so this reads the same transform the renderer
 * and any future hit test would read. Poses the un-slipped stance, samples, then
 * poses the real one and leaves the rig in that state.
 */
function measureHead() {
  if (slip.amount < 0.0005) { posePlayer(); return 0; }
  const savedA = slip.a;
  slip.a = 0;
  posePlayer();
  player.joints.head.getWorldPosition(state.headRest);
  slip.a = savedA;
  posePlayer();
  player.joints.head.getWorldPosition(state.headNow);
  return state.headNow.distanceTo(state.headRest);
}

// ── Contact ─────────────────────────────────────────────────────────────────
function updateGloves(dtSec) {
  for (const s of ['L', 'R']) {
    state.glovePrev[s].copy(state.gloveW[s]);
    player.joints[`glove${s}`].getWorldPosition(state.gloveW[s]);
    if (dtSec > 0) {
      state.gloveVel[s].subVectors(state.gloveW[s], state.glovePrev[s]).divideScalar(dtSec);
      state.gloveSpeed[s] = state.gloveVel[s].length();
    } else {
      state.gloveVel[s].set(0, 0, 0);
      state.gloveSpeed[s] = 0;
    }
  }
}

function tryContact() {
  if (!punch.active || state.hit) return;
  const arm = config.punches[punch.type].arm;
  const c = testContact(dummy, state.gloveW[arm], config.body.gloveR, config.dummy);
  if (!c) return;
  const speed = state.gloveSpeed[arm];
  if (speed < 0.05) return;                     // scrubbing is not punching
  state.hit = true;
  state.lastHit = `${punch.type} → ${c.level}  ${speed.toFixed(2)} m/s`;
  reaction.apply(dummy, c.point, state.gloveVel[arm].clone().normalize(), speed, c.bias);
}

// ── Input ───────────────────────────────────────────────────────────────────
const PUNCH_KEY = { j: 'jab', k: 'cross', h: 'hook' };
const PRESET_KEY = { 1: 'SIDE', 2: 'THREE_Q', 3: 'OVER', 4: 'FREE' };

function throwPunch(type) {
  if (!punch.start(type)) return;
  state.hit = false;
  config.gym.hold = false;
  if (config.gym.trails) { trailL.clear(); trailR.clear(); }
}

addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (PUNCH_KEY[k]) throwPunch(PUNCH_KEY[k]);
  else if (PRESET_KEY[k]) gymCam.applyPreset(PRESET_KEY[k]);
  else if (k === ' ') { config.gym.paused = !config.gym.paused; e.preventDefault(); }
  else if (k === ',') { state.stepOnce = -1; config.gym.paused = true; }
  else if (k === '.') { state.stepOnce = +1; config.gym.paused = true; }
  else if (k === 'r') resetAll();
  else if (k === 't') config.gym.trails = !config.gym.trails;
  else if (k === 'y') config.gym.skeleton = !config.gym.skeleton;
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

function resetAll() {
  punch.type = null; punch.t = 0;
  slip.a = 0; slip.v = 0; slip.dir = 0; slip.held = false;
  reaction.reset();
  state.pos.set(0, 0); state.vel.set(0, 0);
  state.hit = false; state.lastHit = '—';
  config.gym.hold = false; config.gym.scrub = 0;
  trailL.clear(); trailR.clear();
}

function stepMove(dt) {
  const m = config.move;
  let ix = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  let iz = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }
  state.vel.x += (ix * m.maxSpeed - state.vel.x) * Math.min(1, m.accel * dt);
  state.vel.y += (iz * m.maxSpeed - state.vel.y) * Math.min(1, m.accel * dt);
  if (!ix && !iz) state.vel.multiplyScalar(Math.max(0, 1 - m.friction * dt));
  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
  if (state.pos.length() > m.boundR) state.pos.setLength(m.boundR);
  const gap = Math.hypot(state.pos.x - dCarrier.position.x, state.pos.y - dCarrier.position.z);
  if (gap < 0.55) {
    const nx = (state.pos.x - dCarrier.position.x) / (gap || 1);
    const nz = (state.pos.y - dCarrier.position.z) / (gap || 1);
    state.pos.set(dCarrier.position.x + nx * 0.55, dCarrier.position.z + nz * 0.55);
  }
}

// ── HUD ─────────────────────────────────────────────────────────────────────
const hud = document.getElementById('hud');
let hudAcc = 0;
function updateHud(headDisp) {
  const c = config.camera;
  const arm = punch.active ? config.punches[punch.type].arm : 'L';
  hud.style.display = config.gym.hud ? 'block' : 'none';
  hud.innerHTML = [
    `<b>${config.camera.preset}</b>  az ${c.az.toFixed(0)}°  el ${c.el.toFixed(0)}°  d ${c.dist.toFixed(2)}  fov ${c.fov.toFixed(0)}`,
    `punch <b>${punch.type || '—'}</b>  ${punch.t.toFixed(0)}/${punch.total.toFixed(0)} ms  p ${punch.phase.toFixed(3)}${config.gym.hold ? '  [HELD]' : ''}`,
    `glove ${arm} speed <b>${state.gloveSpeed[arm].toFixed(2)}</b> m/s`,
    `last hit ${state.lastHit}   impulse ${reaction.lastImpulse.toFixed(3)}`,
    `slip ${slip.amount.toFixed(2)}  head displaced <b>${headDisp.toFixed(3)}</b> m`,
    `<span class="k">WASD</span> move  <span class="k">J</span> jab <span class="k">K</span> cross <span class="k">H</span> hook  <span class="k">Q/E</span> slip`,
    `<span class="k">1-4</span> camera  <span class="k">space</span> pause  <span class="k">, .</span> frame  <span class="k">R</span> reset  <span class="k">T</span> trail  <span class="k">Y</span> skeleton`,
  ].join('<br>');
}

// ── GUI ─────────────────────────────────────────────────────────────────────
buildGui(config, {
  step: dir => { state.stepOnce = dir; config.gym.paused = true; },
  reset: resetAll,
  clearTrail: () => { trailL.clear(); trailR.clear(); },
  punch: throwPunch,
  preset: n => gymCam.applyPreset(n),
  savePreset: () => gymCam.savePreset(),
  camDirty: () => { gymCam.dirty = true; },
  rebuild: () => { build(); scene.background = new THREE.Color(config.colors.bg); floorMat.color.set(config.colors.floor); },
  relight: () => { ambient.intensity = config.colors.ambient; key.intensity = config.colors.keyLight; },
  moveDummy: () => { dCarrier.position.z = config.dummy.z; },
  resetDummy: () => reaction.reset(),
});

// ── Frame ───────────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);

  let dt = Math.min(clock.getDelta(), 0.05) * config.gym.timescale;
  if (config.gym.paused) dt = 0;
  if (state.stepOnce) {
    dt = (config.gym.stepMs / 1000) * state.stepOnce;
    state.stepOnce = 0;
  }
  const dtAbs = Math.abs(dt);

  slip.set(keys.q ? 1 : keys.e ? -1 : 0, !!(keys.q || keys.e));
  if (dtAbs > 0) {
    stepMove(dtAbs);
    slip.step(dtAbs);
    reaction.step(dtAbs);
  }

  if (config.gym.hold) {
    if (!punch.type) punch.start('jab');
    punch.seek(config.gym.scrub);
  } else if (dt !== 0) {
    punch.advance(dt * 1000);
    if (punch.active) config.gym.scrub = punch.phase;
  }

  const headDisp = measureHead();       // also does the real posePlayer()
  poseDummy();
  updateGloves(dtAbs);
  tryContact();

  // Overlays
  trailL.max = Math.min(config.gym.trailFrames, TRAIL_CAP);
  trailR.max = trailL.max;
  trailL.visible = config.gym.trails;
  trailR.visible = config.gym.trails && config.gym.trailBoth;
  if (config.gym.trails && dtAbs > 0) {
    const arm = punch.active ? config.punches[punch.type].arm : null;
    if (config.gym.trailBoth || arm === 'L') trailL.push(state.gloveW.L);
    if (config.gym.trailBoth || arm === 'R') trailR.push(state.gloveW.R);
  }
  skel.visible = config.gym.skeleton;
  if (config.gym.skeleton) skel.update(config.gym.axesSize);
  grid.visible = config.gym.grid;
  floor.visible = config.gym.grid;

  gymCam.update(pCarrier.position, dCarrier.position);
  renderer.render(scene, gymCam.cam);

  hudAcc += 1;
  if (hudAcc >= 4) { hudAcc = 0; updateHud(headDisp); }
  window.__gym.frames++;
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  gymCam.resize(innerWidth / innerHeight);
});

// ── Test / capture surface ──────────────────────────────────────────────────
// gym_test.mjs and pose_sheet.mjs drive the scene through this and assert on
// getWorldPosition/getWorldQuaternion directly. There is no draw-command buffer
// to decode and no transform stack to re-derive: the scene graph already holds
// the answer.
window.__THREE = THREE;
window.__gym = {
  get root() { return player.root; },   // the fighter root, as asked
  get player() { return player; },
  get dummy()  { return dummy; },
  carrier: pCarrier,
  dummyCarrier: dCarrier,
  scene, renderer, config, punch, slip, reaction, state,
  get camera() { return gymCam.cam; },
  frames: 0,
  ready: false,

  api: {
    /** Hold `type` at phase p (0..1) and re-pose synchronously. */
    poseAt(type, p) {
      config.gym.hold = true;
      punch.start(type);
      punch.seek(p);
      config.gym.scrub = p;
      posePlayer();
      poseDummy();
      updateGloves(0);
    },
    rest() {
      config.gym.hold = false;
      punch.type = null; punch.t = 0;
      slip.a = 0; slip.dir = 0; slip.held = false;
      reaction.reset();
      posePlayer();
      poseDummy();
      updateGloves(0);
    },
    /** Hold `type` at an absolute time in ms. */
    poseAtMs(type, ms) {
      config.gym.hold = true;
      punch.start(type);
      punch.t = ms;
      config.gym.scrub = punch.total ? ms / punch.total : 0;
      posePlayer();
      poseDummy();
      updateGloves(0);
    },
    setFacing(rad) { state.faceOverride = rad; posePlayer(); },
    clearFacing() { state.faceOverride = null; posePlayer(); },
    setCam(o) { Object.assign(config.camera, o); gymCam.dirty = true; gymCam.update(pCarrier.position, dCarrier.position); },
    setSlip(dir, amount) { slip.dir = dir; slip.a = amount; posePlayer(); },
    preset(n) { gymCam.applyPreset(n); gymCam.update(pCarrier.position, dCarrier.position); },
    duration(type) { return punchDuration(config.punches[type]); },

    /** Live-play helpers: stand somewhere, throw for real, let the clock run. */
    place(x, z) { state.pos.set(x, z); state.vel.set(0, 0); posePlayer(); },
    throw(type) { throwPunch(type); },
    play() { config.gym.paused = false; config.gym.hold = false; },

    /** World position of any joint, as a plain array. */
    world(name, which = 'player') {
      const rig = which === 'dummy' ? dummy : player;
      const v = rig.joints[name].getWorldPosition(new THREE.Vector3());
      return [v.x, v.y, v.z];
    },
    /** World orientation of any joint, as a plain quaternion array. */
    quat(name, which = 'player') {
      const rig = which === 'dummy' ? dummy : player;
      const q = rig.joints[name].getWorldQuaternion(new THREE.Quaternion());
      return [q.x, q.y, q.z, q.w];
    },
    /** Every joint's position expressed in the fighter root's own frame. */
    localSkeleton(which = 'player') {
      const rig = which === 'dummy' ? dummy : player;
      rig.root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(rig.root.matrixWorld).invert();
      const out = {};
      for (const n of Object.keys(rig.joints)) {
        const v = rig.joints[n].getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
        out[n] = [v.x, v.y, v.z];
      }
      return out;
    },
    /** The torso as oriented boxes, for the forearm-intersection assertion. */
    torsoBoxes(which = 'player') {
      const rig = which === 'dummy' ? dummy : player;
      return rig.torso.map(t => ({
        matrix: t.obj.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(0, t.cy, 0)).elements.slice(),
        half: [t.half.x, t.half.y, t.half.z],
      }));
    },
    /** Camera-space depth of a joint: bigger = further from the camera. */
    camDepth(name, which = 'player') {
      const rig = which === 'dummy' ? dummy : player;
      return rig.joints[name].getWorldPosition(new THREE.Vector3()).distanceTo(gymCam.cam.position);
    },
    gloveR: () => config.body.gloveR,
    forearmR: () => config.body.forearmR,
  },
};

resetAll();
posePlayer();
poseDummy();
gymCam.update(pCarrier.position, dCarrier.position);
frame();
window.__gym.ready = true;

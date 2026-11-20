/**
 * The human fighter view (?human=1): the realistic skinned boxer (body.ts) posed every frame from mocap
 * clips (anim.ts -> clip.ts -> retarget.ts), standing where the sim says. Same seam as the procedural rig
 * (RigView); setFace / setBodyState / highlight are no-ops for now. The sim is never touched.
 *
 *   await preloadHuman();                                   // once, before any view: glb + clips + roles
 *   const v = createHumanView(side, spec, cfg, scene);      // null-safe: throws only if not preloaded
 */
import * as THREE from 'three';
import type { Config } from '../core/config';
import type { FighterSpec, FighterState, Side, SimEvent } from '../core/types';
import type { RigView } from '../rig';
import { loadBoxer, type BoxerAssets, type KitColors } from './body';
import { decode, synthClips, type BakeIndex, type ClipLib, type Roles } from './clip';
import { applyFit, buildFit, type Fit, type FitOut, type Skeleton } from './retarget';
import { HumanAnim, tiredOf } from './anim';
import { PoseInertia } from './inertia';
import { Spray } from '../rig/spray';
import { installRigReplay, type ReplayFeed } from '../rig/replay';
import { SIM_DT } from '../core';
import { mocapCfg } from '../sim/mocap';
import { createImpact, impactOnEvents, impactPose, impactStep, makeImpactPose, type ImpactBone } from './impact';

interface Assets { boxer: BoxerAssets; lib: ClipLib; roles: Roles; index: BakeIndex }
let assets: Assets | null = null;
/**
 * Where each human fighter's head is DRAWN vs where the sim's head sphere is (last frame). The mocap body
 * stands lower and leans further than the sim's shapes, so a fist aimed at the sim's head would land above
 * the drawn one: the hand IK shifts a head-bound target by the opponent's difference.
 */
const heads: ({ drawn: THREE.Vector3; sim: THREE.Vector3 } | null)[] = [null, null];
/** The states each human view was last given (the other view reads them: the sim's aim needs the opponent). */
const shown: ({ prev: FighterState; next: FighterState } | null)[] = [null, null];
/** Outcome mode: each view's drawn lunge along its facing last frame (the other caps its own by it), m. */
const drawnLunge = [0, 0];
/** Outcome mode: each view's DRAWN head sphere and torso capsule last frame (the other keeps its gloves out of them). */
interface DrawnBody { head: THREE.Vector3; headR: number; a: THREE.Vector3; b: THREE.Vector3; r: number; gloves: [THREE.Vector3, THREE.Vector3];
  /** The shoulder line (joint to joint) and the neck (chest joint to head joint): the torso capsule stops at the chest, so arms went through these. */
  sl: THREE.Vector3; sr: THREE.Vector3; sR: number; nk: THREE.Vector3; nR: number }
const drawnBodies: (DrawnBody | null)[] = [null, null];

/** Load the body and the clips once. Resolves to false (and logs) if anything is missing. */
/** cfg.humanBodyFile: which body glb the human fighters wear (read once, at preload). */
export const HUMAN_BODY_FILES = ['boxer_v2.glb', 'boxer_m1.glb'] as const;

export async function preloadHuman(bodyFile = 1): Promise<boolean> {
  if (assets) return true;
  try {
    const [boxer, index, bin, roles] = await Promise.all([
      // 0: the art-pass body (kit textures, look 2); 1: the Meshy body (same 52 bones, recoloured by region masks)
      loadBoxer('/fighter/', HUMAN_BODY_FILES[Math.max(0, Math.min(HUMAN_BODY_FILES.length - 1, Math.round(bodyFile)))]!),
      fetch('/fighter/clips/index.json').then(r => r.json() as Promise<BakeIndex>),
      fetch('/fighter/clips/clips.bin').then(r => r.arrayBuffer()),
      fetch('/fighter/clips/roles.json').then(r => r.json() as Promise<Roles>),
    ]);
    const lib = decode(index, bin);
    synthClips(lib, roles);   // the synthesised takes (roles with `seq`), same as the sim's library
    assets = { boxer, lib, roles, index };
    return true;
  } catch (e) {
    console.error('human fighters: assets failed to load, using the procedural rig', e);
    return false;
  }
}
export const humanReady = (): boolean => assets !== null;

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
      names: bones.map(b => b.name),
      parents: bones.map(b => bones.indexOf(b.parent as THREE.Bone)),
      restPos: bones.map(b => [b.position.x, b.position.y, b.position.z]),
      restRot: bones.map(b => [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w]),
      basePos: [p.x, p.y, p.z], baseRot: [q.x, q.y, q.z, q.w],
    },
  };
}

const luminance = (hex: string): number => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

// scratch
const vS = new THREE.Vector3(), vE = new THREE.Vector3(), vW = new THREE.Vector3(), vT = new THREE.Vector3();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vN = new THREE.Vector3();
const qP = new THREE.Quaternion(), qR = new THREE.Quaternion(), qL = new THREE.Quaternion(), qG = new THREE.Quaternion(), qI = new THREE.Quaternion();

/** Apply a WORLD-space rotation r to bone b about its own pivot (its local changes; children follow). */
function rotateWorld(b: THREE.Bone, r: THREE.Quaternion): void {
  b.parent!.getWorldQuaternion(qP);
  qL.copy(qP).invert().multiply(r).multiply(qP);
  b.quaternion.premultiply(qL);
}

/** Two-bone IK at full weight: bend `mid` so root -> end spans root -> target, then swing `root` onto it. Matrices must be current. */
function twoBone(root: THREE.Bone, mid: THREE.Bone, end: THREE.Bone, target: THREE.Vector3): void {
  const S = root.getWorldPosition(new THREE.Vector3()), E = mid.getWorldPosition(new THREE.Vector3()), W = end.getWorldPosition(new THREE.Vector3());
  const a = E.distanceTo(S), b = W.distanceTo(E);
  const c = Math.max(Math.abs(a - b) + 1e-3, Math.min(a + b - 1e-4, target.distanceTo(S)));
  const u = new THREE.Vector3().subVectors(S, E), v = new THREE.Vector3().subVectors(W, E);
  const cur = u.angleTo(v);
  const des = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b))));
  const n = new THREE.Vector3().crossVectors(u, v);
  if (n.lengthSq() < 1e-10) return;
  n.normalize();
  const r = new THREE.Quaternion().setFromAxisAngle(n, des - cur);
  rotateWorld(mid, r);
  v.applyQuaternion(r);
  W.copy(E).add(v);
  const r2 = new THREE.Quaternion().setFromUnitVectors(W.sub(S).normalize(), new THREE.Vector3().subVectors(target, S).normalize());
  rotateWorld(root, r2);
}

/** The point on segment a-b nearest p (new vector). */
function closestOn(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): THREE.Vector3 {
  const ab = new THREE.Vector3().subVectors(b, a), L = ab.lengthSq();
  const t = L < 1e-12 ? 0 : Math.max(0, Math.min(1, new THREE.Vector3().subVectors(p, a).dot(ab) / L));
  return a.clone().addScaledVector(ab, t);
}

/** window.__rigReplay (rig/replay.ts) feeds every tick and its events through these when the human views are up. */
const feeds: Partial<Record<Side, ReplayFeed>> = {};
/** window.__humanProbe(side): the drawn body this frame (tests / audits; read-only). */
const probes: Partial<Record<Side, () => unknown>> = {};
(window as unknown as { __humanProbe: (side: Side) => unknown }).__humanProbe = side => probes[side]?.() ?? null;

export function createHumanView(side: Side, spec: FighterSpec, cfg: Config, parent: THREE.Object3D): RigView {
  if (!assets) throw new Error('createHumanView: call preloadHuman() first');
  const { boxer, lib, roles, index } = assets;
  const tone = luminance(spec.skin) < 0.3 ? 'dark' : 'light';
  const kit: KitColors = { glove: spec.gloves, trunks: spec.trunksPrimary, trim: spec.trunksSecondary, boot: spec.boots, hair: spec.hairColor ?? '#15100c' };
  const model = boxer.spawn(tone, kit);
  const { skel, bones } = skeletonOf(model);
  const fit: Fit = buildFit(index.source, index.bones, index.parents, skel);
  const fitOut: FitOut = { localRot: skel.restRot.map(q => [...q] as [number, number, number, number]), hipsPos: [0, 0, 0] };
  const group = new THREE.Group();
  group.name = `human${side}`;
  group.add(model);
  group.scale.setScalar(spec.heightM / cfg.humanNativeHeight);
  parent.add(group);

  const bone = (suffix: string): THREE.Bone => bones.find(b => b.name.endsWith(suffix))!;
  const hips = bone('Hips');
  const head = bone('Head');
  const spine = [bone('Spine'), bone('Spine1'), bone('Spine2')];
  const arm = {
    Left: [bone('LeftArm'), bone('LeftForeArm'), bone('LeftHand')] as const,
    Right: [bone('RightArm'), bone('RightForeArm'), bone('RightHand')] as const,
  };
  const leg = {
    Left: [bone('LeftUpLeg'), bone('LeftLeg'), bone('LeftFoot')] as const,
    Right: [bone('RightUpLeg'), bone('RightLeg'), bone('RightFoot')] as const,
  };
  const neck = bone('Neck');
  const headTop = bones.find(b => b.name.endsWith('HeadTop_End')) ?? null;
  const spray = new Spray(parent);
  // the hit snap: the sim head relative to his floor point, its slow average, and how long the snap is drawn
  const headRel = new THREE.Vector3(), headSlow = new THREE.Vector3();
  let headInit = false, struck = 0, frozen = false;
  const anim = new HumanAnim(lib, roles, side, spec.stance, cfg);
  // the hit impact (impact.ts): additive head whip / body fold / face on a land, outcome mode only
  const imp = createImpact(), impOut = makeImpactPose();
  const impBones: [ImpactBone, THREE.Bone][] = (['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'] as const).map(n => [n, n === 'Head' ? head : bone(n)]);
  const faces: { m: THREE.Mesh; idx: Record<string, number> }[] = [];
  model.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) faces.push({ m, idx: m.morphTargetDictionary }); });
  const qF = new THREE.Quaternion(), qFi = new THREE.Quaternion(), qB = new THREE.Quaternion();
  if (side === 0) {
    const miss = anim.missing();
    if (miss.length) console.info(`human fighters: roles not in roles.json: ${miss.join(', ')}`);
  }
  let label = 'idle';

  const view: RigView & { label: () => string; probe: () => unknown } = {
    side,
    label: () => label,
    /** Measurements (checks): drawn head forward of the group origin along his facing, and the world gloves / head. */
    probe: () => {
      const hp = head.getWorldPosition(new THREE.Vector3());
      const yw = Math.PI / 2 - group.rotation.y;
      const fwd = (hp.x - group.position.x) * Math.cos(yw) + (hp.z - group.position.z) * Math.sin(yw);
      const g = (a: 'Left' | 'Right'): number[] => arm[a][2].getWorldPosition(new THREE.Vector3()).toArray();
      return { headFwd: fwd, head: hp.toArray(), gloves: [g('Left'), g('Right')] };
    },
    apply(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[]): void {
      if (frozen) return;
      run(prev, next, alpha, dt, events);
    },
    highlight(): void { /* the read's warm rim: not drawn on the human body yet */ },
    setFace(): void { /* no face rig yet */ },
    setBodyState(): void { /* no sweat / damage layer yet */ },
    dispose(): void {
      parent.remove(group);
      heads[side] = null;
      shown[side] = null;
      drawnBodies[side] = null; drawnLunge[side] = 0;
      delete probes[side];
      if (feeds[side] === feed) delete feeds[side];
      spray.mesh.parent?.remove(spray.mesh);
      model.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => mt.dispose());
      });
    },
  };
  // the foot planter's state (humanFootPlant): where the man was last frame, and per foot its pin, its step in progress and its floor height
  const plant = { on: false, lx: 0, lz: 0, trig: 0.1, f: [0, 1].map(() => ({ step: false, px: 0, pz: 0, fx: 0, fz: 0, s: 0, floor: 0, ax: 0, az: 0, T: 0.14 })) };
  // Read-only test hook: what is DRAWN this frame (world m). The sim beside it: window.__states()[side] (gloves[i].pos, punch, pos).
  const v3 = (o: THREE.Object3D): number[] => o.getWorldPosition(new THREE.Vector3()).toArray();
  const gloveOf = (a: 'Left' | 'Right'): number[] => {
    const h = arm[a][2].getWorldPosition(new THREE.Vector3()), e = arm[a][1].getWorldPosition(new THREE.Vector3());
    return h.addScaledVector(h.clone().sub(e).normalize(), cfg.humanGloveOffset).toArray();
  };
  const probeBones = (['Hips', 'Spine', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'] as const)
    .map(n => [n, n === 'Head' ? head : n === 'Hips' ? hips : bone(n)] as const);
  probes[side] = () => {
    const lead = spec.stance === 'orthodox' ? 'Left' : 'Right', rear = lead === 'Left' ? 'Right' : 'Left';
    return {
      head: v3(head), hips: v3(hips), headQ: head.getWorldQuaternion(new THREE.Quaternion()).toArray(), headTop: headTop ? v3(headTop) : null,
      gloves: { left: gloveOf('Left'), right: gloveOf('Right'), lead: gloveOf(lead), rear: gloveOf(rear) },
      feet: { left: v3(leg.Left[2]), right: v3(leg.Right[2]) }, knees: [v3(leg.Left[1]), v3(leg.Right[1])], ikMax,
      elbows: { left: v3(arm.Left[1]), right: v3(arm.Right[1]) }, shoulders: { left: v3(arm.Left[0]), right: v3(arm.Right[0]) },
      clip: anim.info.slug, frame: anim.info.frame, punchClip: anim.info.punch, label,
      origin: [group.position.x, group.position.y, group.position.z], legitHand: anim.legitHand,
      // outcome mode: the drawn head sphere / torso line (what the other man's gloves are kept out of) and the hand's target
      drawn: drawnBodies[side] ? { head: drawnBodies[side]!.head.toArray(), headR: drawnBodies[side]!.headR, a: drawnBodies[side]!.a.toArray(), b: drawnBodies[side]!.b.toArray(), r: drawnBodies[side]!.r } : null,
      lungeDbg: [...anim.lungeDbg],
      conform: { kind: anim.conformInfo.kind, w: anim.conformInfo.w, at: anim.conformInfo.at ? [anim.conformInfo.at.x, anim.conformInfo.at.y, anim.conformInfo.at.z] : null },
      // the sim events this view was fed on its last tick (the replay filters them to this side), as plain data
      events: lastEvents.map(e => ({ ...e })),
      // (transition audit) each tracked joint's LOCAL rotation (x, y, z, w) as drawn, and the body's drawn yaw
      lq: Object.fromEntries(probeBones.map(([n, b]) => [n, b.quaternion.toArray()])), yaw: group.rotation.y,
    };
  };
  // Read-only measurement hook (tests): the drawn MESH's head and torso extents about the drawn head sphere / torso line,
  // m, by skinned vertex (arms and hands left out), so mocapHeadR / mocapTorsoR / mocapTorsoFwd can be checked against it.
  ((window as unknown as { __humanMeasure?: Record<number, () => unknown> }).__humanMeasure ??= {})[side] = () => {
    const db = drawnBodies[side];
    if (!db) return null;
    const fy = Math.PI / 2 - group.rotation.y, F = new THREE.Vector3(Math.cos(fy), 0, Math.sin(fy)), R = new THREE.Vector3(-Math.sin(fy), 0, Math.cos(fy));
    const v = new THREE.Vector3();
    let headFront = 0, headSide = 0, headTop = 0, torsoFront = 0, torsoBack = 0, torsoSide = 0;
    model.updateMatrixWorld(true);
    model.traverse(o => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || /glove/i.test(m.name)) return;
      const n = m.geometry.attributes.position!.count, si = m.geometry.attributes.skinIndex!, sw = m.geometry.attributes.skinWeight!;
      for (let i = 0; i < n; i += 3) {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        const bn = m.skeleton.bones[best]?.name ?? '';
        if (/Arm|Hand|Shoulder/.test(bn)) continue;
        m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld);
        const d = v.clone().sub(db.head);
        if (/Head|Neck/.test(bn)) {
          headFront = Math.max(headFront, d.dot(F)); headSide = Math.max(headSide, Math.abs(d.dot(R))); headTop = Math.max(headTop, d.y);
        } else if (/Spine|Hips/.test(bn)) {
          const P = closestOn(db.a, db.b, v), e = v.clone().sub(P);
          if (v.y > db.a.y && v.y < db.b.y) { torsoFront = Math.max(torsoFront, e.dot(F)); torsoBack = Math.max(torsoBack, -e.dot(F)); torsoSide = Math.max(torsoSide, Math.abs(e.dot(R))); }
        }
      }
    });
    return { headFront, headSide, headTop, torsoFront, torsoBack, torsoSide, model: { headR: db.headR, torsoR: db.r } };
  };
  let lastEvents: readonly SimEvent[] = [];
  const droop = { Left: 0, Right: 0 };   // tired: how far each guard hand hangs, m
  // continuity (inertia.ts): scratch + which joints are hips / legs (they settle slower)
  const inRot = new Float32Array(bones.length * 4), inPos = new Float32Array(3), inSlow = new Float32Array(bones.length).fill(1);
  const inLeg = bones.map(b => (/(Spine|Neck|Head|Shoulder|Arm|Hand)/.test(b.name) ? 0 : 1));
  const inertia = new PoseInertia(bones.length, inSlow);
  /** The largest hand displacement any IK made this frame (outcome mode: the conform and the keep-out), m. */
  let ikMax = 0;
  let ikKey = -1;
  const ikOff = new THREE.Vector3();
  /** The guard tuck applied to each hand last frame (world m), so a punch's press offset starts from the tucked hand. */
  const tuckD = { Left: new THREE.Vector3(), Right: new THREE.Vector3() };
  const feed: ReplayFeed ={ feed: (p, n, ev) => run(p, n, 1, SIM_DT, ev), freeze: on => { frozen = on; } };
  feeds[side] = feed;
  installRigReplay(cfg, () => feeds);

  function run(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[]): void {
    lastEvents = events;
    {
      // ---- place: interpolated floor position, facing yaw (the clips face +Z), scaled to his height ----
      const x = prev.pos.x + (next.pos.x - prev.pos.x) * alpha, z = prev.pos.z + (next.pos.z - prev.pos.z) * alpha;
      let dy = next.yaw - prev.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const yaw = prev.yaw + dy * alpha;
      shown[side] = { prev, next };
      const oppSt = shown[side === 0 ? 1 : 0];

      // ---- pose from the clips ----
      const out = anim.update(prev, next, alpha, Math.min(dt, 0.1), events, oppSt);
      // outcome first: the lunge is drawn only, and capped so the two drawn hips never come closer than the sim's
      // separation (the other man's drawn lunge of last frame counted)
      if (cfg.mocapOutcome && oppSt) {
        const c = Math.cos(yaw), s = Math.sin(yaw), o = oppSt.next.pos;
        const d = Math.hypot(o.x - x, o.z - z), L = out.lunge.x * c + out.lunge.z * s;
        const cap = d - mocapCfg(cfg).separationDist + 2 * cfg.humanBackShift - Math.max(0, drawnLunge[side === 0 ? 1 : 0] ?? 0);
        const Lc = Math.min(L, Math.max(-0.25, cap));
        out.lunge = { x: c * Lc, z: s * Lc };
        drawnLunge[side] = Lc;
      } else drawnLunge[side] = 0;
      // stand back along his facing so the leaning mocap head sits over the sim's head (cfg.humanBackShift); with
      // mocapGeo the punch's lunge moves the body (the sim moves his head and body boxes by the same) and its turn turns it
      // CONTINUITY (humanInertia): the lunge is a weight shift, the hips travelling over PLANTED feet (below), not the whole man sliding
      const shift = cfg.humanShiftPlanted && cfg.humanInertia && cfg.mocapOutcome && !cfg.humanRawPose && !next.down;
      const lx = shift ? out.lunge.x : 0, lz = shift ? out.lunge.z : 0;
      group.position.set(x - Math.cos(yaw) * cfg.humanBackShift + out.lunge.x - lx, 0, z - Math.sin(yaw) * cfg.humanBackShift + out.lunge.z - lz);
      group.rotation.y = Math.PI / 2 - yaw - out.turn;
      group.visible = true;
      group.updateMatrixWorld(true);
      label = out.label;
      applyFit(fit, out.pose, fitOut);
      for (let i = 0; i < bones.length; i++) { const r = fitOut.localRot[i]!; bones[i]!.quaternion.set(r[0], r[1], r[2], r[3]); }
      hips.position.set(fitOut.hipsPos[0], fitOut.hipsPos[1], fitOut.hipsPos[2]);
      group.updateMatrixWorld(true);

      // ---- level / crouch / dip / hit sink: the hips go down by the sim's head drop, feet pinned by leg IK ----
      if (out.drop > 0.002 || Math.hypot(lx, lz) > 0.002) {
        const feet = (['Left', 'Right'] as const).map(s => ({ s, p: leg[s][2].getWorldPosition(new THREE.Vector3()), q: leg[s][2].getWorldQuaternion(new THREE.Quaternion()) }));
        const hp = hips.getWorldPosition(new THREE.Vector3());
        hp.y -= Math.min(0.45, Math.max(0, out.drop));
        hp.x += lx; hp.z += lz;
        hips.parent!.worldToLocal(hp);
        hips.position.copy(hp);
        group.updateMatrixWorld(true);
        for (const f of feet) {
          const [u, m, e] = leg[f.s];
          // soft reach: near full stretch the foot gives a little (comes with the hip) instead of the knee snapping straight
          u.getWorldPosition(vS); m.getWorldPosition(vE); e.getWorldPosition(vW);
          const L = vE.distanceTo(vS) + vW.distanceTo(vE), da = L * cfg.humanLegSoft, d = f.p.distanceTo(vS);
          if (d > da && L > da) f.p.sub(vS).setLength(da + (L - da) * (1 - Math.exp(-(d - da) / (L - da)))).add(vS);
          twoBone(u, m, e, f.p);
          group.updateMatrixWorld(true);
          e.parent!.getWorldQuaternion(qP);
          e.quaternion.copy(qP.invert().multiply(f.q));   // the foot keeps its world orientation (flat on the canvas)
        }
        group.updateMatrixWorld(true);
      }

      // ---- THE FEET STAND ON THE CANVAS (humanFootPlant). The sim moves the man at its own speed and the step clips play in
      //      place, so the drawn feet skated (measured 2026-11-20: strafing, the feet slid the whole 2.5 m and lifted 3.6 cm;
      //      walking 25-45% of the way; standing, 30 cm of drift a second: "sliding / floating... levitation"). Each foot is
      //      PINNED where it stands; when the body has carried its place far enough from the pin (further at speed), or the
      //      clip lifts it, it takes a real step — up, over, down ahead of the body — one foot at a time. ----
      // (run AFTER the continuity filter below: that filter re-blends the leg joints and put the feet back off their pins for a frame)
      const plantFeet = (): void => { if (cfg.humanFootPlant && !cfg.humanRawPose && !next.down) {
        const mvx = x - plant.lx, mvz = z - plant.lz, mv = Math.hypot(mvx, mvz);
        const fresh = !plant.on || mv > 0.5;
        const sp = fresh || dt <= 0 ? 0 : mv / Math.max(1e-3, dt);   // (a frozen frame, the hit-stop: the pins simply hold)
        plant.lx = x; plant.lz = z; plant.on = true;
        // (a frozen frame keeps the last distance: at dt 0 the speed reads 0 and a walking man's feet would all come due at once)
        if (dt > 0 || fresh) plant.trig = Math.min(cfg.humanFootStepMax, cfg.humanFootStepMin + cfg.humanFootStepPerSpeed * sp);
        const trig = plant.trig;
        group.updateMatrixWorld(true);
        const sides = ['Left', 'Right'] as const;
        const want = sides.map(s => ({ p: leg[s][2].getWorldPosition(new THREE.Vector3()), q: leg[s][2].getWorldQuaternion(new THREE.Quaternion()) }));
        for (let i = 0; i < 2; i++) {
          const st = plant.f[i]!, C = want[i]!.p, other = plant.f[1 - i]!;
          if (fresh) { st.step = false; st.px = C.x; st.pz = C.z; st.floor = C.y; st.s = 0; }
          st.floor = Math.min(st.floor, C.y);
          const lifted = C.y - st.floor > cfg.humanFootLift;
          if (!st.step) {
            const d = Math.hypot(C.x - st.px, C.z - st.pz);
            if ((d > trig && !other.step) || d > cfg.humanFootStepMax * 1.4 || (lifted && d > 0.03)) {
              st.step = true; st.fx = st.px; st.fz = st.pz; st.s = 0;
              // it lands AHEAD of where the clip has the foot, along the way he is going, so the body travels over it. The
              // lead is fixed at lift-off (recomputed each frame it vanished when a knockback ended: the foot jumped 25 cm
              // in a tick), and a longer step takes longer (the foot is never faster than about 7 cm a tick).
              const lead = sp > 0.08 && dt > 0 ? trig * cfg.humanFootStepLead / mv : 0;
              st.ax = mvx * lead; st.az = mvz * lead;
              st.T = Math.max(cfg.humanFootStepTime, Math.hypot(C.x + st.ax - st.px, C.z + st.az - st.pz) * cfg.humanFootStepPace);
            }
          }
          let y = C.y;
          if (st.step) {
            st.s = Math.min(1, st.s + dt / Math.max(0.03, st.T));
            const k = st.s * st.s * (3 - 2 * st.s);
            st.px = st.fx + (C.x + st.ax - st.fx) * k; st.pz = st.fz + (C.z + st.az - st.fz) * k;
            y = Math.max(C.y, st.floor + cfg.humanFootStepHeight * Math.sin(Math.PI * st.s));
            if (st.s >= 1) st.step = false;
          }
          const T = new THREE.Vector3(st.px, y, st.pz);
          const [u, m, e] = leg[sides[i]!];
          u.getWorldPosition(vS); m.getWorldPosition(vE); e.getWorldPosition(vW);
          const L = vE.distanceTo(vS) + vW.distanceTo(vE), da = L * cfg.humanLegSoft, d = T.distanceTo(vS);
          if (d > da && L > da) T.sub(vS).setLength(da + (L - da) * (1 - Math.exp(-(d - da) / (L - da)))).add(vS);
          twoBone(u, m, e, T);
          group.updateMatrixWorld(true);
          e.parent!.getWorldQuaternion(qP);
          e.quaternion.copy(qP.invert().multiply(want[i]!.q));   // the foot keeps the clip's own orientation
        }
        group.updateMatrixWorld(true);
      } else plant.on = false; };

      // ---- procedural lean (slips without a clip, the blocked-shot jolt): spread over the three spine bones ----
      const { lat, back, fwd } = out.lean, twist = out.lean.twist ?? 0;
      if (Math.abs(lat) + Math.abs(back) + Math.abs(fwd) + Math.abs(twist) > 1e-4) {
        const H = 0.62;   // head above the lower spine, m
        const roll = Math.asin(Math.max(-0.9, Math.min(0.9, lat / H)));       // model +Z forward, +X his left
        // (a negative forward lean, the out-breath, is a small lean back: acos of more than 1 was NaN and the whole body vanished)
        const pitch = Math.asin(Math.max(-0.9, Math.min(0.9, (back + Math.max(0, -fwd)) / H))) - Math.acos(Math.max(0, 1 - Math.max(0, Math.min(0.5, fwd)) / H));
        // model-space rotation: -roll about +Z puts the head to +X; -pitch about +X puts it back (-Z)
        qR.setFromEuler(new THREE.Euler(-pitch, twist, -roll, 'XYZ'));   // (twist + = turn toward his left)
        group.getWorldQuaternion(qG);
        qR.premultiply(qG).multiply(qI.copy(qG).invert());   // to world
        const part = new THREE.Quaternion().slerp(qR, 1 / 3);
        // Same axis for every share, so each bone may use the original parent frames (the shares commute).
        const parents = spine.map(b => b.parent!.getWorldQuaternion(new THREE.Quaternion()));
        spine.forEach((b, i) => { qL.copy(parents[i]!).invert().multiply(part).multiply(parents[i]!); b.quaternion.premultiply(qL); });
        group.updateMatrixWorld(true);
      }

      // ---- aim lift: a body-height clip thrown at the head; half the height gap by spine pitch, half by the shoulder ----
      if (out.aim) {
        const [up, , hand] = arm[out.aim.arm];
        group.getWorldQuaternion(qG);
        vN.set(1, 0, 0).applyQuaternion(qG).normalize();   // his left, world
        const rise = (pivot: THREE.Object3D, share: number): void => {
          hand.getWorldPosition(vW); pivot.getWorldPosition(vS);
          const dy = (out.aim!.y - vW.y) * out.aim!.w * share;
          const d = Math.max(0.15, Math.hypot(vW.x - vS.x, vW.z - vS.z));
          qR.setFromAxisAngle(vN, -Math.atan2(dy, d));   // about his left axis, negative = front up
          rotateWorld(pivot as THREE.Bone, qR);
          group.updateMatrixWorld(true);
        };
        rise(spine[1]!, 0.5);
        rise(up, 1);   // the rest of the gap
      }

      // ---- the sim's hit snap on top of the clip: the fast part of the sim head's movement, through the spine and neck ----
      {
        const hx = prev.headBox.x + (next.headBox.x - prev.headBox.x) * alpha, hy = prev.headBox.y + (next.headBox.y - prev.headBox.y) * alpha, hz = prev.headBox.z + (next.headBox.z - prev.headBox.z) * alpha;
        headRel.set(hx - x, hy, hz - z);
        if (!headInit) { headSlow.copy(headRel); headInit = true; }
        headSlow.lerp(headRel, 1 - Math.exp(-dt / Math.max(0.01, cfg.humanReactTau)));
        if (events.some(e => e.type === 'punchLand' && e.target === side)) struck = cfg.humanReactHold;
        // (off with the raw pose and in outcome mode: the hit reaction clip carries the hit; the impact layer is the next step)
        if (struck > 0 && cfg.humanReactGain > 0 && !cfg.humanRawPose && !cfg.mocapOutcome) {
          const k = cfg.humanReactGain * (struck / cfg.humanReactHold);
          const delta = new THREE.Vector3().subVectors(headRel, headSlow).multiplyScalar(k);
          if (delta.length() > 0.4) delta.setLength(0.4);
          for (const [pivot, share] of [[spine[2]!, 0.5], [neck, 0.5]] as const) {
            const H = head.getWorldPosition(new THREE.Vector3()), P = pivot.getWorldPosition(new THREE.Vector3());
            const arm1 = H.sub(P), d = delta.clone().multiplyScalar(share);
            const ax = new THREE.Vector3().crossVectors(arm1, d);
            if (ax.lengthSq() < 1e-12) continue;
            qR.setFromAxisAngle(ax.normalize(), Math.atan2(d.length(), arm1.length()));
            rotateWorld(pivot, qR);
            group.updateMatrixWorld(true);
          }
        }
        struck = Math.max(0, struck - dt);
      }

      // ---- the hit impact (impact.ts), outcome mode: additive head whip / body fold after the clip, before the hand ----
      if (cfg.mocapOutcome && !cfg.humanRawPose) {
        if (events.length) impactOnEvents(imp, side, events, next, cfg);
        impactStep(imp, Math.min(dt, 0.1));
        impactPose(imp, yaw, impOut);
        if (cfg.impactOn) {
          group.getWorldQuaternion(qF); qFi.copy(qF).invert();
          for (const [n, b] of impBones) {
            const r = impOut.rot[n];
            if (Math.abs(r[3]) > 1 - 1e-9) continue;
            qB.set(r[0], r[1], r[2], r[3]);
            rotateWorld(b, qR.copy(qF).multiply(qB).multiply(qFi));
          }
          if (Math.abs(impOut.hips[2]) > 1e-5) {
            const hp = hips.getWorldPosition(new THREE.Vector3()).add(vA.set(impOut.hips[0], impOut.hips[1], impOut.hips[2]).applyQuaternion(qF));
            hips.position.copy(hips.parent!.worldToLocal(hp));
          }
          group.updateMatrixWorld(true);
        }
        const f = impOut.face;
        for (const { m, idx } of faces) {
          const inf = m.morphTargetInfluences!;
          for (const k of ['hitWince', 'jawOpen', 'cheekL', 'cheekR'] as const) { const i = idx[k]; if (i !== undefined) inf[i] = cfg.impactOn ? f[k] : 0; }
        }
      }

      // ---- fist on target: two-bone IK on the punching arm, bell-weighted round the hit ----
      // (ik2: the previous punch's arm easing off the sim glove while a chained punch with the other arm runs)
      // The guard: every arm not in a live punch sits on the SIM's glove (guard, block, its recovery spring) by
      // humanGuardIK, so the guard drawn is the guard that blocks; a fading punch tail never drops below it.
      const reqs: (typeof out.ik)[] = [out.ik, out.ik2];
      // (outcome mode and the raw pose: the guard is the CLIP's guard — no hand is ever pulled to a sim glove)
      const gw = next.down || cfg.mocapOutcome || cfg.humanRawPose ? 0 : cfg.humanGuardIK;
      ikMax = 0;
      let outcomeT: THREE.Vector3 | null = null;   // the uncapped contact point of this frame's punch
      // outcome first: the punching hand moves at most mocapIKArmMax off the clip (clip elbow as pole); a BLOCKED punch
      // is steered onto the other man's DRAWN guard glove, not the sim's
      if (out.ik?.outcome && out.ik.w > 1e-3) {
        const oppBody = drawnBodies[side === 0 ? 1 : 0];
        const T = new THREE.Vector3(out.ik.at.x, out.ik.at.y, out.ik.at.z);
        if (anim.conformInfo.kind === 'block' && oppBody) {
          const g0 = oppBody.gloves[0], g1 = oppBody.gloves[1], gp = g0.distanceTo(T) <= g1.distanceTo(T) ? g0 : g1;
          const dir = new THREE.Vector3(x - gp.x, 0, z - gp.z).normalize();
          T.copy(gp).addScaledVector(dir, next.body.gloveR * (2 - cfg.contactSquash));
        }
        // CONTACT: a landed glove rests on the other man's DRAWN head / torso surface (the rules' point, moved onto the picture)
        if (cfg.humanInertia && anim.conformInfo.kind === 'land' && oppBody) {
          const rest = next.body.gloveR * (1 - cfg.contactSquash);
          const P = closestOn(oppBody.a, oppBody.b, T);
          const dh = T.distanceTo(oppBody.head) - oppBody.headR, dt = T.distanceTo(P) - oppBody.r;
          const c = dh <= dt ? oppBody.head : P, r = dh <= dt ? oppBody.headR : oppBody.r;
          const dir = T.clone().sub(c);
          if (dir.lengthSq() < 1e-8) dir.set(x - c.x, 0, z - c.z);
          T.copy(c).add(dir.setLength(r + rest));
        }
        outcomeT = T.clone();
        group.updateMatrixWorld(true);
        const G = new THREE.Vector3().fromArray(gloveOf(out.ik.arm));
        const D = T.clone().sub(G);
        if (D.length() > cfg.mocapIKArmMax) D.setLength(cfg.mocapIKArmMax);
        T.copy(G).add(D);
        out.ik.at = { x: T.x, y: T.y, z: T.z };
        ikMax = D.length() * out.ik.w;
      }
      if (gw > 0.01) {
        for (const r of reqs) if (r && r.key === undefined && !r.outcome) r.w = Math.max(r.w, gw);
        const leadArm = spec.stance === 'orthodox' ? 'Left' : 'Right';
        for (const gi of [0, 1] as const) {
          const a = (gi === 0) === (leadArm === 'Left') ? 'Left' : 'Right';
          if (reqs.some(r => r && r.arm === a)) continue;
          const g0 = prev.gloves[gi].pos, g1 = next.gloves[gi].pos;
          reqs.push({ arm: a, w: gw, exact: true, at: { x: g0.x + (g1.x - g0.x) * alpha, y: g0.y + (g1.y - g0.y) * alpha, z: g0.z + (g1.z - g0.z) * alpha } });
        }
      }
      const solveIK = (ik: NonNullable<typeof out.ik>): void => {
        group.updateMatrixWorld(true);
        const [up, fore, hand] = arm[ik.arm];
        up.getWorldPosition(vS); fore.getWorldPosition(vE); hand.getWorldPosition(vW);
        vT.set(ik.at.x, ik.at.y, ik.at.z);
        // a new punch: the target starts ON the drawn glove (its offset from the sim glove at the press), eased out
        // over the wind-up (pressW 1 -> 0), so the arm never jumps to the sim's guard spot
        if (ik.key !== undefined) {
          // (the hand drawn LAST frame: the clip hand pulled onto the sim glove by humanGuardIK, plus last frame's tuck)
          if (ik.key !== ikKey) { ikKey = ik.key; ikOff.fromArray(gloveOf(ik.arm)).sub(vT).multiplyScalar(next.down ? 1 : 1 - cfg.humanGuardIK).add(tuckD[ik.arm]); }
          vT.addScaledVector(ikOff, ik.pressW ?? 0);
        }
        const opp = heads[side === 0 ? 1 : 0];
        if (opp && !ik.exact) {   // (mocapGeo: the sim glove IS the drawn clip glove; no picture-vs-sim head shift)
          const k =Math.max(0, Math.min(1, 1 - (vT.distanceTo(opp.sim) - 0.15) / 0.3));   // only a target at the head
          vT.addScaledVector(vA.subVectors(opp.drawn, opp.sim), k);
        }
        // aim the wrist short of the glove centre along the shoulder -> glove line
        vA.subVectors(vT, vS);
        const reach = vA.length();
        vT.addScaledVector(vA.normalize(), -Math.min(cfg.humanGloveOffset, reach * 0.5));
        const a = vE.distanceTo(vS), b = vW.distanceTo(vE);
        const c = Math.max(Math.abs(a - b) + 1e-3, Math.min(a + b - 1e-4, vT.distanceTo(vS)));
        const w = ik.w;
        const save = [up.quaternion.clone(), fore.quaternion.clone()];
        // 1) the elbow: open / close the interior angle to the one that spans shoulder -> target
        vA.subVectors(vS, vE); vB.subVectors(vW, vE);
        const cur = vA.angleTo(vB);
        const des = Math.acos(Math.max(-1, Math.min(1, (a * a + b * b - c * c) / (2 * a * b))));
        vN.crossVectors(vA, vB);
        if (vN.lengthSq() < 1e-10) { up.getWorldQuaternion(qG); vN.set(0, 0, 1).applyQuaternion(qG); }
        vN.normalize();
        qR.setFromAxisAngle(vN, des - cur);
        rotateWorld(fore, qR);
        // the wrist where the bend put it (rotate the forearm vector about the elbow)
        vB.applyQuaternion(qR);
        vW.copy(vE).add(vB);
        // 2) the shoulder: swing the whole arm so the wrist lands on the target
        vA.subVectors(vW, vS).normalize(); vB.subVectors(vT, vS).normalize();
        qR.setFromUnitVectors(vA, vB);
        rotateWorld(up, qR);
        if (ik.exact) {
          // second pass: the glove centre sits humanGloveOffset past the wrist along the FOREARM as it now lies
          group.updateMatrixWorld(true);
          const T = new THREE.Vector3(ik.at.x, ik.at.y, ik.at.z).addScaledVector(ikOff, ik.key !== undefined ? ik.pressW ?? 0 : 0), E = fore.getWorldPosition(new THREE.Vector3());
          twoBone(up, fore, hand, T.clone().addScaledVector(T.clone().sub(E).normalize(), -cfg.humanGloveOffset));
        }
        // weight
        up.quaternion.copy(save[0]!.slerp(up.quaternion, w));
        fore.quaternion.copy(save[1]!.slerp(fore.quaternion, w));
      };
      for (const ik of reqs) if (ik && ik.w > 1e-3 && (cfg.humanHandIK || ik.exact)) solveIK(ik);
      // CONTACT, closed loop: what the arm could not close (a straight arm, the capped correction) goes to the body travel
      if (cfg.humanInertia && outcomeT && out.ik && out.ik.w > 1e-3 && (anim.conformInfo.kind === 'land' || anim.conformInfo.kind === 'block')) {
        group.updateMatrixWorld(true);
        const G = vA.fromArray(gloveOf(out.ik.arm));
        // (only on the way in: after the hit the glove leaves the contact by itself, and the body must not chase it)
        anim.feedReach(next.punch.resolved ? 0 : (outcomeT.x - G.x) * Math.cos(yaw) + (outcomeT.z - G.z) * Math.sin(yaw), out.ik.w);
      }
      // ---- guard tuck (drawn only): close to the other man the guard hands come back toward his own chin, never in a punch ----
      tuckD.Left.set(0, 0, 0); tuckD.Right.set(0, 0, 0);
      if (cfg.humanGuardTuck > 0 && !cfg.mocapOutcome && !cfg.humanRawPose && next.punch.type === null && !next.down && oppSt) {
        const d = Math.hypot(oppSt.next.pos.x - next.pos.x, oppSt.next.pos.z - next.pos.z);
        const span = Math.max(0.01, cfg.humanTuckFar - cfg.humanTuckNear);
        const t = Math.max(0, Math.min(1, (cfg.humanTuckFar - d) / span));
        const k = cfg.humanGuardTuck * t * t * (3 - 2 * t);
        if (k > 0.002) {
          const chin = head.getWorldPosition(new THREE.Vector3());
          chin.x += Math.cos(yaw) * 0.06; chin.z += Math.sin(yaw) * 0.06;   // just in front of the face
          for (const a of ['Left', 'Right'] as const) {
            const [u, m, e] = arm[a];
            const hp = e.getWorldPosition(new THREE.Vector3());
            const to = new THREE.Vector3().subVectors(chin, hp);
            const room = to.length() - 0.1;
            if (room <= 0) continue;
            tuckD[a].copy(to.normalize()).multiplyScalar(Math.min(k, room));
            twoBone(u, m, e, hp.add(tuckD[a]));
            group.updateMatrixWorld(true);
          }
        }
      }

      // ---- TIRED (drawn only): the guard hands sink as he tires; never the punching hand, less behind a held block ----
      if (cfg.humanInertia && cfg.humanTiredOn && !cfg.humanRawPose && !next.down) {
        const td = tiredOf(next, cfg) * (next.block ? cfg.humanTiredBlockShare : 1);
        for (const a of ['Left', 'Right'] as const) {
          const want = next.punch.type !== null && out.ik?.arm === a ? 0 : td * cfg.humanTiredDroop;
          droop[a] += (want - droop[a]) * (1 - Math.exp(-dt / 0.15));
          if (droop[a] < 0.003) continue;
          group.updateMatrixWorld(true);
          const [u, m, e] = arm[a];
          const hp = e.getWorldPosition(new THREE.Vector3());
          hp.y -= droop[a];
          twoBone(u, m, e, hp);
        }
        group.updateMatrixWorld(true);
      }

      // ---- CONTINUITY (inertia.ts): the final pose starts every switch from the pose and motion that were on screen ----
      {
        const cut = anim.takeCut();
        if (cfg.humanInertia && !cfg.humanRawPose) {
          for (let i = 0; i < bones.length; i++) {
            const q = bones[i]!.quaternion;
            inRot[i * 4] = q.x; inRot[i * 4 + 1] = q.y; inRot[i * 4 + 2] = q.z; inRot[i * 4 + 3] = q.w;
            inSlow[i] = 1 + (cfg.humanInertiaLegMult - 1) * inLeg[i]!;
          }
          inPos[0] = hips.position.x; inPos[1] = hips.position.y; inPos[2] = hips.position.z;
          inertia.step(inRot, inPos, cut, dt, cfg.humanInertiaVelMax, cfg.humanInertiaLegMult);
          for (let i = 0; i < bones.length; i++) bones[i]!.quaternion.set(inRot[i * 4]!, inRot[i * 4 + 1]!, inRot[i * 4 + 2]!, inRot[i * 4 + 3]!);
          hips.position.set(inPos[0]!, inPos[1]!, inPos[2]!);
          group.updateMatrixWorld(true);
          // the punching hand back on its target (what the carried-over difference moved it by; nothing once that has decayed)
          if (out.ik?.outcome && out.ik.w > 1e-3) {
            solveIK(out.ik);
            for (let i = 0; i < bones.length; i++) { const q = bones[i]!.quaternion; inRot[i * 4] = q.x; inRot[i * 4 + 1] = q.y; inRot[i * 4 + 2] = q.z; inRot[i * 4 + 3] = q.w; }
            inertia.sync(inRot);
            group.updateMatrixWorld(true);
          }
        }
      }
      plantFeet();

      // ---- outcome first: no glove of his ever inside the other man's DRAWN head or torso (a whiff, a dodge, a
      //      follow-through); a landed glove rests on the surface, where the contact point puts it ----
      {
        const ob = drawnBodies[side === 0 ? 1 : 0];
        if (ob && !next.down && cfg.mocapOutcome && !cfg.humanRawPose) {
          // ELBOWS TOO: an elbow inside his head or torso swings the upper arm out to the surface (then the glove rule below)
          if (cfg.humanInertia && cfg.humanElbowClear > 0) {
            for (const a of ['Left', 'Right'] as const) {
              group.updateMatrixWorld(true);
              const [u, m] = arm[a];
              const S = u.getWorldPosition(new THREE.Vector3()), E = m.getWorldPosition(new THREE.Vector3());
              let to: THREE.Vector3 | null = null;
              const hmin = ob.headR + cfg.humanElbowClear;
              if (E.distanceTo(ob.head) < hmin) to = ob.head.clone().add(E.clone().sub(ob.head).setLength(hmin));
              const P = closestOn(ob.a, ob.b, to ?? E), tmin = ob.r + cfg.humanElbowClear;
              if ((to ?? E).distanceTo(P) < tmin) to = P.clone().add((to ?? E).clone().sub(P).setLength(tmin));
              // (his shoulder line and neck too: the torso capsule stops at the chest joint)
              for (const [ca, cb, cr] of [[ob.sl, ob.sr, ob.sR], [ob.b, ob.nk, ob.nR]] as const) {
                if (cr <= 0) continue;
                const Q = closestOn(ca, cb, to ?? E), qmin = cr + cfg.humanElbowClear;
                if ((to ?? E).distanceTo(Q) < qmin) to = Q.clone().add((to ?? E).clone().sub(Q).setLength(qmin));
              }
              if (!to) continue;
              qR.setFromUnitVectors(E.sub(S).normalize(), to.sub(S).normalize());
              rotateWorld(u, qR);
            }
          }
          const rest0 = next.body.gloveR * (1 - cfg.contactSquash);
          for (const a of ['Left', 'Right'] as const) {
            group.updateMatrixWorld(true);
            const G = new THREE.Vector3().fromArray(gloveOf(a));
            let push: THREE.Vector3 | null = null;
            // A MISS IS VISIBLY SHORT: the glove of a punch the rules call a whiff never comes within humanMissGap of him
            const rest = rest0 + (cfg.humanInertia && next.punch.type !== null && out.ik?.arm === a && anim.conformInfo.kind === 'whiff' ? cfg.humanMissGap : 0);
            const hd = G.distanceTo(ob.head), hmin = ob.headR + rest;
            if (hd < hmin) push = ob.head.clone().add(G.clone().sub(ob.head).setLength(hmin));
            const P = closestOn(ob.a, ob.b, push ?? G), td = (push ?? G).distanceTo(P), tmin = ob.r + rest;
            if (td < tmin) push = P.clone().add((push ?? G).clone().sub(P).setLength(tmin));
            for (const [ca, cb, cr] of [[ob.sl, ob.sr, ob.sR], [ob.b, ob.nk, ob.nR]] as const) {
              if (cr <= 0) continue;
              const Q = closestOn(ca, cb, push ?? G), qmin = cr + rest;
              if ((push ?? G).distanceTo(Q) < qmin) push = Q.clone().add((push ?? G).clone().sub(Q).setLength(qmin));
            }
            // GLOVE ON GLOVE: two guards never sit inside each other; each man gives half (a punch resting on his guard is left where the block put it)
            if (cfg.humanInertia && cfg.humanGloveClear > 0 && !(next.punch.type !== null && out.ik?.arm === a)) {
              const gmin = next.body.gloveR * 2 * cfg.humanGloveClear;
              for (const og of ob.gloves) {
                const cur = push ?? G, dg = cur.distanceTo(og);
                if (dg < gmin && dg > 1e-4) push = cur.clone().add(cur.clone().sub(og).setLength((gmin - dg) * 0.5));
              }
            }
            if (!push) continue;
            const [u, m, e] = arm[a];
            const E = m.getWorldPosition(new THREE.Vector3());
            ikMax = Math.max(ikMax, push.distanceTo(G));
            twoBone(u, m, e, push.clone().addScaledVector(push.clone().sub(E).normalize(), -cfg.humanGloveOffset));
          }
          group.updateMatrixWorld(true);
        }
        // this man's drawn head sphere and torso line, for the other view (and the probe)
        const s = spec.heightM / cfg.mocapBandRefHeight;
        const db = drawnBodies[side] ?? (drawnBodies[side] = { head: new THREE.Vector3(), headR: 0, a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, gloves: [new THREE.Vector3(), new THREE.Vector3()], sl: new THREE.Vector3(), sr: new THREE.Vector3(), sR: 0, nk: new THREE.Vector3(), nR: 0 });
        db.gloves[0].fromArray(gloveOf('Left')); db.gloves[1].fromArray(gloveOf('Right'));
        arm.Left[0].getWorldPosition(db.sl); arm.Right[0].getWorldPosition(db.sr); head.getWorldPosition(db.nk);
        db.sR = cfg.humanShoulderR * s; db.nR = cfg.humanNeckR * s;
        head.getWorldPosition(db.head);
        if (headTop) db.head.add(headTop.getWorldPosition(vA)).multiplyScalar(0.5); else db.head.y += 0.09 * group.scale.y;
        db.headR = cfg.mocapHeadR * s; db.r = cfg.mocapTorsoR * s;
        const fy = Math.PI / 2 - group.rotation.y, fw = cfg.mocapTorsoFwd * s;
        // (the head sphere's centre forward of the joint midpoint, along his facing: the face, measured)
        db.head.x += Math.cos(fy) * cfg.mocapHeadFwd * s; db.head.z += Math.sin(fy) * cfg.mocapHeadFwd * s;
        hips.getWorldPosition(db.a); spine[2]!.getWorldPosition(db.b);
        db.a.x += Math.cos(fy) * fw; db.a.z += Math.sin(fy) * fw; db.b.x += Math.cos(fy) * fw; db.b.z += Math.sin(fy) * fw;
      }

      // record this man's drawn head (bone origin + ~9 cm to the head's centre) against the sim's sphere
      const hd = heads[side] ?? (heads[side] = { drawn: new THREE.Vector3(), sim: new THREE.Vector3() });
      head.getWorldPosition(hd.drawn);
      hd.drawn.y += 0.09 * group.scale.y;
      hd.sim.set(next.headBox.x, next.headBox.y, next.headBox.z);

      // ---- sweat off the head on clean / flush lands (rig/spray.ts), from the DRAWN head, along the punch ----
      if (cfg.humanSpray) {
        for (const e of events) {
          if (e.type !== 'punchLand' || e.target !== side || e.part !== 'head' || e.grade === 'glancing') continue;
          const n = Math.round(cfg.rigSprayCount * (e.grade === 'flush' ? 1 : 0.4) * (0.3 + 0.7 * Math.min(1, next.fatigue + 0.4)));
          const dl = Math.hypot(e.impulse.x, e.impulse.z) || 1, off = next.body.headR * 1.6;
          spray.burst(n, { x: hd.drawn.x + e.impulse.x / dl * off, y: hd.drawn.y + next.body.headR * 0.3, z: hd.drawn.z + e.impulse.z / dl * off }, e.impulse, cfg.rigSpraySpeed, cfg.rigSpraySize, cfg.rigSprayLife);
        }
      }
      spray.update(dt);
    }
  }
  (window as unknown as { __human?: Record<number, { label: () => string }> }).__human ??= {};
  (window as unknown as { __human: Record<number, { label: () => string }> }).__human[side] = view;
  return view;
}

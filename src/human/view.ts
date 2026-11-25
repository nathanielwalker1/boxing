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
import { Stains } from './stains';
import { FACE_SPOTS, makeFaceWear, paintFighter } from '../render/paint';
import { installRigReplay, type ReplayFeed } from '../rig/replay';
import { SIM_DT } from '../core';
import { mocapCfg } from '../sim/mocap';
import { VARIANTS } from '../sim/variants';
import { createImpact, impactOnEvents, impactPose, impactStep, makeImpactPose, type ImpactBone } from './impact';

interface Assets { boxers: Map<number, BoxerAssets>; forced: number | null; lib: ClipLib; roles: Roles; index: BakeIndex }
let assets: Assets | null = null;
/**
 * Where each human fighter's head is DRAWN vs where the sim's head sphere is (last frame). The mocap body
 * stands lower and leans further than the sim's shapes, so a fist aimed at the sim's head would land above
 * the drawn one: the hand IK shifts a head-bound target by the opponent's difference.
 */
const heads: ({ drawn: THREE.Vector3; sim: THREE.Vector3 } | null)[] = [null, null];
/** (humanContactSkin) per side: how far that man's SKIN reaches from point c along unit dir (vertices within band m of the ray), m; null = none. */
const skins: (((part: 'head' | 'torso', c: THREE.Vector3, dir: THREE.Vector3, band: number) => number | null) | null)[] = [null, null];
/** The states each human view was last given (the other view reads them: the sim's aim needs the opponent). */
const shown: ({ prev: FighterState; next: FighterState } | null)[] = [null, null];
/** Outcome mode: each view's drawn lunge along its facing last frame (the other caps its own by it), m. */
const drawnLunge = [0, 0];
/** Outcome mode: each view's DRAWN head sphere and torso capsule last frame (the other keeps its gloves out of them). */
interface DrawnBody { head: THREE.Vector3; headR: number; a: THREE.Vector3; b: THREE.Vector3; r: number; gloves: [THREE.Vector3, THREE.Vector3];
  /** The shoulder line (joint to joint) and the neck (chest joint to head joint): the torso capsule stops at the chest, so arms went through these. */
  sl: THREE.Vector3; sr: THREE.Vector3; sR: number; nk: THREE.Vector3; nR: number;
  /** humanArmClear: the elbows [Left, Right], and what each arm is doing: 0 guard, 1 a punch the rules will not land, 2 a punch that lands. */
  el: [THREE.Vector3, THREE.Vector3]; act: [number, number];
  /** humanLandCorridor: per arm, where a landing punch's glove is going (its contact point) while it is on its way, and
   *  when it lands (s to the hit tick; negative = landed that long ago); NaN = no lane open for that arm. */
  laneTo: [THREE.Vector3, THREE.Vector3]; laneEta: [number, number];
  /** humanLandCorridor: whether that lane is past its wind-up (every arm of the other man yields to it) or still in it
   *  (only his punching arm does: a punch that will not land, or lands later, gets out of an incoming land's way early). */
  laneLive: [boolean, boolean] }
const drawnBodies: (DrawnBody | null)[] = [null, null];

/** Load the body and the clips once. Resolves to false (and logs) if anything is missing. */
/** cfg.humanBodyFile: which body glb the human fighters wear (read once, at preload). */
export const HUMAN_BODY_FILES = ['boxer_v2.glb', 'boxer_m1.glb', 'boxer_m2.glb', 'boxer_m3.glb', 'boxer_m4.glb', 'boxer_m5.glb'] as const;

/** A menu is showing a fighter off (select / opponent / ladder / champion): the views hang their arms so the face is seen. Set every frame by main.ts. */
let handsDown = false;
export function setHumanHandsDown(on: boolean): void { handsDown = on; }
/** A new fight has started (main.ts startFight): every view dries off and loses its marks, a rematch in the same body included. */
let wearEpoch = 0;
export function resetHumanWear(): void { wearEpoch++; }

/** The bodies a fighter's build can pick when no one body is forced: 2 muscular, 3 average, 4 large, 5 skinny. */
const BUILD_BODIES = [2, 3, 4, 5] as const;
/** Which body file a fighter wears, from his build (roster morph): large / skinny / muscular / average. A forced body (?body=N) wins. */
export function bodyFileFor(spec: FighterSpec): number {
  if (assets && assets.forced !== null) return assets.forced;
  const { bodyFat, muscle } = spec.morph;
  if (bodyFat >= 0.4) return 4;
  if (bodyFat <= -0.5 && muscle <= -0.3) return 5;
  if (muscle >= 0.6) return 2;
  return 3;
}

/** `forced` = every fighter wears `bodyFile` (?body=N); otherwise each wears the body of his build and all four are loaded. */
export async function preloadHuman(bodyFile = 2, forced = false): Promise<boolean> {
  if (assets) return true;
  try {
    const one = Math.max(0, Math.min(HUMAN_BODY_FILES.length - 1, Math.round(bodyFile)));
    const files: readonly number[] = forced ? [one] : BUILD_BODIES;
    const [loaded, index, bin, roles] = await Promise.all([
      // 0: the art-pass body (kit textures, look 2); 1+: the Meshy bodies (same 52 bones, recoloured by region masks)
      Promise.all(files.map(f => loadBoxer('/fighter/', HUMAN_BODY_FILES[f]!))),
      fetch('/fighter/clips/index.json').then(r => r.json() as Promise<BakeIndex>),
      fetch('/fighter/clips/clips.bin').then(r => r.arrayBuffer()),
      fetch('/fighter/clips/roles.json').then(r => r.json() as Promise<Roles>),
    ]);
    const lib = decode(index, bin);
    synthClips(lib, roles);   // the synthesised takes (roles with `seq`), same as the sim's library
    const boxers = new Map<number, BoxerAssets>(files.map((f, i) => [f, loaded[i]!]));
    assets = { boxers, forced: forced ? one : null, lib, roles, index };
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

/** The closest points [on p1-q1, on p2-q2] of two segments (Ericson; a zero-length segment is a point). New vectors. */
function segSegPts(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const d1 = new THREE.Vector3().subVectors(q1, p1), d2 = new THREE.Vector3().subVectors(q2, p2), r = new THREE.Vector3().subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a < 1e-12 && e < 1e-12) { s = 0; t = 0; }
  else if (a < 1e-12) { t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = d1.dot(r);
    if (e < 1e-12) { s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [p1.clone().addScaledVector(d1, s), p2.clone().addScaledVector(d2, t)];
}

/** window.__rigReplay (rig/replay.ts) feeds every tick and its events through these when the human views are up. */
const feeds: Partial<Record<Side, ReplayFeed>> = {};
/** window.__humanProbe(side): the drawn body this frame (tests / audits; read-only). */
const probes: Partial<Record<Side, () => unknown>> = {};
/** window.__humanStages = {} (probes only): each drawn frame, both gloves after every stage of the draw, per side — which layer moved a glove. */
const stageLog = (): Record<number, [string, number[], number[]][]> | undefined => (window as unknown as { __humanStages?: Record<number, [string, number[], number[]][]> }).__humanStages;
/** humanContactDrawn: each view's "settle my hands against the other man as he is drawn now", run for side 0 once side 1 is posed. */
const lates: Partial<Record<Side, (() => void) | undefined>> = {};
(window as unknown as { __humanProbe: (side: Side) => unknown }).__humanProbe = side => probes[side]?.() ?? null;
/** window.__humanFeeds: the same feeds, for a script that runs a LIVE fight itself (sim + AI in the page) tick by tick (scripts/live_contact_probe.mjs). */
(window as unknown as { __humanFeeds: typeof feeds }).__humanFeeds = feeds;

export function createHumanView(side: Side, spec: FighterSpec, cfg: Config, parent: THREE.Object3D): RigView {
  if (!assets) throw new Error('createHumanView: call preloadHuman() first');
  const { lib, roles, index } = assets;
  const bodyFile = bodyFileFor(spec);
  const boxer = assets.boxers.get(bodyFile) ?? [...assets.boxers.values()][0]!;
  const tone = luminance(spec.skin) < 0.3 ? 'dark' : 'light';
  // ?trunks=t2 (red) / ?trunks2=t3 (blue) pick a trunks style on the fight page too, as on the proof page
  const q = new URLSearchParams(location.search);
  // (no ?trunks: the roster's cut picks the part — skirt = t2 gladiator, split = t4 Muay Thai, long = t3 tassels, the rest t1 vintage)
  const cutStyle = ({ skirt: 't2', split: 't4', long: 't3', short: 't1', classic: 't1', belt: 't1' } as const)[spec.trunksStyle];
  const trunksStyle = (side === 0 ? q.get('trunks') : (q.get('trunks2') ?? q.get('trunks'))) ?? cutStyle;
  // ?hair=h1 (red) / ?hair2=h1 (blue): the hair part worn; none = bald. Each side is its own choice (no fallback).
  const hairStyle = q.get(side === 0 ? 'hair' : 'hair2');
  const kit: KitColors = { glove: spec.gloves, trunks: spec.trunksPrimary, trim: spec.trunksSecondary, boot: spec.boots, hair: spec.hairColor ?? '#15100c', ...(cfg.humanSkinFromSpec ? { skin: spec.skin } : {}), ...(trunksStyle ? { trunksStyle } : {}), ...(hairStyle ? { hairStyle } : {}) };
  const model = boxer.spawn(tone, kit);
  const wear = makeFaceWear();   // his face marks and cut (render/paint.ts draws them; filled below from the punches that land on him)
  paintFighter(model, cfg, bodyFile, wear);   // the paint look's banded shading + ink outline (render/paint.ts; hidden when cfg.paintLook is off)
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
  // HEAD SHAPE (humanHeadShape): the roster's head numbers as a stretch of the head bone — width across, height up, chin and
  // brow front to back — and its neck number as a thicker or thinner neck (the head is un-scaled by the neck's so it keeps its own).
  // Set once: the pose only writes bone rotations.
  {
    const hm = spec.morph.head, k = cfg.humanHeadShape, nk = 1 + cfg.humanNeckShape * spec.morph.neck;
    neck.scale.set(nk, 1, nk);
    head.scale.set((1 + k * (0.6 * hm.width + 0.4 * hm.jaw)) / nk, 1 + k * (hm.height + 0.5 * hm.chin), (1 + k * 0.5 * (hm.brow + hm.nose)) / nk);
  }
  // BUILD TRIM (heavyweights, Nate 2026-11-25: the large body too fat, the skinny one too thin): the lower spine is scaled
  // across and front to back, and the bones above take that scale back off, so arms, head and reach are untouched.
  // Large body (file 4): the belly only (the chest bone undoes it). Skinny body (file 5): the whole trunk, shoulders a little wider.
  // (undo: b's own axes seen in its parent's frame, each un-scaled by what the parent did to it — wx across, wy up, wz front to back)
  const undo = (b: THREE.Bone, wx: number, wy = 1, wz = wx): void => {
    const s = [0, 1, 2].map(i => { const d = new THREE.Vector3().setComponent(i, 1).applyQuaternion(b.quaternion); return 1 / Math.hypot(wx * d.x, wy * d.y, wz * d.z); });
    b.scale.multiply(new THREE.Vector3(s[0], s[1], s[2]));
  };
  {
    if (bodyFile === 4 && cfg.humanFatBelly !== 1) { const w = cfg.humanFatBelly; spine[0]!.scale.set(w, 1, w); undo(spine[2]!, w); }
    if (bodyFile === 5 && cfg.humanSkinnyTorso !== 1) {
      const w = cfg.humanSkinnyTorso;
      spine[0]!.scale.set(w, 1, w);
      undo(neck, w); undo(bone('LeftShoulder'), w); undo(bone('RightShoulder'), w);
    }
  }
  // ALIVE (drawn only): the soft parts move by bone SCALE on top of the build's own — the belly (lower spine) and the chest
  // (upper spine) — and the bones above each take it back off (undo), so arms, head and reach keep their size.
  const clav = { Left: bone('LeftShoulder'), Right: bone('RightShoulder') };
  const softBones = [spine[0]!, spine[1]!, spine[2]!, neck, clav.Left, clav.Right];
  const softBase = softBones.map(b => b.scale.clone());   // as built (head shape, build trim)
  /** Belly and chest each scaled (across, up, front to back) for this frame. Call once the frame's rotations of these bones are in. */
  const softScale = (bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void => {
    softBones.forEach((b, i) => b.scale.copy(softBase[i]!));
    if (bx !== 1 || by !== 1 || bz !== 1) { spine[0]!.scale.multiply(vA.set(bx, by, bz)); undo(spine[1]!, bx, by, bz); }
    if (cx !== 1 || cy !== 1 || cz !== 1) { spine[2]!.scale.multiply(vA.set(cx, cy, cz)); undo(neck, cx, cy, cz); undo(clav.Left, cx, cy, cz); undo(clav.Right, cx, cy, cz); }
  };
  // (humanSoftOn) the wobble springs: belly, chest (each a displacement and its speed, 1 = a flush body shot), and the head's swing along world x / z, rad
  const soft = { b: 0, bv: 0, c: 0, cv: 0, hx: 0, hxv: 0, hz: 0, hzv: 0 };
  const softGain = bodyFile === 4 ? 1 : -1;   // (-1: read humanSoftLean live)
  // (for the checks: what the soft layers are doing to him right now — belly and chest scale front to back against the build's, the head's swing in degrees)
  /** A land of size k (1 = flush, nominal power) on his body or head, pushed along world (ix, iz): the springs are kicked. */
  const softKick = (k: number, part: 'head' | 'body', ix: number, iz: number): void => {
    const body = part === 'body' ? 1 : cfg.humanSoftCross, hd = part === 'head' ? 1 : cfg.humanSoftCross;
    const w = 2 * Math.PI * cfg.humanSoftHz, wh = 2 * Math.PI * cfg.humanSoftHeadHz, il = Math.hypot(ix, iz) || 1;
    soft.bv += k * body * w; soft.cv += k * body * w;
    const a = k * hd * cfg.humanSoftHeadDeg * Math.PI / 180 * wh;
    soft.hxv += a * ix / il; soft.hzv += a * iz / il;
  };
  // (.kick: the review film sets the wobble off on a man standing with his hands down, where nothing covers it)
  ((window as unknown as { __humanSoft?: Record<number, unknown> }).__humanSoft ??= {})[side] = Object.assign(() => ({
    belly: spine[0]!.scale.z / softBase[0]!.z, chest: spine[2]!.scale.z / softBase[2]!.z, headDeg: Math.hypot(soft.hx, soft.hz) * 180 / Math.PI,
  }), { kick: softKick });
  let hipSlow = NaN, flatW = 0;   // (humanTiredFlat) the clip's hip height averaged, and how much of the bounce is being taken out
  let menuW = 0;   // (humanMenuHandsDown) 0..1: how far the arms are down at his sides
  const headTop = bones.find(b => b.name.endsWith('HeadTop_End')) ?? null;
  // WEAR OVER THE FIGHT (drawn only; the sim never reads it): `wet` = how sweaty he is, `dmg` = how marked each face spot is,
  // `cutAt` = the spot his one cut is over (-1 = none). Reset when a new fight starts (wearEpoch).
  // The spots are fixed once, in the body mesh's own rest space: fractions of the head's height (head joint to crown) along the
  // head bone's axes — x to his left, y up, z out of the face. Order: L eye, R eye, L cheek, R cheek, nose, mouth.
  let wet = 0, cutAt = -1, myEpoch = -1;   // (-1: his first drawn frame runs the fight-start reset, so a view built AFTER the fight began still starts it properly)
  // NOT EVERY FIGHT HAS A CUT (Nate 2026-11-25, as in boxing): each fight, each man is or is not going to cut, decided once
  // by humanCutChance from the fight's number, his corner and his name (no Math.random: the same fight draws the same).
  const cutRoll = (): boolean => {
    let hsh = (wearEpoch * 2654435761 + side * 40503) >>> 0;
    for (let i = 0; i < spec.id.length; i++) hsh = (Math.imul(hsh ^ spec.id.charCodeAt(i), 1664525) + 1013904223) >>> 0;
    return hsh / 4294967296 < cfg.humanCutChance;
  };
  let cutProne = cutRoll();
  // A SPECTRUM OF BLOOD (Nate 2026-11-25): `cutHits` = head punches landed on him since the cut opened; a fresh cut gives
  // a little blood, one that keeps getting hit gives a lot (bloodAmt: 0.4 fresh to 2 at humanCutWorsen punches).
  let cutHits = 0;
  /** What landed on him this fight, as the rules reported it: "part:zone:punch" -> count (window.__humanWear state; a check reads it). */
  const zoneTally: Record<string, number> = {};
  const bloodAmt = (): number => 0.4 + 1.6 * Math.min(1, cutHits / Math.max(1, cfg.humanCutWorsen));
  let drip = 0;   // 0..1: how far the blood has run down from the cut (humanCutDripTime seconds to its full length)
  const cutPos = [new THREE.Vector3(), new THREE.Vector3()];
  const blood = new Spray(parent, 0x8a0a10, 0x4a0508);   // off a cut man's head on a clean or flush shot
  const stains = new Stains(parent);                      // what comes off HIM and lands on the canvas (human/stains.ts)
  const STAIN_BLOOD = new THREE.Color(cfg.humanStainBloodColor), STAIN_SWEAT = new THREE.Color(cfg.humanStainSweatColor);
  const dmg = new Array<number>(FACE_SPOTS).fill(0);
  const skinMats: THREE.MeshStandardMaterial[] = [];
  {
    let bodyMesh: THREE.Mesh | null = null;
    model.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) if (mt.name === 'meshy') { skinMats.push(mt as THREE.MeshStandardMaterial); bodyMesh ??= m; }
    });
    const bm = bodyMesh as THREE.SkinnedMesh | null;
    const hi = bm?.isSkinnedMesh ? bm.skeleton.bones.indexOf(head) : -1;
    if (bm && hi >= 0) {
      // head-bone space -> the mesh's rest (bind) space, by the skin's own bind data: whatever pose he was spawned in
      const toGeo = new THREE.Matrix4().copy(bm.bindMatrixInverse).multiply(new THREE.Matrix4().copy(bm.skeleton.boneInverses[hi]!).invert());
      // the head's height in the head bone's own units: the crown bone if the body has one (the Meshy bodies do not), else
      // cfg.humanHeadHeight metres at native height, taken back through the bone's world scale
      group.updateMatrixWorld(true);
      const h = headTop ? headTop.position.length() : cfg.humanHeadHeight * group.scale.y / head.getWorldScale(new THREE.Vector3()).y;
      const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).multiplyScalar(h).applyMatrix4(toGeo);
      // (Nate 2026-11-25: a boxer marks up round the EYES and NOSE, not the cheek or jaw. So: L eye, R eye (socket and the
      //  cheekbone under it), L brow, R brow, the bridge of the nose, and a small one on the lip. 4th number = its size.)
      const S: readonly (readonly [number, number, number, number])[] = [[0.2, 0.47, 0.5, 0.75], [-0.2, 0.47, 0.5, 0.75], [0.22, 0.63, 0.5, 0.6], [-0.22, 0.63, 0.5, 0.6], [0, 0.42, 0.62, 0.6], [0, 0.14, 0.56, 0.45]];
      S.forEach((s, i) => { wear.uDmgPos.value[i]!.copy(at(s[0], s[1], s[2])); wear.uDmgSize.value[i] = s[3]; });
      // THE BODY's four (spots 6-9: L ribs, R ribs, solar plexus, belly), straight in the mesh's rest space, which is the
      // man standing at native height, feet at 0, y up, +x his left, +z his front: [x, y] as shares of that height, then
      // size. Measured across the body only, on its front half (uDmgFlat), so a deep belly marks like a flat one.
      const Hn = cfg.humanNativeHeight;
      const B: readonly (readonly [number, number, number])[] = [[0.085, 0.64, 1.6], [-0.085, 0.64, 1.6], [0, 0.69, 1.3], [0, 0.6, 1.8]];
      B.forEach((b, j) => { wear.uDmgPos.value[6 + j]!.set(b[0] * Hn, b[1] * Hn, -0.02 * Hn); wear.uDmgSize.value[6 + j] = b[2]; wear.uDmgFlat.value[6 + j] = 1; });
      const o = at(0, 0, 0);
      wear.uDmgR.value = at(cfg.humanFaceMarkSize, 0, 0).distanceTo(o);
      wear.uCutDir.value.copy(at(1, 0.25, 0)).sub(o).normalize();
      wear.uCutDown.value.copy(at(0, -1, 0)).sub(o).normalize();
      // the cut: at the outer corner of the eye, just under the tail of the eyebrow (Nate 2026-11-25: "the closer to the eye
      // the better"; it was on the forehead above the brow. ON the brow it is dark red on a black eyebrow: not seen)
      cutPos[0]!.copy(at(0.29, 0.57, 0.42)); cutPos[1]!.copy(at(-0.29, 0.57, 0.42));    }
  }
  /** THE RULE (one landed head punch -> marks). `k`: 0 = it landed on his left side, 1 = his right. A flush punch adds
   *  humanFaceMarkPerHit, a clean one 0.6 of it, a glancing one 0.25, shared out by where it landed:
   *    nose: nose 1, both eyes 0.25        temple / forehead: that brow 1, that eye 0.5
   *    anything else (the rules say 'chin' or 'jaw' for nearly every head punch): by the punch —
   *      a hook = that eye 1, that brow 0.5; a jab or cross = nose 0.6, that eye 0.5, that brow 0.2;
   *      an uppercut = lip 0.4 (the lip never passes 0.5: redness, no bruise), nose 0.3
   *  A spot reads as redness from about 0.1, turns to bruise from 0.45, is full at 1. ONE cut a fight: on the brow of the
   *  first side whose eye or brow reaches humanCutAt. */
  let wearForce = false;   // (the review sheet: show the marks on a menu screen too)
  const markHit = (zone: string | undefined, punch: string, k: number, grade: string): void => {
    const a = cfg.humanFaceMarkPerHit * (grade === 'flush' ? 1 : grade === 'clean' ? 0.6 : 0.25);
    const add = (i: number, w: number, cap = 1): void => { dmg[i] = Math.min(Math.max(cap, dmg[i]!), dmg[i]! + a * w); };
    // (MEASURED 2026-11-25 in a live fight: the rules reported 23 of 23 head punches as 'chin' (jab, cross) or 'jaw'
    //  (hook), never nose / temple / forehead. Sending those to the lip left every face clean round the eyes. So chin
    //  and jaw say nothing about WHERE on the face: the punch and its side do.)
    if (zone === 'nose') { add(4, 1); add(0, 0.25); add(1, 0.25); }
    else if (zone === 'temple' || zone === 'forehead') { add(2 + k, 1); add(k, 0.5); }
    else if (punch === 'hook') { add(k, 1); add(2 + k, 0.5); }
    else if (punch === 'uppercut') { add(5, 0.4, 0.5); add(4, 0.3); }
    else { add(4, 0.6); add(k, 0.5); add(2 + k, 0.2); }
    if (cutAt < 0 && cutProne) for (const s of [k, 1 - k]) if (Math.max(dmg[s]!, dmg[2 + s]!) >= cfg.humanCutAt) { cutAt = s; break; }
  };
  /** THE BODY RULE (one landed body punch -> a red mark; never past humanBodyMarkMax: sore, not black). ribs = that side's
   *  ribs; liver = his right ribs; solar = the solar plexus; belly = the belly; no zone given: a hook = that side's ribs,
   *  anything else the belly. A flush punch adds humanBodyMarkPerHit, a clean one 0.6 of it, a glancing one 0.25. */
  const markBody = (zone: string | undefined, punch: string, k: number, grade: string): void => {
    const a = cfg.humanBodyMarkPerHit * (grade === 'flush' ? 1 : grade === 'clean' ? 0.6 : 0.25);
    const i = zone === 'ribs' ? 6 + k : zone === 'liver' ? 7 : zone === 'solar' ? 8 : zone === 'belly' ? 9 : punch === 'hook' ? 6 + k : 9;
    dmg[i] = Math.min(Math.max(cfg.humanBodyMarkMax, dmg[i]!), dmg[i]! + a);
  };
  /** window.__humanWear[side] (scripts/wear_sheet.mjs): land punches on his face by hand, and read what it did. */
  ((window as unknown as { __humanWear?: Record<number, unknown> }).__humanWear ??= {})[side] = {
    hit: (zone: string | undefined, punch: string, k: number, grade: string) => { wearForce = true; markHit(zone, punch, k, grade); },
    body: (zone: string | undefined, punch: string, k: number, grade: string) => { wearForce = true; markBody(zone, punch, k, grade); },
    /** Put `blood` and `sweat` spots on the canvas as head shots along (dx, dz) would, from where he stands. */
    splat: (blood: number, sweat: number, dx: number, dz: number) => {
      const under = { x: group.position.x, z: group.position.z }, dir = { x: dx, z: dz };
      stains.splat(blood, under, dir, cfg.humanStainNear, cfg.humanStainFar, cfg.humanStainSpread, cfg.humanStainBloodSize, STAIN_BLOOD);
      stains.splat(sweat, under, dir, cfg.humanStainNear, cfg.humanStainFar, cfg.humanStainSpread, cfg.humanStainSweatSize, STAIN_SWEAT);
      return stains.active;
    },
    reset: () => { dmg.fill(0); cutAt = -1; wet = 0; drip = 0; cutHits = 0; stains.clear(); },
    /** Make this a fight he does (or does not) cut in, whatever the roll said. */
    prone: (on: boolean) => { cutProne = on; },
    isProne: () => cutProne,
    /** As if `seconds` of the fight had passed since: the blood runs. */
    age: (seconds: number) => { if (cutAt >= 0) drip = Math.min(1, drip + seconds / Math.max(1, cfg.humanCutDripTime)); },
    state: () => ({ dmg: dmg.map(v => Math.round(v * 100) / 100), cut: cutAt, wet, zones: { ...zoneTally } }),
  };
  /** Each drawn frame: sweat on, marks from the punches that landed on his head this frame, and what the materials show. */
  const wearStep = (dt: number, next: FighterState, events: readonly SimEvent[]): void => {
    if (myEpoch !== wearEpoch) {
      myEpoch = wearEpoch; wet = 0; cutAt = -1; drip = 0; dmg.fill(0); cutProne = cutRoll(); cutHits = 0; stains.clear();
      // A fight that STARTS late (cfg.humanWearStart, the ?wear=N link): N head punches already on him in the game's real
      // mix (5 jabs, 2 crosses, 1 hook in 8, most on one side), one body punch per 8, soaked, and a fight he cuts in.
      const n = Math.round(cfg.humanWearStart);
      if (n > 0) {
        cutProne = true; wet = 1;
        for (let i = 0; i < n; i++) {
          const j = i % 8;
          markHit(j === 4 ? 'jaw' : 'chin', j === 4 ? 'hook' : j === 2 || j === 6 ? 'cross' : 'jab', j === 1 || j === 5 || j === 7 ? 0 : 1, j === 4 || j === 6 ? 'flush' : j === 1 || j === 5 ? 'glancing' : 'clean');
          if (j === 0) markBody(undefined, i % 16 ? 'hook' : 'jab', (i >> 4) & 1, 'clean');
        }
        if (cutAt >= 0) { drip = 1; cutHits = n / 4; }
      }
    }
    if (cutAt >= 0 && !handsDown) drip = Math.min(1, drip + dt / Math.max(1, cfg.humanCutDripTime));
    if (!handsDown) wet = Math.min(1, wet + dt / Math.max(1, cfg.humanSweatFull) * (1 + cfg.humanSweatTired * (1 - next.stamina)));
    if (cfg.humanFaceDamage) for (const e of events) {
      if (e.type !== 'punchLand' || e.target !== side) continue;
      // which side of his face: the punch pushes his head AWAY from the side it landed on
      const lat = arm.Left[0].getWorldPosition(vA).sub(arm.Right[0].getWorldPosition(vB));
      const k = e.impulse.x * lat.x + e.impulse.z * lat.z > 0 ? 1 : 0;   // 0 = his left side, 1 = his right
      const tk = `${e.part}:${e.zone ?? 'none'}:${e.punch}`;
      zoneTally[tk] = (zoneTally[tk] ?? 0) + 1;
      if (e.part === 'head' && cutAt >= 0) cutHits += e.grade === 'flush' ? 1 : e.grade === 'clean' ? 0.6 : 0.25;
      if (e.part === 'head') markHit(e.zone, e.punch, k, e.grade); else markBody(e.liver ? 'liver' : e.zone, e.punch, k, e.grade);
    }
    const test = cfg.humanFaceMarkTest, show = handsDown && !wearForce ? 0 : 1;
    for (let i = 0; i < FACE_SPOTS; i++) wear.uDmg.value[i] = Math.max(test, dmg[i]! * show);
    const c = test > 0 && cutAt < 0 ? 0 : cutAt;
    if (c >= 0 && (show > 0 || test > 0)) { const b = cutPos[c]!; wear.uCut.value.set(b.x, b.y, b.z, 1); wear.uCutDrip.value = cutAt < 0 ? 1 : drip; }
    else wear.uCut.value.w = 0;
    for (const m of skinMats) m.roughness = 1 - cfg.humanSweatShine * Math.max(cfg.humanSweatTest, handsDown ? 0 : wet);
  };
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
      if (skins[side]) skins[side] = null;
      shown[side] = null;
      drawnBodies[side] = null; drawnLunge[side] = 0;
      delete probes[side]; lates[side] = undefined;
      if (feeds[side] === feed) delete feeds[side];
      spray.mesh.parent?.remove(spray.mesh);
      blood.mesh.parent?.remove(blood.mesh);
      stains.dispose();
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
      lungeDbg: [...anim.lungeDbg], reach: [...reachDbg], armAct: drawnBodies[side] ? [...drawnBodies[side]!.act] : null, armDbg: [...armDbg],
      laneEta: drawnBodies[side] ? [...drawnBodies[side]!.laneEta] : null, toHit: anim.conformInfo.toHit,
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
  // Read-only measurement hook (probes): the SKINNED MESH as drawn this frame, world m, subsampled — vertices of each glove
  // (by mesh name and side of the body), of the head (dominant bone Head) and of the torso (Spine / Hips). What the eye sees.
  type MeshPick = { m: THREE.SkinnedMesh; i: number; k: 'L' | 'R' | 'head' | 'torso' | 'rest' };
  let meshIdx: MeshPick[] | null = null;
  /** The sampled skinned vertices of this body by part (built once: every 2nd glove vertex, every 3rd of the rest). */
  const meshIndex = (): MeshPick[] => {
    if (meshIdx) return meshIdx;
    const idx: MeshPick[] = [], w = new THREE.Vector3();
    model.updateMatrixWorld(true);
    const lh = bone('LeftHand').getWorldPosition(new THREE.Vector3()), rh = bone('RightHand').getWorldPosition(new THREE.Vector3());
    model.traverse(o => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh) return;
      const n = m.geometry.attributes.position!.count, si = m.geometry.attributes.skinIndex!, sw = m.geometry.attributes.skinWeight!;
      const glove = /glove/i.test(m.name);
      // (a separate glove mesh takes its side from its NAME, e.g. glove_L / glove_R_1 — sorted by distance to the hand bones
      //  at the first call, m2's two gloves got mixed: 932 of 4,538 "left" vertices over 25 cm from the left hand)
      const gSide = !glove ? null : /(_L|Left)(_\d+)?$/i.test(m.name) ? 'L' as const : /(_R|Right)(_\d+)?$/i.test(m.name) ? 'R' as const : null;
      for (let i = 0; i < n; i += glove ? 2 : 3) {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const wt = sw.getComponent(i, k); if (wt > bw) { bw = wt; best = si.getComponent(i, k); } }
        const bn = m.skeleton.bones[best]?.name ?? '';
        if (!glove && /Hand/.test(bn)) idx.push({ m, i, k: /Left/.test(bn) ? 'L' : 'R' });   // a one-mesh body: the glove is what the hand carries
        else if (glove && gSide) idx.push({ m, i, k: gSide });
        else if (glove) { m.getVertexPosition(i, w); w.applyMatrix4(m.matrixWorld); idx.push({ m, i, k: w.distanceTo(lh) < w.distanceTo(rh) ? 'L' : 'R' }); }
        else if (/Head/.test(bn) && !/Arm|Shoulder/.test(bn)) idx.push({ m, i, k: 'head' });
        else if (/Spine|Hips/.test(bn)) idx.push({ m, i, k: 'torso' });
        else idx.push({ m, i, k: 'rest' });
      }
    });
    meshIdx = idx;
    return idx;
  };
  // (probes) the 'rest' vertices of __humanMesh(side, true), in the same order: "mesh name / dominant bone name"
  ((window as unknown as { __humanMeshRestNames?: Record<number, () => string[]> }).__humanMeshRestNames ??= {})[side] = () =>
    meshIndex().filter(e => e.k === 'rest').map(e => {
      const si = e.m.geometry.attributes.skinIndex!, sw = e.m.geometry.attributes.skinWeight!;
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const wt = sw.getComponent(e.i, k); if (wt > bw) { bw = wt; best = si.getComponent(e.i, k); } }
      return `${e.m.name}/${e.m.skeleton.bones[best]?.name ?? '?'}`;
    });
  // CONTACT ON THE SKIN (humanContactSkin, 2026-11-24): the skinned vertices a landed punch is put against — every 4th head
  // vertex (the face is dense), every torso vertex, every glove vertex of the sample
  const skinIdx = { head: [] as MeshPick[], torso: [] as MeshPick[], L: [] as MeshPick[], R: [] as MeshPick[] };
  let skinReady = false;
  const sv = new THREE.Vector3();
  const skinPrep = (): void => {
    if (skinReady) return;
    skinReady = true;
    let hn = 0;
    for (const e of meshIndex()) {
      if (e.k === 'head') { if (hn++ % 4 === 0) skinIdx.head.push(e); }
      else if (e.k !== 'rest') skinIdx[e.k].push(e);
    }
  };
  skins[side] = (part, c, dir, band) => {
    skinPrep(); model.updateMatrixWorld(true);
    let best = -Infinity;
    for (const e of skinIdx[part]) {
      e.m.getVertexPosition(e.i, sv); sv.applyMatrix4(e.m.matrixWorld).sub(c);
      const t = sv.dot(dir);
      if (t <= 0 || sv.lengthSq() - t * t > band * band) continue;
      if (t > best) best = t;
    }
    return best > -Infinity ? best : null;
  };
  // (render/ropes.ts, ropesContainSkin) every `stride`-th sampled skinned vertex of the whole body, world xyz flat: the ropes keep
  // the SKIN inside, not their capsules (a knocked-down man lay 88 cm past the ropes while his capsules sat within the bow)
  group.userData.skinPoints = (stride: number, outPts: number[]): number => {
    let n = 0, k = 0;
    for (const e of meshIndex()) {
      // (the limbs and feet, which poke through, at `stride`; the dense face 8x and the torso 2x sparser: cost)
      const s = e.k === 'head' ? stride * 8 : e.k === 'torso' ? stride * 2 : stride;
      if (k++ % s !== 0) continue;
      e.m.getVertexPosition(e.i, sv); sv.applyMatrix4(e.m.matrixWorld);
      outPts[n++] = sv.x; outPts[n++] = sv.y; outPts[n++] = sv.z;
    }
    return n;
  };
  /** How far this man's glove SKIN reaches past its glove point (gloveOf) toward unit dir, m; null = no glove vertices. */
  const gloveFront = (a: 'Left' | 'Right', dir: THREE.Vector3): number | null => {
    skinPrep(); model.updateMatrixWorld(true);
    const G = new THREE.Vector3().fromArray(gloveOf(a));
    let best = -Infinity;
    for (const e of skinIdx[a === 'Left' ? 'L' : 'R']) {
      e.m.getVertexPosition(e.i, sv); sv.applyMatrix4(e.m.matrixWorld);
      const t = sv.sub(G).dot(dir);
      if (t > best) best = t;
    }
    return best > -Infinity ? best : null;
  };
  // (all = true also returns every other sampled vertex under `rest`: limbs, hips, feet — the rope check)
  ((window as unknown as { __humanMesh?: Record<number, (all?: boolean) => unknown> }).__humanMesh ??= {})[side] = (all = false) => {
    const v = new THREE.Vector3();
    model.updateMatrixWorld(true);
    const out: Record<string, number[]> = { L: [], R: [], head: [], torso: [], rest: [] };
    for (const e of meshIndex()) { if (e.k === 'rest' && !all) continue; e.m.getVertexPosition(e.i, v); v.applyMatrix4(e.m.matrixWorld); out[e.k]!.push(v.x, v.y, v.z); }
    return out;
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
  // CONTACT (humanContactDrawn): seconds since his punch was resolved, and the world point his landed glove holds once it stops following
  let landAge = 0, landHeld = false, earlyS = 0;
  // humanGloveGuard: per arm (Left, Right) the glove as the body alone puts it this frame, and the correction layers' share kept last frame
  const gBase = { Left: new THREE.Vector3(), Right: new THREE.Vector3() }, gOff = { Left: new THREE.Vector3(), Right: new THREE.Vector3() };
  let gOn = false, gX = 1e9, gZ = 1e9;
  // gOff = the glove as SHOWN last frame (world); gBase = the glove as the body alone puts it, this frame and (gPrev) last
  const gPrev = { Left: new THREE.Vector3(), Right: new THREE.Vector3() };
  const guardGloves = (dt: number, skip: boolean, punchArm: 'Left' | 'Right' | null, landing: boolean, toHit: number, stuck: boolean): void => {
    if (!cfg.humanGloveGuard || cfg.humanRawPose || skip) { gOn = false; return; }
    const step = Math.max(0, dt);
    for (const a of ['Left', 'Right'] as const) {
      group.updateMatrixWorld(true);
      const G = new THREE.Vector3().fromArray(gloveOf(a));
      if (!gOn) { gOff[a].copy(G); gPrev[a].copy(gBase[a]); continue; }
      // the speed the glove may move at: what the body itself moves it at (a clip's fast hook), never less than the base
      // speed and never more than the ceiling (a clip switch the continuity filter smooths is not a licence to jump)
      const bodyV = step > 0 ? gBase[a].distanceTo(gPrev[a]) / step : 0;
      let v = Math.max(cfg.humanGloveGuardSpeed, Math.min(bodyV, cfg.humanGloveGuardSpeedMax));
      const d = G.clone().sub(gOff[a]), L = d.length();
      // a punch that will land arrives ON its hit: what is left is closed evenly over the time to it (never in less than
      // two ticks); for the moment it stays on the struck part it follows the part the same way
      if (a === punchArm && landing) v = Math.max(v, L / Math.max(2 * SIM_DT, stuck ? 0 : toHit));
      const lim = v * step;
      gPrev[a].copy(gBase[a]);
      if (L <= lim) { gOff[a].copy(G); continue; }
      const want = gOff[a].clone().addScaledVector(d, lim / L);
      const [u, m, e] = arm[a];
      // (the glove sits along the forearm from the hand bone, and the bend turns the forearm: aimed once, a held glove
      //  sank by that offset every frame — re-aimed from where it actually went)
      const H = e.getWorldPosition(new THREE.Vector3()).add(want.clone().sub(G));
      for (let i = 0; i < 3; i++) {
        twoBone(u, m, e, H);
        group.updateMatrixWorld(true);
        H.add(want.clone().sub(vA.fromArray(gloveOf(a))));
      }
      gOff[a].fromArray(gloveOf(a));   // (what the arm could actually reach is what is shown)
    }
    group.updateMatrixWorld(true);
    gOn = true;
  };
  let baAge = 0;   // (humanBodyAim) seconds since the hit tick of the body punch in flight
  // (humanLandGap) the head contact's turn off the plain point as eased so far (rad), the candidate held, and whether this frame has eased it yet
  let gapYaw = 0, gapPitch = 0, gapPick = -1, gapStep = true, gapHitYaw = NaN, gapHitPitch = 0, landPlainOn = false;
  const landPlain = new THREE.Vector3();
  // the upper-body reach given last frame and so far this frame, m at the shoulder (it grows at humanContactLeanRate)
  let leanPrev = 0, leanUsed = 0;
  /** 0..1: the non-punching hand held home through a body straight (humanOffHandHome). */
  let offHome = 0;
  /** (probe) the last reach solve: glove to contact point before the upper body gave, after, the hand weight, and contact point to the clip's own glove, m. */
  let reachDbg = [0, 0, 0, 0];
  /** (probe, humanArmClear) the arm-clearance moves of this frame's solves, m: [Left, Right] per solve, in order. */
  const armDbg: number[] = [];
  /** (humanArmClear) each arm's clearance move, world m: as left on screen last frame, and as given so far this frame (rate-limited between them). */
  const armPrev = { Left: new THREE.Vector3(), Right: new THREE.Vector3() }, armUsed = { Left: new THREE.Vector3(), Right: new THREE.Vector3() };
  /** (humanArmClear) each glove before its first clearance solve, last frame and this frame (its own speed sets how much the clearance may change); and whether this frame's first solve has run. */
  const armRawPrev = { Left: new THREE.Vector3(), Right: new THREE.Vector3() }, armRaw = { Left: new THREE.Vector3(), Right: new THREE.Vector3() }, armSeen = { Left: false, Right: false };
  const landT = new THREE.Vector3();
  /** (humanContactSkin) this frame's landed glove: its centre's distance off the struck part's centre on the skin, m (0 = none). */
  let skinLand = 0;
  const ikOff = new THREE.Vector3();
  /** The guard tuck applied to each hand last frame (world m), so a punch's press offset starts from the tucked hand. */
  const tuckD = { Left: new THREE.Vector3(), Right: new THREE.Vector3() };
  // drive: one DRAWN frame between two ticks (alpha, view dt), as main.ts's loop draws live play and the slowed replay (probes)
  // (feed = the rigs settled on frames that are not drawn: a replay's preroll, the hand-back to live play. The glove guard
  //  starts afresh after it: carried across that cut it dragged every glove from the live fight toward the clip, the reach
  //  and lean read the dragged glove, and the two kept each other swinging — 2026-11-24, measured in the real quarter-speed
  //  replay: head and chest off their path by more than 3 cm on 9 of 10 drawn frames, gloves by up to 1.3 m)
  const feed: ReplayFeed ={ feed: (p, n, ev) => { gOn = false; run(p, n, 1, SIM_DT, ev); }, drive: (p, n, a, d, ev) => run(p, n, a, d, ev), freeze: on => { frozen = on; } };
  feeds[side] = feed;
  installRigReplay(cfg, () => feeds);

  function stamp(n: string): void {
    const L = stageLog(); if (!L) return;
    group.updateMatrixWorld(true);
    (L[side] ??= []).push([n, gloveOf('Left'), gloveOf('Right')]);
  }
  function run(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[]): void {
    lastEvents = events;
    // (humanTiredPin, the ?tired=N link) how tired he is DRAWN, pinned: copies of the states for the picture only
    if (cfg.humanTiredPin >= 0) {
      const t = Math.min(1, cfg.humanTiredPin);
      prev = { ...prev, fatigue: t, stamina: 1 - t, staminaCap: 1 };
      next = { ...next, fatigue: t, stamina: 1 - t, staminaCap: 1 };
    }
    group.userData.down = next.down;   // (render/ropes.ts: a man on the floor is not held by the ropes' bow)
    { const L = stageLog(); if (L) L[side] = []; }
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
      // ---- ALIVE (drawn only), on the clip and before every hand is placed: the breath in the chest and shoulders, the tired
      //      head, the flatter stance. The breath is the one anim.ts already leans the head on (same phase), so they move as one. ----
      let bl = 0, sw = 0;   // this frame's swell of belly and chest (fractions, front to back)
      // SOFT BODY ON A HIT (humanSoftOn): each land on him kicks the springs; they ring and die
      if (cfg.humanSoftOn && !cfg.humanRawPose) {
        for (const e of events) {
          if (e.type !== 'punchLand' || e.target !== side) continue;
          const k = (e.grade === 'flush' ? 1 : e.grade === 'clean' ? 0.7 : 0.35) * Math.max(0.5, Math.min(1.5, e.power));
          softKick(k, e.part === 'body' ? 'body' : 'head', e.impulse.x, e.impulse.z);
        }
        const w = 2 * Math.PI * cfg.humanSoftHz, wh = 2 * Math.PI * cfg.humanSoftHeadHz;
        const n = Math.max(1, Math.ceil(Math.min(dt, 0.1) * 240)), h = Math.min(dt, 0.1) / n;
        for (let i = 0; i < n; i++) {
          soft.bv += (-w * w * soft.b - 2 * cfg.humanSoftDamp * w * soft.bv) * h; soft.b += soft.bv * h;
          // (the chest is stiffer: it rings a third faster)
          soft.cv += (-w * w * 1.7 * soft.c - 2 * cfg.humanSoftDamp * w * 1.3 * soft.cv) * h; soft.c += soft.cv * h;
          soft.hxv += (-wh * wh * soft.hx - 2 * cfg.humanSoftHeadDamp * wh * soft.hxv) * h; soft.hx += soft.hxv * h;
          soft.hzv += (-wh * wh * soft.hz - 2 * cfg.humanSoftHeadDamp * wh * soft.hzv) * h; soft.hz += soft.hzv * h;
        }
        const g = softGain > 0 ? softGain : cfg.humanSoftLean;
        bl -= Math.max(-0.4, Math.min(0.4, soft.b * cfg.humanSoftBelly * g));
        sw -= Math.max(-0.25, Math.min(0.25, soft.c * cfg.humanSoftChest * g));
      } else { soft.b = soft.bv = soft.c = soft.cv = soft.hx = soft.hxv = soft.hz = soft.hzv = 0; }
      if (cfg.humanTiredOn && !cfg.humanRawPose) {
        const td = next.down ? 0 : tiredOf(next, cfg);
        // the bounce: the clip's hip height pulled toward its own slow average
        const calm = next.punch.type === null && !next.down && !next.slip.active && struck <= 0;
        const hy = fitOut.hipsPos[1];
        if (!calm || !(hipSlow === hipSlow)) hipSlow = hy; else hipSlow += (hy - hipSlow) * (1 - Math.exp(-Math.min(dt, 0.1) / 0.6));
        flatW += ((calm ? td * cfg.humanTiredFlat : 0) - flatW) * (1 - Math.exp(-Math.min(dt, 0.1) / 0.3));
        hips.position.y = hy + (hipSlow - hy) * flatW;
        // the breath, 0 (out) .. 1 (in)
        const ph = (anim as unknown as { breath: number }).breath;
        const inB = 0.5 - 0.5 * Math.sin(ph), br = (cfg.humanBreathChest + cfg.humanBreathChestTired * td) * inB;
        sw += br; bl += br * cfg.humanBreathBelly;
        // (pushed in front to back, the flesh goes out to the sides: 0.6 of it across for the wobble, the breath's own half)
        softScale(1 + (bl < 0 ? -0.6 : 0.5) * bl, 1, 1 + bl, 1 + (sw < 0 ? -0.6 : 0.5) * sw, 1, 1 + sw);
        group.updateMatrixWorld(true);
        group.getWorldQuaternion(qG);
        // shoulders up on the breath in (each collar bone turned about his front-to-back axis)
        const rise = (cfg.humanBreathShoulder + cfg.humanBreathShoulderTired * td) * inB;
        if (rise > 1e-5) {
          vN.set(0, 0, 1).applyQuaternion(qG).normalize();
          for (const [a, sgn] of [['Left', 1], ['Right', -1]] as const) {
            const len = Math.max(0.05, arm[a][0].position.length());   // collar bone length, native m
            rotateWorld(clav[a], qR.setFromAxisAngle(vN, sgn * Math.atan2(rise, len)));
          }
        }
        // the head: hangs when tired, and the chin rides the breath (mouth breathing) — about his left axis, positive = chin down
        const nod = (cfg.humanTiredHeadHang * td - cfg.humanBreathHeadBob * td * (inB - 0.5) * 2) * Math.PI / 180;
        if (Math.abs(nod) > 1e-5) {
          vN.set(1, 0, 0).applyQuaternion(qG).normalize();
          qR.setFromAxisAngle(vN, nod * 0.5);
          const q2 = qI.copy(qR);   // (rotateWorld uses qL / qP only)
          rotateWorld(neck, q2);
          group.updateMatrixWorld(true);
          rotateWorld(head, q2);
        }
      } else softScale(1 - 0.6 * Math.min(0, bl), 1, 1 + bl, 1 - 0.6 * Math.min(0, sw), 1, 1 + sw);
      // the head and neck swing on past the hit: turned about the level axis square to the swing, so the crown goes along it
      if (Math.abs(soft.hx) + Math.abs(soft.hz) > 1e-4) {
        const ang = Math.min(0.5, Math.hypot(soft.hx, soft.hz));
        vN.set(soft.hz, 0, -soft.hx).normalize();   // up × swing
        const q2 = qI.setFromAxisAngle(vN, ang * 0.5);
        group.updateMatrixWorld(true);
        rotateWorld(neck, q2);
        group.updateMatrixWorld(true);
        rotateWorld(head, q2);
      }
      group.updateMatrixWorld(true);
      stamp('clip');

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

      stamp('drop');
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

      stamp('lean');
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

      stamp('aim');
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

      stamp('snap');
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

      stamp('impact');
      // (glove guard: the glove as the body alone puts it; a man who jumped more than half a metre is a new scene)
      gBase.Left.fromArray(gloveOf('Left')); gBase.Right.fromArray(gloveOf('Right'));
      const gFresh = Math.hypot(x - gX, z - gZ) > 0.5; gX = x; gZ = z;
      // AN UPPERCUT STOPS AT THE CHIN (humanUpperFollow): after its hit the take's follow-through carried the glove 30 cm
      // and more over the other man's head on a near-straight arm pointing up (filmed 2026-11-23); it may rise this far
      // past the contact, no further (then the glove guard below keeps the change smooth)
      // AND NO HOOK OR UPPERCUT LOOPS OVER HIS HEAD (humanPunchOverHead): mashed hooks, each cut by the next, finished
      // 20 cm and more above the other man's head with the arm raised like an overhand (filmed 2026-11-23)
      const capUpper = (): void => {
        const ci = anim.conformInfo, pt = next.punch.type, ob = drawnBodies[side === 0 ? 1 : 0];
        if ((pt !== 'uppercut' && pt !== 'hook') || next.punch.phase === 'cock' || VARIANTS[next.punch.variant].body) return;
        // (the ceiling is the upper half of his head: a hook lands on the side of the head, never over the crown)
        let maxY = cfg.humanPunchOverHead >= 0 && ob ? ob.head.y + 0.5 * ob.headR + cfg.humanPunchOverHead * group.scale.y : Infinity;
        if (pt === 'uppercut' && cfg.humanUpperFollow >= 0 && ci.resolved && ci.at && (ci.kind === 'land' || ci.kind === 'block')) maxY = Math.min(maxY, ci.at.y + cfg.humanUpperFollow * group.scale.y);
        if (!Number.isFinite(maxY)) return;
        // (the arm from the punch's own hand: after the hit the hand's aim request has eased off and out.ik is gone)
        const leadA = spec.stance === 'orthodox' ? 'Left' : 'Right';
        const a: 'Left' | 'Right' = next.punch.hand === 'lead' ? leadA : leadA === 'Left' ? 'Right' : 'Left';
        group.updateMatrixWorld(true);
        const G = new THREE.Vector3().fromArray(gloveOf(a));
        if (G.y <= maxY) return;
        const want = G.clone(); want.y = maxY;
        const [u, m, e] = arm[a], H = e.getWorldPosition(new THREE.Vector3()).add(want.clone().sub(G));
        for (let i = 0; i < 3; i++) { twoBone(u, m, e, H); group.updateMatrixWorld(true); H.add(want.clone().sub(vA.fromArray(gloveOf(a)))); }
      };
      const guardArgs = (): ['Left' | 'Right' | null, boolean, number, boolean] => {
        const ci = anim.conformInfo, land = ci.kind === 'land';
        return [next.punch.type !== null && out.ik ? out.ik.arm : null, land, ci.toHit, land && ci.resolved && landAge <= cfg.humanContactStick];
      };
      // ---- fist on target: two-bone IK on the punching arm, bell-weighted round the hit ----
      // (ik2: the previous punch's arm easing off the sim glove while a chained punch with the other arm runs)
      // The guard: every arm not in a live punch sits on the SIM's glove (guard, block, its recovery spring) by
      // humanGuardIK, so the guard drawn is the guard that blocks; a fading punch tail never drops below it.
      const reqs: (typeof out.ik)[] = [out.ik, out.ik2];
      // (outcome mode and the raw pose: the guard is the CLIP's guard — no hand is ever pulled to a sim glove)
      const gw = next.down || cfg.mocapOutcome || cfg.humanRawPose ? 0 : cfg.humanGuardIK;
      ikMax = 0; armDbg.length = 0;
      let outcomeT = null as THREE.Vector3 | null;   // the uncapped contact point of this frame's punch
      // (humanLandGap) the plain, unturned contact point (uncapped / capped like the hand's): what the body's lean and travel read
      let outcomePlain = null as THREE.Vector3 | null, plainAt = null as THREE.Vector3 | null;
      // outcome first: the punching hand moves at most mocapIKArmMax off the clip (clip elbow as pole); a BLOCKED punch
      // is steered onto the other man's DRAWN guard glove, not the sim's
      const simAt = out.ik?.outcome ? { ...out.ik.at } : null;   // the rule's own point, before it is moved onto the picture
      let clipG: THREE.Vector3 | null = null;                    // the punching glove where the clip alone has it this frame
      const contactDrawn = cfg.humanContactDrawn && cfg.humanInertia;
      // (how long ago his punch in flight was resolved: the landed glove follows the struck part for humanContactStick, then holds)
      if (out.ik?.outcome && anim.conformInfo.resolved) landAge += dt; else landAge = 0;
      leanPrev = leanUsed; leanUsed = 0;
      for (const a of ['Left', 'Right'] as const) { armPrev[a].copy(armUsed[a]); armUsed[a].set(0, 0, 0); if (armSeen[a]) armRawPrev[a].copy(armRaw[a]); armSeen[a] = false; }
      // (the stand-off of a glove that WILL land, before its hit tick: by the time left, and eased in — switched on whole
      //  it threw a glove that was already near him 20-50 cm in a tick)
      {
        const ci = anim.conformInfo;
        const want = contactDrawn && out.ik?.outcome && ci.kind === 'land' && !ci.resolved && next.punch.type !== null ? Math.min(cfg.humanContactStandoffMax, ci.toHit * cfg.humanContactCloseSpeed) : 0;
        earlyS = Math.min(want, earlyS + cfg.humanContactStandoffRate * dt);
      }
      // (humanLandGap: a new frame may ease the chosen contact once; no head land in flight = back to the plain point)
      gapStep = true;
      // (let go eased, never at once: reset in a tick it threw the glove of a punch on its way home 30-50 cm)
      if (!(next.punch.type !== null && anim.conformInfo.kind === 'land' && anim.conformInfo.part === 'head')) {
        const f = Math.exp(-dt / Math.max(1e-3, cfg.humanLandGapRelease)); gapYaw *= f; gapPitch *= f; gapPick = -1; gapHitYaw = NaN;
      }
      /** THE LAND FINDS THE GAP: the unit direction, from his head centre, the landing glove arrives along (see humanLandGap). */
      const landGap = (c: THREE.Vector3, d0: THREE.Vector3, ob: DrawnBody, rest: number): THREE.Vector3 => {
        const up = new THREE.Vector3(0, 1, 0), sideV = new THREE.Vector3(d0.z, 0, -d0.x).normalize();
        const pt = next.punch.type, ci = anim.conformInfo;
        const pa = out.ik?.arm ?? ((next.punch.hand === 'lead') === (spec.stance === 'orthodox') ? 'Left' : 'Right');
        const sgn = pt === 'hook' && arm[pa][0].getWorldPosition(new THREE.Vector3()).sub(c).dot(sideV) < 0 ? -1 : 1;
        const dirOf = (yw: number, pc: number): THREE.Vector3 => new THREE.Vector3().addScaledVector(d0, Math.cos(yw) * Math.cos(pc))
          .addScaledVector(sideV, sgn * Math.sin(yw) * Math.cos(pc)).addScaledVector(up, Math.sin(pc));
        if (gapStep) {
          gapStep = false;
          const D2R = Math.PI / 180;
          // the candidates, degrees [yaw toward the side it comes from, pitch up]
          const cands: [number, number][] = [];
          if (pt === 'hook') { for (const yf of [0, 0.35, 0.65, 1]) for (const pf of [-0.8, 0, 0.8]) cands.push([yf * cfg.humanLandGapHookYaw, pf * cfg.humanLandGapHookPitch]); }
          else if (pt === 'uppercut') { for (const yf of [-1, -0.33, 0.33, 1]) for (const pf of [0.4, 0.7, 1]) cands.push([yf * cfg.humanLandGapUpperYaw, -pf * cfg.humanLandGapUpperPitch]); }
          else { for (const yf of [-1, 0, 1]) for (const p of [-cfg.humanLandGapStraightDown, 0, cfg.humanLandGapStraightUp * 0.5, cfg.humanLandGapStraightUp]) cands.push([yf * cfg.humanLandGapStraightSide, p]); }
          // clearance of a candidate: the glove resting there, and the last stretch it comes in along, from his gloves / forearms / upper arms
          const gr = next.body.gloveR, FA = cfg.humanArmClearForearmR, UA = cfg.humanArmClearUpperArmR;
          const S0 = arm[pa][0].getWorldPosition(new THREE.Vector3()), Pplain = c.clone().addScaledVector(d0, ob.headR + rest);
          const clear = (yw: number, pc: number): number => {
            const dd = dirOf(yw * D2R, pc * D2R), P = c.clone().addScaledVector(dd, ob.headR + rest), Q = P.clone().addScaledVector(dd, cfg.humanLandGapApproach);
            // (the HAND only: a point further from his shoulder than the plain one would need more reach, and the body
            //  leans and travels for reach — 5-6 cm hip jumps on the hit tick of every straight)
            if (S0.distanceTo(P) > S0.distanceTo(Pplain) + 0.005) return -Infinity;
            let m = Infinity;
            for (const k of [0, 1] as const) for (const [p1, p2, r] of [[ob.gloves[k], ob.gloves[k], gr], [ob.el[k], ob.gloves[k], FA], [k === 0 ? ob.sl : ob.sr, ob.el[k], UA]] as const) {
              const [c1, c2] = segSegPts(P, Q, p1, p2);
              m = Math.min(m, c1.distanceTo(c2) - gr - r);
            }
            return m;
          };
          const score = (yw: number, pc: number, cl: number): number => cl - cfg.humanLandGapBias * Math.hypot(yw, pc) * D2R;
          // (picked once the land is known and the punch is on its way; re-picked only when the held point is blocked
          //  and another is clearer by humanLandGapMargin — the glove never darts between candidates)
          const going = ci.resolved || next.punch.phase !== 'cock';
          if (going && !ci.resolved) {
            let best = -1, bs = -Infinity, bc = 0;
            for (let i = 0; i < cands.length; i++) { const cl = clear(cands[i]![0], cands[i]![1]), s = score(cands[i]![0], cands[i]![1], cl); if (s > bs) { bs = s; best = i; bc = cl; } }
            if (gapPick < 0 || gapPick >= cands.length) gapPick = best;
            else {
              const cur = clear(cands[gapPick]![0], cands[gapPick]![1]);
              if (cur < 0 && bc > cur + cfg.humanLandGapMargin) gapPick = best;
            }
          }
          // (after the hit it is let go again over humanLandGapRelease, so the glove leaves from where it would have
          //  landed anyway: held, the turned contact made the weighted way home 30-50 cm a tick)
          const want: [number, number] = going && !ci.resolved && gapPick >= 0 && gapPick < cands.length ? cands[gapPick]! : [0, 0];
          // (eased in over the ticks left to the hit, so it is reached on the hit tick and not before)
          const k = ci.resolved ? 1 - Math.exp(-dt / Math.max(1e-3, cfg.humanLandGapRelease)) : Math.min(1, Math.max(dt, 1e-4) / Math.max(dt, ci.toHit, SIM_DT));
          if (ci.resolved) {
            // (after the hit: let go in a straight line to the plain point by humanLandGapRelease — at the end of the
            //  squash, before the glove goes home — so the way home starts where it would have with the key off)
            if (Number.isNaN(gapHitYaw)) { gapHitYaw = gapYaw; gapHitPitch = gapPitch; }
            const f = Math.max(0, 1 - landAge / Math.max(1e-3, cfg.humanLandGapRelease));
            gapYaw = gapHitYaw * f; gapPitch = gapHitPitch * f;
          } else if (!going) {
            // (a new punch starts from the plain point: no carry-over of the last one's turn)
            gapYaw = 0; gapPitch = 0; gapPick = -1; gapHitYaw = NaN;
          } else {
            gapHitYaw = NaN;
            // (and never faster than humanLandGapRate: picked late, a full turn in the last tick threw a hook 30-45 cm; what
            //  is not turned by the hit lands part-way round, still on his head)
            let dy = (want[0] * D2R - gapYaw) * k, dp = (want[1] * D2R - gapPitch) * k;
            const dl = Math.hypot(dy, dp), dm = cfg.humanLandGapRate * Math.max(dt, 1e-4);
            if (dl > dm) { dy *= dm / dl; dp *= dm / dl; }
            gapYaw += dy; gapPitch += dp;
          }
        }
        return dirOf(gapYaw, gapPitch).normalize();
      };
      const aimOutcome = (): void => {
        if (!(out.ik?.outcome && out.ik.w > 1e-3) || !simAt) { skinLand = 0; return; }
        const oppBody = drawnBodies[side === 0 ? 1 : 0];
        const T = new THREE.Vector3(simAt.x, simAt.y, simAt.z);
        const ci = anim.conformInfo;
        let gapPlain: THREE.Vector3 | null = null;
        outcomePlain = null; plainAt = null;
        if (ci.kind === 'block' && oppBody) {
          const g0 = oppBody.gloves[0], g1 = oppBody.gloves[1], gp = g0.distanceTo(T) <= g1.distanceTo(T) ? g0 : g1;
          const dir = new THREE.Vector3(x - gp.x, 0, z - gp.z).normalize();
          T.copy(gp).addScaledVector(dir, next.body.gloveR * (2 - cfg.contactSquash));
          // (humanBodyAim: a blocked BODY punch rests on his guard at belly-to-rib height, not wherever his guard glove sits)
          if (cfg.humanBodyHandAim && ci.part === 'body' && VARIANTS[next.punch.variant].body) T.y = Math.max(simAt.y - 0.1, Math.min(simAt.y + 0.08, gp.y));
        }
        // CONTACT: a landed glove rests on the other man's DRAWN head / torso surface (the rules' point, moved onto the picture)
        if (cfg.humanInertia && ci.kind === 'land' && oppBody) {
          const rest = next.body.gloveR * (1 - cfg.contactSquash);
          if (contactDrawn) {
            // NO PHANTOMS: the part that was SCORED, where it is DRAWN now (not the nearest surface to where his idle head
            // would be: reeling, punching or going to the body his drawn head is 10-27 cm from that), on the side facing the puncher
            if (ci.resolved && landAge > cfg.humanContactStick && landHeld) { T.copy(landT); if (landPlainOn) gapPlain = landPlain.clone(); }
            else {
              // (the body lane: humanBodyLane of the way up from his hips to his chest — the belly, not the breastbone)
              const c = ci.part === 'head' ? oppBody.head : vB.copy(oppBody.a).lerp(oppBody.b, cfg.humanBodyLane);
              const dir = new THREE.Vector3(x - c.x, 0, z - c.z);
              if (dir.lengthSq() < 1e-8) dir.set(Math.cos(yaw), 0, Math.sin(yaw)).negate();
              // (it ARRIVES on the hit tick, not before: steered on early, the glove sat on a face that then leaned away and
              //  the rules called a miss — 7% of live misses were drawn touching. Until the hit it stands off by its closing speed.)
              const off = ci.resolved ? 0 : earlyS;
              // ON THE SKIN (humanContactSkin): glove centre to part centre = how far HIS skin reaches from that centre along
              // the line + how far MY glove's skin reaches past my glove point toward him − the leather's give. MEASURED on the
              // real replay (2026-11-24): with the stand-in radii (mocapHeadR, mocapTorsoR, gloveR) the glove skin stopped
              // 4-9 cm short of the face skin on every land. Measured each frame from the skinned mesh: any body, any glove.
              const plainR = (ci.part === 'head' ? oppBody.headR : oppBody.r) + rest;
              const skinAt = ci.part !== 'head' && cfg.humanBodyHandAim && VARIANTS[next.punch.variant].body ? c.clone().setY(simAt.y) : c;
              const contactR = (dn: THREE.Vector3): number => {
                if (!cfg.humanContactSkin || !out.ik) return plainR;
                const sk = skins[side === 0 ? 1 : 0]?.(ci.part === 'head' ? 'head' : 'torso', skinAt, dn, ci.part === 'head' ? cfg.humanContactSkinBand : cfg.humanContactSkinBand * 1.6) ?? null;
                const gf = gloveFront(out.ik.arm, dn.clone().negate());
                return sk === null || gf === null ? plainR : sk + gf - cfg.humanContactSkinSink;
              };
              // THE LAND FINDS THE GAP (humanLandGap): on the head, the point it arrives at is turned within a cone that
              // suits the punch toward the part his arms leave open (the temple behind a glove at the cheek, over the
              // gloves, under them to the chin), chosen early, held, eased in
              const gapDir = ci.part === 'head' && cfg.humanLandGap ? landGap(c, dir.clone().normalize(), oppBody, rest) : null;
              if (gapDir) {
                // (the HAND only: everything else that reads the contact — the clip's reach, the body's lean and travel —
                //  is given the plain point, as with the key off: fed the turned one, head and feet jumped 10 cm)
                const dh = dir.clone().normalize(), R = contactR(dh);
                anim.feedTarget(c.x + dh.x * R, c.y, c.z + dh.z * R);
                gapPlain = c.clone().addScaledVector(dh, R + off);
                landPlain.copy(gapPlain);
                T.copy(c).addScaledVector(gapDir, contactR(gapDir) + off);
              } else {
              const dn = dir.clone().normalize(), R = contactR(dn);
              anim.feedTarget(c.x + dn.x * R, c.y, c.z + dn.z * R);
              T.copy(c).addScaledVector(dn, R + off);
              }
              // (the keep-out below holds the LANDING glove this far off the part's centre, not the stand-in radius: it was
              //  putting every skin contact back out at mocapHeadR + gloveR)
              if (cfg.humanContactSkin) skinLand = contactR(dir.clone().normalize());
              // (humanBodyAim: a landed body punch's glove is at the rules' contact height; the lane it rested on was 1-8 cm under it)
              if (cfg.humanBodyHandAim && ci.part === 'body' && VARIANTS[next.punch.variant].body) T.y = simAt.y;
              landT.copy(T); landHeld = true; landPlainOn = !!gapPlain;
            }
          } else {
            const P = closestOn(oppBody.a, oppBody.b, T);
            const dh = T.distanceTo(oppBody.head) - oppBody.headR, dt = T.distanceTo(P) - oppBody.r;
            const c = dh <= dt ? oppBody.head : P, r = dh <= dt ? oppBody.headR : oppBody.r;
            const dir = T.clone().sub(c);
            if (dir.lengthSq() < 1e-8) dir.set(x - c.x, 0, z - c.z);
            T.copy(c).add(dir.setLength(r + rest));
          }
        } else { landHeld = false; skinLand = 0; }
        outcomeT = T.clone();
        group.updateMatrixWorld(true);
        clipG ??= new THREE.Vector3().fromArray(gloveOf(out.ik.arm));
        const D = T.clone().sub(clipG), m = contactDrawn ? cfg.humanContactArmMax : cfg.mocapIKArmMax;
        if (D.length() > m) {
          // (humanBodyAim: a landed body punch keeps its HEIGHT when the correction is capped — the cap takes the rest from the
          //  distance along the line, which the body's travel closes: capped as a whole, the glove stopped 6-7 cm under the belly)
          if (cfg.humanBodyHandAim && ci.kind === 'land' && ci.part === 'body' && VARIANTS[next.punch.variant].body && Math.abs(D.y) < m) {
            const hz = Math.sqrt(m * m - D.y * D.y), hl = Math.hypot(D.x, D.z);
            if (hl > hz) { D.x *= hz / hl; D.z *= hz / hl; }
          } else D.setLength(m);
        }
        // (humanLandGap: the plain point, capped the same way, for the body's lean and travel)
        if (gapPlain) { outcomePlain = gapPlain.clone(); const Dp = gapPlain.clone().sub(clipG); if (Dp.length() > m) Dp.setLength(m); plainAt = clipG.clone().add(Dp); }
        T.copy(clipG).add(D);
        out.ik.at = { x: T.x, y: T.y, z: T.z };
        ikMax = D.length() * out.ik.w;
      };
      aimOutcome();
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
      stamp('fistIK');
      // ---- BODY AIM (humanBodyAim): a body punch's hand height is the other man's belly, eased in over the extension and out
      //      after the hit. The clip's own height wins otherwise: a body cross that missed was drawn at the knees, the body
      //      hooks at the shoulder. Only the height moves (the clip's reach and line stay); the puncher's crouch stays. ----
      // (run again after the arm clearance and the late pass: those moved a landed body glove 6-7 cm off its height)
      let baEnv = 0;
      const bodyAim = (first: boolean): void => {
        const ci = anim.conformInfo, np = next.punch, ob = drawnBodies[side === 0 ? 1 : 0];
        const live = cfg.humanBodyHandAim && cfg.mocapOutcome && !cfg.humanRawPose && !next.down && np.type !== null && out.ik && ob
          && VARIANTS[np.variant].body;   // (the level jab / cross / hook; an uppercut keeps its own rise)
        if (!live) { if (first) { baAge = 0; baEnv = 0; } return; }
        const landed = ci.kind === 'land' || ci.kind === 'block';
        if (first) {
          const smoothStep = (v: number): number => { const c = Math.max(0, Math.min(1, v)); return c * c * (3 - 2 * c); };
          if (ci.toHit <= 0 || ci.resolved) baAge += dt; else baAge = 0;
          baEnv = smoothStep(1 - ci.toHit / Math.max(1e-3, cfg.humanBodyAimLead)) * (1 - smoothStep((baAge - cfg.humanBodyAimHold) / Math.max(1e-3, cfg.humanBodyAimOut)));
        }
        if (baEnv <= 0.01) return;
        const targetY = landed && simAt ? simAt.y : vB.copy(ob.a).lerp(ob.b, 0.5).y;
        group.updateMatrixWorld(true);
        const [bu, bm, be] = arm[out.ik!.arm];
        const hp = be.getWorldPosition(new THREE.Vector3());
        hp.y += (targetY - gloveOf(out.ik!.arm)[1]!) * baEnv;
        twoBone(bu, bm, be, hp);
        group.updateMatrixWorld(true);
      };
      bodyAim(true);
      stamp('bodyAim');
      // CONTACT: what the arm at full stretch still lacks to the scored part, the upper body gives (he goes with the punch
      // from the hips), then the arm is solved again. Weighted like the hand, so it comes in with the extension.
      // (`ik`: the request the arm is solved with — the punch's own, weighted; or the late pass's exact one. What is given
      //  is what is OUT OF REACH: the shoulder's distance to the target beyond the arm's length — never the part the hand's
      //  own weight is still holding back.)
      const reachLean = (ik: NonNullable<typeof out.ik>): void => {
        if (!contactDrawn || cfg.humanContactLean <= 0 || ik.w <= 1e-3 || anim.conformInfo.kind !== 'land') return;
        // (humanLandGap: the body leans for the plain point; only the hand goes round to the turned one)
        const T = plainAt ? plainAt.clone() : new THREE.Vector3(ik.at.x, ik.at.y, ik.at.z);
        const [u, m, e] = arm[ik.arm];
        let room = cfg.humanContactLean, turned = false;
        // (twice: the shoulder moves on an arc about the hips, so one turn closes only part of a long reach)
        for (let pass = 0; pass < 2 && room > 0.005; pass++) {
          group.updateMatrixWorld(true);
          const S = u.getWorldPosition(new THREE.Vector3()), E = m.getWorldPosition(new THREE.Vector3()), W = e.getWorldPosition(new THREE.Vector3());
          const over = S.distanceTo(T) - (S.distanceTo(E) + E.distanceTo(W) + cfg.humanGloveOffset) * 0.995;
          if (pass === 0) reachDbg = [over, 0, ik.w, clipG ? T.distanceTo(clipG) : 0];
          if (over < 0.005) break;
          // (and it comes in at a pace: all at once on the hit tick it threw his own head 9-13 cm in a frame)
          const give = Math.min(over * ik.w, room, Math.max(0, leanPrev + cfg.humanContactLeanRate * Math.max(dt, SIM_DT * 0.5) - leanUsed));
          if (give < 0.002) break;
          room -= give; leanUsed += give;
          const P = spine[0]!.getWorldPosition(new THREE.Vector3());
          const r0 = S.clone().sub(P), r1 = r0.clone().addScaledVector(T.clone().sub(S).normalize(), give);
          qR.setFromUnitVectors(r0.normalize(), r1.normalize());
          rotateWorld(spine[0]!, qR);
          turned = true;
        }
        if (turned) { solveIK(ik); group.updateMatrixWorld(true); reachDbg[1] = T.distanceTo(vA.fromArray(gloveOf(ik.arm))); }
      };
      if (out.ik?.outcome && out.ik.w > 1e-3) reachLean(out.ik);
      stamp('reachLean');
      // CONTACT, closed loop: what the arm could not close (a straight arm, the capped correction) goes to the body travel
      if (cfg.humanInertia && outcomeT && out.ik && out.ik.w > 1e-3 && (anim.conformInfo.kind === 'land' || anim.conformInfo.kind === 'block')) {
        group.updateMatrixWorld(true);
        const G = vA.fromArray(gloveOf(out.ik.arm));
        // (only on the way in: after the hit the glove leaves the contact by itself, and the body must not chase it)
        // (humanLandGap: what the plain point lacks from where the hand would be aimed at it, as with the key off)
        if (outcomePlain && plainAt) G.addScaledVector(vB.set(out.ik.at.x, out.ik.at.y, out.ik.at.z).sub(plainAt), -out.ik.w);
        const oT = outcomePlain && plainAt ? outcomePlain : outcomeT;
        const ci = anim.conformInfo, resF = (oT.x - G.x) * Math.cos(yaw) + (oT.z - G.z) * Math.sin(yaw);
        // (with humanContactDrawn the body still goes after a landed glove for the moment it stays on the struck part)
        const stuck = contactDrawn && ci.kind === 'land' && ci.resolved && landAge <= cfg.humanContactStick;
        anim.feedReach(next.punch.resolved && !stuck ? 0 : resF, out.ik.w, contactDrawn && ci.kind === 'land' && (stuck || ci.toHit < 2.5 * SIM_DT));
      }
      // ---- THE OTHER HAND STAYS HOME through a body straight (humanOffHandHome): the body-cross take holds the lead glove
      //      out on the other man's belly for ten ticks before the cross (filmed 2026-11-20: a touch with no punch behind
      //      it); the hand that is not punching is brought back toward his own chin, eased in and out ----
      {
        const np = next.punch;
        const want = cfg.humanOffHandHome > 0 && cfg.mocapOutcome && !cfg.humanRawPose && !next.down && np.type !== null && (np.type === 'jab' || np.type === 'cross') && VARIANTS[np.variant].body && out.ik ? 1 : 0;
        if (dt > 1e-5) offHome += (want - offHome) * (1 - Math.exp(-dt / 0.07));
        if (offHome > 0.02 && out.ik) {
          const a = out.ik.arm === 'Left' ? 'Right' : 'Left';
          group.updateMatrixWorld(true);
          const [u, m, e] = arm[a];
          const hp = e.getWorldPosition(new THREE.Vector3());
          const chin = head.getWorldPosition(new THREE.Vector3());
          chin.x += Math.cos(yaw) * 0.16; chin.z += Math.sin(yaw) * 0.16; chin.y -= 0.05;
          const far = hp.distanceTo(chin);
          const k = cfg.humanOffHandHome * offHome * Math.max(0, Math.min(1, (far - 0.2) / 0.2));
          if (k > 0.01) { twoBone(u, m, e, hp.lerp(chin, k)); group.updateMatrixWorld(true); }
        }
      }
      stamp('offHand');
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

      stamp('tuckTired');
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
            reachLean(out.ik);
            for (let i = 0; i < bones.length; i++) { const q = bones[i]!.quaternion; inRot[i * 4] = q.x; inRot[i * 4 + 1] = q.y; inRot[i * 4 + 2] = q.z; inRot[i * 4 + 3] = q.w; }
            inertia.sync(inRot);
            group.updateMatrixWorld(true);
          }
        }
      }
      stamp('inertia');
      plantFeet();
      stamp('feet');

      // ---- outcome first: no glove of his ever inside the other man's DRAWN head or torso (a whiff, a dodge, a
      //      follow-through); a landed glove rests on the surface, where the contact point puts it ----
      const keepOut = (arms = true): void => {
        const ob = drawnBodies[side === 0 ? 1 : 0];
        // (a glove resting on the part it was scored on is not shoved off it by his shoulder line or neck)
        const landing = contactDrawn && out.ik?.outcome && out.ik.w > 0.5 && anim.conformInfo.kind === 'land' ? out.ik.arm : null;
        // (humanArmClear) the arm his punch is thrown with, and what each arm is doing: 0 guard, 1 a punch that will not land, 2 one that lands
        const leadArm = spec.stance === 'orthodox' ? 'Left' : 'Right';
        const punchArm = next.punch.type !== null ? (next.punch.hand === 'lead' ? leadArm : leadArm === 'Left' ? 'Right' : 'Left') : null;
        // (a land goes through only up to the moment it is on him: on its way home it is an arm like any other)
        // (and only from its extension: in the wind-up it is still his to pull out of the way)
        const actOf = (a: 'Left' | 'Right'): number => (a !== punchArm ? 0 : anim.conformInfo.kind === 'land'
          && (anim.conformInfo.resolved ? landAge < cfg.humanArmClearLandHold : next.punch.phase !== 'cock') ? 2 : 1);
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
          // (up to three passes an arm with humanContactDrawn: the wrist is aimed with the forearm as it lay BEFORE the bend,
          //  so one pass left a straight jab that had to fold back up to 10 cm inside his head for a tick)
          for (const a of (contactDrawn ? ['Left', 'Right', 'Left', 'Right', 'Left', 'Right'] : ['Left', 'Right']) as readonly ('Left' | 'Right')[]) {
            group.updateMatrixWorld(true);
            const G = new THREE.Vector3().fromArray(gloveOf(a));
            let push: THREE.Vector3 | null = null;
            // A MISS IS VISIBLY SHORT: the glove of a punch the rules call a whiff never comes within humanMissGap of him
            // (a DODGED punch too with humanContactDrawn: slipped or leaned away from, it is as visibly a miss as one out of range)
            const ck = anim.conformInfo.kind;
            const mine = next.punch.type !== null && out.ik?.arm === a;
            // (and a punch that WILL land does not touch before its hit tick: thrown from close the clip's own extension had
            //  the glove on the face 6 ticks before the land was scored and heard)
            // (only off the part it will land on: off his torso too, a rising uppercut was thrown out from his chest)
            const early = contactDrawn && mine && ck === 'land' && !anim.conformInfo.resolved ? earlyS : 0;
            // (the gap is for the MOMENT of the miss: with humanContactDrawn it is let go over the 0.2 s after the punch was
            //  resolved. Kept through the whole recovery it shoved a glove on its way home 30-40 cm in a frame when the man it
            //  had missed stepped in with his counter.)
            const gapK = contactDrawn && anim.conformInfo.resolved ? Math.max(0, Math.min(1, 1 - (landAge - 0.05) / 0.15)) : 1;
            const rest = rest0 + (cfg.humanInertia && mine && (ck === 'whiff' || (contactDrawn && ck === 'dodge')) ? cfg.humanMissGap * gapK : 0);
            // A PUNCH THAT MISSES COMES BACK THE WAY IT WENT: its glove, where it would be inside him, is drawn back along
            // the line to the puncher's own shoulder until it is clear — never shoved out sideways or on through him. The
            // nearest-way-out push flipped from his front to his back as he moved (traced: a slipped cross held off his
            // chest, squirted past his shoulder, then snapped 28-35 cm home in a frame).
            const pullBack = contactDrawn && mine && ck !== 'land' && ck !== 'block';
            if (pullBack) {
              const atB = anim.conformInfo.part === 'body';
              const hmin2 = ob.headR + (atB ? rest0 : rest), tmin2 = ob.r + (atB ? rest : rest0);
              const inside = (p: THREE.Vector3): boolean => p.distanceTo(ob.head) < hmin2 || p.distanceTo(closestOn(ob.a, ob.b, p)) < tmin2
                || (ob.sR > 0 && p.distanceTo(closestOn(ob.sl, ob.sr, p)) < ob.sR + rest0) || (ob.nR > 0 && p.distanceTo(closestOn(ob.b, ob.nk, p)) < ob.nR + rest0);
              if (inside(G)) {
                const d = arm[a][0].getWorldPosition(new THREE.Vector3()).sub(G).normalize(), q = G.clone();
                for (let i = 0; i < 50 && inside(q); i++) q.addScaledVector(d, 0.012);
                push = q;
              }
            }
            // (the shoulder line and the neck first, his head and torso LAST: pushed out of the neck in that order the glove
            //  could be left up to 5 cm inside the head — measured in live fights on misses)
            for (const [ca, cb, cr] of (pullBack ? [] : [[ob.sl, ob.sr, ob.sR], [ob.b, ob.nk, ob.nR]]) as readonly (readonly [THREE.Vector3, THREE.Vector3, number])[]) {
              if (cr <= 0 || landing === a) continue;
              // (the miss gap is kept off his head and torso only: off the shoulder line and neck as well, a missed glove
              //  passing beside his head was thrown 40 cm in a tick from one push to the next)
              const Q = closestOn(ca, cb, push ?? G), qmin = cr + (contactDrawn ? rest0 : rest);
              if ((push ?? G).distanceTo(Q) < qmin) push = Q.clone().add((push ?? G).clone().sub(Q).setLength(qmin));
            }
            // (the miss gap, like the stand-off, is kept off the part the punch was THROWN AT only. Traced 2026-11-20: a cross
            //  slipped by the head was held 20-30 cm back by the gap round his chest — it never extended — then squirted
            //  past and snapped home, 35 cm in a frame. A slipped head punch now goes by over the shoulder.)
            const atBody = anim.conformInfo.part === 'body';
            // (humanContactSkin: the landing glove is held off the part it LANDS on by the skin distance, not the stand-in)
            const onSkin = skinLand > 0 && mine && ck === 'land';
            const P = closestOn(ob.a, ob.b, push ?? G), td = (push ?? G).distanceTo(P), tmin = onSkin && atBody ? Math.min(skinLand, ob.r + rest) + early : ob.r + (!contactDrawn || atBody ? rest : rest0) + (atBody ? early : 0);
            if (td < tmin) push = P.clone().add((push ?? G).clone().sub(P).setLength(tmin));
            const hd = (push ?? G).distanceTo(ob.head), hmin = onSkin && !atBody ? Math.min(skinLand, ob.headR + rest) + early : ob.headR + (!contactDrawn || !atBody ? rest : rest0) + (!atBody ? early : 0);
            if (hd < hmin) push = ob.head.clone().add((push ?? G).clone().sub(ob.head).setLength(hmin));
            // GLOVE ON GLOVE: two guards never sit inside each other; each man gives half (a punch resting on his guard is left where the block put it)
            if (!cfg.humanArmClear && cfg.humanInertia && cfg.humanGloveClear > 0 && !(next.punch.type !== null && out.ik?.arm === a)) {
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
          // ARMS DO NOT PASS THROUGH ARMS (humanArmClear): his gloves, forearms and upper arms are capsules my glove and
          // forearm are kept out of. Who gives: a punch that LANDS gives nothing (it got through: the guard in its way is
          // moved aside, square to the punch, never back into his own face); a punch that is blocked or missed stops on the
          // guard; two guards, or two punches that cross, each give half. Run again after both men are posed (the late pass).
          if (arms && cfg.humanArmClear && cfg.humanInertia) {
            const FA = cfg.humanArmClearForearmR, UA = cfg.humanArmClearUpperArmR, gr = next.body.gloveR, mg = cfg.humanArmClearMargin;
            for (const a of ['Left', 'Right'] as const) {
              const mineAct = actOf(a);
              group.updateMatrixWorld(true);
              const [u, m, e] = arm[a];
              const S = u.getWorldPosition(new THREE.Vector3()), E = m.getWorldPosition(new THREE.Vector3()), G = new THREE.Vector3().fromArray(gloveOf(a));
              const D = new THREE.Vector3();
              const corridor = cfg.humanLandCorridor;
              // (humanLandCorridor: when my own punch lands, s to its hit tick, negative once landed; a trade goes to the first to land)
              const myEta = anim.conformInfo.resolved ? -landAge : anim.conformInfo.toHit;
              let laneOpen = false, laneEta = Infinity;
              // (humanLandCorridor, the last resort: my landing punch, still on its way, goes ROUND what is left of his arm in
              //  its path after he has given what he can, square to its own line, less and less as the hit tick comes)
              const myLane = corridor && mineAct === 2 && !anim.conformInfo.resolved && myEta > 0 && outcomeT && out.ik?.arm === a
                ? new THREE.Vector3().subVectors(outcomeT, G) : null;
              const bendW = myLane && myLane.length() > 0.01 ? cfg.humanLandCorridorBend * Math.min(1, myEta / (cfg.humanLandCorridorBendFade + 1e-6)) : 0;
              if (myLane) myLane.normalize();
              // (a land with right of way still runs the limiter below: a move left from last frame is let go at the rate, not dropped)
              if (corridor || !(mineAct === 2 && ob.act[0] !== 2 && ob.act[1] !== 2)) for (const k of [0, 1] as const) {
                const hisAct = ob.act[k];
                // (two lands crossing, a trade: each gives half; with humanLandCorridor the one that lands first owns the crossing)
                const hisEta = ob.laneEta[k];
                // (who lands first: my landing punch keeps its lane against one that lands after it)
                const iFirst = mineAct === 2 && myEta < hisEta - 1e-6 || (mineAct === 2 && Math.abs(myEta - hisEta) <= 1e-6 && side === 0);
                const w = corridor && mineAct === 2 && hisAct === 2 && Number.isFinite(hisEta) ? (iFirst ? 0 : 1)
                  : corridor && mineAct === 2 && hisAct !== 2 ? bendW
                  : mineAct === hisAct ? 0.5 : mineAct === 2 ? 0 : hisAct === 2 ? 1 : mineAct === 1 ? 1 : 0;
                // (the lane: every arm of mine gives way to a live one; my PUNCHING arm to one still in its wind-up too —
                //  a punch of mine that will not land, or lands after his, gets out of his landing punch's way early)
                const laneHere = corridor && Number.isFinite(hisEta) && (ob.laneLive[k] || mineAct >= 1);
                const wl = !laneHere ? 0 : mineAct === 2 && iFirst ? 0 : 1;
                if (w <= 0 && wl <= 0) continue;
                // (a landing punch's line: the guard yields square to it; my own landing punch bends square to ITS line)
                const along = hisAct === 2 ? new THREE.Vector3().subVectors(ob.gloves[k], ob.el[k]).normalize() : mineAct === 2 && myLane ? myLane : null;
                type Cap = readonly [THREE.Vector3, THREE.Vector3, number, THREE.Vector3 | null, number];
                const parts: Cap[] = w > 0 ? [[ob.gloves[k], ob.gloves[k], gr, along, w], [ob.el[k], ob.gloves[k], FA, along, w], [k === 0 ? ob.sl : ob.sr, ob.el[k], UA, along, w]] : [];
                const mineParts: (readonly [THREE.Vector3, THREE.Vector3, number])[] = [[G, G, gr], [E, G, FA]];
                // A LAND OPENS ITS LANE AHEAD OF TIME (humanLandCorridor): the path its glove has still to travel to the contact
                // point, and its forearm there, are kept clear from the moment it is known to land, at the corridor's pace;
                // the guard is split before the glove arrives, square to the lane, not run through.
                let laneLd: THREE.Vector3 | null = null;
                if (wl > 0) {
                  const to = ob.laneTo[k], run = new THREE.Vector3().subVectors(to, ob.gloves[k]);
                  if (run.length() > 0.01) {
                    laneLd = run.clone().normalize();
                    const fa = new THREE.Vector3().subVectors(ob.gloves[k], ob.el[k]).normalize();
                    parts.push([ob.gloves[k], to, gr, laneLd, wl], [ob.el[k].clone().add(run), to, FA, fa, wl]);
                    mineParts.push([S, E, UA]);
                    // (my own punch is checked along the way it is STILL GOING, not only where it is: thrown into his lane, a
                    //  straight covered 20 cm in a tick and was inside it before any push could act. Where they would cross,
                    //  mine is moved off now, at the corridor's pace)
                    if (mineAct >= 1 && cfg.humanLandCorridorAhead && !anim.conformInfo.resolved) {
                      const ci = anim.conformInfo;
                      const myTo = outcomeT && out.ik?.arm === a ? outcomeT : ci.at ? new THREE.Vector3(ci.at.x, ci.at.y, ci.at.z) : null;
                      if (myTo && myTo.distanceTo(G) > 0.01) mineParts.push([G, myTo, gr]);
                    }
                    laneOpen = true; laneEta = Math.min(laneEta, Math.max(0, hisEta));
                  }
                }
                for (const [pa, pb, pr, al, pw] of parts) for (const [qa, qb, qr] of mineParts) {
                  // (my upper arm is tested against the lane only: it moves with the elbow)
                  if ((qr === UA || (qa === G && qb !== G && qb !== E)) && pb !== ob.laneTo[k]) continue;
                  const [c1, c2] = segSegPts(qa === S ? qa : qa.clone().add(D), qb.clone().add(D), pa, pb);
                  const d = c1.distanceTo(c2), need = qr + pr + mg - d;
                  if (need <= 0 || d < 1e-5) continue;
                  const n = c1.sub(c2).divideScalar(d);
                  // (my own punch out of his lane is BRUSHED DOWN, not lifted over it nor dragged back through me)
                  if (pb === ob.laneTo[k] && mineAct >= 1 && cfg.humanLandCorridorDown > 0) { n.y -= cfg.humanLandCorridorDown; n.normalize(); }
                  let k2 = 1;
                  if (al) { n.addScaledVector(al, -n.dot(al)); const l = n.length(); if (l < 1e-2) n.set(0, -1, 0); else { n.divideScalar(l); k2 = 1 / Math.max(l, 0.4); } }
                  D.addScaledVector(n, need * pw * k2);
                }
              }
              armDbg.push(D.length());
              // CONTINUOUS IN TIME: the whole move this arm wants this frame (given so far + this solve), capped, may differ
              // from the one on screen last frame by humanArmClearRate only; what this solve applies is the rest of it
              const want = armUsed[a].clone().add(D);
              const wantMax = laneOpen ? Math.max(cfg.humanArmClearMax, cfg.humanLandCorridorMax) : cfg.humanArmClearMax;
              if (want.length() > wantMax) want.setLength(wantMax);
              // (how much: what the budget leaves after the glove's own move since last frame, between the floor and ceiling rates)
              const tick = Math.max(dt, SIM_DT * 0.5);
              if (!armSeen[a]) { armRaw[a].copy(G).sub(armUsed[a]); armSeen[a] = true; }
              const own = armRaw[a].distanceTo(armRawPrev[a]);
              const step = want.sub(armPrev[a]);
              let stepMax = Math.max(cfg.humanArmClearRate * tick, Math.min(cfg.humanArmClearRateMax * tick, cfg.humanArmClearBudget * tick - own));
              // (humanLandCorridor: a lane must be open by the hit tick: the guard in it is moved at the pace that gets it out
              //  by then, up to humanLandCorridorRate, knocked aside rather than eased)
              if (laneOpen) stepMax = Math.max(stepMax, Math.min(cfg.humanLandCorridorRate * tick, step.length() / Math.max(1, laneEta / SIM_DT)));
              if (step.length() > stepMax) step.setLength(stepMax);
              D.copy(armPrev[a]).add(step).sub(armUsed[a]);
              // NEVER INTO HIM: the move may not take the glove inside his head or torso, nor deeper than it already was
              // (pushed off his guard, a slipped jab was shoved 2-11 cm into his chest: the body pass above had already run).
              // Shortened, not turned: what is left of it is given next frame, at the rate.
              const clearOf = (p: THREE.Vector3): number => Math.min(p.distanceTo(ob.head) - ob.headR, p.distanceTo(closestOn(ob.a, ob.b, p)) - ob.r) - rest0;
              const floor = Math.min(clearOf(G), 0);
              if (D.lengthSq() > 1e-8 && clearOf(G.clone().add(D)) < floor) {
                let lo = 0, hi = 1;
                for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (clearOf(G.clone().addScaledVector(D, mid)) >= floor) lo = mid; else hi = mid; }
                D.multiplyScalar(lo);
              }
              // (humanLandCorridor: and a guard moved out of a lane is never moved into his OWN face or chest, nor deeper)
              const me = drawnBodies[side];
              if (laneOpen && me && D.lengthSq() > 1e-8) {
                const ownOf = (p: THREE.Vector3): number => Math.min(p.distanceTo(me.head) - me.headR, p.distanceTo(closestOn(me.a, me.b, p)) - me.r) - rest0;
                const f2 = Math.min(ownOf(G), 0);
                if (ownOf(G.clone().add(D)) < f2) {
                  let lo = 0, hi = 1;
                  for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; if (ownOf(G.clone().addScaledVector(D, mid)) >= f2) lo = mid; else hi = mid; }
                  D.multiplyScalar(lo);
                }
              }
              armUsed[a].add(D);
              if (D.lengthSq() < 1e-8) continue;
              // (the elbow and the glove go together: the whole forearm is moved, not bent round the contact)
              qR.setFromUnitVectors(E.clone().sub(S).normalize(), E.clone().add(D).sub(S).normalize());
              rotateWorld(u, qR);
              group.updateMatrixWorld(true);
              const G2 = G.clone().add(D), E2 = m.getWorldPosition(new THREE.Vector3());
              ikMax = Math.max(ikMax, D.length());
              twoBone(u, m, e, G2.clone().addScaledVector(G2.clone().sub(E2).normalize(), -cfg.humanGloveOffset));
            }
          }
          group.updateMatrixWorld(true);
        }
        // this man's drawn head sphere and torso line, for the other view (and the probe)
        const s = spec.heightM / cfg.mocapBandRefHeight;
        const db = drawnBodies[side] ?? (drawnBodies[side] = { head: new THREE.Vector3(), headR: 0, a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, gloves: [new THREE.Vector3(), new THREE.Vector3()], sl: new THREE.Vector3(), sr: new THREE.Vector3(), sR: 0, nk: new THREE.Vector3(), nR: 0,
          el: [new THREE.Vector3(), new THREE.Vector3()], act: [0, 0], laneTo: [new THREE.Vector3(), new THREE.Vector3()], laneEta: [NaN, NaN], laneLive: [false, false] });
        db.gloves[0].fromArray(gloveOf('Left')); db.gloves[1].fromArray(gloveOf('Right'));
        arm.Left[1].getWorldPosition(db.el[0]); arm.Right[1].getWorldPosition(db.el[1]);
        db.act[0] = actOf('Left'); db.act[1] = actOf('Right');
        // (humanLandCorridor) the lane of a landing punch: from its glove now to its contact point, until the hit tick
        for (const k of [0, 1] as const) {
          db.laneEta[k] = NaN; db.laneLive[k] = false;
          const ci = anim.conformInfo;
          // (in its wind-up already, once it is known to land: then only the other man's punching arm gives way to it)
          const early = cfg.humanLandCorridorEarly && db.act[k] === 1 && ci.kind === 'land' && !ci.resolved && next.punch.phase === 'cock';
          if (!cfg.humanLandCorridor || (db.act[k] !== 2 && !early)) continue;
          db.laneEta[k] = ci.resolved ? -landAge : ci.toHit;
          db.laneLive[k] = !early;
          const mineArm = out.ik?.arm === (k === 0 ? 'Left' : 'Right');
          if (!ci.resolved && outcomeT && mineArm) db.laneTo[k].copy(outcomeT);
          else if (!ci.resolved && ci.at) db.laneTo[k].set(ci.at.x, ci.at.y, ci.at.z);
          else db.laneTo[k].copy(db.gloves[k]);
        }
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
      };
      // (side 0's arms are cleared of side 1's in the late pass only: here side 1 is still last frame's pose)
      keepOut(side === 1 ||!(contactDrawn && cfg.mocapOutcome && !cfg.humanRawPose));
      stamp('keepOut');
      bodyAim(false);
      stamp('bodyAim2');
      // HANDS DOWN ON THE FIGHTER SCREENS (humanMenuHandsDown; Nate 2026-11-25: the guard's gloves hid every face in the menus):
      // both arms eased to hang at his sides while a menu shows him off. Drawn only; the fight never sets it.
      menuW += ((handsDown && cfg.humanMenuHandsDown ? 1 : 0) - menuW) * (1 - Math.exp(-Math.min(dt, 0.1) / Math.max(1e-3, cfg.humanMenuHandRate)));
      if (menuW > 1e-3) {
        group.updateMatrixWorld(true);
        const sL = arm.Left[0].getWorldPosition(new THREE.Vector3()), sR = arm.Right[0].getWorldPosition(new THREE.Vector3());
        const lat = sL.clone().sub(sR).setY(0).normalize();
        for (const [a, sgn, S] of [['Left', 1, sL], ['Right', -1, sR]] as const) {
          const [u, m, e] = arm[a];
          const qu = u.quaternion.clone(), qm = m.quaternion.clone();
          const T = S.clone().addScaledVector(lat, sgn * cfg.humanMenuHandOut * group.scale.y);
          T.y -= cfg.humanMenuHandDrop * group.scale.y;
          twoBone(u, m, e, T);
          const su = u.quaternion.clone(), sm = m.quaternion.clone();
          u.quaternion.copy(qu).slerp(su, menuW); m.quaternion.copy(qm).slerp(sm, menuW);
          group.updateMatrixWorld(true);
        }
      }
      // SETTLED AFTER BOTH MEN ARE POSED (humanContactDrawn): side 0 is drawn first, against side 1's body of the frame
      // before; once side 1 is posed, side 0's punching hand is put on (or kept off) the body that is on screen NOW.
      // Without it the first man's landed glove sat where the other's head WAS before the hit moved it.
      lates[side] = contactDrawn && cfg.mocapOutcome && !cfg.humanRawPose ? () => {
        if (out.ik?.outcome && out.ik.w > 1e-3) {
          // (the glove follows what the other man's body did THIS frame: moved by the weighted change of its target —
          //  at full weight, put on it exactly. Solved whole: a second weighted solve would compound the weight.)
          const old = new THREE.Vector3(out.ik.at.x, out.ik.at.y, out.ik.at.z);
          aimOutcome();
          const neu = new THREE.Vector3(out.ik.at.x, out.ik.at.y, out.ik.at.z), w = out.ik.w;
          group.updateMatrixWorld(true);
          const goal = w > 0.995 ? neu : new THREE.Vector3().fromArray(gloveOf(out.ik.arm)).addScaledVector(neu.clone().sub(old), w);
          const exact = { arm: out.ik.arm, w: 1, at: { x: goal.x, y: goal.y, z: goal.z }, exact: true, outcome: true };
          if (w > 0.995 || neu.distanceTo(old) > 1e-4) { solveIK(exact); if (w > 0.995) reachLean(exact); }
          if (cfg.humanInertia) { for (let i = 0; i < bones.length; i++) { const q = bones[i]!.quaternion; inRot[i * 4] = q.x; inRot[i * 4 + 1] = q.y; inRot[i * 4 + 2] = q.z; inRot[i * 4 + 3] = q.w; } inertia.sync(inRot); }
        }
        stamp('lateIK');
        keepOut();
        bodyAim(false);
        stamp('late');
        capUpper();
        guardGloves(dt, gFresh || next.down, ...guardArgs());
        stamp('guard');
      } : undefined;
      // (and side 1's gloves once more against side 0 as it now stands: its reach may have moved its own head)
      if (side === 1) { const l = lates[0]; lates[0] = undefined; if (l) { l(); keepOut(); } }
      // the glove guard last of all (side 0's runs in its late pass, once side 1 is posed)
      if (side === 1 || !lates[side]) { capUpper(); guardGloves(dt, gFresh || next.down, ...guardArgs()); stamp('guard'); }

      // record this man's drawn head (bone origin + ~9 cm to the head's centre) against the sim's sphere
      const hd = heads[side] ?? (heads[side] = { drawn: new THREE.Vector3(), sim: new THREE.Vector3() });
      head.getWorldPosition(hd.drawn);
      hd.drawn.y += 0.09 * group.scale.y;
      hd.sim.set(next.headBox.x, next.headBox.y, next.headBox.z);

      // ---- sweat off the head on clean / flush lands (rig/spray.ts), from the DRAWN head, along the punch ----
      wearStep(dt, next, events);
      if (cfg.humanSpray) {
        for (const e of events) {
          if (e.type !== 'punchLand' || e.target !== side || e.part !== 'head' || e.grade === 'glancing') continue;
          // (the wetter he is, the more comes off him: `wet` builds over the fight; his fatigue still counts as before)
          const n = Math.round(cfg.rigSprayCount * (e.grade === 'flush' ? 1 : 0.4) * (0.3 + 0.7 * Math.min(1, Math.max(wet, next.fatigue) + 0.4)));
          const dl = Math.hypot(e.impulse.x, e.impulse.z) || 1, off = next.body.headR * 1.6;
          spray.burst(n, { x: hd.drawn.x + e.impulse.x / dl * off, y: hd.drawn.y + next.body.headR * 0.3, z: hd.drawn.z + e.impulse.z / dl * off }, e.impulse, cfg.rigSpraySpeed, cfg.rigSpraySize, cfg.rigSprayLife);
          // BLOOD: only off a man who is cut, only on a clean or flush head shot (a flush one throws it all, a clean one half)
          if (cutAt >= 0 && cfg.humanBloodCount > 0) blood.burst(Math.round(cfg.humanBloodCount * (e.grade === 'flush' ? 1 : 0.5) * bloodAmt()), { x: hd.drawn.x + e.impulse.x / dl * off, y: hd.drawn.y + next.body.headR * 0.3, z: hd.drawn.z + e.impulse.z / dl * off }, e.impulse, cfg.rigSpraySpeed * 0.8, cfg.humanBloodSize, cfg.rigSprayLife);
          // ON THE CANVAS, where it would come down (out along the punch from under his head), and it stays: a few damp
          // spots of sweat once he is wet, a few of blood if he is cut
          const fl = e.grade === 'flush' ? 1 : 0.5, under = { x: hd.drawn.x, z: hd.drawn.z };
          stains.splat(Math.round(cfg.humanStainSweat * fl * wet), under, e.impulse, cfg.humanStainNear, cfg.humanStainFar, cfg.humanStainSpread, cfg.humanStainSweatSize, STAIN_SWEAT);
          if (cutAt >= 0) stains.splat(Math.round(cfg.humanStainBlood * fl * bloodAmt()), under, e.impulse, cfg.humanStainNear, cfg.humanStainFar, cfg.humanStainSpread, cfg.humanStainBloodSize, STAIN_BLOOD);
        }
      }
      spray.update(dt);
      blood.update(dt);
    }
  }
  (window as unknown as { __human?: Record<number, { label: () => string }> }).__human ??= {};
  (window as unknown as { __human: Record<number, { label: () => string }> }).__human[side] = view;
  return view;
}

/**
 * human/referee.ts — the Meshy referee (public/fighter/referee.glb, tools/blender/build_referee.mjs; the boxers'
 * 52-bone Mixamo skeleton) moved by his own Mixamo clips (public/fighter/referee_clips/,
 * tools/blender/build_referee_clips.mjs). Drawn only: ui/referee.ts still decides where he stands and faces, and
 * hands this a cue (what he is doing, what he watches, when to nod).
 *
 *   await preloadReferee();                       // once (ui/referee.ts starts it in human mode)
 *   const v = createRefereeBody(cfg, scene);      // null until loaded
 *   v.apply(state, cue, dt);                      // state = ui/referee.ts's FighterState (pos, vel, yaw)
 *
 * The pose each frame, all clips fitted onto his skeleton by core/mocapFit (the same fit the boxers use):
 *   base     the watch: breathing idle, settling into the crouched "monitoring" idle as the fighters close (cue.close);
 *            the count: the counting clip from the moment he arrives beside the fallen man
 *   walk     strafe left / right, walk back, walk forward, blended by the direction he moves in his own frame, all on
 *            one shared cycle advanced by the distance covered (so the feet keep to the floor), faded in with speed
 *   nod      the head-nod clip on the spine top, neck and head only, played once per cue.nod tick
 *   look     neck and head turned toward cue.look (the fighters, the man on the canvas), clamped
 * Layers change weight smoothly (refClipFade), never by a cut. cue.mode 'hide' takes him out of the picture (the
 * scenes with no clip for him yet: the winner's arm, the wave-off).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { REFEREE, type Config, type FighterState, type Vec3 } from '../core';
import { crossfade, decode, makePose, sample, type BakeIndex, type Clip, type ClipLib, type Pose } from '../core/mocapClip';
import { applyFit, buildFit, type Fit, type Skeleton } from '../core/mocapFit';

/** What ui/referee.ts wants him doing this frame. */
export interface RefCue {
  mode: 'watch' | 'count' | 'hide';
  /** 0..1: how close and busy the fighters are (1 = in an exchange): the crouched watch. */
  close: number;
  /** World point he looks at, or null (straight ahead). */
  look: Vec3 | null;
  /** Incremented to play one nod. */
  nod: number;
}

let src: { scene: THREE.Object3D; height: number; lib: ClipLib } | null = null;
let loading: Promise<void> | null = null;

/** Load referee.glb and his clips once. Safe to call every frame. */
export function preloadReferee(): Promise<void> {
  if (!loading) {
    loading = Promise.all([
      new GLTFLoader().loadAsync('/fighter/referee.glb'),
      fetch('/fighter/referee_clips/index.json').then(r => r.json() as Promise<BakeIndex>),
      fetch('/fighter/referee_clips/clips.bin').then(r => r.arrayBuffer()),
    ]).then(([g, index, bin]) => {
      const ex = (g.parser.json as { asset?: { extras?: { height?: number } } }).asset?.extras;
      src = { scene: g.scene, height: ex?.height ?? 1.8, lib: decode(index, bin) };
    }, e => { console.info('referee files not loaded; the old referee draws', e); });
  }
  return loading;
}
export const refereeReady = (): boolean => src !== null;

export interface RefereeBody { apply(s: FighterState, cue: RefCue, dt: number): void; dispose(): void }

/** The clips he uses (slugs in referee_clips/index.json, from Nate's file names). */
const CLIP = {
  breathe: 'breathing_idle', crouch: 'slight_crouch_monitoring_idle', count: 'counting', nod: 'thoughtful_head_nod',
  fwd: 'sad_walk', back: 'walking_backwards', left: 'walk_strafe_left', right: 'walk_strafe_right',
} as const;

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

const qP = new THREE.Quaternion(), qL = new THREE.Quaternion(), qT = new THREE.Quaternion();
const vA = new THREE.Vector3(), vB = new THREE.Vector3();
/** Apply a WORLD-space rotation r to bone b about its own pivot (as human/view.ts). */
function rotateWorld(b: THREE.Object3D, r: THREE.Quaternion): void {
  b.parent!.getWorldQuaternion(qP);
  qL.copy(qP).invert().multiply(r).multiply(qP);
  b.quaternion.premultiply(qL);
  b.updateMatrixWorld(true);
}
const smooth = (cur: number, want: number, dt: number, tau: number): number => cur + (want - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));

export function createRefereeBody(cfg: Config, parent: THREE.Object3D): RefereeBody | null {
  if (!src) { void preloadReferee(); return null; }
  const { lib } = src;
  const root = cloneSkinned(src.scene);
  const group = new THREE.Group();
  group.add(root);
  group.scale.setScalar(REFEREE.heightM / src.height);
  root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; } });
  parent.add(group);
  const { skel, bones } = skeletonOf(root);
  const fit: Fit = buildFit(lib.index.source, lib.bones, lib.index.parents, skel);
  const clip = (slug: string): Clip => { const c = lib.clips.get(slug); if (!c) throw new Error('referee clip missing: ' + slug); return c; };
  const C = Object.fromEntries(Object.entries(CLIP).map(([k, s]) => [k, clip(s)])) as Record<keyof typeof CLIP, Clip>;
  const nb = lib.bones.length;
  const P: Record<'a' | 'b' | 'base' | 'walk' | 'tmp', Pose> = { a: makePose(nb), b: makePose(nb), base: makePose(nb), walk: makePose(nb), tmp: makePose(nb) };
  const bi = (n: string): number => lib.bones.indexOf(n);
  const nodBones = ['Spine2', 'Neck', 'Head'].map(bi);
  const byName = (n: string): THREE.Bone => bones.find(b => b.name.replace(/^mixamorig:?/, '') === n)!;
  const neck = byName('Neck'), head = byName('Head');
  const hipsIx = fit.map[0]!;
  // cycle length (m of travel per clip loop) of each walk
  const walks = (['fwd', 'back', 'left', 'right'] as const).map(k => ({ k, c: C[k], net: Math.max(0.3, C[k].travel.net) }));

  let t = 0, cycle = 0, walkW = 0, crouchW = 0, countW = 0, countT = 0, nodT = -1, nodSeen = 0, lookYaw = 0, lookPitch = 0;
  const wDir = { fwd: 0, back: 0, left: 0, right: 0 };

  return {
    apply(s, cue, dt) {
      group.visible = cue.mode !== 'hide';
      t += dt;
      group.position.set(s.pos.x, 0, s.pos.z);
      group.rotation.y = Math.PI / 2 - s.yaw;
      if (!group.visible) return;
      const fx = Math.cos(s.yaw), fz = Math.sin(s.yaw);
      const vf = s.vel.x * fx + s.vel.z * fz, vr = -s.vel.x * fz + s.vel.z * fx;   // forward, right (m/s)
      const speed = Math.hypot(vf, vr);
      const fade = cfg.refClipFade;

      // ── base: watch (breathing -> crouched with the fighters' closeness) or the count ──
      crouchW = smooth(crouchW, cue.close, dt, fade * 2);
      if (cue.mode === 'count' && countW < 0.01) countT = 0;
      countW = smooth(countW, cue.mode === 'count' ? 1 : 0, dt, fade);
      countT += dt;
      sample(lib, C.breathe, t, { loop: true, root: 'inPlace' }, P.base);
      if (crouchW > 0.001) crossfade(P.base, sample(lib, C.crouch, t, { loop: true, root: 'inPlace' }, P.a), crouchW, P.base);
      if (countW > 0.001) crossfade(P.base, sample(lib, C.count, countT, { loop: true, root: 'inPlace' }, P.a), countW, P.base);

      // ── walk: directional blend on one shared cycle ──
      const sp = speed > 1e-4 ? speed : 1;
      const want = { fwd: Math.max(0, vf) / sp, back: Math.max(0, -vf) / sp, right: Math.max(0, vr) / sp, left: Math.max(0, -vr) / sp };
      for (const k of ['fwd', 'back', 'left', 'right'] as const) wDir[k] = smooth(wDir[k], speed > 0.05 ? want[k] : wDir[k], dt, fade * 0.5);
      const wsum = wDir.fwd + wDir.back + wDir.left + wDir.right || 1;
      const net = walks.reduce((a, w) => a + w.net * wDir[w.k] / wsum, 0);
      cycle += dt * speed / net;   // one clip loop per its own travel: the feet keep to the floor at any speed
      walkW = smooth(walkW, Math.max(0, Math.min(1, (speed - cfg.refWalkFrom) / Math.max(0.01, cfg.refWalkFull - cfg.refWalkFrom))), dt, fade * 0.5);
      if (walkW > 0.001) {
        let acc = 0;
        for (const w of walks) {
          const ww = wDir[w.k] / wsum;
          if (ww < 0.01) continue;
          sample(lib, w.c, (cycle % 1) * w.c.duration, { loop: true, root: 'inPlace' }, P.b);
          acc += ww;
          if (acc === ww) { P.walk.rot.set(P.b.rot); P.walk.hips.set(P.b.hips); } else crossfade(P.walk, P.b, ww / acc, P.walk);
        }
        crossfade(P.base, P.walk, walkW, P.base);
      }

      // ── nod: once per cue.nod tick, on the spine top, neck and head ──
      if (cue.nod !== nodSeen) { nodSeen = cue.nod; nodT = 0; }
      if (nodT >= 0) {
        nodT += dt;
        const d = C.nod.duration, e = Math.min(0.35, d / 4);
        const nw = Math.max(0, Math.min(1, nodT / e, (d - nodT) / e));
        if (nodT >= d) nodT = -1;
        else {
          sample(lib, C.nod, nodT, { root: 'inPlace' }, P.tmp);
          for (const b of nodBones) {
            const o = b * 4, r = P.base.rot, n = P.tmp.rot;
            const sg = r[o]! * n[o]! + r[o + 1]! * n[o + 1]! + r[o + 2]! * n[o + 2]! + r[o + 3]! * n[o + 3]! < 0 ? -1 : 1;
            for (let k = 0; k < 4; k++) r[o + k] = r[o + k]! * (1 - nw) + sg * n[o + k]! * nw;
            const l = Math.hypot(r[o]!, r[o + 1]!, r[o + 2]!, r[o + 3]!) || 1;
            for (let k = 0; k < 4; k++) r[o + k] = r[o + k]! / l;
          }
        }
      }

      // ── onto the skeleton ──
      const out = applyFit(fit, P.base);
      for (let i = 0; i < bones.length; i++) { const q = out.localRot[i]!; bones[i]!.quaternion.set(q[0], q[1], q[2], q[3]); }
      bones[hipsIx]!.position.set(out.hipsPos[0], out.hipsPos[1], out.hipsPos[2]);
      group.updateMatrixWorld(true);

      // ── look: neck and head turn toward what he watches ──
      let wy = 0, wp = 0;
      if (cue.look) {
        head.getWorldPosition(vA);
        vB.set(cue.look.x - vA.x, cue.look.y - vA.y, cue.look.z - vA.z);
        const lf = vB.x * fx + vB.z * fz, lr = -vB.x * fz + vB.z * fx;
        const max = cfg.refLookMaxDeg * Math.PI / 180;
        wy = Math.max(-max, Math.min(max, Math.atan2(lr, Math.max(1e-3, lf))));
        wp = Math.max(-0.6, Math.min(0.35, Math.atan2(vB.y, Math.hypot(lf, lr))));
      }
      lookYaw = smooth(lookYaw, wy, dt, 1 / cfg.refLookLambda);
      lookPitch = smooth(lookPitch, wp, dt, 1 / cfg.refLookLambda);
      const right = vB.set(-fz, 0, fx);
      for (const [b, share] of [[neck, cfg.refLookNeckShare], [head, 1 - cfg.refLookNeckShare]] as const) {
        rotateWorld(b, qT.setFromAxisAngle(vA.set(0, 1, 0), -lookYaw * share));       // yaw about up (+right turns clockwise from above)
        rotateWorld(b, qT.setFromAxisAngle(right, lookPitch * share));                 // pitch about his right (+ = up)
      }
    },
    dispose() {
      parent.remove(group);
      root.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    },
  };
}

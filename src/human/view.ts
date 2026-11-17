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
import { decode, type BakeIndex, type ClipLib, type Roles } from './clip';
import { applyFit, buildFit, type Fit, type FitOut, type Skeleton } from './retarget';
import { HumanAnim } from './anim';

interface Assets { boxer: BoxerAssets; lib: ClipLib; roles: Roles; index: BakeIndex }
let assets: Assets | null = null;
/**
 * Where each human fighter's head is DRAWN vs where the sim's head sphere is (last frame). The mocap body
 * stands lower and leans further than the sim's shapes, so a fist aimed at the sim's head would land above
 * the drawn one: the hand IK shifts a head-bound target by the opponent's difference.
 */
const heads: ({ drawn: THREE.Vector3; sim: THREE.Vector3 } | null)[] = [null, null];

/** Load the body and the clips once. Resolves to false (and logs) if anything is missing. */
export async function preloadHuman(): Promise<boolean> {
  if (assets) return true;
  try {
    const [boxer, index, bin, roles] = await Promise.all([
      loadBoxer(),
      fetch('/fighter/clips/index.json').then(r => r.json() as Promise<BakeIndex>),
      fetch('/fighter/clips/clips.bin').then(r => r.arrayBuffer()),
      fetch('/fighter/clips/roles.json').then(r => r.json() as Promise<Roles>),
    ]);
    assets = { boxer, lib: decode(index, bin), roles, index };
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
  const anim = new HumanAnim(lib, roles, side, spec.stance, cfg);
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
      // ---- place: interpolated floor position, facing yaw (the clips face +Z), scaled to his height ----
      const x = prev.pos.x + (next.pos.x - prev.pos.x) * alpha, z = prev.pos.z + (next.pos.z - prev.pos.z) * alpha;
      let dy = next.yaw - prev.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const yaw = prev.yaw + dy * alpha;
      // stand back along his facing so the leaning mocap head sits over the sim's head (cfg.humanBackShift)
      group.position.set(x - Math.cos(yaw) * cfg.humanBackShift, 0, z - Math.sin(yaw) * cfg.humanBackShift);
      group.rotation.y = Math.PI / 2 - yaw;
      group.visible = true;

      // ---- pose from the clips ----
      const out = anim.update(prev, next, alpha, Math.min(dt, 0.1), events);
      label = out.label;
      applyFit(fit, out.pose, fitOut);
      for (let i = 0; i < bones.length; i++) { const r = fitOut.localRot[i]!; bones[i]!.quaternion.set(r[0], r[1], r[2], r[3]); }
      hips.position.set(fitOut.hipsPos[0], fitOut.hipsPos[1], fitOut.hipsPos[2]);
      group.updateMatrixWorld(true);

      // ---- procedural lean (slips without a clip, the blocked-shot jolt): spread over the three spine bones ----
      const { lat, back, fwd } = out.lean;
      if (Math.abs(lat) + Math.abs(back) + Math.abs(fwd) > 1e-4) {
        const H = 0.62;   // head above the lower spine, m
        const roll = Math.asin(Math.max(-0.9, Math.min(0.9, lat / H)));       // model +Z forward, +X his left
        const pitch = Math.asin(Math.max(-0.9, Math.min(0.9, back / H))) - Math.acos(Math.max(0, 1 - Math.min(0.5, fwd) / H));
        // model-space rotation: -roll about +Z puts the head to +X; -pitch about +X puts it back (-Z)
        qR.setFromEuler(new THREE.Euler(-pitch, 0, -roll, 'XYZ'));
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

      // ---- fist on target: two-bone IK on the punching arm, bell-weighted round the hit ----
      if (out.ik && cfg.humanHandIK) {
        const [up, fore, hand] = arm[out.ik.arm];
        up.getWorldPosition(vS); fore.getWorldPosition(vE); hand.getWorldPosition(vW);
        vT.set(out.ik.at.x, out.ik.at.y, out.ik.at.z);
        const opp = heads[side === 0 ? 1 : 0];
        if (opp) {
          const k = Math.max(0, Math.min(1, 1 - (vT.distanceTo(opp.sim) - 0.15) / 0.3));   // only a target at the head
          vT.addScaledVector(vA.subVectors(opp.drawn, opp.sim), k);
        }
        // aim the wrist short of the glove centre along the shoulder -> glove line
        vA.subVectors(vT, vS);
        const reach = vA.length();
        vT.addScaledVector(vA.normalize(), -Math.min(cfg.humanGloveOffset, reach * 0.5));
        const a = vE.distanceTo(vS), b = vW.distanceTo(vE);
        const c = Math.max(Math.abs(a - b) + 1e-3, Math.min(a + b - 1e-4, vT.distanceTo(vS)));
        const w = out.ik.w;
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
        // weight
        up.quaternion.copy(save[0]!.slerp(up.quaternion, w));
        fore.quaternion.copy(save[1]!.slerp(fore.quaternion, w));
      }
      // record this man's drawn head (bone origin + ~9 cm to the head's centre) against the sim's sphere
      const hd = heads[side] ?? (heads[side] = { drawn: new THREE.Vector3(), sim: new THREE.Vector3() });
      head.getWorldPosition(hd.drawn);
      hd.drawn.y += 0.09 * group.scale.y;
      hd.sim.set(next.headBox.x, next.headBox.y, next.headBox.z);
    },
    highlight(): void { /* the read's warm rim: not drawn on the human body yet */ },
    setFace(): void { /* no face rig yet */ },
    setBodyState(): void { /* no sweat / damage layer yet */ },
    dispose(): void {
      parent.remove(group);
      heads[side] = null;
      model.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach(mt => mt.dispose());
      });
    },
  };
  (window as unknown as { __human?: Record<number, { label: () => string }> }).__human ??= {};
  (window as unknown as { __human: Record<number, { label: () => string }> }).__human[side] = view;
  return view;
}

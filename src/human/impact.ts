/**
 * Impact layer: the head whips, the torso folds and the face reacts at the INSTANT of a land, on top of the
 * hit-reaction clip. Pure and deterministic: no three.js, no DOM, no clocks, no Math.random; all time comes
 * from dt. Drawn only (the sim never reads it).
 *
 * HOW THE VIEW CALLS IT (per fighter `side`, one impact state each):
 *   1. once per SIM tick:  impactOnEvents(state, side, tickEvents, simFighterState, cfg)
 *   2. every tick / frame: impactStep(state, dt)               (dt = the sim step, or the frame time)
 *   3. impactPose(state, fighterYaw, out), then apply `out` AFTER the clip pose and BEFORE arm IK:
 *      for each named bone, compose out.rot[bone] onto the bone's WORLD rotation about the FIGHTER's axes
 *      (newWorld = qFighter * out.rot * inverse(qFighter) * oldWorld, with qFighter = rotation about Y by
 *      the fighter's facing), and add out.hips (local metres, same frame) to the Hips position. Set
 *      out.face on the skin mesh's morphTargetInfluences by name (hitWince, jawOpen, cheekL, cheekR) when
 *      those names exist.
 *
 * LOCAL FRAME (the mocap convention of core/mocapClip.ts): +Y up, +Z the way he faces, +X his LEFT.
 *   rotation about +X by a positive angle = tip forward (pitch forward / fold / chin down); NEGATIVE = back (chin up)
 *   rotation about +Y by a positive angle = turn toward his LEFT; NEGATIVE = toward his right
 *   rotation about +Z by a positive angle = top goes toward his RIGHT (left side up); NEGATIVE = toward his left
 *   hips translation: -Z = back.
 * Event conversion: the sim frame has forward = (cos yaw, sin yaw), right = (-sin yaw, cos yaw); the event's
 * `impulse` is world-space and points the way the punch travels (attacker toward target), so the head goes
 * the way it points. punchBlock carries no impulse: the shove is straight back.
 */
import type { Config } from '../core/config';
import type { FighterState, SimEvent } from '../core/types';
import { qmul, type Quat, type Vec3 } from '../core/mocapClip';

export type ImpactBone = 'Head' | 'Neck' | 'Spine2' | 'Spine1' | 'Spine' | 'Hips';
export interface ImpactFace { hitWince: number; jawOpen: number; cheekL: number; cheekR: number }
export interface ImpactPose { rot: Record<ImpactBone, Quat>; hips: Vec3; face: ImpactFace }

interface Feed { delay: number; rem: number; dur: number; amt: number }
interface Chan { x: number; v: number; w: number; z: number; feeds: Feed[] }
export interface ImpactState {
  ch: Chan[]; wince: number; jaw: number; cheekL: number; cheekR: number;
  /** decay times and bone shares, refreshed from the config at every impactOnEvents call */
  wT: number; jT: number; cT: number; headShare: number; spineShare: number;
}

// channel indices
const HP = 0, HY = 1, HR = 2;          // head group pitch / yaw / roll (total of Head + Neck), rad
const SP = 3, SY = 4, SR = 5;          // Spine2 pitch / yaw / roll, rad
const BF = 6, BR = 7, HB = 8, HD = 9;  // torso fold, torso roll, hips back (m), head dip, (slow group)

const D2R = Math.PI / 180;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export function createImpact(): ImpactState {
  const ch: Chan[] = [];
  for (let i = 0; i < 10; i++) ch.push({ x: 0, v: 0, w: 20, z: 0.6, feeds: [] });
  return { ch, wince: 0, jaw: 0, cheekL: 0, cheekR: 0, wT: 0.3, jT: 0.4, cT: 0.12, headShare: 0.65, spineShare: 0.6 };
}

const gainCache = new Map<string, number>();
/** The spring eats part of a ramp while it is still being fed; this is the peak / amount ratio, so the configured angles ARE the peaks. */
function peakGain(dur: number, w: number, z: number): number {
  const key = `${dur}|${w}|${z}`;
  let g = gainCache.get(key);
  if (g === undefined) {
    const h = 1 / 60, n = Math.max(1, Math.round(dur / h)); // the sim's own step, so the stepped peak matches
    let x = 0, v = 0, pk = 0;
    for (let i = 0; i < 100; i++) {
      if (i < n) x += 1 / n;
      v += (-w * w * x - 2 * z * w * v) * h; x += v * h;
      if (x > pk) pk = x;
    }
    g = pk > 1e-6 ? 1 / pk : 1;
    gainCache.set(key, g);
  }
  return g;
}

function feed(s: ImpactState, c: number, amt: number, delay: number, dur: number): void {
  const ch = s.ch[c]!;
  if (amt !== 0) ch.feeds.push({ delay, rem: dur, dur, amt: amt * peakGain(dur, ch.w, ch.z) });
}

/** Start the response to this tick's events. */
export function impactOnEvents(s: ImpactState, side: 0 | 1, events: readonly SimEvent[], fs: Pick<FighterState, 'yaw'>, cfg: Config): void {
  if (!cfg.impactOn) return;
  // spring rates from the config's recovery times (settle in ~4 / (zeta w))
  for (let i = 0; i < 10; i++) {
    const c = s.ch[i]!, slow = i >= BF;
    c.z = slow ? cfg.impactBodyDamping : cfg.impactHeadDamping;
    c.w = 4 / (c.z * (slow ? cfg.impactBodyRecover : cfg.impactHeadRecover));
  }
  s.wT = cfg.impactWinceTime; s.jT = cfg.impactJawTime; s.cT = cfg.impactCheekTime;
  s.headShare = cfg.impactHeadShare; s.spineShare = cfg.impactBodySpineShare;
  const cy = Math.cos(fs.yaw), sy = Math.sin(fs.yaw);
  for (const e of events) {
    if (e.type === 'punchBlock' && e.target === side) {
      const a = cfg.impactBlockDeg * D2R;
      feed(s, HP, -a * 0.5, 0, cfg.impactHeadAttack);
      feed(s, SP, -a, 0, cfg.impactHeadAttack);
      continue;
    }
    if (e.type !== 'punchLand' || e.target !== side) continue;
    const grade = e.grade === 'flush' ? cfg.impactFlush : e.grade === 'clean' ? cfg.impactClean : cfg.impactGlance;
    const k = grade * (1 + cfg.impactPowerGain * (clamp(e.power, 0, 2) - 1)) * (e.counter ? cfg.impactCounter : 1);
    // travel direction in his own frame (tf < 0: the punch travels against his facing, i.e. hits his front; tr > 0: toward his right)
    let tf = e.impulse.x * cy + e.impulse.z * sy;
    let tr = -e.impulse.x * sy + e.impulse.z * cy;
    const n = Math.hypot(tf, tr);
    if (n < 1e-6) { tf = -1; tr = 0; } else { tf /= n; tr /= n; }
    const upper = e.punch.includes('ppercut'), hook = !upper && e.punch.includes('ook');
    const hookW = hook ? 1 : 0.3, fwdW = hook ? 0.3 : 1;
    const atk = cfg.impactHeadAttack;
    if (e.part === 'head') {
      let pitch: number, yaw: number, roll: number;
      if (upper) {
        pitch = -cfg.impactUpperDeg * k; yaw = -tr * cfg.impactHookYawDeg * 0.3 * k; roll = tr * cfg.impactHookRollDeg * 0.3 * k;
      } else {
        pitch = tf * fwdW * cfg.impactStraightDeg * k;
        yaw = -tr * hookW * cfg.impactHookYawDeg * k;
        roll = tr * hookW * cfg.impactHookRollDeg * k;
      }
      pitch *= D2R; yaw *= D2R; roll *= D2R;
      feed(s, HP, pitch, 0, atk); feed(s, HY, yaw, 0, atk); feed(s, HR, roll, 0, atk);
      const d = cfg.impactShoulderDelay, sh = cfg.impactShoulderShare;
      feed(s, SP, pitch * sh, d, atk); feed(s, SY, yaw * sh, d, atk); feed(s, SR, roll * sh, d, atk);
      if (e.grade !== 'glancing') s.wince = Math.max(s.wince, 1);
      if (upper) s.jaw = Math.max(s.jaw, clamp(k, 0, 1));
      if (hook) { const f = clamp(k, 0, 1); if (tr > 0) s.cheekL = Math.max(s.cheekL, f); else s.cheekR = Math.max(s.cheekR, f); }
    } else {
      const ba = cfg.impactBodyAttack;
      // (a body shot is never a small reaction: a glancing one folded him 6 degrees, which nobody could see)
      const kb = Math.max(k, cfg.impactBodyMin);
      feed(s, BF, cfg.impactBodyFlexDeg * kb * D2R, 0, ba);
      feed(s, BR, -tr * hookW * cfg.impactBodyRollDeg * kb * D2R, 0, ba);
      feed(s, HB, -cfg.impactBodyHipsBack * kb, 0, ba);
      feed(s, HD, cfg.impactBodyHeadDipDeg * kb * D2R, 0, ba);
      s.jaw = Math.max(s.jaw, clamp(cfg.impactJawBody * k, 0, 1));
    }
  }
}

/** Advance the springs and the face decays by dt seconds. */
export function impactStep(s: ImpactState, dt: number): void {
  for (const c of s.ch) {
    for (let i = c.feeds.length - 1; i >= 0; i--) {
      const f = c.feeds[i]!;
      let h = dt;
      if (f.delay > 1e-9) { const used = Math.min(h, f.delay); f.delay -= used; h -= used; }
      if (h > 0) {
        const use = Math.min(h, f.rem);
        c.x += f.amt * use / f.dur;
        f.rem -= use;
        if (f.rem < 1e-7) c.feeds.splice(i, 1);
      }
    }
    c.v += (-c.w * c.w * c.x - 2 * c.z * c.w * c.v) * dt;
    c.x += c.v * dt;
  }
  s.wince = Math.max(0, s.wince - dt / s.wT);
  s.jaw = Math.max(0, s.jaw - dt / s.jT);
  s.cheekL = Math.max(0, s.cheekL - dt / s.cT);
  s.cheekR = Math.max(0, s.cheekR - dt / s.cT);
}

/** Small-angle rotation: pitch about +X, yaw about +Y, roll about +Z, composed Y * X * Z. */
function euler(p: number, y: number, r: number): Quat {
  const qx: Quat = [Math.sin(p / 2), 0, 0, Math.cos(p / 2)];
  const qy: Quat = [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
  const qz: Quat = [0, 0, Math.sin(r / 2), Math.cos(r / 2)];
  return qmul(qmul(qy, qx), qz);
}

/** Current additive pose in the fighter's local frame (see the header). `fighterYaw` is unused: the frame is already his own. */
export function impactPose(s: ImpactState, _fighterYaw: number, out: ImpactPose): ImpactPose {
  const c = s.ch, hs = s.headShare;
  const hp = c[HP]!.x, hy = c[HY]!.x, hr = c[HR]!.x;
  out.rot.Head = euler(hp * hs + c[HD]!.x, hy * hs, hr * hs);
  out.rot.Neck = euler(hp * (1 - hs), hy * (1 - hs), hr * (1 - hs));
  out.rot.Spine2 = euler(c[SP]!.x, c[SY]!.x, c[SR]!.x);
  const ss = s.spineShare;
  out.rot.Spine = euler(c[BF]!.x * ss, 0, c[BR]!.x * ss);
  out.rot.Spine1 = euler(c[BF]!.x * (1 - ss), 0, c[BR]!.x * (1 - ss));
  out.rot.Hips = [0, 0, 0, 1];
  out.hips[0] = 0; out.hips[1] = 0; out.hips[2] = c[HB]!.x;
  out.face.hitWince = clamp(s.wince, 0, 1); out.face.jawOpen = clamp(s.jaw, 0, 1);
  out.face.cheekL = clamp(s.cheekL, 0, 1); out.face.cheekR = clamp(s.cheekR, 0, 1);
  return out;
}

export function makeImpactPose(): ImpactPose {
  return { rot: { Head: [0, 0, 0, 1], Neck: [0, 0, 0, 1], Spine2: [0, 0, 0, 1], Spine1: [0, 0, 0, 1], Spine: [0, 0, 0, 1], Hips: [0, 0, 0, 1] },
    hips: [0, 0, 0], face: { hitWince: 0, jawOpen: 0, cheekL: 0, cheekR: 0 } };
}

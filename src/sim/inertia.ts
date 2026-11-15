/**
 * sim/inertia.ts — joint-space inertialization (slice A2, cfg.inertiaOn; docs/anim/LOG_SMOOTH.md).
 *
 * The pose in f.skel is final after the last stepArms. A cut between two motions (cross into hook, block into jab, a
 * slip, a guard change) turns a joint by 50 to 126 degrees in ONE tick. This pass runs on that pose, once per tick:
 * per joint it keeps last tick's OUTPUT rotation and OUTPUT turn, and lets the turn change by no more than
 * inertiaMaxAccel (deg per tick squared). What the limit holds back is an offset (the output lags the pose underneath),
 * and the offset dies away on a critically damped spring of half-life inertiaHalfLife. Output = underneath ∘ offset.
 * No event list: every jump is caught, including ones nobody named.
 *
 * Pure and deterministic: state lives on FighterState.inertia, no clocks, no Math.random, no Math.exp (negexp below).
 * Exempt (output = underneath, state reset): the tick a hit or a block lands on him, and a man who is down.
 * Hit-stop frozen ticks keep the offset (no decay).
 * Only f.skel changes. Head, body, arm joints and gloves (the hit shapes) stay as the unsmoothed fit left them: moving
 * them cut landed punches in whole fights and made the third punch of a 1-2-3 miss at 0.90 m (flow_test).
 */
import type { Config, FighterState, InertiaState } from '../core';
import {
  JOINT_COUNT, SIM_DT, clampPose, skelLimits, poseQ, setPoseQ, qMul, qConj, qFromRotVec, qToRotVec, skelDef, type Quat,
} from '../core';
import { fallActive } from './skel';

const DEG = Math.PI / 180;

/** exp(-x) for x >= 0 without Math.exp: (Taylor of exp(-x/16))^16 — the same answer on every engine. */
function negexp(x: number): number {
  if (x <= 0) return 1;
  if (x > 40) return 0;
  const y = x / 16;
  let e = 1 - y * (1 - y / 2 * (1 - y / 3 * (1 - y / 4 * (1 - y / 5))));
  e *= e; e *= e; e *= e; e *= e;
  return e;
}

/** A copy of the state (or undefined), taken before the first pass of a tick so a re-derive can redo the pass. */
export function snapInertia(f: FighterState): InertiaState | undefined {
  const s = f.inertia;
  return s ? { out: s.out.slice(), step: s.step.slice(), off: s.off.slice(), vel: s.vel.slice(), raw: s.raw.slice() } : undefined;
}
/** Put the state back to a snapshot from snapInertia (a land tick re-fits the pose and the pass runs again). */
export function restoreInertia(f: FighterState, snap: InertiaState | undefined): void {
  if (snap) f.inertia = { out: snap.out.slice(), step: snap.step.slice(), off: snap.off.slice(), vel: snap.vel.slice(), raw: snap.raw.slice() };
  else delete f.inertia;
}

/**
 * Start of a tick: the sim works on the unsmoothed pose it made last tick (gloves.ts reads f.skel for the guard), so
 * smoothing, which only shows in the state the rig draws, never feeds back into the fight.
 */
export function restoreRaw(f: FighterState, cfg: Config): void {
  if (!cfg.inertiaOn) delete f.inertia;   // switched off live: no stale state
  else if (f.inertia && f.skel) f.skel.q = f.inertia.raw.slice();
}

/** Is the man exempt this tick on his own account (a knockdown owns his pose)? */
export const inertiaExempt = (f: FighterState, cfg: Config): boolean => f.down || fallActive(f, cfg);

/**
 * Smooth f.skel in place and rewrite the hit shapes from it. `hit`: an impulse lands on him this tick (reactions stay
 * sharp: output = the pose underneath, state reset). `frozen`: hit-stop, no decay this tick.
 */
export function applyInertia(f: FighterState, cfg: Config, hit: boolean, frozen: boolean): void {
  if (!cfg.inertiaOn || !cfg.skelOn || !f.skel) return;
  const pose = f.skel;
  const exempt = hit || inertiaExempt(f, cfg);
  let st = f.inertia;
  if (!st) {
    st = f.inertia = { out: pose.q.slice(), step: new Array(3 * JOINT_COUNT).fill(0), off: new Array(3 * JOINT_COUNT).fill(0), vel: new Array(3 * JOINT_COUNT).fill(0), raw: pose.q.slice() };
    return;
  }
  st.raw = pose.q.slice();   // the pose underneath, before smoothing (restored at the start of the next tick)
  const A = cfg.inertiaMaxAccel * DEG, maxOff = cfg.inertiaMaxOffset * DEG;
  const omega = 2 * Math.LN2 / Math.max(0.5, cfg.inertiaHalfLife / SIM_DT);   // per tick
  const decay = negexp(omega);
  let changed = false;
  for (let j = 0; j < JOINT_COUNT; j++) {
    const raw = poseQ(pose, j);
    const k3 = 3 * j, k4 = 4 * j;
    const prev: Quat = { x: st.out[k4]!, y: st.out[k4 + 1]!, z: st.out[k4 + 2]!, w: st.out[k4 + 3]! };
    if (exempt) {
      const s = qToRotVec(qMul(qConj(prev), raw));
      st.out[k4] = raw.x; st.out[k4 + 1] = raw.y; st.out[k4 + 2] = raw.z; st.out[k4 + 3] = raw.w;
      st.step[k3] = s.x; st.step[k3 + 1] = s.y; st.step[k3 + 2] = s.z;
      for (let c = 0; c < 3; c++) { st.off[k3 + c] = 0; st.vel[k3 + c] = 0; }
      continue;
    }
    // The offset's spring, one tick (exact, critically damped): x' = (x + (v + wx) t) e^-wt.
    const o = [st.off[k3]!, st.off[k3 + 1]!, st.off[k3 + 2]!], w = [st.vel[k3]!, st.vel[k3 + 1]!, st.vel[k3 + 2]!];
    if (!frozen) {
      for (let c = 0; c < 3; c++) {
        const j0 = w[c]! + omega * o[c]!;
        o[c] = (o[c]! + j0) * decay;
        w[c] = (w[c]! - omega * j0) * decay;
      }
    }
    // Past inertiaMaxOffset the lag is pulled back a quarter of the excess a tick (a hard clamp would itself be a snap).
    const m0 = Math.hypot(o[0]!, o[1]!, o[2]!);
    if (m0 > maxOff) { const k = 1 - 0.25 * (1 - maxOff / m0); o[0] = o[0]! * k; o[1] = o[1]! * k; o[2] = o[2]! * k; }
    // Quiet: the offset has died away, the output IS the pose underneath (bit for bit).
    const mag = Math.hypot(o[0]!, o[1]!, o[2]!), wm = Math.hypot(w[0]!, w[1]!, w[2]!);
    let out: Quat = raw;
    let engaged = false;
    if (mag > 1e-7 || wm > 1e-7) { out = qMul(raw, qFromRotVec({ x: o[0]!, y: o[1]!, z: o[2]! })); engaged = true; }
    else { o[0] = o[1] = o[2] = 0; w[0] = w[1] = w[2] = 0; }
    // The limit: the turn this tick may differ from last tick's turn by at most A.
    let s = qToRotVec(qMul(qConj(prev), out));
    const ex = s.x - st.step[k3]!, ey = s.y - st.step[k3 + 1]!, ez = s.z - st.step[k3 + 2]!;
    const em = Math.sqrt(ex * ex + ey * ey + ez * ez);
    let limited = false;
    if (em > A) {
      const d = 1 - A / em;
      s = { x: s.x - ex * d, y: s.y - ey * d, z: s.z - ez * d };
      out = qMul(prev, qFromRotVec(s));
      limited = true; engaged = true;
    }
    if (limited) {
      // The offset is what the limit left between the output and the pose underneath.
      const od = qToRotVec(qMul(qConj(raw), out));
      o[0] = od.x; o[1] = od.y; o[2] = od.z;
    }
    if (engaged) {
      if (out.x * raw.x + out.y * raw.y + out.z * raw.z + out.w * raw.w < 0) out = { x: -out.x, y: -out.y, z: -out.z, w: -out.w };
      setPoseQ(pose, j, out);
      changed = true;
    }
    st.out[k4] = out.x; st.out[k4 + 1] = out.y; st.out[k4 + 2] = out.z; st.out[k4 + 3] = out.w;
    st.step[k3] = s.x; st.step[k3 + 1] = s.y; st.step[k3 + 2] = s.z;
    for (let c = 0; c < 3; c++) { st.off[k3 + c] = o[c]!; st.vel[k3 + c] = w[c]!; }
  }
  if (changed) {
    // A lagging joint may be past a human limit (the pose underneath was inside them): bring it back, and let the state
    // carry what is drawn.
    const def = skelDef(f.body, f.stance, cfg);
    clampPose(def, pose, skelLimits(cfg));
    for (let j = 0; j < JOINT_COUNT; j++) {
      const q = poseQ(pose, j), k4 = 4 * j;
      if (q.x !== st.out[k4] || q.y !== st.out[k4 + 1] || q.z !== st.out[k4 + 2] || q.w !== st.out[k4 + 3]) { st.out[k4] = q.x; st.out[k4 + 1] = q.y; st.out[k4 + 2] = q.z; st.out[k4 + 3] = q.w; }
    }
    // The hit shapes (head, body, arm joints, gloves) are NOT rewritten: they stay on the unsmoothed pose, so reach and
    // every hit test are exactly what they were. Only the skeleton (f.skel: what the rig seeds its draw from) is smoothed.
  }
}

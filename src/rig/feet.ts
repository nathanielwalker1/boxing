/**
 * rig/feet.ts — planted feet. Each foot remembers a WORLD position + yaw and
 * only moves when its rest spot (the stance position under the current hips,
 * pushed ahead along the velocity) has drifted past cfg.rigStepThreshold, and
 * the other foot is not mid-step. A step is a smooth lerp with a sine lift.
 * Result: a still fighter never slides, a walking one takes real steps, and a
 * turning one shuffles.
 *
 * Boxing footwork (2026-09-16): the foot nearest the direction of travel
 * LEADS — the lead foot going forward or toward the lead side, the rear foot
 * going back or toward the rear side — and the other foot DRAGS up behind it
 * to restore the stance, shorter and lower, never crossing. The caller decides
 * the roles (rig/index.ts, from the velocity in the fighter's frame) and
 * updates the leader first so it wins when both are due. Sideways steps are
 * shuffles: shorter, quicker, lower.
 */
import type { Config } from '../core';
import { angleDelta, smoothstep, wrapAngle } from '../core';

export interface FootPose { x: number; y: number; z: number; rotY: number }
export type FootRole = 'lead' | 'trail';
export interface StepStyle { role: FootRole; lateral: boolean }

const TELEPORT = 1.0;   // a jump this large is a reset/pose, not a step

/**
 * Which foot leads for a velocity in the fighter's frame (fwd, lat = +right),
 * given the lead foot's lateral sign (−1 = the lead foot is the left foot,
 * orthodox). Forward → lead foot; back → rear foot; sideways → the foot on
 * that side. Standing still → lead foot (nothing steps anyway).
 */
export function stepRoles(vFwd: number, vLat: number, leadSign: -1 | 1): { leader: 0 | 1; lateral: boolean } {
  const spd = Math.hypot(vFwd, vLat);
  const lateral = Math.abs(vLat) > Math.abs(vFwd);
  if (spd < 1e-3) return { leader: 0, lateral: false };
  if (lateral) return { leader: (vLat < 0 ? -1 : 1) === leadSign ? 0 : 1, lateral };
  return { leader: vFwd >= 0 ? 0 : 1, lateral };
}

export class FootPlanter {
  private inited = false;
  private planted: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  private from: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  private to: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  private t = 1;
  private dur = 0.2;
  private lift = 0.05;
  readonly out: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };

  get stepping(): boolean { return this.t < 1; }
  /** 0..1 through the current step (1 when planted). */
  get phase(): number { return this.t; }

  snap(p: FootPose): void {
    this.planted = { ...p, y: 0 };
    this.t = 1;
    this.inited = true;
    Object.assign(this.out, this.planted);
  }

  /** Start a quick step to `target` now, whatever the threshold says (a step jab's lead foot). No-op mid-step. */
  stepNow(target: FootPose, cfg: Config, quick = 0.6): void {
    if (!this.inited || this.t < 1) return;
    this.from = { ...this.planted };
    this.to = { ...target, y: 0 };
    this.t = 0;
    this.dur = cfg.rigStepDur * quick;
    this.lift = cfg.rigStepLift * 0.7;
  }

  /**
   * `desired` is where the foot wants to be with the velocity lead already
   * applied; `rest` is the bare stance spot. The leader reaches for `desired`,
   * the trailer drags up to `rest`.
   */
  update(desired: FootPose, rest: FootPose, style: StepStyle, dt: number, cfg: Config, other: FootPlanter): FootPose {
    const dx = desired.x - this.planted.x, dz = desired.z - this.planted.z;
    const dist = Math.hypot(dx, dz);
    if (!this.inited || dist > TELEPORT) { this.snap(desired); return this.out; }

    if (this.t >= 1) {
      const turn = Math.abs(angleDelta(this.planted.rotY, desired.rotY));
      if ((dist > cfg.rigStepThreshold || turn > 0.6) && !other.stepping) {
        const trail = style.role === 'trail';
        const target = trail ? rest : desired;
        this.from = { ...this.planted };
        this.to = { ...target, y: 0 };
        this.t = 0;
        this.dur = cfg.rigStepDur * (trail ? cfg.rigTrailStepScale : 1) * (style.lateral ? cfg.rigShuffleScale : 1);
        this.lift = cfg.rigStepLift * (trail ? 0.6 : 1) * (style.lateral ? 0.5 : 1);
      }
    }
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / Math.max(1e-3, this.dur));
      const s = smoothstep(this.t);
      this.out.x = this.from.x + (this.to.x - this.from.x) * s;
      this.out.z = this.from.z + (this.to.z - this.from.z) * s;
      this.out.rotY = wrapAngle(this.from.rotY + angleDelta(this.from.rotY, this.to.rotY) * s);
      this.out.y = Math.sin(Math.PI * this.t) * this.lift;
      if (this.t >= 1) this.planted = { ...this.to };
    } else {
      Object.assign(this.out, this.planted);
    }
    return this.out;
  }
}

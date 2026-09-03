/**
 * rig/feet.ts — planted feet. Each foot remembers a WORLD position + yaw and
 * only moves when its rest spot (the stance position under the current hips,
 * pushed ahead along the velocity) has drifted past cfg.rigStepThreshold, and
 * the other foot is not mid-step. A step is a smooth lerp with a sine lift.
 * Result: a still fighter never slides, a walking one takes real steps, and a
 * turning one shuffles.
 */
import type { Config } from '../core';
import { angleDelta, smoothstep, wrapAngle } from '../core';

export interface FootPose { x: number; y: number; z: number; rotY: number }

const TELEPORT = 1.0;   // a jump this large is a reset/pose, not a step

export class FootPlanter {
  private inited = false;
  private planted: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  private from: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  private to: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };
  private t = 1;
  readonly out: FootPose = { x: 0, y: 0, z: 0, rotY: 0 };

  get stepping(): boolean { return this.t < 1; }

  snap(p: FootPose): void {
    this.planted = { ...p, y: 0 };
    this.t = 1;
    this.inited = true;
    Object.assign(this.out, this.planted);
  }

  update(desired: FootPose, dt: number, cfg: Config, other: FootPlanter): FootPose {
    const dx = desired.x - this.planted.x, dz = desired.z - this.planted.z;
    const dist = Math.hypot(dx, dz);
    if (!this.inited || dist > TELEPORT) { this.snap(desired); return this.out; }

    if (this.t >= 1) {
      const turn = Math.abs(angleDelta(this.planted.rotY, desired.rotY));
      if ((dist > cfg.rigStepThreshold || turn > 0.6) && !other.stepping) {
        this.from = { ...this.planted };
        this.to = { ...desired, y: 0 };
        this.t = 0;
      }
    }
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / Math.max(1e-3, cfg.rigStepDur));
      const s = smoothstep(this.t);
      this.out.x = this.from.x + (this.to.x - this.from.x) * s;
      this.out.z = this.from.z + (this.to.z - this.from.z) * s;
      this.out.rotY = wrapAngle(this.from.rotY + angleDelta(this.from.rotY, this.to.rotY) * s);
      this.out.y = Math.sin(Math.PI * this.t) * cfg.rigStepLift;
      if (this.t >= 1) this.planted = { ...this.to };
    } else {
      Object.assign(this.out, this.planted);
    }
    return this.out;
  }
}

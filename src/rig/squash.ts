/**
 * rig/squash.ts — contact squash (L6). A one-shot sine envelope that compresses
 * a bone along an axis expressed in that bone's local frame and swells the two
 * perpendicular axes. Applied as bone scale, so a squashed head or glove keeps
 * its centre exactly on the sim position.
 */
import { Vector3 } from 'three';

export class Squash {
  private t = Infinity;
  private dur = 0.1;
  private amount = 0;
  readonly axis = new Vector3(0, 1, 0);

  /** `axis` need not be unit; it is normalised. */
  fire(axis: Vector3, amount: number, dur: number): void {
    if (axis.lengthSq() < 1e-10) this.axis.set(0, 1, 0); else this.axis.copy(axis).normalize();
    this.amount = amount;
    this.dur = Math.max(1e-3, dur);
    this.t = 0;
  }

  get active(): boolean { return this.t < this.dur; }

  step(dt: number): void { if (this.t < this.dur) this.t += dt; }

  /** Multiply `scale` by this frame's squash. Exact when the axis is bone-aligned. */
  applyTo(scale: Vector3): void {
    if (this.t >= this.dur) return;
    const env = Math.sin(Math.PI * this.t / this.dur) * this.amount;
    const ax = this.axis.x * this.axis.x, ay = this.axis.y * this.axis.y, az = this.axis.z * this.axis.z;
    scale.x *= 1 - env * ax + env * 0.5 * (1 - ax);
    scale.y *= 1 - env * ay + env * 0.5 * (1 - ay);
    scale.z *= 1 - env * az + env * 0.5 * (1 - az);
  }
}

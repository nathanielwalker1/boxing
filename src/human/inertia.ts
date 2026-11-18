/**
 * CONTINUITY (cfg.humanInertia): inertial blending of the FINAL drawn pose. No three.js.
 *
 * The view hands in the pose it is about to draw (every joint's local rotation after clips, lean, impact, hand IK,
 * and the hips' local position). On a CUT (an action started or ended this frame: anim.takeCut()) the difference
 * between the pose that was on screen last frame and this new pose is taken over, together with the joint speeds that
 * were on screen, and decays on a critically damped spring. So a switch always starts from the pose and motion on
 * screen, whatever layer caused the change. Between cuts the pose passes through untouched once the difference has
 * decayed.
 */

/** r = log(a × b⁻¹) as a rotation vector (shortest way). */
function qDiff(a: Float32Array, ao: number, b: Float32Array, bo: number, out: Float32Array, oo: number): void {
  const ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!;
  const bx = -b[bo]!, by = -b[bo + 1]!, bz = -b[bo + 2]!, bw = b[bo + 3]!;
  let x = aw * bx + ax * bw + ay * bz - az * by, y = aw * by - ax * bz + ay * bw + az * bx, z = aw * bz + ax * by - ay * bx + az * bw, w = aw * bw - ax * bx - ay * by - az * bz;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  const k = s < 1e-8 ? 2 : 2 * Math.atan2(s, w) / s;
  out[oo] = x * k; out[oo + 1] = y * k; out[oo + 2] = z * k;
}
/** out = exp(r) × q. */
function qApply(r: Float32Array, ro: number, q: Float32Array, qo: number, out: Float32Array, oo: number): void {
  const rx = r[ro]!, ry = r[ro + 1]!, rz = r[ro + 2]!;
  const a = Math.hypot(rx, ry, rz);
  const k = a < 1e-8 ? 0.5 : Math.sin(a / 2) / a, ew = Math.cos(a / 2), ex = rx * k, ey = ry * k, ez = rz * k;
  const x = q[qo]!, y = q[qo + 1]!, z = q[qo + 2]!, w = q[qo + 3]!;
  const ox = ew * x + ex * w + ey * z - ez * y, oy = ew * y - ex * z + ey * w + ez * x, oz = ew * z + ex * y - ey * x + ez * w, ow = ew * w - ex * x - ey * y - ez * z;
  const l = Math.hypot(ox, oy, oz, ow) || 1;
  out[oo] = ox / l; out[oo + 1] = oy / l; out[oo + 2] = oz / l; out[oo + 3] = ow / l;
}

export class PoseInertia {
  private ready = false;
  private half = 0.07;
  private readonly out: Float32Array;    // the pose drawn last frame (n × 4)
  private readonly off: Float32Array;    // per joint: the carried difference as a rotation vector (n × 3)
  private readonly offV: Float32Array;   // its rate, rad/s
  private readonly vel: Float32Array;    // the drawn joint speed last frame, rad/s
  private readonly pOut = new Float32Array(3); private readonly pOff = new Float32Array(3);
  private readonly pOffV = new Float32Array(3); private readonly pVel = new Float32Array(3);

  /** slow[j]: how many times longer joint j takes to settle (1 = arms and trunk; more for hips and legs). */
  constructor(private readonly n: number, private readonly slow: Float32Array) {
    this.out = new Float32Array(n * 4); this.off = new Float32Array(n * 3); this.offV = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
  }

  /** A correction made after step() (the punching hand put back on its target): what is on screen is this pose. */
  sync(rot: Float32Array): void { this.out.set(rot); }

  /**
   * rot (n × 4, x y z w) and pos (the hips' local position) are the pose wanted this frame; they are overwritten with
   * the pose to draw. cut > 0: an action switched this frame; its value is the half-life (s) of the carried difference.
   */
  step(rot: Float32Array, pos: Float32Array, cut: number, dt: number, velMax: number, slowPos: number): void {
    const n = this.n;
    if (!this.ready) { this.out.set(rot); this.pOut.set(pos); this.ready = true; return; }
    if (dt <= 1e-5) { rot.set(this.out); pos.set(this.pOut); return; }
    if (cut > 0) {
      for (let b = 0; b < n; b++) {
        qDiff(this.out, b * 4, rot, b * 4, this.off, b * 3);
        const vx = this.vel[b * 3]!, vy = this.vel[b * 3 + 1]!, vz = this.vel[b * 3 + 2]!;
        const v = Math.hypot(vx, vy, vz), k = v > velMax ? velMax / v : 1;
        this.offV[b * 3] = vx * k; this.offV[b * 3 + 1] = vy * k; this.offV[b * 3 + 2] = vz * k;
      }
      for (let i = 0; i < 3; i++) { this.pOff[i] = this.pOut[i]! - pos[i]!; this.pOffV[i] = Math.max(-3, Math.min(3, this.pVel[i]!)); }
      this.half = cut;
    }
    // critically damped decay of the carried difference (exact step)
    const y0 = 2 * Math.LN2 / Math.max(1e-3, this.half);
    for (let i = 0; i < n * 3; i++) {
      const y = y0 / this.slow[(i / 3) | 0]!, e = Math.exp(-y * dt);
      const x = this.off[i]!, v = this.offV[i]!, j1 = v + x * y;
      this.off[i] = e * (x + j1 * dt); this.offV[i] = e * (v - j1 * y * dt);
    }
    for (let b = 0; b < n; b++) {
      qApply(this.off, b * 3, rot, b * 4, rot, b * 4);
      qDiff(rot, b * 4, this.out, b * 4, this.vel, b * 3);
      this.vel[b * 3] = this.vel[b * 3]! / dt; this.vel[b * 3 + 1] = this.vel[b * 3 + 1]! / dt; this.vel[b * 3 + 2] = this.vel[b * 3 + 2]! / dt;
    }
    this.out.set(rot);
    const y = y0 / Math.max(1, slowPos), e = Math.exp(-y * dt);
    for (let i = 0; i < 3; i++) {
      const x = this.pOff[i]!, v = this.pOffV[i]!, j1 = v + x * y;
      this.pOff[i] = e * (x + j1 * dt); this.pOffV[i] = e * (v - j1 * y * dt);
      const p = pos[i]! + this.pOff[i]!;
      this.pVel[i] = (p - this.pOut[i]!) / dt; this.pOut[i] = p; pos[i] = p;
    }
  }
}

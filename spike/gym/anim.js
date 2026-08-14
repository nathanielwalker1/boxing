/**
 * anim.js — the kinetic-chain evaluator.
 *
 * One punch = a bag of independent channels. Each channel runs its own clock:
 *
 *   0 .......... t0 .......... t1 ...... t1+hold ......... t1+hold+rec
 *   |  anticipate |   strike    |  hold  |     recover      |
 *        -ant*amp       amp        amp       overshoot -> 0
 *
 * Because t0/t1/rec are per channel, the hip can be finished and settling while
 * the elbow has not started. That staggering is the entire experiment: it is
 * mechanically impossible in a system where one progress value drives every
 * joint through two shared curves.
 *
 * Recovery is deliberately NOT the strike curve run backwards. It leaves fast,
 * crosses rest, overshoots to -over*amp around the two-thirds mark and settles.
 * A symmetrical ease back to rest is what makes a punch look like it is being
 * un-drawn rather than followed through.
 */
import { EASE, clamp } from './ease.js';
import { punchDuration } from './config.js';

/** Value of one channel at time t (ms since the punch started). */
export function channelValue(c, t, hold) {
  if (t <= 0) return 0;
  const amp = c.amp;
  const antV = -c.ant * amp;

  if (t < c.t0) {
    // Wind-up. Always eased out so the load settles before the strike fires,
    // which is what makes an anticipation read as weight rather than a twitch.
    return antV * EASE.easeOutQuad(c.t0 > 0 ? t / c.t0 : 1);
  }

  const peakAt = Math.max(c.t1, c.t0 + 1);
  if (t < peakAt) {
    const u = (t - c.t0) / (peakAt - c.t0);
    return antV + (amp - antV) * (EASE[c.ease] || EASE.easeOutCubic)(u);
  }

  const holdEnd = peakAt + hold;
  if (t < holdEnd) return amp;

  const u = clamp((t - holdEnd) / Math.max(c.rec, 1), 0, 1);
  if (u >= 1) return 0;
  const e = EASE.easeOutCubic(u);
  return amp * ((1 - e) - c.over * Math.sin(Math.PI * u));
}

/**
 * A punch in flight. Owns its own clock so the scrubber can seize it.
 */
export class PunchPlayer {
  constructor(punches) {
    this.punches = punches;
    this.type = null;
    this.t = 0;
    this.total = 0;
    this.out = Object.create(null);
  }

  start(type) {
    if (!this.punches[type]) return false;
    this.type = type;
    this.t = 0;
    this.total = punchDuration(this.punches[type]);
    return true;
  }

  get active() { return this.type !== null; }

  /** 0..1 across the whole punch. */
  get phase() { return this.total > 0 ? clamp(this.t / this.total, 0, 1) : 0; }

  /** Drive the clock directly — the scrubber and the pose-sheet capture path. */
  seek(p) {
    if (!this.type) return;
    this.total = punchDuration(this.punches[this.type]);
    this.t = clamp(p, 0, 1) * this.total;
  }

  advance(dtMs) {
    if (!this.type) return;
    this.total = punchDuration(this.punches[this.type]);
    this.t = Math.max(0, this.t + dtMs);      // frame-stepping backwards must not go negative
    if (this.t >= this.total) { this.type = null; this.t = 0; }
  }

  /**
   * The pose delta dict for the current instant. Reuses one object — this runs
   * every frame and there is no reason to churn allocations for it.
   */
  evaluate() {
    const out = this.out;
    for (const k in out) delete out[k];
    if (!this.type) return out;
    const p = this.punches[this.type];
    for (const c of p.channels) {
      const v = channelValue(c, this.t, p.hold);
      if (v) out[c.path] = (out[c.path] || 0) + v;
    }
    return out;
  }
}

/**
 * Slip: a held pose, not a timed animation.
 *
 * It springs toward 1 while the key is down and back to 0 when released, with a
 * lower release stiffness so the return is a recovery rather than a snap. There
 * is no separate visible-lean and hurtbox-lean here to disagree with each other:
 * the head bone IS the head, so what you see displaced is what moved.
 */
export class SlipDriver {
  constructor(cfg) { this.cfg = cfg; this.a = 0; this.v = 0; this.dir = 0; this.held = false; }

  set(dir, held) {
    if (held && dir) this.dir = dir;
    this.held = held;
  }

  step(dt) {
    const target = this.held ? 1 : 0;
    const k = this.held ? this.cfg.attack : this.cfg.release;
    const acc = -k * (this.a - target) - this.cfg.damping * this.v;
    this.v += acc * dt;
    this.a += this.v * dt;
    if (!this.held && this.a < 0.0008 && Math.abs(this.v) < 0.0008) { this.a = 0; this.v = 0; this.dir = 0; }
  }

  get dict() { return this.dir > 0 ? this.cfg.lead : this.cfg.rear; }
  get amount() { return this.a; }
}

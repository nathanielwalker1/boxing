/**
 * Hit reaction — the localized, spring-damped rig response to a landed punch
 * (Stage 10). Owned by both Fighter and Dummy, so getting hit reads identically
 * from either side.
 *
 * This is deliberately NOT a second stagger system. The existing whole-body
 * knockback stays where it is (the player's vx/vy, the dummy's staggerX/Y
 * offset) and still moves the fighter through the ring. What this adds is the
 * part that knockback can't express: WHICH BIT of the body moved, and which way.
 * A jab that snaps only the head and a cross that carries the torso with it
 * produce the same world displacement; the difference lives here.
 *
 * Three independent spring-dampers, all pulling back to 0:
 *   head  — px offset of the head, ON TOP of the torso's own offset
 *   torso — px offset of the torso (and therefore the shoulders, so the arms
 *           travel with the body instead of detaching from it)
 *   tilt  — radians of whole-rig lean, the rotational component of a hook
 *
 * COORDINATE SPACE is the defender's own rig-local space, not the world:
 *   +x = toward the attacker (facing always tracks the opponent, so this holds
 *        no matter where either fighter is standing)
 *   -y = up
 * ...and every positive value in the per-punch shape table pushes the defender
 * AWAY from the punch, on whichever of those axes it names.
 * The container's scaleX mirror then renders it correctly from either side, the
 * same trick the guard/punch poses already rely on. Working locally is what lets
 * "snap the head straight back" be one number instead of a world-space vector.
 */

import { config, punchReaction } from './config.js';
import { NO_REACT } from './rig.js';

export class HitReaction {
  constructor() {
    this.headX = 0;  this.headY = 0;  this.headVx = 0;  this.headVy = 0;
    this.torsoX = 0; this.torsoY = 0; this.torsoVx = 0; this.torsoVy = 0;
    this.tilt = 0;   this.tiltV = 0;
    // Stiffness multiplier of the punch that most recently landed — this is
    // what makes a jab's snap quick and short-lived while a hook's wallows.
    this._snap = 1;
  }

  /**
   * Apply an impact. Magnitude comes from the SAME force value the stagger
   * impulse and health damage already use (base × momentum × per-punch damage
   * multiplier, post block-reduction), so a retreating jab and an advancing
   * cross differ here for free rather than being flat per-type constants.
   *
   * The rotational component is NOT signed by which hand threw the punch. A
   * left and a right hook do mirror each other in reality, but the rig is a
   * side view with a single horizontal axis, so signing by hand would make one
   * of the two hooks lean the defender INTO the punch — which reads as a
   * mistake, not as a mirrored arc. The twist therefore always whips the upper
   * body away, and the hand difference stays where the view can actually show
   * it (the attacker's own swing).
   *
   * @param {string} punchType  'jab' | 'cross' | 'hook' | 'uppercut'
   * @param {number} force      post-block impact force from _resolveAttack
   */
  apply(punchType, force) {
    const s = punchReaction(punchType);
    const v = force * config.reactionForceScale;

    this.headVx  -= s.back * v;              // straight back = away from the attacker
    this.headVy  -= s.lift * v;              // positive lift = upward (chin up)
    this.torsoVx -= s.back * s.torso * v;    // bleed into the body, per type
    this.torsoVy -= s.lift * s.torso * v;
    this.tiltV   += s.twist * v * config.reactionTwistScale;   // positive = leans away

    this._snap = s.snap;
  }

  /** Clear instantly — used when a knockdown takes over the whole pose. */
  reset() {
    this.headX = this.headY = this.headVx = this.headVy = 0;
    this.torsoX = this.torsoY = this.torsoVx = this.torsoVy = 0;
    this.tilt = this.tiltV = 0;
    this._snap = 1;
  }

  update(dt) {
    const k   = config.reactionStiffness * this._snap;
    const c   = config.reactionDamping;
    const max = config.reactionMaxOffset;

    // Same integrator as the dummy's body stagger, run three times.
    const step = (pos, vel) => {
      const a = -k * pos - c * vel;
      const nv = vel + a * dt;
      let np = pos + nv * dt;
      if (np >  max) np =  max;
      if (np < -max) np = -max;
      return [np, nv];
    };

    [this.headX,  this.headVx]  = step(this.headX,  this.headVx);
    [this.headY,  this.headVy]  = step(this.headY,  this.headVy);
    [this.torsoX, this.torsoVx] = step(this.torsoX, this.torsoVx);
    [this.torsoY, this.torsoVy] = step(this.torsoY, this.torsoVy);

    // Tilt is radians, so it needs its own clamp rather than the px one.
    const ta  = -k * this.tilt - c * this.tiltV;
    this.tiltV += ta * dt;
    this.tilt   = Math.max(-config.reactionMaxTilt,
                  Math.min(config.reactionMaxTilt, this.tilt + this.tiltV * dt));
  }

  /**
   * The offsets in the form rig.js consumes. Returns the shared frozen zero
   * object while at rest so the common case allocates nothing.
   */
  pose() {
    if (this.headX === 0 && this.headY === 0 &&
        this.torsoX === 0 && this.torsoY === 0 && this.tilt === 0) return NO_REACT;
    return {
      headX: this.headX, headY: this.headY,
      torsoX: this.torsoX, torsoY: this.torsoY,
      tilt: this.tilt,
    };
  }
}

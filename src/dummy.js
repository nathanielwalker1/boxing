import { config } from './config.js';
import { drawRig } from './rig.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Dummy — target fighter with a randomized attack timer (Stage 4).
 * Does not move or make decisions — attacks fire on a random interval,
 * regardless of player position/range. Takes punch impulses and staggers
 * via a spring-damper. Visually identical rig to the player (shared drawRig).
 */
export class Dummy {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} x
   * @param {number} y
   * @param {() => void} onAttackImpact  called when a thrown punch reaches
   *        full extension — the scene resolves range gating/force from here,
   *        mirroring how the player's punch buttons drive _resolvePunch.
   */
  constructor(scene, x, y, onAttackImpact) {
    this.scene   = scene;
    this.originX = x;
    this.originY = y;
    this.x       = x;
    this.y       = y;

    // Attack-impact resolution has no momentum contribution — the dummy
    // doesn't move toward the player, so this stays flat at 0.
    this.vx = 0;
    this.vy = 0;

    // Spring-damper stagger state
    this.staggerVx = 0;
    this.staggerVy = 0;

    // Hit flash state
    this.flashAlpha = 0;
    this.flashColor = 0xffffff;

    // Faces the player — starts facing left since the player starts on the left.
    this.facingRight = false;

    // Punch windup animation (reuses the same leadExtend/rearExtend blend as Fighter)
    this.punchArm   = null;
    this.punchTimer = 0;

    // Attack cadence — pure randomized timer, no positioning/decision logic
    this._onAttackImpact  = onAttackImpact;
    this.attackTimer      = randRange(config.dummyAttackDelayMin, config.dummyAttackDelayMax);
    this._impactPending   = false;
    this._impactTimer     = 0;

    // Container + graphics (same pattern as Fighter)
    this.container = scene.add.container(x, y);
    this.gfx       = scene.add.graphics();
    this.container.add(this.gfx);
    this.container.setDepth(4);   // just behind player (depth 5)
    this.container.setScale(-1, 1);

    this.draw();
  }

  draw() {
    let leadExtend = 0, rearExtend = 0;

    if (this.punchTimer > 0 && this.punchArm) {
      // Same triangle-wave shape as Fighter's punch animation, but stretched
      // over dummyWindupDuration (not punchDuration) so it's slow enough to
      // react to — the player's own punches stay snappy and unaffected.
      const progress = 1 - this.punchTimer / config.dummyWindupDuration;
      const wave     = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
      if (this.punchArm === 'lead') leadExtend = wave;
      else                          rearExtend = wave;
    }

    drawRig(
      this.gfx,
      cssHex(config.dummyBodyColor),
      cssHex(config.dummySkinColor),
      leadExtend,
      rearExtend,
    );
  }

  /**
   * Return the world-space position of the specified fist (for flash spawning).
   * @param {'lead'|'rear'} arm
   */
  getFistPos(arm) {
    const localX = arm === 'lead' ? -19 : 19;
    const flip   = this.facingRight ? 1 : -1;
    return { x: this.x + localX * flip, y: this.y - 14 };
  }

  /**
   * Apply a velocity impulse to the stagger system.
   * vx/vy are in world-space px/s.
   */
  receiveImpulse(vx, vy) {
    this.staggerVx += vx;
    this.staggerVy += vy;
  }

  /**
   * Trigger a brief color flash on the dummy's torso.
   * @param {number} color  Phaser integer color
   */
  flash(color) {
    this.flashAlpha = 1.0;
    this.flashColor = color;
  }

  update(dt, opponentX) {
    // ── Spring-damper: pulls dummy back to origin ─────────────────────────
    const dispX = this.x - this.originX;
    const dispY = this.y - this.originY;
    const ax = -config.dummyReturnSpeed * dispX - config.dummyDamping * this.staggerVx;
    const ay = -config.dummyReturnSpeed * dispY - config.dummyDamping * this.staggerVy;
    this.staggerVx += ax * dt;
    this.staggerVy += ay * dt;
    this.x += this.staggerVx * dt;
    this.y += this.staggerVy * dt;

    // ── Facing — always toward the player, so the punch telegraph swings the
    //    correct direction even if they circle past the dummy ─────────────
    if (opponentX > this.x) this.facingRight = true;
    else if (opponentX < this.x) this.facingRight = false;
    this.container.setScale(this.facingRight ? 1 : -1, 1);

    // ── Punch windup animation timer ───────────────────────────────────────
    if (this.punchTimer > 0) {
      this.punchTimer = Math.max(0, this.punchTimer - dt);
      if (this.punchTimer === 0) this.punchArm = null;
    }

    // ── Pending impact — fires at peak extension (half the windup), not at
    //    the trigger instant, so there's a visible tell before it lands ────
    if (this._impactPending) {
      this._impactTimer -= dt;
      if (this._impactTimer <= 0) {
        this._impactPending = false;
        this._onAttackImpact();
      }
    }

    // ── Attack cadence — randomized timer only, no reactive logic ─────────
    this.attackTimer -= dt;
    if (this.attackTimer <= 0) {
      this.attackTimer = randRange(config.dummyAttackDelayMin, config.dummyAttackDelayMax);
      this.punchArm        = 'lead';
      this.punchTimer      = config.dummyWindupDuration;
      this._impactPending  = true;
      this._impactTimer    = config.dummyWindupDuration / 2;
    }

    // ── Redraw rig (clears previous frame, picks up live color config changes)
    this.draw();

    // ── Hit flash overlay drawn ON TOP of the rig ────────────────────────
    if (this.flashAlpha > 0) {
      this.flashAlpha = Math.max(0, this.flashAlpha - dt / 0.18);
      this.gfx.fillStyle(this.flashColor, this.flashAlpha * 0.55);
      this.gfx.fillRect(-14, -50, 28, 64);   // covers torso + head area
    }

    // ── Sync position ─────────────────────────────────────────────────────
    this.container.setPosition(this.x, this.y);
  }
}

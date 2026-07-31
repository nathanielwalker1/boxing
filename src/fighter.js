import { config, punchSpeedMult } from './config.js';
import { drawRig, computePose, peakProgress, armSlot, hurtboxes } from './rig.js';
import { stepMovement, stepBob } from './movement.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

/**
 * Fighter — player-controlled boxer rig.
 *
 * Local origin = torso center.  Container.scaleX = ±1 controls facing direction;
 * facing always tracks the opponent's position, never movement input. Facing is
 * PURELY COSMETIC — it mirrors the rendered rig and nothing else. Which arm
 * throws a jab or a cross comes from `stance` (see rig.js), so an orthodox
 * fighter jabs with their left hand from either side of the ring.
 * Punch state (type + arm + progress) is handed to drawRig(), which owns the
 * per-punch-type trajectory — see the PUNCHES table in rig.js.
 */
export class Fighter {
  /** @param {'orthodox'|'southpaw'} stance  defaults to config.playerStance */
  constructor(scene, x, y, stance = config.playerStance) {
    this.scene = scene;
    this.stance = stance;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facingRight = true;

    // Punch animation state
    this.punchArm   = null;   // 'left' | 'right' | null — anatomical, resolved to a rig slot via stance
    this.punchType  = null;   // 'jab' | 'cross' | 'hook' | 'uppercut' | null — selects the trajectory in rig.js
    this.punchTimer = 0;      // seconds remaining in current punch animation

    // Block state — isBlocking only goes true once any in-progress punch has
    // finished (see update()), so a held block never snaps a punch animation.
    this.isBlocking = false;

    // Slip/duck state (Stage 5) — see _triggerSlip() and getHitPos().
    this.slipTimer = 0;   // seconds remaining in the active slip window
    this.slipDirX  = 0;   // captured flick direction (normalized), drives lean + head offset
    this.slipDirY  = 0;

    // Flick-vs-hold detector — a read-only observer of the same merged movement
    // input everything else reads. It never gates or delays normal movement.
    this._pushTimerMs       = 0;       // ms since input crossed slipInputThreshold; 0 = not pushed
    this._pushDirX          = 0;       // direction captured at the start of the current push
    this._pushDirY          = 0;
    this._pushHoldConfirmed = false;   // true once duration exceeds the flick window (reads as footwork)

    // Movement bounce on top of the guard pose — see stepBob() in movement.js.
    this._bobPhase = 0;
    this._bob      = 0;

    // Hit flash state (mirrors Dummy's)
    this.flashAlpha = 0;
    this.flashColor = 0xffffff;

    // Health/stamina/knockdown (Stage 6) — see takeDamage()/_triggerKnockdown().
    this.health       = config.healthMax;
    this.stamina      = config.staminaMax;
    this.isDown       = false;
    this.knockdownTimer = 0;
    this._punchDuration = config.punchDuration;   // this punch's actual duration (may be stretched by low stamina)

    this.container = scene.add.container(x, y);
    this.gfx       = scene.add.graphics();
    this.container.add(this.gfx);
    this.container.setDepth(5);

    this._draw();
  }

  // ── Punch API ──────────────────────────────────────────────────────────────

  /**
   * Trigger a punch animation.  Interrupts any in-progress punch. Drains a
   * flat stamina cost regardless of outcome, and — reusing the existing
   * windup/telegraph timing rather than a new system — stretches the punch
   * duration when stamina is low, so a gassed fighter is visibly slower to
   * react to instead of being locked out of throwing at all.
   * Duration is the shared config.punchDuration divided by the punch type's own
   * speed multiplier (Stage 8), so the four punches differ in snappiness while
   * still tracking the one shared base value and the low-stamina stretch.
   * @param {'left'|'right'} arm  which ANATOMICAL arm throws (stance decides
   *        whether that is the lead or rear slot in the rig — see armSlot())
   * @param {string} type         'jab' | 'cross' | 'hook' | 'uppercut'
   */
  startPunch(arm, type) {
    const lowStamina    = this.stamina < config.lowStaminaThreshold;
    this._punchDuration = config.punchDuration / punchSpeedMult(type)
                          * (lowStamina ? config.lowStaminaWindupMultiplier : 1);
    this.punchArm        = arm;
    this.punchType       = type;
    this.punchTimer      = this._punchDuration;
    this.stamina         = Math.max(0, this.stamina - config.staminaDrainPerPunch);
  }

  /**
   * Current punch animation state in the form rig.js consumes, or null when
   * idle. Shared by _draw() and getFistPos() so both read the same pose.
   */
  _punchState(atPeak = false) {
    if (this.punchTimer <= 0 || !this.punchArm) return null;
    return {
      type: this.punchType,
      arm:  armSlot(this.stance, this.punchArm),   // anatomical → rig slot
      p:    atPeak ? peakProgress(this.punchType) : 1 - this.punchTimer / this._punchDuration,
    };
  }

  /**
   * Apply damage from a landed punch (see RingScene._resolveAttack, which
   * passes in the same force value already used for the stagger impulse —
   * no parallel damage number). Triggers a knockdown at 0 health.
   */
  takeDamage(amount) {
    if (this.isDown) return;   // invulnerable while down (belt-and-suspenders; _resolveAttack already gates this)
    this.health = Math.max(0, this.health - amount);
    if (this.health === 0) this._triggerKnockdown();
  }

  _triggerKnockdown() {
    this.isDown         = true;
    this.knockdownTimer = config.knockdownRecoveryDuration;
    this.punchArm       = null;
    this.punchType      = null;
    this.punchTimer     = 0;
    this.isBlocking     = false;
    this.slipTimer      = 0;
    this.vx = 0;
    this.vy = 0;
  }

  /**
   * Return the world-space position of the specified fist (for flash spawning).
   * Solved from the rig pose sampled at the punch's PEAK, so a whiff/smother
   * flash appears where the punch actually arrives — which now differs a lot
   * per punch type (an uppercut's fist is nowhere near a jab's). Sampling the
   * current frame instead would place it at the fist's press-time rest spot,
   * since the player's punch resolves on the frame it's thrown.
   * @param {'left'|'right'} arm  anatomical arm; stance maps it to a rig slot
   * @returns {{ x: number, y: number }}
   */
  getFistPos(arm) {
    const pose = computePose(this._punchState(true), this.isBlocking ? 1 : 0, this._bob);
    const hand = armSlot(this.stance, arm) === 'lead' ? pose.lead : pose.rear;
    const flip = this.facingRight ? 1 : -1;
    return { x: this.x + hand.wx * flip, y: this.y + hand.wy };
  }

  /**
   * World-space head + body hurtboxes (Stage 9) — what an incoming fist is
   * tested against in RingScene._resolveAttack.
   *
   * Solved from the CURRENT pose (not a peak sample), so they track this
   * fighter's live position, bob and torso rotation frame by frame. Anchored to
   * getHitPos() rather than (x, y), which is what keeps a slip working: the slip
   * displaces the anchor, so the whole hurtbox set moves out of the incoming
   * punch's way. Still no bypass flag.
   * @returns {{ head: {x,y,r}, body: {x,y,hw,hh} }}
   */
  getHurtboxes() {
    const base = this.getHitPos();
    const pose = computePose(this._punchState(), this.isBlocking ? 1 : 0, this._bob);
    const hb   = hurtboxes(pose);
    const flip = this.facingRight ? 1 : -1;
    return {
      head: { x: base.x + hb.head.x * flip, y: base.y + hb.head.y, r: hb.head.r },
      body: { x: base.x + hb.body.x * flip, y: base.y + hb.body.y, hw: hb.body.hw, hh: hb.body.hh },
    };
  }

  /**
   * World-space position used for incoming-attack range gating (see
   * RingScene._resolveAttack). Normally the fighter's true (x, y); while a
   * slip is active it's offset toward the flick direction. This is how the
   * slip's "invincibility" is implemented — it's not a bypass flag, it's the
   * same distance-based whiff/land/smother math in _resolveAttack reading a
   * displaced target, so no parallel collision system is needed.
   */
  getHitPos() {
    if (this.slipTimer <= 0) return { x: this.x, y: this.y };
    return {
      x: this.x + this.slipDirX * config.slipHeadOffsetX,
      y: this.y + this.slipDirY * config.slipHeadOffsetY,
    };
  }

  /**
   * Trigger a slip/duck in the given (normalized) direction. Ignored while
   * blocking or while a slip is already active — mutually exclusive with
   * block, same as punch/block (see CLAUDE.md note in main.js/README about
   * this being an assumption, not a spec'd rule).
   */
  _triggerSlip(dirX, dirY) {
    if (this.isBlocking || this.slipTimer > 0) return;
    this.slipTimer = config.slipInvincibilityDuration;
    this.slipDirX  = dirX;
    this.slipDirY  = dirY;
  }

  /**
   * Apply a velocity impulse (e.g. from an incoming punch) directly to the
   * fighter's momentum, reusing the same vx/vy the movement system already
   * decays via friction — no separate stagger state needed.
   */
  receiveImpulse(vx, vy) {
    this.vx += vx;
    this.vy += vy;
  }

  /**
   * Trigger a brief color flash on the fighter's torso (mirrors Dummy.flash).
   * @param {number} color  Phaser integer color
   */
  flash(color) {
    this.flashAlpha = 1.0;
    this.flashColor = color;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _draw() {
    // rig.js owns the punch trajectory now — this just hands it the current
    // punch type/arm and normalized progress (see _punchState()).
    drawRig(
      this.gfx,
      cssHex(config.fighterBodyColor),
      cssHex(config.fighterSkinColor),
      this._punchState(),
      this.isBlocking ? 1 : 0,
      this._bob,
    );

    // ── Hit flash overlay drawn ON TOP of the rig (mirrors Dummy's) ────────
    if (this.flashAlpha > 0) {
      this.gfx.fillStyle(this.flashColor, this.flashAlpha * 0.55);
      this.gfx.fillRect(-14, -50, 28, 64);   // covers torso + head area
    }

    // ── Slip/duck visual lean, or down pose (Stage 6) ───────────────────────
    // Purely cosmetic — offsets/rotates/scales the gfx child within the
    // container, never the container's own position (this.x/this.y stay the
    // true, logic-authoritative position used for range gating/boundaries).
    // Deliberately uses transforms footwork and guard never touch (rotation,
    // vertical squash) rather than a plain translate — footwork already
    // translates the rig every frame, so a lean built only from translation
    // would be hard to tell apart from ordinary movement in a screenshot.
    // Horizontal flick  → rig tilts (lean), footwork never rotates.
    // Vertical flick    → rig squashes (crouch/dip), footwork never scales.
    // Down (knockdown)  → far more extreme rotation + squash than a slip
    // ever uses, so it reads as a distinct, more dramatic state.
    let leanX = 0, leanY = 0, leanRot = 0, squashY = 1;
    if (this.isDown) {
      leanY   = 26;
      leanRot = Math.PI / 2 * 0.9;
      squashY = 0.35;
    } else if (this.slipTimer > 0) {
      const progress = 1 - this.slipTimer / config.slipInvincibilityDuration;
      const wave     = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
      leanX   = this.slipDirX * config.slipHeadOffsetX * 0.35 * wave;
      leanRot = this.slipDirX * 0.35 * wave;
      squashY = 1 - Math.abs(this.slipDirY) * 0.3 * wave;
    }
    this.gfx.setPosition(leanX, leanY);
    this.gfx.setRotation(leanRot);
    this.gfx.setScale(1, squashY);
  }

  // ── Main update ─────────────────────────────────────────────────────────────

  /**
   * @param {number} dt          seconds
   * @param {number} inputX      -1..1 horizontal
   * @param {number} inputY      -1..1 vertical
   * @param {{left,right,top,bottom}} ringBounds
   * @param {number} opponentX   world-space x of the opponent, used for facing
   * @param {boolean} blockHeld  is the block input currently held
   */
  update(dt, inputX, inputY, ringBounds, opponentX, blockHeld) {
    // ── Knockdown (Stage 6) ──────────────────────────────────────────────────
    // Counts down regardless of anything else below; getting back up restores
    // a fraction of health (see config.knockdownHealthRestorePct) rather than
    // full — see the ASSUMPTION note on that config value.
    if (this.isDown) {
      this.knockdownTimer = Math.max(0, this.knockdownTimer - dt);
      if (this.knockdownTimer === 0) {
        this.isDown  = false;
        this.health  = config.healthMax * config.knockdownHealthRestorePct;
      }
    }

    // ── Punch timer ────────────────────────────────────────────────────────
    if (this.punchTimer > 0) {
      this.punchTimer = Math.max(0, this.punchTimer - dt);
      if (this.punchTimer === 0) { this.punchArm = null; this.punchType = null; }
    }

    // ── Block ──────────────────────────────────────────────────────────────
    // Engages the instant the block input is held AND no punch is mid-flight —
    // an in-progress punch is left to finish rather than snapping its animation.
    // Also mutually exclusive with an active slip (assumption — see summary),
    // and disabled entirely while down (Stage 6).
    this.isBlocking = !this.isDown && blockHeld && this.punchTimer === 0 && this.slipTimer === 0;

    // ── Slip/duck: flick-vs-hold detector — suspended entirely while down ──
    // Watches the same merged inputX/inputY everything else reads — a pure
    // observer that never gates or delays normal movement/footwork below.
    if (!this.isDown) {
      const pushMag = Math.hypot(inputX, inputY);
      if (pushMag >= config.slipInputThreshold) {
        if (this._pushTimerMs === 0) {
          // Push just started — capture the direction now, not at release,
          // so a direction change mid-push doesn't retroactively change it.
          this._pushDirX = inputX / pushMag;
          this._pushDirY = inputY / pushMag;
          this._pushHoldConfirmed = false;
        }
        this._pushTimerMs += dt * 1000;
        if (this._pushTimerMs > config.slipFlickMaxDurationMs) {
          this._pushHoldConfirmed = true;   // held too long — reads as footwork now
        }
      } else {
        // Released (or never reached threshold this frame).
        if (this._pushTimerMs > 0 && !this._pushHoldConfirmed) {
          this._triggerSlip(this._pushDirX, this._pushDirY);   // released early = flick
        }
        this._pushTimerMs = 0;
        this._pushHoldConfirmed = false;
      }
    }
    if (this.slipTimer > 0) this.slipTimer = Math.max(0, this.slipTimer - dt);

    // ── Hit flash decay ────────────────────────────────────────────────────
    if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - dt / 0.18);

    // ── Stamina drain/regen (Stage 6) — frozen while down ───────────────────
    // Punch cost is deducted once at throw time (see startPunch()); this only
    // handles the continuous block drain and the neither-punching-nor-blocking
    // regen case.
    if (!this.isDown) {
      if (this.isBlocking) {
        this.stamina = Math.max(0, this.stamina - config.staminaDrainPerSecondBlocking * dt);
      } else if (this.punchTimer === 0) {
        this.stamina = Math.min(config.staminaMax, this.stamina + config.staminaRegenPerSecond * dt);
      }
    }

    // ── Movement physics + ring boundary clamp ─────────────────────────────
    // Shared with the dummy's movement AI via movement.js. Frozen while down by
    // zeroing the input (residual velocity still bleeds off through friction,
    // exactly as before) rather than by skipping the step.
    stepMovement(
      this,
      dt,
      this.isDown ? 0 : inputX,
      this.isDown ? 0 : inputY,
      ringBounds,
      config.moveSpeed,
    );

    // Movement bounce — zero while down, so the knockdown pose stays still.
    this._bob = this.isDown ? 0 : stepBob(this, dt, this.vx, this.vy, config.moveSpeed);

    // ── Facing ─────────────────────────────────────────────────────────────
    // Always face the opponent, independent of movement input/direction.
    // Frozen while down so the knockdown pose doesn't suddenly mirror-flip.
    if (!this.isDown) {
      if (opponentX > this.x) this.facingRight = true;
      else if (opponentX < this.x) this.facingRight = false;
    }

    // ── Sync container ─────────────────────────────────────────────────────
    this.container.setPosition(this.x, this.y);
    this.container.setScale(this.facingRight ? 1 : -1, 1);

    this._draw();
  }
}

import Phaser from 'phaser';
import { config } from './config.js';
import { drawRig } from './rig.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

// Visual extent of the rig from the container origin (derived from rig.js layout).
// Used for boundary clamping. Update if the rig geometry changes.
const RIG_MARGIN_X      = 24;   // arms reach ~22 px left/right of origin
const RIG_MARGIN_TOP    = 67;   // head top: -50 - 13 - 4 pad
const RIG_MARGIN_BOTTOM = 44;   // shin bottom: 29 + 11 + 4 pad

/**
 * Fighter — player-controlled boxer rig.
 *
 * Local origin = torso center.  Container.scaleX = ±1 controls facing direction;
 * facing always tracks the opponent's position, never movement input.
 * Punch state drives arm extension in drawRig() via leadExtend / rearExtend.
 */
export class Fighter {
  constructor(scene, x, y) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facingRight = true;

    // Punch animation state
    this.punchArm   = null;   // 'lead' | 'rear' | null
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
   * @param {'lead'|'rear'} arm  which local arm to animate
   */
  startPunch(arm) {
    const lowStamina    = this.stamina < config.lowStaminaThreshold;
    this._punchDuration = config.punchDuration * (lowStamina ? config.lowStaminaWindupMultiplier : 1);
    this.punchArm        = arm;
    this.punchTimer      = this._punchDuration;
    this.stamina         = Math.max(0, this.stamina - config.staminaDrainPerPunch);
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
    this.punchTimer     = 0;
    this.isBlocking     = false;
    this.slipTimer      = 0;
    this.vx = 0;
    this.vy = 0;
  }

  /**
   * Return the world-space position of the specified fist (for flash spawning).
   * @param {'lead'|'rear'} arm
   * @returns {{ x: number, y: number }}
   */
  getFistPos(arm) {
    // Local fist x: lead arm at -19, rear arm at +19 (from rig.js layout)
    const localX = arm === 'lead' ? -19 : 19;
    const flip   = this.facingRight ? 1 : -1;
    return { x: this.x + localX * flip, y: this.y - 14 };
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
    let leadExtend = 0, rearExtend = 0;

    if (this.punchTimer > 0 && this.punchArm) {
      // Triangle wave: 0 → 1 at half-duration, 1 → 0 at full duration.
      // Uses this._punchDuration (not config.punchDuration directly) since a
      // low-stamina punch may be stretched — see startPunch().
      const progress = 1 - this.punchTimer / this._punchDuration;
      const wave     = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
      if (this.punchArm === 'lead') leadExtend = wave;
      else                          rearExtend = wave;
    }

    drawRig(
      this.gfx,
      cssHex(config.fighterBodyColor),
      cssHex(config.fighterSkinColor),
      leadExtend,
      rearExtend,
      this.isBlocking ? 1 : 0,
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
      if (this.punchTimer === 0) this.punchArm = null;
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

    // ── Movement physics — frozen while down (residual velocity bleeds off) ─
    const accelRate    = config.acceleration / config.playerMass;
    const frictionRate = config.friction     / config.playerMass;
    const hasInput     = !this.isDown && (Math.abs(inputX) > 0.01 || Math.abs(inputY) > 0.01);

    if (hasInput) {
      const len = Math.sqrt(inputX * inputX + inputY * inputY);
      const nx  = inputX / Math.max(len, 1);
      const ny  = inputY / Math.max(len, 1);
      const tvx = nx * config.moveSpeed;
      const tvy = ny * config.moveSpeed;
      const a   = Math.min(1, accelRate * dt);
      this.vx  += (tvx - this.vx) * a;
      this.vy  += (tvy - this.vy) * a;
    } else {
      const decay = Math.min(1, frictionRate * dt);
      this.vx *= (1 - decay);
      this.vy *= (1 - decay);
      if (Math.abs(this.vx) < 0.5) this.vx = 0;
      if (Math.abs(this.vy) < 0.5) this.vy = 0;
    }

    const spd = Math.hypot(this.vx, this.vy);
    if (spd > config.moveSpeed) {
      this.vx = (this.vx / spd) * config.moveSpeed;
      this.vy = (this.vy / spd) * config.moveSpeed;
    }

    // ── Position ───────────────────────────────────────────────────────────
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // ── Ring boundary clamp ────────────────────────────────────────────────
    const preX = this.x, preY = this.y;
    this.x = Phaser.Math.Clamp(this.x, ringBounds.left + RIG_MARGIN_X,   ringBounds.right  - RIG_MARGIN_X);
    this.y = Phaser.Math.Clamp(this.y, ringBounds.top  + RIG_MARGIN_TOP, ringBounds.bottom - RIG_MARGIN_BOTTOM);
    if (this.x !== preX) this.vx = 0;
    if (this.y !== preY) this.vy = 0;

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

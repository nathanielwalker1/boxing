import { config, punchSpeedMult, playerPalette } from './config.js';
import { drawRig, drawGloveFlash, computePose, peakProgress, armSlot, hurtboxes, wristPath } from './rig.js';
import { stepMovement, stepBob, stepFacing } from './movement.js';
import { HitReaction } from './reaction.js';
import { stepVulnerability, clearVulnerabilityPunish } from './vulnerability.js';

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
    this.punchAim   = 0;      // aim-cone bend (radians), LOCKED at the input frame — see aimAngle() in rig.js

    // Multiplies the POST-PEAK portion of the current punch's timeline. 1 =
    // normal; config.whiffRecoveryMultiplier once this punch has resolved as a
    // whiff or a smother (see extendRecovery). Reset on every new punch.
    this._recoveryScale = 1;

    // Block state — isBlocking only goes true once any in-progress punch has
    // finished (see update()), so a held block never snaps a punch animation.
    // The one exception is an extended whiff recovery, where the guard stays
    // immediately available — see the locked-mechanic note in update().
    this.isBlocking = false;
    // Seconds the guard has been continuously up; Infinity while not blocking.
    // This is what makes a perfect block detectable (Stage 16 part 4) — a guard
    // raised at the last instant and one held for five seconds were previously
    // indistinguishable.
    this.blockHeldTime = Infinity;

    // Continuous 0..1 exposure (Stage 16 part 1) — see vulnerability.js. Read by
    // the counter multiplier in _resolveAttack, and by the debug readout.
    this.vulnerability = 0;
    this._punishTimer  = 0;   // perfect-block punish spike (part 4)
    this._punishVuln   = 0;

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

    // Hit flash state (mirrors Dummy's). Since Stage 10 this is only raised for
    // BLOCKED hits — a clean hit is communicated by the rig reaction below.
    this.flashAlpha = 0;
    this.flashColor = 0xffffff;

    // Localized spring-damped hit reaction (Stage 10) — head/torso/tilt offsets
    // in rig-local space, layered on top of the whole-body knockback that
    // receiveImpulse() already applies to vx/vy. See reaction.js.
    this.reaction = new HitReaction();

    // Health/stamina/knockdown (Stage 6) — see takeDamage()/_triggerKnockdown().
    this.health       = config.healthMax;
    this.stamina      = config.staminaMax;
    this.isDown       = false;
    this.knockdownTimer = 0;
    this._punchDuration = config.punchDuration;   // this punch's actual duration (may be stretched by low stamina)
    // Seconds of stamina-regen suppression left after taking a hit (Stage 17
    // part 0d) — see receiveStaminaChip(). Mirrored on Dummy.
    this._hitRegenDelay = 0;

    this.container = scene.add.container(x, y);
    this.gfx       = scene.add.graphics();
    this.container.add(this.gfx);
    // Initial value only — RingScene re-derives BOTH fighters' depth from their
    // world y every frame, so whoever is lower on screen draws in front. See
    // _updateDepthSort() in main.js.
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
   * @param {number} [aim]        aim-cone bend in radians, sampled by the caller
   *        on THIS frame and stored unchanged for the punch's whole duration —
   *        never re-sampled (see aimAngle() in rig.js for why)
   */
  startPunch(arm, type, aim = 0) {
    const lowStamina    = this.stamina < config.lowStaminaThreshold;
    this._punchDuration = config.punchDuration / punchSpeedMult(type)
                          * (lowStamina ? config.lowStaminaWindupMultiplier : 1);
    this.punchArm        = arm;
    this.punchType       = type;
    this.punchAim        = aim;
    this.punchTimer      = this._punchDuration;
    this._recoveryScale  = 1;
    this.stamina         = Math.max(0, this.stamina - config.staminaDrainPerPunch);
  }

  /**
   * This punch's animation progress, 0..1. Divides by the EFFECTIVE duration
   * (base × any whiff-recovery stretch) rather than the base one, so a stretched
   * recovery plays the same pose sequence over a longer real time instead of
   * being clipped.
   */
  punchProgress() {
    if (this.punchTimer <= 0) return 0;
    const total = this._punchDuration * this._recoveryScale;
    return total > 0 ? 1 - this.punchTimer / total : 1;
  }

  /**
   * Stretch what's LEFT of this punch — its recovery (Stage 16 part 2). Called
   * by RingScene._resolveAttack the instant a punch resolves as a whiff or a
   * smother, which is at peak extension, so by construction the cock and the
   * extension have already happened and only the post-peak portion is affected.
   *
   * Scaling the remaining timer and the effective duration by the same factor
   * keeps punchProgress() exactly continuous across the change — the arm does
   * not jump, it just starts retracting slower — and it means the vulnerability
   * decay (which is expressed in progress) stretches with it for free.
   */
  extendRecovery(mult) {
    const k = Math.max(1, mult || 1);
    if (k === 1 || this.punchTimer <= 0) return;
    this.punchTimer     *= k;
    this._recoveryScale *= k;
  }

  /**
   * True while this fighter is paying the whiff penalty. Gates re-throwing (see
   * RingScene._resolvePunch) — but deliberately NOT blocking, which stays
   * immediately available throughout. See update().
   */
  get inWhiffRecovery() {
    return this.punchTimer > 0 && this._recoveryScale > 1;
  }

  /**
   * The x an OPPONENT should face toward — see stepFacing(). The player has no
   * stagger offset (impulses go straight into vx/vy), so this IS this.x; it
   * exists so both fighters expose the same facing contract.
   */
  get facingAnchorX() { return this.x; }

  /**
   * The body other systems should push against. The player has no stagger
   * offset, so this is the Fighter itself. See resolveOverlap().
   */
  get locoBody() { return this; }

  /**
   * Current punch animation state in the form rig.js consumes, or null when
   * idle. Shared by _draw() and getFistPos() so both read the same pose.
   */
  _punchState(atPeak = false) {
    if (this.punchTimer <= 0 || !this.punchArm) return null;
    return {
      type: this.punchType,
      arm:  armSlot(this.stance, this.punchArm),   // anatomical → rig slot
      p:    atPeak ? peakProgress(this.punchType) : this.punchProgress(),
      aim:  this.punchAim,                         // locked at throw time, never re-sampled
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
    this.punchAim       = 0;
    this._recoveryScale = 1;
    this.isBlocking     = false;
    this.blockHeldTime  = Infinity;
    this.slipTimer      = 0;
    clearVulnerabilityPunish(this);   // the knockdown supersedes any punish window
    this.vx = 0;
    this.vy = 0;
    this.reaction.reset();   // the knockdown pose takes the rig over entirely
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
    const pose = computePose(this._punchState(true), this.isBlocking ? 1 : 0, this._bob, this.reaction.pose());
    const hand = armSlot(this.stance, arm) === 'lead' ? pose.lead : pose.rear;
    const flip = this.facingRight ? 1 : -1;
    return { x: this.x + hand.wx * flip, y: this.y + hand.wy };
  }

  /**
   * The world-space arc this punch's wrist travelled from its cocked pose to
   * full extension (Stage 16 part 5) — what the whiff streak is drawn along.
   * Same mirror/anchor conversion getFistPos() uses, so the streak's head lands
   * exactly on the fist position the resolver tested with.
   * @param {'left'|'right'} arm  anatomical arm
   * @param {string} type         punch type (passed in rather than read off
   *        this.punchType, so a resolution can't be misattributed if the punch
   *        state has already been cleared)
   */
  getWristPath(arm, type) {
    const flip = this.facingRight ? 1 : -1;
    const pts  = wristPath(
      type, armSlot(this.stance, arm), this.punchAim,
      config.whiffStreakSamples, this._bob, this.reaction.pose(),
    );
    return pts.map(p => ({ x: this.x + p.x * flip, y: this.y + p.y }));
  }

  /**
   * World-space shoulder the given arm pivots about, sampled at the same peak
   * pose getFistPos() uses. Only the aim-cone debug overlay needs this — the
   * cone is drawn from the joint the bend actually rotates around.
   * @param {'left'|'right'} arm
   */
  getShoulderPos(arm) {
    const pose = computePose(this._punchState(true), this.isBlocking ? 1 : 0, this._bob, this.reaction.pose());
    const hand = armSlot(this.stance, arm) === 'lead' ? pose.lead : pose.rear;
    const flip = this.facingRight ? 1 : -1;
    return { x: this.x + hand.sx * flip, y: this.y + hand.sy };
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
    const pose = computePose(this._punchState(), this.isBlocking ? 1 : 0, this._bob, this.reaction.pose());
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
   * Localized hit reaction (Stage 10) — the punch-type-specific part of getting
   * hit. Called by RingScene._resolveAttack alongside receiveImpulse/takeDamage,
   * with the SAME force value all three share, so a weak retreating jab and a
   * hard advancing cross differ in reaction as well as in damage.
   * @param {string} punchType
   * @param {number} force    post-block impact force
   */
  receiveHit(punchType, force) {
    this.reaction.apply(punchType, force);
  }

  /**
   * Stamina chip damage from being hit (Stage 17 part 0d) — mirrored verbatim on
   * Dummy, so both fighters tire from absorbing punches on the same terms.
   *
   * Takes the SAME post-block-reduction force value receiveImpulse/receiveHit/
   * takeDamage are handed, so there is no flat per-hit constant and no parallel
   * damage number: the counter bonus, the momentum term and the per-punch damage
   * multiplier all reach this for free.
   *
   * `blocked` layers staminaDrainBlockedMult ON TOP of blockReduction having
   * already cut the force — the guard soaking a punch is its own kind of tiring.
   * The regen pause is what stops staminaRegenPerSecond repaying the chip before
   * the next punch of an exchange arrives.
   *
   * Not called at all on a PERFECT block — see the note in _resolveAttack; that
   * waiver is now half of what a perfect block is worth.
   * @param {number}  force    post-block impact force
   * @param {boolean} blocked
   */
  receiveStaminaChip(force, blocked) {
    const mult = blocked ? config.staminaDrainBlockedMult : 1;
    const cost = Math.max(0, force) * config.staminaDrainPerHitForce * mult;
    // Clamped at 0, never negative — getting hit at 0 stamina is a no-op, not an
    // error and not a debt carried into the next regen tick.
    this.stamina = Math.max(0, this.stamina - cost);
    this._hitRegenDelay = Math.max(this._hitRegenDelay, config.staminaRegenDelayAfterHit);
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
    const react = this.reaction.pose();
    const pose  = drawRig(
      this.gfx,
      playerPalette(),
      this._punchState(),
      this.isBlocking ? 1 : 0,
      this._bob,
      react,
    );

    // ── Block flash overlay drawn ON TOP of the rig (mirrors Dummy's) ──────
    // Stage 16 part 5: localized to the gloves, where the block happens. Was a
    // flat fillRect(-14, -50, 28, 64) slab over the torso and head.
    if (this.flashAlpha > 0) drawGloveFlash(this.gfx, pose, this.flashColor, this.flashAlpha);

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
    // NOTE: the hit-reaction lean is NOT applied here — drawRig tilts only the
    // upper body around the waist, so the planted shins stay planted. Rotating
    // the whole graphics object (as this does for slip/knockdown, which are
    // whole-body states) swung the feet out from under the fighter.
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
   * @param {number} opponentX   the opponent's LOCOMOTION x (their facingAnchorX),
   *                             used for facing — see stepFacing()
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
    //
    // LOCKED MECHANIC (CLAUDE.md): blocking and punching are mutually exclusive,
    // but switching between them must feel instant. Stage 16 part 2 stretches
    // the recovery of a whiffed punch, and that penalty must NOT read as the
    // controls going dead — so the guard is available for the whole extended
    // window. What the penalty still costs is the throw: _resolvePunch refuses
    // while inWhiffRecovery, and the punch timer keeps running underneath the
    // raised guard rather than being cancelled by it. Getting punished for a
    // whiff means "you were caught out of position", not "input stopped".
    const wasBlocking = this.isBlocking;
    const guardOpen   = this.punchTimer === 0 || this.inWhiffRecovery;
    this.isBlocking   = !this.isDown && blockHeld && guardOpen && this.slipTimer === 0;

    // How long the guard has been up, for the perfect-block test (part 4).
    // Zeroed on the rising edge only, so a held guard ages out of the window and
    // a re-raise starts a fresh one.
    this.blockHeldTime = this.isBlocking
      ? (wasBlocking ? this.blockHeldTime + dt : 0)
      : Infinity;

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
    if (this.flashAlpha > 0) {
      this.flashAlpha = Math.max(0, this.flashAlpha - dt / Math.max(0.01, config.blockFlashDuration));
    }

    // ── Hit reaction springs (Stage 10) ────────────────────────────────────
    this.reaction.update(dt);

    // ── Vulnerability (Stage 16 part 1) ────────────────────────────────────
    // AFTER the punch timer and the block state above, so it reads this frame's
    // settled values — a punch resolving later this frame sees the same number
    // the player is looking at in the debug readout.
    stepVulnerability(this, dt);

    // ── Stamina drain/regen (Stage 6) — frozen while down ───────────────────
    // Punch cost is deducted once at throw time (see startPunch()); this only
    // handles the continuous block drain and the neither-punching-nor-blocking
    // regen case.
    // The post-hit regen pause (Stage 17 part 0d) ticks down on the same clock
    // whatever else is happening — it suppresses regen, it doesn't gate drain.
    if (this._hitRegenDelay > 0) this._hitRegenDelay = Math.max(0, this._hitRegenDelay - dt);
    if (!this.isDown) {
      if (this.isBlocking) {
        this.stamina = Math.max(0, this.stamina - config.staminaDrainPerSecondBlocking * dt);
      } else if (this.punchTimer === 0 && this._hitRegenDelay === 0) {
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
    // Same shared rule the dummy uses — see stepFacing() in movement.js.
    if (!this.isDown) {
      this.facingRight = stepFacing(this.facingRight, this.x, opponentX);
    }

    // ── Sync container ─────────────────────────────────────────────────────
    this.container.setPosition(this.x, this.y);
    this.container.setScale(this.facingRight ? 1 : -1, 1);

    this._draw();
  }
}

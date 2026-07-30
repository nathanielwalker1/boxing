import Phaser from 'phaser';
import { config } from './config.js';
import { drawRig } from './rig.js';
import { stepMovement } from './movement.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * Dummy — the opponent fighter. Reactive heuristics layered on the systems the
 * player already uses; no pathfinding, no decision tree, no difficulty tiers.
 *
 *   1. Movement AI      — steers to hold config.dummyStandoffDist via the shared
 *                         locomotion step (movement.js), with a hysteresis
 *                         deadband so it settles instead of hunting.
 *   2. Range-gated      — the randomized timer only ARMS an attack; the throw
 *      attacks           also requires the player inside the landing band.
 *   3. Reactive block    — rolls dummyBlockReactionChance when the player throws,
 *                         reusing isBlocking / the guard pose / blockReduction.
 *   4. Opening punish    — a gassed or unguarded player drains the attack timer
 *                         faster (see _aggression).
 *
 * Position model: this.x/this.y stay the authoritative world position, but they
 * are now composed of two parts — the AI-driven locomotion body (this._loco)
 * plus the spring-damper stagger OFFSET. Previously the spring pulled back to a
 * fixed origin; it now hangs off the locomotion position, so a staggered dummy
 * recovers to wherever it has walked to rather than to where it spawned. The
 * offset-space spring math is unchanged, so the stagger feel is identical.
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
    this.scene = scene;
    this.x     = x;
    this.y     = y;

    // Locomotion body handed to stepMovement — the same {x,y,vx,vy} contract the
    // player's Fighter satisfies. Kept as a sub-object (rather than stepping
    // this.x directly) so the stagger offset below can sit on top of it without
    // the AI steering against its own stagger wobble.
    this._loco = { x, y, vx: 0, vy: 0 };

    // Mirrored from _loco each frame — _resolveAttack reads attacker.vx/vy for
    // the momentum contribution to punch force. Now that the dummy actually
    // moves, its punches gain force when it throws while advancing, exactly
    // like the player's (this was pinned at 0 while it was a static target).
    this.vx = 0;
    this.vy = 0;

    // Spring-damper stagger, tracked as an OFFSET from the locomotion position
    // (springs toward 0 rather than toward a fixed origin).
    this.staggerX  = 0;
    this.staggerY  = 0;
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

    // Attack cadence
    this._onAttackImpact  = onAttackImpact;
    this.attackTimer      = randRange(config.dummyAttackDelayMin, config.dummyAttackDelayMax);
    this._impactPending   = false;
    this._impactTimer     = 0;
    this._windupDuration  = config.dummyWindupDuration;   // this attack's actual windup (may be stretched by low stamina)
    this._forceAttack     = false;   // debug T key — bypasses the range gate (see forceAttack)

    // Reactive block (Stage 7) — same isBlocking flag _resolveAttack already
    // reads on the player, so blockReduction applies with no new plumbing.
    this.isBlocking = false;
    this.blockTimer = 0;

    // Cached each frame for the attack gate / aggression check, and read by
    // onOpponentPunchStart (which fires earlier in the frame, so it sees the
    // previous frame's value — a ~16 ms lag that doesn't matter here).
    this._distToOpponent = Infinity;
    this._aggression     = 1;

    // Health/stamina/knockdown (Stage 6) — mirrors Fighter's, symmetric fight.
    this.health         = config.healthMax;
    this.stamina        = config.staminaMax;
    this.isDown         = false;
    this.knockdownTimer = 0;

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
      // over this._windupDuration (not config.dummyWindupDuration directly,
      // since low stamina stretches it — see update()) so it's slow enough to
      // react to — the player's own punches stay snappy and unaffected.
      const progress = 1 - this.punchTimer / this._windupDuration;
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
      this.isBlocking ? 1 : 0,   // same guard pose the player's block uses
    );

    // ── Down pose (Stage 6) — same exaggerated rotate+squash as Fighter's,
    //    applied post-hoc to the gfx child so this.x/this.y stay authoritative.
    if (this.isDown) {
      this.gfx.setPosition(0, 26);
      this.gfx.setRotation(Math.PI / 2 * 0.9);
      this.gfx.setScale(1, 0.35);
    } else {
      this.gfx.setPosition(0, 0);
      this.gfx.setRotation(0);
      this.gfx.setScale(1, 1);
    }
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
    this.isDown          = true;
    this.knockdownTimer  = config.knockdownRecoveryDuration;
    this.punchArm        = null;
    this.punchTimer      = 0;
    this._impactPending  = false;
    this._forceAttack    = false;
    this.isBlocking      = false;
    this.blockTimer      = 0;
    this.staggerVx = 0;
    this.staggerVy = 0;
  }

  /**
   * Reactive block (Stage 7) — called by the scene the instant the player
   * commits to a punch, before the punch resolves. Rolls once against
   * config.dummyBlockReactionChance; on success the guard goes up for
   * config.dummyBlockReactionWindow seconds, which also covers follow-up
   * punches thrown inside that window.
   *
   * NOTE: the player's punch resolves on the same frame as the button press
   * (Stage 2 design, untouched here), so this reaction necessarily has zero
   * latency — there is no player-side windup for it to lose a race against.
   * Giving the player's punch a resolution delay would be a player-side change,
   * so it's flagged rather than done.
   */
  onOpponentPunchStart() {
    if (this.isDown) return;
    if (this.punchTimer > 0) return;                                  // mid-windup: punching and blocking are mutually exclusive
    if (this.blockTimer > 0) return;                                  // guard already up — don't re-roll or extend it
    if (this._distToOpponent > config.rangeMax) return;               // nothing to defend against from out of range
    if (Math.random() >= config.dummyBlockReactionChance) return;     // failed the roll — eats this one

    this.blockTimer = config.dummyBlockReactionWindow;
    this.isBlocking = true;   // set now, not in update(), so it applies to the punch that triggered it
  }

  /**
   * TEMPORARY DEBUG HOOK (Stage 5) — forces the next attack to fire immediately,
   * bypassing the randomized cadence AND (since Stage 7) the range gate, so the
   * throw still happens on demand from any distance for whiff/slip testing.
   * Intentionally left in past Stage 5 — see the T key in main.js. No-ops while
   * a windup is already in progress or while down.
   */
  forceAttack() {
    if (this.punchTimer > 0 || this.isDown) return;
    this.attackTimer  = 0;
    this._forceAttack = true;
    this.blockTimer   = 0;       // drop the guard so the block exclusion can't swallow the forced throw
    this.isBlocking   = false;
  }

  /**
   * @param {Fighter} player                          the opponent — position, stamina and block state drive the AI
   * @param {{left,right,top,bottom}} ringBounds      same bounds object the player clamps against
   */
  update(dt, player, ringBounds) {
    // ── Knockdown (Stage 6) — counts down regardless of anything else below;
    //    getting back up restores a fraction of health, not full (see the
    //    ASSUMPTION note on config.knockdownHealthRestorePct).
    if (this.isDown) {
      this.knockdownTimer = Math.max(0, this.knockdownTimer - dt);
      if (this.knockdownTimer === 0) {
        this.isDown  = false;
        this.health  = config.healthMax * config.knockdownHealthRestorePct;
      }
    }

    // ── Punch windup animation timer ───────────────────────────────────────
    if (this.punchTimer > 0) {
      this.punchTimer = Math.max(0, this.punchTimer - dt);
      if (this.punchTimer === 0) this.punchArm = null;
    }

    // ── Block state (Stage 7) ──────────────────────────────────────────────
    // Raised by onOpponentPunchStart(); expires on its own timer. Suppressed
    // mid-windup so the locked "blocking and punching are mutually exclusive"
    // rule holds for the dummy too.
    if (this.blockTimer > 0) this.blockTimer = Math.max(0, this.blockTimer - dt);
    this.isBlocking = !this.isDown && this.blockTimer > 0 && this.punchTimer === 0;

    // ── Stamina (Stage 6) — frozen while down; per-punch cost is deducted at
    //    throw time below. Blocking drains and suppresses regen, same as the
    //    player's, so the dummy's guard isn't free either.
    if (!this.isDown) {
      if (this.isBlocking) {
        this.stamina = Math.max(0, this.stamina - config.staminaDrainPerSecondBlocking * dt);
      } else if (this.punchTimer === 0) {
        this.stamina = Math.min(config.staminaMax, this.stamina + config.staminaRegenPerSecond * dt);
      }
    }

    // ── 1. Movement AI ─────────────────────────────────────────────────────
    // Steer to hold dummyStandoffDist: advance when too far, back off when too
    // close (rather than just stopping — sitting inside the smother zone kills
    // its own jab, so stepping back out restores its full attack options and
    // produces the natural in-and-out rhythm).
    //
    // Distance is measured from the LOCOMOTION position, not this.x, so the
    // stagger wobble doesn't feed back into the steering as oscillation. Two
    // anti-jitter measures: a hysteresis deadband (no steering at all inside
    // it) and a proportional taper that eases speed down as it approaches the
    // band edge, so it decelerates into the band instead of overshooting and
    // bouncing back out. The taper reuses the band width — no extra constant.
    let mvx = 0, mvy = 0;
    if (!this.isDown) {
      const dx   = player.x - this._loco.x;
      const dy   = player.y - this._loco.y;
      const raw  = Math.hypot(dx, dy);
      const band = config.dummyStandoffBand;
      const err  = raw - config.dummyStandoffDist;

      if (Math.abs(err) > band) {
        // Degenerate overlap: no usable direction, so back straight off along
        // the axis it's facing.
        const ux = raw > 1 ? dx / raw : (this.facingRight ? 1 : -1);
        const uy = raw > 1 ? dy / raw : 0;
        const mag  = Phaser.Math.Clamp(Math.abs(err) / (band * 2), 0, 1);
        const sign = err > 0 ? 1 : -1;   // +1 = close in, -1 = back off
        mvx = ux * sign * mag;
        mvy = uy * sign * mag;
      }
    }

    // Shared locomotion step — same physics + ring clamp as the player.
    stepMovement(this._loco, dt, mvx, mvy, ringBounds, config.dummyMoveSpeed);

    // ── Spring-damper stagger, in offset space (springs back toward 0) ──────
    const ax = -config.dummyReturnSpeed * this.staggerX - config.dummyDamping * this.staggerVx;
    const ay = -config.dummyReturnSpeed * this.staggerY - config.dummyDamping * this.staggerVy;
    this.staggerVx += ax * dt;
    this.staggerVy += ay * dt;
    this.staggerX  += this.staggerVx * dt;
    this.staggerY  += this.staggerVy * dt;

    // ── Compose the authoritative world position + velocity ────────────────
    this.x  = this._loco.x + this.staggerX;
    this.y  = this._loco.y + this.staggerY;
    this.vx = this._loco.vx;
    this.vy = this._loco.vy;

    // Cached for the attack gate, the aggression check, and onOpponentPunchStart.
    this._distToOpponent = Math.hypot(player.x - this.x, player.y - this.y);

    // ── Facing — always toward the player, so the punch telegraph swings the
    //    correct direction even if they circle past the dummy. Frozen while
    //    down so the knockdown pose doesn't suddenly mirror-flip. ─────────
    if (!this.isDown) {
      if (player.x > this.x) this.facingRight = true;
      else if (player.x < this.x) this.facingRight = false;
      this.container.setScale(this.facingRight ? 1 : -1, 1);
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

    // ── 2 + 4. Attack cadence: range-gated trigger + opening punish ────────
    // Suspended entirely while down (Stage 6) — a downed dummy can't throw.
    if (!this.isDown) {
      // 4. Aggression drains the timer FASTER rather than re-rolling a shorter
      // delay, so the punish tracks an opening appearing or closing mid-wait
      // instead of being locked in at the moment the last punch landed. The two
      // openings stack multiplicatively — gassed AND unguarded is punished
      // harder than either alone.
      const mult    = config.dummyOpeningAggressionMultiplier;
      const inRange = this._distToOpponent <= config.rangeMax;
      let aggression = 1;
      if (inRange && !player.isBlocking)                        aggression *= mult;
      if (player.stamina < config.lowStaminaThreshold)          aggression *= mult;
      this._aggression = aggression;

      this.attackTimer -= dt * aggression;

      if (this.attackTimer <= 0) {
        // Timer expired = ARMED, not fired. Held at 0 so it throws the instant
        // it's actually in range instead of rolling a fresh 1.5–3.5 s wait
        // after the movement AI finally closes the distance.
        this.attackTimer = 0;

        // 2. Only throw when the punch can actually land: inside the same
        //    landing band _resolveAttack gates on (the dummy throws a jab,
        //    which is smother-vulnerable, so the near edge counts too).
        const inLandingBand = this._distToOpponent <= config.rangeMax &&
                              this._distToOpponent >= config.smotherDist;
        const canThrow      = this.punchTimer === 0 && !this.isBlocking;

        if (canThrow && (inLandingBand || this._forceAttack)) {
          this._forceAttack    = false;
          this.attackTimer     = randRange(config.dummyAttackDelayMin, config.dummyAttackDelayMax);
          const lowStamina     = this.stamina < config.lowStaminaThreshold;
          this._windupDuration = config.dummyWindupDuration * (lowStamina ? config.lowStaminaWindupMultiplier : 1);
          this.punchArm        = 'lead';
          this.punchTimer      = this._windupDuration;
          this._impactPending  = true;
          this._impactTimer    = this._windupDuration / 2;
          this.stamina         = Math.max(0, this.stamina - config.staminaDrainPerPunch);
        }
      }
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

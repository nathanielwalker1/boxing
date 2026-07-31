import Phaser from 'phaser';
import { config } from './config.js';
import { drawRig, computePose, peakProgress, armSlot, leadArm, hurtboxes } from './rig.js';
import { stepMovement, stepBob } from './movement.js';
import { HitReaction } from './reaction.js';

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
   * @param {'orthodox'|'southpaw'} stance  defaults to config.dummyStance. Data
   *        flag only for now — it decides which anatomical arm jabs, and is the
   *        hook for per-opponent variety later.
   */
  constructor(scene, x, y, onAttackImpact, stance = config.dummyStance) {
    this.scene  = scene;
    this.stance = stance;
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

    // Movement bounce on top of the guard pose — see stepBob() in movement.js.
    this._bobPhase = 0;
    this._bob      = 0;

    // Hit flash state. Since Stage 10 this is only raised for BLOCKED hits —
    // a clean hit is communicated by the rig reaction below.
    this.flashAlpha = 0;
    this.flashColor = 0xffffff;

    // Localized spring-damped hit reaction (Stage 10) — head/torso/tilt offsets
    // in rig-local space. Distinct from the whole-body stagger offset above:
    // that one moves the fighter through the ring, this one deforms the pose.
    this.reaction = new HitReaction();

    // Faces the player — starts facing left since the player starts on the left.
    this.facingRight = false;

    // Punch windup animation (reuses the same rig pose solver as Fighter).
    // The dummy only throws jabs — punch variety for the opponent is a separate
    // stage; punchType exists so its damage multiplier and jab trajectory flow
    // through the same shared code the player uses.
    this.punchArm   = null;   // 'left' | 'right' | null — anatomical, same as Fighter's
    this.punchType  = null;
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

  /**
   * Current punch animation state in the form rig.js consumes, or null when
   * idle. The trajectory is the shared per-type one, but stretched over
   * this._windupDuration (NOT the player's punchDuration/speed multipliers) so
   * the dummy's telegraph stays deliberately slow and readable — see the note
   * on config.dummyWindupDuration.
   */
  _punchState(atPeak = false) {
    if (this.punchTimer <= 0 || !this.punchArm) return null;
    return {
      type: this.punchType,
      arm:  armSlot(this.stance, this.punchArm),   // anatomical → rig slot
      p:    atPeak ? peakProgress(this.punchType) : 1 - this.punchTimer / this._windupDuration,
    };
  }

  draw() {
    drawRig(
      this.gfx,
      cssHex(config.dummyBodyColor),
      cssHex(config.dummySkinColor),
      this._punchState(),
      this.isBlocking ? 1 : 0,   // same block pose the player's block uses
      this._bob,
      this.reaction.pose(),
    );

    // ── Down pose (Stage 6) — same exaggerated rotate+squash as Fighter's,
    //    applied post-hoc to the gfx child so this.x/this.y stay authoritative.
    if (this.isDown) {
      this.gfx.setPosition(0, 26);
      this.gfx.setRotation(Math.PI / 2 * 0.9);
      this.gfx.setScale(1, 0.35);
    } else {
      // The hit-reaction lean is applied inside drawRig (upper body only, so
      // the shins stay planted) — see the note in Fighter._draw.
      this.gfx.setPosition(0, 0);
      this.gfx.setRotation(0);
      this.gfx.setScale(1, 1);
    }
  }

  /**
   * Return the world-space position of the specified fist (for flash spawning).
   * @param {'left'|'right'} arm  anatomical arm; stance maps it to a rig slot
   */
  getFistPos(arm) {
    const pose = computePose(this._punchState(true), this.isBlocking ? 1 : 0, this._bob, this.reaction.pose());
    const hand = armSlot(this.stance, arm) === 'lead' ? pose.lead : pose.rear;
    const flip = this.facingRight ? 1 : -1;
    return { x: this.x + hand.wx * flip, y: this.y + hand.wy };
  }

  /**
   * World-space head + body hurtboxes (Stage 9) — see Fighter.getHurtboxes().
   * Anchored to this.x/this.y, which already includes the stagger offset, so a
   * dummy still rocking from the last punch is genuinely harder to hit clean.
   * The dummy has no slip, so there's no getHitPos() displacement here.
   * @returns {{ head: {x,y,r}, body: {x,y,hw,hh} }}
   */
  getHurtboxes() {
    const pose = computePose(this._punchState(), this.isBlocking ? 1 : 0, this._bob, this.reaction.pose());
    const hb   = hurtboxes(pose);
    const flip = this.facingRight ? 1 : -1;
    return {
      head: { x: this.x + hb.head.x * flip, y: this.y + hb.head.y, r: hb.head.r },
      body: { x: this.x + hb.body.x * flip, y: this.y + hb.body.y, hw: hb.body.hw, hh: hb.body.hh },
    };
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
   * Localized hit reaction (Stage 10) — mirrors Fighter.receiveHit(), so the
   * punch-type-specific response is identical on both sides of the fight.
   * @param {string} punchType
   * @param {number} force    post-block impact force
   */
  receiveHit(punchType, force) {
    this.reaction.apply(punchType, force);
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
    this.punchType       = null;
    this.punchTimer      = 0;
    this._impactPending  = false;
    this._forceAttack    = false;
    this.isBlocking      = false;
    this.blockTimer      = 0;
    this.staggerVx = 0;
    this.staggerVy = 0;
    this.reaction.reset();   // the knockdown pose takes the rig over entirely
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
    if (this._distToOpponent > config.dummyEngageDist) return;        // nothing to defend against from out of range
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
      if (this.punchTimer === 0) { this.punchArm = null; this.punchType = null; }
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

    // Movement bounce — driven by the LOCOMOTION velocity, so being knocked
    // around by the stagger spring doesn't read as walking. Zero while down.
    this._bob = this.isDown
      ? 0
      : stepBob(this, dt, this._loco.vx, this._loco.vy, config.dummyMoveSpeed);

    // ── Spring-damper stagger, in offset space (springs back toward 0) ──────
    const ax = -config.dummyReturnSpeed * this.staggerX - config.dummyDamping * this.staggerVx;
    const ay = -config.dummyReturnSpeed * this.staggerY - config.dummyDamping * this.staggerVy;
    this.staggerVx += ax * dt;
    this.staggerVy += ay * dt;
    this.staggerX  += this.staggerVx * dt;
    this.staggerY  += this.staggerVy * dt;

    // ── Localized hit-reaction springs (Stage 10) — rig-local, independent of
    //    the whole-body stagger above. See reaction.js.
    this.reaction.update(dt);

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
      const inRange = this._distToOpponent <= config.dummyEngageDist;
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

        // 2. Only throw when the punch can actually land. Since Stage 9 that is
        //    no longer a config value _resolveAttack also reads — landing is
        //    geometric, so the far edge is dummyEngageDist, an AI-owned
        //    threshold set from the MEASURED reach of the dummy's lead jab (see
        //    the note on that config value). The near edge is still smotherDist,
        //    which the resolver does share: the dummy throws a jab, and a jab is
        //    smother-vulnerable, so getting too close still kills the punch.
        const inLandingBand = this._distToOpponent <= config.dummyEngageDist &&
                              this._distToOpponent >= config.smotherDist;
        const canThrow      = this.punchTimer === 0 && !this.isBlocking;

        if (canThrow && (inLandingBand || this._forceAttack)) {
          this._forceAttack    = false;
          this.attackTimer     = randRange(config.dummyAttackDelayMin, config.dummyAttackDelayMax);
          const lowStamina     = this.stamina < config.lowStaminaThreshold;
          this._windupDuration = config.dummyWindupDuration * (lowStamina ? config.lowStaminaWindupMultiplier : 1);
          this.punchArm        = leadArm(this.stance);   // it only jabs, and a jab is always the lead hand
          this.punchType       = 'jab';
          this.punchTimer      = this._windupDuration;
          this._impactPending  = true;
          // Impact fires at the trajectory's own peak (Stage 9), not at a flat
          // half-windup — getFistPos() samples the peak pose, so the two have to
          // refer to the same instant for the geometric check to mean anything.
          this._impactTimer    = peakProgress(this.punchType) * this._windupDuration;
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

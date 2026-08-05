import Phaser from 'phaser';
import GUI from 'lil-gui';
import { config, punchDamageMult, punchAudioClass, punchWhiffRecoveryMult, cssHex } from './config.js';
import { initCombatAudio, playCombatSound, renderCombatSound, audioLog } from './audio.js';
import { Fighter } from './fighter.js';
import { Dummy } from './dummy.js';
import { VirtualJoystick } from './joystick.js';
import { PunchButtons } from './punchButtons.js';
import { BlockButton } from './blockButton.js';
import { Hud } from './hud.js';
import { FollowCamera, arenaBounds } from './camera.js';
import { resolveOverlap } from './movement.js';
import { Arena } from './arena.js';
import {
  drawRig, computePose, leadArm, rearArm, armSlot,
  peakProgress, hurtboxes, circleHitsCircle, circleHitsBox,
  aimAngle, punchGeometry, maxAimAngleRad, punchTiming, wristPath,
} from './rig.js';
import { punchVulnerability, applyVulnerabilityPunish } from './vulnerability.js';

const GAME_W = 960;
const GAME_H = 640;

// ── Depth sorting (Stage 14 part 4) ──────────────────────────────────────────
// Screen Y is depth in this game's convention, so both fighter containers take a
// depth derived from their world y every frame: whoever is lower on screen is
// nearer the camera and draws on top. Previously these were static (player 5,
// dummy 4), which meant the dummy was drawn behind you even when standing well
// in front of you — an ordering error that contact shadows make obvious.
//
// The band sits above the shadow layer and below flashGfx (15) / debugGfx (20).
// Its span over the ring height is what sets the depth resolution: 10 units
// across a 500 px ring is 0.02 per px.
const FIGHTER_DEPTH_MIN = 2;
const FIGHTER_DEPTH_MAX = 12;

// Tiebreak: a constant bias in the PLAYER's favour, worth ~1 px of world y at
// the span above. Deterministic by construction — there is exactly one crossing
// point, at "dummy 1 px lower", so a dead-level pair (or two fighters pinned
// against the same rope, where both clamp to the same y) always resolves the
// same way instead of flickering on sub-pixel jitter. Player-in-front is also
// the answer the old static depths gave, so nothing about the common case moves.
const FIGHTER_DEPTH_TIEBREAK = 0.02;

// The contact shadows sit above every arena layer (ropes are -20, the beam sheet
// -6) and below both fighters. Under the beams on purpose: a shadow on the mat
// should be lit by the overhead beams like the mat is.
const SHADOW_DEPTH = -10;

// ── Flash effect helpers ──────────────────────────────────────────────────────
// Each flash: { x, y, color, elapsed, maxTime, style: 'ring'|'burst' }
function makeRing(x, y, color, maxTime = 0.28) {
  return { x, y, color, elapsed: 0, maxTime, style: 'ring' };
}
function makeBurst(x, y, color, maxTime = 0.22) {
  return { x, y, color, elapsed: 0, maxTime, style: 'burst' };
}
/**
 * A directional motion streak along a path (Stage 16 part 5) — what a WHIFF
 * gets instead of the two concentric expanding rings it used to draw. A
 * concentric ring reads as an impact radiating from a point, which is exactly
 * wrong for a punch that hit nothing; a whiff is a movement, so it gets the arc
 * the fist actually travelled (see wristPath() in rig.js).
 * @param {Array<{x,y}>} pts  tail first, fist last
 */
function makeStreak(pts, color, maxTime = 0.2) {
  return { pts, color, elapsed: 0, maxTime, style: 'streak' };
}

// Block flash colours. Blue = an ordinary blocked hit (unchanged intent from
// Stage 10); white = a PERFECT block, deliberately a smaller, cleaner read than
// a counter gets — a perfect block is a setup, not a payoff.
const BLOCK_FLASH_COLOR   = 0x3388ff;
const PERFECT_FLASH_COLOR = 0xffffff;

class RingScene extends Phaser.Scene {
  constructor() {
    super({ key: 'RingScene' });
  }

  create() {
    // ── Arena (Stage 12) ───────────────────────────────────────────────────
    // Owns every environment layer: backdrop, crowd, apron, mat, ropes/posts,
    // light beams and the vignette. Purely visual — it reads the ring bounds
    // rect to draw around, and nothing reads it back.
    this.arena = new Arena(this, GAME_W, GAME_H);

    // Contact shadows (Stage 14 part 2) — see _drawShadows(). Deliberately a
    // scene-level layer rather than something inside the fighter containers:
    // those rotate and vertically squash for slip and knockdown, and a shadow
    // caught in that transform would tilt off the ground during a slip.
    this.shadowGfx = this.add.graphics().setDepth(SHADOW_DEPTH);

    this.flashGfx = this.add.graphics().setDepth(15);
    this._flashes = [];

    // Dev-only hurtbox overlay (config.showHurtboxes) — the hit geometry is
    // otherwise invisible, which makes the hurtbox sliders impossible to tune.
    this.debugGfx = this.add.graphics().setDepth(20);

    // Dev-only vulnerability readout (config.showVulnerability) — same class of
    // affordance as Show Hurtboxes, and for the same reason: vulnerability is a
    // continuous number that cannot be read off the rig, so none of the counter
    // or perfect-block tuning is possible without seeing it move. Screen-space
    // (it is routed to the UI camera below), so it doesn't scroll with the ring.
    this.vulnText = this.add.text(GAME_W / 2, 4, '', {
      fontSize: '12px', color: '#ffdd66', fontFamily: 'monospace', align: 'center',
    }).setOrigin(0.5, 0).setDepth(30).setVisible(false);

    // Punches scheduled to resolve at their peak-extension frame — see
    // _resolvePunch / _updatePendingImpacts.
    this._pendingImpacts = [];

    // Seconds of hit-stop remaining — see _triggerHitStop / update().
    this._hitStopTimer = 0;

    // ── Keyboard: movement ─────────────────────────────────────────────────
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd    = this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });

    // ── Fighter: starts left of center ─────────────────────────────────────
    this.fighter = new Fighter(this, GAME_W / 2 - 170, GAME_H / 2);

    // ── Dummy: starts right of center, ~340 px away (well out of reach) ───
    this.dummy = new Dummy(this, GAME_W / 2 + 170, GAME_H / 2, () => this._resolveDummyAttackImpact());

    // ── Virtual joystick — bottom-left ─────────────────────────────────────
    this.joystick = new VirtualJoystick(this, 110, GAME_H - 110, 70);

    // ── Punch buttons — bottom-right ───────────────────────────────────────
    this.punchBtns = new PunchButtons(
      this,
      GAME_W - 130, GAME_H - 120,
      (type) => this._resolvePunch(type),
    );

    // ── Block button — bottom-center, clear of the joystick and diamond ────
    this.blockBtn = new BlockButton(this, GAME_W / 2, GAME_H - 70);

    // ── Health/stamina HUD (Stage 6) ─────────────────────────────────────────
    this.hud = new Hud(this, GAME_W);

    // Stores the last horizontal input so hook/uppercut can read it at punch time
    this._lastInputX = 0;

    // Current block-held state, refreshed once per frame before punches resolve
    this._blockHeld = false;

    // ── TEMPORARY DEBUG KEY (Stage 5) ───────────────────────────────────────
    // Press T to force the dummy to throw immediately, bypassing its random
    // timer, so slip timing can be verified on demand. Intentionally kept in
    // past Stage 5 for Stage 6+ testing — see Dummy.forceAttack().
    this._debugForceAttackKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T);

    // ── Combat audio ────────────────────────────────────────────────────────
    // Hands Phaser's own AudioContext over when it has one, so we don't open a
    // second one. Stays silent (not broken) if WebAudio is unavailable or the
    // browser hasn't seen a user gesture yet — see audio.js.
    initCombatAudio(this.sound && this.sound.context);

    this._setupCameras();
  }

  // ── Cameras (Stage 11) ──────────────────────────────────────────────────────
  // Two cameras over one scene, split by mutual ignore lists:
  //
  //   cameras.main — the WORLD. Scrolls and zooms (see FollowCamera).
  //   this.uiCam   — the SCREEN. Never scrolls, never zooms, added second so it
  //                  renders on top. transparent = true by default, so it
  //                  composites over the world rather than clearing it.
  //
  // Splitting by ignore list rather than by depth is the point: depth alone
  // wouldn't help, since a scrolling camera moves everything it renders. The
  // HUD/joystick/buttons are laid out in canvas coordinates and their pointer
  // hit-tests read pointer.x/y (canvas space, camera-independent), so keeping
  // them off the world camera is the whole fix — no per-object repositioning.
  _setupCameras() {
    const world = [
      ...this.arena.displayObjects(), this.shadowGfx, this.flashGfx, this.debugGfx,
      this.fighter.container, this.dummy.container,
    ];
    const ui = [
      ...this.joystick.displayObjects(),
      ...this.punchBtns.displayObjects(),
      ...this.blockBtn.displayObjects(),
      ...this.hud.displayObjects(),
      this.vulnText,
    ];

    this.uiCam = this.cameras.add(0, 0, GAME_W, GAME_H);
    this.uiCam.setName('ui');

    this.cameras.main.ignore(ui);
    this.uiCam.ignore(world);

    this.followCam = new FollowCamera(this, GAME_W, GAME_H);
  }

  /**
   * Assign a NEWLY created display object to one of the two camera layers.
   *
   * Anything added to the scene after _setupCameras() is rendered by BOTH
   * cameras until it is ignored by one of them — a world object would then be
   * drawn a second time unscrolled, and a UI object a second time scrolled. Any
   * later stage that calls this.add.* has to route it through here.
   *
   * @param {Phaser.GameObjects.GameObject|Array} obj
   * @param {'world'|'ui'} layer
   */
  assignToLayer(obj, layer) {
    if (layer === 'ui') this.cameras.main.ignore(obj);
    else                this.uiCam.ignore(obj);
    return obj;
  }

  // ── Ring bounds (re-computed each frame so slider changes take effect) ─────
  _getRingBounds() {
    const cx = GAME_W / 2, cy = GAME_H / 2;
    const hw = config.ringWidth / 2, hh = config.ringHeight / 2;
    return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
  }

  // ── Punch resolution (player-initiated) ─────────────────────────────────────
  _resolvePunch(punchType) {
    // Punching and blocking are mutually exclusive — ignore punch input entirely
    // while block is held (no cooldown: this re-checks fresh every frame).
    if (this._blockHeld) return;
    // Can't throw while down (Stage 6).
    if (this.fighter.isDown) return;
    // Can't throw again until an extended WHIFF recovery has played out (Stage
    // 16 part 2) — this is the whole cost of missing. Note what is NOT gated
    // here: an ordinary punch still cancels into the next one exactly as it did
    // before, and block is never gated at all (see Fighter.update).
    if (this.fighter.inWhiffRecovery) return;

    // ── Hand selection ─────────────────────────────────────────────────────
    // Resolves to an ANATOMICAL arm ('left' | 'right'); the rig maps it to its
    // lead/rear slot via the fighter's stance (see armSlot() in rig.js).
    //
    // Jab = the stance's lead hand, cross = the rear hand. Both ignore the
    // joystick AND facing entirely — an orthodox fighter jabs with their left
    // from either side of the ring; only the rendered mirror changes.
    // Hook / Uppercut: joystick/keyboard left → LEFT hand, right (or neutral)
    //                  → RIGHT hand. Stance-independent by design (locked spec).
    const stance = this.fighter.stance;
    let arm;
    if (punchType === 'jab') {
      arm = leadArm(stance);
    } else if (punchType === 'cross') {
      arm = rearArm(stance);
    } else {
      // hook / uppercut — direction-sensitive, picks the hand directly
      arm = this._lastInputX < -0.25 ? 'left' : 'right';
    }

    // ── Aim cone (Stage 13) ────────────────────────────────────────────────
    // Sampled HERE, on the input frame, from the positions that are live right
    // now — not deferred to the next frame, which would add a frame of input
    // latency to every punch. This runs before resolveOverlap() and before
    // facing is recomputed this frame, so it reads last frame's settled
    // positions: that IS the state at the moment the button went down.
    //
    // The angle is handed to startPunch and then locked. Nothing re-samples it,
    // which is what makes a separation shove or (later) a slip actually beat a
    // committed punch instead of being tracked through.
    //
    // Aimed at the dummy's RENDER position rather than its locomotion body,
    // deliberately breaking the loco-not-render rule facing follows: that rule
    // exists because facing is a per-frame binary flip that a few px of stagger
    // wobble could strobe. Aim is a one-shot continuous sample, and the render
    // position is where the hurtboxes the resolver tests against actually are.
    const slot = armSlot(stance, arm);
    const flip = this.fighter.facingRight ? 1 : -1;
    const aim  = aimAngle(
      punchType, slot,
      (this.dummy.x - this.fighter.x) * flip,
      this.dummy.y - this.fighter.y,
    );

    // ── Start arm animation immediately (plays even on whiff/smother) ──────
    this.fighter.startPunch(arm, punchType, aim);

    // Give the dummy its reaction chance BEFORE the punch resolves, so a
    // successful roll actually guards against this punch (Stage 7). It now gets
    // a genuine window to do it in, rather than a zero-latency reaction — see
    // the scheduling note below.
    this.dummy.onOpponentPunchStart();

    // ── Resolve at PEAK EXTENSION, not on the press frame (Stage 9) ────────
    // The old code resolved immediately, which was fine for a distance band but
    // is wrong for a geometric check: it would test this punch's peak fist pose
    // against where the opponent stood when the button went down. Scheduling the
    // impact for the frame the fist actually arrives is what makes hits track a
    // moving target. Same mechanism the dummy has always used for its windup.
    this._pendingImpacts.push({
      attacker: this.fighter,
      defender: this.dummy,
      arm,
      punchType,
      timer: peakProgress(punchType) * this.fighter._punchDuration,
    });
  }

  /**
   * Tick scheduled punch impacts. Called AFTER both fighters have stepped, so a
   * punch resolves against this frame's positions, not last frame's.
   */
  _updatePendingImpacts(dt) {
    if (this._pendingImpacts.length === 0) return;
    const still = [];
    for (const imp of this._pendingImpacts) {
      imp.timer -= dt;
      if (imp.timer > 0) { still.push(imp); continue; }
      // A knockdown mid-flight cancels the punch (startPunch state is cleared in
      // _triggerKnockdown), so the impact it scheduled must die with it.
      if (imp.attacker.isDown) continue;
      this._resolveAttack(imp.attacker, imp.defender, imp.arm, imp.punchType);
    }
    this._pendingImpacts = still;
  }

  // ── Attack impact resolution (dummy-initiated) ──────────────────────────────
  // Called by Dummy at peak extension of its windup — see the onAttackImpact
  // callback passed into `new Dummy(...)` above.
  _resolveDummyAttackImpact() {
    this._resolveAttack(this.dummy, this.fighter, this.dummy.punchArm, this.dummy.punchType);
  }

  // ── Shared impact resolution — used by both attackers ─────────────────────
  // (the player punching the dummy, and the dummy punching the player), so
  // whiff/smother/land handling and the force/stagger calc exist in one place.
  //
  // Stage 9: landing is GEOMETRIC. Called on the punch's peak-extension frame,
  // it asks one question — does the fist (a circle of config.fistRadius at the
  // pose-solved wrist) overlap either of the defender's hurtboxes right now?
  // Reach is therefore a consequence of the rig and the per-punch trajectory
  // rather than a declared number, so the four punches differ in range for
  // free and a punch that visually misses actually misses.
  //
  // @returns {'whiff'|'smother'|'land'|null}  null = no resolution (target down)
  _resolveAttack(attacker, defender, arm, punchType) {
    // Invulnerable while down (Stage 6) — no resolution at all, not even a
    // whiff flash; a downed fighter isn't a valid target until they get up.
    if (defender.isDown) return null;

    // Defenders that can slip (Fighter) expose getHitPos() — normally just
    // their true (x, y), but offset while a slip is active. It also anchors
    // getHurtboxes() below, which is the entire "invincibility" implementation:
    // no separate bypass flag, the boxes simply aren't there any more.
    const defPos = typeof defender.getHitPos === 'function'
      ? defender.getHitPos()
      : { x: defender.x, y: defender.y };
    const dx   = defPos.x - attacker.x;
    const dy   = defPos.y - attacker.y;
    const dist = Math.hypot(dx, dy);
    const fist = attacker.getFistPos(arm);

    // Only jab/cross are smother-vulnerable at close range — hook/uppercut
    // still land, per the locked range-gating rule. Checked BEFORE the overlap
    // test on purpose: point-blank, a straight punch's fist still passes through
    // the head geometrically, so geometry alone can never produce a smother.
    const smotherable = punchType !== 'hook' && punchType !== 'uppercut';

    let outcome;
    if (dist < config.smotherDist && smotherable) {
      outcome = 'smother';
    } else {
      const hb = defender.getHurtboxes();
      const r  = config.fistRadius;
      outcome = (circleHitsCircle(fist.x, fist.y, r, hb.head) ||
                 circleHitsBox(fist.x, fist.y, r, hb.body))
        ? 'land'
        : 'whiff';
    }

    switch (outcome) {
      case 'whiff':
        // A directional streak along the arc the fist just travelled (Stage 16
        // part 5), replacing the two concentric rings that used to spawn here.
        // Near-white rather than the old effect's orange: the mat is a warm tan
        // (#c8a060), so an orange streak sits within a few points of the
        // background it is drawn on and simply doesn't read. A cool near-white
        // separates on any surface and suits "air moving past" better anyway.
        this._flashes.push(makeStreak(
          attacker.getWristPath(arm, punchType), 0xeef4ff, config.whiffStreakDuration));
        playCombatSound('whiff');
        // Stage 16 part 2 — the whiff cost. Applied HERE, at the resolution, and
        // not predicted earlier: the outcome simply isn't known before peak.
        // Stage 17 part 0c — the multiplier is now per punch type, so missing a
        // jab is cheap and missing an uppercut is the opening it should be.
        attacker.extendRecovery(punchWhiffRecoveryMult(punchType));
        break;

      case 'smother':
        // Grey burst at fist — punch absorbed, no stagger
        this._flashes.push(makeBurst(fist.x, fist.y, 0x7788aa));
        this._flashes.push(makeRing(fist.x, fist.y, 0x667799, 0.2));
        // JUDGEMENT CALL — flag if you disagree: the brief specified sounds for
        // land / block / whiff and didn't mention smother, but leaving the
        // fourth outcome silent is a hole in the feedback. A smother is a punch
        // that got absorbed at zero range, so it borrows the blocked variant
        // rather than getting a fifth sound of its own.
        playCombatSound('impactBlocked');
        // Smother is a miss too, per the brief — same recovery penalty, and
        // since Stage 17 that means the same PER-TYPE penalty.
        attacker.extendRecovery(punchWhiffRecoveryMult(punchType));
        break;

      case 'land': {
        const blocked = !!defender.isBlocking;

        // ── Perfect block (Stage 16 part 4) ────────────────────────────────
        // A guard raised within perfectBlockWindow of THIS impact resolving.
        // blockHeldTime is Infinity whenever the guard is down, so an unblocked
        // hit can never satisfy this. A normal held block is untouched — it
        // simply ages past the window and behaves exactly as it did before.
        const perfect = blocked && defender.blockHeldTime <= config.perfectBlockWindow;

        // ── Counter (Stage 16 part 3) ──────────────────────────────────────
        // Read BEFORE anything else touches the defender. Both fighters have
        // already stepped this frame, so this is the same live number the debug
        // readout is showing. A blocking defender is at 0 by construction, so a
        // blocked hit is never a counter and the ordering below is unambiguous.
        const targetVuln = defender.vulnerability || 0;

        // Blocked hits are always the absorbed variant regardless of punch
        // type; only clean hits get the per-weight-class impact. Both attackers
        // route through here, so player and dummy sound identical for free.
        playCombatSound(blocked ? 'impactBlocked' : punchAudioClass(punchType));

        // The generic circular hit flash (a body-centered burst + ring) is GONE
        // for clean hits — the localized rig reaction below is the feedback now.
        // The blue overlay is kept ONLY for blocked hits, where it isn't hit
        // feedback at all: it's the readout for a distinct game state
        // (blockReduction cuts the force by 75%, so the reaction alone would be
        // near-invisible and a blocked hit would look like a whiff).
        if (blocked) defender.flash(perfect ? PERFECT_FLASH_COLOR : BLOCK_FLASH_COLOR);

        // Force = base + momentum contribution from the attacker's approach velocity
        const d    = dist || 1;
        const dirX = dx / d;
        const dirY = dy / d;
        const approachSpd = attacker.vx * dirX + attacker.vy * dirY;
        let force = config.punchForceBase
          + (approachSpd / config.moveSpeed) * config.playerMass * config.punchMomentumScale;
        force = Math.max(config.punchForceBase * 0.1, force);
        // Per-punch damage multiplier (Stage 8) — layered ON TOP of the
        // momentum result rather than replacing it, so a retreating hook is
        // still weaker than an advancing one. Scales stagger and health damage
        // together, since damage is derived from this same force value.
        force *= punchDamageMult(punchType);
        // Counter bonus (Stage 16 part 3) — applied to the SHARED force value
        // every downstream system already reads, so a counter is automatically
        // harder, pushes further and reacts bigger without three separate
        // multipliers. Stacks multiplicatively with the momentum term above and
        // the per-punch damage multiplier; the measured ceiling that produces is
        // reported by scripts/counter_test.mjs.
        force *= 1 + targetVuln * config.counterForceBonus;
        if (blocked) force *= (1 - config.blockReduction);

        defender.receiveImpulse(dirX * force, dirY * force);
        // Localized punch-type reaction (Stage 10) — head/torso/tilt, driven by
        // this same force value so it scales with momentum and damage rather
        // than being a flat per-type animation.
        defender.receiveHit(punchType, force);

        if (perfect) {
          // No chip damage — takeDamage is simply not called, and since Stage 17
          // part 0d neither is receiveStaminaChip: a perfect block now waives
          // BOTH halves of the cost of absorbing a punch, which is the thing the
          // Stage 16 note said this reward had nothing to negate. The stagger
          // impulse and the rig reaction ARE kept: a perfect block still absorbs
          // a punch, it doesn't delete it.
          //
          // The reward proper: the ATTACKER's vulnerability spikes, which opens
          // a counter window through the part 1 + part 3 machinery rather than
          // introducing a separate parry system.
          applyVulnerabilityPunish(
            attacker,
            config.perfectBlockPunishVulnerability,
            config.perfectBlockPunishDuration,
          );
          this._triggerHitStop(0, config.perfectBlockHitStop);
        } else {
          // Damage reuses this same post-block-reduction force value (Stage 6)
          // rather than a parallel damage number — see config.healthDamagePerForce.
          defender.takeDamage(force * config.healthDamagePerForce);
          // …and so does stamina chip damage (Stage 17 part 0d), off the exact
          // same `force`, so being hit finally costs something and turtling
          // isn't free. `blocked` only picks the multiplier — blockReduction has
          // already been applied to force above.
          defender.receiveStaminaChip(force, blocked);
          // Hit-stop (Stage 10) — a few frames of near-frozen timescale, length
          // scaled by the same force, plus the counter bonus (Stage 16 part 3).
          this._triggerHitStop(force, targetVuln * config.counterHitStopBonus);
          if (targetVuln > 0) {
            // Counter feedback: a sting layered OVER the punch's own impact
            // sound (see the `counter` recipe in config), and a camera shake
            // scaled by the same vulnerability. No new VFX shapes.
            playCombatSound('counter');
            this._shakeCamera(targetVuln);
          }
        }
        break;
      }
    }

    // Returned so the Playwright checks can assert on the resolver's own verdict
    // instead of re-deriving it from positions (which is how punch_test used to
    // work — it would have kept passing against the old distance rule).
    return outcome;
  }

  // ── Hit-stop (Stage 10) ────────────────────────────────────────────────────
  // A brief freeze-frame on a landed hit. Deliberately implemented as a scale on
  // the dt handed to update() rather than as Phaser's own timescale, so it slows
  // exactly the things the game steps itself (fighters, springs, pending
  // impacts, flashes) and nothing else — and so the hit-stop clock keeps running
  // on REAL time and can't freeze itself out.
  //
  // Overlapping hits take the longer of the two rather than stacking; stacking
  // would let a fast combo compound into a genuine hang.
  // `bonus` (Stage 16) is added ON TOP of the clamped force-derived duration
  // rather than inside the clamp, so a counter or a perfect block genuinely
  // extends a hit-stop that was already at hitStopMax — clamping it in would
  // have made the bonus invisible on exactly the hardest hits, which are the
  // ones most likely to be counters.
  _triggerHitStop(force, bonus = 0) {
    if (!config.hitStopEnabled) return;
    const base = Math.min(config.hitStopMax, config.hitStopBase + force * config.hitStopPerForce);
    const dur  = base + Math.max(0, bonus);
    this._hitStopTimer = Math.max(this._hitStopTimer, dur);
  }

  /**
   * Counter camera shake (Stage 16 part 3), scaled by the target's vulnerability.
   *
   * Checked against the Stage 15 zoom solve before shipping: Phaser's shake
   * effect only translates the camera's render MATRIX (Effects/Shake.preRender)
   * — it never writes scrollX/scrollY or zoom. FollowCamera sets both of those
   * every frame, so there is nothing for the two to fight over, and the smoothed
   * zoom is untouched.
   *
   * The zoom division is not cosmetic: Phaser scales the shake offset by zoom
   * and then applies it through a matrix that is already scaled by zoom, so a
   * fixed intensity would shake ~5x harder at the tight end of the zoom range
   * (3.0) than at the wide end (1.3) — and counters happen up close, so the
   * fixed version would only ever produce the violent one. Dividing by zoom²
   * makes the config value mean "this fraction of the viewport", at any zoom.
   *
   * Shakes the WORLD camera only, so the HUD and the controls stay still.
   */
  _shakeCamera(vulnerability) {
    const v   = Math.max(0, Math.min(1, vulnerability));
    const amt = config.counterShakeIntensity * v;
    if (amt <= 0 || config.counterShakeDuration <= 0) return;
    const zoom = Math.max(0.1, this.cameras.main.zoom);
    this.cameras.main.shake(config.counterShakeDuration * 1000, amt / (zoom * zoom), true);
  }

  // ── Contact shadows (Stage 14 part 2) ──────────────────────────────────────
  /**
   * Where each fighter's shadow sits and how big it is, in world space. Split
   * out from the draw so the verification script asserts against the geometry
   * the renderer actually consumes rather than re-deriving it.
   *
   * Anchored to the fighter's world (x, y) — their FEET, via shadowOffsetY —
   * and to nothing else. Not the hit-reaction offsets, not the slip lean, not
   * the bob: a fighter rocked back by a cross has moved their upper body, their
   * feet haven't gone anywhere. The dummy's stagger IS included, because that
   * one displaces the whole body through the ring (it's baked into this.x, and
   * the drawn rig moves with it), unlike the rig-local reaction offsets.
   *
   * Knockdown is the single exception to "position only": a downed fighter is
   * lying on the canvas rather than standing on it, so the ellipse widens and
   * flattens by config.shadowDownRadiusScale.
   */
  _shadowGeom() {
    return [this.fighter, this.dummy].map((f) => {
      const s = f.isDown ? config.shadowDownRadiusScale : 1;
      return {
        x:  f.x,
        y:  f.y + config.shadowOffsetY,
        rx: config.shadowRadiusX * s,
        ry: config.shadowRadiusY / s,
      };
    });
  }

  _drawShadows() {
    const g = this.shadowGfx;
    g.clear();
    if (!config.shadowEnabled) return;
    const color = cssHex(config.shadowColor);
    for (const s of this._shadowGeom()) {
      g.fillStyle(color, config.shadowAlpha);
      g.fillEllipse(s.x, s.y, s.rx * 2, s.ry * 2);
    }
  }

  // ── Depth sorting (Stage 14 part 4) ────────────────────────────────────────
  // See the FIGHTER_DEPTH_* constants at the top of this file for the band and
  // the tiebreak. Runs after both fighters have stepped, so it sorts on this
  // frame's final positions rather than trailing them by one.
  _updateDepthSort(bounds) {
    const span    = Math.max(1, bounds.bottom - bounds.top);
    const depthOf = (y) => FIGHTER_DEPTH_MIN +
      Phaser.Math.Clamp((y - bounds.top) / span, 0, 1) * (FIGHTER_DEPTH_MAX - FIGHTER_DEPTH_MIN);

    this.fighter.container.setDepth(depthOf(this.fighter.y) + FIGHTER_DEPTH_TIEBREAK);
    this.dummy.container.setDepth(depthOf(this.dummy.y));
  }

  // ── Flash effect rendering ─────────────────────────────────────────────────
  _updateFlashes(dt) {
    const g = this.flashGfx;
    g.clear();

    for (const f of this._flashes) {
      f.elapsed += dt;
      const t     = f.elapsed / f.maxTime;      // 0..1
      const alpha = Math.max(0, 1 - t);         // fades out

      if (f.style === 'ring') {
        const r = 8 + t * 32;                   // expands from 8 to 40
        g.lineStyle(3, f.color, alpha * 0.9);
        g.strokeCircle(f.x, f.y, r);
      } else if (f.style === 'streak') {
        // A whiff is a movement, not an explosion (Stage 16 part 5). The line
        // tapers and brightens toward the fist end, and the TAIL catches up as
        // the effect ages — so it reads as the swing trailing off rather than as
        // a static arc fading out on the spot.
        const pts  = f.pts;
        const n    = pts.length;
        if (n < 2) continue;
        const from = Math.min(n - 2, Math.floor(t * (n - 1) * 0.65));
        for (let i = from + 1; i < n; i++) {
          const u = i / (n - 1);                // 0 = tail, 1 = fist
          // The taper floors at 0.25 rather than running to zero: a ramp
          // straight down to nothing left the back half of the arc invisible,
          // which is the half that carries the direction.
          const w = 0.25 + 0.75 * u;
          g.lineStyle(Math.max(1, config.whiffStreakWidth * w),
                      f.color, alpha * config.whiffStreakAlpha * w);
          g.beginPath();
          g.moveTo(pts[i - 1].x, pts[i - 1].y);
          g.lineTo(pts[i].x, pts[i].y);
          g.strokePath();
        }
      } else {
        g.fillStyle(f.color, alpha * 0.65);
        g.fillCircle(f.x, f.y, 28);
      }
    }

    this._flashes = this._flashes.filter(f => f.elapsed < f.maxTime);
  }

  // ── Hurtbox debug overlay (dev only, off by default) ──────────────────────
  // Draws exactly what _resolveAttack tests against: both fighters' head/body
  // hurtboxes, plus the fist circle of any punch currently in flight.
  _drawDebugOverlays() {
    this.debugGfx.clear();
    this._drawHurtboxDebug();
    this._drawAimConeDebug();
  }

  // ── Vulnerability readout (dev only, off by default) ──────────────────────
  // Both fighters' live 0..1 value, plus the state that explains it: WHIFF while
  // an extended recovery is running, PUNISH while a perfect-block spike is held,
  // BLOCK while the guard is up (which pins it at 0). Sits behind
  // config.showVulnerability, alongside Show Hurtboxes / Show Aim Cone.
  _updateVulnReadout() {
    const t = this.vulnText;
    if (!config.showVulnerability) {
      if (t.visible) t.setVisible(false);
      return;
    }
    t.setVisible(true);
    const tag = (f) => {
      if (f.isDown)          return 'DOWN';
      if (f.isBlocking)      return 'BLOCK';
      if (f.inWhiffRecovery) return 'WHIFF';
      if (f._punishTimer > 0) return 'PUNISH';
      if (f.punchTimer > 0)  return String(f.punchType || '').toUpperCase();
      return '';
    };
    const line = (label, f) => `${label} ${f.vulnerability.toFixed(2)} ${tag(f).padEnd(8)}`;
    t.setText(`VULN   ${line('YOU', this.fighter)}   ${line('DUMMY', this.dummy)}`);
  }

  _drawHurtboxDebug() {
    const g = this.debugGfx;
    if (!config.showHurtboxes) return;

    for (const f of [this.fighter, this.dummy]) {
      if (f.isDown) continue;
      const hb = f.getHurtboxes();
      g.lineStyle(1, 0x00ff88, 0.9);
      g.strokeCircle(hb.head.x, hb.head.y, hb.head.r);
      g.lineStyle(1, 0x00aaff, 0.9);
      g.strokeRect(hb.body.x - hb.body.hw, hb.body.y - hb.body.hh, hb.body.hw * 2, hb.body.hh * 2);

      // Fist at its PEAK pose — where the punch will be tested from, which is
      // the useful thing to see while tuning, not where the hand is right now.
      if (f.punchArm) {
        const fist = f.getFistPos(f.punchArm);
        g.lineStyle(1, 0xffcc00, 0.9);
        g.strokeCircle(fist.x, fist.y, config.fistRadius);
      }
    }
  }

  // ── Aim-cone debug overlay (dev only, off by default) ─────────────────────
  // Draws, per fighter, the cone the aim solve is allowed to bend within and —
  // while a punch is in flight — the angle it actually locked. Without this the
  // Max Aim Angle slider is being tuned blind: the bend is a few degrees of arm
  // rotation, which is very hard to read off the rig itself.
  //
  // Drawn from the throwing SHOULDER at the punch's own reach, because that is
  // literally the joint and the radius the bend rotates about. Idle fighters
  // show their lead-hand jab cone as the representative one.
  _drawAimConeDebug() {
    const g = this.debugGfx;
    if (!config.showAimCone) return;

    const max = maxAimAngleRad();

    for (const f of [this.fighter, this.dummy]) {
      if (f.isDown) continue;

      const throwing = !!f.punchArm;
      const arm      = throwing ? f.punchArm : leadArm(f.stance);
      const type     = throwing ? f.punchType : 'jab';
      const geo      = punchGeometry(type, armSlot(f.stance, arm));
      if (!geo) continue;

      const sh   = f.getShoulderPos(arm);
      const flip = f.facingRight ? 1 : -1;
      // Rig-local angle → a world-space point at distance `reach`. Only x is
      // mirrored; y never is, which is exactly why the cone behaves the same
      // from either side of the ring.
      const at = (a) => ({
        x: sh.x + Math.cos(a) * geo.reach * flip,
        y: sh.y + Math.sin(a) * geo.reach,
      });

      // Cone bounds + the arc closing them off.
      g.lineStyle(1, 0x8866ff, 0.55);
      for (const edge of [geo.angle - max, geo.angle + max]) {
        const p = at(edge);
        g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(p.x, p.y); g.strokePath();
      }
      g.beginPath();
      const STEPS = 12;
      for (let i = 0; i <= STEPS; i++) {
        const p = at(geo.angle - max + (2 * max * i) / STEPS);
        if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y);
      }
      g.strokePath();

      // The locked aim line for the punch actually in flight.
      if (throwing) {
        const p = at(geo.angle + (f.punchAim || 0));
        g.lineStyle(2, 0xff44aa, 0.95);
        g.beginPath(); g.moveTo(sh.x, sh.y); g.lineTo(p.x, p.y); g.strokePath();
        g.fillStyle(0xff44aa, 0.95);
        g.fillCircle(p.x, p.y, 3);
      }
    }
  }

  // ── Main update loop ──────────────────────────────────────────────────────
  update(_time, delta) {
    const realDt = Math.min(delta / 1000, 0.05);

    // Hit-stop (Stage 10): the timer burns REAL time while everything the game
    // steps runs on a near-zero dt. Input reading below is unaffected — a press
    // during the stop is still registered, it just resolves as the game resumes,
    // which is what keeps this reading as impact rather than as dropped input.
    let dt = realDt;
    if (this._hitStopTimer > 0) {
      this._hitStopTimer = Math.max(0, this._hitStopTimer - realDt);
      dt = realDt * config.hitStopScale;
    }

    // Dev hook (Stage 18a): frame count and accumulated GAME time, so the
    // Playwright checks can wait on "the sim advanced N seconds" instead of
    // sleeping N seconds of wall clock. Game time is the hit-stop-scaled dt —
    // the same clock the systems under test run on — which is what makes these
    // waits immune to both CPU load and hit-stop eating the window.
    window.__tick.frames++;
    window.__tick.gameTime += dt;

    // Movement input
    let kx = 0, ky = 0;
    if (this.cursors.left.isDown  || this.wasd.left.isDown)  kx -= 1;
    if (this.cursors.right.isDown || this.wasd.right.isDown) kx += 1;
    if (this.cursors.up.isDown    || this.wasd.up.isDown)    ky -= 1;
    if (this.cursors.down.isDown  || this.wasd.down.isDown)  ky += 1;

    const joy    = this.joystick.getInput();
    const inputX = Phaser.Math.Clamp(kx + joy.x, -1, 1);
    const inputY = Phaser.Math.Clamp(ky + joy.y, -1, 1);
    this._lastInputX = inputX;   // saved for hook/uppercut hand selection

    // Block state refreshed BEFORE punch input so the same frame's punch
    // attempts see up-to-date block-held status (mutual exclusion, no lag).
    this._blockHeld = this.blockBtn.update();

    // Check punch keys BEFORE fighter.update() so arm animation starts same frame
    this.punchBtns.update();

    // DEBUG (temporary, Stage 5): force an immediate dummy attack for testing
    if (Phaser.Input.Keyboard.JustDown(this._debugForceAttackKey)) this.dummy.forceAttack();

    // Step everything
    const bounds = this._getRingBounds();
    // Body separation runs BEFORE the two steps, on last frame's final
    // positions, so each fighter's update() then composes and syncs its
    // container from the already-corrected position — resolving afterwards
    // would leave the sprites a frame behind the push.
    resolveOverlap(this.fighter.locoBody, this.dummy.locoBody, bounds);

    // Arena dressing is drawn from this same rect, before anything moves — it
    // is the only consumer of the bounds that doesn't act on them.
    this.arena.drawWorld(bounds);

    // facingAnchorX, not .x — the dummy's .x carries its stagger offset, which
    // is an impact wobble rather than a change of where it is standing. See
    // stepFacing() in movement.js.
    this.fighter.update(dt, inputX, inputY, bounds, this.dummy.facingAnchorX, this._blockHeld);
    this.dummy.update(dt, this.fighter, bounds);
    // AFTER both have stepped — a punch resolves against current positions.
    this._updatePendingImpacts(dt);
    // Same reason: both the shadows and the draw order are read off this
    // frame's final positions, not last frame's.
    this._drawShadows();
    this._updateDepthSort(bounds);
    this._updateFlashes(dt);
    this._drawDebugOverlays();
    this._updateVulnReadout();
    this.hud.update(this.fighter, this.dummy);

    // Camera last — it frames this frame's final positions rather than trailing
    // them by one. Handed the SCALED dt on purpose: during a hit-stop that dt is
    // near zero, so the follow eases by a near-zero amount and the camera freezes
    // with the fight instead of continuing to glide on real time.
    this.followCam.update(dt, this.fighter, this.dummy, bounds);

    // Vignette last of all: it is fitted to the visible rect, so it has to be
    // placed AFTER the camera has settled this frame's scroll/zoom or it would
    // trail by a frame and show a bright sliver at the leading edge.
    this.arena.updateOverlay(this.followCam.getView(), bounds);
  }
}

// ── Phaser game ───────────────────────────────────────────────────────────────
// Dev hook: declared before the game exists so the very first update() tick can
// increment it. See the write site in RingScene.update().
window.__tick = { frames: 0, gameTime: 0 };

const game = new Phaser.Game({
  type:            Phaser.AUTO,
  width:           GAME_W,
  height:          GAME_H,
  backgroundColor: '#1a1a2e',
  scene:           RingScene,
  parent:          document.body,
});

// ── Dev tuning panel ──────────────────────────────────────────────────────────
const gui = new GUI({ title: 'Tuning Panel', width: 270 });

const ringF = gui.addFolder('Ring');
ringF.add(config, 'ringWidth',           200, 900,  1).name('Width');
ringF.add(config, 'ringHeight',          100, 600,  1).name('Height');
ringF.addColor(config, 'ringFloorColor')              .name('Mat Color');
ringF.add(config, 'ringRopeCount',         1,   6,  1).name('Strands / Side');
ringF.add(config, 'ringRopeSpacing',       2,  16, 0.5).name('Strand Gap px');
ringF.add(config, 'ringRopeThickness',     1,  10, 0.5).name('Strand px');
ringF.addColor(config, 'ringRopeColor')               .name('Strand 1');
ringF.addColor(config, 'ringRopeColor2')              .name('Strand 2');
ringF.addColor(config, 'ringRopeColor3')              .name('Strand 3');
ringF.add(config, 'ringPostSize',          6,  36,  1).name('Post px');
ringF.add(config, 'ringPadSize',          10,  70,  1).name('Turnbuckle px');
ringF.addColor(config, 'ringPostColor')               .name('Post Color');
ringF.addColor(config, 'ringPadColorA')               .name('Pad — Left');
ringF.addColor(config, 'ringPadColorB')               .name('Pad — Right');
ringF.add(config, 'ringBorderThickness',   1,  24,  1).name('Mat Trim px');
ringF.close();

// ── Arena dressing (Stage 12) — purely visual, no gameplay effect ────────────
const arenaF = gui.addFolder('Arena');
arenaF.add(config, 'ringApronWidth',   0, 120, 1).name('Apron Deck px');
arenaF.add(config, 'ringSkirtHeight',  0, 140, 1).name('Skirt px');
arenaF.addColor(config, 'apronDeckColor')        .name('Deck Color');
arenaF.addColor(config, 'apronSkirtColor')       .name('Skirt Color');
arenaF.addColor(config, 'apronStripeColor')      .name('Skirt Stripe');
arenaF.add(config, 'matGrainAlpha',  0, 0.6, 0.01).name('Mat Grain');
arenaF.add(config, 'matShadeAlpha',  0,   1, 0.01).name('Mat Edge Shade');
arenaF.add(config, 'matGlowAlpha',   0,   1, 0.01).name('Mat Light Pool');
arenaF.add(config, 'matEmblemAlpha', 0, 0.6, 0.01).name('Emblem Alpha');
arenaF.addColor(config, 'matEmblemColor')        .name('Emblem Color');
arenaF.addColor(config, 'matTrimColor')          .name('Mat Trim Color');
arenaF.open();

const atmoF = gui.addFolder('Atmosphere');
atmoF.add(config, 'vignetteStrength', 0,   1, 0.01).name('Vignette');
atmoF.add(config, 'beamAlpha',        0, 0.5, 0.01).name('Beam Strength');
atmoF.add(config, 'beamCount',        0,   3,   1) .name('Beam Count');
atmoF.add(config, 'arenaHazeAlpha',   0,   1, 0.01).name('Arena Haze');
atmoF.addColor(config, 'arenaHazeColor')          .name('Haze Color');
atmoF.addColor(config, 'arenaVoidColor')          .name('Void Color');
atmoF.open();

// Crowd is baked into a RenderTexture at boot, so these need an explicit
// rebuild rather than taking effect on the next frame like everything else.
const crowdF = gui.addFolder('Crowd');
const rebuildCrowd = () => game.scene.keys.RingScene?.arena?.rebuildCrowd();
crowdF.add(config, 'crowdRowGap',    12, 70, 1)    .name('Row Gap px')  .onFinishChange(rebuildCrowd);
crowdF.add(config, 'crowdSeatGap',   10, 70, 1)    .name('Seat Gap px') .onFinishChange(rebuildCrowd);
crowdF.add(config, 'crowdHeadScale', 0.4, 2.5, 0.05).name('Head Scale') .onFinishChange(rebuildCrowd);
crowdF.addColor(config, 'crowdFarColor')            .name('Far Color')  .onFinishChange(rebuildCrowd);
crowdF.addColor(config, 'crowdNearColor')           .name('Near Color') .onFinishChange(rebuildCrowd);
crowdF.close();

// Follow camera (Stage 11, dynamic zoom in Stage 15) — viewport only, no
// gameplay effect. Zoom is solved from the framing constraints below rather
// than set directly; the min/max are the useful knobs.
const cameraF = gui.addFolder('Camera');
cameraF.add(config, 'camZoomMin',       1,   4, 0.05).name('Zoom Min (wide)');
cameraF.add(config, 'camZoomMax',       1,   6, 0.05).name('Zoom Max (tight)');
cameraF.add(config, 'camFramePaddingX', 0, 200,   5) .name('Frame Pad X px');
cameraF.add(config, 'camFramePaddingY', 0, 200,   5) .name('Frame Pad Y px');
cameraF.add(config, 'camFighterExtent', 0, 200,   5) .name('Fighter Extent px');
cameraF.add(config, 'camZoomLerp',    0.5,  20, 0.5) .name('Zoom Rate — Out');
cameraF.add(config, 'camZoomInLerp',  0.5,  20, 0.5) .name('Zoom Rate — In');
cameraF.add(config, 'camZoomDeadzone',  0, 0.3, 0.01).name('Zoom Deadzone');
cameraF.add(config, 'arenaMarginX',     0, 400,   5) .name('Arena Margin X px');
cameraF.add(config, 'arenaMarginY',     0, 400,   5) .name('Arena Margin Y px');
cameraF.add(config, 'camPairMix',     0,   1, 0.05).name('Player ↔ Pair Anchor');
cameraF.add(config, 'camBiasFrac',    0, 0.3, 0.01).name('Left Bias (frac)');
cameraF.add(config, 'camBiasFalloff', 5, 300,   5) .name('Bias Flip Ramp px');
cameraF.add(config, 'camLerpX',       0.5, 20, 0.5).name('Follow Rate X');
cameraF.add(config, 'camLerpY',       0.5, 20, 0.5).name('Follow Rate Y');
cameraF.open();

const fighterF = gui.addFolder('Fighter');
fighterF.add(config, 'moveSpeed',    50,  600,  1).name('Move Speed');
fighterF.add(config, 'playerMass',   20,  200,  1).name('Mass (kg)');
fighterF.add(config, 'acceleration', 100, 3000, 10).name('Acceleration');
fighterF.add(config, 'friction',     100, 3000, 10).name('Friction');
fighterF.add(config, 'fighterRadius', 10,  60,  1).name('Hit Radius');
// Body Color is currently wired to nothing — see the note on fighterBodyColor
// in config.js. Left on the panel pending a call on what to hand back to it.
fighterF.addColor(config, 'fighterBodyColor').name('Body Color (unused)');
fighterF.addColor(config, 'fighterSkinColor').name('Skin Color');
fighterF.addColor(config, 'fighterTrunksColor').name('Trunks Color');
fighterF.addColor(config, 'fighterGloveColor').name('Glove Color');
fighterF.add(config, 'trunksHeight',      0, 26, 1).name('Trunks Down Thigh px');
fighterF.add(config, 'guardBobAmplitude', 0, 12, 0.5).name('Move Bob px');
fighterF.add(config, 'guardBobFrequency', 0,  6, 0.1).name('Move Bob Hz');
// The two rear-side depth treatments, both live so they can be compared without
// a code change: Darken is the current one, Alpha is the old translucency.
fighterF.add(config, 'rearLimbDarken',    0,  1, 0.01).name('Rear Limb Darken');
fighterF.add(config, 'rearArmAlpha',    0.4,  1, 0.01).name('Rear Limb Alpha');
fighterF.add(config, 'facingDeadband',    0, 10, 0.25).name('Facing Deadband px');
fighterF.add(config, 'fighterSeparationDist',     0, 100, 1).name('Separation Dist');
fighterF.add(config, 'fighterSeparationStrength', 0,   1, 0.05).name('Separation Strength');
fighterF.close();

const combatF = gui.addFolder('Combat');
combatF.add(config, 'punchForceBase',     50, 800,  5).name('Base Force');
combatF.add(config, 'punchMomentumScale',  0,   5, 0.1).name('Momentum Scale');
combatF.add(config, 'punchDuration',     0.05, 0.5, 0.01).name('Punch Duration (base)');
combatF.add(config, 'smotherDist',        0,  150,  5).name('Smother Dist');
combatF.add(config, 'blockReduction',     0,    1, 0.05).name('Block Reduction');
combatF.open();

// ── Vulnerability (Stage 16 part 1 + 2) ──────────────────────────────────────
// The curve's shape, and the whiff penalty that stretches its decay. Show
// Readout is not optional equipment: vulnerability is a continuous number that
// can't be read off the rig, so nothing below it can be tuned blind.
const vulnF = gui.addFolder('Vulnerability');
vulnF.add(config, 'vulnerabilityPeak',       0,   1, 0.05).name('Peak (max 0..1)');
vulnF.add(config, 'vulnerabilityCockLevel',  0,   1, 0.05).name('Level at End of Cock');
vulnF.add(config, 'vulnerabilityRiseShape',  0.3, 5, 0.1) .name('Rise Shape (>1 = late)');
vulnF.add(config, 'vulnerabilityDecayShape', 0.3, 5, 0.1) .name('Decay Shape (>1 = fast)');
// The global scalar first, then the per-type WEIGHTS it multiplies (Stage 17
// part 0c). Drag the global to move the whole gradient; drag a weight to change
// only that punch's share of it. See punchWhiffRecoveryMult() in config.js.
vulnF.add(config, 'whiffRecoveryMultiplier', 1,   5, 0.1) .name('Whiff Recovery x (global)');
vulnF.add(config, 'jabWhiffScale',           0,   2, 0.05).name('· jab weight');
vulnF.add(config, 'crossWhiffScale',         0,   2, 0.05).name('· cross weight');
vulnF.add(config, 'hookWhiffScale',          0,   2, 0.05).name('· hook weight');
vulnF.add(config, 'uppercutWhiffScale',      0,   2, 0.05).name('· uppercut weight');
vulnF.add(config, 'showVulnerability')                    .name('Show Readout');
vulnF.open();

// ── Counter + perfect block (Stage 16 parts 3 + 4) ───────────────────────────
// Counter Force x multiplies the SHARED force value, so it scales damage,
// stagger and the hit reaction together. The perfect-block numbers below feed
// the same vulnerability the counter reads — that's the loop.
const counterF = gui.addFolder('Counter / Perfect Block');
counterF.add(config, 'counterForceBonus',     0,   3, 0.05) .name('Counter Force x');
counterF.add(config, 'counterHitStopBonus',   0, 0.2, 0.005).name('Counter Hit-Stop +s');
counterF.add(config, 'counterShakeIntensity', 0, 0.03, 0.001).name('Counter Shake');
counterF.add(config, 'counterShakeDuration',  0, 0.6, 0.02) .name('Shake Duration (s)');
counterF.add(config, 'perfectBlockWindow',    0, 0.5, 0.01) .name('Perfect Window (s)');
counterF.add(config, 'perfectBlockPunishVulnerability', 0, 1, 0.05).name('Punish Vulnerability');
counterF.add(config, 'perfectBlockPunishDuration', 0, 1.5, 0.05).name('Punish Duration (s)');
counterF.add(config, 'perfectBlockHitStop',   0, 0.2, 0.005).name('Perfect Hit-Stop (s)');
counterF.open();

// ── Feedback VFX (Stage 16 part 5) ───────────────────────────────────────────
// The two placeholder effects, replaced. Both are deliberately understated —
// they get redesigned once sprite art lands.
const fxF = gui.addFolder('Feedback VFX');
fxF.add(config, 'blockFlashDuration',    0.02, 0.5, 0.01).name('Block Flash (s)');
fxF.add(config, 'blockFlashAlpha',       0,      1, 0.05).name('Block Flash Alpha');
fxF.add(config, 'blockFlashRadiusScale', 0.5,    3, 0.05).name('Block Flash Radius x');
fxF.add(config, 'whiffStreakDuration',   0.05, 0.6, 0.01).name('Whiff Streak (s)');
fxF.add(config, 'whiffStreakSamples',    2,     24,    1).name('Whiff Streak Points');
fxF.add(config, 'whiffStreakWidth',      1,     16,  0.5).name('Whiff Streak Width');
fxF.add(config, 'whiffStreakAlpha',      0,      1, 0.05).name('Whiff Streak Alpha');
fxF.close();

// Hit geometry (Stage 9) — these ARE the range gate now: reach is whatever the
// fist circle plus these boxes happen to produce per punch type.
const hurtboxF = gui.addFolder('Hurtboxes');
hurtboxF.add(config, 'fistRadius',          2,  30, 1).name('Fist Radius');
hurtboxF.add(config, 'headHurtboxRadius',   4,  40, 1).name('Head Radius');
hurtboxF.add(config, 'headHurtboxOffsetY', -80,  0, 1).name('Head Offset Y');
hurtboxF.add(config, 'bodyHurtboxWidth',   10,  70, 1).name('Body Width');
hurtboxF.add(config, 'bodyHurtboxHeight',  10,  80, 1).name('Body Height');
hurtboxF.add(config, 'bodyHurtboxOffsetY', -60, 20, 1).name('Body Offset Y');
hurtboxF.add(config, 'showHurtboxes')                 .name('Show Hurtboxes');
hurtboxF.open();

// Aim cone (Stage 13) — how far a punch may bend off its own trajectory toward
// an off-axis opponent. Max Aim Angle is the knob that decides whether ring
// position is a tactical layer or a per-punch precision requirement; Show Aim
// Cone is what makes it tunable by eye rather than by guesswork.
const aimF = gui.addFolder('Aim');
aimF.add(config, 'maxAimAngle',  0,  60, 1)   .name('Max Aim Angle (deg)');
aimF.add(config, 'aimBendRamp', 0.2, 4, 0.1)  .name('Bend Ramp');
aimF.add(config, 'aimMinRun',     1, 40, 1)   .name('Min Run px');
aimF.add(config, 'jabAimPointY',      -80, 20, 1).name('Jab Aim Point Y');
aimF.add(config, 'crossAimPointY',    -80, 20, 1).name('Cross Aim Point Y');
aimF.add(config, 'hookAimPointY',     -80, 20, 1).name('Hook Aim Point Y');
aimF.add(config, 'uppercutAimPointY', -80, 20, 1).name('Uppercut Aim Point Y');
aimF.add(config, 'showAimCone')                  .name('Show Aim Cone');
aimF.open();

// Per-punch identity (Stage 8). Damage multiplies the momentum-based force;
// speed divides config.punchDuration (higher = snappier).
const punchTypeF = gui.addFolder('Punch Types');
punchTypeF.add(config, 'jabDamage',       0.1, 3, 0.05).name('Jab Damage x');
punchTypeF.add(config, 'jabSpeed',        0.3, 3, 0.05).name('Jab Speed x');
punchTypeF.add(config, 'crossDamage',     0.1, 3, 0.05).name('Cross Damage x');
punchTypeF.add(config, 'crossSpeed',      0.3, 3, 0.05).name('Cross Speed x');
punchTypeF.add(config, 'hookDamage',      0.1, 3, 0.05).name('Hook Damage x');
punchTypeF.add(config, 'hookSpeed',       0.3, 3, 0.05).name('Hook Speed x');
punchTypeF.add(config, 'uppercutDamage',  0.1, 3, 0.05).name('Uppercut Damage x');
punchTypeF.add(config, 'uppercutSpeed',   0.3, 3, 0.05).name('Uppercut Speed x');
punchTypeF.open();

// Combat audio. Master volume is the knob that matters; the jitter pair is here
// because config rules say no gameplay constant gets hardcoded, and "how robotic
// do repeated punches sound" is exactly a feel value to slide.
const audioF = gui.addFolder('Audio');
audioF.add(config, 'audioEnabled')                        .name('Enabled');
audioF.add(config, 'audioMasterVolume', 0, 1,    0.01)    .name('Master Volume');
audioF.add(config, 'audioPitchJitter',  0, 0.30, 0.01)    .name('Pitch Jitter ±');
audioF.add(config, 'audioVolumeJitter', 0, 0.50, 0.01)    .name('Volume Jitter ±');
audioF.open();

// Hit reaction — the localized rig response to a landed punch.
// Shared spring first, then the per-punch shape (direction/proportion only:
// magnitude always comes from the force calc, so these compose with Base Force,
// Momentum Scale and the per-punch Damage multiplier above).
const reactF = gui.addFolder('Hit Reaction');
reactF.add(config, 'reactionStiffness',  50, 1500, 10).name('Spring Stiffness');
reactF.add(config, 'reactionDamping',     1,   60,  1).name('Damping');
reactF.add(config, 'reactionForceScale',  0,    6, 0.05).name('Force → Motion x');
reactF.add(config, 'reactionTwistScale',  0, 0.05, 0.001).name('Force → Twist x');
reactF.add(config, 'reactionMaxOffset',   5,  100,  1).name('Max Offset px');
reactF.add(config, 'reactionMaxTilt',   0.1,  1.5, 0.05).name('Max Tilt (rad)');
for (const t of ['jab', 'cross', 'hook', 'uppercut']) {
  const f = reactF.addFolder(t[0].toUpperCase() + t.slice(1));
  f.add(config, `${t}ReactBack`,  -1, 2, 0.05).name('Back');
  f.add(config, `${t}ReactLift`,  -1, 2, 0.05).name('Lift (up +)');
  f.add(config, `${t}ReactTwist`, -2, 2, 0.05).name('Twist');
  f.add(config, `${t}ReactTorso`,  0, 1, 0.05).name('Torso Bleed');
  f.add(config, `${t}ReactSnap`, 0.3, 3, 0.05).name('Snap x');
  f.close();
}
reactF.close();

const hitStopF = gui.addFolder('Hit Stop');
hitStopF.add(config, 'hitStopEnabled')                    .name('Enabled');
hitStopF.add(config, 'hitStopBase',     0,   0.15, 0.005).name('Base (s)');
hitStopF.add(config, 'hitStopPerForce', 0, 0.0006, 0.00002).name('Per Force (s)');
hitStopF.add(config, 'hitStopMax',   0.01,    0.3, 0.01) .name('Max (s)');
hitStopF.add(config, 'hitStopScale',    0,      1, 0.01) .name('Timescale');
hitStopF.close();

const dummyF = gui.addFolder('Dummy');
dummyF.add(config, 'dummyReturnSpeed',  5, 200,  5).name('Spring Stiffness');
dummyF.add(config, 'dummyDamping',      1,  50,  1).name('Damping');
dummyF.add(config, 'dummyAttackDelayMin', 0.5, 6, 0.1).name('Attack Delay Min');
dummyF.add(config, 'dummyAttackDelayMax', 0.5, 8, 0.1).name('Attack Delay Max');
dummyF.add(config, 'dummyWindupDuration', 0.2, 1.5, 0.05).name('Windup Duration');
dummyF.addColor(config, 'dummyBodyColor').name('Body Color (unused)');
dummyF.addColor(config, 'dummySkinColor').name('Skin Color');
dummyF.addColor(config, 'dummyTrunksColor').name('Trunks Color');
dummyF.addColor(config, 'dummyGloveColor').name('Glove Color');
dummyF.open();

// Contact shadows (Stage 14) — purely visual. Enabled is here so the whole
// effect can be toggled off for a side-by-side comparison.
const shadowF = gui.addFolder('Shadows');
shadowF.add(config, 'shadowEnabled')                       .name('Enabled');
shadowF.addColor(config, 'shadowColor')                    .name('Color');
shadowF.add(config, 'shadowAlpha',    0,   1,    0.01)     .name('Alpha');
shadowF.add(config, 'shadowRadiusX',  2,  80,    1)        .name('Radius X px');
shadowF.add(config, 'shadowRadiusY',  1,  40,    0.5)      .name('Radius Y px');
shadowF.add(config, 'shadowOffsetY', -20, 90,    1)        .name('Offset Y px');
shadowF.add(config, 'shadowDownRadiusScale', 1, 3, 0.05)   .name('Knockdown Spread x');
shadowF.open();

const dummyAiF = gui.addFolder('Dummy AI');
dummyAiF.add(config, 'dummyMoveSpeed',                 50, 400, 5).name('Move Speed');
dummyAiF.add(config, 'dummyStandoffDist',               0, 300, 5).name('Standoff Dist');
dummyAiF.add(config, 'dummyEngageDist',                20, 300, 1).name('Engage Dist');
dummyAiF.add(config, 'dummyStandoffBand',               2,  80, 1).name('Standoff Band');
dummyAiF.add(config, 'dummyBlockReactionChance',        0,   1, 0.05).name('Block React Chance');
dummyAiF.add(config, 'dummyBlockReactionWindow',     0.05, 1.5, 0.05).name('Block Window (s)');
dummyAiF.add(config, 'dummyOpeningAggressionMultiplier', 1, 5, 0.1).name('Opening Aggression x');
dummyAiF.open();

// ── Dev hook ──────────────────────────────────────────────────────────────────
// Lets the Playwright verification scripts in /scripts read live game state
// (positions, stamina, AI aggression) and override config values instead of
// inferring everything from pixels. Not read by any gameplay code.
window.__game   = game;
window.__config = config;
// Also exposed so the punch-animation checks can render a contact sheet of every
// punch's trajectory in one frame instead of scrubbing the live fighter.
window.__rig    = {
  drawRig, computePose, hurtboxes, peakProgress, circleHitsCircle, circleHitsBox,
  // Stage 13 — so the aim checks can solve the cone angle and read a punch's
  // real peak geometry directly, instead of re-deriving either from pixels.
  aimAngle, punchGeometry, maxAimAngleRad, armSlot,
  // Stage 16 — so the vulnerability checks can evaluate the curve directly
  // against the punch timings it is derived from, and the whiff-streak check
  // can compare the drawn path to the real wrist arc.
  punchTiming, wristPath,
};
// Stage 16 — the vulnerability curve itself, so vulnerability_test.mjs asserts
// against the shipped function rather than re-deriving the shape.
// Stage 17 — and the per-type whiff-recovery lookup next to it, so the checks
// assert against the shipped composition rule (global × per-type weight) rather
// than re-deriving it from the two config values.
window.__vuln = { curve: punchVulnerability, whiffMult: punchWhiffRecoveryMult };
// Audio can't be asserted on by listening in a headless browser, so the checks
// in scripts/audio_test.mjs read the bounded log of which logical sound each
// resolved outcome asked for, and at what pitch. See audio.js.
// `render` additionally renders a sound offline so the checks can measure the
// waveform the recipes actually produce, not just which name was requested.
window.__audio  = { log: audioLog, play: playCombatSound, render: renderCombatSound };
// Camera state for the Stage 11 checks: the visible world rect, the two
// cameras' scroll/zoom, and screen-space projections of anything worth
// asserting on — so the tests read the real transform instead of guessing it
// from a screenshot.
window.__cam = () => {
  const s = game.scene.keys.RingScene;
  if (!s || !s.followCam) return null;
  const main = s.cameras.main;
  const ui   = s.uiCam;
  const view = s.followCam.getView();
  const toScreen = (p) => ({
    x: (p.x - main.scrollX - main.width / 2) * main.zoom + main.width / 2,
    y: (p.y - main.scrollY - main.height / 2) * main.zoom + main.height / 2,
  });
  const ring = s._getRingBounds();
  return {
    view,
    ring,
    // Stage 15 — the camera's own clamp rect (ring + arenaMargin*). Camera
    // only; fighters still clamp to `ring`.
    arena: arenaBounds(ring),
    main: { scrollX: main.scrollX, scrollY: main.scrollY, zoom: main.zoom },
    ui:   { scrollX: ui.scrollX,   scrollY: ui.scrollY,   zoom: ui.zoom },
    player: { x: s.fighter.x, y: s.fighter.y, screen: toScreen(s.fighter) },
    dummy:  { x: s.dummy.x,   y: s.dummy.y,   screen: toScreen(s.dummy) },
    hitStop: s._hitStopTimer,
  };
};

const slipF = gui.addFolder('Slip / Duck');
slipF.add(config, 'slipInputThreshold',        0.1, 1,   0.05).name('Push Threshold');
slipF.add(config, 'slipFlickMaxDurationMs',     40, 500, 10).name('Flick Max Duration (ms)');
slipF.add(config, 'slipInvincibilityDuration', 0.05, 1,  0.01).name('Slip Window (s)');
slipF.add(config, 'slipHeadOffsetX',             0, 150, 5).name('Head Offset X');
slipF.add(config, 'slipHeadOffsetY',             0, 150, 5).name('Head Offset Y');
slipF.open();

const healthF = gui.addFolder('Health / Stamina');
healthF.add(config, 'healthMax',                 20, 300, 5).name('Health Max');
healthF.add(config, 'healthDamagePerForce',     0.01, 0.3, 0.005).name('Damage / Force');
healthF.add(config, 'staminaMax',                20, 300, 5).name('Stamina Max');
healthF.add(config, 'staminaDrainPerPunch',       0,  30, 1).name('Drain / Punch');
healthF.add(config, 'staminaDrainPerSecondBlocking', 0, 60, 1).name('Drain / s Blocking');
healthF.add(config, 'staminaRegenPerSecond',      0,  60, 1).name('Regen / s');
// Chip damage on being hit (Stage 17 part 0d). Derived from the same force
// value as health damage, so the slider above it is the direct comparison.
healthF.add(config, 'staminaDrainPerHitForce', 0, 0.06, 0.001).name('Drain / Hit Force');
healthF.add(config, 'staminaDrainBlockedMult', 0,    3, 0.05) .name('Blocked Drain x');
healthF.add(config, 'staminaRegenDelayAfterHit', 0,  3, 0.05) .name('Regen Delay / Hit (s)');
healthF.add(config, 'lowStaminaThreshold',       0, 100, 1).name('Low Stamina Threshold');
healthF.add(config, 'lowStaminaWindupMultiplier', 1,   5, 0.1).name('Low Stamina Windup x');
healthF.add(config, 'knockdownRecoveryDuration', 0.5, 8, 0.1).name('Knockdown Duration (s)');
healthF.add(config, 'knockdownHealthRestorePct',  0.05, 1, 0.05).name('Knockdown Restore %');
healthF.open();

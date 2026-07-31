import Phaser from 'phaser';
import GUI from 'lil-gui';
import { config, punchDamageMult } from './config.js';
import { Fighter } from './fighter.js';
import { Dummy } from './dummy.js';
import { VirtualJoystick } from './joystick.js';
import { PunchButtons } from './punchButtons.js';
import { BlockButton } from './blockButton.js';
import { Hud } from './hud.js';
import { FollowCamera } from './camera.js';
import { Arena } from './arena.js';
import {
  drawRig, computePose, leadArm, rearArm,
  peakProgress, hurtboxes, circleHitsCircle, circleHitsBox,
} from './rig.js';

const GAME_W = 960;
const GAME_H = 640;

// ── Flash effect helpers ──────────────────────────────────────────────────────
// Each flash: { x, y, color, elapsed, maxTime, style: 'ring'|'burst' }
function makeRing(x, y, color, maxTime = 0.28) {
  return { x, y, color, elapsed: 0, maxTime, style: 'ring' };
}
function makeBurst(x, y, color, maxTime = 0.22) {
  return { x, y, color, elapsed: 0, maxTime, style: 'burst' };
}

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

    this.flashGfx = this.add.graphics().setDepth(15);
    this._flashes = [];

    // Dev-only hurtbox overlay (config.showHurtboxes) — the hit geometry is
    // otherwise invisible, which makes the hurtbox sliders impossible to tune.
    this.debugGfx = this.add.graphics().setDepth(20);

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
      ...this.arena.displayObjects(), this.flashGfx, this.debugGfx,
      this.fighter.container, this.dummy.container,
    ];
    const ui = [
      ...this.joystick.displayObjects(),
      ...this.punchBtns.displayObjects(),
      ...this.blockBtn.displayObjects(),
      ...this.hud.displayObjects(),
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

    // ── Start arm animation immediately (plays even on whiff/smother) ──────
    this.fighter.startPunch(arm, punchType);

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
        // Orange expanding ring at fist — "I swung but hit air"
        this._flashes.push(makeRing(fist.x, fist.y, 0xffaa00));
        this._flashes.push(makeRing(fist.x, fist.y, 0xffdd44, 0.18));
        break;

      case 'smother':
        // Grey burst at fist — punch absorbed, no stagger
        this._flashes.push(makeBurst(fist.x, fist.y, 0x7788aa));
        this._flashes.push(makeRing(fist.x, fist.y, 0x667799, 0.2));
        break;

      case 'land': {
        const blocked = !!defender.isBlocking;

        // Stage 10: the generic circular hit flash (a body-centered burst + ring)
        // is GONE for clean hits — the localized rig reaction below is the
        // feedback now. The blue overlay is kept ONLY for blocked hits, where it
        // isn't hit feedback at all: it's the readout for a distinct game state
        // (blockReduction cuts the force by 75%, so the reaction alone would be
        // near-invisible and a blocked hit would look like a whiff).
        if (blocked) defender.flash(0x3388ff);

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
        if (blocked) force *= (1 - config.blockReduction);

        defender.receiveImpulse(dirX * force, dirY * force);
        // Localized punch-type reaction (Stage 10) — head/torso/tilt, driven by
        // this same force value so it scales with momentum and damage rather
        // than being a flat per-type animation.
        defender.receiveHit(punchType, force);
        // Damage reuses this same post-block-reduction force value (Stage 6)
        // rather than a parallel damage number — see config.healthDamagePerForce.
        defender.takeDamage(force * config.healthDamagePerForce);
        // Hit-stop (Stage 10) — a few frames of near-frozen timescale, length
        // scaled by the same force. Applied globally in update().
        this._triggerHitStop(force);
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
  _triggerHitStop(force) {
    if (!config.hitStopEnabled) return;
    const dur = Math.min(config.hitStopMax, config.hitStopBase + force * config.hitStopPerForce);
    this._hitStopTimer = Math.max(this._hitStopTimer, dur);
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
  _drawHurtboxDebug() {
    const g = this.debugGfx;
    g.clear();
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
    this._updateFlashes(dt);
    this._drawHurtboxDebug();
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

// Follow camera (Stage 11) — viewport only, no gameplay effect. Zoom first:
// see the trade-off note on config.camZoom.
const cameraF = gui.addFolder('Camera');
cameraF.add(config, 'camZoom',        1,   4, 0.05).name('Zoom');
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
fighterF.addColor(config, 'fighterBodyColor').name('Body Color');
fighterF.addColor(config, 'fighterSkinColor').name('Skin Color');
fighterF.add(config, 'guardBobAmplitude', 0, 12, 0.5).name('Move Bob px');
fighterF.add(config, 'guardBobFrequency', 0,  6, 0.1).name('Move Bob Hz');
fighterF.add(config, 'rearArmAlpha',    0.4,  1, 0.01).name('Rear Limb Alpha');
fighterF.add(config, 'facingDeadband',    0, 10, 0.25).name('Facing Deadband px');
fighterF.close();

const combatF = gui.addFolder('Combat');
combatF.add(config, 'punchForceBase',     50, 800,  5).name('Base Force');
combatF.add(config, 'punchMomentumScale',  0,   5, 0.1).name('Momentum Scale');
combatF.add(config, 'punchDuration',     0.05, 0.5, 0.01).name('Punch Duration (base)');
combatF.add(config, 'smotherDist',        0,  150,  5).name('Smother Dist');
combatF.add(config, 'blockReduction',     0,    1, 0.05).name('Block Reduction');
combatF.open();

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

// Hit reaction (Stage 10) — the localized rig response to a landed punch.
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
dummyF.addColor(config, 'dummyBodyColor').name('Body Color');
dummyF.addColor(config, 'dummySkinColor').name('Skin Color');
dummyF.open();

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
window.__rig    = { drawRig, computePose, hurtboxes, peakProgress, circleHitsCircle, circleHitsBox };
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
  return {
    view,
    ring: s._getRingBounds(),
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
healthF.add(config, 'lowStaminaThreshold',       0, 100, 1).name('Low Stamina Threshold');
healthF.add(config, 'lowStaminaWindupMultiplier', 1,   5, 0.1).name('Low Stamina Windup x');
healthF.add(config, 'knockdownRecoveryDuration', 0.5, 8, 0.1).name('Knockdown Duration (s)');
healthF.add(config, 'knockdownHealthRestorePct',  0.05, 1, 0.05).name('Knockdown Restore %');
healthF.open();

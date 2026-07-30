import Phaser from 'phaser';
import GUI from 'lil-gui';
import { config } from './config.js';
import { Fighter } from './fighter.js';
import { Dummy } from './dummy.js';
import { VirtualJoystick } from './joystick.js';
import { PunchButtons } from './punchButtons.js';
import { BlockButton } from './blockButton.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

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
    // ── Ring graphics ──────────────────────────────────────────────────────
    this.ringGfx  = this.add.graphics();
    this.flashGfx = this.add.graphics().setDepth(15);
    this._flashes = [];

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

    // ── Dummy: starts right of center, ~200 px away (within rangeMax=220) ─
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

    // Stores the last horizontal input so hook/uppercut can read it at punch time
    this._lastInputX = 0;

    // Current block-held state, refreshed once per frame before punches resolve
    this._blockHeld = false;

    // ── TEMPORARY DEBUG KEY (Stage 5) ───────────────────────────────────────
    // Press T to force the dummy to throw immediately, bypassing its random
    // timer, so slip timing can be verified on demand. Intentionally kept in
    // past Stage 5 for Stage 6+ testing — see Dummy.forceAttack().
    this._debugForceAttackKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.T);
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

    // ── Hand selection ─────────────────────────────────────────────────────
    // Jab = always lead (left) arm; Cross = always rear (right) arm.
    // Hook / Uppercut: joystick/keyboard left → left hand (lead arm),
    //                  right → right hand (rear arm), neutral → right hand (rear).
    let arm;
    if (punchType === 'jab') {
      arm = 'lead';
    } else if (punchType === 'cross') {
      arm = 'rear';
    } else {
      // hook / uppercut — direction-sensitive
      arm = this._lastInputX < -0.25 ? 'lead' : 'rear';
    }

    // ── Start arm animation immediately (plays even on whiff/smother) ──────
    this.fighter.startPunch(arm);

    // Only jab/cross are smother-vulnerable at close range — hook/uppercut
    // still land, per the locked range-gating rule.
    const smotherable = punchType === 'jab' || punchType === 'cross';
    this._resolveAttack(this.fighter, this.dummy, arm, smotherable);
  }

  // ── Attack impact resolution (dummy-initiated) ──────────────────────────────
  // Called by Dummy at peak extension of its windup — see the onAttackImpact
  // callback passed into `new Dummy(...)` above.
  _resolveDummyAttackImpact() {
    this._resolveAttack(this.dummy, this.fighter, this.dummy.punchArm, true);
  }

  // ── Shared range-gating / impact resolution — used by both attackers ───────
  // (the player punching the dummy, and the dummy punching the player), so
  // whiff/smother/land handling and the force/stagger calc exist in one place.
  _resolveAttack(attacker, defender, arm, smotherable) {
    // Defenders that can slip (Fighter) expose getHitPos() — normally just
    // their true (x, y), but offset while a slip is active. Using it here is
    // the entire "invincibility" implementation: no separate bypass flag.
    const defPos = typeof defender.getHitPos === 'function'
      ? defender.getHitPos()
      : { x: defender.x, y: defender.y };
    const dx   = defPos.x - attacker.x;
    const dy   = defPos.y - attacker.y;
    const dist = Math.hypot(dx, dy);
    const fist = attacker.getFistPos(arm);

    let outcome;
    if (dist > config.rangeMax) {
      outcome = 'whiff';
    } else if (dist < config.smotherDist && smotherable) {
      outcome = 'smother';
    } else {
      outcome = 'land';
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
        const blocked   = !!defender.isBlocking;
        const flashTint = blocked ? 0x3388ff : 0xff3333;
        const burstTint = blocked ? 0x2266ee : 0xff2222;

        defender.flash(flashTint);
        this._flashes.push(makeBurst(defender.x, defender.y - 20, burstTint));
        this._flashes.push(makeRing(defender.x, defender.y - 20, 0xffffff, 0.2));

        // Force = base + momentum contribution from the attacker's approach velocity
        const d    = dist || 1;
        const dirX = dx / d;
        const dirY = dy / d;
        const approachSpd = attacker.vx * dirX + attacker.vy * dirY;
        let force = config.punchForceBase
          + (approachSpd / config.moveSpeed) * config.playerMass * config.punchMomentumScale;
        force = Math.max(config.punchForceBase * 0.1, force);
        if (blocked) force *= (1 - config.blockReduction);

        defender.receiveImpulse(dirX * force, dirY * force);
        break;
      }
    }
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

  // ── Ring drawing ──────────────────────────────────────────────────────────
  drawRing() {
    const g  = this.ringGfx;
    const cx = GAME_W / 2, cy = GAME_H / 2;
    const hw = config.ringWidth / 2, hh = config.ringHeight / 2;
    g.clear();

    g.fillStyle(cssHex(config.ringFloorColor), 1);
    g.fillRect(cx - hw, cy - hh, config.ringWidth, config.ringHeight);

    const ropeCount = Math.max(1, Math.round(config.ringRopeCount));
    const ropeStep  = config.ringHeight / (ropeCount + 1);
    g.lineStyle(Math.max(1, config.ringBorderThickness / 3), cssHex(config.ringRopeColor), 0.85);
    for (let i = 1; i <= ropeCount; i++) {
      const y = cy - hh + ropeStep * i;
      g.beginPath(); g.moveTo(cx - hw, y); g.lineTo(cx + hw, y); g.strokePath();
    }

    g.lineStyle(config.ringBorderThickness, cssHex(config.ringRopeColor), 1);
    g.strokeRect(cx - hw, cy - hh, config.ringWidth, config.ringHeight);

    const ps = 14;
    g.fillStyle(cssHex(config.ringPostColor), 1);
    for (const [px, py] of [
      [cx - hw, cy - hh], [cx + hw, cy - hh],
      [cx - hw, cy + hh], [cx + hw, cy + hh],
    ]) g.fillRect(px - ps / 2, py - ps / 2, ps, ps);
  }

  // ── Main update loop ──────────────────────────────────────────────────────
  update(_time, delta) {
    const dt = Math.min(delta / 1000, 0.05);

    this.drawRing();

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
    this.fighter.update(dt, inputX, inputY, this._getRingBounds(), this.dummy.x, this._blockHeld);
    this.dummy.update(dt, this.fighter.x);
    this._updateFlashes(dt);
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
ringF.addColor(config, 'ringFloorColor')              .name('Floor Color');
ringF.addColor(config, 'ringRopeColor')               .name('Rope Color');
ringF.add(config, 'ringRopeCount',         1,   6,  1).name('Rope Lines');
ringF.add(config, 'ringBorderThickness',   1,  24,  1).name('Border px');
ringF.close();

const fighterF = gui.addFolder('Fighter');
fighterF.add(config, 'moveSpeed',    50,  600,  1).name('Move Speed');
fighterF.add(config, 'playerMass',   20,  200,  1).name('Mass (kg)');
fighterF.add(config, 'acceleration', 100, 3000, 10).name('Acceleration');
fighterF.add(config, 'friction',     100, 3000, 10).name('Friction');
fighterF.add(config, 'fighterRadius', 10,  60,  1).name('Hit Radius');
fighterF.addColor(config, 'fighterBodyColor').name('Body Color');
fighterF.addColor(config, 'fighterSkinColor').name('Skin Color');
fighterF.close();

const combatF = gui.addFolder('Combat');
combatF.add(config, 'punchForceBase',     50, 800,  5).name('Base Force');
combatF.add(config, 'punchMomentumScale',  0,   5, 0.1).name('Momentum Scale');
combatF.add(config, 'punchDuration',     0.05, 0.5, 0.01).name('Punch Duration');
combatF.add(config, 'rangeMax',          80,  500,  5).name('Range Max');
combatF.add(config, 'smotherDist',        0,  150,  5).name('Smother Dist');
combatF.add(config, 'blockReduction',     0,    1, 0.05).name('Block Reduction');
combatF.open();

const dummyF = gui.addFolder('Dummy');
dummyF.add(config, 'dummyReturnSpeed',  5, 200,  5).name('Spring Stiffness');
dummyF.add(config, 'dummyDamping',      1,  50,  1).name('Damping');
dummyF.add(config, 'dummyAttackDelayMin', 0.5, 6, 0.1).name('Attack Delay Min');
dummyF.add(config, 'dummyAttackDelayMax', 0.5, 8, 0.1).name('Attack Delay Max');
dummyF.add(config, 'dummyWindupDuration', 0.2, 1.5, 0.05).name('Windup Duration');
dummyF.addColor(config, 'dummyBodyColor').name('Body Color');
dummyF.addColor(config, 'dummySkinColor').name('Skin Color');
dummyF.open();

const slipF = gui.addFolder('Slip / Duck');
slipF.add(config, 'slipInputThreshold',        0.1, 1,   0.05).name('Push Threshold');
slipF.add(config, 'slipFlickMaxDurationMs',     40, 500, 10).name('Flick Max Duration (ms)');
slipF.add(config, 'slipInvincibilityDuration', 0.05, 1,  0.01).name('Slip Window (s)');
slipF.add(config, 'slipHeadOffsetX',             0, 150, 5).name('Head Offset X');
slipF.add(config, 'slipHeadOffsetY',             0, 150, 5).name('Head Offset Y');
slipF.open();

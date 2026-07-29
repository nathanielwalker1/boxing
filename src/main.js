import Phaser from 'phaser';
import GUI from 'lil-gui';
import { config } from './config.js';
import { Fighter } from './fighter.js';
import { Dummy } from './dummy.js';
import { VirtualJoystick } from './joystick.js';
import { PunchButtons } from './punchButtons.js';

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
    this.dummy = new Dummy(this, GAME_W / 2 + 170, GAME_H / 2);

    // ── Virtual joystick — bottom-left ─────────────────────────────────────
    this.joystick = new VirtualJoystick(this, 110, GAME_H - 110, 70);

    // ── Punch buttons — bottom-right ───────────────────────────────────────
    this.punchBtns = new PunchButtons(
      this,
      GAME_W - 130, GAME_H - 120,
      (type) => this._resolvePunch(type),
    );

    // Stores the last horizontal input so hook/uppercut can read it at punch time
    this._lastInputX = 0;
  }

  // ── Ring bounds (re-computed each frame so slider changes take effect) ─────
  _getRingBounds() {
    const cx = GAME_W / 2, cy = GAME_H / 2;
    const hw = config.ringWidth / 2, hh = config.ringHeight / 2;
    return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
  }

  // ── Punch resolution ───────────────────────────────────────────────────────
  _resolvePunch(punchType) {
    const dx   = this.dummy.x - this.fighter.x;
    const dy   = this.dummy.y - this.fighter.y;
    const dist = Math.hypot(dx, dy);

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
    const fist = this.fighter.getFistPos(arm);

    // ── Range gating ───────────────────────────────────────────────────────
    let outcome;
    if (dist > config.rangeMax) {
      outcome = 'whiff';
    } else if (dist < config.smotherDist && (punchType === 'jab' || punchType === 'cross')) {
      outcome = 'smother';
    } else {
      outcome = 'land';
    }

    // ── Effects per outcome ────────────────────────────────────────────────
    switch (outcome) {
      case 'whiff':
        // Orange expanding ring at fist — "I swung but hit air"
        this._flashes.push(makeRing(fist.x, fist.y, 0xffaa00));
        this._flashes.push(makeRing(fist.x, fist.y, 0xffdd44, 0.18));
        break;

      case 'smother': {
        // Grey burst at fist — punch absorbed, no stagger
        this._flashes.push(makeBurst(fist.x, fist.y, 0x7788aa));
        this._flashes.push(makeRing(fist.x, fist.y, 0x667799, 0.2));
        break;
      }

      case 'land': {
        // Red impact burst on dummy + white ring
        this.dummy.flash(0xff3333);
        this._flashes.push(makeBurst(this.dummy.x, this.dummy.y - 20, 0xff2222));
        this._flashes.push(makeRing(this.dummy.x, this.dummy.y - 20, 0xffffff, 0.2));

        // Force = base + momentum contribution from player's approach velocity
        const d    = dist || 1;
        const dirX = dx / d;
        const dirY = dy / d;
        // Dot player velocity onto direction-to-dummy to get approach speed
        const approachSpd = this.fighter.vx * dirX + this.fighter.vy * dirY;
        const force = config.punchForceBase
          + (approachSpd / config.moveSpeed) * config.playerMass * config.punchMomentumScale;
        const safeForce = Math.max(config.punchForceBase * 0.1, force);

        this.dummy.receiveImpulse(dirX * safeForce, dirY * safeForce);
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

    // Check punch keys BEFORE fighter.update() so arm animation starts same frame
    this.punchBtns.update();

    // Step everything
    this.fighter.update(dt, inputX, inputY, this._getRingBounds());
    this.dummy.update(dt);
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
combatF.open();

const dummyF = gui.addFolder('Dummy');
dummyF.add(config, 'dummyReturnSpeed',  5, 200,  5).name('Spring Stiffness');
dummyF.add(config, 'dummyDamping',      1,  50,  1).name('Damping');
dummyF.addColor(config, 'dummyBodyColor').name('Body Color');
dummyF.addColor(config, 'dummySkinColor').name('Skin Color');
dummyF.open();

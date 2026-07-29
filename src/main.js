import Phaser from 'phaser';
import GUI from 'lil-gui';
import { config } from './config.js';
import { Fighter } from './fighter.js';
import { VirtualJoystick } from './joystick.js';

// Convert CSS hex string '#rrggbb' to Phaser integer 0xrrggbb
function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

const GAME_W = 960;
const GAME_H = 640;

class RingScene extends Phaser.Scene {
  constructor() {
    super({ key: 'RingScene' });
  }

  create() {
    // Ring drawn on a dedicated graphics layer (depth 0)
    this.ringGfx = this.add.graphics();

    // ── Keyboard input ───────────────────────────────────────────────────
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });

    // ── Fighter — starts at ring center ──────────────────────────────────
    this.fighter = new Fighter(this, GAME_W / 2, GAME_H / 2);

    // ── Virtual joystick — bottom-left corner ────────────────────────────
    this.joystick = new VirtualJoystick(this, 110, GAME_H - 110, 70);
  }

  // Compute current ring world bounds from config (re-evaluated every frame
  // so live slider changes to ringWidth/ringHeight are respected instantly).
  _getRingBounds() {
    const cx = GAME_W / 2;
    const cy = GAME_H / 2;
    const hw = config.ringWidth  / 2;
    const hh = config.ringHeight / 2;
    return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
  }

  drawRing() {
    const g  = this.ringGfx;
    const cx = GAME_W / 2;
    const cy = GAME_H / 2;
    const hw = config.ringWidth  / 2;
    const hh = config.ringHeight / 2;

    g.clear();

    // Floor
    g.fillStyle(cssHex(config.ringFloorColor), 1);
    g.fillRect(cx - hw, cy - hh, config.ringWidth, config.ringHeight);

    // Horizontal rope lines
    const ropeCount = Math.max(1, Math.round(config.ringRopeCount));
    const ropeStep  = config.ringHeight / (ropeCount + 1);
    g.lineStyle(Math.max(1, config.ringBorderThickness / 3), cssHex(config.ringRopeColor), 0.85);
    for (let i = 1; i <= ropeCount; i++) {
      const y = cy - hh + ropeStep * i;
      g.beginPath();
      g.moveTo(cx - hw, y);
      g.lineTo(cx + hw, y);
      g.strokePath();
    }

    // Outer border
    g.lineStyle(config.ringBorderThickness, cssHex(config.ringRopeColor), 1);
    g.strokeRect(cx - hw, cy - hh, config.ringWidth, config.ringHeight);

    // Corner posts
    const ps = 14;
    g.fillStyle(cssHex(config.ringPostColor), 1);
    for (const [px, py] of [
      [cx - hw, cy - hh], [cx + hw, cy - hh],
      [cx - hw, cy + hh], [cx + hw, cy + hh],
    ]) {
      g.fillRect(px - ps / 2, py - ps / 2, ps, ps);
    }
  }

  update(_time, delta) {
    // Cap dt to avoid physics explosions if the tab was backgrounded
    const dt = Math.min(delta / 1000, 0.05);

    this.drawRing();

    // ── Gather keyboard input ────────────────────────────────────────────
    let kx = 0, ky = 0;
    if (this.cursors.left.isDown  || this.wasd.left.isDown)  kx -= 1;
    if (this.cursors.right.isDown || this.wasd.right.isDown) kx += 1;
    if (this.cursors.up.isDown    || this.wasd.up.isDown)    ky -= 1;
    if (this.cursors.down.isDown  || this.wasd.down.isDown)  ky += 1;

    // ── Gather joystick input ────────────────────────────────────────────
    const joy = this.joystick.getInput();

    // Combine both inputs — either or both can be active simultaneously
    const inputX = Phaser.Math.Clamp(kx + joy.x, -1, 1);
    const inputY = Phaser.Math.Clamp(ky + joy.y, -1, 1);

    // ── Step fighter ─────────────────────────────────────────────────────
    this.fighter.update(dt, inputX, inputY, this._getRingBounds());
  }
}

// ── Phaser game ──────────────────────────────────────────────────────────────
const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: GAME_W,
  height: GAME_H,
  backgroundColor: '#1a1a2e',
  scene: RingScene,
  parent: document.body,
});

// ── Dev tuning panel (lil-gui) ───────────────────────────────────────────────
const gui = new GUI({ title: 'Tuning Panel', width: 270 });

const ringFolder = gui.addFolder('Ring');
ringFolder.add(config, 'ringWidth',          200, 900, 1).name('Width');
ringFolder.add(config, 'ringHeight',         100, 600, 1).name('Height');
ringFolder.addColor(config, 'ringFloorColor').name('Floor Color');
ringFolder.addColor(config, 'ringRopeColor') .name('Rope Color');
ringFolder.add(config, 'ringRopeCount',      1,  6,  1).name('Rope Lines');
ringFolder.add(config, 'ringBorderThickness',1, 24,  1).name('Border px');
ringFolder.close();  // collapsed by default to give Fighter folder more room

const fighterFolder = gui.addFolder('Fighter');
fighterFolder.add(config, 'moveSpeed',    50, 600,  1).name('Move Speed');
fighterFolder.add(config, 'playerMass',   20, 200,  1).name('Mass (kg)');
fighterFolder.add(config, 'acceleration',100,3000, 10).name('Acceleration');
fighterFolder.add(config, 'friction',    100,3000, 10).name('Friction');
fighterFolder.add(config, 'fighterRadius', 10, 60,  1).name('Hit Radius');
fighterFolder.addColor(config, 'fighterBodyColor').name('Body Color');
fighterFolder.addColor(config, 'fighterSkinColor').name('Skin Color');
fighterFolder.open();

const combatFolder = gui.addFolder('Combat');
combatFolder.add(config, 'punchForceBase', 10, 600, 1).name('Punch Force');
combatFolder.add(config, 'rangeMin',       10, 200, 1).name('Range Min');
combatFolder.add(config, 'rangeMax',      100, 500, 1).name('Range Max');
combatFolder.add(config, 'smotherDist',    0,  150, 1).name('Smother Dist');
combatFolder.close();  // not active yet

import Phaser from 'phaser';
import GUI from 'lil-gui';
import { config } from './config.js';

// Convert CSS hex string '#rrggbb' to Phaser integer 0xrrggbb
function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

class RingScene extends Phaser.Scene {
  constructor() {
    super({ key: 'RingScene' });
  }

  create() {
    this.ringGfx = this.add.graphics();
    this.drawRing();
  }

  drawRing() {
    const g = this.ringGfx;
    g.clear();

    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const hw = config.ringWidth / 2;
    const hh = config.ringHeight / 2;

    // Floor fill
    g.fillStyle(cssHex(config.ringFloorColor), 1);
    g.fillRect(cx - hw, cy - hh, config.ringWidth, config.ringHeight);

    // Rope lines (horizontal, evenly spaced inside the ring border)
    const count = Math.max(1, Math.round(config.ringRopeCount));
    const step = config.ringHeight / (count + 1);
    g.lineStyle(Math.max(1, config.ringBorderThickness / 3), cssHex(config.ringRopeColor), 0.85);
    for (let i = 1; i <= count; i++) {
      const y = cy - hh + step * i;
      g.beginPath();
      g.moveTo(cx - hw, y);
      g.lineTo(cx + hw, y);
      g.strokePath();
    }

    // Ring border
    g.lineStyle(config.ringBorderThickness, cssHex(config.ringRopeColor), 1);
    g.strokeRect(cx - hw, cy - hh, config.ringWidth, config.ringHeight);

    // Corner posts (small squares at each corner)
    const ps = 14;
    g.fillStyle(cssHex(config.ringPostColor), 1);
    [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx - hw, cy + hh],
      [cx + hw, cy + hh],
    ].forEach(([px, py]) => {
      g.fillRect(px - ps / 2, py - ps / 2, ps, ps);
    });
  }

  update() {
    // Redraw every frame so lil-gui changes are reflected instantly
    this.drawRing();
  }
}

// Phaser game
const GAME_W = 960;
const GAME_H = 640;

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: GAME_W,
  height: GAME_H,
  backgroundColor: '#1a1a2e',
  scene: RingScene,
  parent: document.body,
});

// ─── Dev tuning panel (lil-gui) ─────────────────────────────────────────────
const gui = new GUI({ title: 'Tuning Panel', width: 260 });

const ring = gui.addFolder('Ring');
ring.add(config, 'ringWidth',          200, 900, 1).name('Width');
ring.add(config, 'ringHeight',         100, 600, 1).name('Height');
ring.addColor(config, 'ringFloorColor').name('Floor Color');
ring.addColor(config, 'ringRopeColor') .name('Rope Color');
ring.add(config, 'ringRopeCount',      1,  6,  1).name('Rope Lines');
ring.add(config, 'ringBorderThickness',1, 24,  1).name('Border px');

const fighter = gui.addFolder('Fighter');
fighter.add(config, 'moveSpeed',   50,  600, 1).name('Move Speed');
fighter.add(config, 'playerMass',  20,  200, 1).name('Mass (kg)');

const combat = gui.addFolder('Combat');
combat.add(config, 'punchForceBase', 10, 600, 1).name('Punch Force');
combat.add(config, 'rangeMin',       10, 200, 1).name('Range Min');
combat.add(config, 'rangeMax',      100, 500, 1).name('Range Max');
combat.add(config, 'smotherDist',    0,  150, 1).name('Smother Dist');

ring.open();
fighter.open();
combat.open();

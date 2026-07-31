import { config } from './config.js';

/**
 * Hud — fixed-position health/stamina bars for both fighters (Stage 6).
 * Player bars top-left (fill grows rightward), dummy bars top-right
 * (mirrored — fill grows leftward), so the layout reads symmetrically.
 * Health and stamina are visually distinct (color + bar height), not just
 * two bars that look the same.
 */
export class Hud {
  constructor(scene, gameW) {
    this.scene = scene;
    this.gameW = gameW;
    this.gfx   = scene.add.graphics().setDepth(25);

    this.barW = 240;
    this.healthH = 16;
    this.staminaH = 8;
    this.gap = 4;

    this.playerLabel = scene.add.text(20, 2, 'YOU', this._labelStyle()).setDepth(26);
    this.dummyLabel  = scene.add.text(gameW - 20, 2, 'DUMMY', this._labelStyle())
      .setOrigin(1, 0).setDepth(26);
  }

  /**
   * Every Phaser object this component owns, for camera layer assignment
   * (Stage 11) — the HUD is screen-anchored UI and must be ignored by the
   * world camera, or it would scroll and scale with the fight.
   */
  displayObjects() {
    return [this.gfx, this.playerLabel, this.dummyLabel];
  }

  _labelStyle() {
    return { fontSize: '11px', color: '#ffffff', fontFamily: 'monospace' };
  }

  _drawBar(x, y, w, h, pct, fillColor, bgColor, anchorRight) {
    const g = this.gfx;
    g.fillStyle(bgColor, 0.6);
    g.fillRect(x, y, w, h);

    const fillW = Math.max(0, Math.min(1, pct)) * w;
    g.fillStyle(fillColor, 0.95);
    if (anchorRight) g.fillRect(x + w - fillW, y, fillW, h);
    else             g.fillRect(x, y, fillW, h);

    g.lineStyle(1, 0xffffff, 0.5);
    g.strokeRect(x, y, w, h);
  }

  update(fighter, dummy) {
    const g = this.gfx;
    g.clear();

    const y0 = 18;
    const y1 = y0 + this.healthH + this.gap;

    // Player — top-left, fill grows rightward from the left edge.
    this._drawBar(20, y0, this.barW, this.healthH,
      fighter.health / config.healthMax, 0x33cc33, 0x552222, false);
    this._drawBar(20, y1, this.barW, this.staminaH,
      fighter.stamina / config.staminaMax, 0xffcc33, 0x554d1a, false);

    // Dummy — top-right, mirrored (fill grows leftward from the right edge).
    const rx = this.gameW - 20 - this.barW;
    this._drawBar(rx, y0, this.barW, this.healthH,
      dummy.health / config.healthMax, 0x33cc33, 0x552222, true);
    this._drawBar(rx, y1, this.barW, this.staminaH,
      dummy.stamina / config.staminaMax, 0xffcc33, 0x554d1a, true);
  }
}

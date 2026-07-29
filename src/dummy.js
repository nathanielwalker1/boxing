import { config } from './config.js';
import { drawRig } from './rig.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

/**
 * Dummy — static target fighter.
 * Does not move or attack. Takes punch impulses and staggers via a spring-damper.
 * Visually identical rig to the player (uses shared drawRig), different colors.
 */
export class Dummy {
  constructor(scene, x, y) {
    this.scene   = scene;
    this.originX = x;
    this.originY = y;
    this.x       = x;
    this.y       = y;

    // Spring-damper stagger state
    this.staggerVx = 0;
    this.staggerVy = 0;

    // Hit flash state
    this.flashAlpha = 0;
    this.flashColor = 0xffffff;

    // Container + graphics (same pattern as Fighter)
    this.container = scene.add.container(x, y);
    this.gfx       = scene.add.graphics();
    this.container.add(this.gfx);
    this.container.setDepth(4);   // just behind player (depth 5)

    // Faces left toward the player who starts on the left
    this.container.setScale(-1, 1);

    this.draw();
  }

  draw() {
    drawRig(
      this.gfx,
      cssHex(config.dummyBodyColor),
      cssHex(config.dummySkinColor),
    );
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

  update(dt) {
    // ── Spring-damper: pulls dummy back to origin ─────────────────────────
    const dispX = this.x - this.originX;
    const dispY = this.y - this.originY;
    const ax = -config.dummyReturnSpeed * dispX - config.dummyDamping * this.staggerVx;
    const ay = -config.dummyReturnSpeed * dispY - config.dummyDamping * this.staggerVy;
    this.staggerVx += ax * dt;
    this.staggerVy += ay * dt;
    this.x += this.staggerVx * dt;
    this.y += this.staggerVy * dt;

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

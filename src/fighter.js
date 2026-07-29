import Phaser from 'phaser';
import { config } from './config.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

// Draw a rectangle centered at (cx, cy)
function cr(g, cx, cy, w, h) {
  g.fillRect(cx - w * 0.5, cy - h * 0.5, w, h);
}

// Visual extent of the rig from the container origin (derived from draw() layout).
// Used for boundary clamping so the body stays visually inside the ropes.
// Update these if the draw() layout changes — they are geometry, not gameplay tuning.
const RIG_MARGIN_X      = 24;   // arms reach ~22 px left/right of origin
const RIG_MARGIN_TOP    = 67;   // head top: origin - 50 (center) - 13 (radius) - 4 pad
const RIG_MARGIN_BOTTOM = 44;   // shin bottom: origin + 29 (center) + 11 (half-h) + 4 pad

/**
 * Fighter — procedurally drawn humanoid rig inside a Phaser Container.
 *
 * Local coordinate origin = center of torso (rough center of mass).
 * Positive X = fighter's right (forward when facingRight = true).
 * Container.scaleX = -1 flips the whole rig for leftward facing.
 *
 * Body layout (local coords, y-up is negative):
 *   head       y ≈ -50 (circle)
 *   torso      y ≈ -20
 *   upper arms y ≈ -34, at ±17 x
 *   forearms   y ≈ -14, at ±19 x
 *   thighs     y ≈ +5,  at ±11 x
 *   shins      y ≈ +28, at ±11 x
 *
 * Rear limbs drawn at reduced alpha to suggest depth.
 */
export class Fighter {
  constructor(scene, x, y) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facingRight = true;

    // Container is the root; its world position = fighter position
    this.container = scene.add.container(x, y);
    this.gfx = scene.add.graphics();
    this.container.add(this.gfx);
    this.container.setDepth(5);

    this.draw();
  }

  draw() {
    const g = this.gfx;
    g.clear();

    const bc = cssHex(config.fighterBodyColor);
    const sc = cssHex(config.fighterSkinColor);

    // ── Rear limbs (drawn first / visually behind) ────────────────────────
    g.fillStyle(bc, 0.55);
    cr(g,  11,   5, 10, 26);   // rear thigh
    cr(g,  11,  29,  9, 22);   // rear shin
    cr(g,  17, -34,  9, 22);   // rear upper arm
    g.fillStyle(sc, 0.55);
    cr(g,  19, -14,  8, 18);   // rear forearm / fist

    // ── Torso ─────────────────────────────────────────────────────────────
    g.fillStyle(bc, 1.0);
    cr(g,   0, -20, 28, 38);

    // Shorts stripe (white band across lower torso — helps readability)
    g.fillStyle(0xffffff, 0.22);
    cr(g,   0,  -4, 28,  9);

    // ── Lead limbs (drawn in front of torso) ──────────────────────────────
    g.fillStyle(bc, 1.0);
    cr(g, -11,   5, 10, 26);   // lead thigh
    cr(g, -11,  29,  9, 22);   // lead shin
    cr(g, -17, -34,  9, 22);   // lead upper arm
    g.fillStyle(sc, 1.0);
    cr(g, -19, -14,  8, 18);   // lead forearm / fist

    // ── Head ──────────────────────────────────────────────────────────────
    g.fillStyle(sc, 1.0);
    g.fillCircle(1, -50, 13);
    // Ear (on the far/back side — negative x in local space)
    g.fillStyle(sc, 0.80);
    g.fillCircle(-6, -47, 5);
  }

  /**
   * @param {number} dt          delta time in seconds
   * @param {number} inputX      -1..1 horizontal input
   * @param {number} inputY      -1..1 vertical input
   * @param {{left,right,top,bottom}} ringBounds  world-space ring edges
   */
  update(dt, inputX, inputY, ringBounds) {
    const accelRate    = config.acceleration / config.playerMass;
    const frictionRate = config.friction     / config.playerMass;

    const hasInput = Math.abs(inputX) > 0.01 || Math.abs(inputY) > 0.01;

    if (hasInput) {
      // Normalise so diagonal isn't faster than cardinal (len clamped to ≥1)
      const len = Math.sqrt(inputX * inputX + inputY * inputY);
      const nx = inputX / Math.max(len, 1);
      const ny = inputY / Math.max(len, 1);

      const targetVx = nx * config.moveSpeed;
      const targetVy = ny * config.moveSpeed;

      // Exponential lerp toward target velocity — heavier mass → smaller alpha
      const alpha = Math.min(1, accelRate * dt);
      this.vx += (targetVx - this.vx) * alpha;
      this.vy += (targetVy - this.vy) * alpha;
    } else {
      // Decelerate — heavier mass → slower stop
      const decay = Math.min(1, frictionRate * dt);
      this.vx *= (1 - decay);
      this.vy *= (1 - decay);

      // Kill micro-drift
      if (Math.abs(this.vx) < 0.5) this.vx = 0;
      if (Math.abs(this.vy) < 0.5) this.vy = 0;
    }

    // Hard speed cap (safety net for extreme config values)
    const spd = Math.hypot(this.vx, this.vy);
    if (spd > config.moveSpeed) {
      this.vx = (this.vx / spd) * config.moveSpeed;
      this.vy = (this.vy / spd) * config.moveSpeed;
    }

    // ── Integrate position ─────────────────────────────────────────────────
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // ── Ring boundary clamp ────────────────────────────────────────────────
    // Use per-direction rig margins so the body stays visually inside the ropes.
    const preX = this.x, preY = this.y;

    this.x = Phaser.Math.Clamp(this.x,
      ringBounds.left   + RIG_MARGIN_X,
      ringBounds.right  - RIG_MARGIN_X);
    this.y = Phaser.Math.Clamp(this.y,
      ringBounds.top    + RIG_MARGIN_TOP,
      ringBounds.bottom - RIG_MARGIN_BOTTOM);

    // Kill velocity in any direction that was blocked by the wall
    if (this.x !== preX) this.vx = 0;
    if (this.y !== preY) this.vy = 0;

    // ── Facing direction ───────────────────────────────────────────────────
    // Changes only on meaningful horizontal velocity; otherwise holds last dir
    if (this.vx >  8) this.facingRight = true;
    if (this.vx < -8) this.facingRight = false;

    // ── Sync container to world ────────────────────────────────────────────
    this.container.setPosition(this.x, this.y);
    // Flip entire rig by negating scaleX (mirrors around container origin)
    this.container.setScale(this.facingRight ? 1 : -1, 1);

    // Redraw every frame so live config color changes apply instantly
    this.draw();
  }
}

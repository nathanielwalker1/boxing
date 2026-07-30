import Phaser from 'phaser';
import { config } from './config.js';
import { drawRig } from './rig.js';

function cssHex(str) {
  return parseInt(str.replace('#', ''), 16);
}

// Visual extent of the rig from the container origin (derived from rig.js layout).
// Used for boundary clamping. Update if the rig geometry changes.
const RIG_MARGIN_X      = 24;   // arms reach ~22 px left/right of origin
const RIG_MARGIN_TOP    = 67;   // head top: -50 - 13 - 4 pad
const RIG_MARGIN_BOTTOM = 44;   // shin bottom: 29 + 11 + 4 pad

/**
 * Fighter — player-controlled boxer rig.
 *
 * Local origin = torso center.  Container.scaleX = ±1 controls facing direction;
 * facing always tracks the opponent's position, never movement input.
 * Punch state drives arm extension in drawRig() via leadExtend / rearExtend.
 */
export class Fighter {
  constructor(scene, x, y) {
    this.scene = scene;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.facingRight = true;

    // Punch animation state
    this.punchArm   = null;   // 'lead' | 'rear' | null
    this.punchTimer = 0;      // seconds remaining in current punch animation

    // Block state — isBlocking only goes true once any in-progress punch has
    // finished (see update()), so a held block never snaps a punch animation.
    this.isBlocking = false;

    this.container = scene.add.container(x, y);
    this.gfx       = scene.add.graphics();
    this.container.add(this.gfx);
    this.container.setDepth(5);

    this._draw();
  }

  // ── Punch API ──────────────────────────────────────────────────────────────

  /**
   * Trigger a punch animation.  Interrupts any in-progress punch.
   * @param {'lead'|'rear'} arm  which local arm to animate
   */
  startPunch(arm) {
    this.punchArm   = arm;
    this.punchTimer = config.punchDuration;
  }

  /**
   * Return the world-space position of the specified fist (for flash spawning).
   * @param {'lead'|'rear'} arm
   * @returns {{ x: number, y: number }}
   */
  getFistPos(arm) {
    // Local fist x: lead arm at -19, rear arm at +19 (from rig.js layout)
    const localX = arm === 'lead' ? -19 : 19;
    const flip   = this.facingRight ? 1 : -1;
    return { x: this.x + localX * flip, y: this.y - 14 };
  }

  /**
   * Apply a velocity impulse (e.g. from an incoming punch) directly to the
   * fighter's momentum, reusing the same vx/vy the movement system already
   * decays via friction — no separate stagger state needed.
   */
  receiveImpulse(vx, vy) {
    this.vx += vx;
    this.vy += vy;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _draw() {
    let leadExtend = 0, rearExtend = 0;

    if (this.punchTimer > 0 && this.punchArm) {
      // Triangle wave: 0 → 1 at half-duration, 1 → 0 at full duration
      const progress = 1 - this.punchTimer / config.punchDuration;
      const wave     = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
      if (this.punchArm === 'lead') leadExtend = wave;
      else                          rearExtend = wave;
    }

    drawRig(
      this.gfx,
      cssHex(config.fighterBodyColor),
      cssHex(config.fighterSkinColor),
      leadExtend,
      rearExtend,
      this.isBlocking ? 1 : 0,
    );
  }

  // ── Main update ─────────────────────────────────────────────────────────────

  /**
   * @param {number} dt          seconds
   * @param {number} inputX      -1..1 horizontal
   * @param {number} inputY      -1..1 vertical
   * @param {{left,right,top,bottom}} ringBounds
   * @param {number} opponentX   world-space x of the opponent, used for facing
   * @param {boolean} blockHeld  is the block input currently held
   */
  update(dt, inputX, inputY, ringBounds, opponentX, blockHeld) {
    // ── Punch timer ────────────────────────────────────────────────────────
    if (this.punchTimer > 0) {
      this.punchTimer = Math.max(0, this.punchTimer - dt);
      if (this.punchTimer === 0) this.punchArm = null;
    }

    // ── Block ──────────────────────────────────────────────────────────────
    // Engages the instant the block input is held AND no punch is mid-flight —
    // an in-progress punch is left to finish rather than snapping its animation.
    this.isBlocking = blockHeld && this.punchTimer === 0;

    // ── Movement physics ───────────────────────────────────────────────────
    const accelRate    = config.acceleration / config.playerMass;
    const frictionRate = config.friction     / config.playerMass;
    const hasInput     = Math.abs(inputX) > 0.01 || Math.abs(inputY) > 0.01;

    if (hasInput) {
      const len = Math.sqrt(inputX * inputX + inputY * inputY);
      const nx  = inputX / Math.max(len, 1);
      const ny  = inputY / Math.max(len, 1);
      const tvx = nx * config.moveSpeed;
      const tvy = ny * config.moveSpeed;
      const a   = Math.min(1, accelRate * dt);
      this.vx  += (tvx - this.vx) * a;
      this.vy  += (tvy - this.vy) * a;
    } else {
      const decay = Math.min(1, frictionRate * dt);
      this.vx *= (1 - decay);
      this.vy *= (1 - decay);
      if (Math.abs(this.vx) < 0.5) this.vx = 0;
      if (Math.abs(this.vy) < 0.5) this.vy = 0;
    }

    const spd = Math.hypot(this.vx, this.vy);
    if (spd > config.moveSpeed) {
      this.vx = (this.vx / spd) * config.moveSpeed;
      this.vy = (this.vy / spd) * config.moveSpeed;
    }

    // ── Position ───────────────────────────────────────────────────────────
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // ── Ring boundary clamp ────────────────────────────────────────────────
    const preX = this.x, preY = this.y;
    this.x = Phaser.Math.Clamp(this.x, ringBounds.left + RIG_MARGIN_X,   ringBounds.right  - RIG_MARGIN_X);
    this.y = Phaser.Math.Clamp(this.y, ringBounds.top  + RIG_MARGIN_TOP, ringBounds.bottom - RIG_MARGIN_BOTTOM);
    if (this.x !== preX) this.vx = 0;
    if (this.y !== preY) this.vy = 0;

    // ── Facing ─────────────────────────────────────────────────────────────
    // Always face the opponent, independent of movement input/direction.
    if (opponentX > this.x) this.facingRight = true;
    else if (opponentX < this.x) this.facingRight = false;

    // ── Sync container ─────────────────────────────────────────────────────
    this.container.setPosition(this.x, this.y);
    this.container.setScale(this.facingRight ? 1 : -1, 1);

    this._draw();
  }
}

import { config } from './config.js';

/**
 * FollowCamera — the world-space viewport (Stage 11).
 *
 * Framing model, in one line: anchor between the two fighters, push that anchor
 * toward the opponent so the PLAYER ends up in the left third, then clamp the
 * whole thing to the ring.
 *
 * Why anchor on the pair rather than purely on the player: a player-only anchor
 * with a fixed left-third offset puts the player at exactly 1/3 forever, but it
 * has no idea where the opponent is — circle past them and they fall off the
 * left edge. Anchoring on the pair (config.camPairMix) guarantees both fighters
 * stay symmetric around the frame, and the bias term then slides that framing
 * left so the player reads as the left-hand fighter. camPairMix = 0 recovers the
 * rigid player-lock if that turns out to feel better on the sliders.
 *
 * The bias flips sign when the player crosses to the other side of the opponent
 * (otherwise the opponent would be the one shoved off-screen), but it flips
 * through a linear ramp over config.camBiasFalloff px of separation rather than
 * on sign(), so a crossover eases the framing across instead of snapping it.
 *
 * NOTHING here touches gameplay: no ring bounds, no hit geometry, no input
 * mapping. It only sets cameras.main.scroll/zoom.
 */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Frame-rate-independent exponential smoothing. `rate` is in 1/s: higher =
 * snappier. Uses exp() rather than a raw per-frame lerp factor so the follow
 * feel doesn't change with frame rate — and so a hit-stop frame (which arrives
 * here as a near-zero dt) moves the camera by a correspondingly near-zero
 * amount instead of taking its usual fixed step.
 */
function smooth(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export class FollowCamera {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} gameW  canvas width (viewport width in SCREEN px)
   * @param {number} gameH  canvas height
   */
  constructor(scene, gameW, gameH) {
    this.scene = scene;
    this.gameW = gameW;
    this.gameH = gameH;
    this.cam   = scene.cameras.main;

    // Smoothed world-space point held at the center of the viewport.
    this.centerX = gameW / 2;
    this.centerY = gameH / 2;

    this._needsSnap = true;   // first update jumps rather than easing in from the default view
  }

  /**
   * The world-space rectangle currently visible, in the same
   * {left,right,top,bottom} shape the ring bounds use. Exposed for the
   * Playwright checks (and the void/clamp assertions) rather than having them
   * re-derive it from scroll + zoom.
   */
  getView() {
    const zoom  = Math.max(0.1, config.camZoom);
    const viewW = this.gameW / zoom;
    const viewH = this.gameH / zoom;
    return {
      left:   this.centerX - viewW / 2,
      right:  this.centerX + viewW / 2,
      top:    this.centerY - viewH / 2,
      bottom: this.centerY + viewH / 2,
      width:  viewW,
      height: viewH,
      zoom,
    };
  }

  /**
   * @param {number} dt        seconds — ALREADY hit-stop-scaled by the caller,
   *                           which is what keeps camera motion on the same
   *                           clock as everything else during a freeze frame.
   * @param {{x:number,y:number}} player
   * @param {{x:number,y:number}} opponent
   * @param {{left,right,top,bottom}} ringBounds
   */
  update(dt, player, opponent, ringBounds) {
    const zoom = Math.max(0.1, config.camZoom);
    this.cam.setZoom(zoom);

    const viewW = this.gameW / zoom;
    const viewH = this.gameH / zoom;

    // ── Anchor: player → pair-midpoint, per camPairMix ──────────────────────
    const sepX = opponent.x - player.x;
    const sepY = opponent.y - player.y;
    const mix  = clamp(config.camPairMix, 0, 1);
    let targetX = player.x + mix * sepX / 2;
    let targetY = player.y + mix * sepY / 2;

    // ── Horizontal bias: push the frame toward the opponent so the player
    //    sits left of center. Ramped over camBiasFalloff so a crossover eases.
    const dir = clamp(sepX / Math.max(1, config.camBiasFalloff), -1, 1);
    targetX += config.camBiasFrac * viewW * dir;

    // ── Ring clamp — never show past the ring edge into the void. If the view
    //    is WIDER than the ring on an axis (possible via the zoom/ring sliders),
    //    the void is unavoidable, so center on the ring instead of pinning to
    //    one edge, which is what a naive min/max clamp would do.
    const clampAxis = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi));
    targetX = clampAxis(targetX, ringBounds.left + viewW / 2, ringBounds.right - viewW / 2);
    targetY = clampAxis(targetY, ringBounds.top + viewH / 2, ringBounds.bottom - viewH / 2);

    if (this._needsSnap) {
      this.centerX = targetX;
      this.centerY = targetY;
      this._needsSnap = false;
    } else {
      this.centerX = smooth(this.centerX, targetX, config.camLerpX, dt);
      this.centerY = smooth(this.centerY, targetY, config.camLerpY, dt);
    }

    // Re-clamp the SMOOTHED value too: the eased position trails the target, so
    // a live zoom/ring-size change (or a fast corner approach) can leave the
    // trailing point outside the legal band for a few frames and flash the void.
    this.centerX = clampAxis(this.centerX, ringBounds.left + viewW / 2, ringBounds.right - viewW / 2);
    this.centerY = clampAxis(this.centerY, ringBounds.top + viewH / 2, ringBounds.bottom - viewH / 2);

    // Phaser: the world point rendered at the viewport center is
    // (scrollX + width/2, scrollY + height/2) — width/height are the SCREEN
    // viewport size, so this conversion is zoom-independent.
    this.cam.setScroll(this.centerX - this.gameW / 2, this.centerY - this.gameH / 2);
  }
}

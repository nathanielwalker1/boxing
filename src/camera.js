import { config } from './config.js';

/**
 * FollowCamera — the world-space viewport (Stage 11, zoom reworked in Stage 15).
 *
 * Framing model, in one line: anchor between the two fighters, push that anchor
 * toward the opponent so the PLAYER ends up in the left third, then clamp the
 * whole thing to the ARENA (Stage 15: the ring plus a margin, not the ring).
 *
 * Zoom is derived, not authored (Stage 15). Every frame it solves for the
 * smallest zoom that still holds both fighters — plus camFighterExtent of their
 * drawn size, plus camFramePadding — inside the viewport, then clamps that to
 * [camZoomMin, camZoomMax] and to whatever the arena can fill. Nothing is keyed
 * to distance thresholds, so changing ring size, fighter size or viewport size
 * re-solves for free instead of needing the numbers re-tuned.
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

/**
 * The ARENA: the ring rect grown by config.arenaMargin* (Stage 15).
 *
 * This is a CAMERA-ONLY concept. Fighters still clamp to the ring bounds; the
 * arena is simply how far past the ring the camera is allowed to look, and
 * therefore the band the apron / ropes / posts / crowd get to live in. Before
 * this existed the camera clamped to the ring itself, which meant the ring edge
 * could sit at the very edge of the frame but never comfortably inside it.
 *
 * @param {{left,right,top,bottom}} ringBounds
 */
export function arenaBounds(ringBounds) {
  const mx = Math.max(0, config.arenaMarginX);
  const my = Math.max(0, config.arenaMarginY);
  return {
    left:   ringBounds.left   - mx,
    right:  ringBounds.right  + mx,
    top:    ringBounds.top    - my,
    bottom: ringBounds.bottom + my,
  };
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

    // Smoothed zoom, and the deadzoned target it is easing toward. Both are
    // overwritten on the first update() (see _needsSnap) — these are only
    // sane placeholders for anything that reads getView() before then.
    this.zoom      = clamp(2, config.camZoomMin, config.camZoomMax);
    this._heldZoom = this.zoom;

    this._needsSnap = true;   // first update jumps rather than easing in from the default view
  }

  /**
   * The world-space rectangle currently visible, in the same
   * {left,right,top,bottom} shape the ring bounds use. Exposed for the
   * Playwright checks (and the void/clamp assertions) rather than having them
   * re-derive it from scroll + zoom.
   */
  getView() {
    const zoom  = Math.max(0.1, this.zoom);
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
    const arena = arenaBounds(ringBounds);

    // If the view is BIGGER than the arena on an axis, the void is unavoidable,
    // so center on the arena instead of pinning to one edge — which is what a
    // naive min/max clamp would do (lo > hi). Dynamic zoom can now reach this
    // legitimately, e.g. camZoomMax too low for a small arena.
    const clampAxis = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi));

    // Where the camera WANTS to sit, at a given zoom. Shared by the zoom solve
    // (which needs to know the frame it is sizing) and the final placement.
    const anchorAt = (z) => {
      const vw = this.gameW / z, vh = this.gameH / z;

      // ── Anchor: player → pair-midpoint, per camPairMix ────────────────────
      const sepX = opponent.x - player.x;
      const sepY = opponent.y - player.y;
      const mix  = clamp(config.camPairMix, 0, 1);
      let x = player.x + mix * sepX / 2;
      let y = player.y + mix * sepY / 2;

      // ── Horizontal bias: push the frame toward the opponent so the player
      //    sits left of center. Ramped over camBiasFalloff so a crossover eases.
      //    Expressed as a fraction of the visible width, so it is a constant
      //    fraction of the SCREEN at every zoom — the player holds the same
      //    screen position whether the camera is tight or wide.
      const dir = clamp(sepX / Math.max(1, config.camBiasFalloff), -1, 1);
      x += config.camBiasFrac * vw * dir;

      // ── Arena clamp — never show past the arena edge into the void.
      return {
        x: clampAxis(x, arena.left + vw / 2, arena.right - vw / 2),
        y: clampAxis(y, arena.top + vh / 2, arena.bottom - vh / 2),
      };
    };

    // ── Zoom solve ──────────────────────────────────────────────────────────
    // Distances are measured from the frame CENTER, not from the pair's
    // midpoint: camPairMix, the left-bias and the arena clamp all move the
    // center off the midpoint, and a solve that ignored that would size the
    // frame correctly around a point the camera isn't actually looking at.
    //
    // Both the anchor the camera is heading for AND the smoothed center it is
    // currently at are considered, taking the worse of the two — otherwise a
    // fighter can sit outside the real frame for as long as the follow trails.
    // The anchor is solved at the CURRENT zoom, one frame stale; the bias term
    // makes this mildly self-referential (a wider view biases harder, which
    // wants a wider view) but the loop gain is camBiasFrac, so it converges.
    const preAnchor = anchorAt(Math.max(0.1, this.zoom));
    const ext = Math.max(0, config.camFighterExtent);
    const halfNeed = (pa, pb, anchor, center, pad) =>
      Math.max(Math.abs(pa - anchor), Math.abs(pb - anchor),
               Math.abs(pa - center), Math.abs(pb - center)) + ext + Math.max(0, pad);

    const needX = halfNeed(player.x, opponent.x, preAnchor.x, this.centerX, config.camFramePaddingX);
    const needY = halfNeed(player.y, opponent.y, preAnchor.y, this.centerY, config.camFramePaddingY);

    let zoomTarget = Math.min(
      (this.gameW / 2) / Math.max(1, needX),
      (this.gameH / 2) / Math.max(1, needY),
    );
    zoomTarget = clamp(zoomTarget, config.camZoomMin, config.camZoomMax);

    // Never ask for a view wider or taller than the arena can fill: that would
    // pull the void into frame no matter where the camera sat. camZoomMax stays
    // the hard ceiling — if even that can't cover a tiny arena, clampAxis above
    // centers on it rather than showing a lopsided edge.
    const arenaFit = Math.max(
      this.gameW / Math.max(1, arena.right - arena.left),
      this.gameH / Math.max(1, arena.bottom - arena.top),
    );
    zoomTarget = Math.min(Math.max(zoomTarget, arenaFit), config.camZoomMax);

    // ── Anti-oscillation ────────────────────────────────────────────────────
    // Two layers, because the framing solve is continuous in fighter separation
    // and would otherwise track every jab: (1) a deadzone, so the held target
    // only moves once the solve has drifted more than camZoomDeadzone — this
    // kills the small, constant hunting that reads as the camera breathing;
    // (2) asymmetric rates, widening quickly (a fighter leaving the frame is a
    // real failure) and tightening lazily (nothing breaks if the frame stays a
    // little loose for a moment). Same class of fix as the Stage 7 dummy
    // movement deadzone.
    if (Math.abs(zoomTarget - this._heldZoom) > Math.max(0, config.camZoomDeadzone)) {
      this._heldZoom = zoomTarget;
    }
    const zoomRate = this._heldZoom < this.zoom ? config.camZoomLerp : config.camZoomInLerp;

    if (this._needsSnap) this.zoom = this._heldZoom = zoomTarget;
    // smooth() and not a second easing function: it is already frame-rate
    // independent, and a hit-stop frame arrives as a near-zero dt and so moves
    // the zoom by a near-zero amount instead of gliding through the freeze.
    else this.zoom = smooth(this.zoom, this._heldZoom, zoomRate, dt);

    const zoom = Math.max(0.1, this.zoom);
    this.cam.setZoom(zoom);

    const viewW = this.gameW / zoom;
    const viewH = this.gameH / zoom;

    // ── Placement, at the zoom actually in effect this frame ────────────────
    const anchor  = anchorAt(zoom);
    const targetX = anchor.x;
    const targetY = anchor.y;

    if (this._needsSnap) {
      this.centerX = targetX;
      this.centerY = targetY;
      this._needsSnap = false;
    } else {
      this.centerX = smooth(this.centerX, targetX, config.camLerpX, dt);
      this.centerY = smooth(this.centerY, targetY, config.camLerpY, dt);
    }

    // Re-clamp the SMOOTHED value too, AFTER smoothing: the eased position
    // trails the target, so a live ring-size change (or a fast corner approach)
    // can leave the trailing point outside the legal band and flash the void.
    // This matters more now that zoom animates — viewW/viewH move every frame,
    // so the legal band itself shifts under the trailing center.
    this.centerX = clampAxis(this.centerX, arena.left + viewW / 2, arena.right - viewW / 2);
    this.centerY = clampAxis(this.centerY, arena.top + viewH / 2, arena.bottom - viewH / 2);

    // Phaser: the world point rendered at the viewport center is
    // (scrollX + width/2, scrollY + height/2) — width/height are the SCREEN
    // viewport size, so this conversion is zoom-independent.
    this.cam.setScroll(this.centerX - this.gameW / 2, this.centerY - this.gameH / 2);
  }
}

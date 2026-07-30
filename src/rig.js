/**
 * Shared procedural boxer rig drawing.
 * Used by both Fighter (player) and Dummy (target) so the rig shape is identical.
 *
 * All coords are in the local space of the graphics object (container origin = torso center).
 * Positive X = fighter's right.  Container.scaleX = -1 mirrors for leftward facing.
 *
 * Layout (local coords):
 *   head circle   y ≈ -50
 *   torso rect    y ≈ -20
 *   upper arms    y ≈ -34, x ≈ ±17
 *   forearms      y ≈ -14, x ≈ ±19  (animated for punch)
 *   thighs        y ≈ +5,  x ≈ ±11
 *   shins         y ≈ +29, x ≈ ±11
 */

// Draw a rectangle centered at (cx, cy)
function cr(g, cx, cy, w, h) {
  g.fillRect(cx - w * 0.5, cy - h * 0.5, w, h);
}

/**
 * @param {Phaser.GameObjects.Graphics} g
 * @param {number} bodyColor   Phaser integer color
 * @param {number} skinColor   Phaser integer color
 * @param {number} leadExtend  0..1 — lead arm punch extension (extends in +x direction)
 * @param {number} rearExtend  0..1 — rear arm punch extension (extends in +x direction)
 * @param {number} guard       0..1 — blend toward raised guard pose (both forearms up in front of the face)
 */
export function drawRig(g, bodyColor, skinColor, leadExtend = 0, rearExtend = 0, guard = 0) {
  g.clear();

  // Forearm offsets for punch animation — both arms punch toward local +x (toward opponent)
  // Lead arm is at -x, so extending +x moves it toward center; rear arm extends further right.
  const lx = leadExtend * 16;   // lead fist x offset
  const ly = leadExtend * -3;   // slight upward arc
  const rx = rearExtend * 16;
  const ry = rearExtend * -3;

  // Guard pose — forearms rise to the chin, elbows tucked in front of the torso.
  // Blends over idle/punch forearm position rather than replacing it outright.
  const lerp = (a, b, t) => a + (b - a) * t;
  const leadFx = lerp(-19 + lx, -8, guard);
  const leadFy = lerp(-14 + ly, -42, guard);
  const rearFx = lerp( 19 + rx,  8, guard);
  const rearFy = lerp(-14 + ry, -42, guard);

  // ── Rear limbs (behind — drawn first) ─────────────────────────────────────
  g.fillStyle(bodyColor, 0.55);
  cr(g,  11,   5, 10, 26);           // rear thigh
  cr(g,  11,  29,  9, 22);           // rear shin
  cr(g,  17, -34,  9, 22);           // rear upper arm

  // Rear forearm — can extend for cross/right-hand punch, or rise into guard
  g.fillStyle(skinColor, 0.55);
  cr(g, rearFx, rearFy, 8, 18);

  // ── Torso ──────────────────────────────────────────────────────────────────
  g.fillStyle(bodyColor, 1.0);
  cr(g,  0, -20, 28, 38);

  // Shorts stripe (visual anchor)
  g.fillStyle(0xffffff, 0.22);
  cr(g,  0,  -4, 28,  9);

  // ── Lead limbs (front — drawn last / on top) ───────────────────────────────
  g.fillStyle(bodyColor, 1.0);
  cr(g, -11,   5, 10, 26);           // lead thigh
  cr(g, -11,  29,  9, 22);           // lead shin
  cr(g, -17, -34,  9, 22);           // lead upper arm

  // Lead forearm — can extend for jab/left-hand punch, or rise into guard
  g.fillStyle(skinColor, 1.0);
  cr(g, leadFx, leadFy, 8, 18);

  // ── Head ───────────────────────────────────────────────────────────────────
  g.fillStyle(skinColor, 1.0);
  g.fillCircle(1, -50, 13);
  g.fillStyle(skinColor, 0.80);
  g.fillCircle(-6, -47, 5);         // ear
}

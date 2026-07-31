/**
 * Shared procedural boxer rig — skeleton solver + drawing.
 * Used by both Fighter (player) and Dummy (opponent) so the rig is identical.
 *
 * All coords are in the local space of the graphics object (container origin =
 * torso center).  Positive X = TOWARD THE OPPONENT.  Container.scaleX = -1
 * mirrors the whole rig for leftward facing, so "lead" always means the side
 * nearer the opponent regardless of which side of the ring a fighter is on.
 *
 *   LEAD  limbs live at +x (front — closest to the opponent: jab hand, lead leg)
 *   REAR  limbs live at -x (back  — crosses the body to punch: cross hand)
 *
 * NOTE: this used to be inverted (lead drawn at -x), which made the jab appear
 * to come from the back hand and the cross from the front hand.
 *
 * Arms are a two-segment jointed chain solved from angles, not fixed rects, so
 * each punch type can trace its own trajectory (see PUNCHES below):
 *   a1 = upper-arm angle at the shoulder, a2 = forearm angle at the elbow.
 *   Angle 0 = segment hanging straight down; positive = rotating toward +x.
 */

// Visual extent of the rig from the container origin, derived from the layout
// below. Lives here (with the geometry it's derived from) so the player and the
// dummy clamp to the ropes identically — see movement.js. Deliberately measured
// from the IDLE pose: a punch reaches well past this, but clamping to the punch
// extent would shrink the usable ring and change movement feel.
export const RIG_MARGIN_X      = 24;   // arms rest ~22 px left/right of origin
export const RIG_MARGIN_TOP    = 67;   // head top: -50 - 13 - 4 pad
export const RIG_MARGIN_BOTTOM = 44;   // shin bottom: 29 + 11 + 4 pad

// ── Skeleton constants ───────────────────────────────────────────────────────
const SHOULDER_X = 17;
const SHOULDER_Y = -45;
const UPPER_LEN  = 22;
const FORE_LEN   = 18;
const UPPER_W    = 9;
const FORE_W     = 8;
const HIP_X      = 11;

// Body-rotation response to a punch's `turn` value (0..1). Splitting the drive
// per side is what makes a cross read differently from a jab: the rear shoulder
// has to travel all the way across the body, the lead shoulder is already there.
const TORSO_SHIFT        = 8;    // px the torso/head slide forward at full turn
const REAR_SHOULDER_DRIVE = 34;  // rear shoulder travel when IT throws (crosses past center)
const LEAD_SHOULDER_DRIVE = 8;   // lead shoulder travel when IT throws (already forward)
const REAR_SHOULDER_PULL  = 8;   // rear shoulder pulls back while the lead arm throws
const LEAD_SHOULDER_PULL  = 22;  // lead shoulder pulls back while the rear arm throws
const HIP_DRIVE           = 5;   // punching-side hip rotates forward
const HIP_PULL            = 4;   // opposite hip rotates back

// ── Pose keyframes ───────────────────────────────────────────────────────────
const REST_KEY     = { a1: 0, a2: 0, dip: 0, turn: 0 };
const GUARD_ANGLES = { a1: -0.14, a2: -2.73 };   // forearm folded up in front of the chin

/**
 * Per-punch trajectory table. Each punch runs rest → cock → peak → rest across
 * its animation progress p (0..1):
 *   cockEnd — p at which the wind-up pose is reached
 *   peakAt  — p at which full extension is reached
 *   turn    — hip/shoulder rotation at peak (0 = square on, 1 = full torque)
 *   dip     — px the body drops during the wind-up (leg drive for the uppercut)
 *
 * These are pose/animation shape, not gameplay tunables — damage and speed live
 * in config.js. Timings are fractions of the punch's duration, so they stay
 * proportional when a punch's speed multiplier or low stamina stretches it.
 */
const PUNCHES = {
  // Straight, minimal rotation, snaps back fast.
  jab: {
    cock: { a1: -0.15, a2: -0.30 },
    peak: { a1:  1.50, a2:  0.05 },
    cockEnd: 0.12, peakAt: 0.42, turn: 0.15, dip: 0,
  },
  // Straight, but the rear shoulder/hip rotate all the way through — longest reach.
  cross: {
    cock: { a1: -0.35, a2: -0.55 },
    peak: { a1:  1.48, a2:  0.10 },
    cockEnd: 0.20, peakAt: 0.52, turn: 1.00, dip: 0,
  },
  // Wound back across the body, then a wide lateral sweep with the elbow bent
  // and raised — the fist travels ~65 px horizontally at head height.
  hook: {
    cock: { a1: -0.55, a2: -1.45 },
    peak: { a1:  2.05, a2: -1.15 },
    cockEnd: 0.28, peakAt: 0.62, turn: 0.70, dip: 0,
  },
  // Drops to the hip, then the forearm whips upward: the fist rises ~37 px and
  // finishes at chin height clear of the chest, with the elbow staying low.
  // recoverA2 keeps the forearm rotating the SAME way on the way out (-2π is
  // visually identical to 0) instead of unwinding backwards through the strike.
  uppercut: {
    cock: { a1:  0.65, a2: -1.60 },
    peak: { a1:  0.79, a2: -4.38 },
    cockEnd: 0.26, peakAt: 0.60, turn: 0.70, dip: 6,
    recoverA2: -Math.PI * 2,
  },
};

/** Animation progress at which a punch reaches full extension. Used to sample
 *  the pose for flash placement, so effects spawn where the punch ARRIVES
 *  rather than where the fist happens to be on the frame it resolves. */
export function peakProgress(type) {
  return PUNCHES[type] ? PUNCHES[type].peakAt : 0;
}

const lerp    = (a, b, t) => a + (b - a) * t;
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = u => 1 - (1 - u) * (1 - u);            // snap into the strike
const easeIO  = u => u * u * (3 - 2 * u);              // settle on the recovery

function keyLerp(A, B, t) {
  return {
    a1:   lerp(A.a1,   B.a1,   t),
    a2:   lerp(A.a2,   B.a2,   t),
    dip:  lerp(A.dip,  B.dip,  t),
    turn: lerp(A.turn, B.turn, t),
  };
}

/**
 * Resolve a punch definition at progress p into a pose key + an "extension"
 * scalar (0 at rest/cocked, 1 at peak) used for depth/alpha cues.
 */
function punchKey(def, p) {
  const cockK = { a1: def.cock.a1, a2: def.cock.a2, dip:  def.dip,        turn: def.turn * 0.2 };
  const peakK = { a1: def.peak.a1, a2: def.peak.a2, dip: -def.dip * 0.4,  turn: def.turn };

  if (p < def.cockEnd) {
    const u = easeOut(p / def.cockEnd);
    return { key: keyLerp(REST_KEY, cockK, u), ext: 0 };
  }
  if (p < def.peakAt) {
    const u = easeOut((p - def.cockEnd) / (def.peakAt - def.cockEnd));
    return { key: keyLerp(cockK, peakK, u), ext: u };
  }
  const restK = def.recoverA2 === undefined
    ? REST_KEY
    : { ...REST_KEY, a2: def.recoverA2 };
  const u = easeIO((p - def.peakAt) / (1 - def.peakAt));
  return { key: keyLerp(peakK, restK, u), ext: 1 - u };
}

/** Solve one arm chain from its shoulder anchor + joint angles. */
function solveArm(sx, sy, a1, a2) {
  const ex = sx + UPPER_LEN * Math.sin(a1);
  const ey = sy + UPPER_LEN * Math.cos(a1);
  const af = a1 + a2;                                  // absolute forearm angle
  return {
    sx, sy, ex, ey, a1, af,
    wx: ex + FORE_LEN * Math.sin(af),
    wy: ey + FORE_LEN * Math.cos(af),
  };
}

/**
 * Full-body pose solve. Shared by drawRig() and by getFistPos() on both
 * fighters, so flash effects spawn at the fist's ACTUAL animated position
 * rather than a fixed offset.
 *
 * @param {{type: string, arm: 'lead'|'rear', p: number}|null} punch  p = 0..1 progress
 * @param {number} guard  0..1 blend toward the raised-guard (block) pose
 * @returns {{ torsoShift, dip, turn, ext, punchingArm, lead, rear }}
 */
export function computePose(punch, guard = 0) {
  const def = punch && PUNCHES[punch.type] ? PUNCHES[punch.type] : null;
  const punchingArm = def ? punch.arm : null;

  let key = REST_KEY, ext = 0;
  if (def) ({ key, ext } = punchKey(def, clamp01(punch.p)));

  // The guard pose is square-on: rotation/dip fade out as the guard comes up.
  const g          = clamp01(guard);
  const turn       = key.turn * (1 - g);
  const dip        = key.dip  * (1 - g);
  const torsoShift = TORSO_SHIFT * turn;

  const leadSx = SHOULDER_X + torsoShift +
    (punchingArm === 'lead' ? LEAD_SHOULDER_DRIVE * turn : -LEAD_SHOULDER_PULL * turn);
  const rearSx = -SHOULDER_X + torsoShift +
    (punchingArm === 'rear' ? REAR_SHOULDER_DRIVE * turn : -REAR_SHOULDER_PULL * turn);

  // Non-punching arm retracts toward the chin as the body rotates, so the off
  // hand doesn't just hang there while the body torques.
  const offArm = { a1: -0.10 * turn, a2: -1.00 * turn };
  const leadA  = punchingArm === 'lead' ? key : offArm;
  const rearA  = punchingArm === 'rear' ? key : offArm;

  const blend = a => ({
    a1: lerp(a.a1, GUARD_ANGLES.a1, g),
    a2: lerp(a.a2, GUARD_ANGLES.a2, g),
  });
  const la = blend(leadA);
  const ra = blend(rearA);

  return {
    torsoShift, dip, turn, ext, punchingArm,
    lead: solveArm(leadSx, SHOULDER_Y + dip, la.a1, la.a2),
    rear: solveArm(rearSx, SHOULDER_Y + dip, ra.a1, ra.a2),
  };
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

/** Rectangle centered at (cx, cy). */
function cr(g, cx, cy, w, h) {
  g.fillRect(cx - w * 0.5, cy - h * 0.5, w, h);
}

/** Limb segment of length `len` starting at (x, y), rotated by `angle`
 *  (0 = straight down, positive = toward +x). */
function seg(g, x, y, angle, len, w) {
  g.save();
  g.translateCanvas(x, y);
  g.rotateCanvas(-angle);
  g.fillRect(-w * 0.5, 0, w, len);
  g.restore();
}

function drawArm(g, bodyColor, skinColor, arm, alpha) {
  g.fillStyle(bodyColor, alpha);
  seg(g, arm.sx, arm.sy, arm.a1, UPPER_LEN, UPPER_W);
  g.fillStyle(skinColor, alpha);
  seg(g, arm.ex, arm.ey, arm.af, FORE_LEN, FORE_W);
}

/**
 * @param {Phaser.GameObjects.Graphics} g
 * @param {number} bodyColor  Phaser integer color
 * @param {number} skinColor  Phaser integer color
 * @param {{type, arm, p}|null} punch  current punch state (null = idle)
 * @param {number} guard      0..1 blend toward the raised guard pose
 */
export function drawRig(g, bodyColor, skinColor, punch = null, guard = 0) {
  g.clear();

  const pose      = computePose(punch, guard);
  const shift     = pose.torsoShift;
  const dip       = pose.dip;
  const turn      = pose.turn;
  const rearIsPunching = pose.punchingArm === 'rear';

  // Hip rotation — thighs swing with the turn, shins stay planted so the feet
  // don't slide out from under the fighter.
  const leadHipX = HIP_X  + shift * 0.5 +
    (pose.punchingArm === 'lead' ? HIP_DRIVE * turn : -HIP_PULL * turn);
  const rearHipX = -HIP_X + shift * 0.5 +
    (rearIsPunching ? HIP_DRIVE * turn : -HIP_PULL * turn);

  // ── Rear side (behind — drawn first, dimmed for depth) ─────────────────────
  g.fillStyle(bodyColor, 0.55);
  cr(g, rearHipX,       5 + dip, 10, 26);   // rear thigh
  cr(g, -HIP_X,        29,        9, 22);   // rear shin (planted)

  // A punching rear arm is deferred: it swings ACROSS the front of the body, so
  // it has to be drawn on top of the torso, not behind it.
  if (!rearIsPunching) drawArm(g, bodyColor, skinColor, pose.rear, 0.55);

  // ── Torso ──────────────────────────────────────────────────────────────────
  // Widens with the turn: a rotating fighter presents more chest to the camera.
  // Together with the forward shift this is what makes a cross read as torqued
  // rather than as a jab from the other hand.
  const torsoW = 28 + 7 * turn;
  g.fillStyle(bodyColor, 1.0);
  cr(g, shift, -20 + dip, torsoW, 38);

  // Shorts stripe (visual anchor — makes the hip rotation readable)
  g.fillStyle(0xffffff, 0.22);
  cr(g, shift, -4 + dip, torsoW, 9);

  // ── Lead side (front — drawn on top) ───────────────────────────────────────
  g.fillStyle(bodyColor, 1.0);
  cr(g, leadHipX,  5 + dip, 10, 26);        // lead thigh
  cr(g, HIP_X,    29,        9, 22);        // lead shin (planted)

  drawArm(g, bodyColor, skinColor, pose.lead, 1.0);

  // Rear arm mid-cross: brightens as it extends so it reads as coming forward.
  if (rearIsPunching) drawArm(g, bodyColor, skinColor, pose.rear, 0.55 + 0.4 * pose.ext);

  // ── Head ───────────────────────────────────────────────────────────────────
  const headX = 1 + shift * 0.9;
  g.fillStyle(skinColor, 1.0);
  g.fillCircle(headX, -50 + dip, 13);
  g.fillStyle(skinColor, 0.80);
  g.fillCircle(headX - 7, -47 + dip, 5);    // ear (on the away side)
}

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
 * 'lead' and 'rear' here are GEOMETRIC SLOTS, not anatomical arms — the rig's
 * single horizontal axis is toward/away-from-opponent, so it has nowhere to put
 * a fixed left/right. Which anatomical arm occupies each slot is decided by the
 * fighter's STANCE (see leadArm/rearArm/armSlot below), which is a property of
 * the fighter and never changes with facing. Game logic talks in 'left'/'right'
 * and converts at this boundary; only the rig thinks in lead/rear.
 *
 * Arms are a two-segment jointed chain solved from angles, not fixed rects, so
 * each punch type can trace its own trajectory (see PUNCHES below):
 *   a1 = upper-arm angle at the shoulder, a2 = forearm angle at the elbow.
 *   Angle 0 = segment hanging straight down; positive = rotating toward +x.
 */

import { config, punchAimPointY } from './config.js';

// Visual extent of the rig from the container origin, derived from the layout
// below. Lives here (with the geometry it's derived from) so the player and the
// dummy clamp to the ropes identically — see movement.js. Deliberately measured
// from the IDLE pose: a punch reaches well past this, but clamping to the punch
// extent would shrink the usable ring and change movement feel.
// NOTE: the guard pose reaches further than this on the lead side (the lead
// fist sits ~38 px out), same as a punch does. The margin is deliberately NOT
// widened to match — it is a movement/feel constant, and growing it would
// shrink the usable ring. A glove overlapping the rope reads fine.
export const RIG_MARGIN_X      = 24;   // arms rest ~22 px left/right of origin
export const RIG_MARGIN_TOP    = 67;   // head top: -50 - 13 - 4 pad
export const RIG_MARGIN_BOTTOM = 44;   // shin bottom: 29 + 11 + 4 pad

// ── Stance ↔ anatomical arm identity ─────────────────────────────────────────
// Orthodox: left arm leads (jabs), right arm is rear (crosses the body).
// Southpaw: the mirror of that. Facing is NOT an input here on purpose — an
// orthodox fighter's jab is their left hand from either side of the ring; the
// container's scaleX mirror handles the rendered side on its own.
export function leadArm(stance) { return stance === 'southpaw' ? 'right' : 'left';  }
export function rearArm(stance) { return stance === 'southpaw' ? 'left'  : 'right'; }

/** Which rig slot ('lead' | 'rear') the given anatomical arm occupies. */
export function armSlot(stance, arm) {
  return arm === leadArm(stance) ? 'lead' : 'rear';
}

// ── Hit reaction (Stage 10) ──────────────────────────────────────────────────
// The rest value of the offsets reaction.js produces. Shared (and frozen) so
// the overwhelmingly common "nobody is currently reacting" case allocates
// nothing per frame, and so both modules agree on the shape of the object.
export const NO_REACT = Object.freeze({ headX: 0, headY: 0, torsoX: 0, torsoY: 0, tilt: 0 });

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

// Fraction of the gap between config.rearArmAlpha and solid that a punching rear
// arm closes at full extension. At the default 0.55 this reproduces the original
// hardcoded 0.55 → 0.95 brighten exactly.
const PUNCH_BRIGHTEN      = 0.89;

// ── Pose keyframes ───────────────────────────────────────────────────────────
/**
 * The BLOCK — both gloves folded up in front of the face.
 *
 * Per-slot, for the same reason the guard is (see LEAD_GUARD/REAR_GUARD): the
 * two shoulders sit 34 px apart on the toward/away axis, so ONE shared absolute
 * angle pair cannot put both gloves at the chin — it just translates the same
 * arm shape 34 px backwards for the rear slot. That is what this used to do,
 * and it parked the rear elbow/glove at x = -20/-25 while the lead reached only
 * to +14, so the rig's limb mass sat BEHIND the torso. Since facing is expressed
 * purely by the scaleX mirror, a silhouette whose limbs stick out the away side
 * reads as a fighter pointing the wrong way — the block appeared to spin the
 * fighter around even though facing itself was (and is) computed correctly.
 *
 *   lead: elbow forward at the shoulder line, forearm up and slightly back —
 *         glove at (+13, -40), covering the front edge of the head
 *   rear: elbow swung IN to the ribs (not left trailing at the shoulder),
 *         forearm up and forward — glove at (+1, -41), covering the face center
 *
 * Both gloves therefore sit at or ahead of center with the lead one further
 * forward, so the block keeps the same forward-reading asymmetry as the guard.
 */
const LEAD_BLOCK = { a1: 0.10, a2: -2.872 };   // elbow (+19, -23) → glove (+13, -40)
const REAR_BLOCK = { a1: 0.45, a2:  2.181 };   // elbow  (-7, -25) → glove  (+1, -41)

const slotBlock = slot => (slot === 'lead' ? LEAD_BLOCK : REAR_BLOCK);

/**
 * The GUARD — the pose both fighters hold whenever they aren't punching. It is
 * the rest pose punches start from and return to, replacing the old
 * arms-hanging-at-the-waist rest.
 *
 *   lead: elbow low and slightly forward, forearm angled UP AND FORWARD at
 *         ~38° — the fist sits ~40 px in front of center (the jabbing hand)
 *   rear: elbow tucked by the ribs, forearm straight UP — the fist sits by the
 *         chin, ~20 px behind center and higher than the lead fist (power hand)
 *
 * The asymmetry is load-bearing, not decoration. Facing is expressed ONLY by
 * the container's scaleX mirror, so a left/right-symmetric rig mirrors into an
 * identical silhouette and a fighter's facing becomes unreadable. A lead hand
 * reaching well past the torso on one side, against a compact vertical column
 * on the other, is what makes "which way is this fighter pointing" legible at a
 * glance — deliberately over-extended rather than anatomically cautious.
 *
 * Which anatomical arm holds which of these is the fighter's stance (see
 * armSlot() above), so the whole pose mirrors for a southpaw for free.
 */
const LEAD_GUARD = { a1: 0.69, a2:  1.47 };   // elbow (+31, -28) → fist (+46, -38)
const REAR_GUARD = { a1: 0.15, a2: -3.10 };   // elbow (-14, -23) → fist (-17, -41)

const slotGuard = slot => (slot === 'lead' ? LEAD_GUARD : REAR_GUARD);
const restKey   = slot => ({ ...slotGuard(slot), dip: 0, turn: 0 });

/**
 * Per-punch trajectory table. Each punch runs rest → cock → peak → rest across
 * its animation progress p (0..1):
 *   cockEnd — p at which the wind-up pose is reached
 *   peakAt  — p at which full extension is reached
 *   turn    — hip/shoulder rotation at peak (0 = square on, 1 = full torque)
 *   dip     — px the body drops during the wind-up (leg drive for the uppercut)
 *
 * The wind-up comes in two flavours, and which one a punch uses is a real
 * distinction, not a style choice:
 *   cock    — an ABSOLUTE pose. For the punches that genuinely wind up somewhere
 *             specific (hook coils across the body, uppercut drops to the hip).
 *   cockRel — a wind-back RELATIVE to wherever the guard is. The straight
 *             punches have no real wind-up: they fire from the guard, and their
 *             numbers were only ever a small nudge off the rest pose.
 * Straight punches must be relative, because rest is now the guard rather than
 * arms-at-the-waist: held absolute, their old values would drop the hand to the
 * hip for the one frame the wind-up lasts before the arm shot out.
 *
 * These are pose/animation shape, not gameplay tunables — damage and speed live
 * in config.js. Timings are fractions of the punch's duration, so they stay
 * proportional when a punch's speed multiplier or low stamina stretches it.
 */
const PUNCHES = {
  // Straight, minimal rotation, snaps back fast.
  jab: {
    cockRel: { a1: -0.15, a2: -0.30 },
    peak:    { a1:  1.50, a2:  0.05 },
    cockEnd: 0.12, peakAt: 0.42, turn: 0.15, dip: 0,
  },
  // Straight, but the rear shoulder/hip rotate all the way through — longest reach.
  cross: {
    cockRel: { a1: -0.35, a2: -0.55 },
    peak:    { a1:  1.48, a2:  0.10 },
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
  uppercut: {
    cock: { a1:  0.65, a2: -1.60 },
    peak: { a1:  0.79, a2: -4.38 },
    cockEnd: 0.26, peakAt: 0.60, turn: 0.70, dip: 6,
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
 *
 * Rest is the throwing slot's GUARD pose, so a punch winds up out of the guard
 * and settles back into it. The trajectory itself (cock/peak/timings) is
 * untouched — only the endpoints moved off the old arms-down rest.
 *
 * @param {'lead'|'rear'} slot  which guard the arm returns to
 */
function punchKey(def, p, slot) {
  const rest = restKey(slot);
  // Absolute wind-up pose, or a wind-back relative to the guard — see PUNCHES.
  const cockA = def.cockRel
    ? { a1: rest.a1 + def.cockRel.a1, a2: rest.a2 + def.cockRel.a2 }
    : def.cock;
  const cockK = { a1: cockA.a1,    a2: cockA.a2,    dip:  def.dip,        turn: def.turn * 0.2 };
  const peakK = { a1: def.peak.a1, a2: def.peak.a2, dip: -def.dip * 0.4,  turn: def.turn };

  if (p < def.cockEnd) {
    const u = easeOut(p / def.cockEnd);
    return { key: keyLerp(rest, cockK, u), ext: 0 };
  }
  if (p < def.peakAt) {
    const u = easeOut((p - def.cockEnd) / (def.peakAt - def.cockEnd));
    return { key: keyLerp(cockK, peakK, u), ext: u };
  }
  // Recovery unwinds by the SHORT way round: a2 is an angle, so the guard's
  // value has infinitely many equivalents 2π apart and the nearest one to the
  // peak is the one that doesn't rewind the forearm back through the strike.
  // (This replaces the uppercut's old hand-written recoverA2: -2π — that punch
  // ends at a2 = -4.38, and the lead guard's +1.75 resolves to -4.53 here, so
  // the forearm still finishes its rotation the way it was already going.)
  const restK = { ...rest, a2: nearestAngle(rest.a2, def.peak.a2) };
  const u = easeIO((p - def.peakAt) / (1 - def.peakAt));
  return { key: keyLerp(peakK, restK, u), ext: 1 - u };
}

/** The representative of `angle` (mod 2π) closest to `to`. */
function nearestAngle(angle, to) {
  let a = angle;
  while (a - to >  Math.PI) a -= Math.PI * 2;
  while (a - to < -Math.PI) a += Math.PI * 2;
  return a;
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
 * @param {{type: string, arm: 'lead'|'rear', p: number, aim?: number}|null} punch
 *                        p = 0..1 progress; aim = the locked aim-cone bend in
 *                        radians (see aimAngle below), positive = downward in
 *                        rig-local space. Optional — absent/0 is the pre-Stage-13
 *                        behaviour exactly.
 * @param {number} guard  0..1 blend toward the raised BLOCK pose
 * @param {number} bob    px of movement bounce (see stepBob in movement.js);
 *                        folded into `dip`, so it rides the torso/head/thighs
 *                        while the shins stay planted
 * @param {{headX,headY,torsoX,torsoY,tilt}} react  hit-reaction offsets in this
 *                        same local space (see reaction.js). The torso part
 *                        moves the SHOULDERS here, so the arms travel with the
 *                        body rather than detaching from it; the head part is
 *                        applied on top of it by drawRig/hurtboxes.
 * @returns {{ torsoShift, dip, turn, ext, punchingArm, lead, rear, react }}
 */
export function computePose(punch, guard = 0, bob = 0, react = NO_REACT) {
  const def = punch && PUNCHES[punch.type] ? PUNCHES[punch.type] : null;
  const punchingArm = def ? punch.arm : null;

  let key = { a1: 0, a2: 0, dip: 0, turn: 0 }, ext = 0;
  if (def) ({ key, ext } = punchKey(def, clamp01(punch.p), punchingArm));

  // The block pose is square-on: rotation/dip fade out as the guard comes up.
  const g          = clamp01(guard);
  const turn       = key.turn * (1 - g);
  const dip        = key.dip  * (1 - g) + bob;
  const torsoShift = TORSO_SHIFT * turn;

  const rk = react || NO_REACT;
  const leadSx = SHOULDER_X + torsoShift + rk.torsoX +
    (punchingArm === 'lead' ? LEAD_SHOULDER_DRIVE * turn : -LEAD_SHOULDER_PULL * turn);
  const rearSx = -SHOULDER_X + torsoShift + rk.torsoX +
    (punchingArm === 'rear' ? REAR_SHOULDER_DRIVE * turn : -REAR_SHOULDER_PULL * turn);
  const shoulderY = SHOULDER_Y + dip + rk.torsoY;

  // ── Aim-cone bend (Stage 13) ───────────────────────────────────────────────
  // A rigid rotation of the THROWING arm chain about its own shoulder: a2 is
  // measured relative to a1, so subtracting the bend from a1 alone swings the
  // upper arm and forearm together without changing the arm's shape. Two
  // properties fall out of that, and both are load-bearing:
  //   - the shoulder does not move, so the torso/hips/head/legs are untouched
  //     and the punch still reads as itself;
  //   - the wrist's distance FROM the shoulder is unchanged, so total extension
  //     along the bent path is constant at any angle. Reach is therefore not
  //     quietly shortened by bending (a horizontally-measured reach would lose
  //     ~13% at 30°, and a max-range punch would start whiffing once bent).
  // Positive bend = rotate downward: a1 = 0 hangs straight down and increases
  // toward +x, so past horizontal a larger a1 points further UP.
  //
  // Scaled by `ext`, which is already 0 for the whole wind-up, ramps to 1 at
  // peak extension and falls back to 0 on the recovery — so the arm leaves the
  // guard straight, bends onto the target as it reaches, and unwinds straight.
  const bend = def
    ? (punch.aim || 0) * Math.pow(ext, Math.max(0.1, config.aimBendRamp))
    : 0;
  const bentKey = bend ? { a1: key.a1 - bend, a2: key.a2 } : key;

  // The non-punching arm simply holds its guard — it no longer needs a
  // turn-driven retraction, because the guard IS hands-up now; the shoulder
  // pull above already carries the body torque.
  const leadA = punchingArm === 'lead' ? bentKey : LEAD_GUARD;
  const rearA = punchingArm === 'rear' ? bentKey : REAR_GUARD;

  const blend = (a, slot) => {
    const B = slotBlock(slot);
    return {
      a1: lerp(a.a1, B.a1, g),
      a2: lerp(a.a2, nearestAngle(B.a2, a.a2), g),
    };
  };
  const la = blend(leadA, 'lead');
  const ra = blend(rearA, 'rear');

  return {
    torsoShift, dip, turn, ext, bend, punchingArm, react: rk,
    lead: solveArm(leadSx, shoulderY, la.a1, la.a2),
    rear: solveArm(rearSx, shoulderY, ra.a1, ra.a2),
  };
}

// ── Aim cone (Stage 13) ──────────────────────────────────────────────────────

/**
 * The unbent peak-extension geometry of one punch, in rig-local space: where
 * its shoulder sits, how far the fist reaches from that shoulder, and along
 * what angle. Shared by the aim solve, the debug overlay and the tests so all
 * three read the punch's real trajectory instead of re-deriving it.
 *
 * @param {string} type            punch type
 * @param {'lead'|'rear'} slot     which rig slot throws it
 */
export function punchGeometry(type, slot) {
  const def = PUNCHES[type];
  if (!def) return null;
  const pose = computePose({ type, arm: slot, p: def.peakAt }, 0, 0);
  const arm  = slot === 'lead' ? pose.lead : pose.rear;
  return {
    sx: arm.sx, sy: arm.sy,
    fx: arm.wx, fy: arm.wy,
    reach: Math.hypot(arm.wx - arm.sx, arm.wy - arm.sy),
    angle: Math.atan2(arm.wy - arm.sy, arm.wx - arm.sx),
  };
}

/** The cone's half-angle in radians (config stores it in degrees). */
export function maxAimAngleRad() {
  return Math.abs(config.maxAimAngle) * Math.PI / 180;
}

/**
 * How far to bend this punch toward an opponent who is off the facing axis.
 * Sampled ONCE, on the frame the input is registered, and then locked for the
 * punch's duration — a punch that keeps re-aiming is a homing missile, it
 * contradicts the momentum-commitment philosophy, and it would make a slip
 * cosmetic (the punch would simply follow the head down).
 *
 * Measured relative to the LEVEL case rather than absolutely: the returned
 * angle is the difference between the direction from this punch's shoulder to
 * the aim point, and the direction to that same aim point with the opponent's
 * vertical offset removed. Two consequences worth stating, because both are the
 * reason it is written this way:
 *   - at dy = 0 the result is exactly 0 for every punch type, so nothing about
 *     a level exchange changes;
 *   - the per-type aim point (head vs body) is what sets how steeply the
 *     correction grows with offset, rather than pointing the punch somewhere
 *     new on the frame it is thrown.
 *
 * Everything is in RIG-LOCAL space — dxLocal is already mirrored by the
 * caller's facing, y never is — so the cone is measured off the facing axis and
 * behaves identically from either side of the ring.
 *
 * @param {string} type            punch type
 * @param {'lead'|'rear'} slot     which rig slot throws it
 * @param {number} dxLocal         opponent's horizontal offset, +ve = in front
 * @param {number} dy              opponent's vertical offset, +ve = below
 * @returns {number} radians, clamped to ±maxAimAngle; positive = aim downward
 */
export function aimAngle(type, slot, dxLocal, dy) {
  const geo = punchGeometry(type, slot);
  if (!geo) return 0;

  // Aim-point height relative to the throwing shoulder, and the horizontal run
  // out to it. The run is floored (config.aimMinRun) so an opponent stacked on
  // top of us, or directly above/below, produces a large-but-finite angle that
  // the clamp below absorbs — rather than a division blow-up or a sign flip
  // once the target passes behind the shoulder.
  const k   = punchAimPointY(type) - geo.sy;
  const run = Math.max(config.aimMinRun, dxLocal - geo.sx);

  const a = Math.atan2(dy + k, run) - Math.atan2(k, run);
  if (!Number.isFinite(a)) return 0;

  const max = maxAimAngleRad();
  return a > max ? max : a < -max ? -max : a;
}

// ── Hurtboxes (Stage 9) ──────────────────────────────────────────────────────
/**
 * The defender's vulnerable regions, in the SAME local space as the pose — i.e.
 * hung off the rig's actual head and torso rather than being a second, parallel
 * body model. They therefore inherit the pose's dip (bob, uppercut crouch) and
 * torso shift (a fighter torqued into a cross presents their head further
 * forward), so a moving target's hurtboxes move with it.
 *
 * Sizes/offsets come from config so they're live-tunable — see the Hurtboxes
 * folder in the tuning panel. Caller maps to world space (and applies the facing
 * mirror to x) — see getHurtboxes() on Fighter/Dummy.
 *
 * @param {ReturnType<typeof computePose>} pose
 */
export function hurtboxes(pose) {
  // Stage 10: the hit-reaction offsets are included, so a head that has just
  // been snapped back is genuinely where the drawn head is. Keeping them out
  // would put the boxes back where Stage 9 spent its effort getting them off —
  // a punch that visually misses a rocked head has to actually miss. (The
  // reaction's `tilt` is deliberately NOT applied: it's a small cosmetic lean,
  // and rotating the boxes would mean an oriented-box test for a few degrees.)
  const rk = pose.react || NO_REACT;
  return {
    // Matches the head circle drawn in drawRig(): local (1 + shift*0.9, -50+dip).
    head: {
      x: 1 + pose.torsoShift * 0.9 + rk.torsoX + rk.headX,
      y: config.headHurtboxOffsetY + pose.dip + rk.torsoY + rk.headY,
      r: config.headHurtboxRadius,
    },
    // Matches the torso rect: centered at (shift, -20+dip). Width is held fixed
    // rather than tracking the turn-driven torsoW, so rotating into a punch
    // doesn't silently widen your own hurtbox.
    body: {
      x: pose.torsoShift + rk.torsoX,
      y: config.bodyHurtboxOffsetY + pose.dip + rk.torsoY,
      hw: config.bodyHurtboxWidth  / 2,
      hh: config.bodyHurtboxHeight / 2,
    },
  };
}

/** Circle (x, y, r) vs circle {x, y, r}. */
export function circleHitsCircle(x, y, r, c) {
  return Math.hypot(x - c.x, y - c.y) <= r + c.r;
}

/** Circle (x, y, r) vs axis-aligned box {x, y, hw, hh} — nearest-point test. */
export function circleHitsBox(x, y, r, b) {
  const nx = Math.min(Math.max(x, b.x - b.hw), b.x + b.hw);
  const ny = Math.min(Math.max(y, b.y - b.hh), b.y + b.hh);
  return Math.hypot(x - nx, y - ny) <= r;
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
 * @param {number} guard      0..1 blend toward the raised block pose
 * @param {number} bob        px of movement bounce (0 when standing still)
 * @param {{headX,headY,torsoX,torsoY,tilt}} react  hit-reaction offsets (Stage 10)
 */
export function drawRig(g, bodyColor, skinColor, punch = null, guard = 0, bob = 0, react = NO_REACT) {
  g.clear();

  const pose      = computePose(punch, guard, bob, react);
  const shift     = pose.torsoShift;
  const dip       = pose.dip;
  const turn      = pose.turn;
  const rearIsPunching = pose.punchingArm === 'rear';

  // Hit reaction (Stage 10). The torso offset carries the torso, shorts and —
  // via computePose above — the shoulders. The hips take a fraction of it and
  // the shins none at all, so the fighter is rocked back on their feet rather
  // than sliding as a rigid block. The vertical drag is higher than the
  // horizontal one because a torso lifted off stationary hips (the uppercut)
  // opens a visible gap, whereas a torso slid sideways over them doesn't.
  const rk        = pose.react;
  const hipDragX  = 0.35;
  const hipDragY  = 0.65;

  // The tilt is applied around the WAIST and only to the upper body — never as
  // a rotation of the whole graphics object. Rotating everything swung the feet
  // out from under the fighter, which is exactly what the planted shins below
  // exist to prevent; it read as toppling over rather than as being rocked.
  // Positive tilt leans the upper body AWAY from the opponent (-x), matching
  // `back` and `lift`: every positive shape value in config pushes the defender
  // away from the punch.
  const TILT_PIVOT_Y = -2;   // where the torso meets the hips
  const tilted = fn => {
    if (!rk.tilt) { fn(); return; }
    g.save();
    g.translateCanvas(0, TILT_PIVOT_Y);
    g.rotateCanvas(-rk.tilt);
    g.translateCanvas(0, -TILT_PIVOT_Y);
    fn();
    g.restore();
  };

  // Hip rotation — thighs swing with the turn, shins stay planted so the feet
  // don't slide out from under the fighter.
  const leadHipX = HIP_X  + shift * 0.5 + rk.torsoX * hipDragX +
    (pose.punchingArm === 'lead' ? HIP_DRIVE * turn : -HIP_PULL * turn);
  const rearHipX = -HIP_X + shift * 0.5 + rk.torsoX * hipDragX +
    (rearIsPunching ? HIP_DRIVE * turn : -HIP_PULL * turn);
  const hipY     = rk.torsoY * hipDragY;

  // ── Rear side (behind — drawn first, dimmed for depth) ─────────────────────
  // One shared alpha for every rear-side limb (see config.rearArmAlpha) so the
  // depth cue stays consistent when it's dialed — an arm at 1.0 next to a thigh
  // still stuck at 0.55 reads as a bug, not as depth.
  const rearAlpha = config.rearArmAlpha;
  g.fillStyle(bodyColor, rearAlpha);
  cr(g, rearHipX,       5 + dip + hipY, 10, 26);   // rear thigh
  cr(g, -HIP_X,        29,              9, 22);    // rear shin (planted)

  // A punching rear arm is deferred: it swings ACROSS the front of the body, so
  // it has to be drawn on top of the torso, not behind it.
  // Everything from here that belongs to the UPPER body goes inside tilted() —
  // in three groups rather than one, because the legs are drawn interleaved
  // between them and the draw order is what produces the depth layering.
  if (!rearIsPunching) tilted(() => drawArm(g, bodyColor, skinColor, pose.rear, rearAlpha));

  // ── Torso ──────────────────────────────────────────────────────────────────
  // Widens with the turn: a rotating fighter presents more chest to the camera.
  // Together with the forward shift this is what makes a cross read as torqued
  // rather than as a jab from the other hand.
  const torsoW = 28 + 7 * turn;
  tilted(() => {
    g.fillStyle(bodyColor, 1.0);
    cr(g, shift + rk.torsoX, -20 + dip + rk.torsoY, torsoW, 38);

    // Shorts stripe (visual anchor — makes the hip rotation readable)
    g.fillStyle(0xffffff, 0.22);
    cr(g, shift + rk.torsoX, -4 + dip + rk.torsoY, torsoW, 9);
  });

  // ── Lead side (front — drawn on top) ───────────────────────────────────────
  g.fillStyle(bodyColor, 1.0);
  cr(g, leadHipX,  5 + dip + hipY, 10, 26);   // lead thigh
  cr(g, HIP_X,    29,               9, 22);   // lead shin (planted)

  tilted(() => {
    drawArm(g, bodyColor, skinColor, pose.lead, 1.0);

    // Rear arm mid-cross: brightens as it extends so it reads as coming forward.
    // Starts from the same tunable rear alpha and closes the remaining gap to
    // fully solid, so the punch always ends at full opacity whatever the slider.
    if (rearIsPunching) {
      drawArm(g, bodyColor, skinColor, pose.rear, rearAlpha + (1 - rearAlpha) * PUNCH_BRIGHTEN * pose.ext);
    }

    // ── Head ─────────────────────────────────────────────────────────────────
    // The head carries the torso's displacement PLUS its own, so a jab (torso
    // bleed ~0) snaps only the head while a cross moves the whole upper body.
    const headX = 1 + shift * 0.9 + rk.torsoX + rk.headX;
    const headY = -50 + dip + rk.torsoY + rk.headY;
    g.fillStyle(skinColor, 1.0);
    g.fillCircle(headX, headY, 13);
    g.fillStyle(skinColor, 0.80);
    g.fillCircle(headX - 7, headY + 3, 5);    // ear (on the away side)
  });
}

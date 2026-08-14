/**
 * config.js — the single gym config object.
 *
 * Same rule as the main project: nothing tunable is written at a call site. Every
 * number here is generated into a lil-gui control by gui.js, so the whole file is
 * a live control surface.
 *
 * ── SPACE ──────────────────────────────────────────────────────────────────────
 * Units are metres. The fighter is ~1.85 m tall.
 *
 *   +Y  up
 *   +Z  TOWARD THE OPPONENT   <- the depth axis the 2D rig does not have
 *   +X  the fighter's own LEFT (so an orthodox lead side is +X)
 *
 * Sign conventions that fall out of that, written down because every amp below
 * depends on them:
 *
 *   rotation.y < 0   swings +X toward +Z   -> blades an orthodox stance
 *   rotation.x > 0   tips  +Y toward +Z    -> torso leans forward
 *   rotation.x > 0   on a limb hanging down -Y swings its far end BACKWARD (-Z),
 *                    so a limb reaching forward wants a NEGATIVE rotation.x
 *   rotation.z > 0   on a limb hanging down -Y swings its far end toward +X
 *
 * ── CHANNELS ───────────────────────────────────────────────────────────────────
 * A channel is one scalar track on one joint property, addressed by path string
 * ('chest.rotation.y'). Every channel owns its own start time, peak time, easing
 * curve, anticipation, overshoot and recovery length. That per-joint independence
 * IS the experiment; the 2D rig gives every joint one shared timeline.
 *
 *   t0    ms  channel starts moving (anticipation runs from 0 to t0)
 *   t1    ms  channel reaches peak
 *   amp       peak value, added on top of the rest pose (radians or metres)
 *   ease      curve name from ease.js, used t0 -> t1
 *   ant       anticipation as a fraction of amp, in the opposite direction
 *   over      overshoot past rest on the way back, as a fraction of amp
 *   rec   ms  recovery length, measured from the end of the contact hold
 *
 * EVERY NUMBER IN THE punches/slip/dummy BLOCKS IS A FIRST-PASS GUESS, authored
 * by eye against the sign conventions above and then adjusted from screenshots.
 * None of it is ported from src/rig.js.
 */

// A channel literal. Defaults keep the tables readable; anything omitted is a
// channel that does not anticipate, does not overshoot and recovers in 200 ms.
const ch = (path, amp, t0, t1, ease = 'easeOutCubic', ant = 0, over = 0, rec = 200) =>
  ({ path, amp, t0, t1, ease, ant, over, rec });

export const config = {

  // ── Proportions ─────────────────────────────────────────────────────────────
  // Exaggerated, not anatomical: wide shoulders, narrow waist, oversized gloves,
  // slightly small head. Changing anything here rebuilds the rig.
  body: {
    hipY:           0.98,   // pelvis pivot height off the mat
    spineY:         0.14,   // spine pivot, local to pelvis
    chestY:         0.20,   // chest pivot, local to spine
    shoulderY:      0.16,   // clavicle pivot height, local to chest
    shoulderX:      0.215,  // half shoulder width
    neckY:          0.25,   // neck pivot height, local to chest
    neckLen:        0.11,
    neckR:          0.055,
    headR:          0.113,

    chestW:         0.42, chestH: 0.30, chestD: 0.26,
    waistW:         0.24, waistH: 0.24, waistD: 0.18,

    upperArmLen:    0.30, upperArmR: 0.058,
    forearmLen:     0.28, forearmR:  0.052,
    gloveR:         0.088,

    hipX:           0.105,  // half hip width
    thighLen:       0.48, thighR: 0.082,
    shinLen:        0.44, shinR:  0.060,
    footLen:        0.26, footW:  0.105, footH: 0.055,
  },

  // ── Rest pose: the bladed orthodox stance ───────────────────────────────────
  // Additive over the bind pose (bind = everything at zero, limbs hanging).
  // Lead = LEFT (+X side). These are the numbers that make it read as boxing
  // before a single frame of animation runs.
  rest: {
    'pelvis.rotation.y':   -0.55,   // hips bladed, left hip forward
    'pelvis.rotation.x':    0.04,
    'pelvis.position.y':   -0.045,  // sunk into the knees

    'spine.rotation.x':     0.05,
    'spine.rotation.y':    -0.06,

    'chest.rotation.y':    -0.22,   // shoulders slightly more bladed than the hips
    'chest.rotation.x':     0.12,   // shoulders over the front knee
    'chest.rotation.z':     0.00,

    'neck.rotation.x':     -0.14,   // chin tucked back down onto the chest
    'neck.rotation.y':      0.20,   // head stays squarer to the opponent than the chest
    'head.rotation.x':     -0.02,

    // Both arms below were SOLVED, not guessed: coordinate descent on these ten
    // angles against world-space targets for each glove and each elbow (lead
    // hand out front, rear glove on the cheek and behind the head on the depth
    // axis, both elbows low and tucked). Picking radians by eye is exactly the
    // authoring problem a hierarchy plus a world-space probe removes.
    'upperArmL.rotation.x': -0.886,
    'upperArmL.rotation.y':  0.231,
    'upperArmL.rotation.z':  0.522,
    'forearmL.rotation.x':  -2.150,
    'forearmL.rotation.y':   0.100,

    'upperArmR.rotation.x': -1.137,
    'upperArmR.rotation.y':  0.575,
    'upperArmR.rotation.z':  0.776,
    'forearmR.rotation.x':  -2.555,
    'forearmR.rotation.y':  -0.300,

    // Lead (left) leg: forward along the depth axis, toe turned in with the blade.
    'thighL.rotation.x':   -0.26,
    'thighL.rotation.y':   -0.30,
    'thighL.rotation.z':    0.05,
    'shinL.rotation.x':     0.34,
    'footL.rotation.x':    -0.06,
    'footL.rotation.y':    -0.34,

    // Rear (right) leg: back, knee turned in, heel off the mat.
    'thighR.rotation.x':    0.24,
    'thighR.rotation.y':   -0.52,
    'thighR.rotation.z':   -0.06,
    'shinR.rotation.x':     0.26,
    'footR.rotation.x':    -0.26,   // heel up
    'footR.rotation.y':    -0.70,   // toe out
  },

  // ── Punches ─────────────────────────────────────────────────────────────────
  // Each punch is a kinetic chain: the ground end starts first and the glove
  // arrives last. Read the t0 column down a punch and it should ascend.
  punches: {

    jab: {
      arm: 'L',           // lead hand — which glove carries the impulse
      hold: 25,           // ms held at full extension before recovery starts
      channels: [
        // ground -> hips
        ch('footR.rotation.x',      -0.10,   0,  60, 'easeOutQuad',  0.00, 0.20, 130),
        ch('pelvis.rotation.y',     -0.13,  10,  78, 'easeOutCubic', 0.10, 0.25, 145),
        ch('pelvis.position.z',      0.035, 10,  82, 'easeOutCubic', 0.15, 0.30, 150),
        // hips -> chest
        ch('chest.rotation.y',      -0.28,  32, 102, 'easeOutCubic', 0.12, 0.30, 150),
        ch('chest.rotation.x',       0.06,  36, 106, 'easeOutQuad',  0.20, 0.30, 150),
        // chest -> shoulder. The clavicle TRANSLATES, which carries the elbow
        // forward through space instead of pivoting it on a pin.
        ch('clavicleL.position.z',   0.055, 46, 122, 'easeOutQuart', 0.15, 0.35, 150),
        ch('upperArmL.rotation.x',  -0.849, 52, 132, 'easeOutQuad',  0.10, 0.25, 155),
        ch('upperArmL.rotation.z',   0.296, 52, 132, 'easeOutQuad',  0.10, 0.20, 155),
        // shoulder -> elbow, last link in the chain
        ch('forearmL.rotation.x',    1.648, 78, 152, 'easeOutQuart', 0.06, 0.22, 165),
        ch('forearmL.rotation.y',   -0.450, 86, 150, 'easeOutQuad',  0.00, 0.15, 165),
        // off hand tightens rather than mirroring — never twin the limbs
        ch('forearmR.rotation.x',   -0.12,  62, 142, 'easeOutQuad',  0.00, 0.10, 175),
        ch('upperArmR.rotation.z',   0.07,  62, 142, 'easeOutQuad',  0.00, 0.10, 175),
        ch('neck.rotation.y',       -0.07,  42, 122, 'easeOutQuad',  0.05, 0.15, 160),
      ],
    },

    cross: {
      arm: 'R',
      hold: 35,
      channels: [
        // the rear foot screws into the mat first — this is where a cross starts
        ch('footR.rotation.y',       0.80,   0, 112, 'easeOutCubic', 0.08, 0.20, 205),
        ch('footR.rotation.x',      -0.28,   0, 112, 'easeOutQuad',  0.05, 0.20, 205),
        ch('thighR.rotation.y',      0.46,   6, 122, 'easeOutCubic', 0.10, 0.20, 215),
        // hips
        ch('pelvis.rotation.y',      0.62,  22, 142, 'easeOutCubic', 0.15, 0.25, 225),
        ch('pelvis.position.z',      0.095, 22, 152, 'easeOutCubic', 0.25, 0.30, 240),
        ch('pelvis.position.x',     -0.030, 22, 152, 'easeOutCubic', 0.20, 0.25, 240),
        ch('pelvis.position.y',     -0.025, 16, 132, 'easeOutQuad',  0.30, 0.30, 235),
        // THE ROOT TRANSLATES. Weight going onto the front foot is displacement,
        // not a pose change, and nothing in the 2D game moves during a punch.
        ch('root.position.z',        0.055, 26, 162, 'easeOutCubic', 0.30, 0.15, 265),
        // chest lags the hips by ~35 ms — that gap is the whole point
        ch('chest.rotation.y',       0.78,  56, 176, 'easeOutCubic', 0.15, 0.30, 235),
        ch('chest.rotation.x',       0.10,  60, 180, 'easeOutQuad',  0.20, 0.25, 235),
        // shoulder
        ch('clavicleR.position.z',   0.075, 86, 202, 'easeOutQuart', 0.20, 0.35, 225),
        ch('upperArmR.rotation.x',  -0.543, 92, 206, 'easeOutQuad',  0.12, 0.25, 225),
        ch('upperArmR.rotation.z',  -0.179, 92, 206, 'easeOutQuad',  0.10, 0.20, 225),
        ch('upperArmR.rotation.y',  -0.644, 92, 206, 'easeOutQuad',  0.10, 0.20, 225),
        // elbow last
        ch('forearmR.rotation.x',    2.497,126, 232, 'easeOutQuart', 0.05, 0.25, 235),
        ch('forearmR.rotation.y',    0.620,136, 230, 'easeOutQuad',  0.00, 0.15, 235),
        // lead hand comes back to the cheek
        ch('upperArmL.rotation.x',   0.26,  72, 192, 'easeOutQuad',  0.00, 0.15, 245),
        ch('forearmL.rotation.x',   -0.34,  72, 192, 'easeOutQuad',  0.00, 0.15, 245),
        ch('neck.rotation.y',        0.10,  66, 176, 'easeOutQuad',  0.05, 0.15, 240),
      ],
    },

    hook: {
      arm: 'L',
      hold: 40,
      channels: [
        // real wind-up: the ant column is doing visible work on this punch
        ch('footL.rotation.y',      -0.58,   0, 132, 'easeOutCubic', 0.15, 0.20, 235),
        ch('footL.rotation.x',      -0.12,   0, 132, 'easeOutQuad',  0.10, 0.20, 235),
        ch('thighL.rotation.y',     -0.34,   8, 140, 'easeOutCubic', 0.20, 0.20, 240),
        // The rest stance is ALREADY 48 degrees of shoulder blade. A lead hook
        // finishes around 85, so the torso only has ~37 degrees left to give —
        // the first pass asked for 90 more and turned the fighter backwards.
        ch('pelvis.rotation.y',     -0.38,  26, 158, 'easeOutCubic', 0.35, 0.30, 250),
        ch('pelvis.position.x',      0.030, 26, 158, 'easeOutCubic', 0.35, 0.25, 250),
        ch('pelvis.position.z',      0.020, 26, 158, 'easeOutCubic', 0.30, 0.25, 250),
        ch('pelvis.position.y',     -0.020, 20, 148, 'easeOutQuad',  0.35, 0.25, 250),
        ch('chest.rotation.y',      -0.26,  66, 196, 'easeOutCubic', 0.35, 0.35, 260),
        ch('chest.rotation.z',      -0.10,  70, 196, 'easeOutQuad',  0.25, 0.25, 260),
        ch('chest.rotation.x',       0.05,  70, 196, 'easeOutQuad',  0.20, 0.25, 260),
        // the elbow is carried, not swung. clavicle translation + shoulder
        // abduction move the elbow bodily through the arc; the forearm only
        // opens ~35 degrees the whole way.
        ch('clavicleL.position.z',   0.045, 82, 200, 'easeOutQuart', 0.25, 0.30, 250),
        ch('clavicleL.position.x',  -0.025, 82, 200, 'easeOutQuart', 0.25, 0.30, 250),
        ch('upperArmL.rotation.x',   0.010, 84, 202, 'easeOutQuad',  0.25, 0.25, 250),
        ch('upperArmL.rotation.z',   0.877, 84, 198, 'easeOutQuad',  0.30, 0.25, 250),
        ch('upperArmL.rotation.y',  -0.320, 98, 216, 'easeOutCubic', 0.30, 0.30, 250),
        ch('forearmL.rotation.x',    0.746,112, 222, 'easeOutQuad',  0.15, 0.25, 250),
        ch('forearmL.rotation.y',   -0.300,112, 222, 'easeOutQuad',  0.10, 0.15, 250),
        // rear hand stays home
        ch('upperArmR.rotation.z',  -0.10,  70, 190, 'easeOutQuad',  0.00, 0.10, 255),
        ch('forearmR.rotation.x',   -0.14,  70, 190, 'easeOutQuad',  0.00, 0.10, 255),
        ch('neck.rotation.y',       -0.12,  76, 196, 'easeOutQuad',  0.10, 0.15, 255),
      ],
    },
  },

  // ── Slip ────────────────────────────────────────────────────────────────────
  // Spine articulation over a planted base. The legs hang off the ROOT, not off
  // the pelvis, so bending pelvis/spine/chest physically cannot move the feet —
  // the "plank tipping over" failure is structurally impossible here.
  //
  // Held while the key is down: a fast spring to 1, a slower release with
  // overshoot. Amps are the pose at full slip.
  slip: {
    attack:   26.0,   // spring stiffness toward the held target
    release:  17.0,   // spring stiffness returning to rest
    damping:   7.4,   // shared; below critical on release so it settles back
    lead: {           // slip toward the lead (+X) side
      'pelvis.rotation.z':  -0.08,
      'pelvis.position.x':   0.035,
      'spine.rotation.z':   -0.20,
      'spine.rotation.x':    0.10,
      'chest.rotation.z':   -0.26,
      'chest.rotation.x':    0.16,
      'chest.rotation.y':   -0.10,
      'neck.rotation.z':    -0.14,
      'neck.rotation.x':     0.10,
      // No leg channels, deliberately. The legs hang off the root at a fixed hip
      // height, so bending a knee lifts the FOOT rather than lowering the hip;
      // the ground clamp then puts the foot back down somewhere else and the
      // base has slid. A knee bend during a slip needs foot IK, which this spike
      // does not have. Feet planted is the requirement, so the legs sit it out.
    },
    rear: {           // slip toward the rear (-X) side
      'pelvis.rotation.z':   0.08,
      'pelvis.position.x':  -0.035,
      'spine.rotation.z':    0.20,
      'spine.rotation.x':    0.10,
      'chest.rotation.z':    0.26,
      'chest.rotation.x':    0.16,
      'chest.rotation.y':    0.10,
      'neck.rotation.z':     0.14,
      'neck.rotation.x':     0.10,
    },
  },

  // ── Player locomotion ───────────────────────────────────────────────────────
  // Not in the brief, but the impulse model reads glove world velocity, so
  // walking the punch in has to be possible or the physics claim is untestable.
  move: {
    accel:    9.0,
    maxSpeed: 1.9,
    friction: 8.0,
    boundR:   2.6,    // circular pen so nothing walks off to infinity
  },

  // ── Dummy reaction ──────────────────────────────────────────────────────────
  // Three spring-dampers down the chain, each with its OWN stiffness. Stiffest
  // at the pelvis, loosest at the head, so the chain lags as well as scaling —
  // scaling alone (which is what reaction.js does) keeps everything in phase.
  dummy: {
    z:            1.55,   // where it stands on the depth axis
    impulseScale: 0.115,  // glove speed (m/s) -> impulse. THE only magnitude input.
    headBias:     1.00,   // extra multiplier when the glove lands on the head
    bodyBias:     0.62,   //                               ... on the chest
    headHitR:     0.20,
    chestHitR:    0.27,

    pelvis: { k: 260, c: 20.0, lin: 0.16, ang: 0.9 },
    chest:  { k: 150, c: 14.0, lin: 0.42, ang: 3.4 },
    head:   { k:  86, c:  9.0, lin: 0.55, ang: 7.0 },

    maxLin: 0.30,   // clamp so a huge impulse deforms rather than explodes
    maxAng: 1.25,
  },

  // ── Camera ──────────────────────────────────────────────────────────────────
  // Deliberately NOT a decision made in code. az/el are degrees; az 0 puts the
  // camera in front of the player (on the +Z side, i.e. behind the dummy),
  // az 90 puts it on the player's lead flank, az 180 behind the player.
  camera: {
    preset:   'THREE_Q',
    az:       118,
    el:       24,
    dist:     4.6,
    fov:      42,
    targetY:  1.16,
    targetMix: 0.5,      // 0 = frame the player, 1 = frame the dummy
    presets: {
      SIDE:    { az:  90, el:  8, dist: 4.30, fov: 38, targetY: 1.20, targetMix: 0.50 },
      THREE_Q: { az: 118, el: 24, dist: 4.60, fov: 42, targetY: 1.16, targetMix: 0.50 },
      OVER:    { az: 162, el: 15, dist: 3.30, fov: 50, targetY: 1.32, targetMix: 0.62 },
      FREE:    { az: 118, el: 24, dist: 4.60, fov: 42, targetY: 1.16, targetMix: 0.50 },
    },
  },

  // ── Gym affordances ─────────────────────────────────────────────────────────
  gym: {
    timescale:    1.0,
    paused:       false,
    hold:         false,   // freeze the active punch and drive it from `scrub`
    scrub:        0.0,     // 0..1 over the whole punch, hold only
    stepMs:       16.667,
    trails:       true,
    trailFrames:  90,
    trailBoth:    false,
    skeleton:     false,
    axesSize:     0.055,
    grid:         true,
    hud:          true,
  },

  colors: {
    bg:        '#1b1d24',
    floor:     '#3a3f4b',
    playerBody:'#c8503c',
    playerSkin:'#e0a878',
    playerGlove:'#e8443a',
    dummyBody: '#3f6fa8',
    dummySkin: '#d0a074',
    dummyGlove:'#4c86c8',
    trail:     '#ffd24a',
    skeleton:  '#8cff7a',
    ambient:   0.55,
    keyLight:  1.15,
  },
};

/**
 * Total length of a punch in ms, derived rather than declared: every channel
 * recovers from its OWN peak, so the punch is over when the last one settles.
 */
export function punchDuration(p) {
  let end = 0;
  for (const c of p.channels) end = Math.max(end, c.t1 + p.hold + c.rec);
  return end;
}

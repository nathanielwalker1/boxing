/**
 * core/config.ts — EVERY tunable in the game, with its slider range and a
 * comment saying what it does and which legacy key it came from.
 *
 * Not frozen with the rest of core: it is append-only, and each workstream
 * appends only inside its own `group`. The tuning panel (`?tune=1`) walks
 * SCHEMA and binds every entry live, grouped by `group`. Sim code receives the
 * flat `Config` object (values only) and never reads SCHEMA.
 *
 * Constants that are NOT tunable (SIM_DT, ring size) are exported below
 * SCHEMA; they are structural, and a slider on them would break tests.
 */

// ── Schema vocabulary ─────────────────────────────────────────────────────────

export interface NumEntry  { kind: 'number'; value: number;  min: number; max: number; step: number; group: string; desc: string; legacy?: string }
export interface BoolEntry { kind: 'bool';   value: boolean; group: string; desc: string; legacy?: string }
export interface ColorEntry{ kind: 'color';  value: string;  group: string; desc: string; legacy?: string }
export type Entry = NumEntry | BoolEntry | ColorEntry;

const num  = (value: number, min: number, max: number, step: number, group: string, desc: string, legacy?: string): NumEntry =>
  legacy === undefined ? { kind: 'number', value, min, max, step, group, desc } : { kind: 'number', value, min, max, step, group, desc, legacy };
const bool = (value: boolean, group: string, desc: string, legacy?: string): BoolEntry =>
  legacy === undefined ? { kind: 'bool', value, group, desc } : { kind: 'bool', value, group, desc, legacy };
const color= (value: string, group: string, desc: string, legacy?: string): ColorEntry =>
  legacy === undefined ? { kind: 'color', value, group, desc } : { kind: 'color', value, group, desc, legacy };

// ── Structural constants (not sliders) ────────────────────────────────────────

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
/** Inside the ropes, metres (20 ft). CONTRACT §3. */
export const RING_SIZE = 6.1;
export const RING_HALF = RING_SIZE / 2;
export const APRON_W = 0.9;

// ── The schema ────────────────────────────────────────────────────────────────
// Group order here is the panel's folder order. Keep groups contiguous.

export const SCHEMA = {
  // ── ring (RENDER + SIM) ──
  ringInset:        num(0.35, 0, 1.5, 0.01, 'ring', 'movement bound inset from the ropes, m', 'RIG_MARGIN_X'),
  ropeCount:        num(4, 3, 4, 1, 'ring', 'rope strands per side', 'ringRopeCount'),
  ropeTopY:         num(1.3, 0.8, 1.6, 0.01, 'ring', 'height of the top rope, m'),
  ropeSag:          num(0.03, 0, 0.15, 0.005, 'ring', 'mid-span sag of each rope, m'),
  postR:            num(0.05, 0.02, 0.1, 0.005, 'ring', 'corner post radius, m'),
  matColor:         color('#5a4a3a', 'ring', 'canvas colour — darkest large surface in frame', 'ringFloorColor'),
  matLineColor:     color('#d9d2c4', 'ring', 'canvas border trim'),
  apronColor:       color('#1d2a63', 'ring', 'apron skirt', 'apronSkirtColor'),
  ropeColorA:       color('#cc2222', 'ring', 'rope 1', 'ringRopeColor'),
  ropeColorB:       color('#e8e8ee', 'ring', 'rope 2', 'ringRopeColor2'),
  ropeColorC:       color('#2b46a8', 'ring', 'rope 3', 'ringRopeColor3'),
  padColorRed:      color('#a8202a', 'ring', 'red corner pads', 'ringPadColorB'),
  padColorBlue:     color('#2b4a9e', 'ring', 'blue corner pads', 'ringPadColorA'),
  padColorNeutral:  color('#e9e9f2', 'ring', 'neutral corner pads'),
  matGrain:         num(0.10, 0, 0.5, 0.01, 'ring', 'canvas grain amplitude (0 = flat colour)'),
  matTrimW:         num(0.06, 0, 0.2, 0.005, 'ring', 'canvas trim line width, m'),
  apronStripeColor: color('#c9a227', 'ring', 'apron skirt stripe'),
  apronStripeY:     num(0.8, 0, 1, 0.01, 'ring', 'stripe height on the skirt, fraction from the bottom'),
  sponsorDecalAlpha: num(0.8, 0, 1, 0.05, 'ring', 'opacity of the sponsor decals on the canvas'),
  sponsorDecalTone: num(0.45, 0, 1, 0.01, 'ring', 'decal brightness multiplier — prints are inked into the canvas, never lighter than fighters (L1)'),

  // ── camera (RENDER) — CONTRACT §7 broadcast 3/4 view ──
  camElevationDeg:  num(24, 5, 60, 0.5, 'camera', 'elevation above the floor plane, degrees'),
  camAzimuthDeg:    num(90, 0, 360, 1, 'camera', 'orbit angle around the ring; 90 = looking along -z'),
  camDistMin:       num(4.2, 2, 8, 0.05, 'camera', 'dolly distance when fighters are clinched, m'),
  camDistMax:       num(6.5, 3, 12, 0.05, 'camera', 'dolly distance at max separation, m'),
  camFovMin:        num(34, 20, 60, 0.5, 'camera', 'vertical FOV when close, degrees'),
  camFovMax:        num(42, 20, 70, 0.5, 'camera', 'vertical FOV at max separation, degrees'),
  camLookY:         num(1.0, 0.5, 1.6, 0.01, 'camera', 'height of the look-at point, m'),
  camFollowLambda:  num(6, 0.5, 20, 0.1, 'camera', 'tracking smoothing rate, 1/s (higher = snappier)', 'camFollowLerp'),
  camDriftAmp:      num(0.012, 0, 0.05, 0.001, 'camera', 'handheld drift amplitude, m'),
  camDriftHz:       num(0.18, 0.02, 1, 0.01, 'camera', 'handheld drift frequency'),
  camPunchIn:       num(0.18, 0, 0.6, 0.01, 'camera', 'dolly-in on a heavy impact, m per unit impulse'),
  camPunchInMax:    num(0.5, 0, 2, 0.05, 'camera', 'cap on the impact punch-in, m'),
  camPunchRecover:  num(0.35, 0.05, 2, 0.01, 'camera', 'punch-in recovery time, s'),
  camKoPunchIn:     num(0.7, 0, 2, 0.05, 'camera', 'dolly-in on a knockdown / KO, m'),
  camKoRecover:     num(1.2, 0.1, 4, 0.05, 'camera', 'knockdown / KO punch-in recovery time, s'),
  camDollyLambda:   num(4, 0.5, 20, 0.1, 'camera', 'dolly + FOV smoothing rate toward closeness, 1/s'),

  // ── light (RENDER) ──
  keyIntensity:     num(6, 0, 20, 0.1, 'light', 'key spot over the ring'),
  keyHeight:        num(6, 3, 12, 0.1, 'light', 'key spot height, m'),
  keyAngleDeg:      num(38, 10, 80, 0.5, 'light', 'key spot cone half-angle, degrees'),
  fillIntensity:    num(0.8, 0, 4, 0.05, 'light', 'hemisphere fill'),
  rimIntensity:     num(2.5, 0, 10, 0.1, 'light', 'rim light from behind the far ropes'),
  shadowMapSize:    num(2048, 512, 4096, 512, 'light', 'shadow map resolution (power of two)'),
  shadowRadius:     num(2, 0, 8, 0.1, 'light', 'shadow softness'),

  // ── render toggles (RENDER) ──
  postEnabled:      bool(false, 'render', 'bloom + vignette post pass (off by default on mobile)'),
  outlines:         bool(false, 'render', 'inverted-hull outlines on the rigs (ink look)'),
  outlineWidth:     num(0.012, 0, 0.05, 0.001, 'render', 'outline thickness, m'),
  toonBands:        num(2, 1, 4, 1, 'render', 'toon shading bands'),
  rimStrength:      num(0.6, 0, 2, 0.05, 'render', 'material rim term'),
  crowdEnabled:     bool(true, 'render', 'instanced crowd silhouettes'),
  bloomStrength:    num(0.35, 0, 2, 0.01, 'render', 'post: bloom strength'),
  bloomRadius:      num(0.4, 0, 1, 0.01, 'render', 'post: bloom radius'),
  bloomThreshold:   num(0.8, 0, 1, 0.01, 'render', 'post: bloom luminance threshold'),
  vignetteStrength: num(0.4, 0, 1, 0.01, 'render', 'post: vignette darkening at the frame edge'),

  // ── arena (RENDER) — L7 placeholder: dark bowl, crowd, truss, beams, haze ──
  fogColor:         color('#0b0b10', 'arena', 'haze / background colour — the bowl fades into this'),
  fogNear:          num(10, 2, 40, 0.5, 'arena', 'haze starts, m from camera'),
  fogFar:           num(34, 5, 80, 0.5, 'arena', 'haze fully opaque, m from camera'),
  bowlColor:        color('#17171c', 'arena', 'tier / floor / back-wall colour'),
  bowlInnerR:       num(7, 4.5, 12, 0.1, 'arena', 'radius where the first seating tier starts, m'),
  bowlTiers:        num(5, 1, 8, 1, 'arena', 'seating tiers'),
  bowlTierRise:     num(0.9, 0.2, 2, 0.05, 'arena', 'height step per tier, m'),
  bowlTierDepth:    num(2.6, 1, 5, 0.1, 'arena', 'radial depth per tier, m'),
  crowdCount:       num(3000, 0, 6000, 100, 'arena', 'crowd instances (one InstancedMesh)'),
  crowdColor:       color('#2c2a33', 'arena', 'crowd base colour — dark, desaturated'),
  crowdVariance:    num(0.35, 0, 1, 0.01, 'arena', 'per-instance brightness variance'),
  crowdSeed:        num(7, 1, 9999, 1, 'arena', 'seed for the crowd layout (render-local RNG)'),
  flashCount:       num(10, 0, 32, 1, 'arena', 'camera-flash quads in the crowd'),
  flashRate:        num(2.5, 0, 12, 0.1, 'arena', 'camera flashes per second across the bowl'),
  flashSize:        num(0.35, 0.05, 1.5, 0.05, 'arena', 'camera flash quad size, m'),
  trussHeight:      num(7.5, 4, 14, 0.1, 'arena', 'overhead light truss height, m'),
  trussSize:        num(9, 4, 20, 0.5, 'arena', 'truss square side, m'),
  beamCount:        num(4, 0, 8, 1, 'arena', 'visible light beams from the truss'),
  beamOpacity:      num(0.07, 0, 0.6, 0.01, 'arena', 'beam cone opacity (additive) — keep the bowl band darker than the mat (L1)'),
  beamColor:        color('#9fb4ff', 'arena', 'beam cone colour'),
  beamRadius:       num(1.4, 0.2, 4, 0.05, 'arena', 'beam cone radius where it meets the ring, m'),

  // ── body proportions (CORE body.ts; read by RIG and SIM) — toy-figure ratios ──
  headsTall:        num(6.2, 5, 8, 0.1, 'body', 'height in head-heights; toy figure ≈ 6, realistic ≈ 7.5'),
  gloveScale:       num(1.6, 1, 2.5, 0.05, 'body', 'glove radius as a multiple of anatomical fist', 'fistRadius'),
  shoulderRatio:    num(0.26, 0.18, 0.34, 0.005, 'body', 'shoulder width / height'),
  hipRatio:         num(0.17, 0.12, 0.24, 0.005, 'body', 'hip width / height'),
  bodyRadiusRatio:  num(0.085, 0.05, 0.14, 0.005, 'body', 'torso capsule radius / height'),
  armRatio:         num(0.44, 0.35, 0.55, 0.005, 'body', 'upper+forearm length / height (reach-adjusted)'),
  legRatio:         num(0.47, 0.4, 0.55, 0.005, 'body', 'thigh+shin length / height'),
  buildLean:        num(0.9, 0.7, 1, 0.01, 'body', 'radius multiplier for build=lean'),
  buildHeavy:       num(1.18, 1, 1.5, 0.01, 'body', 'radius multiplier for build=heavy'),

  // ── sim: movement (SIM) — ported from legacy movement.js at 1 px = 0.0122 m ──
  moveSpeed:        num(2.44, 0.5, 4, 0.05, 'movement', 'top walking speed, m/s (v1: 200 px/s)', 'moveSpeed'),
  moveAccel:        num(11.25, 2, 40, 0.25, 'movement', 'approach rate toward the input velocity at moveMassRef, 1/s (v1: acceleration / playerMass)', 'acceleration'),
  moveFriction:     num(15, 1, 30, 0.5, 'movement', 'velocity decay rate with no input at moveMassRef, 1/s (v1: friction / playerMass)', 'friction'),
  turnRate:         num(9, 1, 30, 0.5, 'movement', 'max yaw turn rate toward the opponent, rad/s'),
  separationDist:   num(0.46, 0.3, 1, 0.01, 'movement', 'minimum centre-to-centre distance, m (v1: 38 px)', 'fighterSeparationDist'),
  moveMassRef:      num(80, 50, 120, 1, 'movement', 'mass at which moveAccel/moveFriction apply as written, kg; heavier = sluggier', 'playerMass'),
  moveStopSpeed:    num(0.006, 0, 0.05, 0.001, 'movement', 'speed below which a coasting fighter snaps to rest, m/s (v1: 0.5 px/s)', 'stepMovement'),
  separationStrength: num(0.5, 0.05, 1, 0.05, 'movement', 'fraction of a body overlap corrected per tick; 1 = rigid', 'fighterSeparationStrength'),

  // ── sim: punch (SIM) — per-phase timing in seconds, impulse in N·s ──
  jabCock:          num(0.08, 0.02, 0.4, 0.005, 'punch', 'jab wind-up (the telegraph), s', 'jabCockMs'),
  jabExtend:        num(0.045, 0.02, 0.2, 0.005, 'punch', 'jab cock → full extension, s', 'jabExtendMs'),
  jabRecover:       num(0.108, 0.02, 0.4, 0.005, 'punch', 'jab peak → back to guard, s', 'jabRecoverMs'),
  crossCock:        num(0.105, 0.02, 0.4, 0.005, 'punch', 'cross wind-up, s', 'crossCockMs'),
  crossExtend:      num(0.05, 0.02, 0.2, 0.005, 'punch', 'cross cock → full extension, s', 'crossExtendMs'),
  crossRecover:     num(0.104, 0.02, 0.4, 0.005, 'punch', 'cross peak → back to guard, s', 'crossRecoverMs'),
  punchTimeScale:   num(1, 0.25, 3, 0.05, 'punch', 'global multiplier over every punch phase; 1 = as authored', 'punchTimeScale'),
  punchImpulseBase: num(244, 20, 600, 2, 'punch', 'base impulse of a standing punch, N·s (v1: 250 px/s on an 80 kg body)', 'punchForceBase'),
  punchMomentumScale: num(0.4, 0, 2, 0.05, 'punch', 'impulse added per (attacker mass × approach speed); 0 = flat force', 'punchMomentumScale'),
  punchLeanScale:   num(0.25, 0, 1, 0.05, 'punch', 'impulse multiplier per unit of forward lean at the resolve moment'),
  punchImpulseFloor: num(0.1, 0, 1, 0.05, 'punch', 'a retreating punch never drops below this fraction of the base impulse', '_resolveAttack'),
  jabImpulseMult:   num(0.7, 0.2, 2, 0.05, 'punch', 'jab impulse multiplier', 'jabDamage'),
  crossImpulseMult: num(0.95, 0.2, 2, 0.05, 'punch', 'cross impulse multiplier', 'crossDamage'),
  rangeMax:         num(1.2, 0.6, 2, 0.01, 'punch', 'centre-to-centre distance beyond which a punch whiffs without a hit test, m', 'rangeMax'),
  smotherDist:      num(0.61, 0.3, 1, 0.01, 'punch', 'centre-to-centre distance inside which a straight punch is smothered, m (v1: 50 px)', 'smotherDist'),
  punchLean:        num(0.5, 0, 1, 0.05, 'punch', 'forward lean at full extension, 0..1'),

  // ── sim: block (SIM) ──
  blockReduction:   num(0.75, 0, 1, 0.05, 'block', 'fraction of an incoming impulse absorbed by a held block', 'blockReduction'),

  // ── sim: reaction (SIM) — hit reaction springs, per chain level ──
  reactionHeadK:    num(400, 50, 1500, 10, 'reaction', 'head spring stiffness, 1/s² (loosest level)', 'reactionStiffness'),
  reactionHeadC:    num(16, 2, 60, 0.5, 'reaction', 'head spring damping, 1/s', 'reactionDamping'),
  reactionTorsoK:   num(520, 50, 1500, 10, 'reaction', 'torso spring stiffness, 1/s² (stiffer than the head so the chain lags)'),
  reactionTorsoC:   num(20, 2, 60, 0.5, 'reaction', 'torso spring damping, 1/s'),
  reactionTiltK:    num(400, 50, 1500, 10, 'reaction', 'tilt spring stiffness, 1/s²'),
  reactionTiltC:    num(16, 2, 60, 0.5, 'reaction', 'tilt spring damping, 1/s'),
  reactionForceScale: num(0.03, 0, 0.1, 0.001, 'reaction', 'm/s of rig velocity per N·s of impulse', 'reactionForceScale'),
  reactionTwistScale: num(0.012, 0, 0.05, 0.001, 'reaction', 'rad/s of tilt velocity per N·s of (impulse × twist)', 'reactionTwistScale'),
  reactionMaxOffset: num(0.49, 0.05, 1, 0.01, 'reaction', 'hard clamp on head/torso offset, m (v1: 40 px)', 'reactionMaxOffset'),
  reactionMaxTilt:  num(0.6, 0.1, 1.5, 0.05, 'reaction', 'hard clamp on the tilt, rad', 'reactionMaxTilt'),
  jabReactBack:     num(0.7, 0, 2, 0.05, 'reaction', 'jab: head snap along the impulse', 'jabReactBack'),
  jabReactLift:     num(0.15, 0, 2, 0.05, 'reaction', 'jab: upward component', 'jabReactLift'),
  jabReactTwist:    num(0.06, 0, 2, 0.01, 'reaction', 'jab: tilt component', 'jabReactTwist'),
  jabReactTorso:    num(0.05, 0, 1, 0.05, 'reaction', 'jab: fraction bleeding into the torso', 'jabReactTorso'),
  jabReactSnap:     num(1.8, 0.5, 3, 0.05, 'reaction', 'jab: stiffness multiplier (higher = quicker, shorter)', 'jabReactSnap'),
  crossReactBack:   num(1.0, 0, 2, 0.05, 'reaction', 'cross: head snap along the impulse', 'crossReactBack'),
  crossReactLift:   num(0.2, 0, 2, 0.05, 'reaction', 'cross: upward component', 'crossReactLift'),
  crossReactTwist:  num(0.2, 0, 2, 0.01, 'reaction', 'cross: tilt component', 'crossReactTwist'),
  crossReactTorso:  num(0.45, 0, 1, 0.05, 'reaction', 'cross: fraction bleeding into the torso', 'crossReactTorso'),
  crossReactSnap:   num(1.15, 0.5, 3, 0.05, 'reaction', 'cross: stiffness multiplier', 'crossReactSnap'),
  staggerDecay:     num(15, 1, 40, 0.5, 'reaction', 'decay rate of the floor velocity injected by an impact, 1/s (v1: friction / playerMass)', 'friction'),

  // ── sim: chain (SIM) — the kinetic chain that carries each glove to its target ──
  chainK:           num(2500, 200, 8000, 50, 'chain', 'glove spring stiffness at guard, 1/s²'),
  chainC:           num(80, 10, 300, 1, 'chain', 'glove spring damping at guard, 1/s'),
  chainPunchK:      num(4, 1, 10, 0.25, 'chain', 'stiffness multiplier on the punching hand through cock + extend (damping scales by its root)'),
  chainRearK:       num(1.1, 0.7, 1.5, 0.01, 'chain', 'rear-hand stiffness multiplier so the hands never twin'),
  chainRearC:       num(1.05, 0.7, 1.5, 0.01, 'chain', 'rear-hand damping multiplier'),
  chainBobAmp:      num(0.012, 0, 0.05, 0.001, 'chain', 'idle guard bob amplitude, m', 'guardBobAmplitude'),
  chainBobHz:       num(1.1, 0.1, 4, 0.05, 'chain', 'idle guard bob frequency', 'guardBobFrequency'),

  // ── sim: time (SIM) ──
  hitStopScale:     num(0.05, 0, 0.5, 0.01, 'time', 'sim time rate during hit-stop (0 = frozen)', 'hitStopTimeScale'),
  hitStopBase:      num(0.06, 0, 0.3, 0.005, 'time', 'hit-stop duration on a clean land at power 1, s', 'hitStopDuration'),
  hitStopMax:       num(0.1, 0, 0.5, 0.005, 'time', 'hit-stop ceiling so a huge hit never reads as a hang, s', 'hitStopMax'),

  // ── fight (SIM) ──
  roundCount:       num(6, 1, 12, 1, 'fight', 'rounds per fight'),
  roundSeconds:     num(60, 10, 180, 5, 'fight', 'seconds per round'),
  betweenRoundSeconds: num(10, 3, 30, 1, 'fight', 'between-round card duration, s'),
  knockdownsForTko: num(3, 1, 5, 1, 'fight', 'knockdowns in one round = TKO'),

  // ── debug (UI) ──
  debugHitboxes:    bool(false, 'debug', 'draw sim hit spheres and capsules'),
  debugSkeleton:    bool(false, 'debug', 'draw rig joints and bones'),
  debugFps:         bool(true, 'debug', 'show the frame-time overlay'),

  // ── input (UI) — touch joystick, touch buttons, gamepad. src/ui/input.ts ──
  joyRadius:        num(70, 30, 160, 1, 'input', 'floating joystick max knob travel, px (full deflection = 1)'),
  joyDeadZone:      num(0.12, 0, 0.5, 0.01, 'input', 'joystick dead zone as a fraction of joyRadius'),
  touchButtonR:     num(34, 20, 60, 1, 'input', 'punch diamond button radius, px'),
  touchButtonSep:   num(78, 40, 140, 1, 'input', 'punch diamond centre-to-button distance, px'),
  touchBlockW:      num(150, 80, 260, 1, 'input', 'block button width, px'),
  touchBlockH:      num(48, 30, 90, 1, 'input', 'block button height, px'),
  touchMargin:      num(20, 0, 80, 1, 'input', 'gap from the screen edge to the touch controls, px'),
  padDeadZone:      num(0.2, 0, 0.6, 0.01, 'input', 'gamepad left-stick dead zone (radial, 0..1)'),

  // ── rig (RIG) — proportions not in BodyDims, stance, springs, idle life, squash. src/rig ──
  rigStanceHipYawDeg:      num(28, 0, 60, 1, 'rig', 'hips bladed off-square toward the lead side, degrees'),
  rigStanceShoulderYawDeg: num(38, 0, 75, 1, 'rig', 'shoulder line bladed off-square, degrees (lead shoulder forward)'),
  rigHeadFollow:           num(0.35, 0, 1, 0.01, 'rig', 'fraction of the shoulder yaw the head follows (0 = always faces the opponent)'),
  rigStanceFwd:            num(0.20, 0, 0.5, 0.01, 'rig', 'lead foot forward of the hips, m'),
  rigStanceBack:           num(0.24, 0, 0.5, 0.01, 'rig', 'rear foot behind the hips, m'),
  rigStanceLat:            num(0.17, 0.05, 0.4, 0.005, 'rig', 'lateral half-spread of the feet, m'),
  rigLeadFootYawDeg:       num(12, -30, 45, 1, 'rig', 'lead foot toes turned in, degrees'),
  rigRearFootYawDeg:       num(40, 0, 80, 1, 'rig', 'rear foot toes turned out, degrees'),
  rigFootLen:              num(2.9, 1.5, 4, 0.05, 'rig', 'boot length as a multiple of bootH'),
  rigFootW:                num(1.15, 0.6, 2, 0.05, 'rig', 'boot width as a multiple of bootH'),
  rigKneeMax:              num(0.98, 0.8, 1, 0.005, 'rig', 'max hip→ankle distance as a fraction of thigh+shin (no hyperextension)'),
  rigKneePoleFwd:          num(1.0, 0, 2, 0.05, 'rig', 'knee pole vector forward weight'),
  rigKneePoleOut:          num(0.35, 0, 2, 0.05, 'rig', 'knee pole vector outward weight'),
  rigElbowPoleDown:        num(1.0, 0, 2, 0.05, 'rig', 'elbow pole vector downward weight'),
  rigElbowPoleOut:         num(0.9, 0, 2, 0.05, 'rig', 'elbow pole vector outward (away from torso) weight'),
  rigElbowPoleBack:        num(0.35, 0, 2, 0.05, 'rig', 'elbow pole vector backward weight'),
  rigElbowClearance:       num(1.15, 1, 1.6, 0.01, 'rig', 'min elbow distance from the torso axis as a multiple of bodyR + forearm radius'),
  rigArmStretchMax:        num(1.15, 1, 1.5, 0.01, 'rig', 'forearm may stretch to this × its length to reach the glove'),
  rigUpperArmR:            num(0.42, 0.2, 0.8, 0.01, 'rig', 'upper arm radius / bodyR'),
  rigForearmR:             num(0.36, 0.2, 0.8, 0.01, 'rig', 'forearm radius / bodyR'),
  rigThighR:               num(0.55, 0.3, 0.9, 0.01, 'rig', 'thigh radius / bodyR'),
  rigShinR:                num(0.42, 0.2, 0.8, 0.01, 'rig', 'shin radius / bodyR'),
  rigNeckR:                num(0.45, 0.2, 0.8, 0.01, 'rig', 'neck radius / headR'),
  rigChestDepth:           num(1.0, 0.5, 1.5, 0.01, 'rig', 'chest half-depth / bodyR'),
  rigWaistRatio:           num(0.70, 0.4, 1, 0.01, 'rig', 'waist width / shoulder width (wide shoulders, narrow waist)'),
  rigGloveElongate:        num(1.12, 1, 1.4, 0.01, 'rig', 'glove length along the forearm as a multiple of gloveR'),
  rigCuffLen:              num(0.9, 0, 1.5, 0.05, 'rig', 'wrist cuff length / gloveR'),
  rigHipK:                 num(380, 20, 1200, 10, 'rig', 'hip sway spring stiffness, 1/s² (stiffest link)'),
  rigHipZeta:              num(0.55, 0.1, 1.5, 0.01, 'rig', 'hip sway damping ratio (<1 overshoots)'),
  rigSpineK:               num(240, 20, 1200, 10, 'rig', 'spine bend spring stiffness'),
  rigSpineZeta:            num(0.5, 0.1, 1.5, 0.01, 'rig', 'spine bend damping ratio'),
  rigShoulderK:            num(150, 20, 1200, 10, 'rig', 'shoulder line spring stiffness'),
  rigShoulderZeta:         num(0.4, 0.1, 1.5, 0.01, 'rig', 'shoulder line damping ratio'),
  rigElbowK:               num(110, 20, 1200, 10, 'rig', 'elbow pole spring stiffness (loosest link)'),
  rigElbowZeta:            num(0.5, 0.1, 1.5, 0.01, 'rig', 'elbow pole damping ratio'),
  rigTwinSkew:             num(0.12, 0, 0.5, 0.01, 'rig', 'right-side springs are this fraction stiffer than left so limbs never twin'),
  rigLeanHip:              num(0.05, 0, 0.3, 0.005, 'rig', 'hip forward shift per unit lean.fwd, m'),
  rigLeanChest:            num(0.10, 0, 0.3, 0.005, 'rig', 'chest forward shift per unit lean.fwd, m'),
  rigLeanLat:              num(0.05, 0, 0.3, 0.005, 'rig', 'hip lateral shift per unit lean.lat, m'),
  rigLeanTiltDeg:          num(10, 0, 30, 0.5, 'rig', 'chest pitch per unit lean.fwd, degrees'),
  rigBreathHz:             num(0.28, 0.05, 1, 0.01, 'rig', 'breathing rate'),
  rigBreathAmp:            num(0.03, 0, 0.1, 0.005, 'rig', 'chest scale swell per breath'),
  rigSwayHz:               num(0.42, 0.05, 2, 0.01, 'rig', 'idle weight-shift rate'),
  rigSwayAmp:              num(0.012, 0, 0.05, 0.001, 'rig', 'idle weight-shift lateral amplitude, m'),
  rigBobAmp:               num(0.006, 0, 0.03, 0.001, 'rig', 'idle hip bob amplitude, m'),
  rigStepThreshold:        num(0.12, 0.02, 0.4, 0.01, 'rig', 'a foot steps once its rest spot drifts this far, m'),
  rigStepDur:              num(0.22, 0.08, 0.6, 0.01, 'rig', 'step duration, s'),
  rigStepLift:             num(0.05, 0, 0.15, 0.005, 'rig', 'foot lift mid-step, m'),
  rigStepLead:             num(0.15, 0, 0.5, 0.01, 'rig', 'step lands this many seconds ahead along vel'),
  rigSquashAmount:         num(0.22, 0, 0.6, 0.01, 'rig', 'head/torso squash along the impulse on a landed punch'),
  rigSquashDur:            num(0.14, 0.03, 0.5, 0.01, 'rig', 'head/torso squash duration, s'),
  rigGloveSquashAmount:    num(0.3, 0, 0.6, 0.01, 'rig', 'glove squash along the forearm on contact'),
  rigGloveSquashDur:       num(0.09, 0.03, 0.4, 0.01, 'rig', 'glove squash duration, s'),
  rigFlatShading:          bool(true, 'rig', 'faceted low-poly normals (off = smooth)'),
  rigRimPower:             num(3, 1, 8, 0.1, 'rig', 'rim falloff exponent (higher = thinner rim)'),
  rigHairColor:            color('#1c1612', 'rig', 'hair and facial hair'),
  rigEyeColor:             color('#14101a', 'rig', 'eyes and brow'),
  rigCuffColor:            color('#f2f2f2', 'rig', 'glove wrist cuff'),
  rigOutlineColor:         color('#0a0a0e', 'rig', 'inverted-hull outline colour'),
} satisfies Record<string, Entry>;

export type Schema = typeof SCHEMA;
export type ConfigKey = keyof Schema;

/** The flat values object the sim, rig and renderer read. */
export type Config = { [K in ConfigKey]: Schema[K]['value'] };

export function createConfig(): Config {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(SCHEMA) as ConfigKey[]) out[k] = SCHEMA[k].value;
  return out as Config;
}

/** Distinct group names in schema order. */
export function configGroups(): string[] {
  const seen: string[] = [];
  for (const k of Object.keys(SCHEMA) as ConfigKey[]) {
    const g = SCHEMA[k].group;
    if (!seen.includes(g)) seen.push(g);
  }
  return seen;
}

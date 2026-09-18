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
  camElevationDeg:  num(12, 5, 60, 0.5, 'camera', 'elevation above the floor plane, degrees. 12 = near eye level with the boxers, Fight Night\'s ringside seat; was 24, "like an eagle" (Nate 2026-09-16)'),
  camAzimuthDeg:    num(90, 0, 360, 1, 'camera', 'orbit angle around the ring when the camera is not following (camFollow 0, or a focused single fighter); 90 = looking along -z'),
  camFollow:        num(1, 0, 1, 1, 'camera', 'the follow camera (2026-09-17, Fight Night Champion): the orbit rides the player→opponent line so the player is always seen from the same angle, over the shoulder, and never stands between the lens and the opponent. 0 = the fixed broadcast seat (fighters circling ended up in a line, "I\'m blocked, I don\'t even see my fighter")'),
  camBehindDeg:     num(35, 0, 80, 1, 'camera', 'how far round from side-on toward the player\'s back the follow camera sits, degrees. 0 = pure side view (both fighters in profile), 90 = directly behind the player'),
  camOrbitLambda:   num(2.5, 0.3, 12, 0.1, 'camera', 'how quickly the follow camera swings round to the new line, 1/s (higher = tighter)'),
  camOrbitMaxRate:  num(140, 20, 720, 5, 'camera', 'cap on the follow camera\'s swing, degrees per second, so two fighters circling do not whip the room'),
  camDistMin:       num(4.2, 2, 8, 0.05, 'camera', 'dolly distance when fighters are clinched, m'),
  camDistMax:       num(6.5, 3, 12, 0.05, 'camera', 'dolly distance at max separation, m'),
  camFovMin:        num(34, 20, 60, 0.5, 'camera', 'vertical FOV when close, degrees'),
  camFovMax:        num(42, 20, 70, 0.5, 'camera', 'vertical FOV at max separation, degrees'),
  camLookY:         num(1.08, 0.5, 1.6, 0.01, 'camera', 'height of the look-at point, m (chest height; was 1.0)'),
  camFollowLambda:  num(6, 0.5, 20, 0.1, 'camera', 'tracking smoothing rate, 1/s (higher = snappier)', 'camFollowLerp'),
  camDriftAmp:      num(0.012, 0, 0.05, 0.001, 'camera', 'handheld drift amplitude, m'),
  camDriftHz:       num(0.18, 0.02, 1, 0.01, 'camera', 'handheld drift frequency'),
  camPunchIn:       num(0.18, 0, 0.6, 0.01, 'camera', 'dolly-in on a heavy impact, m per unit impulse'),
  camPunchInMax:    num(0.5, 0, 2, 0.05, 'camera', 'cap on the impact punch-in, m'),
  camPunchRecover:  num(0.35, 0.05, 2, 0.01, 'camera', 'punch-in recovery time, s'),
  camKoPunchIn:     num(0.7, 0, 2, 0.05, 'camera', 'dolly-in on a knockdown / KO, m'),
  camKoRecover:     num(1.2, 0.1, 4, 0.05, 'camera', 'knockdown / KO punch-in recovery time, s'),
  camDollyLambda:   num(4, 0.5, 20, 0.1, 'camera', 'dolly + FOV smoothing rate toward closeness, 1/s'),
  camShake:         num(0.012, 0, 0.05, 0.001, 'camera', 'camera shake amplitude on a landed punch, m per unit impulse (a hook ≈ 1.4, a jab ≈ 0.7) — decays over camShakeRecover (2026-09-16)'),
  camShakeHz:       num(17, 4, 40, 0.5, 'camera', 'camera shake frequency'),
  camShakeRecover:  num(0.3, 0.05, 1, 0.01, 'camera', 'camera shake decay time, s'),

  // ── audio (UI) — synthesized combat SFX, ported from v1 audio.js: master knobs here, recipes in src/ui/audio.ts ──
  audioEnabled:     bool(true, 'audio', 'combat sounds on (they need one click or key press first — browser autoplay policy)', 'audioEnabled'),
  audioMasterVolume: num(0.55, 0, 1, 0.01, 'audio', 'master volume', 'audioMasterVolume'),
  audioPitchJitter: num(0.05, 0, 0.3, 0.01, 'audio', '± pitch per play, so a four-jab burst is not one sample stamped four times', 'audioPitchJitter'),
  audioVolumeJitter: num(0.10, 0, 0.5, 0.01, 'audio', '± volume per play', 'audioVolumeJitter'),

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
  moveAccel:        num(7, 2, 40, 0.25, 'movement', 'approach rate toward the input velocity at moveMassRef, 1/s — top speed in ~0.4 s. Was 11.25 (v1: acceleration / playerMass), which read as an instant start (Nate 2026-09-16: "robotic and stiff")', 'acceleration'),
  moveFriction:     num(8, 1, 30, 0.5, 'movement', 'velocity decay rate with no input at moveMassRef, 1/s — a released stick glides ~0.3 m. Was 15 (v1: friction / playerMass), a dead stop', 'friction'),
  turnRate:         num(9, 1, 30, 0.5, 'movement', 'max yaw turn rate toward the opponent, rad/s'),
  separationDist:   num(0.55, 0.3, 1, 0.01, 'movement', 'minimum centre-to-centre distance, m (v1: 38 px = 0.46; raised so resting gloves sit clear of the other chest)', 'fighterSeparationDist'),
  moveMassRef:      num(80, 50, 120, 1, 'movement', 'mass at which moveAccel/moveFriction apply as written, kg; heavier = sluggier', 'playerMass'),
  moveStopSpeed:    num(0.006, 0, 0.05, 0.001, 'movement', 'speed below which a coasting fighter snaps to rest, m/s (v1: 0.5 px/s)', 'stepMovement'),
  separationStrength: num(0.5, 0.05, 1, 0.05, 'movement', 'fraction of a body overlap corrected per tick; 1 = rigid', 'fighterSeparationStrength'),
  moveBackScale:    num(0.8, 0.3, 1, 0.05, 'movement', 'top speed walking BACK (away from the opponent) as a fraction of moveSpeed — a boxer retreats slower than he advances (2026-09-16; Fight Night does the same)'),
  moveLateralScale: num(0.9, 0.3, 1, 0.05, 'movement', 'top speed circling (pure lateral stick) as a fraction of moveSpeed; diagonals blend'),
  moveTiredScale:   num(0.65, 0.2, 1, 0.05, 'movement', 'the legs go first (2026-09-16): at ZERO stamina top speed and the push-off are this fraction of fresh, linearly in between — both fighters. Undisputed does loose → flat-footed off the same bar'),

  // ── sim: punch (SIM) — per-phase timing in seconds, impulse in N·s ──
  jabCock:          num(0.06, 0.02, 0.4, 0.005, 'punch', 'jab wind-up (the telegraph), s. 0.06 from v1\'s 0.08 (2026-09-16, the whip: the fist leaves the guard sooner and there is no pull-back to show)', 'jabCockMs'),
  jabExtend:        num(0.05, 0.02, 0.2, 0.005, 'punch', 'jab cock → full extension, s (3 ticks — the fastest thing in the game)', 'jabExtendMs'),
  jabRecover:       num(0.10, 0.02, 0.4, 0.005, 'punch', 'jab peak → back to guard, s', 'jabRecoverMs'),
  // Cross / hook / uppercut wind-ups and recoveries lengthened ~45% on 2026-09-16 (Nate's call): the load and the
  // follow-through were unreadable inside v1's 0.26 s. The extensions (the strike itself) are untouched, so the
  // punch is not in slow motion — it is loaded longer and stays committed longer. The jab keeps v1's speed.
  crossCock:        num(0.15, 0.02, 0.4, 0.005, 'punch', 'cross wind-up, s (v1: 0.105)', 'crossCockMs'),
  crossExtend:      num(0.05, 0.02, 0.2, 0.005, 'punch', 'cross cock → full extension, s', 'crossExtendMs'),
  crossRecover:     num(0.15, 0.02, 0.4, 0.005, 'punch', 'cross peak → back to guard, s (v1: 0.104)', 'crossRecoverMs'),
  hookCock:         num(0.19, 0.02, 0.4, 0.005, 'punch', 'hook wind-up (coils out and across), s (v1: 0.16). cock + extend = 0.25 = 15 ticks exactly', 'hookCockMs'),
  hookExtend:       num(0.06, 0.02, 0.2, 0.005, 'punch', 'hook cock → the fist crosses the centreline, s', 'hookExtendMs'),
  hookRecover:      num(0.16, 0.02, 0.4, 0.005, 'punch', 'hook peak → back to guard, s (v1: 0.113)', 'hookRecoverMs'),
  uppercutCock:     num(0.24, 0.02, 0.4, 0.005, 'punch', 'uppercut wind-up (drops to the hip), s (v1: 0.17)', 'uppercutCockMs'),
  uppercutExtend:   num(0.06, 0.02, 0.2, 0.005, 'punch', 'uppercut hip → above the chin, s (v1: 0.062; cock + extend = 0.30 = 18 ticks exactly)', 'uppercutExtendMs'),
  uppercutRecover:  num(0.17, 0.02, 0.4, 0.005, 'punch', 'uppercut peak → back to guard, s (v1: 0.118)', 'uppercutRecoverMs'),
  punchTimeScale:   num(1, 0.25, 3, 0.05, 'punch', 'global multiplier over every punch phase; 1 = as authored', 'punchTimeScale'),
  punchImpulseBase: num(244, 20, 600, 2, 'punch', 'base impulse of a standing punch, N·s (v1: 250 px/s on an 80 kg body)', 'punchForceBase'),
  punchMomentumScale: num(0.4, 0, 2, 0.05, 'punch', 'impulse added per (attacker mass × approach speed); 0 = flat force', 'punchMomentumScale'),
  punchLeanScale:   num(0.25, 0, 1, 0.05, 'punch', 'impulse multiplier per unit of forward lean at the resolve moment'),
  punchImpulseFloor: num(0.1, 0, 1, 0.05, 'punch', 'a retreating punch never drops below this fraction of the base impulse', '_resolveAttack'),
  jabImpulseMult:   num(0.7, 0.2, 2, 0.05, 'punch', 'jab impulse multiplier', 'jabDamage'),
  crossImpulseMult: num(0.95, 0.2, 2, 0.05, 'punch', 'cross impulse multiplier', 'crossDamage'),
  hookImpulseMult:  num(1.45, 0.2, 2, 0.05, 'punch', 'hook impulse multiplier (the heavy ones)', 'hookDamage'),
  uppercutImpulseMult: num(1.55, 0.2, 2, 0.05, 'punch', 'uppercut impulse multiplier', 'uppercutDamage'),
  rangeMax:         num(1.2, 0.6, 2, 0.01, 'punch', 'centre-to-centre distance beyond which a punch whiffs without a hit test, m', 'rangeMax'),
  smotherDist:      num(0.61, 0.3, 1, 0.01, 'punch', 'centre-to-centre distance inside which a straight punch starts losing power, m (v1: 50 px, where it was a no-contact smother)', 'smotherDist'),
  smotherPowerFloor: num(0.35, 0, 1, 0.05, 'punch', 'power multiplier of a straight punch thrown at the body-separation distance; ramps to 1 at smotherDist'),
  contactSquash:    num(0.35, 0, 0.9, 0.05, 'punch', 'how far the glove sinks into what it hit during the hold, as a fraction of its radius'),
  punchLean:        num(0.7, 0, 1, 0.05, 'punch', 'forward lean at full extension, 0..1 (× each punch\'s own lean: jab 0.8, cross 1, hook 0.6, uppercut 0.4). Was 0.5 (2026-09-16, the Tyson stretch)'),
  punchLeanMove:    num(0.4, 0, 1, 0.05, 'punch', 'context (2026-09-16): the forward lean of a punch scales by 1 + this × (own speed along the facing / moveSpeed) — a jab thrown advancing leans further (the lunge), one thrown backing off barely leans (the flicker)'),
  punchRollWith:    num(0.3, 0, 1, 0.05, 'punch', 'a punch landing on a defender moving AWAY along the impulse loses this fraction of its impulse at full retreat speed (rolling with it)…'),
  punchRetreatStumble: num(0.8, 0, 2, 0.05, 'punch', '…but the retreating defender stumbles this much further (× retreat speed / moveSpeed) — hit while backing off looks different: less damage, more feet'),
  punchSweepLen:    num(0.3, 0, 0.6, 0.01, 'punch', 'the hit test sweeps the glove back this far along the attacker\'s forward axis from where the fist is (2026-09-16): a fist that has passed the head along its line still landed (a cramped straight now reaches past the head). 0 = the old point test'),
  punchLeanShift:   num(0.18, 0, 0.4, 0.01, 'punch', 'how far the head and shoulders move FORWARD per unit lean.fwd, m (hips half; back through the load) — in the SIM, so the punch reaches further and the head is out over the front knee (2026-09-16). A cross at lean 0.7 carries the head 12.6 cm toward the opponent'),
  punchStepIn:      num(0.15, 0, 0.4, 0.01, 'punch', 'the step-in (2026-09-16, Nate\'s call): a jab or cross thrown with the stick pushed forward takes a lunge step this long with it, m, landing as the fist does; it counts as approach momentum, so a step-in cross hits harder. 0 = punches are thrown from where you stand. Hooks and uppercuts never step'),
  punchStepInStick: num(0.5, 0, 1, 0.05, 'punch', 'how far forward the stick must be at the press for a straight to step in'),
  punchLoad:        num(1, 0, 2, 0.05, 'punch', 'the load (2026-09-16): through the wind-up the weight rocks BACK onto the rear foot by this × each punch\'s own load × its lean (jab 0.15, cross 0.5, hook 0.4, uppercut 0.6), and the hips counter-turn (cross coil 0.15, jab 0.05); the drive then comes forward off that foot. 0 = the old straight-into-it ramp'),
  punchDipScale:    num(1, 0, 3, 0.05, 'punch', 'multiplier on every punch\'s body dip (sit down through the wind-up, drive up at the peak; uppercut 9 cm, hook 5, cross 3, jab 2)'),
  hookReachScale:   num(1, 0.7, 1.4, 0.05, 'punch', 'hook peak reach multiplier: 1 = elbow ~90° at contact, lands to ~0.8 m; higher straightens the arm for range'),
  uppercutReachScale: num(1, 0.7, 1.4, 0.05, 'punch', 'uppercut peak reach multiplier: 1 = elbow ~75°, lands to ~0.66 m; higher straightens the arm for range'),
  punchHoldFrac:    num(0.35, 0, 0.9, 0.05, 'punch', 'fraction of the recover phase the fist holds at full extension before returning (visible straight arm; timing and hit tick unchanged). Cross, hook and uppercut; the body\'s turn and lean hold with it and unwind with the fist. A MISSED punch never holds — it starts home at once over its stretched recovery. Was 0.6: "my cross just stays there and floats" (Nate 2026-09-16)'),
  jabHoldFrac:      num(0.2, 0, 0.9, 0.05, 'punch', 'the jab\'s own hold: a whip touches and is gone. 0.2 of a 0.10 s recovery = one tick on the target (2026-09-16)'),
  punchBuffer:      num(0.3, 0, 1, 0.05, 'punch', 'a punch pressed while one is in flight is remembered this long and thrown the moment it can be, s (0 = dropped, which is what made jab-cross spam skip every other press)'),
  punchChainAt:     num(0.5, 0, 1, 0.05, 'punch', 'after a MISS, the next punch may start this far into the (stretched) recover phase, cutting the tail of the retraction (1 = only after the punch fully finishes; lower = faster combos off a whiff)'),
  punchChainOnHit:  num(0, 0, 1, 0.05, 'punch', 'the hit confirm (2026-09-17): after a punch that TOUCHED something (land or block) the next may start this far into the recovery. 0 = the tick after the hit test — the fist comes home while the other goes out, a 1-2 instead of jab, wait, cross. Was punchChainAt for all punches: the cross pressed at 50 ms started at 217 ms'),
  comboCockScale:   num(0.6, 0.2, 1, 0.05, 'punch', 'a punch thrown INSIDE a chain (the previous still recovering) runs its wind-up this fraction as long: the body is already turned and loaded from the follow-through, so the cross of a 1-2 needs no full pull-back. 1 = every punch winds up from scratch (2026-09-17)'),
  punchBufferDepth: num(2, 1, 3, 1, 'punch', 'how many presses the buffer queues in order while a punch is in flight. 1 = the newest replaces the older (a fast 1-2-3 lost its 2); 2 = a 1-2-3 pressed as fast as you like comes out as a 1-2-3 (2026-09-17)'),

  // ── sim: block (SIM) ──
  blockReduction:   num(0.75, 0, 1, 0.05, 'block', 'fraction of an incoming impulse absorbed by a held block', 'blockReduction'),

  // ── sim: slip (SIM) — flick-vs-hold head movement on the movement stick, ported from legacy fighter.js Stage 5. src/sim/slip.ts ──
  slipInputThreshold: num(0.6, 0.1, 1, 0.05, 'slip', 'stick magnitude that counts as a push; under it the flick detector sees nothing', 'slipInputThreshold'),
  slipFlickMax:     num(0.18, 0.04, 0.5, 0.01, 'slip', 'a lateral push released before this is a FLICK and slips; held past it, it is footwork and never slips, even on release, s (v1: 180 ms)', 'slipFlickMaxDurationMs'),
  slipDuration:     num(0.25, 0.05, 1, 0.01, 'slip', 'the slip window: how long the head stays off the line, s. The block cannot come up inside it (v1 rule)', 'slipInvincibilityDuration'),
  slipHeadOffset:   num(0.33, 0, 0.5, 0.01, 'slip', 'how far the head moves to the side, m — the whole invincibility: the head sphere is simply not where the punch is. One toy-head width. MEASURED: a jab lands 5 cm off the centreline on the lead-hand side, so this must beat headR + gloveR + 0.05 (0.30 at the default body; 0.33 since the swept hit test, 2026-09-16, which removed the 5 mm the point test left) to clear a straight slipped AWAY from the hand; slipped into the hand it still catches the body (v1: 90 px, which at 0.0122 m/px would be 1.1 m — a body teleport, not a slip)', 'slipHeadOffsetX'),
  slipBackOffset:   num(0.28, 0, 0.5, 0.01, 'slip', 'the PULL (2026-09-16, contract addition): a BACK flick takes the head straight back this far, m — the torso winds back from the waist (Fight Night reference). Beats a straight at the edge of its range; a step-in still finds it'),
  slipDip:          num(0.06, 0, 0.15, 0.005, 'slip', 'a lateral slip also dips the head this far, m (the head only — the shoulder end of the capsule stays at height, or a slip INTO the jab hand no longer catches the shoulder) — the knees give as the head goes off the line'),
  slipShoulderFrac: num(0.7, 0, 1, 0.05, 'slip', 'the slip is a bend at the waist: the shoulder end of the body capsule (and the drawn shoulders) move this fraction of the head offset; the hips stay. Below ~0.5 the capsule\'s end cap, which reaches chin height, still catches a slipped jab; above ~0.72 (at slipHeadOffset 0.33) a slip INTO the jab hand no longer catches the shoulder either and the slip loses its direction (slip_test pins it). 0.7 since 2026-09-16 (was 0.6) for the torso bend the rig now draws'),
  slipRise:         num(0.05, 0, 0.2, 0.005, 'slip', 'seconds the head takes to reach the full offset after the flick (the sim moves the sphere; the rig draws it there)'),
  slipReturn:       num(0.12, 0, 0.5, 0.01, 'slip', 'seconds the head takes to come home after the window closes; no new slip until it is back'),

  // ── sim: vulnerability, whiff cost, counters, perfect block, slip punish (SIM) — v1 Stage 16 / 17 / 19, src/sim/vulnerability.ts ──
  vulnerabilityPeak:  num(1, 0, 1, 0.05, 'counter', 'how exposed a fighter is at full extension, 0..1 — the ceiling of the per-punch curve', 'vulnerabilityPeak'),
  vulnerabilityCockLevel: num(0.15, 0, 1, 0.05, 'counter', 'fraction of the peak reached by the END of the wind-up', 'vulnerabilityCockLevel'),
  vulnerabilityRiseShape: num(2, 0.25, 4, 0.05, 'counter', '>1 back-loads the rise: flat through the early cock, steep into the peak', 'vulnerabilityRiseShape'),
  vulnerabilityDecayShape: num(1.2, 0.25, 4, 0.05, 'counter', '>1 drops off quickly after the peak; <1 stays exposed longer through the recovery', 'vulnerabilityDecayShape'),
  whiffRecoveryMult: num(2.2, 1, 6, 0.1, 'counter', 'a punch that misses retracts this many times slower (recover phase only; the cock and extension already happened). Stretches the exposure with it and holds off the next punch AND the guard (v2: the block waits for the punch to end). 1 = missing is free. The single most important number here to feel-test', 'whiffRecoveryMultiplier'),
  jabWhiffScale:    num(0.55, 0, 2, 0.05, 'counter', 'weight on the whiff stretch for a jab: effective = 1 + (whiffRecoveryMult - 1) × weight. Cheapest miss', 'jabWhiffScale'),
  crossWhiffScale:  num(0.85, 0, 2, 0.05, 'counter', 'weight on the whiff stretch for a cross', 'crossWhiffScale'),
  hookWhiffScale:   num(1.15, 0, 2, 0.05, 'counter', 'weight on the whiff stretch for a hook', 'hookWhiffScale'),
  uppercutWhiffScale: num(1.45, 0, 2, 0.05, 'counter', 'weight on the whiff stretch for an uppercut: the most expensive miss', 'uppercutWhiffScale'),
  counterImpulseBonus: num(0.9, 0, 2, 0.05, 'counter', 'a hit on a vulnerable target multiplies the impulse by 1 + vulnerability × this, so damage, stagger and reaction all grow off one number. 0.9 ≈ double at full exposure', 'counterForceBonus'),
  counterHitStopBonus: num(0.05, 0, 0.2, 0.005, 'counter', 'seconds ADDED to the hit-stop on a counter, × the target\'s vulnerability', 'counterHitStopBonus'),
  perfectBlockWindow: num(0.12, 0.02, 0.5, 0.01, 'counter', 'a guard that is younger than this at the impact is a PERFECT block: no health or stamina cost, and the attacker is pinned exposed (the stagger and reaction stay — it absorbs the punch, it does not delete it)', 'perfectBlockWindow'),
  perfectBlockLateFrac: num(0.6, 0, 1, 0.05, 'counter', 'v2 addition: the guard must also be younger than this fraction of the punch\'s flight (cock + extension). A guard raised the instant the punch STARTS is a reaction to the start, not a read of the arrival — without this the AI\'s zero-latency block was perfect every time and each blocked jab bought it a counter (v1 finding, counter_test §4)'),
  perfectBlockPunishVuln: num(0.85, 0, 1, 0.05, 'counter', 'the attacker\'s vulnerability is pinned at (at least) this after a perfect block', 'perfectBlockPunishVulnerability'),
  perfectBlockPunishDuration: num(0.45, 0, 2, 0.05, 'counter', 'seconds that pin is held', 'perfectBlockPunishDuration'),
  perfectBlockHitStop: num(0.05, 0, 0.2, 0.005, 'counter', 'hit-stop on a perfect block, s — deliberately under a counter\'s', 'perfectBlockHitStop'),
  slipPunishVuln:   num(1, 0, 1, 0.05, 'counter', 'the attacker\'s vulnerability is pinned at (at least) this after a punch is slipped. Higher than the perfect block\'s: a slip is a timed flick that commits the head', 'slipPunishVulnerability'),
  slipPunishDuration: num(0.7, 0, 2, 0.05, 'counter', 'seconds that pin is held — long enough to step in and counter after the slip unwinds; the number to argue with first', 'slipPunishDuration'),

  // ── sim: health + stamina + knockdown (SIM) — v1 Stage 6 / 17 on 0..1 bars, impulse in N·s ──
  healthDamagePerImpulse: num(0.0003, 0, 0.005, 0.00005, 'health', 'health lost per N·s of landed impulse (after block reduction and the counter bonus). A standing cross is ~230 N·s → ~0.07, so ~14 clean crosses or ~8 hooks put a fighter down; counters at full exposure nearly double that. Was 0.0009 (~5 crosses, Nate 2026-09-15: "knocked out too fast"), then 0.0005 (still "too much damage", 2026-09-16) (v1: 0.01 per force on a 100 bar)', 'healthDamagePerForce'),
  staminaPunchCost: num(0.04, 0, 0.2, 0.005, 'health', 'stamina spent per punch thrown, lands or not (v1: 4/100)', 'staminaDrainPerPunch'),
  staminaBlockDrain: num(0.08, 0, 0.5, 0.01, 'health', 'stamina drained per second the block is held — a full bar buys 12.5 s of guard. v1 was 2/100 per s, which made turtling free (Nate 2026-09-11: "you can\'t perpetually block")', 'staminaDrainPerSecondBlocking'),
  staminaRegen:     num(0.35, 0, 1, 0.01, 'health', 'stamina regained per second while neither punching nor blocking — an empty bar refills in ~3 s (v1: 20/100; raised from 0.2, Nate 2026-09-11)', 'staminaRegenPerSecond'),
  staminaHitCost:   num(0.00026, 0, 0.002, 0.00001, 'health', 'stamina lost per N·s taken (after block reduction): eating a solid shot costs about what throwing one or two does (v1: 0.012 per force)', 'staminaDrainPerHitForce'),
  staminaBlockedHitMult: num(1, 0, 3, 0.1, 'health', 'multiplier on that hit cost when the shot lands on the guard, on top of blockReduction having already cut the impulse', 'staminaDrainBlockedMult'),
  staminaRegenDelay: num(0.6, 0, 3, 0.05, 'health', 'seconds regen pauses after taking a hit, so a chip is not repaid before the next punch lands', 'staminaRegenDelayAfterHit'),
  lowStamina:       num(0.25, 0, 1, 0.05, 'health', 'stamina below this = gassed: the wind-up telegraphs (next key) and the AI smells it', 'lowStaminaThreshold'),
  lowStaminaCockMult: num(2.5, 1, 5, 0.1, 'health', 'a gassed fighter\'s wind-up (cock phase) takes this many times longer in real time; extend and recover are untouched, so the strike itself is not in slow motion', 'lowStaminaWindupMultiplier'),
  knockdownHealthRestore: num(0.35, 0, 1, 0.05, 'health', 'health on getting up, as a fraction of full', 'knockdownHealthRestorePct'),
  healthRegen:      num(0.06, 0, 0.2, 0.005, 'health', 'health regained per second, up to the cap (2026-09-16, Nate: "health should regenerate"). 0.06 = most of the bar back over a 10 s lull (was 0.03: "regeneration too slow")'),
  healthRegenDelay: num(1.5, 0, 10, 0.1, 'health', 'seconds after taking a hit before health starts coming back — you have to earn the lull'),
  healthCapLoss:    num(0.35, 0, 1, 0.05, 'health', 'Fight Night\'s recoverable health: each hit lowers the CAP health can regenerate to by this fraction of its damage for the rest of the round (the HUD shows the cap as the dim part of the bar). 0 = everything comes back, 1 = nothing does'),

  // ── sim: reaction (SIM) — hit reaction springs, per chain level ──
  // Springs slowed ~2.5x on 2026-09-16 (Nate: "can't feel combinations land" — a hit settled in 0.17–0.37 s, a nod):
  // a landed punch now plays out over ~half a second, with a yaw whip (spin) and the hips lagging the shoulders.
  reactionHeadK:    num(160, 50, 1500, 10, 'reaction', 'head spring stiffness, 1/s² (loosest level). Was 400', 'reactionStiffness'),
  reactionHeadC:    num(9, 2, 60, 0.5, 'reaction', 'head spring damping, 1/s (time constant 2/C ≈ 0.22 s). Was 16', 'reactionDamping'),
  reactionTorsoK:   num(220, 50, 1500, 10, 'reaction', 'torso spring stiffness, 1/s² (stiffer than the head so the chain lags). Was 520'),
  reactionTorsoC:   num(11, 2, 60, 0.5, 'reaction', 'torso spring damping, 1/s. Was 20'),
  reactionTiltK:    num(150, 50, 1500, 10, 'reaction', 'tilt spring stiffness, 1/s². Was 400'),
  reactionTiltC:    num(8, 2, 60, 0.5, 'reaction', 'tilt spring damping, 1/s. Was 16'),
  reactionSpinK:    num(180, 50, 1500, 10, 'reaction', 'spin (yaw whip) spring stiffness, 1/s²'),
  reactionSpinC:    num(9, 2, 60, 0.5, 'reaction', 'spin spring damping, 1/s'),
  reactionSpinScale: num(0.045, 0, 0.1, 0.001, 'reaction', 'rad/s of yaw whip per N·s of sideways impulse (× the punch\'s spin shape) — the head and shoulders turn with a hook'),
  reactionMaxSpin:  num(0.9, 0.1, 2, 0.05, 'reaction', 'hard clamp on the spin, rad'),
  reactionHipFollow: num(0.45, 0, 1, 0.05, 'reaction', 'the hips take this fraction of the torso reaction offset (the shoulders take all of it), so a hit bends the body back from the waist instead of sliding it as a post'),
  reactionForceScale: num(0.024, 0, 0.1, 0.001, 'reaction', 'm/s of rig velocity per N·s of impulse. Was 0.03; the slower springs travel further per kick', 'reactionForceScale'),
  reactionTwistScale: num(0.012, 0, 0.05, 0.001, 'reaction', 'rad/s of tilt velocity per N·s of (impulse × twist)', 'reactionTwistScale'),
  reactionMaxOffset: num(0.49, 0.05, 1, 0.01, 'reaction', 'hard clamp on the torso offset, m (v1: 40 px)', 'reactionMaxOffset'),
  reactionMaxNeck:  num(0.17, 0.02, 0.5, 0.01, 'reaction', 'hard clamp on the head offset relative to the torso, m: how far the head can leave the neck (an uppercut lift was detaching it at the v1 clamp)'),
  reactionMaxTilt:  num(0.6, 0.1, 1.5, 0.05, 'reaction', 'hard clamp on the tilt, rad', 'reactionMaxTilt'),
  jabReactBack:     num(0.7, 0, 2, 0.05, 'reaction', 'jab: head snap along the impulse', 'jabReactBack'),
  jabReactLift:     num(0.15, 0, 2, 0.05, 'reaction', 'jab: upward component', 'jabReactLift'),
  jabReactTwist:    num(0.06, 0, 2, 0.01, 'reaction', 'jab: tilt component', 'jabReactTwist'),
  jabReactTorso:    num(0.05, 0, 1, 0.05, 'reaction', 'jab: fraction bleeding into the torso', 'jabReactTorso'),
  jabReactSnap:     num(1.8, 0.5, 3, 0.05, 'reaction', 'jab: stiffness multiplier (higher = quicker, shorter)', 'jabReactSnap'),
  jabReactSpin:     num(0.15, 0, 2, 0.05, 'reaction', 'jab: yaw whip per unit sideways impulse (a jab arrives nearly straight, so almost none)'),
  crossReactSpin:   num(0.3, 0, 2, 0.05, 'reaction', 'cross: yaw whip'),
  hookReactSpin:    num(1.0, 0, 2, 0.05, 'reaction', 'hook: yaw whip — the head and shoulders turn with the punch, the hook\'s signature'),
  uppercutReactSpin: num(0.3, 0, 2, 0.05, 'reaction', 'uppercut: yaw whip'),
  crossReactBack:   num(1.0, 0, 2, 0.05, 'reaction', 'cross: head snap along the impulse', 'crossReactBack'),
  crossReactLift:   num(0.2, 0, 2, 0.05, 'reaction', 'cross: upward component', 'crossReactLift'),
  crossReactTwist:  num(0.2, 0, 2, 0.01, 'reaction', 'cross: tilt component', 'crossReactTwist'),
  crossReactTorso:  num(0.45, 0, 1, 0.05, 'reaction', 'cross: fraction bleeding into the torso', 'crossReactTorso'),
  crossReactSnap:   num(1.15, 0.5, 3, 0.05, 'reaction', 'cross: stiffness multiplier', 'crossReactSnap'),
  hookReactBack:    num(0.55, 0, 2, 0.05, 'reaction', 'hook: head snap along the impulse (which for a hook is mostly sideways)', 'hookReactBack'),
  hookReactLift:    num(0.1, 0, 2, 0.05, 'reaction', 'hook: upward component', 'hookReactLift'),
  hookReactTwist:   num(1.0, 0, 2, 0.01, 'reaction', 'hook: tilt component — the hook\'s signature', 'hookReactTwist'),
  hookReactTorso:   num(0.4, 0, 1, 0.05, 'reaction', 'hook: fraction bleeding into the torso', 'hookReactTorso'),
  hookReactSnap:    num(1.0, 0.5, 3, 0.05, 'reaction', 'hook: stiffness multiplier', 'hookReactSnap'),
  uppercutReactBack: num(0.35, 0, 2, 0.05, 'reaction', 'uppercut: head snap along the impulse (barely — it goes up)', 'uppercutReactBack'),
  uppercutReactLift: num(0.35, 0, 2, 0.05, 'reaction', 'uppercut: upward component — the story of this punch (v1: 0.58, which in metres lifted the chest 20 cm off the hips)', 'uppercutReactLift'),
  uppercutReactTwist: num(0.35, 0, 2, 0.01, 'reaction', 'uppercut: tilt component (a lean back, not a whip)', 'uppercutReactTwist'),
  uppercutReactTorso: num(0.4, 0, 1, 0.05, 'reaction', 'uppercut: fraction bleeding into the torso (v1: 0.75, to keep the head on; reactionMaxNeck does that now)', 'uppercutReactTorso'),
  uppercutReactSnap: num(0.9, 0.5, 3, 0.05, 'reaction', 'uppercut: stiffness multiplier (slowest to settle)', 'uppercutReactSnap'),
  staggerDecay:     num(8, 1, 40, 0.5, 'reaction', 'decay rate of the floor velocity injected by an impact, 1/s — lower = a longer stumble, and the feet take a real step to catch it. Was 15 (v1: friction / playerMass), a short slide', 'friction'),

  // ── sim: chain (SIM) — the kinetic chain that carries each glove to its target ──
  chainK:           num(2500, 200, 8000, 50, 'chain', 'glove spring stiffness at guard, 1/s²'),
  chainC:           num(80, 10, 300, 1, 'chain', 'glove spring damping at guard, 1/s'),
  chainPunchK:      num(6, 1, 10, 0.25, 'chain', 'stiffness multiplier on the punching hand through cock + extend (damping scales by its root)'),
  chainRecoverK:    num(1.5, 1, 10, 0.25, 'chain', 'stiffness multiplier on the punching hand through recovery (cross, hook, uppercut); >1 lets the fist reach full extension before it is pulled home'),
  jabChainRecoverK: num(5, 1, 10, 0.25, 'chain', 'the jab\'s recovery stiffness: the fist is snapped home nearly as hard as it was thrown (chainPunchK 6), so it does not float back (2026-09-16, the whip)'),
  chainArrive:      num(0.8, 0.3, 1, 0.05, 'chain', 'the punching hand\'s TARGET reaches the peak at this fraction of the extend phase and waits there, so the glove (a spring that lags a fast target by several cm) has settled onto the peak by the hit test. At 1 a hook\'s reach depended on where the tick grid fell (2026-09-16)'),
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
  countTickSeconds: num(0.5, 0.2, 1.5, 0.05, 'fight', 'seconds per count of the referee\'s 10-count (both fighters freeze, the clock holds). 0.5 = a 5 s count; 1 = real time (was a flat 2.5 s knockdownDuration)'),
  getUpCountBest:   num(3, 1, 9, 0.5, 'fight', 'the count a chin-100 fighter rises on, first knockdown of the round (the sim/round.ts get-up roll)'),
  getUpCountWorst:  num(9, 1, 12, 0.5, 'fight', 'the count a chin-0 fighter rises on; 10 or more = does not get up (KO)'),
  getUpCountPerKnockdown: num(1.5, 0, 5, 0.5, 'fight', 'counts added per earlier knockdown in the same round — the third knockdown of a round is usually a KO before it is a TKO'),
  getUpJitter:      num(1, 0, 3, 0.5, 'fight', '± counts of seeded randomness on the get-up roll, so a fight is not a spreadsheet'),
  betweenRoundHealthRestore: num(0.1, 0, 1, 0.05, 'fight', 'fraction of the MISSING health that comes back on the stool between rounds'),
  betweenRoundStaminaRestore: num(0.6, 0, 1, 0.05, 'fight', 'fraction of the MISSING stamina that comes back between rounds'),
  scorePowerWeight: num(0.005, 0, 0.02, 0.0005, 'fight', 'judges: a round is scored on clean landed punches + summed impulse × this (a 230 N·s cross counts 1 + 1.15). 10-point-must: winner 10, loser 9, −1 per knockdown suffered, 10-10 if level. Control is not scored yet'),

  // ── ai (SIM: src/ai) — the opponent's four heuristics, ported from legacy dummy.js at 1 px = 0.0122 m ──
  aiEnabled:        bool(true, 'ai', 'side 1 is driven by the AI (off = the frozen-guard dummy; ?ai=0 in the URL sets this at boot)'),
  aiSpeedScale:     num(0.85, 0, 1, 0.05, 'ai', 'the AI walks at this fraction of moveSpeed so the player can always make distance (v1: 170 / 200)', 'dummyMoveSpeed'),
  aiStandoffDist:   num(0.72, 0.4, 1.5, 0.01, 'ai', 'centre-to-centre distance it tries to hold, m. Coming in from far it rests at standoff + band, which must sit inside aiEngageDist or it never throws (v1: 64 px)', 'dummyStandoffDist'),
  aiStandoffBand:   num(0.12, 0.02, 0.5, 0.01, 'ai', 'hysteresis half-width around the standoff inside which it stops steering — the anti-jitter knob (v1: 12 px)', 'dummyStandoffBand'),
  aiEngageDist:     num(0.9, 0.5, 1.5, 0.01, 'ai', 'farthest distance it commits a straight at, and inside which it bothers reacting with its guard. MEASURED: its jab lands to 0.97 m, cross to 0.99; set under that so a step back during the wind-up still connects (v1: 78 px)', 'dummyEngageDist'),
  aiHookEngageDist: num(0.78, 0.4, 1.2, 0.01, 'ai', 'farthest distance it commits a hook at. MEASURED: lands to 0.84 m'),
  aiUppercutEngageDist: num(0.6, 0.4, 1.2, 0.01, 'ai', 'farthest distance it commits an uppercut at. MEASURED: lands to 0.65 m'),
  aiJabWeight:      num(4, 0, 10, 0.5, 'ai', 'relative odds the armed punch is a jab (0 = never)'),
  aiCrossWeight:    num(2, 0, 10, 0.5, 'ai', 'relative odds the armed punch is a cross'),
  aiHookWeight:     num(2, 0, 10, 0.5, 'ai', 'relative odds the armed punch is a hook (either hand, coin flip)'),
  aiUppercutWeight: num(1, 0, 10, 0.5, 'ai', 'relative odds the armed punch is an uppercut (either hand, coin flip)'),
  aiStepIn:         num(2, 0, 4, 0.5, 'ai', 'armed with a punch it is too far out for, it walks in to (that punch\'s engage distance − this many standoff bands) and throws on the way; 0 = waits for the player to come to it'),
  aiAttackDelayMin: num(1.5, 0.1, 10, 0.1, 'ai', 'shortest gap before the next punch is ARMED, s — the throw itself still waits for range', 'dummyAttackDelayMin'),
  aiAttackDelayMax: num(3.5, 0.1, 10, 0.1, 'ai', 'longest gap before the next punch is armed, s', 'dummyAttackDelayMax'),
  aiBlockChance:    num(0.35, 0, 1, 0.05, 'ai', 'probability it answers an in-range punch by raising its guard', 'dummyBlockReactionChance'),
  aiBlockWindow:    num(0.45, 0.05, 2, 0.05, 'ai', 'seconds the reactive guard stays up once raised (also covers follow-ups thrown inside it)', 'dummyBlockReactionWindow'),
  aiAggressionMult: num(1.8, 1, 4, 0.1, 'ai', 'the attack timer drains this much faster against an unguarded in-range opponent, and again against a gassed one (they stack)', 'dummyOpeningAggressionMultiplier'),
  // Footwork modes (2026-09-16, Nate: "magnetized to me, not giving me an inch of space"). Fight Night / UFC AI picks
  // a spacing behaviour per style rather than holding one distance; here the AI rolls a mode on a timer:
  // PRESS (the old standoff steer), PROBE (sits just outside its jab, steps in to throw, drifts back out),
  // CIRCLE (lateral movement, loose range), HOLD (stands still a beat), and RESET (steps out of range after
  // an exchange). Zero every weight but press and it is the old AI.
  aiLookahead:      num(0.15, 0, 0.5, 0.01, 'ai', 'the steer acts on where it WILL be this many seconds on at its closing speed, so it decelerates into range instead of gliding through it (≈ 1 / moveFriction)'),
  aiPressWeight:    num(4, 0, 10, 0.5, 'ai', 'relative odds the next footwork mode is PRESS: close to aiStandoffDist and fight there'),
  aiProbeWeight:    num(3, 0, 10, 0.5, 'ai', 'relative odds of PROBE: hold aiProbeDist, out of range, and step in only to throw'),
  aiCircleWeight:   num(3, 0, 10, 0.5, 'ai', 'relative odds of CIRCLE: move laterally around the opponent at a loose standoff'),
  aiHoldWeight:     num(1.5, 0, 10, 0.5, 'ai', 'relative odds of HOLD: stop steering for a beat (a look, a feint that never comes)'),
  aiModeMin:        num(0.8, 0.1, 5, 0.1, 'ai', 'shortest a press / probe / circle mode lasts, s'),
  aiModeMax:        num(2.4, 0.1, 6, 0.1, 'ai', 'longest a press / probe / circle mode lasts, s'),
  aiHoldMax:        num(0.8, 0.1, 3, 0.1, 'ai', 'a HOLD lasts 0.3 s to this, s'),
  aiProbeDist:      num(1.05, 0.6, 1.6, 0.01, 'ai', 'PROBE standoff, m — just outside its own jab (aiEngageDist 0.9), so the player has space and it has to step in to score'),
  aiCircleSpeed:    num(0.7, 0, 1, 0.05, 'ai', 'lateral stick while circling, 0..1 (× aiSpeedScale × moveLateralScale in the sim)'),
  aiResetChance:    num(0.4, 0, 1, 0.05, 'ai', 'after landing or missing a punch, odds it RESETS: steps out to aiResetDist before choosing the next mode'),
  aiHitResetChance: num(0.5, 0, 1, 0.05, 'ai', 'after taking a solid shot (health drop ≥ aiHitResetDamage in a tick), odds it resets'),
  aiHitResetDamage: num(0.04, 0, 0.3, 0.005, 'ai', 'the health drop in one tick that counts as a solid shot (a clean cross ≈ 0.12)'),
  aiResetDist:      num(1.3, 0.8, 2, 0.01, 'ai', 'RESET standoff, m — out of everyone\'s range'),
  aiResetTime:      num(1.0, 0.2, 4, 0.1, 'ai', 'seconds a reset lasts before the next mode is rolled'),
  aiTiredFootwork:  num(0.3, 0, 1, 0.05, 'ai', 'CIRCLE weight multiplier at zero stamina (1 at full): a gassed fighter goes flat-footed (Undisputed\'s loose → flat movement)'),
  // Reading the opponent (2026-09-16): nothing it does is instant, and it responds to what the player DOES, not where they are.
  aiReactionTime:   num(0.2, 0, 0.6, 0.01, 'ai', 'human reaction time, s: its guard comes up this long after it notices a punch (a jab is through before the hands move; a hook meets the guard), and it steers by where it SAW the player this long ago (a lag, so a step-in gets a beat before it answers). 0 = the old tick-after AI. SF2\'s input-reading "reactions" read as cheating; this is the opposite'),
  aiPressureSpeed:  num(1.0, 0.2, 3, 0.05, 'ai', 'the player closing faster than this, m/s, is a RUSH it responds to; backing off faster than this is a RETREAT it declines to chase for aiChaseDelay'),
  aiGiveGroundChance: num(0.5, 0, 1, 0.05, 'ai', 'on a rush: odds it gives ground (standoff + aiGiveGround for aiGiveGroundTime); otherwise it stands and fires (a jab is armed on the spot to meet them coming in)'),
  aiGiveGround:     num(0.3, 0, 1, 0.05, 'ai', 'how far the standoff steps out while giving ground, m'),
  aiGiveGroundTime: num(0.6, 0.1, 3, 0.1, 'ai', 'seconds it gives ground for'),
  aiPressureCooldown: num(1.0, 0.1, 5, 0.1, 'ai', 'seconds before it responds to another rush'),
  aiChaseDelay:     num(0.4, 0, 2, 0.05, 'ai', 'after the player backs off fast it does not close the gap for this long — the space opens before it follows'),
  aiComboChance:    num(0.5, 0, 1, 0.05, 'ai', 'odds a throw opens a BURST: up to aiComboMax punches chained through the sim\'s combo window, then the usual wait (and the reset roll). Bursts and lulls, not a metronome'),
  aiComboMax:       num(3, 1, 5, 1, 'ai', 'most punches in a burst'),
  aiComboGap:       num(0.05, 0, 1, 0.01, 'ai', 'seconds before the next punch of a burst is armed (it still waits for range and the chain window)'),

  // ── debug (UI) ──
  debugHitboxes:    bool(false, 'debug', 'draw sim hit spheres and capsules'),
  debugSkeleton:    bool(false, 'debug', 'draw rig joints and bones'),
  debugFps:         bool(true, 'debug', 'show the frame-time overlay'),
  sparRestartSeconds: num(2, 0, 10, 0.5, 'debug', 'sparring shell: seconds after the fight ends (decision, KO or TKO) before a fresh one starts (0 = never; the Stage 3 menus replace this)'),

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
  rigElbowPoleOut:         num(0.4, 0, 2, 0.05, 'rig', 'elbow pole vector outward (away from torso) weight'),
  rigElbowPoleBack:        num(-0.6, -2, 2, 0.05, 'rig', 'elbow pole vector backward weight; negative = forward, which tucks the elbow in front of the ribs when the glove is up'),
  rigElbowClearance:       num(1.02, 1, 1.6, 0.01, 'rig', 'min elbow distance from the torso axis as a multiple of bodyR + forearm radius (1 = elbow may rest on the ribs)'),
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
  rigHipK:                 num(700, 20, 1200, 10, 'rig', 'hip sway / hip turn spring stiffness, 1/s² (stiffest link). 700 settles in ~0.07 s so the hips actually reach the sim\'s turn inside a 0.15 s cross; was 380 (2026-09-16, "the body doesn\'t twist enough")'),
  rigHipZeta:              num(0.55, 0.1, 1.5, 0.01, 'rig', 'hip sway damping ratio (<1 overshoots)'),
  rigSpineK:               num(240, 20, 1200, 10, 'rig', 'spine bend spring stiffness'),
  rigSpineZeta:            num(0.5, 0.1, 1.5, 0.01, 'rig', 'spine bend damping ratio'),
  rigShoulderK:            num(400, 20, 1200, 10, 'rig', 'shoulder line spring stiffness. At 150 the shoulders had a 0.2 s time constant and reached ~half the sim\'s twist before a cross was already unwinding; 480 settles in ~0.09 s (2026-09-16)'),
  rigShoulderZeta:         num(0.5, 0.1, 1.5, 0.01, 'rig', 'shoulder line damping ratio (<1 = the shoulders overshoot the turn a touch, the follow-through)'),
  rigElbowK:               num(110, 20, 1200, 10, 'rig', 'elbow pole spring stiffness (loosest link)'),
  rigElbowZeta:            num(0.5, 0.1, 1.5, 0.01, 'rig', 'elbow pole damping ratio'),
  rigTwinSkew:             num(0.12, 0, 0.5, 0.01, 'rig', 'right-side springs are this fraction stiffer than left so limbs never twin'),
  rigLeanHip:              num(0.03, 0, 0.3, 0.005, 'rig', 'EXTRA hip forward shift per unit lean.fwd, m, on top of the sim\'s punchLeanShift (which now moves the boxes the rig draws on). Small: the hips lag the chest'),
  rigLeanChest:            num(0.02, 0, 0.3, 0.005, 'rig', 'extra chest forward shift per unit lean.fwd, m (the sim carries the rest)'),
  rigLeanLat:              num(0.09, 0, 0.3, 0.005, 'rig', 'hip lateral shift per unit lean.lat, m — a hook carries the weight across to the other foot, an uppercut loads over the punching hip. Was 0.05 (2026-09-16)'),
  rigLeanRollDeg:          num(10, 0, 20, 0.5, 'rig', 'chest rolls about the forward axis this much per unit lean.lat, degrees: the shoulders go with the weight (2026-09-16)'),
  rigLeanTiltDeg:          num(16, 0, 40, 0.5, 'rig', 'chest pitch per unit lean.fwd, degrees, on top of the bend the sim\'s lean shift already puts in the torso (rigTorsoBend). 16 × a cross\'s 0.7 = 11° plus ~7° of bend over the front knee (Tyson reference)'),
  rigHitHeadSpin:          num(1.5, 0, 3, 0.1, 'rig', 'on a hit the drawn head yaws this multiple of the sim\'s spin (the shoulders yaw 1×): the head whips further than the body on a hook'),
  rigTorsoBend:            num(1, 0, 1.5, 0.05, 'rig', 'the chest mesh follows the hip→shoulder line of the sim\'s body capsule by this fraction: a slip, a pull, a lean and a hit all BEND the torso instead of shearing it (2026-09-16, "the torso winds back" — Fight Night slip reference). 0 = the old upright chest'),
  rigPunchShoulderReach:   num(0.07, 0, 0.15, 0.005, 'rig', 'the punching shoulder rolls FORWARD out of the chest this far at full lean (scapular reach — the stretch in a Fight Night jab), the other shoulder half as far back, m'),
  rigPunchChinTuckDeg:     num(12, 0, 30, 1, 'rig', 'the head pitches down this much at full lean on a punch (chin behind the shoulder), degrees'),
  rigBreathHz:             num(0.28, 0.05, 1, 0.01, 'rig', 'breathing rate'),
  rigBreathAmp:            num(0.03, 0, 0.1, 0.005, 'rig', 'chest scale swell per breath'),
  rigSwayHz:               num(0.42, 0.05, 2, 0.01, 'rig', 'idle weight-shift rate'),
  rigSwayAmp:              num(0.012, 0, 0.05, 0.001, 'rig', 'idle weight-shift lateral amplitude, m'),
  rigBobAmp:               num(0.006, 0, 0.03, 0.001, 'rig', 'idle hip bob amplitude, m'),
  rigRhythmHz:             num(1.7, 0.5, 4, 0.05, 'rig', 'the boxer\'s bounce: beats per second the knees pump at while standing/moving (side 1 runs 6% slower so the two never sync)'),
  rigRhythmBob:            num(0.035, 0, 0.08, 0.002, 'rig', 'bounce depth: how far the hips drop on each beat, m (feet are planted, so the knees bend). 2 cm read as too little (Nate, 2026-09-11)'),
  rigRhythmSway:           num(0.022, 0, 0.06, 0.001, 'rig', 'weight shift: hips move this far foot to foot, every other beat, m'),
  rigRhythmFwd:            num(0.012, 0, 0.04, 0.001, 'rig', 'front/back rock of the hips with the weight shift, m'),
  rigRhythmHead:           num(0.8, 0, 1.5, 0.05, 'rig', 'the head follows this fraction of the bounce and weave, lagging a little (drawn head leaves the sim\'s head sphere by at most rhythmBob × this)'),
  rigRhythmRoll:           num(3, 0, 8, 0.5, 'rig', 'chest rolls this much over the loaded foot on each weight shift, degrees'),
  rigRhythmFade:           num(1, 0, 1, 0.05, 'rig', 'how completely the rhythm stops while punching or blocking (1 = fully; 0 = it never stops)'),
  rigWeaveAmp:             num(0.045, 0, 0.1, 0.005, 'rig', 'head off the centre line (2026-09-16): the drawn head weaves this far side to side at rest, m, on a slow asymmetric loop; the shoulders go 0.6 of it, the hips stay. Non-hitbox (the sim\'s head sphere holds), fades with the rhythm while punching/blocking/tired'),
  rigWeaveFwd:             num(0.02, 0, 0.06, 0.005, 'rig', 'the weave\'s front/back component, m'),
  rigWeaveHz:              num(0.45, 0.1, 2, 0.05, 'rig', 'weave rate; a 1.7× harmonic makes it a figure, not a metronome'),
  rigMoveHeadLead:         num(0.03, 0, 0.1, 0.005, 'rig', 'circling: the drawn head leads the travel sideways by this much at top lateral speed, m — the upper body goes first'),
  rigShuffleLead:          num(1.3, 0.5, 2, 0.05, 'rig', 'circling: the leading foot\'s sideways step reaches this multiple of the forward step lead (a longer pivot step); the drag foot is unchanged'),
  rigRhythmTired:          num(0.25, 0, 1, 0.05, 'rig', 'the bounce at ZERO stamina as a fraction of fresh (linearly in between): a gassed fighter goes flat-footed and the head stops riding (2026-09-16)'),
  rigFallGravity:          num(5, 1, 15, 0.25, 'rig', 'knockdown: the legs give way and the hips fall to the canvas under this acceleration, m/s² (real is 9.8; lower reads heavier and slower on a toy figure)'),
  rigFallTip:              num(8, 1, 30, 0.5, 'rig', 'knockdown: the torso tips about the hips along the punch\'s impulse line with this angular acceleration, rad/s² (8 → lying in ~0.6 s)'),
  rigFallSlide:            num(0.35, 0, 0.8, 0.01, 'rig', 'knockdown: how far the hips travel along the fall line as they drop, m (the feet stay, so the legs fold)'),
  rigFallHeadLag:          num(0.3, 0, 1, 0.05, 'rig', 'knockdown: the head whips this fraction further than the torso before the canvas stops it'),
  rigFallLift:             num(0.12, 0, 0.3, 0.01, 'rig', 'knockdown by an uppercut: the body rises this far first (head punched up), then collapses back, m'),
  rigFallLiftTime:         num(0.3, 0.05, 0.8, 0.05, 'rig', 'knockdown by an uppercut: seconds of that lift before the legs go'),
  rigFallHookSpin:         num(40, 0, 120, 5, 'rig', 'knockdown by a hook: the body turns this far with the punch as it goes down sideways, degrees'),
  rigFallBounce:           num(0.06, 0, 0.2, 0.01, 'rig', 'knockdown: the torso bounces this much (rad) as it hits the canvas, damped out over ~0.4 s'),
  rigGetUpTime:            num(0.8, 0.2, 3, 0.05, 'rig', 'seconds the rig takes to rise from the canvas back to the stance after the sim\'s get-up'),
  rigStepThreshold:        num(0.12, 0.02, 0.4, 0.01, 'rig', 'a foot steps once its rest spot drifts this far, m'),
  rigStepDur:              num(0.22, 0.08, 0.6, 0.01, 'rig', 'step duration, s'),
  rigStepLift:             num(0.05, 0, 0.15, 0.005, 'rig', 'foot lift mid-step, m'),
  rigStepLead:             num(0.15, 0, 0.5, 0.01, 'rig', 'the leading foot\'s step lands this many seconds ahead along vel'),
  rigTrailStepScale:       num(0.8, 0.3, 1.5, 0.05, 'rig', 'footwork: the trailing foot drags up to the stance in this fraction of a step\'s time (and at 0.6 of its lift). Forward: lead foot steps, rear drags; back: rear steps, lead drags; sideways: the near foot steps, the far foot drags — never crossing (2026-09-16)'),
  rigShuffleScale:         num(0.75, 0.3, 1.5, 0.05, 'rig', 'footwork: sideways steps are shuffles — this fraction of a step\'s time, half its lift'),
  rigStepSurge:            num(0.03, 0, 0.1, 0.005, 'rig', 'footwork: the hips surge this far along the travel through each step of the LEADING foot (the push off the other foot), m'),
  rigStepBob:              num(0.02, 0, 0.06, 0.002, 'rig', 'footwork: the hips rise this much mid-step (up on the planted foot\'s toes) and sit back down on the plant, m'),
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
  rigElbowFlareBias:       num(0.1, 0, 1, 0.05, 'rig', 'elbow flare at shoulder height (0 = elbows tucked down at guard, higher = winged out)'),
  rigHookElbowLevel:       num(1, 0, 1, 0.05, 'rig', 'during a hook the punching elbow rises to the glove line and the pole goes level: 1 = arm flat to the floor, 0 = the guard\'s dropped elbow'),
  rigHookDrive:            num(1.6, 1, 3, 0.05, 'rig', 'during a hook, hips, head and the punching-side foot follow the twist this much harder than on a straight'),
  rigUppercutElbowBack:    num(0.8, 0, 2, 0.05, 'rig', 'during an uppercut the punching elbow pole points this far BACK, so the arm folds with the fist up by the ribs instead of the forearm aiming at the body'),
  rigBlockTiltDeg:         num(18, 0, 30, 0.5, 'rig', 'chest pitches forward this much while blocking (the hunch), degrees. Was 10: guard and block looked alike (Nate 2026-09-16)'),
  rigBlockShrug:           num(0.05, 0, 0.1, 0.005, 'rig', 'shoulders rise this much while blocking, m'),
  rigBlockChinTuckDeg:     num(18, 0, 40, 1, 'rig', 'the head pitches down this much while blocking (chin behind the gloves), degrees — the drawn head only; the sim\'s head sphere stays'),
  rigPunchHipFollow:       num(0.7, 0, 1, 0.05, 'rig', 'hips turn this fraction of the sim torso twist (through the hip spring, so they lead the shoulders). 0.6: a cross turns the hips ~35°, a hook (× rigHookDrive) ~70°. Was 0.45 (2026-09-16)'),
  rigPunchFootPivot:       num(1.3, 0, 2, 0.05, 'rig', 'the pivoting foot turns this multiple of the hip turn on the ball of the foot (heel swings out, knee follows in). >1: the foot turns further than the hips, as it does. Was 0.9 (2026-09-16)'),
  rigPunchLeadFootPivot:   num(0.3, 0, 2, 0.05, 'rig', 'lead foot pivots this multiple of the hip turn on a straight (on a lead hook it becomes the pivot foot and uses rigPunchFootPivot)'),
  rigPivotBall:            num(0.5, 0, 0.72, 0.02, 'rig', 'where the pivot point sits along the boot, as a fraction of its length forward of the ankle (0 = pivots on the ankle, 0.5 = the ball of the foot, 0.72 = the toe)'),
  rigPunchHeelLift:        num(0.06, 0, 0.15, 0.005, 'rig', 'the pivoting foot\'s heel rises this much through the drive, m (toe stays down): the rear foot on a straight, the punching-side foot on a hook. Down through the load'),
  rigHeelLiftLean:         num(0.25, 0.05, 1, 0.05, 'rig', 'the forward lean (sim lean.fwd) at which the heel is fully up; a cross peaks at 0.5, an uppercut at 0.2'),
  rigMoveLeanDeg:          num(7, 0, 20, 0.5, 'rig', 'walking: the chest pitches into the direction of travel this much at top speed, degrees (forward = lean in, back = lean away, sideways = roll over the leading foot). 2026-09-16, movement feel'),
  rigMoveLeanShift:        num(0.05, 0, 0.15, 0.005, 'rig', 'walking: the hips shift this far into the direction of travel at top speed, m — the weight goes where the fighter is going, so the legs trail'),
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

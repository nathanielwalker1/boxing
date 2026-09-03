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

  // ── sim: movement (SIM) — values are placeholders until SIM ports legacy movement ──
  moveSpeed:        num(1.6, 0.5, 4, 0.05, 'movement', 'top walking speed, m/s', 'moveSpeed'),
  moveAccel:        num(14, 2, 40, 0.5, 'movement', 'acceleration toward the input velocity, m/s²', 'acceleration'),
  moveFriction:     num(10, 1, 30, 0.5, 'movement', 'velocity decay with no input, 1/s', 'friction'),
  turnRate:         num(9, 1, 30, 0.5, 'movement', 'max yaw turn rate toward the opponent, rad/s'),
  separationDist:   num(0.55, 0.3, 1, 0.01, 'movement', 'minimum centre-to-centre distance, m', 'bodySeparation'),

  // ── sim: time (SIM) ──
  hitStopScale:     num(0.05, 0, 0.5, 0.01, 'time', 'sim time rate during hit-stop (0 = frozen)', 'hitStopTimeScale'),
  hitStopBase:      num(0.06, 0, 0.3, 0.005, 'time', 'hit-stop duration on a clean land, s', 'hitStopDuration'),

  // ── fight (SIM) ──
  roundCount:       num(6, 1, 12, 1, 'fight', 'rounds per fight'),
  roundSeconds:     num(60, 10, 180, 5, 'fight', 'seconds per round'),
  betweenRoundSeconds: num(10, 3, 30, 1, 'fight', 'between-round card duration, s'),
  knockdownsForTko: num(3, 1, 5, 1, 'fight', 'knockdowns in one round = TKO'),

  // ── debug (UI) ──
  debugHitboxes:    bool(false, 'debug', 'draw sim hit spheres and capsules'),
  debugSkeleton:    bool(false, 'debug', 'draw rig joints and bones'),
  debugFps:         bool(true, 'debug', 'show the frame-time overlay'),
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

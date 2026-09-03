/**
 * core/types.ts — the shared vocabulary. Every workstream imports from here;
 * nothing imports into here. Frozen after Stage 0: additions go through the
 * orchestrator as a core patch, never by a workstream editing this file.
 *
 * Conventions (CONTRACT §3 + 2026-09-02 additions):
 *   - metres / seconds, y up, ring floor is x/z at y = 0
 *   - `yaw` is the direction a fighter faces on the floor: forward = (cos yaw, sin yaw)
 *     in (x, z). Right-hand side = (-sin yaw, cos yaw). See math.ts `frameOf`.
 *   - the sim owns every hitbox; the rig draws them where the sim says they are
 */

// ── Primitive geometry ────────────────────────────────────────────────────────

export interface Vec2 { x: number; z: number }            // a point / vector on the floor
export interface Vec3 { x: number; y: number; z: number }
export interface Sphere extends Vec3 { r: number }
export interface Capsule { a: Vec3; b: Vec3; r: number }  // segment a→b swept by r

// ── Input ─────────────────────────────────────────────────────────────────────

/**
 * One frame of intent for one fighter. Opponent-relative: `move.y` > 0 is toward
 * the opponent, `move.x` > 0 is to the fighter's own right. Magnitude ≤ 1.
 * Punch flags are levels; the sim edge-triggers them. `block` is a level.
 */
export interface FrameInput {
  move: { x: number; y: number };
  jab: boolean; cross: boolean; hook: boolean; uppercut: boolean;
  block: boolean;
}

export const NULL_INPUT: Readonly<FrameInput> = Object.freeze({
  move: Object.freeze({ x: 0, y: 0 }),
  jab: false, cross: false, hook: false, uppercut: false, block: false,
});

export function cloneInput(i: Readonly<FrameInput>): FrameInput {
  return { move: { x: i.move.x, y: i.move.y }, jab: i.jab, cross: i.cross, hook: i.hook, uppercut: i.uppercut, block: i.block };
}

// ── Fighter definition (CONTRACT §5) ──────────────────────────────────────────

export type Stance = 'orthodox' | 'southpaw';
export type Build  = 'lean' | 'athletic' | 'heavy';
export type AiStyle = 'pressure' | 'counter' | 'outboxer' | 'swarmer' | 'slugger';

export interface FighterSpec {
  id: string; name: string; nickname: string; hometown: string;
  stance: Stance;
  heightM: number;   // 1.60 – 2.00
  reachM: number;    // wingspan
  massKg: number;
  build: Build;
  skin: string; trunksPrimary: string; trunksSecondary: string;
  trunksStyle: 'short' | 'long' | 'belt';
  gloves: string; boots: string;
  hair: 'none' | 'short' | 'afro' | 'braids' | 'long' | 'mohawk';
  facialHair: 'none' | 'goatee' | 'beard';
  tattoos?: ('chest' | 'back' | 'leftArm' | 'rightArm')[];
  power: number; speed: number; chin: number; stamina: number; defense: number; // 0–100
  style: AiStyle;
}

/** Sizes derived once from a FighterSpec (core/body.ts). Sim and rig both read these. */
export interface BodyDims {
  heightM: number; reachM: number; massKg: number;
  headR: number; gloveR: number; bodyR: number;
  shoulderW: number; hipW: number;
  neckLen: number; chestLen: number; spineLen: number;   // chest→neck, spine top→chest, hips→spine top
  upperArm: number; forearm: number;
  thigh: number; shin: number; bootH: number;
  hipY: number;       // rest height of the hip joint above the floor
  headY: number;      // rest height of the head centre
  shoulderY: number;  // rest height of the shoulder joints
}

// ── Sponsors (CONTRACT §9) ────────────────────────────────────────────────────

export type SlotId = 'matCenter' | 'matCorners' | 'apronFront' | 'apronSides' | 'postPads' | 'roundCard' | 'introBanner';
export interface Sponsor { id: string; name: string; primary: string; secondary: string; logoSvg?: string; slots: SlotId[] }

// ── Sim state ─────────────────────────────────────────────────────────────────

export type Hand = 'lead' | 'rear';
export type Side = 0 | 1;                                   // index into SimState.fighters
export type PunchType = 'jab' | 'cross' | 'hook' | 'uppercut';
export type PunchPhase = 'idle' | 'cock' | 'extend' | 'recover';
export type GuardId = 'rest' | 'high' | 'block' | 'down';   // what the arms do when not punching

export interface Spring1 { x: number; v: number }
export interface Spring3 { x: number; y: number; z: number; vx: number; vy: number; vz: number }

export interface RngState { s0: number; s1: number; s2: number; s3: number }

export interface PunchState {
  type: PunchType | null;
  hand: Hand;
  phase: PunchPhase;
  t: number;          // seconds into the current phase
  progress: number;   // 0..1 across the whole punch (cock→recover)
  resolved: boolean;  // hit test already run for this punch
}

export interface SlipState {
  active: boolean;
  dir: -1 | 0 | 1;      // -1 = toward lead side, +1 = toward rear side
  t: number;            // seconds since the flick
  offset: number;       // current lateral head offset in metres (signed by dir)
}

export interface GloveState {
  /** World-space glove centre — THE hit sphere (with BodyDims.gloveR). */
  pos: Vec3;
  vel: Vec3;
  /** Where the kinetic chain is pulling it this tick (world space). */
  target: Vec3;
}

export interface ReactionState {
  head: Spring3;    // head offset from its rest position, metres
  torso: Spring3;   // torso offset
  tilt: Spring1;    // torso tilt about the lateral axis, radians
}

export interface FighterState {
  specId: string;
  body: BodyDims;
  stance: Stance;

  // locomotion
  pos: Vec2;          // hip projection on the floor
  vel: Vec2;
  yaw: number;        // faces the opponent; sim turns it, never snaps
  lean: { fwd: number; lat: number };   // weight transfer, -1..1, drives punch force and rig
  torsoTwist: number;                   // radians about y, from punches

  // resources
  health: number;     // 0..1
  stamina: number;    // 0..1

  // actions
  block: boolean;
  blockT: number;         // seconds block has been held (perfect-block window)
  guard: GuardId;
  punch: PunchState;
  slip: SlipState;
  /** Recent `move` samples for flick-vs-hold detection. Opaque outside the sim. */
  moveHist: number[];
  vuln: number;           // 0..1 vulnerability curve (legacy vulnerability.js)
  counterWindow: number;  // seconds remaining in which a landed punch counts as a counter

  // physical response
  gloves: [GloveState, GloveState];   // index 0 = lead, 1 = rear
  reaction: ReactionState;
  stagger: Vec2;          // floor velocity injected by impacts (decays)

  // knockdowns
  down: boolean;
  downT: number;          // seconds on the canvas
  knockdowns: number;     // this round

  // ── derived every step by the sim, read by rig/render/ai — never written elsewhere
  headBox: Sphere;
  bodyBox: Capsule;
}

export type RoundPhase = 'intro' | 'fighting' | 'between' | 'count' | 'over';

export interface RoundState {
  index: number;       // 0-based
  clock: number;       // seconds remaining
  phase: RoundPhase;
  phaseT: number;      // seconds in the current phase
  score: [number, number][];   // per completed round, 10-point-must
}

export interface SimState {
  seed: number;
  tick: number;
  time: number;        // sim seconds elapsed (advances during hit-stop at the scaled rate)
  hitStop: number;     // seconds of hit-stop remaining (global)
  rng: RngState;
  round: RoundState;
  fighters: [FighterState, FighterState];
}

// ── Events (CONTRACT §4) ──────────────────────────────────────────────────────

export type BodyPart = 'head' | 'body';

export type SimEvent =
  | { type: 'punchStart';  side: Side; punch: PunchType; hand: Hand }
  | { type: 'punchLand';   side: Side; target: Side; punch: PunchType; hand: Hand; part: BodyPart; at: Vec3; impulse: Vec3; power: number; counter: boolean }
  | { type: 'punchBlock';  side: Side; target: Side; punch: PunchType; at: Vec3 }
  | { type: 'perfectBlock'; side: Side; target: Side; punch: PunchType; at: Vec3 }
  | { type: 'punchWhiff';  side: Side; punch: PunchType }
  | { type: 'punchSmother'; side: Side; target: Side; punch: PunchType }
  | { type: 'slip';        side: Side; dir: -1 | 1; dodged: boolean }
  | { type: 'counter';     side: Side; target: Side; punch: PunchType }
  | { type: 'hurt';        side: Side; part: BodyPart; impulse: Vec3 }
  | { type: 'knockdown';   side: Side; count: number }
  | { type: 'countTick';   side: Side; n: number }
  | { type: 'getUp';       side: Side }
  | { type: 'roundStart';  index: number }
  | { type: 'roundEnd';    index: number; score: [number, number] }
  | { type: 'bell' }
  | { type: 'ko';          winner: Side }
  | { type: 'tko';         winner: Side }
  | { type: 'decision';    winner: Side | null; cards: [number, number][] };

export type SimEventType = SimEvent['type'];

// ── Presentation interfaces ───────────────────────────────────────────────────

/**
 * A rig for one fighter. RIG implements it; UI/RENDER host it. `apply` is called
 * once per rendered frame with the two most recent sim states and the
 * interpolation alpha in [0, 1). Events since the last frame arrive in `events`
 * (already filtered to this side or with no side).
 */
export interface FighterView {
  readonly side: Side;
  apply(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[]): void;
  dispose(): void;
}

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
  /** The level modifier (overhaul 2026-11-11, the ONE new input): held = drop the level (knees bend, head comes down); punches thrown while it is held go to the body or come up from underneath. A level, like block. */
  level: boolean;
  /** guardHolesV2: this fighter's timed-block skill 0..1 (absent = 1, a human). The AI sets it from its difficulty; the sim rolls it when a block qualifies as well-timed. */
  timedSkill?: number;
}

export const NULL_INPUT: Readonly<FrameInput> = Object.freeze({
  move: Object.freeze({ x: 0, y: 0 }),
  jab: false, cross: false, hook: false, uppercut: false, block: false, level: false,
});

export function cloneInput(i: Readonly<FrameInput>): FrameInput {
  return { move: { x: i.move.x, y: i.move.y }, jab: i.jab, cross: i.cross, hook: i.hook, uppercut: i.uppercut, block: i.block, level: i.level ?? false, ...(i.timedSkill !== undefined ? { timedSkill: i.timedSkill } : {}) };
}

// ── Fighter definition (CONTRACT §5) ──────────────────────────────────────────

export type Stance = 'orthodox' | 'southpaw';
export type AiStyle = 'pressure' | 'counter' | 'outboxer' | 'swarmer' | 'slugger';

/**
 * Head shape (overhaul 2026-11-11). Every value is −1..1 with 0 the average
 * head; drawn only — the head hit sphere is `BodyDims.headR` whatever these say.
 */
export interface HeadMorph {
  width: number;    // narrow ↔ wide skull and cheekbones
  jaw: number;      // narrow ↔ wide, square jaw
  chin: number;     // receding ↔ long, jutting chin
  brow: number;     // smooth ↔ heavy brow ridge
  nose: number;     // small ↔ big nose
  ears: number;     // small, flat ↔ big, sticking out
  height: number;   // low ↔ tall cranium
}

/**
 * Build as continuous morphs (overhaul 2026-11-11; replaces `build: lean |
 * athletic | heavy`). Every value is −1..1 with 0 the baseline athletic boxer.
 * `frame`, `muscle`, positive `bodyFat`, `limbLength` and `neck` reach the
 * sim through core/body.ts (`BodyDims`); the rest is drawn only.
 */
export interface BodyMorph {
  frame: number;       // skeleton breadth: shoulders, ribcage, hips
  muscle: number;      // muscle mass: limb and torso girth, definition (−0.5 is the old `lean`, +0.9 the old `heavy`)
  bodyFat: number;     // < 0 shredded (drawn only), > 0 soft, then a gut (adds girth)
  limbLength: number;  // leg length against the torso (arm length honours `reachM`)
  neck: number;        // thin, long ↔ thick, short bull neck
  head: HeadMorph;
}

export type HairStyle =
  | 'none' | 'short' | 'afro' | 'braids' | 'long' | 'mohawk'                       // the six from Stage 1 ('none' = bald, 'short' = a crop)
  | 'buzz' | 'fade' | 'flatTop' | 'curls' | 'cornrows' | 'dreads' | 'tied' | 'receding' | 'slick' | 'topKnot';
export type FacialHair =
  | 'none' | 'goatee' | 'beard'
  | 'stubble' | 'moustache' | 'chinstrap' | 'longBeard' | 'muttonChops' | 'soulPatch' | 'handlebar';
export type TattooPlace = 'chest' | 'back' | 'sleeveL' | 'sleeveR' | 'forearmL' | 'forearmR' | 'shoulderL' | 'shoulderR' | 'neck' | 'ribs';
export type TattooMotif = 'tribal' | 'script' | 'cross' | 'star' | 'wings' | 'rose' | 'bands' | 'geometric' | 'serpent';
/** One procedural tattoo: where, what, and the seed its strokes are drawn from. No real marks or logos. */
export interface Tattoo { place: TattooPlace; motif: TattooMotif; seed: number }
export type TrunksCut = 'short' | 'classic' | 'long' | 'belt' | 'skirt' | 'split';
export type TrunksPattern = 'solid' | 'sideStripe' | 'waistStripe' | 'twoTone' | 'flames' | 'stars' | 'checker' | 'gradient';
export type BootHeight = 'low' | 'mid' | 'high';

export interface FighterSpec {
  id: string; name: string; nickname: string; hometown: string;
  stance: Stance;
  heightM: number;   // 1.60 – 2.00
  reachM: number;    // wingspan
  massKg: number;
  morph: BodyMorph;
  skin: string; trunksPrimary: string; trunksSecondary: string;
  trunksStyle: TrunksCut;
  /** Default 'sideStripe' (the Stage-1 look). The waistband carries the fighter's initials. */
  trunksPattern?: TrunksPattern;
  gloves: string; boots: string;
  /** Glove design: cuff, thumb and back-of-hand panel colours (defaults: white cuff, the glove colour) and the closure. */
  gloveCuff?: string; gloveThumb?: string; glovePanel?: string; gloveClosure?: 'laces' | 'strap';
  /** Boot design: shaft height (default 'mid'), trim colour (sole, laces, stripes; default trunksSecondary), tassels, side stripes. */
  bootHeight?: BootHeight; bootTrim?: string; bootTassels?: boolean; bootStripes?: boolean;
  hair: HairStyle;
  /** Hair and facial hair colour (default: config rigHairColor). */
  hairColor?: string;
  facialHair: FacialHair;
  eyeColor?: string;
  tattoos?: Tattoo[];
  /** A dressed figure (the referee; contract addition 2026-10-15): shirt over the torso and upper arms, trousers to the boots, a bow tie, bare hands. */
  outfit?: { shirt: string; trousers: string; tie: string };
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
// ── Overhaul 2026-11-11 (SIM): the vocabulary of the new fight systems (docs/OVERHAUL_SIM.md) ──
/** What a button actually threw: chosen at the press from button × level × feet × range (sim/variants.ts). The rig and audio key off this, never off PunchType alone. */
export type PunchVariant =
  | 'jab' | 'stepJab' | 'retreatJab' | 'bodyJab'
  | 'cross' | 'bodyCross' | 'overhand'
  | 'hook' | 'checkHook' | 'shovelHook' | 'bodyHook' | 'risingHook'
  | 'uppercut' | 'insideUppercut' | 'risingUppercut';
/** How well a landed punch landed (sim/grade.ts). Scales impulse, damage and hit-stop; sound, camera and crowd read it off punchLand. */
export type HitGrade = 'glancing' | 'clean' | 'flush';
/** Which of the three fights this is, by centre-to-centre distance. */
export type RangeBand = 'outside' | 'mid' | 'inside';
/** What put the fighter in the hurt state: a head shot (ROCKED — the legs) or the body (winded — folded, guard down). */
export type HurtKind = 'none' | 'head' | 'body';
/** The get-up as a process: flat → stirring → up on a knee → (slumps back, tries again) → rising. 'none' = on his feet. */
export type GetUpPhase = 'none' | 'down' | 'stir' | 'knee' | 'slump' | 'rise';
export type SlipKind = 'slip' | 'pull' | 'roll';
/** The guard a fighter holds (phase 2, core/styles.ts GUARDS): where his hands rest, what his block covers. */
export type GuardShape = 'high' | 'shell' | 'peekaboo' | 'long' | 'low';

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
  /** World point the glove is held at after it hit something (its centre, resting on the surface). null = swung free. */
  contact: Vec3 | null;
  /** What was thrown (overhaul): the contextual punch behind the button. Meaningful while type !== null. */
  variant: PunchVariant;
  /** THE TELL: seconds from the press to the hit test for this punch as thrown (wind-up + extension, after every speed-up and slow-down). Fixed by variant and context — never random. */
  tell: number;
  /** Every phase of this punch runs this many times slower (fatigue; 1 = fresh). */
  timeMult: number;
  /** Impulse multiplier fixed at the press: the variant's own × a loaded counter's bonus. */
  powerMult: number;
  /** Walking speed while this punch is in flight, as a fraction of normal (the jab does not root; a cross plants the feet). */
  moveScale: number;
  /** Thrown with the hand a slip had LOADED (the natural counter from that side). */
  loaded: boolean;
  /** How far below its lane the punch is aimed, m, fixed at the press: a body shot's drop; for an overhand, how far the target's head was down at that moment (it is thrown at where the head IS). */
  aim: number;
  /** Cancelled before the commit point (a feint): rewinding home, never resolves. */
  feint: boolean;
  /** NERFED (polish phase): 0..1, how much this punch was thrown — or caught in flight — while its thrower was being hit or is hurt. It comes out slower, shorter and weaker by this much (hitNerf… keys). 0 = a normal punch. Draw / voice it: an arm punch, off balance. */
  nerf: number;
}

/** Where a landed punch found the target (polish phase), from the contact geometry: head zones and body zones. */
export type HitZone = 'chin' | 'jaw' | 'temple' | 'nose' | 'forehead' | 'solar' | 'ribs' | 'liver' | 'belly';
/** The sub-kind of a hurt state (polish phase). Rocked (head): legs = the legs are gone, reach = reaching for balance, cover = covering up. Winded (body): fold = folded over, elbow = an elbow clamped down on the side, knee = sinking toward a knee. */
export type HurtStyle = 'none' | 'legs' | 'reach' | 'cover' | 'fold' | 'elbow' | 'knee';
/** What kind of knockdown (polish phase): flash = caught, up early; heavy = hurt, barely beats the count (or does not); knee = took a knee by choice; out = unconscious before he lands, no count. */
export type KnockdownKind = 'flash' | 'heavy' | 'knee' | 'out';
/** How a man who is OUT goes down: stiff (a plank) or crumple (the legs fold). */
export type FallStyle = 'none' | 'stiff' | 'crumple';

export interface SlipState {
  active: boolean;
  dir: -1 | 0 | 1 | 2;  // -1 = toward lead side, +1 = toward rear side, 2 = BACK (the pull / lean-back; contract addition 2026-09-16)
  t: number;            // seconds since the flick
  offset: number;       // current head offset in metres: lateral, signed by dir, for ±1; backward (positive) for 2
  /** Overhaul: slip / pull / roll (level + lateral flick: the head goes DOWN and across, under a hook). */
  kind: SlipKind;
  /** The offset this move started from (a chained slip leaves from where the last one was, not from home). */
  from: number;
  /** How many slips deep this chain is (1 = a single slip; 0 = none). */
  chain: number;
  /** How far the head is down because of this move right now, m (slipDip, or the roll's U). */
  dip: number;
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
  spin: Spring1;    // torso yaw kick about the vertical axis, radians (a hook whips the head and shoulders round; contract addition 2026-09-16)
  sink: Spring1;    // the legs giving under a hit: the whole body sits down this far, m (+ = down), and recovers (contract addition 2026-09-19)
}

/** The spec's 0–100 ratings, carried on the state so the sim can read them without the roster (2026-09-15; only chin is wired). */
export interface Ratings { power: number; speed: number; chin: number; stamina: number; defense: number }

export interface FighterState {
  specId: string;
  body: BodyDims;
  stance: Stance;
  ratings: Ratings;

  // locomotion
  pos: Vec2;          // hip projection on the floor
  vel: Vec2;
  yaw: number;        // faces the opponent; sim turns it, never snaps
  lean: { fwd: number; lat: number };   // weight transfer, -1..1, drives punch force and rig
  torsoTwist: number;                   // radians about y, from punches
  /** How far the body sits down, m (+ = down; a small negative is the drive up past rest). Punches dip; slips/ducks will. Moves the boxes and the guard. */
  crouch: number;

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
  /** ROCKED (sim/stun.ts, 2026-10-15): seconds of the hurt state left (0 = clear) and the length it started at. */
  hurt: number;
  hurtMax: number;

  // ── Overhaul 2026-11-11 (SIM) — everything a viewer should see is here or on an event ──
  /** STYLE (phase 2): the fighter's style id (core/styles.ts STYLES — stance width and rhythm for the rig) and the guard shape he holds (GUARDS — the sim's gloves already rest and block in it). */
  styleId: AiStyle;
  guardShape: GuardShape;
  /** LEVEL: 0..1, how far the level modifier has taken the body down (× levelDrop m; head, body capsule and hands all ride it). */
  level: number;
  /** Seconds left in which a punch counts as thrown COMING UP out of the crouch (rising hook, rising uppercut). */
  riseT: number;
  /** Which fight this is right now, by distance to the opponent. */
  range: RangeBand;
  /** INSIDE POSTURE: 0..1, eased — knees bent, head low, elbows in (× insideCrouch m of real height). */
  posture: number;
  /** Seconds this fighter has stood still (reset by walking, a burst, a pivot). */
  stillT: number;
  /** FLAT-FOOTED: 0..1 — off the balls of the feet (stood still too long, or gassed). Slower first step, takes more. 1 − flat is the bounce the rig should draw. */
  flat: number;
  /** ON THE ROPES: 0..1 — how close the ropes are BEHIND (0 = ring centre, or facing them). */
  ropes: number;
  /** In a corner: ropes close on two sides. */
  cornered: boolean;
  /** THE ANGLE: radians the OPPONENT stands off this fighter's facing line (0 = square on). Past angleExposeDeg the guard does not cover and shots land as on an exposed target. */
  angle: number;
  /** Seconds of slow turning left after being pivoted on (the feet have to reset). */
  turned: number;
  /** The BURST channel: floor velocity of a hop, decays on its own clock. */
  hop: Vec2;
  /** Seconds since the last burst began, while it and its landing recovery last (0 = none). */
  burstT: number;
  /** Seconds before another burst is allowed. */
  burstCd: number;
  /** The PIVOT in progress: seconds in (0 = none), which way (−1 toward the lead side, +1 rear), radians still to turn (signed, world), and the planted lead foot it turns about. */
  pivot: { t: number; dir: -1 | 0 | 1; left: number; cx: number; cz: number };
  /** The last flick (for the double-tap burst): push direction (−1 lead, 1 rear, 2 back, 3 forward; 0 = none) and seconds since its release. */
  tap: { dir: -1 | 0 | 1 | 2 | 3; t: number };
  /** GUARD METER: 1 = fresh, drains under fire, recovers when left alone. Low = the block absorbs less; empty = guard break. */
  guardHp: number;
  /** Seconds the guard cannot come up after a guard break. */
  guardBroken: number;
  /** BLOCK STUN: seconds left in which no punch, slip or burst can start after a shot on the guard. */
  blockStun: number;
  /** GUARD DROOP: metres the resting hands hang below the fresh guard (fatigue + body damage). The head opens. */
  guardDroop: number;
  /** FATIGUE: 0..1 derived from stamina (0 above fatigueFrom, 1 at empty). */
  fatigue: number;
  /** A tired fighter's punches: every phase runs this many times slower (1 = fresh). */
  punchSlow: number;
  /** The ceiling stamina regenerates to (body damage and missed punches lower it). */
  staminaCap: number;
  /** Work-rate wear: the part of the stamina ceiling lost to missed punches this fight (partly restored on the stool). */
  wear: number;
  /** Seconds since the guard was last hit (the guard meter recovers after guardRegenDelay). */
  guardRest: number;
  /** DAMAGE taken this fight, by where (sums of health fractions lost; never comes back). liver = the part of the body damage that landed on the liver side. */
  damage: { head: number; body: number; liver: number };
  /** What the hurt state (hurt > 0) is: head = rocked, body = winded. */
  hurtKind: HurtKind;
  /** THE BUCKLE: 0..1, the body folding over a body hurt (eased; × buckleDrop m of real height). */
  buckle: number;
  /** A clean liver shot's delayed buckle: seconds until it fires (0 = none pending) and the impulse behind it. */
  liverT: number;
  liverMag: number;
  /** CLINCH: tied up with the opponent. reach = seconds of the grab so far (an attempt), t = seconds held, by = who initiated, cd = seconds before this fighter may try again. */
  clinch: { active: boolean; reach: number; t: number; by: Side | -1; cd: number };
  /** Seconds before another push-off. */
  pushCd: number;
  /** THE GET-UP while down: the phase, seconds in it, how many times he has got to a knee, and whether his first try is going to fail (rolled at the knockdown — the rig may play the fall accordingly). */
  getUp: { phase: GetUpPhase; t: number; tries: number; owed: boolean };
  /** LOADED after a slip: the side the weight sits on (−1 lead, +1 rear; 0 = none) and the seconds it stays there. The natural counter from that side is faster and harder. */
  loaded: -1 | 0 | 1;
  loadedT: number;
  /** COMBINATION: consecutive clean/flush lands inside the chain (0 = none) and the seconds before it lapses. */
  combo: number;
  comboT: number;
  /** BEING HIT (polish phase): seconds left of the "hit" window a landed punch opened on this fighter, and how hard that hit was, 0..1 (glancing low, flush 1). A punch he starts inside it is nerfed (PunchState.nerf). Draw: the flinch he is throwing through. */
  hitT: number;
  hitSev: number;
  /** The sub-kind of the hurt state while hurt > 0 (polish phase): see HurtStyle. Picked at the hurt from the shot and the seeded rng; each has a small mechanical difference (hurt… keys). */
  hurtStyle: HurtStyle;
  /** A body hurt that lands a beat LATE (polish phase): seconds until the fold begins (0 = none pending). He is hit, keeps his feet for this long, then folds. */
  hurtDelay: number;
  /** The last / current knockdown's kind and, if he is out, how he falls (polish phase). 'none' fall = an ordinary knockdown. Meaningful while down. */
  downKind: KnockdownKind;
  fall: FallStyle;
  /** TAKING A KNEE (polish phase): seconds the take-a-knee input has been held while hurt (0 = not asking). At takeKneeHold he goes down by choice. */
  kneeT: number;

  // ── derived every step by the sim, read by rig/render/ai — never written elsewhere
  headBox: Sphere;
  bodyBox: Capsule;
  /** Shoulder and elbow per arm (index 0 = lead); the hand is gloves[i].pos. The rig draws the arms on these; contacts use them (2026-09-18). */
  arms: [ArmJoints, ArmJoints];
  /**
   * The rigid skeleton (anim Phase 1.1, core/skeleton.ts), fitted every tick while cfg.skelOn. With it on,
   * headBox, bodyBox, gloves[].pos and arms are rewritten FROM this pose, so hit geometry = the skeleton.
   * Absent with skelOn off (and on states built outside the sim: the referee, fixtures).
   */
  skel?: SkelPose;
  /**
   * Joint inertialization state (sim/inertia.ts, cfg.inertiaOn), per joint, flat: the last OUTPUT rotation `out` (x,y,z,w),
   * the last output turn `step` and the lag offset `off` and its rate `vel`
   * (rotation vectors, rad and rad per tick, 3 numbers a joint). Absent with inertiaOn off.
   */
  inertia?: InertiaState;
  /**
   * The keyed feet (anim Phase 1.4, cfg.punchKeysOn): per foot, lead then rear — step forward (m), step outward (m),
   * pivot about the ball (rad, about +y), heel lift (m) — then the weight on the rear foot (0..1). The rig's foot
   * planter obeys it. Absent without punch keys.
   */
  footKey?: number[];
}

/** `raw`: the unsmoothed pose (q) of the last tick; the next tick's sim starts from it, so smoothing never feeds back into the sim. */
export interface InertiaState { out: number[]; step: number[]; off: number[]; vel: number[]; raw: number[] }

export interface ArmJoints { shoulder: Vec3; elbow: Vec3 }

/**
 * A rigid skeleton pose (core/skeleton.ts). Plain number arrays so it clones with slice() and survives JSON.
 *   root: [floor x, floor z, yaw, pelvis forward, pelvis up, pelvis right] — the pelvis offset is in the root frame.
 *   q:    one LOCAL rotation per joint, (x, y, z, w) × JOINT_COUNT, in core/skeleton.ts joint order.
 * Bone lengths are not in the pose: they are fixed by the skeleton definition (skelDef), so a pose cannot stretch.
 */
export interface SkelPose { root: number[]; q: number[] }

export type RoundPhase = 'intro' | 'fighting' | 'between' | 'count' | 'over';

export interface RoundState {
  index: number;       // 0-based
  clock: number;       // seconds remaining
  phase: RoundPhase;
  phaseT: number;      // seconds in the current phase
  score: [number, number][];   // per completed round, 10-point-must
  /** This round's tallies, the judges' inputs (sim/round.ts): clean landed punches and their summed impulse, N·s. Reset at each roundStart. */
  landed: [number, number];
  power: [number, number];
  /** Control (phase 4): punches of the OTHER man's each side made miss this round — the defence and ring generalship the judges credit (scoreControlWeight). */
  control: [number, number];
  /** The referee's count while phase = 'count' (1…10), else 0. */
  count: number;
}

export interface SimState {
  seed: number;
  tick: number;
  time: number;        // sim seconds elapsed (advances during hit-stop at the scaled rate)
  hitStop: number;     // seconds of hit-stop remaining (global)
  /** Hit-stop spent lately, s (polish phase): a leaky bucket — every freeze granted adds to it, it drains at hitStopBudget per hitStopBudgetWindow. A new freeze is cut to what the budget has left. Optional so states built by hand elsewhere stay valid; the sim treats a missing value as 0. */
  stopUsed?: number;
  rng: RngState;
  round: RoundState;
  fighters: [FighterState, FighterState];
}

// ── Events (CONTRACT §4) ──────────────────────────────────────────────────────

export type BodyPart = 'head' | 'body';

export type SimEvent =
  /** variant = what was actually thrown; tell = seconds until its hit test (the read the defender gets). */
  /** nerf (polish phase) = 0..1, thrown while being hit / hurt: slower, shorter, weaker by that much. */
  | { type: 'punchStart';  side: Side; punch: PunchType; hand: Hand; variant: PunchVariant; tell: number; nerf?: number }
  /** grade = glancing / clean / flush (the tier every downstream read keys off); combo = which punch of a clean combination this is (1 = first); liver = a body shot on the liver side; through = it came round or through a held guard; wrongWay = the target slipped INTO it. */
  | { type: 'punchLand';   side: Side; target: Side; punch: PunchType; hand: Hand; part: BodyPart; at: Vec3; impulse: Vec3; power: number; counter: boolean; variant: PunchVariant; grade: HitGrade; combo: number; liver: boolean; through: boolean; wrongWay: boolean;
      /** Polish phase. finisher = the last, biggest punch of a clean combination (its own bonus; sound / camera / crowd key on it). zone = where it found him, from the contact geometry. vary = −1..1, a seeded variation (the same punch never lands identically twice; the reaction springs already carry it). nerf = how nerfed the punch was. */
      finisher?: boolean; zone?: HitZone; vary?: number; nerf?: number;
      /** HOW CLOSE (measured, read by nothing in the sim; outcome-first mode only). margin = far − d, m (how deep inside reach). ramp = 0..1 fraction of full power the close-range ramp left a straight (1 = no ramp). */
      margin?: number; ramp?: number }
  /** chip = health the guard let through (0 on a light shot); guard = the guard meter after it; stun = block stun, s. */
  | { type: 'punchBlock';  side: Side; target: Side; punch: PunchType; at: Vec3; variant: PunchVariant; part: BodyPart; chip: number; guard: number; stun: number; margin?: number }
  | { type: 'perfectBlock'; side: Side; target: Side; punch: PunchType; at: Vec3; variant: PunchVariant; margin?: number }
  /** margin (measured only, outcome-first mode): a real whiff d − far > 0, m short of reach; a dodge (dodged = true: the outcome rule said dodge) far − d, m inside reach, with evadeAge / evadeLeft (s) when the evade state is known. */
  | { type: 'punchWhiff';  side: Side; punch: PunchType; variant: PunchVariant; margin?: number; dodged?: boolean; evadeAge?: number; evadeLeft?: number }
  /** A wind-up cancelled into the guard before its commit point. */
  | { type: 'feint';       side: Side; punch: PunchType; variant: PunchVariant }
  /** A quick hop: x / y in the fighter's own frame (y + = toward the opponent). */
  | { type: 'burst';       side: Side; x: number; y: number }
  /** A pivot off the lead foot (dir −1 toward the lead side, +1 rear). */
  | { type: 'pivot';       side: Side; dir: -1 | 1 }
  /** Got off the ropes / out of the corner by a pivot, a slip or a roll. */
  | { type: 'escape';      side: Side; how: 'pivot' | 'slip' | 'roll' }
  /** A shove with both gloves: hit = the opponent was in reach and went back. */
  | { type: 'pushOff';     side: Side; target: Side; hit: boolean }
  /** A tie-up: side grabbed target; then the break and why. */
  | { type: 'clinch';      side: Side; target: Side }
  | { type: 'clinchBreak'; side: Side; reason: 'referee' | 'pushOff' | 'denied' }
  /** The guard meter emptied: side's hands are knocked apart and cannot come up for `seconds`. */
  | { type: 'guardBreak';  side: Side; by: Side; seconds: number }
  /** A clean liver shot: the buckle comes `delay` seconds later. */
  | { type: 'liverShot';   side: Side; by: Side; delay: number }
  /** The body gave: winded (hurtKind body) for `seconds`. liver = it was the delayed liver buckle. */
  | { type: 'bodyHurt';    side: Side; by: Side; liver: boolean; seconds: number }
  /** The downed fighter's struggle: each phase change. */
  | { type: 'getUpPhase';  side: Side; phase: GetUpPhase; tries: number }
  | { type: 'punchSmother'; side: Side; target: Side; punch: PunchType }
  /** `side`'s punch was broken mid-flight by a punch from `by` landing on them: it never resolves and rewinds home. */
  | { type: 'punchStuffed'; side: Side; by: Side; punch: PunchType }
  /** Once at the flick (dodged: false), and once more, dodged: true, for each punch the slip takes away. */
  | { type: 'slip';        side: Side; dir: -1 | 1 | 2; dodged: boolean; kind: SlipKind; chain: number; margin?: number; evadeAge?: number; evadeLeft?: number }
  | { type: 'counter';     side: Side; target: Side; punch: PunchType }
  | { type: 'hurt';        side: Side; part: BodyPart; impulse: Vec3 }
  /** kind / fall (polish phase): see KnockdownKind / FallStyle. `cause` keeps its four values (a knee taken by choice reports cause 'health', an instant KO 'flash'): read `kind` for those. */
  | { type: 'knockdown';   side: Side; count: number; cause: 'health' | 'finish' | 'flash' | 'body'; kind?: KnockdownKind; fall?: FallStyle;
      /** For a knockdown by a head shot: how many times the target's stun threshold the shot was (probes and the crowd's size of reaction). */
      over?: number }
  /** A hurt state's sub-kind was picked (polish phase): fires with `rocked` / `bodyHurt`, and again when a late body hurt folds him. */
  | { type: 'hurtStyle';   side: Side; kind: HurtKind; style: HurtStyle; late: boolean }
  /** A clean head shot cleared the target's stun threshold (sim/stun.ts): `seconds` of the hurt state. */
  | { type: 'rocked';      side: Side; by: Side; punch: PunchType; impulse: number; threshold: number; seconds: number }
  | { type: 'countTick';   side: Side; n: number }
  | { type: 'getUp';       side: Side }
  | { type: 'roundStart';  index: number }
  | { type: 'roundEnd';    index: number; score: [number, number] }
  | { type: 'bell' }
  /** waved = the referee waved it off without a count (polish phase: he was out before he landed). */
  | { type: 'ko';          winner: Side; waved?: boolean }
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
  /** The read (2026-09-22): how strongly this fighter is marked as exposed this frame, 0..1 — UI decides, RIG draws (a warm rim). */
  highlight(strength: number): void;
  dispose(): void;
}

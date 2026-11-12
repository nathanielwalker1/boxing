/**
 * rig/reads.ts — the sim's fight state, turned into what the BODY does about
 * it (overhaul phase 2). The user's rule: the game tells him things through
 * bodies, never words, flashes or glows. The sim owns every hit box and both
 * fists; this owns the read — how the spine, hips, shoulders, head, feet and
 * face answer a level change, a range, a punch variant, a graded hit, a worn
 * guard, fatigue, a body shot, a clinch, a knockdown.
 *
 * `Reads.step` runs once per rendered frame inside the view's `apply` and
 * leaves pose channels on itself for the solver (index.ts) to add in:
 * angles in radians, lengths in metres, every one eased through a spring so
 * nothing pops. Hits arrive as events and KICK loose springs (a head whip, a
 * fold at the waist), so a flush shot follows through and comes back.
 *
 * `stanceParams` is the ONE place the stance and the bounce are read from, so
 * a style table (core/styles.ts, when it lands) can be pointed at it.
 */
import { fighterStyle, lerp, spring1, type Config, type FighterState, type GetUpPhase, type HurtStyle, type PunchVariant, type Side, type SimEvent, type Spring1 } from '../core';
import { chase1 } from './springs';

const DEG = Math.PI / 180;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** Stance and bounce for this fighter, this frame. Neutral = the config; a style table replaces the body of this function. */
export interface StanceParams {
  /** Lead foot forward of the hips, rear foot behind, lateral half-spread, m. */
  fwd: number; back: number; lat: number;
  /** The boxer's bounce: beats per second and hip drop per beat, m. */
  bounceHz: number; bounceAmp: number;
  /** How far the hips and the ribcage blade off square, degrees. */
  hipYawDeg: number; chestYawDeg: number;
}
export function stanceParams(state: FighterState, cfg: Config): StanceParams {
  // Inside, the feet come under the fighter and the bounce stops; outside he is up and bouncing.
  const p = state.posture;
  const band = state.range === 'outside' ? cfg.rigBounceOutside : state.range === 'inside' ? cfg.rigBounceInside : 1;
  // The fighter's style (core/styles.ts): a swarmer is planted and busy, an outboxer narrow and on his toes.
  const st = cfg.stylesOn && state.styleId ? fighterStyle(state.styleId) : null;
  const w = st ? st.stanceWidth : 1, hz = st ? st.bounceHz : 1, amp = st ? st.bounceAmp : 1;
  return {
    fwd: cfg.rigStanceFwd * w * (1 - 0.15 * p), back: cfg.rigStanceBack * w * (1 - 0.1 * p), lat: cfg.rigStanceLat * w * (1 + 0.12 * p + 0.1 * state.level),
    bounceHz: cfg.rigRhythmHz * hz, bounceAmp: cfg.rigRhythmBob * amp * band * (1 - state.flat),
    hipYawDeg: cfg.rigStanceHipYawDeg, chestYawDeg: cfg.rigStanceChestYawDeg * (1 - 0.5 * p),
  };
}

/** What a landed punch asks the view to do right now (index.ts has the bones and the world). */
export interface HitRead {
  part: 'head' | 'body';
  /** Squash multiple of a clean hit, and how much longer it lasts. */
  squash: number; squashDur: number;
  /** Sweat droplets to throw, 0 = none; `at` and `dir` are world. */
  spray: number; at: { x: number; y: number; z: number }; dir: { x: number; y: number; z: number };
}

const BODY_SHOTS: ReadonlySet<PunchVariant> = new Set<PunchVariant>(['bodyJab', 'bodyCross', 'bodyHook']);
const RISING: ReadonlySet<PunchVariant> = new Set<PunchVariant>(['risingHook', 'risingUppercut']);
const COMPACT: ReadonlySet<PunchVariant> = new Set<PunchVariant>(['shovelHook', 'insideUppercut']);
const BACKFOOT: ReadonlySet<PunchVariant> = new Set<PunchVariant>(['retreatJab', 'checkHook']);

export class Reads {
  // ── Pose channels (read by the solver) ──
  /** Chest pitch forward (+) and roll toward the fighter's right (+), radians; extra chest yaw. */
  chestPitch = 0; chestRoll = 0; chestYaw = 0;
  /** Shoulders up (+) / down (−), m. */
  shrug = 0;
  /** Hips: down (+), forward (+), toward the right (+), m; extra hip yaw, radians. */
  hipDrop = 0; hipFwd = 0; hipLat = 0; hipYaw = 0;
  /** Head on top of the solver's: pitch back (+), yaw, radians. */
  headPitch = 0; headYaw = 0; headRoll = 0;
  /** The lead foot's extra step forward, m; rear / both heels off the canvas, m. */
  leadStep = 0; heelRear = 0; heelBoth = 0;
  /** Burst: 0..1 through the hop (0 = on the ground), and the feet's height. */
  airborne = 0; footLift = 0;
  /** Breathing rate and depth multiples. */
  breathRate = 1; breathAmp = 1;
  /** 1 = the rocked wobble may play (head hurt); 0 = it may not (winded). */
  wobble = 1;
  /** Clinch 0..1 and push-off 0..1 (the drawn arms leave the sim's gloves for these two). */
  clinch = 0; push = 0;
  /** Get-up: 0 lying … 1 standing, and a small struggle offset; how the fall goes. */
  up = 0; struggle = 0;
  fallCause: 'health' | 'finish' | 'flash' | 'body' = 'health';
  /** Punching-shoulder twitch forward, m (a feint). */
  feintReach = 0;
  // ── Face and skin (0..1) ──
  wince = 0; mouthOpen = 0; swellL = 0; swellR = 0; sweat = 0; reddenHead = 0; reddenBody = 0;
  cuts = { browL: 0, browR: 0, cheekL: 0, cheekR: 0, nose: 0, lip: 0 };
  /** Hits landed on this fighter this frame, for the squash and the spray. */
  readonly hits: HitRead[] = [];

  // ── Private state ──
  private sPitch = spring1(); private sRoll = spring1(); private sShrug = spring1();
  private sDrop = spring1(); private sFwd = spring1(); private sLat = spring1(); private sHipYaw = spring1(); private sChestYaw = spring1();
  private sStep = spring1(); private sHeelB = spring1();
  private kWhipYaw = spring1(); private kWhipPitch = spring1(); private kFoldRoll = spring1(); private kFoldPitch = spring1(); private kRock = spring1();
  private sUp = spring1(1); private sClinch = spring1(); private sBuckle = spring1();
  private winceT = 0; private pushT = 0; private feintT = 0; private struckSide = 1;
  private hitsL = 0; private hitsR = 0; private bodyL = 0; private bodyR = 0;
  private coverT = 0; private coverDur = 1;
  private kSag = spring1();
  private sShrugLead = spring1(); private sShapeHead = spring1();
  /** The lead shoulder alone, up (+), m (the shell). */
  shrugLead = 0;
  private t = 0;
  /** The elbow drops to cover the struck side after a body shot: 0..1, and which side (+1 = the fighter's right). */
  cover = 0; coverSide = 1;
  /** Clinch: the drawn head's lean onto the other man's shoulder, m (forward, toward the right). */
  headFwd = 0; headLat = 0;
  // ── Polish phase B (rigReactV2 / rigHurtV2 / rigNerfV2 / rigComboV2): drawn only ──
  /** The hit-side shoulder gives: drop, m, [the fighter's right, his left]. */
  readonly shoulderGive: [number, number] = [0, 0];
  /** A hand knocked loose by a flush shot: how far the drawn glove leaves the sim's, m, [right, left]. */
  readonly armKick: [number, number] = [0, 0];
  /** Rocking back on the heels: 0..1 (toes off the canvas). The attacker's lead foot should step now (the follow step). */
  toeUp = 0; followStep = false;
  /** 0..1: hold still (the beat before a late body shot folds him): the bounce and the breath stop. */
  still = 0;
  /** Rocked: both knees turn in, 0..1; the wobble's size as a multiple. */
  kneeIn = 0; wobbleAmp = 1;
  /** A nerfed punch: the hips turn / the heel lifts this fraction of a full punch's. */
  hipFollowScale = 1; heelScale = 1;
  private kHeadRoll = spring1(); private kChestYaw = spring1(); private kHipLat = spring1(); private kHipBack = spring1();
  private kShoulder = [spring1(), spring1()]; private kArm = [spring1(), spring1()];
  private mouthT = 0; private rockN = 0; private rockT = 0; private sRock = spring1(); private sHurt = spring1(); private sStill = spring1();
  private sNerf = spring1(); private sFlinch = spring1(); private style: HurtStyle = 'none';
  /** Reddening of the torso by side (the liver is on the right). */
  reddenBodyR = 0; reddenBodyL = 0;

  constructor(private side: Side) {}

  /**
   * rigReactV2 — one landed punch, by where it found him (zone), how well (grade, finisher), which way it was going
   * (nF forward / nR toward his right, unit, in his frame) and the land's seeded `vary`. Everything is a KICK into a
   * loose spring, so it follows through and comes back, and two lands stack.
   *   glancing: the head moves a little and nothing else does.   clean: the head snaps, the shoulder gives, the chest rocks.
   *   flush: the head whips, the chest goes, the knees dip, a hand is knocked loose, the mouth opens.   finisher: more, both hands.
   * `vary` picks one of three ways of taking it (rides it: more head, less body / plain / stiffens: less head, more
   * body), which hand comes loose and how far, which way the hips go, the head's extra roll, and the mouth.
   */
  private reactV2(e: Extract<SimEvent, { type: 'punchLand' }>, nF: number, nR: number, c: Config): void {
    const vary = Math.max(-1, Math.min(1, (e.vary ?? 0) * c.rigReactVary));
    const gk = e.grade === 'glancing' ? c.rigReactGlancing : e.grade === 'clean' ? c.rigReactClean : 1;
    const big = gk * (e.finisher ? c.rigReactFinisher : 1);
    const way = vary < -0.33 ? 0 : vary > 0.33 ? 2 : 1;
    const headK = way === 0 ? 1.25 : way === 2 ? 0.75 : 1, bodyK = way === 0 ? 0.7 : way === 2 ? 1.5 : 1;
    const body = e.grade === 'glancing' ? 0 : big * c.rigReactBody * bodyK;
    // Which way it sends him: +1 = toward his right (he was struck on his left). A punch with no sideways travel is decided by vary.
    const side = Math.abs(nR) > 0.2 ? Math.sign(nR) : vary >= 0 ? 1 : -1;
    if (e.part === 'head') {
      const A = c.rigFlushWhipDeg * DEG * big * c.rigReactHead * headK;
      // Per zone: head yaw / pitch back / roll, chest rock back, knees, chest yaw, the hit-side shoulder, hips sideways.
      let yaw = 0.3, pitch = 1, roll = 0, rock = 0.6, sag = 0.4, cyaw = 0, give = 0, hipL = 0.3, sideways = false;
      switch (e.zone) {
        case 'chin': yaw = 0.25; pitch = 1.15; roll = 0.3 * vary; rock = 1; sag = 1.2; break;                                  // lifted up and back; the legs feel it
        case 'jaw': yaw = 1.5; pitch = 0.35; roll = 0.5; rock = 0.4; cyaw = 0.7; give = 1; hipL = 0.6; sideways = true; break;   // the head TURNS, the shoulders go with it
        case 'temple': yaw = 0.45; pitch = 0.15; roll = 1.4; rock = 0.3; cyaw = 0.35; give = 1.2; hipL = 1; sideways = true; break;   // the head TIPS, ear to the far shoulder, and he is off balance sideways
        case 'nose': yaw = 0.1 * vary; pitch = 0.85; rock = 1.3; sag = 0.6; break;                                              // straight back, the face screwed shut
        case 'forehead': yaw = 0.15; pitch = 0.55; rock = 1.7; sag = 0.3; break;                                               // the skull takes it: the chest is shoved, the head hardly moves
        default: break;
      }
      this.kWhipYaw.v += -(sideways ? side : nR) * A * 16 * yaw;
      this.kWhipPitch.v += Math.max(0.3, -nF) * A * 17 * pitch;
      this.kHeadRoll.v += side * A * 14 * (roll + (sideways ? 0.25 * vary : 0));
      this.kRock.v += c.rigBlockRockDeg * DEG * 70 * rock * body;
      this.kSag.v += 1.1 * sag * body * (e.grade === 'flush' ? 1 : 0.3);
      this.kChestYaw.v += -side * 10 * DEG * 12 * cyaw * body;
      this.kShoulder[side < 0 ? 0 : 1]!.v += c.rigReactShoulder * 14 * give * body;   // struck on the side it did NOT go toward
      this.kHipLat.v += side * 0.4 * hipL * body * (1 + 0.6 * vary);
      if (e.grade === 'flush' || e.finisher) {
        const k = c.rigReactArm * 16 * (0.5 + 0.5 * Math.abs(vary)) * big;
        if (e.finisher) { this.kArm[0]!.v += k; this.kArm[1]!.v += k * 0.8; } else this.kArm[vary >= 0 ? 0 : 1]!.v += k;
        this.mouthT = 0.35;
      } else if (e.grade === 'clean' && vary > 0.2) this.mouthT = 0.18;
      if (nR > 0) this.hitsL += e.power; else this.hitsR += e.power;
    } else {
      const F = c.rigBodyFoldDeg * DEG * (e.grade === 'glancing' ? c.rigGradeGlancing : big * 1.6) * c.rigReactBody * (e.grade === 'glancing' ? 1 : bodyK);
      this.struckSide = e.liver || e.zone === 'liver' ? 1 : nR > 0.15 ? -1 : nR < -0.15 ? 1 : vary >= 0 ? 1 : -1;   // the liver is on his right
      let roll = 1, pitch = 1, back = 0.3, lat = 0.5, sag = 0.2;
      switch (e.zone) {
        case 'solar': roll = 0.15; pitch = 1.7; back = 0.7; lat = 0; this.mouthT = 0.4; break;   // folds over it, the wind going
        case 'ribs': roll = 1.6; pitch = 0.4; lat = 1; break;                                     // bends sideways onto it
        case 'liver': roll = 1.2; pitch = 1.1; lat = 0.8; sag = 1; break;                         // sideways AND down
        case 'belly': roll = 0.1; pitch = 0.8; back = 1.6; sag = 0.4; lat = 0; break;             // the hips go back
        default: break;
      }
      this.kFoldRoll.v += this.struckSide * F * 14 * roll;
      this.kFoldPitch.v += F * 9 * pitch;
      this.kHipBack.v += 0.6 * back * gk;
      this.kHipLat.v += -this.struckSide * 0.4 * lat * gk * (1 + 0.5 * vary);
      this.kSag.v += sag * gk;
      if (this.struckSide > 0) this.bodyR += e.power; else this.bodyL += e.power;
      if (e.grade !== 'glancing') { this.coverT = c.rigCoverTime * (e.grade === 'flush' ? 1.4 : 1) * (1 + 0.3 * vary); this.coverDur = this.coverT; this.coverSide = this.struckSide; }
    }
  }

  /**
   * `toLocal(x, y, z)` turns a world direction into the fighter's frame as [forward, up, right].
   * `handSide` = lateral sign (+1 right) of the hand that is punching.
   */
  step(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[], c: Config, toLocal: (x: number, y: number, z: number) => readonly [number, number, number], handSide: number, leadSign: number): void {
    this.t += dt;
    this.hits.length = 0;
    const f = next;
    const L = (a: number, b: number): number => lerp(a, b, alpha);

    // ── Events: hits kick loose springs; knockdowns pick the fall ──
    for (const e of events) {
      if (e.type === 'punchLand' && e.target === this.side) {
        const g = e.grade === 'glancing' ? c.rigGradeGlancing : e.grade === 'flush' ? c.rigGradeFlush : 1;
        const [iF, , iR] = toLocal(e.impulse.x, 0, e.impulse.z);
        const il = Math.hypot(iF, iR) || 1;
        if (c.rigReactV2 && e.zone !== undefined && (e.part === 'head' || c.rigReactBodyZones)) this.reactV2(e, iF / il, iR / il, c);
        else if (e.part === 'head') {
          // Three sizes that cannot be mistaken for each other: a glancing shot barely turns the head; a clean one
          // snaps it; a flush one whips it right round, rocks the chest back with it and takes longer to come home.
          const whip = c.rigFlushWhipDeg * DEG * (e.grade === 'flush' ? 1 : e.grade === 'clean' ? 0.42 : 0.05);
          // The head goes with the punch: velocity into a loose spring, so it follows through and returns.
          this.kWhipYaw.v += -(iR / il) * whip * 16;
          this.kWhipPitch.v += -(iF / il) * whip * 17;
          // …and the body answers: flush, the chest goes back hard and the knees give for a beat; clean, a small rock; glancing, nothing.
          if (e.grade === 'flush') { this.kRock.v += c.rigBlockRockDeg * DEG * 70; this.kSag.v += 1.1; } else if (e.grade === 'clean') this.kRock.v += c.rigBlockRockDeg * DEG * 18;
          if (iR > 0) this.hitsL += e.power; else this.hitsR += e.power;   // pushed right = struck on the left
        } else {
          const fold = c.rigBodyFoldDeg * DEG * g;
          this.struckSide = e.liver ? 1 : iR > 0 ? -1 : 1;                   // the liver is on the fighter's right
          this.kFoldRoll.v += this.struckSide * fold * 14;
          this.kFoldPitch.v += fold * 9;
          if (this.struckSide > 0) this.bodyR += e.power; else this.bodyL += e.power;
          if (e.grade !== 'glancing') { this.coverT = c.rigCoverTime * (e.grade === 'flush' ? 1.4 : 1); this.coverDur = this.coverT; this.coverSide = this.struckSide; }
        }
        if (e.grade !== 'glancing') this.winceT = Math.max(this.winceT, c.rigWinceTime * (e.grade === 'flush' ? 1.4 : e.part === 'body' ? 1 : 0.5) * (c.rigReactV2 && e.zone === 'nose' ? 2.5 : 1));
        // rigComboV2: while the sim holds his knockback (punches 2…n of a clean combination) he rocks back on his heels a little more each time; the finisher lets him go.
        if (c.rigComboV2) { if (e.finisher) { this.rockN = 0; this.rockT = 0; } else if (e.combo >= 2 && e.grade !== 'glancing') { this.rockN = Math.min(3, e.combo - 1); this.rockT = 0.45; } }
        const sprayK = e.part === 'head' ? (e.grade === 'flush' ? 1 : e.grade === 'clean' ? 0.4 : 0) : 0;
        this.hits.push({ part: e.part, squash: g, squashDur: e.grade === 'flush' ? c.rigGradeFlush : 1, spray: Math.round(c.rigSprayCount * sprayK * (0.3 + 0.7 * this.sweat)), at: e.at, dir: e.impulse });
      } else if (e.type === 'punchBlock' && e.target === this.side) {
        // A blocked shot rocks him by its WEIGHT (the sim's block stun: a hook stuns longer than a cross, a jab hardly),
        // and more on a worn guard — the gloves are driven back onto the face and the head goes with them.
        // (Phase 3 film: at the old size a blocked cross and a blocked hook were the same picture, and neither moved him.)
        const weight = Math.min(2.2, 0.35 + e.stun * 9) * (1 + 1.2 * (1 - Math.max(0, Math.min(1, e.guard))));
        this.kRock.v += c.rigBlockRockDeg * DEG * 34 * weight;
        this.kWhipPitch.v += 9 * DEG * 12 * weight;
        this.kSag.v += 0.25 * weight;
        if (c.rigReactV2) {
          // Phase 3 found a blocked cross, a blocked hook and a blocked shot on a worn guard "look almost alike": all three
          // rocked him straight back. A hook on the gloves now shoves him SIDEWAYS (chest turns and tips away from the side
          // it landed on), an uppercut lifts the gloves and the head, and on a worn guard the hands are driven apart.
          const hitR = toLocal(e.at.x - f.pos.x, 0, e.at.z - f.pos.z)[2] >= 0 ? 1 : -1;   // which side of him the glove met
          if (e.punch === 'hook') { this.kChestYaw.v += hitR * 12 * DEG * 12 * weight; this.kFoldRoll.v += -hitR * 7 * DEG * 14 * weight; this.kHipLat.v += -hitR * 0.3 * weight; this.kHeadRoll.v += -hitR * 8 * DEG * 14 * weight; }
          else if (e.punch === 'uppercut') { this.kWhipPitch.v += 10 * DEG * 14 * weight; this.kSag.v -= 0.2 * weight; }
          if (e.guard < 0.35) { const k = c.rigReactArm * 16 * (1 - e.guard / 0.35); this.kArm[0]!.v += k; this.kArm[1]!.v += k; this.kSag.v += 0.5; }
        }
      } else if (e.type === 'guardBreak' && e.side === this.side) {
        this.kRock.v += c.rigBlockRockDeg * DEG * 26;
        this.winceT = Math.max(this.winceT, c.rigWinceTime);
      } else if ((e.type === 'liverShot' || e.type === 'bodyHurt') && e.side === this.side) {
        this.struckSide = e.type === 'liverShot' || e.liver ? 1 : this.struckSide;
        this.winceT = Math.max(this.winceT, c.rigWinceTime * 2.2);
      } else if (e.type === 'knockdown' && e.side === this.side) {
        this.fallCause = e.cause;
        this.sUp.x = 0; this.sUp.v = 0;
      } else if (e.type === 'pushOff' && e.side === this.side) {
        this.pushT = c.rigPushTime;
      } else if (e.type === 'feint' && e.side === this.side) {
        this.feintT = 0.22;
      }
    }

    // ── What the state asks for ──
    const lvl = L(prev.level, next.level), post = L(prev.posture, next.posture);
    const ropes = L(prev.ropes, next.ropes);
    const dip = f.slip.kind === 'roll' ? clamp01(L(prev.slip.dip, next.slip.dip) / Math.max(1e-3, c.rollDip)) : 0;
    const winded = f.hurtKind === 'body' && f.hurt > 0;
    const buckle = chase1(this.sBuckle, winded ? Math.max(L(prev.buckle, next.buckle), 0.35) : L(prev.buckle, next.buckle), 160, 0.8, dt);
    const fatigue = clamp01(f.fatigue);
    const v = f.punch.type !== null && !f.punch.feint ? f.punch.variant : null;
    const p = f.punch.type !== null ? L(prev.punch.type !== null ? prev.punch.progress : 0, next.punch.progress) : 0;
    const env = v ? Math.sin(Math.PI * clamp01(p * 1.15)) : 0;        // 0 at the press, 1 around the hit, 0 home
    const drive = v ? smooth(p / 0.45) * (1 - smooth((p - 0.6) / 0.4)) : 0;
    const droop = f.guardDroop;
    const broken = f.guardBroken > 0 ? 1 : 0;
    const stun = clamp01(f.blockStun / 0.25);
    // clinchV2 (polish): the sim places the bodies, the heads and the hands for the tie-up, so the drawn head shift and the
    // drawn arm wrap are OFF (clinch = 0 below); what is left for the drawing is a chest-pitch trim and a head roll (tied).
    const tied = chase1(this.sClinch, f.clinch.active ? 1 : 0, 90, 0.9, dt);
    const clinch = c.clinchV2 ? 0 : tied;
    this.clinch = clinch;
    if (this.pushT > 0) this.pushT = Math.max(0, this.pushT - dt);
    this.push = this.pushT > 0 ? Math.sin(Math.PI * (1 - this.pushT / c.rigPushTime)) : 0;
    if (this.feintT > 0) this.feintT = Math.max(0, this.feintT - dt);
    this.feintReach = this.feintT > 0 ? Math.sin(Math.PI * (1 - this.feintT / 0.22)) * 0.05 : 0;

    // Burst: a hop with a push-off and a landing.
    const hopT = c.burstTime, landT = Math.max(1e-3, c.burstRecover);
    const bT = f.burstT;
    // Three beats so the hop READS: the first fifth is the push-off (knees load, feet still down), then both feet
    // leave the canvas on an arc, then the landing compresses and recovers. (Phase 2: one small arc; it did not read.)
    const loadT = hopT * 0.2;
    const load = bT > 0 && bT < loadT ? Math.sin(Math.PI * bT / loadT) : 0;
    const air = bT >= loadT && bT < hopT ? Math.sin(Math.PI * (bT - loadT) / (hopT - loadT)) : 0;
    const land = bT >= hopT ? Math.sin(Math.PI * clamp01((bT - hopT) / landT)) : 0;
    this.airborne = air;
    this.footLift = air * c.rigBurstHop * 0.6;
    const [hF, , hR] = toLocal(f.hop.x, 0, f.hop.z);
    const hl = Math.hypot(hF, hR);
    const hopLean = air > 0 && hl > 1e-3 ? c.rigBurstLeanDeg * DEG * (1 - bT / hopT) : 0;

    // Chest pitch (forward +).
    let pitch = post * c.rigPostureTiltDeg + lvl * c.rigLevelTiltDeg + dip * c.rigRollTiltDeg
      + buckle * c.rigBuckleFoldDeg + clinch * c.rigClinchLeanDeg + (c.clinchV2 ? tied * c.rigClinchV2LeanDeg : 0)
      + Math.min(1, droop / 0.1) * 5 * c.rigGuardSlump
      - ropes * c.rigRopesLeanDeg - broken * 5;
    // Spent: the chest sags and the shoulders hang — the tells that survive at play distance (the face does not:
    // the player's own man is seen from behind, and at the play camera a mouth is three pixels).
    pitch += fatigue * 9 + (1 - clamp01(f.guardHp)) * 4;
    let roll = 0, shrug = post * 0.012 - droop * c.rigGuardSlump - broken * c.rigBrokenSlump - buckle * 0.02 - fatigue * 0.022 - (1 - clamp01(f.guardHp)) * 0.012;
    // The guard's SHAPE (core/styles.ts places the gloves; this is the rest of the body for it).
    const shape = c.stylesOn && f.styleId ? fighterStyle(f.styleId).guard : 'high';
    const settled = v || f.down ? 0 : 1;
    let shrugLead = 0, shapeYaw = 0, shapeHead = 0;
    if (shape === 'shell') { shrugLead = 0.045 * settled; shapeYaw = 12 * DEG * leadSign * settled; shapeHead = -7 * DEG * settled; pitch += 3 * settled; }   // lead shoulder up, chin behind it, more side-on
    else if (shape === 'peekaboo') { pitch += 7 * settled; shrug += 0.018 * settled; shapeHead = -5 * DEG * settled; }                                        // crouched behind the gloves
    else if (shape === 'low') { pitch -= 4 * settled; shrug -= 0.012 * settled; }                                                                               // upright, loose, hands down
    else if (shape === 'long') { shapeYaw = 6 * DEG * leadSign * settled; }                                                                                     // a touch side-on behind the lead arm
    this.shrugLead = chase1(this.sShrugLead, shrugLead, 200, 0.8, dt);
    let drop = buckle * 0.02 + land * c.rigBurstLand + load * c.rigBurstLand * 0.7 - air * c.rigBurstHop + dip * 0.03;
    let fwd = -ropes * c.rigRopesHip, lat = buckle * c.rigBuckleKnee * this.struckSide, hipYaw = 0, chestYaw = 0, step = 0, heelBoth = air > 0 ? 0.04 : 0;
    if (hopLean > 0) { pitch += hopLean * (hF / hl) / DEG; roll += hopLean * (hR / hl) / DEG; }
    if (v) {
      if (BODY_SHOTS.has(v)) { pitch += env * c.rigBodyShotBendDeg; drop += env * 0.03; roll += env * handSide * -4; }
      if (v === 'overhand') { pitch += env * c.rigOverhandDeg * 0.7; roll += env * c.rigOverhandDeg * leadSign; shrug += env * 0.02; }
      if (RISING.has(v)) { drop -= drive * c.rigRiseDrive; heelBoth = Math.max(heelBoth, drive * 0.05); pitch -= drive * 5; }
      if (COMPACT.has(v)) { shrug += env * c.rigInsideShrug; pitch += env * 5; }
      if (BACKFOOT.has(v)) { pitch -= env * c.rigRetreatLeanDeg; fwd -= env * 0.04; }
      if (v === 'checkHook') { hipYaw += env * 14 * DEG * -handSide; chestYaw += env * 8 * DEG * -handSide; }
      if (v === 'stepJab') step = smooth(p / 0.35) * (1 - smooth((p - 0.75) / 0.25)) * c.rigStepJabReach;
    }
    // ── Polish phase B: the kind of hurt, the nerfed punch and the flinch, the combination (all drawn only) ──
    let headPitchX = 0, headRollX = 0, toe = 0, coverHold = 0;
    this.kneeIn = 0; this.wobbleAmp = 1; this.still = 0;
    if (c.rigHurtV2) {
      // The sub-kind (FighterState.hurtStyle) is held while it eases out, so he does not snap to the plain pose as the clock runs down.
      const hurting = f.hurt > 0 && f.hurtMax > 0 && f.hurtStyle !== 'none';
      if (hurting) this.style = f.hurtStyle;
      const h = chase1(this.sHurt, hurting ? Math.min(1, (f.hurt / f.hurtMax) * 2.5) : 0, 80, 0.9, dt);
      const loll = Math.sin(this.t * 2 * Math.PI * 0.9);
      switch (this.style) {
        case 'legs': drop += c.rigHurtLegsDrop * h; this.kneeIn = 0.7 * h; this.wobbleAmp = 1 + 0.5 * h; pitch += 6 * h; break;                                             // the knees buckle; he staggers
        case 'reach': pitch -= c.rigHurtReachLeanDeg * h; headRollX = loll * 11 * DEG * h; headPitchX = 9 * DEG * h; toe = 0.7 * h; fwd -= 0.03 * h; shrug -= 0.012 * h; break;   // back on his heels, head loose (the sim has his hands wide)
        case 'cover': pitch += c.rigHurtCoverHunchDeg * h; shrug += 0.03 * h; headPitchX = -10 * DEG * h; drop += 0.03 * h; this.wobbleAmp = 1 - 0.55 * h; break;              // small and tight behind the gloves
        case 'elbow': roll += this.struckSide * c.rigHurtElbowLeanDeg * h; pitch -= buckle * c.rigBuckleFoldDeg * 0.5 * h; coverHold = 0.92 * h; lat += this.struckSide * 0.03 * h; break;   // leaning onto the pinned elbow, not folded over
        case 'knee': drop += c.rigHurtKneeDrop * h; lat += this.struckSide * 0.07 * h; pitch -= buckle * c.rigBuckleFoldDeg * 0.25 * h; break;                                  // sinking toward that knee
        default: break;                                                                                                                                                          // fold: the buckle above
      }
      // A body shot that lands a beat late (hurtDelay): upright, tight and STILL, then the fold arrives with the sim's bodyHurt.
      this.still = chase1(this.sStill, f.hurtDelay > 0 ? 1 : 0, 300, 1, dt);
      shrug += 0.012 * this.still;
    }
    // Taking a knee: the dip as he decides (kneeT runs up to takeKneeHold while the input is held).
    if (c.rigDownV2 && f.kneeT > 0 && !f.down) { const kd = smooth(f.kneeT / Math.max(1e-3, c.takeKneeHold)); drop += c.rigDownKneeDip * kd; pitch += 6 * kd; }
    // The nerfed punch (PunchState.nerf): an arm punch — weight on the back foot, chest and head away from it; and the flinch he throws through.
    const nerf = chase1(this.sNerf, c.rigNerfV2 && f.punch.type !== null ? f.punch.nerf ?? 0 : 0, 300, 1, dt);
    pitch -= c.rigNerfLeanDeg * nerf * env; fwd -= 0.04 * nerf * env;
    this.hipFollowScale = 1 - 0.7 * nerf; this.heelScale = 1 - nerf;
    const flinch = chase1(this.sFlinch, c.rigNerfV2 && f.hitT > 0 ? f.hitSev : 0, 500, 0.9, dt);
    shrug += c.rigFlinch * flinch; headPitchX -= 8 * DEG * flinch;
    // The combination: rocking back on the heels while the knockback is held; the attacker's lead foot goes with the sim's follow step.
    if (this.rockT > 0) this.rockT = Math.max(0, this.rockT - dt);
    const rock = chase1(this.sRock, c.rigComboV2 && this.rockT > 0 ? this.rockN : 0, 220, 0.8, dt);
    pitch -= c.rigComboRockDeg * rock; fwd -= 0.015 * rock; toe = Math.max(toe, rock / 3);
    this.toeUp = toe;
    this.followStep = c.rigComboV2 && f.punch.type !== null && toLocal(f.stagger.x, 0, f.stagger.z)[0] > 0.25;
    const K = 260, Z = 0.75;
    this.chestPitch = chase1(this.sPitch, pitch * DEG, K, Z, dt) + chase1(this.kFoldPitch, 0, 120, 0.45, dt) - chase1(this.kRock, 0, 150, 0.5, dt) * (0.4 + 0.6 * Math.max(stun, 0.4));
    this.chestRoll = chase1(this.sRoll, roll * DEG, K, Z, dt) + chase1(this.kFoldRoll, 0, 110, 0.4, dt);
    this.chestYaw = chase1(this.sChestYaw, chestYaw + shapeYaw, K, Z, dt) + chase1(this.kChestYaw, 0, 120, 0.45, dt);
    this.shrug = chase1(this.sShrug, shrug, K, Z, dt);
    this.hipDrop = chase1(this.sDrop, drop, 420, 0.7, dt) + Math.max(0, chase1(this.kSag, 0, 70, 0.6, dt));
    this.hipFwd = chase1(this.sFwd, fwd, K, Z, dt) - chase1(this.kHipBack, 0, 110, 0.55, dt);
    this.hipLat = chase1(this.sLat, lat, 120, 0.8, dt) + chase1(this.kHipLat, 0, 110, 0.5, dt);
    for (let k = 0; k < 2; k++) { this.shoulderGive[k] = Math.max(0, chase1(this.kShoulder[k]!, 0, 140, 0.6, dt)); this.armKick[k] = Math.max(0, chase1(this.kArm[k]!, 0, 90, 0.5, dt)); }
    this.hipYaw = chase1(this.sHipYaw, hipYaw, K, Z, dt);
    this.leadStep = chase1(this.sStep, step, 500, 0.9, dt);
    this.heelBoth = chase1(this.sHeelB, heelBoth, 400, 0.8, dt);
    this.heelRear = c.rigBounceHeel * (1 - f.flat) * (1 - 0.6 * post);
    // The head: whip on a loose spring; rocks back with a blocked shot; hangs when winded.
    this.headYaw = chase1(this.kWhipYaw, 0, 90, 0.38, dt);
    this.headPitch = chase1(this.kWhipPitch, 0, 70, 0.4, dt) + this.kRock.x * 0.6 - buckle * 14 * DEG - fatigue * 6 * DEG + chase1(this.sShapeHead, shapeHead, 200, 0.8, dt) + headPitchX;
    this.headRoll = clinch * 16 * DEG * leadSign + (c.clinchV2 ? tied * c.rigClinchV2HeadDeg * DEG * leadSign : 0) + headRollX + chase1(this.kHeadRoll, 0, 80, 0.4, dt);
    // (A neck has limits, however many kicks stack: first film of rigReactV2 had a clean chin shot pointing the face at the ceiling.)
    this.headPitch = Math.max(-40 * DEG, Math.min(48 * DEG, this.headPitch)); this.headYaw = Math.max(-70 * DEG, Math.min(70 * DEG, this.headYaw)); this.headRoll = Math.max(-35 * DEG, Math.min(35 * DEG, this.headRoll));
    // Clinch: the head goes forward and to its own lead side — onto the other man's shoulder; his does the same, so they pass.
    this.headFwd = clinch * c.rigClinchHead; this.headLat = clinch * c.rigClinchHead * leadSign;
    // Covering up after a body shot: quick down, slow back.
    if (this.coverT > 0) this.coverT = Math.max(0, this.coverT - dt);
    const cu = this.coverT > 0 ? 1 - this.coverT / this.coverDur : 1;
    this.cover = this.coverT > 0 ? smooth(cu / 0.18) * (1 - smooth((cu - 0.55) / 0.45)) : 0;
    if (coverHold > this.cover) { this.cover = coverHold; this.coverSide = this.struckSide; }   // winded, elbow: it stays pinned
    this.wobble = winded ? 0 : 1;
    this.breathRate = lerp(1, c.rigBreathTired, fatigue) * (winded ? 1.5 : 1);
    this.breathAmp = lerp(1, c.rigBreathTiredAmp, fatigue) * (winded ? 1.6 : 1);

    // ── The get-up: lying → stir → a knee → (a slump) → the rise ──
    const phase: GetUpPhase = f.getUp.phase;
    const upT = !f.down ? 1 : phase === 'stir' ? c.rigGetUpStir : phase === 'knee' ? c.rigGetUpKnee : phase === 'slump' ? c.rigGetUpSlump : phase === 'rise' ? 0.9 : 0;
    this.up = clamp01(chase1(this.sUp, upT, (f.down ? c.rigGetUpK : c.rigGetUpK * 1.6) * (c.rigDownV2 && f.downKind === 'flash' ? 3 : c.rigDownV2 && f.downKind === 'knee' ? 1.8 : 1), phase === 'slump' ? 1 : 0.75, dt));
    // He is not steady: a slow sway while he is anywhere between the canvas and his feet.
    this.struggle = f.down && phase !== 'down' && phase !== 'none' ? Math.sin(this.t * 5.3) * 0.5 + Math.sin(this.t * 8.1 + 1) * 0.3 : 0;

    // ── Face and skin ──
    if (this.winceT > 0) this.winceT = Math.max(0, this.winceT - dt);
    if (this.mouthT > 0) this.mouthT = Math.max(0, this.mouthT - dt);
    this.wince = Math.max(smooth(this.winceT / 0.18), winded ? 0.75 : 0, f.down && phase !== 'rise' ? 0.6 : 0, flinch, this.still * 0.5);
    this.mouthOpen = Math.max(smooth((fatigue - c.rigMouthFrom) / Math.max(0.05, 1 - c.rigMouthFrom)) * 0.85, winded ? 0.9 : 0, f.down ? 0.7 : 0, smooth(this.mouthT / 0.1) * 0.8);
    this.sweat = clamp01(c.rigSweatBase + c.rigSweatFatigue * fatigue + c.rigSweatCap * (1 - f.staminaCap) + 0.3 * f.wear);
    const dh = f.damage.head, db = f.damage.body + f.damage.liver;
    const tot = this.hitsL + this.hitsR;
    const shareL = tot > 0 ? this.hitsL / tot : 0.5;
    const swell = clamp01((dh - c.rigSwellFrom) / Math.max(0.05, c.rigSwellFull - c.rigSwellFrom));
    this.swellL = clamp01(swell * (0.25 + 1.5 * shareL));
    this.swellR = clamp01(swell * (0.25 + 1.5 * (1 - shareL)));
    const cut = (from: number): number => clamp01((dh - from) / 0.35);
    const worse = shareL >= 0.5;
    this.cuts.browL = worse ? cut(c.rigCutFrom) : cut(c.rigCutFrom * 2.1);
    this.cuts.browR = worse ? cut(c.rigCutFrom * 2.1) : cut(c.rigCutFrom);
    this.cuts.lip = cut(c.rigCutFrom * 1.3);
    this.cuts.nose = cut(c.rigCutFrom * 1.7);
    this.cuts.cheekL = worse ? cut(c.rigCutFrom * 2.4) : 0;
    this.cuts.cheekR = worse ? 0 : cut(c.rigCutFrom * 2.4);
    this.reddenHead = clamp01(dh * c.rigReddenGain);
    this.reddenBody = clamp01(db * c.rigReddenGain);
    // By side: the body ledger split by which flank the shots landed on (events), and the liver ledger all on the right.
    const bt = this.bodyL + this.bodyR;
    const bShareR = bt > 0 ? this.bodyR / bt : 0.5;
    this.reddenBodyR = clamp01((f.damage.body * 2 * bShareR + f.damage.liver * 2.5) * c.rigReddenGain);
    this.reddenBodyL = clamp01(f.damage.body * 2 * (1 - bShareR) * c.rigReddenGain);
  }
}

export type { Spring1 };

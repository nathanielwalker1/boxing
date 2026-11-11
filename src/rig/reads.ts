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
import { fighterStyle, lerp, spring1, type Config, type FighterState, type GetUpPhase, type PunchVariant, type Side, type SimEvent, type Spring1 } from '../core';
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
  private t = 0;
  /** The elbow drops to cover the struck side after a body shot: 0..1, and which side (+1 = the fighter's right). */
  cover = 0; coverSide = 1;
  /** Clinch: the drawn head's lean onto the other man's shoulder, m (forward, toward the right). */
  headFwd = 0; headLat = 0;
  /** Reddening of the torso by side (the liver is on the right). */
  reddenBodyR = 0; reddenBodyL = 0;

  constructor(private side: Side) {}

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
        if (e.part === 'head') {
          // Three sizes that cannot be mistaken for each other: a glancing shot barely turns the head; a clean one
          // snaps it; a flush one whips it right round, rocks the chest back with it and takes longer to come home.
          const whip = c.rigFlushWhipDeg * DEG * (e.grade === 'flush' ? 1 : e.grade === 'clean' ? 0.42 : 0.05);
          // The head goes with the punch: velocity into a loose spring, so it follows through and returns.
          this.kWhipYaw.v += -(iR / il) * whip * 16;
          this.kWhipPitch.v += -(iF / il) * whip * 12;
          // …and the body answers: flush, the chest goes back hard and the knees give for a beat; clean, a small rock; glancing, nothing.
          if (e.grade === 'flush') { this.kRock.v += c.rigBlockRockDeg * DEG * 48; this.kSag.v += 0.9; } else if (e.grade === 'clean') this.kRock.v += c.rigBlockRockDeg * DEG * 10;
          if (iR > 0) this.hitsL += e.power; else this.hitsR += e.power;   // pushed right = struck on the left
        } else {
          const fold = c.rigBodyFoldDeg * DEG * g;
          this.struckSide = e.liver ? 1 : iR > 0 ? -1 : 1;                   // the liver is on the fighter's right
          this.kFoldRoll.v += this.struckSide * fold * 14;
          this.kFoldPitch.v += fold * 9;
          if (this.struckSide > 0) this.bodyR += e.power; else this.bodyL += e.power;
          if (e.grade !== 'glancing') { this.coverT = c.rigCoverTime * (e.grade === 'flush' ? 1.4 : 1); this.coverDur = this.coverT; this.coverSide = this.struckSide; }
        }
        if (e.grade !== 'glancing') this.winceT = Math.max(this.winceT, c.rigWinceTime * (e.grade === 'flush' ? 1.4 : e.part === 'body' ? 1 : 0.5));
        const sprayK = e.part === 'head' ? (e.grade === 'flush' ? 1 : e.grade === 'clean' ? 0.4 : 0) : 0;
        this.hits.push({ part: e.part, squash: g, squashDur: e.grade === 'flush' ? c.rigGradeFlush : 1, spray: Math.round(c.rigSprayCount * sprayK * (0.3 + 0.7 * this.sweat)), at: e.at, dir: e.impulse });
      } else if (e.type === 'punchBlock' && e.target === this.side) {
        this.kRock.v += c.rigBlockRockDeg * DEG * 14 * Math.min(1.5, 0.5 + e.stun * 4);
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
    const clinch = chase1(this.sClinch, f.clinch.active ? 1 : 0, 90, 0.9, dt);
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
      + buckle * c.rigBuckleFoldDeg + clinch * c.rigClinchLeanDeg
      + Math.min(1, droop / 0.1) * 5 * c.rigGuardSlump
      - ropes * c.rigRopesLeanDeg - broken * 5;
    let roll = 0, shrug = post * 0.012 - droop * c.rigGuardSlump - broken * c.rigBrokenSlump - buckle * 0.02;
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
    const K = 260, Z = 0.75;
    this.chestPitch = chase1(this.sPitch, pitch * DEG, K, Z, dt) + chase1(this.kFoldPitch, 0, 120, 0.45, dt) - chase1(this.kRock, 0, 150, 0.5, dt) * (0.4 + 0.6 * Math.max(stun, 0.4));
    this.chestRoll = chase1(this.sRoll, roll * DEG, K, Z, dt) + chase1(this.kFoldRoll, 0, 110, 0.4, dt);
    this.chestYaw = chase1(this.sChestYaw, chestYaw, K, Z, dt);
    this.shrug = chase1(this.sShrug, shrug, K, Z, dt);
    this.hipDrop = chase1(this.sDrop, drop, 420, 0.7, dt) + Math.max(0, chase1(this.kSag, 0, 70, 0.6, dt));
    this.hipFwd = chase1(this.sFwd, fwd, K, Z, dt);
    this.hipLat = chase1(this.sLat, lat, 120, 0.8, dt);
    this.hipYaw = chase1(this.sHipYaw, hipYaw, K, Z, dt);
    this.leadStep = chase1(this.sStep, step, 500, 0.9, dt);
    this.heelBoth = chase1(this.sHeelB, heelBoth, 400, 0.8, dt);
    this.heelRear = c.rigBounceHeel * (1 - f.flat) * (1 - 0.6 * post);
    // The head: whip on a loose spring; rocks back with a blocked shot; hangs when winded.
    this.headYaw = chase1(this.kWhipYaw, 0, 90, 0.38, dt);
    this.headPitch = chase1(this.kWhipPitch, 0, 90, 0.4, dt) + this.kRock.x * 0.6 - buckle * 14 * DEG - fatigue * 4 * DEG;
    this.headRoll = clinch * 16 * DEG * leadSign;
    // Clinch: the head goes forward and to its own lead side — onto the other man's shoulder; his does the same, so they pass.
    this.headFwd = clinch * c.rigClinchHead; this.headLat = clinch * c.rigClinchHead * leadSign;
    // Covering up after a body shot: quick down, slow back.
    if (this.coverT > 0) this.coverT = Math.max(0, this.coverT - dt);
    const cu = this.coverT > 0 ? 1 - this.coverT / this.coverDur : 1;
    this.cover = this.coverT > 0 ? smooth(cu / 0.18) * (1 - smooth((cu - 0.55) / 0.45)) : 0;
    this.wobble = winded ? 0 : 1;
    this.breathRate = lerp(1, c.rigBreathTired, fatigue) * (winded ? 1.5 : 1);
    this.breathAmp = lerp(1, c.rigBreathTiredAmp, fatigue) * (winded ? 1.6 : 1);

    // ── The get-up: lying → stir → a knee → (a slump) → the rise ──
    const phase: GetUpPhase = f.getUp.phase;
    const upT = !f.down ? 1 : phase === 'stir' ? c.rigGetUpStir : phase === 'knee' ? c.rigGetUpKnee : phase === 'slump' ? c.rigGetUpSlump : phase === 'rise' ? 0.9 : 0;
    this.up = clamp01(chase1(this.sUp, upT, f.down ? c.rigGetUpK : c.rigGetUpK * 1.6, phase === 'slump' ? 1 : 0.75, dt));
    // He is not steady: a slow sway while he is anywhere between the canvas and his feet.
    this.struggle = f.down && phase !== 'down' && phase !== 'none' ? Math.sin(this.t * 5.3) * 0.5 + Math.sin(this.t * 8.1 + 1) * 0.3 : 0;

    // ── Face and skin ──
    if (this.winceT > 0) this.winceT = Math.max(0, this.winceT - dt);
    this.wince = Math.max(smooth(this.winceT / 0.18), winded ? 0.75 : 0, f.down && phase !== 'rise' ? 0.6 : 0);
    this.mouthOpen = Math.max(smooth((fatigue - c.rigMouthFrom) / Math.max(0.05, 1 - c.rigMouthFrom)) * 0.85, winded ? 0.9 : 0, f.down ? 0.7 : 0);
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

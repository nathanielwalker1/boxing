/**
 * sim/combat.ts — punch start, punch clock, hit resolution and impulse.
 * Port of legacy/src/main.js _resolvePunch / _resolveAttack and the punch
 * timer in fighter.js, in SI.
 *
 * Overhaul 2026-11-11 (docs/OVERHAUL_SIM.md): a press throws a VARIANT
 * (variants.ts); a wind-up can be feinted; a land is GRADED (grade.ts) and
 * builds a combination; a block costs (stun, guard wear, chip) and has a
 * shape (hooks come round it, uppercuts split it, it half covers the body);
 * a slip loads a counter and slipping into a punch hurts more; the body is
 * its own ledger (resources.ts) with its own hurt state (stun.ts).
 */
import type { BodyPart, Config, FighterState, FrameInput, HitGrade, PunchType, Side, SimEvent, SimState, Vec3 } from '../core';
import { atan2, clamp, closestOnSegment, frameOf, lerp, smoothstep, sphereCapsuleOverlap, sqrt, v2dist, v2dot, handLateralSign, worldToLocal } from '../core';
import { PUNCHES, punchCrouch, punchEnvelope, punchHand, punchLean, punchTwist, whiffPhases, whiffRecoveryMult } from './punches';
import { EMPTY_BUFFER, MASK_CROSS, MASK_HOOK, MASK_JAB, MASK_UPPERCUT, PUNISH_BLOCK, PUNISH_SLIP, brokenMult, chainCarry, cockMult, idlePunch, prevPunchMask, punchBuffer, punchMask, punishSource, setBrokenMult, setChainCarry, setCockMult, setPrevPunchMask, setPunchBuffer, setStuffed, setWhiffMult, stuffed, targetCut, touchedBlock, whiffMult } from './state';
import { applyReaction } from './reaction';
import { takeHit } from './resources';
import { slipBack, slipLateral } from './slip';
import { applyPunish } from './vulnerability';
import { applyBodyHurt, applyStun, stunPunchLocked } from './stun';
import { VARIANTS, aimAtPress, pickVariant } from './variants';
import { ESCAPE_AT, addHop } from './footing';
import { gradeHit } from './grade';

const DEG = Math.PI / 180;

/** Two pressed on the same tick: the faster punch wins. */
function fastestOf(mask: number): PunchType | null {
  return mask & MASK_JAB ? 'jab' : mask & MASK_CROSS ? 'cross' : mask & MASK_HOOK ? 'hook' : mask & MASK_UPPERCUT ? 'uppercut' : null;
}
const maskOf = (t: PunchType): number => t === 'jab' ? MASK_JAB : t === 'cross' ? MASK_CROSS : t === 'hook' ? MASK_HOOK : MASK_UPPERCUT;

/**
 * Can a new punch start this tick? With the guard down, yes. With one in
 * flight, once its recover phase is far enough through — the combo window:
 * the next punch cuts the tail of the retraction. The hit confirm
 * (2026-09-17): a punch that TOUCHED something (land or block) opens at
 * punchChainOnHit of its recovery, a miss at punchChainAt of its stretched
 * one. The AI reads the same rule.
 */
export function canStartPunch(f: FighterState, cfg: Config): boolean {
  if (stunPunchLocked(f, cfg)) return false;   // rocked / winded: the first seconds throw nothing
  if (cfg.blockStunOn && f.blockStun > 0) return false;   // held by a shot on the guard (or a shove)
  if (f.clinch.active || f.pivot.dir !== 0) return false;
  const p = f.punch;
  if (p.type === null) return true;
  if (p.feint) return false;
  const at = p.contact ? cfg.punchChainOnHit : cfg.punchChainAt;
  return p.phase === 'recover' && p.t >= at * PUNCHES[p.type].phases(cfg).recover;
}

/**
 * Hook/uppercut: the joystick at the press picks the hand (x < 0 = lead).
 * Every punch costs staminaPunchCost, lands or not; thrown gassed (below
 * lowStamina, judged before the cost) its wind-up runs lowStaminaCockMult
 * times slower — a slower pull-back, not a strike in slow motion.
 *
 * Overhaul: the press throws the VARIANT the moment calls for (variants.ts);
 * the hand a slip LOADED winds up faster and hits harder; fatigue slows every
 * phase; and a lone heavy punch never beats its tell (tellMinHeavy).
 */
function startPunch(f: FighterState, opp: FighterState | null, side: Side, type: PunchType, moveX: number, moveY: number, cfg: Config, events: SimEvent[]): void {
  const def = PUNCHES[type];
  const hand = punchHand(def, moveX);
  const variant = pickVariant(f, type, moveY, cfg);
  const v = VARIANTS[variant];
  // Inside a chain the body is already turned and loaded from the last
  // punch's follow-through, so the wind-up is comboCockScale as long.
  const chained = f.punch.type !== null;
  const loaded = cfg.slipLoadedOn && f.loaded !== 0 && (f.loaded === -1) === (hand === 'lead');
  const slow = cfg.fatigueOn ? f.punchSlow : 1;
  const ph = def.phases(cfg);
  let cock = (f.stamina < cfg.lowStamina ? cfg.lowStaminaCockMult : 1) * (chained ? cfg.comboCockScale : 1) * v.time(cfg) * (loaded ? cfg.slipLoadedCock : 1);
  // The tell: a heavy punch that opens an attack is always readable.
  if (cfg.tellsOn && type !== 'jab' && !chained && ph.cock > 0) cock = Math.max(cock, (cfg.tellMinHeavy / slow - ph.extend) / ph.cock);
  setCockMult(f, cock);
  setWhiffMult(f, 1);
  setStuffed(f, false);
  setBrokenMult(f, 1);
  // The body pose the last punch leaves behind (2026-09-22): a chained
  // wind-up blends out of it instead of snapping to zero and reloading.
  setChainCarry(f, { on: chained, twist: f.torsoTwist, fwd: f.lean.fwd, lat: f.lean.lat, crouch: f.crouch });
  f.stamina = Math.max(0, f.stamina - cfg.staminaPunchCost);
  f.punch = {
    ...idlePunch(hand), type, phase: 'cock', variant,
    tell: (ph.cock * cock + ph.extend) * slow, timeMult: slow,
    powerMult: v.power(cfg) * (loaded ? cfg.slipLoadedPower : 1), moveScale: v.move(cfg), loaded,
    aim: opp ? aimAtPress(v, opp, cfg) : v.aimDrop(cfg),
  };
  if (loaded) { f.loaded = 0; f.loadedT = 0; }
  const fr = frameOf(f.yaw);
  // The step-in (2026-09-16): a straight thrown with the stick pushed forward
  // takes a short lunge step with it — a burst on the stagger channel (it
  // decays on its own, is not capped by walking speed, and counts as approach
  // momentum in the impulse), covering punchStepIn metres by the time the
  // fist lands. Hooks and uppercuts are thrown from where you stand.
  if (def.smotherable && cfg.punchStepIn > 0 && moveY > cfg.punchStepInStick && !f.down) {
    // Sized so that punchStepIn metres are covered by the resolve moment
    // whatever the stagger decay is (the burst keeps gliding a little after).
    const k = cfg.staggerDecay, tPeak = ph.cock + ph.extend;
    const covered = 1 - Math.exp(-k * tPeak);
    const vel = cfg.punchStepIn * k / Math.max(0.05, covered);
    f.stagger.x += fr.fwd.x * vel;
    f.stagger.z += fr.fwd.z * vel;
  }
  // Thrown going away (retreat jab, check hook): the feet give ground with it, on the hop channel.
  const hop = v.hop(cfg);
  if (hop > 0 && !f.down) addHop(f, -fr.fwd.x, -fr.fwd.z, hop, cfg);
  events.push({ type: 'punchStart', side, punch: type, hand, variant, tell: f.punch.tell });
}

/**
 * Block and punch input for one fighter this tick. Block is a level and
 * engages whenever no punch is in flight; a punch fires on the rising edge of
 * its flag. Both re-check fresh every tick, which is what makes switching
 * instant.
 *
 * A press that cannot fire yet (one in flight, before the chain window) is
 * buffered for punchBuffer seconds — up to punchBufferDepth presses queue in
 * order, a press beyond that replaces the last, the stick at each press is
 * kept for the hand — and fires on the first tick it can. Without this,
 * jab-cross spam lost every press that landed inside the previous punch, and
 * a held key has no edge, so it read as "cross… cross…"; with a depth of one
 * a fast 1-2-3 lost its 2. The guard coming up, or the canvas, forgets the
 * buffer: block wins.
 *
 * The feint (overhaul): block pressed while a wind-up has not passed
 * feintCommit cancels the punch — it rewinds home fast (advancePunch), most
 * of its stamina comes back, and the guard is up the moment the fist is home.
 */
export function stepActions(f: FighterState, side: Side, input: Readonly<FrameInput>, cfg: Config, dt: number, events: SimEvent[], opp: FighterState | null = null): void {
  const mask = punchMask(input);
  const pressed = fastestOf(mask & ~prevPunchMask(f));
  setPrevPunchMask(f, mask);

  const p = f.punch;
  if (cfg.feintOn && input.block && p.type !== null && !p.resolved && !p.feint && !stuffed(f) && p.phase === 'cock') {
    const ph = PUNCHES[p.type].phases(cfg);
    if (p.progress * ph.total <= cfg.feintCommit * ph.cock) {
      p.feint = true;
      f.stamina = Math.min(1, f.stamina + cfg.staminaPunchCost * cfg.feintRefund);
      events.push({ type: 'feint', side, punch: p.type, variant: p.variant });
    }
  }

  const guardOpen = f.punch.type === null;
  const wasBlocking = f.block;
  // The guard cannot come up inside a slip window (v1: isBlocking requires
  // slipTimer === 0); the head is committed. It engages the tick the window closes.
  // Nor through a guard break, nor tied up.
  f.block = input.block && guardOpen && !f.down && !f.slip.active && f.guardBroken === 0 && !f.clinch.active;
  f.blockT = f.block ? (wasBlocking ? f.blockT + dt : 0) : 0;
  f.guard = f.down ? 'down' : f.block ? 'block' : 'rest';

  const buf = punchBuffer(f);
  buf.t = Math.max(0, buf.t - dt);
  if (buf.t === 0) { buf.mask = 0; buf.mask2 = 0; }

  if (input.block || f.down) { setPunchBuffer(f, { ...EMPTY_BUFFER }); return; }

  const open = canStartPunch(f, cfg);
  if (pressed !== null) {
    if (open) { startPunch(f, opp, side, pressed, input.move.x, input.move.y, cfg, events); buf.mask = 0; buf.mask2 = 0; buf.t = 0; }
    else if (cfg.punchBuffer > 0) {
      if (buf.mask && cfg.punchBufferDepth >= 2) { buf.mask2 = maskOf(pressed); buf.x2 = input.move.x; }
      else { buf.mask = maskOf(pressed); buf.t = cfg.punchBuffer; buf.x = input.move.x; buf.mask2 = 0; }
    }
  } else if (open && buf.mask) {
    // A buffered press keeps the hand it chose; the step-in reads the stick as it fires.
    startPunch(f, opp, side, fastestOf(buf.mask)!, buf.x, input.move.y, cfg, events);
    // The queued press moves up with a fresh life.
    buf.mask = buf.mask2; buf.x = buf.x2; buf.mask2 = 0; buf.t = buf.mask ? cfg.punchBuffer : 0;
  }
  setPunchBuffer(f, buf);
}

/**
 * Advance the punch clock. Returns true on the one tick the punch reaches its
 * resolve moment (peakAt), which is when the hit test runs.
 */
/** Seconds of slack on a phase boundary so a boundary that falls on a tick is taken on that tick. */
const PHASE_EPS = 1e-6;

export function advancePunch(f: FighterState, cfg: Config, dt: number): boolean {
  const p = f.punch;
  if (p.type === null) return false;
  const def = PUNCHES[p.type];
  const ph = whiffPhases(f, def.phases(cfg));   // a miss drops the hold (fist and body come home together)
  // A gassed throw's cock phase runs slower in real time (the telegraph), and
  // a punch that missed retracts slower (the whiff cost, set at the resolve);
  // the phase table itself is untouched, so every pose still reads off
  // `progress`, and the exposure curve stretches with the recovery for free.
  const was = p.progress * ph.total;
  // A STUFFED punch (hit clean mid-flight, see interruptPunch) runs its clock
  // BACKWARDS: every pose — fist, twist, lean, crouch — reads off progress,
  // so the arm retraces its path and the body unwinds through its load with
  // no jump anywhere; the jolt of the hit rides on top through the reaction
  // springs. It reaches home when the clock reaches 0. Nothing chains off it
  // and the guard waits (phase is never 'recover'): the momentum is gone.
  // A FEINT (overhaul) rewinds the same way, faster.
  const rewinding = stuffed(f) || p.feint;
  // The variant's time scale is in the cock multiplier (set at the press) and
  // applies again to the recovery; fatigue (timeMult) slows every phase.
  const rate = rewinding ? -(p.feint ? cfg.feintRewindRate : cfg.interruptRewindRate)
    : (was < ph.cock - PHASE_EPS ? 1 / cockMult(f) : was >= ph.cock + ph.extend - PHASE_EPS ? 1 / (whiffMult(f) * VARIANTS[p.variant].time(cfg)) : 1) / Math.max(1e-6, p.timeMult);
  const elapsed = clamp(was + dt * rate, 0, ph.total);
  p.progress = elapsed / ph.total;
  if (rewinding && elapsed <= 0) {
    f.punch = idlePunch(p.hand);
    f.lean.fwd = 0; f.lean.lat = 0; f.torsoTwist = 0; f.crouch = 0;
    return false;
  }
  // Phase boundaries with a float epsilon: twelve ticks of 1/60 sum to a hair
  // under 0.2, and a phase that ends exactly on a tick must end ON that tick,
  // not one later (the whiff stretch and the hit test both key off it).
  if (elapsed < ph.cock - PHASE_EPS) { p.phase = 'cock'; p.t = elapsed; }
  else if (elapsed < ph.cock + ph.extend - PHASE_EPS) { p.phase = 'extend'; p.t = elapsed - ph.cock; }
  else { p.phase = 'recover'; p.t = Math.max(0, elapsed - ph.cock - ph.extend); }

  // Whole-body channels the rig draws: forward and lateral weight transfer,
  // torso twist (all peak at the resolve moment and hold with the fist) and
  // the body dip.
  const ext = punchEnvelope(elapsed, ph);
  // Context (2026-09-16): a punch thrown moving FORWARD leans further into
  // it (the lunge); thrown backing off it is the flicker — hips stay back,
  // little lean. Reads the fighter's own velocity along its facing.
  const fr = frameOf(f.yaw);
  const along = cfg.moveSpeed > 1e-6 ? (f.vel.x * fr.fwd.x + f.vel.z * fr.fwd.z) / cfg.moveSpeed : 0;
  const leanMove = clamp(1 + cfg.punchLeanMove * along, 0.4, 1.5);
  const leanShape = punchLean(def, elapsed, ph, cfg);
  f.lean.fwd = cfg.punchLean * def.lean * (leanShape > 0 ? leanShape * leanMove : leanShape);
  f.lean.lat = def.sway * handLateralSign(p.hand, f.stance) * ext;
  f.torsoTwist = (p.hand === 'lead' ? 1 : -1) * handLateralSign('lead', f.stance) * def.turn * punchTwist(def, elapsed, ph);
  f.crouch = punchCrouch(def, elapsed, ph, cfg);
  // Chained (2026-09-22): through the first comboBlend of the flight the
  // body blends from where the last punch left it into this punch's own
  // load and drive — the 1 was at its peak twist when the 2 was pressed;
  // the cross turns straight through from there instead of snapping to
  // neutral, coiling and then driving (measured: 2 direction reversals in
  // the chained wind-up → 0). The peak pose at the hit test is untouched.
  // A stuffed chained punch rewinds to its own start (the carry is dropped
  // at the stuff, where the jolt of the hit covers the step).
  const carry = chainCarry(f);
  const blendLen = (ph.cock + ph.extend) * cfg.comboBlend;   // over the flight: the extra travel spreads over ~8 ticks, not 5, so no tick is steeper than the drive's own
  if (carry.on && blendLen > 0 && elapsed < blendLen) {
    const k = smoothstep(elapsed / blendLen);
    f.torsoTwist = lerp(carry.twist, f.torsoTwist, k);
    f.lean.fwd = lerp(carry.fwd, f.lean.fwd, k);
    f.lean.lat = lerp(carry.lat, f.lean.lat, k);
    f.crouch = lerp(carry.crouch, f.crouch, k);
  }

  let peak = false;
  if (!rewinding && !p.resolved && p.progress >= ph.peakAt - PHASE_EPS / ph.total) { p.resolved = true; peak = true; }
  if (elapsed >= ph.total) {
    f.punch = idlePunch(p.hand);
    f.lean.fwd = 0;
    f.lean.lat = 0;
    f.torsoTwist = 0;
    f.crouch = 0;
  }
  return peak;
}

/**
 * The interrupt (2026-09-22, Nate: "when you punch the opponent mid wind-up,
 * that should break their punch momentum"). `d` has just been hit CLEAN by
 * `by`. If `d`'s own punch is still in flight (not yet at its hit test), the
 * hit breaks it, by how far along it was:
 *   - at or before interruptStuffBefore of the flight → STUFFED: the punch
 *     never resolves, its clock runs backwards (advancePunch) so the fist and
 *     body come home the way they went, and nothing can start until it has.
 *   - later → it still arrives, but bleeds interruptPowerLoss of its impulse
 *     at the stuff line, fading to none at the arrival. A same-tick trade
 *     lands clean both ways (side 0 resolves first; its own punch has already
 *     resolved by the time side 1's lands, so it cannot be weakened — the one
 *     asymmetry, only on an exact-tick tie).
 * A punch in its hold or recovery has already happened: untouched.
 */
function interruptPunch(d: FighterState, target: Side, by: Side, cfg: Config, events: SimEvent[]): void {
  const p = d.punch;
  if (p.type === null || p.resolved || stuffed(d) || p.feint) return;
  const ph = PUNCHES[p.type].phases(cfg);
  const u = clamp(p.progress / Math.max(1e-6, ph.peakAt), 0, 1);   // how far through the flight (0 = just pressed, 1 = arriving)
  if (u <= cfg.interruptStuffBefore) {
    setStuffed(d, true);
    setChainCarry(d, { on: false, twist: 0, fwd: 0, lat: 0, crouch: 0 });
    events.push({ type: 'punchStuffed', side: target, by, punch: p.type });
    return;
  }
  const span = Math.max(1e-6, 1 - cfg.interruptStuffBefore);
  const loss = cfg.interruptPowerLoss * clamp((1 - u) / span, 0, 1);
  setBrokenMult(d, Math.min(brokenMult(d), 1 - loss));
}

/** A miss (or a punch stopped dead on the guard) ends the combination; a miss also costs wind and wears the stamina ceiling. */
function missed(a: FighterState, cfg: Config, whiff: boolean): void {
  a.combo = 0; a.comboT = 0;
  if (whiff && cfg.whiffCostOn) {
    a.stamina = Math.max(0, a.stamina - cfg.staminaWhiffCost);
    a.wear += cfg.whiffCapLoss;
  }
}

/**
 * How much of a held guard a punch meets, 0..1 (overhaul, brief A4). The
 * block covers the FRONT: full inside guardArcFullDeg of the blocker's
 * facing, nothing past guardArcNoneDeg — so a hook, which arrives from the
 * side, comes round it by how sideways it arrives plus any angle the
 * attacker has taken. An uppercut comes up between the elbows; the high
 * guard only half covers the body; a worn guard (guardHp) covers less.
 */
function guardCover(d: FighterState, base: PunchType, part: BodyPart, dirX: number, dirZ: number, cfg: Config): number {
  let cover = 1;
  if (cfg.guardShapeOn) {
    const fr = frameOf(d.yaw);
    const c = clamp(-(dirX * fr.fwd.x + dirZ * fr.fwd.z), -1, 1);
    const arrive = atan2(sqrt(Math.max(0, 1 - c * c)), c) / DEG;   // 0 = straight down the blocker's facing line
    cover *= 1 - smoothstep(clamp((arrive - cfg.guardArcFullDeg) / Math.max(1e-6, cfg.guardArcNoneDeg - cfg.guardArcFullDeg), 0, 1));
    if (base === 'uppercut') cover *= cfg.guardUppercutCover;
    if (part === 'body') cover *= cfg.guardBodyCover;
  }
  if (cfg.guardWearOn) cover *= lerp(cfg.guardWornCover, 1, clamp(d.guardHp, 0, 1));
  return cover;
}

/**
 * The hit test, run once at the resolve moment against the defender's
 * current boxes. Outcomes: beyond rangeMax = whiff; otherwise the attacking
 * glove sphere against head then body — a miss is a whiff, a hit is a land
 * or, if the guard is up, a block. A straight punch thrown inside smotherDist
 * still lands (a cramped jab is still a jab) but loses power, sliding to
 * smotherPowerFloor at the body-separation distance (Stage-1 feel-test,
 * 2026-09-03; supersedes v1's no-contact smother). Hooks and uppercuts keep
 * full power at any distance they can reach.
 */
export function resolvePunch(s: SimState, side: Side, type: PunchType, cfg: Config, events: SimEvent[]): void {
  const def = PUNCHES[type];
  const target: Side = side === 0 ? 1 : 0;
  const a = s.fighters[side], d = s.fighters[target];
  if (d.down) return;
  // Reached its hit-test tick and was stuffed on that same tick by the other
  // side's resolve (side 0 resolves first): it is already rewinding.
  if (stuffed(a) || a.punch.feint) return;
  const variant = a.punch.variant, v = VARIANTS[variant];

  const dist = v2dist(a.pos, d.pos);
  // A miss is paid for in the recovery: the arm comes back whiffRecoveryMult
  // (weighted per type) times slower, the next punch and the guard wait for
  // it, and the exposure curve decays over the longer window.
  const whiff = (): void => { events.push({ type: 'punchWhiff', side, punch: type, variant }); setWhiffMult(a, whiffRecoveryMult(def, cfg)); missed(a, cfg, true); };
  if (dist > cfg.rangeMax) { whiff(); return; }

  const g = a.gloves[a.punch.hand === 'lead' ? 0 : 1];
  const glove = { x: g.pos.x, y: g.pos.y, z: g.pos.z, r: a.body.gloveR };
  // Swept (2026-09-16): the glove is tested along the last punchSweepLen of
  // its LINE — the attacker's forward axis, ending where the fist is — not
  // only where it stopped. A cramped straight at body contact now reaches
  // PAST the head (the lean carries the shoulders forward) and still lands.
  // Along the forward axis only, so the sweep never drifts sideways into a
  // head that slipped just clear of the fist (the slip-into-the-hand body
  // shot stays a body shot).
  const afr = frameOf(a.yaw);
  const sweep = { a: { x: g.pos.x - afr.fwd.x * cfg.punchSweepLen, y: g.pos.y, z: g.pos.z - afr.fwd.z * cfg.punchSweepLen }, b: { x: g.pos.x, y: g.pos.y, z: g.pos.z }, r: a.body.gloveR };
  const bodyHit = (): boolean => {
    for (const t of [1, 0.5, 0]) {
      const p = { x: lerp(sweep.a.x, sweep.b.x, t), y: lerp(sweep.a.y, sweep.b.y, t), z: lerp(sweep.a.z, sweep.b.z, t), r: glove.r };
      if (sphereCapsuleOverlap(p, d.bodyBox)) return true;
    }
    return false;
  };
  // A fist stopped at the guard (2026-09-18/19): a held block, or a guard
  // hand pinned against the face so the fist sits on the gloves on the head
  // — the fist never reaches the head sphere, but if its line would have
  // (the sweep carried on by its own length) the guard absorbed it: a
  // BLOCKED head punch, not a whiff. A guard hand knocked freely aside sets
  // no flag, and a slipped head is off the line, so those stay what they are.
  const hand = a.punch.hand === 'lead' ? 0 : 1;
  const stoppedByGuard = touchedBlock(a, hand) && (d.block || targetCut(a, hand));
  const headHit = sphereCapsuleOverlap(d.headBox, sweep);
  const part: BodyPart | null = headHit ? 'head' : bodyHit() ? 'body' : stoppedByGuard ? 'head' : null;
  if (part === null) {
    whiff();
    // Slip classification (legacy main.js Stage 19 part 1): a punch that missed
    // because the defender READ it and one that missed because the attacker
    // was out of range are the same whiff to every other system, and must not
    // earn the same reward. The test is the head test again, at the head's
    // UN-slipped position: if the glove would have found it there, the slip is
    // the only thing that took the punch away. A classification layered on,
    // not a new outcome — the whiff above still stands for recovery and stamina.
    if (d.slip.active && d.slip.dir !== 0) {
      const fr = frameOf(d.yaw), lat = slipLateral(d), back = slipBack(d);
      // A roll's U is part of the move too: the head's un-rolled height is where the hook was going.
      const up = d.slip.kind === 'roll' ? d.slip.dip : 0;
      const home = { x: d.headBox.x - fr.right.x * lat + fr.fwd.x * back, y: d.headBox.y + up, z: d.headBox.z - fr.right.z * lat + fr.fwd.z * back, r: d.headBox.r };
      if (sphereCapsuleOverlap(home, sweep)) {
        events.push({ type: 'slip', side: target, dir: d.slip.dir, dodged: true, kind: d.slip.kind, chain: d.slip.chain });
        // The read (2026-09-18): a beat of hit-stop as the fist passes the
        // ear, so a well-timed slip is felt — Fight Night's brief slow moment
        // that opens the counter — and the attacker falls into the space:
        // a slipOverreach lunge on the stagger channel, so you SEE them go
        // past your ear, off balance, into the counter window.
        s.hitStop = Math.max(s.hitStop, cfg.slipDodgeHitStop);
        if (cfg.slipOverreach > 0) {
          const vel = cfg.slipOverreach * cfg.staggerDecay;   // a burst that covers slipOverreach metres as it decays
          a.stagger.x += afr.fwd.x * vel;
          a.stagger.z += afr.fwd.z * vel;
        }
        // The slip punish: the attacker is pinned exposed, and the counter
        // machinery does the rest. Survives the stretched recovery above —
        // the spike is a floor under the curve, on its own clock.
        applyPunish(a, cfg.slipPunishVuln, cfg.slipPunishDuration, PUNISH_SLIP);
        // The escape (overhaul): slipping or rolling under a punch with the
        // ropes behind you carries the feet along them, the way the head went.
        if (cfg.ropesOn && d.ropes > ESCAPE_AT && cfg.ropeEscapeHop > 0 && lat !== 0) {
          const sgn = lat > 0 ? 1 : -1;
          addHop(d, fr.right.x * sgn, fr.right.z * sgn, cfg.ropeEscapeHop, cfg);
          events.push({ type: 'escape', side: target, how: d.slip.kind === 'roll' ? 'roll' : 'slip' });
        }
      }
    }
    return;
  }

  // Impulse: base + attacker momentum toward the defender, floored so a
  // retreating punch still lands with something, scaled by lean and per-type.
  // Momentum is measured along the attacker→defender line; the impulse
  // DIRECTION is that line blended, per type, with the fist's own travel, so
  // a hook that crosses the face sends the head and body sideways.
  let adX: number, adZ: number;
  if (dist > 1e-6) { adX = (d.pos.x - a.pos.x) / dist; adZ = (d.pos.z - a.pos.z) / dist; }
  else { const fr = frameOf(a.yaw); adX = fr.fwd.x; adZ = fr.fwd.z; }
  // Walking plus the stagger channel: a step-in lunge (and, fairly, a shove
  // toward the defender) is momentum behind the fist too — and a burst's hop.
  const approachSpd = v2dot({ x: a.vel.x + a.stagger.x + a.hop.x, z: a.vel.z + a.stagger.z + a.hop.z }, { x: adX, z: adZ });
  let dirX = adX, dirZ = adZ;
  const swing = v.swing(cfg) ?? def.swing;
  if (swing > 0) {
    // The fist's travel direction. A torso-frame punch (hook) travels on the
    // TANGENT of the body's turn — perpendicular to the line from the
    // fighter's axis to the fist, in the turn's direction — which is the
    // analytic version of what the glove was doing (2026-09-16; the glove
    // spring has settled by the resolve, so its own velocity no longer says).
    let tx = 0, tz = 0;
    if (def.torsoFrame) {
      const loc = worldToLocal(a.pos, afr, g.pos);
      const sgn = a.torsoTwist >= 0 ? 1 : -1;
      const lf = loc.lateral * sgn, ll = -loc.forward * sgn;   // d/dθ of a yawed point: (z, −x) × sign(θ)
      tx = afr.fwd.x * lf + afr.right.x * ll; tz = afr.fwd.z * lf + afr.right.z * ll;
    } else { tx = g.vel.x; tz = g.vel.z; }
    const vlen = Math.hypot(tx, tz);
    if (vlen > 1e-6) {
      dirX = lerp(adX, tx / vlen, swing); dirZ = lerp(adZ, tz / vlen, swing);
      const n = Math.hypot(dirX, dirZ);
      if (n > 1e-6) { dirX /= n; dirZ /= n; } else { dirX = adX; dirZ = adZ; }
    }
  }
  let mag = cfg.punchImpulseBase + a.body.massKg * approachSpd * cfg.punchMomentumScale;
  mag = Math.max(cfg.punchImpulseBase * cfg.punchImpulseFloor, mag);
  mag *= 1 + a.lean.fwd * cfg.punchLeanScale;
  mag *= def.impulseMult(cfg);
  // The variant's own weight and a loaded counter's bonus, fixed at the press.
  mag *= a.punch.powerMult;
  // A punch hit late in its own flight arrives with less behind it (interruptPunch).
  mag *= brokenMult(a);
  // Context (2026-09-16): a defender moving AWAY along the impulse rolls with
  // it — less impulse — but stumbles further for it (below). With the ropes
  // behind him there is nowhere to roll to (overhaul).
  const dvx = d.vel.x + d.stagger.x + d.hop.x, dvz = d.vel.z + d.stagger.z + d.hop.z;
  const along = cfg.moveSpeed > 1e-6 ? (dvx * dirX + dvz * dirZ) / cfg.moveSpeed : 0;
  const retreat = clamp(along, 0, 1), closing = clamp(-along, 0, 1);
  const rollKeep = cfg.ropesOn ? lerp(1, cfg.ropeRollKeep, d.ropes) : 1;
  // `soft`: the losses a land already carries for being cramped or rolled with — a glancing grade never stacks on them.
  let soft = 1 - retreat * cfg.punchRollWith * rollKeep;
  if (def.smotherable && dist < cfg.smotherDist) {
    const span = Math.max(1e-6, cfg.smotherDist - cfg.separationDist);
    soft *= lerp(cfg.smotherPowerFloor, 1, clamp((dist - cfg.separationDist) / span, 0, 1));
  }
  mag *= soft;

  // The glove stops at what it hit: for the rest of the hold its centre rests
  // one glove radius (less the contact squash) off the struck surface, on the
  // side it arrived from — a hook rests on the cheek, an uppercut under the
  // chin. Bodies are flesh and bone, not empty (feel-test 2026-09-03).
  const sink = a.body.gloveR * cfg.contactSquash;
  const centre = part === 'head' ? { x: d.headBox.x, y: d.headBox.y, z: d.headBox.z } : closestOnSegment(d.bodyBox.a, d.bodyBox.b, g.pos);
  const r = (part === 'head' ? d.headBox.r : d.bodyBox.r) + a.body.gloveR - sink;
  let nx = g.pos.x - centre.x, ny = g.pos.y - centre.y, nz = g.pos.z - centre.z;
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen > 1e-6) { nx /= nlen; ny /= nlen; nz /= nlen; } else { nx = -adX; ny = 0; nz = -adZ; }
  a.punch.contact = { x: centre.x + nx * r, y: centre.y + ny * r, z: centre.z + nz * r };

  // Exposure: the target's vulnerability this tick (0 while blocking, by
  // construction) scales the ONE impulse value damage, stagger and reaction
  // all read, so a hit into an over-committed punch or a punish window is
  // harder, pushes further and reacts bigger without three multipliers.
  // A COUNTER (the flag, the event, the sting, the extra hit-stop) is only a
  // landing inside the window a SLIP opened (Nate, 2026-09-22: "I should
  // only ever have a counter if I've successfully slipped a punch"). Hitting
  // someone mid-punch or after a perfect block still hits harder; it is not
  // called a counter.
  const targetVuln = d.vuln;
  const counter = targetVuln > 0 && d.counterWindow > 0 && punishSource(d) === PUNISH_SLIP;
  mag *= 1 + targetVuln * cfg.counterImpulseBonus;
  // Overhaul: what the target's FEET were doing. Flat-footed he rides nothing; on the ropes there is nowhere for the head to go.
  if (cfg.flatFootedOn) mag *= 1 + cfg.flatImpulseBonus * d.flat;
  if (cfg.ropesOn) mag *= 1 + cfg.ropeImpulseBonus * d.ropes;
  // The wrong way: he slipped INTO it (the head is mid-slip and the punch found it, or the body it left behind).
  const wrongWay = cfg.wrongWayOn && d.slip.active && d.slip.dir !== 0 && d.slip.dir !== 2;
  if (wrongWay) mag *= cfg.slipWrongWayMult;

  // Perfect block: a guard younger than perfectBlockWindow at the impact —
  // and younger than perfectBlockLateFrac of the punch's flight, so it read
  // the ARRIVAL, not the start (see config). It absorbs the punch (stagger
  // and reaction stay) but costs nothing, and the attacker is pinned exposed.
  const guarded = d.block || (stoppedByGuard && !headHit);   // held up, or the gloves pinned on the face
  // The flight as thrown (the tell), in sim seconds: cock × its multipliers + extension.
  const flight = a.punch.timeMult > 0 ? a.punch.tell / a.punch.timeMult : a.punch.tell;
  // Only a HELD block can be perfect — a fist absorbed by a relaxed guard pinned on the face is a plain block.
  const perfect = d.block && d.blockT <= Math.min(cfg.perfectBlockWindow, cfg.perfectBlockLateFrac * flight);
  // The guard's shape and wear (overhaul): how much of it this punch meets. A perfect block meets all of it.
  // A RESTING guard that the fist pinned against the face is not a block: the hands were in the way (guardPinnedCover).
  const cover = !guarded ? 0 : perfect ? 1 : !d.block ? (cfg.guardShapeOn ? cfg.guardPinnedCover : 1) : guardCover(d, type, part, dirX, dirZ, cfg);
  const through = guarded && !perfect && cfg.guardShapeOn && cover < cfg.guardThroughAt;   // it came round or through: a land, at what the guard left of it
  const blocked = guarded && !through;
  const raw = mag;   // what arrived at the guard — block stun, guard wear and the chip threshold read this
  if (guarded) mag *= 1 - cfg.blockReduction * cover * (d.hurt > 0 ? cfg.stunBlockScale : 1);   // a rocked guard is loose

  // The grade (overhaul): only a land has one.
  let grade: HitGrade = 'clean';
  let combo = 0;
  if (!blocked) {
    const res = gradeHit({ a, d, def, v, part, dist, centre, glove: g.pos, line: afr.fwd, rising: type === 'uppercut', retreat, closing, wrongWay }, cfg);
    grade = through && res.grade === 'flush' ? 'clean' : res.grade;
    // Glancing: the larger of this and the losses already taken, never both. Flush: on top.
    if (grade === 'glancing') mag *= Math.min(1, cfg.gradeGlancingPower / Math.max(1e-6, soft));
    else if (grade === 'flush') mag *= cfg.gradeFlushPower;
    // The combination: each clean or flush land inside the window hits harder than the last.
    if (grade !== 'glancing') {
      a.combo = (a.comboT > 0 ? a.combo : 0) + 1;
      a.comboT = cfg.comboWindow;
      if (cfg.comboBuildOn) mag *= 1 + Math.min(cfg.comboBuildMax, cfg.comboBuildStep * (a.combo - 1));
      if (cfg.whiffCostOn) a.stamina = Math.min(1, a.stamina + cfg.staminaLandRefund);
    }
    combo = a.combo;
  } else missed(a, cfg, false);

  const power = mag / cfg.punchImpulseBase;
  const rawPower = raw / cfg.punchImpulseBase;
  const dir: Vec3 = { x: dirX, y: 0, z: dirZ };
  const impulse: Vec3 = { x: dirX * mag, y: 0, z: dirZ * mag };
  const at: Vec3 = { x: g.pos.x, y: g.pos.y, z: g.pos.z };

  // The liver: a hook to the body thrown with the hand that is on the target's RIGHT side (facing each other, the
  // attacker's left — an orthodox lead hook, a southpaw's rear). The hand, not the contact point: in this sim a hook
  // finishes across the front of the body, past the centre line.
  let liver = false;
  if (!blocked && part === 'body' && type === 'hook') {
    const dfr = frameOf(d.yaw), s = handLateralSign(a.punch.hand, a.stance);
    liver = (afr.right.x * dfr.right.x + afr.right.z * dfr.right.z) * s > 0;
  }

  // What the guard paid (overhaul): a shot on a HELD guard wears it and holds
  // the blocker; a light one takes no health. A perfect block pays nothing.
  let chip = 0, stun = 0;
  const light = blocked && !perfect && cfg.chipOn && rawPower < cfg.chipMinPower;
  if (d.block && !perfect) {
    if (cfg.blockStunOn) { stun = Math.min(cfg.blockStunMax, cfg.blockStunBase * rawPower); d.blockStun = Math.max(d.blockStun, stun); }
    if (cfg.guardWearOn) { d.guardHp = Math.max(0, d.guardHp - cfg.guardWearPerImpulse * raw); d.guardRest = 0; }
    if (blocked && !light) chip = mag * cfg.healthDamagePerImpulse * (part === 'body' && cfg.bodyDamageOn ? cfg.bodyHealthScale : 1);
  }

  if (perfect) events.push({ type: 'perfectBlock', side, target, punch: type, at, variant });
  else if (blocked) events.push({ type: 'punchBlock', side, target, punch: type, at, variant, part, chip, guard: d.guardHp, stun });
  else {
    events.push({ type: 'punchLand', side, target, punch: type, hand: a.punch.hand, part, at, impulse, power, counter, variant, grade, combo, liver, through, wrongWay });
    // The judges see clean lands and how hard they were (round.ts scoring).
    s.round.landed[side] += 1;
    s.round.power[side] += mag;
    d.clinch.reach = 0;   // a clean shot breaks a grab that had not taken
  }
  events.push({ type: 'hurt', side: target, part, impulse });
  if (counter && !blocked) events.push({ type: 'counter', side, target, punch: type });
  if (!blocked) interruptPunch(d, target, side, cfg, events);

  const stumble = 1 + retreat * cfg.punchRetreatStumble;   // hit while backing off: the feet go
  d.stagger.x += impulse.x / d.body.massKg * stumble;
  d.stagger.z += impulse.z / d.body.massKg * stumble;
  applyReaction(d, type, dir, mag, cfg);
  if (perfect) {
    applyPunish(a, cfg.perfectBlockPunishVuln, cfg.perfectBlockPunishDuration, PUNISH_BLOCK);
    s.hitStop = Math.max(s.hitStop, cfg.perfectBlockHitStop);
    // Deflected: the arm hangs out there for the window (overhaul).
    setWhiffMult(a, Math.max(whiffMult(a), cfg.perfectBlockRecoverMult));
  } else {
    takeHit(s, target, mag, blocked, cfg, events, part, light);
    // Hit-stop by grade: a glancing land barely registers, a clean one scales with its power, a flush one holds.
    const stop = blocked || !cfg.gradesOn || grade === 'clean' ? clamp(cfg.hitStopBase * power, 0, cfg.hitStopMax)
      : grade === 'glancing' ? cfg.hitStopGlancing : cfg.hitStopFlush;
    s.hitStop = Math.max(s.hitStop, stop + (counter ? targetVuln * cfg.counterHitStopBonus : 0));
    // The guard meter emptied: the hands are knocked apart.
    if (d.block && cfg.guardWearOn && d.guardHp <= 0 && !d.down) {
      d.guardBroken = cfg.guardBreakSeconds; d.block = false; d.blockT = 0; d.guard = 'rest';
      applyPunish(d, cfg.guardBreakVuln, cfg.guardBreakSeconds, PUNISH_BLOCK);
      events.push({ type: 'guardBreak', side: target, by: side, seconds: cfg.guardBreakSeconds });
    }
    // ROCKED (sim/stun.ts): a clean head shot from a punch that can rock is
    // measured against the target's threshold — rock, finish or flash.
    if (!blocked && part === 'head' && def.rocks && !d.down) {
      const n = events.length;
      applyStun(s, target, side, type, mag, cfg, events, counter);
      if (events.length > n) s.hitStop = Math.max(s.hitStop, cfg.stunHitStop);
    }
    // The body (overhaul): a clean body shot can wind him; a liver shot lights the fuse.
    if (!blocked && part === 'body' && grade !== 'glancing' && !d.down) {
      if (liver) d.damage.liver += mag * cfg.healthDamagePerImpulse;
      applyBodyHurt(s, target, side, mag, liver, cfg, events);
    }
  }
}

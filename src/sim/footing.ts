/**
 * sim/footing.ts — what the feet and the posture are doing (overhaul
 * 2026-11-11, brief A1 / A2 / A7). One step per fighter per tick derives the
 * state the rest of the sim and the rig read:
 *
 *   level      the held level modifier, eased (real height: the boxes and hands ride it)
 *   range      outside / mid / inside, and the inside posture
 *   flat       flat-footed: stood still too long, or gassed
 *   ropes      back to the ropes, cornered
 *   angle      how far off this fighter's facing line the opponent stands
 *   fatigue    punch slow-down, guard droop, the stamina ceiling
 *
 * and it starts and runs the two footwork moves that are not walking:
 *
 *   BURST      a double-tap of the stick: a short hop on its own velocity
 *              channel (`hop`), then a brief landing
 *   PIVOT      block + a lateral flick: the body swings round the planted
 *              lead foot; an opponent in range is slow to turn afterwards
 *
 * Pure and deterministic: no rng, no clocks.
 */
import type { Config, FighterState, FrameInput, GuardDef, RangeBand, Side, SimEvent, Vec2 } from '../core';
import { rated } from './ratings';
import { GUARDS, RING_HALF, SIM_DT, angleDelta, clamp, cos, frameOf, handLateralSign, sin, v2angle, v2dist } from '../core';
import { setStunAge, stunAge } from './state';
import { VARIANTS } from './variants';

const DEG = Math.PI / 180;

/** The guard a fighter holds (phase 2): his style's shape, or the high guard with styles off. */
export function guardOf(f: FighterState, cfg: Config): GuardDef {
  return GUARDS[cfg.stylesOn ? f.guardShape : 'high'];
}

/** How far the whole body sits below its rest height, m: the punch dip, the held level, the inside posture, the buckle — and the crouch of his guard (the peek-a-boo sits down). */
export function stanceDrop(f: FighterState, cfg: Config): number {
  return f.crouch + guardOf(f, cfg).crouch
    + (cfg.levelOn ? cfg.levelDrop * f.level : 0)
    + (cfg.postureOn ? cfg.insideCrouch * f.posture : 0)
    + (cfg.bodyHurtOn ? cfg.buckleDrop * f.buckle * hurtMods(f, cfg).buckle : 0);   // (a man sinking toward a knee folds deeper — `buckle` itself stays 0..1; read hurtStyle 'knee' for the rest)
}

export function rangeBand(dist: number, cfg: Config): RangeBand {
  return dist < cfg.rangeInside ? 'inside' : dist > cfg.rangeOutside ? 'outside' : 'mid';
}

/** 0..1: how worn the body is (damage.body against bodyWearFull). */
export function bodyWear(f: FighterState, cfg: Config): number {
  return cfg.bodyDamageOn && cfg.bodyWearFull > 0 ? clamp(f.damage.body / cfg.bodyWearFull, 0, 1) : 0;
}

/** 0..1: how exposed `f` is to an attacker standing where the opponent stands, from the angle alone. */
export function angleExposure(f: FighterState, cfg: Config): number {
  if (!cfg.anglesOn) return 0;
  const a = f.angle / DEG;
  return clamp((a - cfg.angleExposeDeg) / Math.max(1e-6, cfg.angleFullDeg - cfg.angleExposeDeg), 0, 1);
}

/** The mechanical differences between the kinds of hurt (polish phase, item 3): multipliers on what the hurt state already does. All 1 with hurtVarietyOn off. */
export function hurtMods(f: FighterState, cfg: Config): { move: number; guard: number; block: number; vuln: number; buckle: number; lock: number } {
  const m = { move: 1, guard: 1, block: 1, vuln: 1, buckle: 1, lock: 1 };
  if (!cfg.hurtVarietyOn || !(f.hurt > 0)) return m;
  switch (f.hurtStyle) {
    case 'legs': m.move = cfg.hurtLegsMove; break;
    case 'reach': m.guard = cfg.hurtReachGuard; m.vuln = cfg.hurtReachVuln; break;
    case 'cover': m.guard = 0; m.block = cfg.stunBlockScale > 0 ? cfg.hurtCoverBlock / cfg.stunBlockScale : 1; m.lock = cfg.hurtCoverLock; break;
    case 'elbow': m.guard = cfg.hurtElbowDroop; m.move = cfg.hurtElbowMove; break;
    case 'knee': m.buckle = cfg.hurtKneeBuckle; m.move = cfg.hurtKneeMove; break;
    default: break;
  }
  return m;
}

/** Everything that scales walking speed and push-off beyond stamina (movement.ts multiplies it in). */
export function moveScales(f: FighterState, cfg: Config): { speed: number; accel: number } {
  let speed = rated(f, 'speed', cfg.ratingSpeedFeet, cfg) * guardOf(f, cfg).move, accel = 1;   // foot speed: the rating, and a low guard's lighter feet
  if (cfg.levelOn) speed *= 1 - (1 - cfg.levelMoveScale) * f.level;
  speed *= 1 - cfg.bodyMoveLoss * bodyWear(f, cfg);
  if (f.hurt > 0 && f.hurtKind === 'body') speed *= Math.min(1, cfg.bodyHurtMoveScale * hurtMods(f, cfg).move);   // (by the kind of winded: polish phase. The rocked kinds are applied in movement.ts)
  if (cfg.blockStunOn && f.blockStun > 0) speed *= cfg.blockStunMoveScale;
  // A punch plants the feet by its own amount; once it has landed or missed the feet come free half-way.
  const p = f.punch;
  if (cfg.punchRootOn && p.type !== null) speed *= p.resolved ? (1 + p.moveScale) / 2 : p.moveScale;
  if (f.clinch.active || f.pivot.dir !== 0) speed = 0;
  if (cfg.flatFootedOn) accel *= 1 - (1 - cfg.flatAccelScale) * f.flat;
  if (f.burstT > cfg.burstTime) accel *= cfg.burstRecoverAccel;   // the landing
  return { speed, accel };
}

const approach = (x: number, target: number, step: number): number => x < target ? Math.min(target, x + step) : Math.max(target, x - step);

/** Timers and derived state for one fighter. Runs after actions and stamina, before locomotion. */
export function stepFooting(f: FighterState, opp: FighterState, input: Readonly<FrameInput>, cfg: Config, dt: number): void {
  const down0 = (t: number): number => Math.max(0, t - dt);
  f.burstCd = down0(f.burstCd); f.turned = down0(f.turned); f.pushCd = down0(f.pushCd);
  f.blockStun = down0(f.blockStun); f.clinch.cd = down0(f.clinch.cd);
  // Polish phase: how long this block stun has run, in REAL time (the punch lock is its first hitLockMax — combat.ts), and the hit window.
  setStunAge(f, f.blockStun > 0 ? stunAge(f) + SIM_DT : 0);
  if (f.hitT > 0) { f.hitT = down0(f.hitT); if (f.hitT === 0) f.hitSev = 0; }
  if (f.loadedT > 0) { f.loadedT = down0(f.loadedT); if (f.loadedT === 0) f.loaded = 0; }
  if (f.comboT > 0) { f.comboT = down0(f.comboT); if (f.comboT === 0) f.combo = 0; }
  if (f.guardBroken > 0) { f.guardBroken = down0(f.guardBroken); if (f.guardBroken === 0) f.guardHp = Math.max(f.guardHp, cfg.guardBreakRestore); }
  if (f.burstT > 0) { f.burstT += dt; if (f.burstT >= cfg.burstTime + cfg.burstRecover) f.burstT = 0; }

  // ── Level: follows the input, except through a punch that owns it (a body shot stays down, a rising one drives up).
  let want = cfg.levelOn && input.level && !f.down && !f.clinch.active ? 1 : 0;
  const p = f.punch;
  if (p.type !== null && !p.resolved && cfg.levelOn) {
    const hold = VARIANTS[p.variant].hold;
    if (hold === 1) want = 1; else if (hold === -1) want = 0;
  }
  // A roll stays down for its whole U whatever the input does, then comes up (into the rise window: roll, rising hook).
  if (cfg.levelOn && f.slip.kind === 'roll' && f.slip.active && !f.down) want = 1;
  if (want === 0 && f.level >= cfg.levelAt) f.riseT = cfg.levelRiseWindow; else f.riseT = down0(f.riseT);
  f.level = approach(f.level, want, cfg.levelTime > 0 ? dt / cfg.levelTime : 1);

  // ── Range and the inside posture.
  const dist = v2dist(f.pos, opp.pos);
  f.range = rangeBand(dist, cfg);
  const inside = cfg.postureOn && f.range === 'inside' && !f.down && !opp.down ? 1 : 0;
  f.posture = approach(f.posture, inside, cfg.postureTime > 0 ? dt / cfg.postureTime : 1);

  // ── Fatigue numbers.
  const from = cfg.fatigueFrom * rated(f, 'stamina', -cfg.ratingStaminaFatigue, cfg);   // a high-stamina fighter starts to tire later
  f.fatigue = cfg.fatigueOn && from > 0 ? clamp((from - f.stamina) / from, 0, 1) : 0;
  f.punchSlow = 1 + f.fatigue * (cfg.tiredPunchSlow - 1);
  const wear = bodyWear(f, cfg);
  f.staminaCap = Math.max(cfg.staminaCapFloor, 1 - wear * cfg.bodyStaminaCapLoss - (cfg.whiffCostOn ? f.wear : 0));
  const winded = f.hurt > 0 && f.hurtKind === 'body' && f.hurtMax > 0 ? clamp(f.hurt / f.hurtMax, 0, 1) : 0;
  f.guardDroop = f.fatigue * cfg.tiredGuardDroop + wear * cfg.bodyGuardDroop + (winded > 0 ? cfg.bodyHurtGuardDrop * Math.min(1, winded * 2) * hurtMods(f, cfg).guard : 0);
  f.buckle = approach(f.buckle, winded > 0 && !f.down ? 1 : 0, cfg.levelTime > 0 ? dt / cfg.levelTime : 1);

  // ── The guard meter recovers once it has been left alone.
  f.guardRest += dt;
  // (Phase B, guardMeterOn: the meter comes back sooner and faster — it was too thin for a man who keeps his guard up against a busy opponent.)
  const gm = cfg.guardMeterOn;
  if (f.guardBroken === 0 && f.guardRest >= cfg.guardRegenDelay * (gm ? cfg.guardRegenDelayScale : 1) && f.guardHp < 1) f.guardHp = Math.min(1, f.guardHp + cfg.guardRegen * (gm ? cfg.guardRegenScale : 1) * dt);

  // ── Flat-footed.
  const speed = Math.hypot(f.vel.x + f.hop.x, f.vel.z + f.hop.z);
  const moving = speed >= cfg.flatSpeed || f.pivot.dir !== 0;
  f.stillT = f.down ? 0 : moving ? Math.max(0, f.stillT - dt * cfg.flatClear) : f.stillT + dt;
  f.flat = cfg.flatFootedOn
    ? Math.max(cfg.flatRamp > 0 ? clamp((f.stillT - cfg.flatAfter) / cfg.flatRamp, 0, 1) : (f.stillT > cfg.flatAfter ? 1 : 0), f.fatigue * cfg.flatFatigue)
    : 0;

  // ── Ropes: how close the bound is on each axis, counted only when it is BEHIND the fighter.
  if (cfg.ropesOn && cfg.ropeZone > 0) {
    const b = RING_HALF - cfg.ringInset, fr = frameOf(f.yaw);
    const px = clamp(1 - (b - Math.abs(f.pos.x)) / cfg.ropeZone, 0, 1), pz = clamp(1 - (b - Math.abs(f.pos.z)) / cfg.ropeZone, 0, 1);
    const bx = Math.max(0, -fr.fwd.x * (f.pos.x >= 0 ? 1 : -1)), bz = Math.max(0, -fr.fwd.z * (f.pos.z >= 0 ? 1 : -1));
    // Behind-ness saturates early: 30° off square to the rope is still "on the ropes".
    f.ropes = Math.max(px * Math.min(1, bx * 2), pz * Math.min(1, bz * 2));
    f.cornered = px > CORNER_AT && pz > CORNER_AT && f.ropes > 0;
  } else { f.ropes = 0; f.cornered = false; }

  // ── The angle: how far off this fighter's facing line the opponent stands.
  f.angle = dist > 1e-6 ? Math.abs(angleDelta(f.yaw, v2angle({ x: opp.pos.x - f.pos.x, z: opp.pos.z - f.pos.z }))) : 0;
}
/** Both walls this close (as a fraction of the rope zone) = a corner. Shape, not a tunable (ropeZone is). */
const CORNER_AT = 0.4;

/** The fighter-frame unit direction of a flick: −1 lead side, +1 rear side, 2 back, 3 forward → (x right, y toward). */
export function flickDir(f: FighterState, dir: -1 | 1 | 2 | 3): { x: number; y: number } {
  if (dir === 2) return { x: 0, y: -1 };
  if (dir === 3) return { x: 0, y: 1 };
  return { x: dir * handLateralSign('rear', f.stance), y: 0 };
}

export function canBurst(f: FighterState, cfg: Config): boolean {
  if (!cfg.burstOn || f.down || f.burstCd > 0 || f.clinch.active || f.pivot.dir !== 0) return false;
  if (cfg.blockStunOn && f.blockStun > 0) return false;
  // Only a punch that leaves the feet free can be hopped with (the jab family).
  return f.punch.type === null || f.punch.moveScale >= BURST_MIN_MOVE;
}
/** A punch that roots the feet below this fraction cannot be hopped with. Shape. */
const BURST_MIN_MOVE = 0.7;

/** Add a hop that covers `dist` metres along (wx, wz) as it decays. */
export function addHop(f: FighterState, wx: number, wz: number, dist: number, cfg: Config): void {
  const v = dist * cfg.burstDecay;
  f.hop.x += wx * v; f.hop.z += wz * v;
}

/** THE BURST: a hop along a flick direction. Returns whether it started. */
export function startBurst(f: FighterState, side: Side, dir: -1 | 1 | 2 | 3, cfg: Config, events: SimEvent[]): boolean {
  if (!canBurst(f, cfg)) return false;
  const d = flickDir(f, dir), fr = frameOf(f.yaw);
  let dist = cfg.burstDist * (dir === 3 ? 1 : dir === 2 ? cfg.burstBackScale : cfg.burstLateralScale) * rated(f, 'speed', cfg.ratingSpeedFeet, cfg);
  if (f.hurt > 0) dist *= f.hurtKind === 'body' ? cfg.bodyHurtMoveScale : cfg.stunMoveScale;   // hurt legs hop short
  addHop(f, fr.fwd.x * d.y + fr.right.x * d.x, fr.fwd.z * d.y + fr.right.z * d.x, dist, cfg);
  f.burstT = 1e-6; f.burstCd = cfg.burstCooldown; f.stillT = 0;
  f.stamina = Math.max(0, f.stamina - cfg.burstStaminaCost);
  events.push({ type: 'burst', side, x: d.x, y: d.y });
  return true;
}

/** THE PIVOT: swing round the planted lead foot toward `dir` (−1 lead side, +1 rear). Returns whether it started. */
export function startPivot(f: FighterState, side: Side, dir: -1 | 1, cfg: Config, events: SimEvent[]): boolean {
  if (!cfg.pivotOn || f.down || f.burstCd > 0 || f.clinch.active || f.pivot.dir !== 0 || f.punch.type !== null) return false;
  const fr = frameOf(f.yaw);
  const lead = handLateralSign('lead', f.stance);
  const cx = f.pos.x + fr.fwd.x * (cfg.rigStanceFwd + cfg.pivotReach) + fr.right.x * lead * cfg.rigStanceLat;
  const cz = f.pos.z + fr.fwd.z * (cfg.rigStanceFwd + cfg.pivotReach) + fr.right.z * lead * cfg.rigStanceLat;
  // Which way round carries the hips toward the flicked side: the tangent of a +angle turn at the hips is (−dz, dx).
  const lat = dir * handLateralSign('rear', f.stance);
  const dx = f.pos.x - cx, dz = f.pos.z - cz;
  const sgn = (-dz * fr.right.x + dx * fr.right.z) * lat >= 0 ? 1 : -1;
  const onRopes = f.ropes > ESCAPE_AT;
  f.pivot = { t: 1e-6, dir, left: sgn * cfg.pivotAngleDeg * DEG * (onRopes ? cfg.ropePivotScale : 1), cx, cz };
  f.burstCd = cfg.burstCooldown; f.stillT = 0;
  f.vel.x = 0; f.vel.z = 0;
  f.stamina = Math.max(0, f.stamina - cfg.pivotStaminaCost);
  events.push({ type: 'pivot', side, dir });
  if (onRopes) events.push({ type: 'escape', side, how: 'pivot' });
  return true;
}
/** On the ropes by more than this = a slip, roll or pivot from here is an ESCAPE. Shape. */
export const ESCAPE_AT = 0.5;

/** Advance a pivot in progress: the hips turn about the planted foot, the remaining angle spread over the remaining time. */
export function stepPivot(f: FighterState, cfg: Config, dt: number): void {
  const pv = f.pivot;
  if (pv.dir === 0) return;
  const remain = Math.max(dt, cfg.pivotTime - pv.t);
  const a = pv.left * Math.min(1, dt / remain);
  const dx = f.pos.x - pv.cx, dz = f.pos.z - pv.cz, c = cos(a), s = sin(a);
  f.pos.x = pv.cx + dx * c - dz * s;
  f.pos.z = pv.cz + dx * s + dz * c;
  pv.left -= a; pv.t += dt;
  if (pv.t >= cfg.pivotTime - 1e-9 || f.down) f.pivot = { t: 0, dir: 0, left: 0, cx: 0, cz: 0 };
}

/** The hop channel: integrate and decay. Returns the displacement this tick. */
export function stepHop(f: FighterState, cfg: Config, dt: number): Vec2 {
  const d = { x: f.hop.x * dt, z: f.hop.z * dt };
  const k = Math.max(0, 1 - cfg.burstDecay * dt);
  f.hop.x *= k; f.hop.z *= k;
  if (Math.abs(f.hop.x) < cfg.moveStopSpeed) f.hop.x = 0;
  if (Math.abs(f.hop.z) < cfg.moveStopSpeed) f.hop.z = 0;
  return d;
}

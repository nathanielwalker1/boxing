/**
 * sim/flow.ts — the polish phase's flow rules (2026-11-11, item 2; numbers and
 * the measurements behind them in docs/POLISH_SIM.md):
 *
 *   THE HOLD     knockback held back while a combination runs on a man, let
 *                go when it ends (comboHold…).
 *   THE FOLLOW   the puncher's feet go after the man a landed punch moved
 *                (comboStep…).
 *   THE FINISHER the last power punch of a clean combination is its biggest
 *                moment (comboFinisher…).
 *   THE BUDGET   hit-stop is paid from a bucket, so a busy exchange cannot
 *                freeze a third of a second out of every second (hitStopBudget…).
 *   THE NERF     being hit opens a window in which your punches come out
 *                slower, shorter and weaker — instead of not at all (hitNerf…).
 *   THE ZONE     where a land found him, from the contact geometry, and a
 *                seeded variation number, for the rig.
 *
 * Everything here is pure, seeded and behind a config toggle.
 */
import type { BodyPart, Config, FighterState, HitGrade, HitZone, PunchType, SimState, Vec3 } from '../core';
import { SIM_DT, clamp, frameOf } from '../core';
import { heldKnock, punchBuffer, setHeldKnock } from './state';

// ── The hit-stop budget ───────────────────────────────────────────────────────

/**
 * Ask for `seconds` of hit-stop. The stop only ever extends to `seconds` (as
 * before: the longest request wins); what it extends BY is paid from the
 * bucket. `tier`: 0 an ordinary land or block, 1 a big moment, 2 the read.
 */
export function addHitStop(s: SimState, seconds: number, cfg: Config, tier: 0 | 1 | 2 = 0): void {
  const extra = seconds - s.hitStop;
  if (extra <= 0) return;
  if (!cfg.hitStopBudgetOn) { s.hitStop = seconds; return; }
  const used = s.stopUsed ?? 0;
  // Tier 2 (the read: a slipped punch, the counter off it — earned, rare, tuned by hand) is always given in full.
  if (tier === 2) { s.hitStop = seconds; s.stopUsed = used + extra; return; }
  // Tier 1 (a big moment: the finisher, a rock, a knockdown) may overdraw the bucket by hitStopBigExtra; an ordinary stop may not overdraw it at all.
  const left = Math.max(0, cfg.hitStopBudget + (tier === 1 ? cfg.hitStopBigExtra : 0) - used);
  // At least hitStopMin of freeze in total (if that much was asked for), whatever is left.
  const grant = Math.min(extra, Math.max(left, Math.min(seconds, cfg.hitStopMin) - s.hitStop));
  if (grant <= 0) return;
  s.hitStop += grant;
  s.stopUsed = used + grant;
}

/**
 * hitStopV2: ask for a stop of `ticks` sim ticks (the longest request wins, no budget). Capped at hitStopTicksCap unless
 * `exempt` (a knockdown / the fight-ending shot). The stop is then `ticks` stopped ticks after this one (step() in index.ts).
 */
export function addHitStopTicks(s: SimState, ticks: number, cfg: Config, exempt = false): void {
  const t = exempt ? ticks : Math.min(ticks, cfg.hitStopTicksCap);
  if (t > 0) s.hitStop = Math.max(s.hitStop, t * SIM_DT);
}

/** The bucket refills in REAL time (once a tick), whether or not the sim is frozen. */
export function stepHitStopBudget(s: SimState, cfg: Config): void {
  const used = s.stopUsed ?? 0;
  if (used <= 0) { s.stopUsed = 0; return; }
  s.stopUsed = Math.max(0, used - SIM_DT * cfg.hitStopBudget / Math.max(1e-6, cfg.hitStopBudgetWindow));
}

// ── The hold ──────────────────────────────────────────────────────────────────

/**
 * A land's knockback (a velocity on the stagger channel) arrives on `d` while
 * `a` has `combo` clean lands running. Returns nothing; applies the share that
 * goes at once and banks the rest. `finisher` lets everything go.
 */
export function applyKnock(a: FighterState, d: FighterState, kx: number, kz: number, combo: number, finisher: boolean, held: boolean, cfg: Config): void {
  if (!cfg.comboHoldOn || !held) { d.stagger.x += kx; d.stagger.z += kz; return; }
  const bank = heldKnock(d);
  if (finisher) {
    d.stagger.x += kx + bank.x * cfg.comboHoldRelease; d.stagger.z += kz + bank.z * cfg.comboHoldRelease;
    setHeldKnock(d, 0, 0);
    return;
  }
  const keep = combo <= 1 ? cfg.comboHoldFirst : cfg.comboHoldKeep;
  d.stagger.x += kx * keep; d.stagger.z += kz * keep;
  setHeldKnock(d, bank.x + kx * (1 - keep), bank.z + kz * (1 - keep));
}

/**
 * Per tick: what is held on `d` is let go once `a`'s combination is over — he
 * missed, the clock lapsed, he went down, or his hand is home with nothing
 * queued. A lone punch's held part goes in full; a combination's at
 * comboHoldRelease.
 */
export function stepHold(a: FighterState, d: FighterState, cfg: Config): void {
  const bank = heldKnock(d);
  if (bank.x === 0 && bank.z === 0) return;
  const running = cfg.comboHoldOn && !a.down && !d.down && a.combo > 0 && a.comboT > 0 && (a.punch.type !== null || punchBuffer(a).mask !== 0);
  if (running) return;
  const share = d.down ? 0 : a.combo <= 1 && a.comboT > 0 ? 1 : cfg.comboHoldRelease;
  d.stagger.x += bank.x * share; d.stagger.z += bank.z * share;
  setHeldKnock(d, 0, 0);
}

// ── The follow ────────────────────────────────────────────────────────────────

/**
 * How far (m) a punch that `a` is starting now should step after `d`: only
 * inside comboWindow of a clean land, far enough to put the hit test at
 * comboStepRange of this punch's `reach` given where `d` is still drifting
 * to, capped at comboStepMax. `tell` = sim seconds until the hit test.
 */
export function followStep(a: FighterState, d: FighterState | null, reach: number, tell: number, cfg: Config): number {
  if (!cfg.comboStepOn || !d || a.down || d.down || a.combo < 1 || a.comboT <= 0) return 0;
  const dx = d.pos.x - a.pos.x, dz = d.pos.z - a.pos.z, dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return 0;
  const ux = dx / dist, uz = dz / dist;
  // Where he will have drifted to by the hit test: the stagger still on him, decaying.
  const k = Math.max(1e-6, cfg.staggerDecay);
  const away = Math.max(0, d.stagger.x * ux + d.stagger.z * uz);
  // (With the ropes behind him he is not going anywhere: MEASURED, the step carried the puncher onto a man the ropes had bounced back and the cross was smothered.)
  const drift = away / k * (1 - Math.exp(-k * tell)) * (cfg.ropesOn ? 1 - clamp(d.ropes, 0, 1) : 1);
  return clamp(dist + drift - cfg.comboStepRange * reach, 0, cfg.comboStepMax);
}

// ── The nerf ──────────────────────────────────────────────────────────────────

/** A punch has landed (or, `blocked`, thudded heavily on the guard): open the hit window on `d`. */
export function openHitWindow(d: FighterState, grade: HitGrade, blocked: boolean, cfg: Config): void {
  if (!cfg.hitNerfOn) return;
  const sev = blocked ? cfg.hitSevBlocked : grade === 'glancing' ? cfg.hitSevGlancing : grade === 'flush' ? cfg.hitSevFlush : cfg.hitSevClean;
  if (sev <= 0) return;
  // A harder hit replaces a softer one still fading; a softer one never shortens a harder one.
  const now = hitNerf(d, cfg);
  if (sev >= now) { d.hitSev = sev; d.hitT = cfg.hitWindow; }
}

/** 0..1: how nerfed a punch `f` starts right now would be — the hit window fading out, and a floor while hurt. */
export function hitNerf(f: FighterState, cfg: Config): number {
  if (!cfg.hitNerfOn) return 0;
  const hit = f.hitT > 0 && cfg.hitWindow > 0 ? f.hitSev * clamp(f.hitT / cfg.hitWindow, 0, 1) : 0;
  return clamp(Math.max(hit, f.hurt > 0 ? cfg.hitNerfHurt : 0), 0, 1);
}

// ── Stamina by weight (polish phase, item 6) ──────────────────────────────────

/** What a punch of this type costs to throw, as a multiple of staminaPunchCost (1 with the polish rules off). */
export function throwWeight(type: PunchType, cfg: Config): number {
  if (!cfg.staminaPolishOn) return 1;
  return cfg.staminaThrowScale * typeWeight(type, cfg);
}
/** The punch's own weight against a cross's. */
export function typeWeight(type: PunchType, cfg: Config): number {
  if (!cfg.staminaPolishOn) return 1;
  return type === 'jab' ? cfg.staminaJabWeight : type === 'hook' ? cfg.staminaHookWeight : type === 'uppercut' ? cfg.staminaUppercutWeight : 1;
}

// ── The zone and the variation ────────────────────────────────────────────────

/**
 * Where a land found him. `n` is the unit vector from the struck centre (head
 * centre, or the nearest point on the body's axis) to the fist; the zones are
 * cut in the DEFENDER's frame: how far round to the side, how high.
 */
export function hitZone(d: FighterState, part: BodyPart, n: Vec3, centreY: number, liver: boolean, dir: { x: number; z: number } = { x: 0, z: 0 }, rising = false): HitZone {
  const fr = frameOf(d.yaw);
  // 0 = square on the front, 1 = on the ear / the flank: where the fist rests, or how sideways it was travelling
  // (a hook in this sim finishes across the front of the face — its travel says "jaw", its resting point does not).
  const side = Math.max(Math.abs(n.x * fr.right.x + n.z * fr.right.z), Math.abs(dir.x * fr.right.x + dir.z * fr.right.z));
  if (part === 'head') {
    if (rising) return 'chin';                      // from underneath
    if (side > 0.5) return n.y > 0.2 ? 'temple' : 'jaw';
    if (n.y < -0.45) return 'chin';
    return n.y > 0.3 ? 'forehead' : n.y < -0.2 ? 'chin' : 'nose';
  }
  if (liver) return 'liver';
  if (side > 0.6) return 'ribs';
  // Along the body's axis: the top third of hips → shoulders is the solar plexus, under it the belly.
  const h = d.bodyBox.b.y - d.bodyBox.a.y;
  return h > 1e-6 && (centreY - d.bodyBox.a.y) / h > 0.55 ? 'solar' : 'belly';
}

/**
 * A deterministic number in −1..1 from the fight seed, the tick and a salt —
 * the seeded variation of a land. Not drawn from `SimState.rng`, so adding a
 * consumer never moves the get-up rolls. Integer mixing only (no clocks, no
 * Math.random).
 */
export function seededUnit(seed: number, tick: number, salt: number): number {
  let h = (seed | 0) ^ Math.imul(tick + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

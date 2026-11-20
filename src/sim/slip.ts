/**
 * sim/slip.ts — the flick. Port of legacy fighter.js Stage 5 (the
 * flick-vs-hold detector, _triggerSlip, getHitPos) in SI, and (overhaul
 * 2026-11-11) the family of moves a flick now selects.
 *
 * The movement stick is read twice: locomotion treats every push as footwork,
 * and this detector watches the same push and asks one question at release —
 * was it short? A push let go inside slipFlickMax is a FLICK; one held longer
 * is confirmed footwork and never flicks, even when it is finally released.
 * The detector never gates or delays movement (a flick still shuffles the
 * feet a little, as in v1). CLAUDE.md locked mechanics: "flick = slip, hold =
 * footwork, distinguished by duration, detected in the sim".
 *
 * What a flick does depends on what else is held (the control scheme is
 * extended by COMBINATIONS, never replaced):
 *
 *   flick alone, lateral   SLIP   head sideways by slipHeadOffset, dips slipDip
 *   flick alone, back      PULL   head straight back by slipBackOffset
 *   flick alone, forward   nothing (it arms the double-tap)
 *   level + lateral flick  ROLL   the head goes down and across in a U, under a hook
 *   block + lateral flick  PIVOT  off the planted lead foot (footing.ts)
 *   block + forward flick  PUSH-OFF (clinch.ts; requested here, resolved with the opponent)
 *   flick, then push the same way again inside burstTapWindow → BURST (footing.ts)
 *
 * A slip is not an invincibility flag. It moves the head sphere (computeBoxes
 * adds the offset; the rig draws the head on that sphere, so hit geometry
 * stays drawn geometry) and the punch simply is not where the head is. The
 * offset rises over slipRise, holds for the slipDuration window, then comes
 * home over slipReturn.
 *
 * Chains: a new lateral flick the OTHER way (or a roll) while the head is
 * still off the line starts the next move from where the head is — slip,
 * slip, roll. Every slip LOADS the side the weight went to (`loaded`): the
 * natural counter from that side is faster and harder (combat.ts).
 */
import type { Config, FighterState, FrameInput, Side, SimEvent, SlipKind } from '../core';
import { handLateralSign, lerp, sin, smoothstep } from '../core';
import { duckT, evadeCd, idleSlip, prevPunchMask, punchMask, pushState, setDuckT, setEvadeCd, setPushState } from './state';
import { guardOf, startBurst, startPivot } from './footing';
import { rated } from './ratings';

/** What a flick asked for that needs the other fighter to resolve (index.ts hands it to clinch.ts). */
export interface FlickRequest { push: boolean }

/** The head's lateral offset in the fighter's own frame, metres, + = their right (0 for a pull). */
export function slipLateral(f: FighterState): number {
  return f.slip.dir === 2 ? 0 : f.slip.offset * handLateralSign('rear', f.stance);
}

/** The head's BACKWARD offset for a pull, metres (0 for a lateral slip). */
export function slipBack(f: FighterState): number {
  return f.slip.dir === 2 ? f.slip.offset : 0;
}

/** 0..1 progress of the current offset toward its full value (for the dip and the rig). */
export function slipShape(f: FighterState, cfg: Config): number {
  const full = f.slip.dir === 2 ? cfg.slipBackOffset : cfg.slipHeadOffset;
  return full > 0 ? Math.min(1, Math.abs(f.slip.offset) / full) : 0;
}

/** How far the head alone is down because of the current move, m: a slip's dip, or the roll's U. */
export function slipHeadDip(f: FighterState, cfg: Config): number {
  if (f.slip.dir === 0 || f.slip.dir === 2) return 0;
  return f.slip.kind === 'roll' ? f.slip.dip : cfg.slipDip * slipShape(f, cfg);
}

function triggerSlip(f: FighterState, side: Side, dir: -1 | 1 | 2, kind: SlipKind, cfg: Config, events: SimEvent[]): void {
  const s = f.slip;
  let from = 0, chain = 1;
  if (s.dir !== 0) {
    // Busy. One at a time (v1 _triggerSlip) — unless it CHAINS: a lateral
    // move off a lateral move, the other way or a roll, once the first has
    // gone slipChainAfter.
    const lateralNow = s.dir === 1 || s.dir === -1;
    if (!cfg.slipChainOn || !lateralNow || dir === 2 || s.chain >= cfg.slipChainMax || s.t < cfg.slipChainAfter) return;
    if (dir === s.dir && kind !== 'roll') return;
    from = s.offset; chain = s.chain + 1;
  }
  f.slip = { active: true, dir, t: 0, offset: from, kind, from, chain, dip: 0 };
  if (cfg.evadeV2) setEvadeCd(f, (kind === 'roll' ? cfg.rollDuration : cfg.evadeWindow) + cfg.evadeCooldown);
  // The weight goes where the head went: lead side → the lead hand is loaded,
  // rear side (and the pull, onto the back foot) → the rear hand.
  if (cfg.slipLoadedOn) { f.loaded = dir === 2 ? 1 : dir; f.loadedT = cfg.slipLoadedTime; }
  events.push({ type: 'slip', side, dir, dodged: false, kind, chain });
}

/** A flick was released: pick the move from what is held. */
function flick(f: FighterState, side: Side, dir: -1 | 1 | 2 | 3, input: Readonly<FrameInput>, cfg: Config, events: SimEvent[], req: FlickRequest): void {
  const lateral = dir === -1 || dir === 1;
  // (evadeFromBlock: with the guard held a side or back tap is still the slip / lean — the guard is down for its window,
  //  combat.ts — so a man waiting behind his gloves can make a punch miss and counter. Forward stays the push-off.)
  if (input.block && !(cfg.evadeV2 && cfg.evadeFromBlock && dir !== 3)) {
    // Mutually exclusive with the slip (the held level: this runs before
    // stepActions). With the guard up a flick is footwork of another kind.
    if (lateral) startPivot(f, side, dir, cfg, events);
    else if (dir === 3 && cfg.pushOffOn && f.pushCd === 0) req.push = true;
    return;
  }
  if (dir === 3) return;
  if ((cfg.blockStunOn && f.blockStun > 0) || f.clinch.active) return;
  const roll = lateral && cfg.rollOn && cfg.levelOn && input.level;
  triggerSlip(f, side, dir, roll ? 'roll' : dir === 2 ? 'pull' : 'slip', cfg, events);
}

/**
 * The detector, then the slip clock, for one fighter this tick. Runs before
 * stepActions (so the block sees this tick's window) and before the boxes are
 * computed (so the head is offset on the same tick the offset changes).
 */
export function stepSlip(f: FighterState, side: Side, input: Readonly<FrameInput>, cfg: Config, dt: number, events: SimEvent[], req: FlickRequest = { push: false }): void {
  const p = pushState(f);
  // evadeV2: the one clock every evade shares, and the TIMED DUCK: the level input going down is an evade for
  // evadeWindow (it beats hooks, sim/outcome.ts); held past that he is simply crouched. Refused while the clock runs.
  if (cfg.evadeV2) {
    if (evadeCd(f) > 0) setEvadeCd(f, Math.max(0, evadeCd(f) - dt));
    const dk = duckT(f);
    if (!input.level || f.down) { if (dk !== 0) setDuckT(f, 0); }
    else if (dk === 0) {
      if (evadeCd(f) > 0 || (input.block && !cfg.evadeFromBlock) || (cfg.blockStunOn && f.blockStun > 0)) setDuckT(f, -1);
      else { setDuckT(f, dt); setEvadeCd(f, cfg.evadeWindow + cfg.evadeCooldown); }
    } else if (dk > 0) setDuckT(f, dk + dt);
  }
  // The tap window runs from the flick's release to the START of the next push; once that push is down the tap waits for its confirm.
  if (f.tap.dir !== 0 && p.t === 0) { f.tap.t += dt; if (f.tap.t > cfg.burstTapWindow) f.tap = { dir: 0, t: 0 }; }
  if (f.down) {
    // Suspended entirely on the canvas: nothing is tracked and nothing fires.
    p.t = 0; p.dir = 0; p.hold = false;
    f.tap = { dir: 0, t: 0 };
  } else {
    const mx = input.move.x, my = input.move.y;
    const mag = Math.hypot(mx, my);
    if (mag >= cfg.slipInputThreshold) {
      // evadeHeldTap: A NEW DIRECTION WHILE ANOTHER IS HELD IS A NEW PUSH. A man backing up or circling (a key held)
      // who taps to the side, or one moving sideways who taps back, starts the evade on that tap: without it the push
      // "began" only from a still stick, and a player on the move could never slip (Nate 2026-11-20: three rounds,
      // "could not slip a single punch"). Going forward is never an evade, and the shared clock stops it being spammed.
      if (cfg.evadeV2 && cfg.evadeHeldTap && p.t > 0) {
        const now = Math.abs(mx) >= Math.abs(my) ? ((mx > 0 ? 1 : -1) * handLateralSign('rear', f.stance)) : my < 0 ? 2 : 3;
        if (now !== p.dir && now !== 3 && evadeCd(f) <= 0) p.t = 0;
      }
      if (p.t === 0) {
        // Push just began — the direction is captured now, not at release, so
        // a wobble mid-push cannot change which way the head goes. Sideways is
        // a slip, back is a pull, forward is footwork (or the push-off).
        p.dir = Math.abs(mx) >= Math.abs(my) ? ((mx > 0 ? 1 : -1) * handLateralSign('rear', f.stance)) as -1 | 1 : my < 0 ? 2 : 3;
        p.hold = false;
        if (f.tap.dir !== p.dir) f.tap = { dir: 0, t: 0 };   // a push another way ends the double-tap
        // evadeV2: THE EVADE STARTS ON THE PUSH, not on its release (measured 2026-11-19: waiting for the release left
        // 200 ms from the other man's press to beat a jab, under human reaction time). A push that turns out to be held
        // is footwork that began with the head going that way; the shared clock (evadeCooldown) stops it being spammed.
        if (cfg.evadeV2 && (!input.block || cfg.evadeFromBlock) && p.dir !== 3 && evadeCd(f) <= 0 && !(punchMask(input) & ~prevPunchMask(f))) flick(f, side, p.dir, input, cfg, events, req);
      }
      p.t += dt;
      if (p.t > cfg.slipFlickMax) p.hold = true;   // outlived the flick window: footwork
      // A push that is on the stick when a punch is pressed is the hand
      // selection for that punch (hook/uppercut read its sign) — it is spent,
      // and letting go of it afterwards is not a flick. Without this every
      // stick-nudged hook came with a slip, the AI's included, and the slip
      // carried the attacker's own guard off its line. (The step-in reads a
      // forward push the same way.)
      if (punchMask(input) & ~prevPunchMask(f)) { p.hold = true; f.tap = { dir: 0, t: 0 }; }
      // The double-tap: this push began inside burstTapWindow of a flick the
      // same way and has been down burstConfirm without a punch press — it is
      // a BURST, and it is spent (never a second flick). The confirm is what
      // lets "slip left, lead hook" (stick left again + the button a tick or
      // two apart) be a hook and not a hop.
      const tapped = f.tap.dir;
      if (tapped !== 0 && tapped === p.dir && !p.hold && p.t >= cfg.burstConfirm) {
        if (startBurst(f, side, tapped, cfg, events)) p.hold = true;
        f.tap = { dir: 0, t: 0 };
      }
    } else {
      if (p.t > 0 && !p.hold && p.dir !== 0) {   // let go early = flick
        // (evadeV2: the slip / lean already began on the push; the guard-up flicks, pivot and push-off, still fire here)
        if (!cfg.evadeV2 || (input.block && !(cfg.evadeFromBlock && p.dir !== 3))) flick(f, side, p.dir, input, cfg, events, req);
        f.tap = { dir: p.dir, t: 0 };
      }
      p.t = 0; p.dir = 0; p.hold = false;
    }
  }
  setPushState(f, p);

  // The slip clock: rise (or the roll's U), hold, return, home.
  const s = f.slip;
  if (s.dir === 0) { if (s.active || s.offset !== 0 || s.t !== 0 || s.chain !== 0) f.slip = idleSlip(); return; }
  s.t += dt;   // the flick tick ends at t = dt, so the head starts moving on the tick of the release
  const roll = s.kind === 'roll';
  const rise = roll ? cfg.rollDuration : s.chain > 1 ? cfg.slipChainRise : cfg.slipRise;
  // (The window: longer for a high defense rating and for a guard that lives on head movement.)
  // (evadeV2: one window for everyone, so it can be learned: evadeWindow from the push.)
  const window = roll ? cfg.rollDuration : cfg.evadeV2 ? cfg.evadeWindow : cfg.slipDuration * rated(f, 'defense', cfg.ratingDefenseSlip, cfg) * guardOf(f, cfg).slip;
  if (s.t >= window + cfg.slipReturn) { f.slip = idleSlip(); return; }
  s.active = s.t < window;
  const full = s.dir === 2 ? cfg.slipBackOffset : cfg.slipHeadOffset * s.dir;
  if (s.t < rise) {
    const u = rise > 0 ? s.t / rise : 1;
    s.offset = lerp(s.from, full, roll ? smoothstep(u) : u);
  } else if (s.t < window) s.offset = full;
  else s.offset = full * (cfg.slipReturn > 0 ? Math.max(0, 1 - (s.t - window) / cfg.slipReturn) : 0);
  s.dip = roll ? cfg.rollDip * sin(Math.PI * Math.min(1, rise > 0 ? s.t / rise : 1)) : slipHeadDip(f, cfg);
}

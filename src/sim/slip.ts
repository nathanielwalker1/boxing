/**
 * sim/slip.ts — the flick slip. Port of legacy fighter.js Stage 5 (the
 * flick-vs-hold detector, _triggerSlip, getHitPos) in SI.
 *
 * The movement stick is read twice: locomotion treats every push as footwork,
 * and this detector watches the same push and asks one question at release —
 * was it short? A lateral push let go inside slipFlickMax is a FLICK and
 * slips; one held longer is confirmed footwork and never slips, even when it
 * is finally released. The detector never gates or delays movement (a flick
 * still shuffles the feet a little, as in v1). CLAUDE.md locked mechanics:
 * "flick = slip, hold = footwork, distinguished by duration, detected in the
 * sim".
 *
 * A slip is not an invincibility flag. It moves the head sphere sideways
 * (computeBoxes adds the offset; the rig draws the head on that sphere, so hit
 * geometry stays drawn geometry) and the punch simply is not where the head
 * is. The offset rises over slipRise, holds for the slipDuration window, then
 * comes home over slipReturn; a new flick is ignored until it is home.
 *
 * Lateral only for now: `dir` is -1 toward the lead side, +1 toward the rear
 * side, so a right-hand flick slips an orthodox boxer to their rear (right)
 * and a southpaw to their lead. A forward/back flick is not a slip (v1's duck
 * on the vertical axis is not ported — the y axis is depth here).
 */
import type { Config, FighterState, FrameInput, Side, SimEvent } from '../core';
import { handLateralSign } from '../core';
import { prevPunchMask, punchMask, pushState, setPushState } from './state';

/** The head's lateral offset in the fighter's own frame, metres, + = their right. */
export function slipLateral(f: FighterState): number {
  return f.slip.offset * handLateralSign('rear', f.stance);
}

/** Is the head still away from home (window open or returning)? A new flick waits for this. */
function slipBusy(f: FighterState): boolean {
  return f.slip.dir !== 0;
}

function triggerSlip(f: FighterState, side: Side, dir: -1 | 1, blockHeld: boolean, events: SimEvent[]): void {
  // Mutually exclusive with the block (the held level: this runs before
  // stepActions), and one at a time (v1 _triggerSlip).
  if (blockHeld || slipBusy(f)) return;
  f.slip = { active: true, dir, t: 0, offset: 0 };
  events.push({ type: 'slip', side, dir, dodged: false });
}

/**
 * The detector, then the slip clock, for one fighter this tick. Runs before
 * stepActions (so the block sees this tick's window) and before the boxes are
 * computed (so the head is offset on the same tick the offset changes).
 */
export function stepSlip(f: FighterState, side: Side, input: Readonly<FrameInput>, cfg: Config, dt: number, events: SimEvent[]): void {
  const p = pushState(f);
  if (f.down) {
    // Suspended entirely on the canvas: nothing is tracked and nothing fires.
    p.t = 0; p.dir = 0; p.hold = false;
  } else {
    const mx = input.move.x, my = input.move.y;
    const mag = Math.hypot(mx, my);
    if (mag >= cfg.slipInputThreshold) {
      if (p.t === 0) {
        // Push just began — the direction is captured now, not at release, so
        // a wobble mid-push cannot change which way the head goes. A push that
        // is more forward/back than sideways is footwork or nothing.
        p.dir = Math.abs(mx) >= Math.abs(my) ? ((mx > 0 ? 1 : -1) * handLateralSign('rear', f.stance)) as -1 | 1 : 0;
        p.hold = false;
      }
      p.t += dt;
      if (p.t > cfg.slipFlickMax) p.hold = true;   // outlived the flick window: footwork
      // A push that is on the stick when a punch is pressed is the hand
      // selection for that punch (hook/uppercut read its sign) — it is spent,
      // and letting go of it afterwards is not a flick. Without this every
      // stick-nudged hook came with a slip, the AI's included, and the slip
      // carried the attacker's own guard off its line.
      if (punchMask(input) & ~prevPunchMask(f)) p.hold = true;
    } else {
      if (p.t > 0 && !p.hold && p.dir !== 0) triggerSlip(f, side, p.dir, input.block, events);   // let go early = flick
      p.t = 0; p.dir = 0; p.hold = false;
    }
  }
  setPushState(f, p);

  // The slip clock: rise, hold, return, home.
  const s = f.slip;
  if (s.dir === 0) { s.active = false; s.offset = 0; s.t = 0; return; }
  s.t += dt;   // the flick tick ends at t = dt, so the head starts moving on the tick of the release
  const home = cfg.slipDuration + cfg.slipReturn;
  if (s.t >= home) { s.active = false; s.dir = 0; s.offset = 0; s.t = 0; return; }
  s.active = s.t < cfg.slipDuration;
  const shape = s.t < cfg.slipRise ? (cfg.slipRise > 0 ? s.t / cfg.slipRise : 1)
    : s.t < cfg.slipDuration ? 1
    : cfg.slipReturn > 0 ? Math.max(0, 1 - (s.t - cfg.slipDuration) / cfg.slipReturn) : 0;
  s.offset = cfg.slipHeadOffset * shape * s.dir;
}

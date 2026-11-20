/**
 * sim/outcome.ts — OUTCOME FIRST (cfg.mocapOutcome, with mocapGeo; ?human=1). At a punch's hit tick the sim decides
 * it by RULE, exactly as the locked mechanics say, and the drawing is then made to show that outcome (src/human).
 * No sphere test decides anything here. Pure and deterministic: state in, outcome out.
 *
 *   d = centre-to-centre distance at the hit tick; [near, far] = the punch's band (config, × his height)
 *   d > far                                  WHIFF
 *   head punch, target slipped / pulled / rolled in its window, or ducked under the press aim
 *                                            DODGED (a wrong-way lateral slip, toward the punching hand, is caught on
 *                                            the shoulder instead: a body land — the existing wrongWay rule)
 *   body punch, target rolling / slipping    still LANDS (a roll or a slip beats head punches only)
 *   target holding block (not guard-broken)  BLOCKED (full block while held)
 *   otherwise                                LAND, on the head or body as THROWN (the variant)
 *   d < near (straights)                     still lands, the power ramps down (combat.ts, the smother ramp)
 *
 * predictOutcome is the same rule on any state: the drawn side calls it a few ticks early to steer the hand.
 */
import type { BodyPart, Config, FighterState, Hand, PunchType, PunchVariant } from '../core';
import { GUARDS, handLateralSign, v2dist } from '../core';
import { makeDrawnTargets, mocapBandFar, mocapDrawnTargets, mocapLib, type DrawnTargets } from '../core/mocap';
import { VARIANTS } from './variants';
import { slipLateral } from './slip';
import { duckT } from './state';

export type OutcomeKind = 'land' | 'block' | 'dodge' | 'whiff';
export interface Outcome {
  kind: OutcomeKind;
  /** What was thrown at (a wrong-way slip turns a head punch into a body land). */
  part: BodyPart;
  /** The dodge was a slip / pull / roll (the slip event and the counter window fire), not a duck. */
  slip: boolean;
  near: number; far: number; d: number;
}

/** The punch's band, centre to centre, m. Straights: near = smotherDist (the power ramp starts); hooks and uppercuts: the separation. */
export function punchBand(a: FighterState, type: PunchType, hand: Hand, variant: PunchVariant, cfg: Config, d: FighterState | null = null): { near: number; far: number } {
  const v = VARIANTS[variant];
  const lead = hand === 'lead';
  // the far end measured from the clip itself (core/mocap.ts mocapBandFar): the picture and the rule cannot disagree
  const lib = cfg.mocapBandsFromClips ? mocapLib() : null;
  const clipFar = lib ? mocapBandFar(lib, cfg, a.body.heightM, a.stance, type, hand, !!v.body, d?.body.heightM ?? a.body.heightM, d?.stance ?? a.stance, a.body.gloveR) : null;
  const far0 = type === 'jab' ? (v.body ? cfg.mocapFarBodyJab : cfg.mocapFarJab)
    : type === 'cross' ? (v.body ? cfg.mocapFarBodyCross : cfg.mocapFarCross)
    : type === 'hook' ? (v.body ? cfg.mocapFarBodyHook : lead ? cfg.mocapFarLeadHook : cfg.mocapFarRearHook)
    : lead ? cfg.mocapFarLeadUpper : cfg.mocapFarRearUpper;
  // (not × the variant's reach: that shaped the procedural arm; the drawn clip is the same for a shovel hook or an inside uppercut)
  // (the cross steps in: its take has almost no travel of its own, which left it 29 cm shorter than the jab)
  // (hooks and uppercuts reach at least a floor: measured 2026-11-19, fights happen at 0.9-1.3 m and the clips' own reach
  //  was 0.98 m lead hook, 0.94 m uppercuts — "so frustrating when my hook and uppercut is out of range". The drawn body steps in for the rest.)
  const floor = (type === 'hook' ? cfg.mocapFarMinHook : type === 'uppercut' ? cfg.mocapFarMinUpper : 0) * a.body.heightM / cfg.mocapBandRefHeight;
  const far = Math.max(floor, (clipFar ?? far0 * a.body.heightM / cfg.mocapBandRefHeight) + (type === 'cross' && !v.body ? cfg.mocapCrossStep * a.body.heightM / cfg.mocapBandRefHeight : 0));
  const near = type === 'jab' || type === 'cross' ? cfg.smotherDist : cfg.separationDist;
  return { near: Math.min(near, far), far };
}

/** How far the target's head is down from where the punch was aimed at the press, m (variants.ts aimAtPress measures the same). */
function duckedBy(a: FighterState, d: FighterState): number {
  return Math.max(0, d.body.headY - d.headBox.y) - a.punch.aim;
}

/** The rule, on this state, for a's punch in flight (null: no punch). */
export function predictOutcome(a: FighterState, d: FighterState, cfg: Config, out?: Outcome): Outcome | null {
  const p = a.punch;
  if (p.type === null) return null;
  const o = out ?? { kind: 'whiff', part: 'head', slip: false, near: 0, far: 0, d: 0 };
  const band = punchBand(a, p.type, p.hand, p.variant, cfg, d);
  const v = VARIANTS[p.variant];
  o.near = band.near; o.far = band.far; o.d = v2dist(a.pos, d.pos); o.slip = false;
  o.part = v.body ? 'body' : 'head';
  if (o.d > band.far) { o.kind = 'whiff'; return o; }
  if (o.part === 'head') {
    const s = d.slip;
    if (cfg.evadeV2) {
      // THE FORMULA (Nate 2026-11-19: "no formula... nothing predictable my brain can wrap around"), one answer per punch:
      //   jab / cross -> SLIP (a side tap, either way)     hook -> DUCK (the level input going down)
      //   uppercut    -> LEAN BACK (a back tap)            a roll (level + side tap) is a duck and a slip at once
      // Each is live from the tick of its press for evadeWindow. The wrong one is simply hit.
      const lateral = s.active && (s.dir === 1 || s.dir === -1);
      const dk = duckT(d);
      // (the LEAN BACK beats every head punch, Nate 2026-11-20: it is the safe evade and opens only the short counter window)
      const beaten = (s.active && s.dir === 2)
        || (p.type === 'hook' ? (dk > 0 && dk <= cfg.evadeWindow) || (lateral && s.kind === 'roll') : p.type !== 'uppercut' && lateral);
      if (beaten) { o.kind = 'dodge'; o.slip = true; return o; }
    } else if (s.active && s.dir !== 0) {
      const lateral = s.dir === 1 || s.dir === -1;
      // the wrong way: a lateral slip toward the punching hand walks the shoulder into it (combat.ts wrongWayShoulder)
      const intoHand = lateral && s.kind !== 'roll' && cfg.wrongWayOn && cfg.wrongWayShoulder > 0 && slipLateral(d) * -handLateralSign(p.hand, a.stance) > 0;
      if (intoHand) o.part = 'body';
      else { o.kind = 'dodge'; o.slip = true; return o; }
    // (only a TIMED duck dodges, Nate 2026-11-18: a man who simply stands lower, by build or by a held crouch, is hit where his head is; the punch is aimed there)
    } else if ((s.active || cfg.mocapDuckDodgeHeld) && duckedBy(a, d) > cfg.mocapDuckDodge + GUARDS[cfg.stylesOn ? d.guardShape : 'high'].crouch) { o.kind = 'dodge'; return o; }
  }
  o.kind = d.block && d.guardBroken <= 0 ? 'block' : 'land';
  return o;
}

const TG = makeDrawnTargets();
/**
 * The contact point (world): where the punching glove's CENTRE rests on the DRAWN target, on the side facing the
 * attacker — head (sphere) or torso (at the body lane), one glove radius less the contact squash off the surface; a
 * blocked punch on the defender's nearer guard glove. Writes `out`.
 */
export function contactPoint(a: FighterState, d: FighterState, kind: OutcomeKind, part: BodyPart, cfg: Config, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const t: DrawnTargets = mocapDrawnTargets(mocapLib(), cfg, d, GUARDS[cfg.stylesOn ? d.guardShape : 'high'].crouch, TG);
  const gr = a.body.gloveR, rest = gr * (1 - cfg.contactSquash);
  let cx: number, cy: number, cz: number, r: number;
  if (part === 'head') { cx = t.head.x; cy = t.head.y; cz = t.head.z; r = t.headR; }
  else {
    // the body lane: half way up the torso line
    cx = (t.torsoA.x + t.torsoB.x) / 2; cy = (t.torsoA.y + t.torsoB.y) / 2; cz = (t.torsoA.z + t.torsoB.z) / 2; r = t.torsoR;
  }
  // toward the attacker's shoulders, on the floor plane (a straight meets the face from the front, a hook from its side)
  let nx = a.pos.x - cx, nz = a.pos.z - cz;
  const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
  if (kind === 'block') {
    // the guard glove on the punch's side: the nearer of his two to the head point, the fist resting against it
    const g0 = d.gloves[0].pos, g1 = d.gloves[1].pos;
    const n0 = Math.hypot(g0.x - (cx + nx * r), g0.y - cy, g0.z - (cz + nz * r)), n1 = Math.hypot(g1.x - (cx + nx * r), g1.y - cy, g1.z - (cz + nz * r));
    const g = n0 <= n1 ? g0 : g1, R = d.body.gloveR + rest;
    out.x = g.x + nx * R; out.y = g.y; out.z = g.z + nz * R;
    return out;
  }
  out.x = cx + nx * (r + rest); out.y = cy; out.z = cz + nz * (r + rest);
  return out;
}

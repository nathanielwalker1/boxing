/**
 * Sim state -> mocap clip blend for ONE drawn human fighter (?human=1). No three.js: the output is a
 * skeleton-independent Pose (clip.ts) plus a few procedural asks (lean, hand IK) the view applies.
 *
 * Layers, bottom to top: the fight idle (always), the four step clips (by speed in his own frame), then
 * actions in the order they started (punch, block, hit reaction, slip, stunned, knockdown / get-up),
 * each with its own eased weight. Upper-body actions (block) blend through a spine-up mask.
 *
 * Roles are looked up BY NAME in roles.json at runtime (roles are still being added); a missing role
 * falls back to a clip found by its inventory label, then to a mirrored twin, then to a procedural ask.
 *
 * Punch timing: the clip's from / contact / end frames are mapped piecewise onto the sim's punch progress
 * (0 -> peakAt -> 1), so the clip's contact frame is drawn on the very tick the sim runs its hit test and
 * the clip's punch ends when the sim's does. A lead-in longer than humanMaxLeadIn x the tell starts later
 * in the clip (the crossfade covers the cut).
 */
import type { Config } from '../core/config';
import { SIM_DT } from '../core';
import type { BodyPart, FighterState, HitGrade, PunchType, SimEvent, Side, Vec3 } from '../core/types';
import { punchPhases } from '../sim/punches';
import { mocapCfg, mocapPunchNow } from '../sim/mocap';
import { cockMult, getUpAt } from '../sim/state';
import { VARIANTS } from '../sim/variants';
import { contactPoint, predictOutcome, type Outcome, type OutcomeKind } from '../sim/outcome';
import { mocapClipGlove, mocapRoleNames, mocapTwinRole, type ChainedFrom, type MocapPick } from '../core/mocap';
const CG1 = { x: 0, y: 0, z: 0 }, CG2 = { x: 0, y: 0, z: 0 }, TP = { x: 0, y: 0, z: 0 };   // scratch
const OCS: Outcome = { kind: 'whiff', part: 'head', slip: false, near: 0, far: 0, d: 0 };
import { makePose, sample, type Clip, type ClipLib, type Pose, type Role, type Roles } from './clip';

interface Pick { name: string; role: Role; clip: Clip; mirror: boolean }

interface Track {
  key: string; pick: Pick; t: number; loop: boolean;
  w: number; target: number; fadeIn: number; fadeOut: number;
  upper: boolean; seq: number;
  /** Legs, hips and lower spine only (the crouch): the complement of the upper mask. */
  lower?: boolean;
  /** The upper body without the head (the crouch's forward lean). */
  lean?: boolean;
  /** Head, neck and upper spine only (a hit taken while his own punch is in flight: the arms keep punching, the head goes). */
  head?: boolean;
}

export interface AnimOut {
  pose: Pose;
  /** Hand IK ask: pull this arm's hand so the glove centre sits at `at` (world), by weight w. */
  ik: { arm: 'Left' | 'Right'; w: number; at: Vec3; exact?: boolean; key?: number; pressW?: number; outcome?: boolean } | null;
  /** The previous punch's arm easing off the sim glove while a chained punch with the other arm runs (null otherwise). */
  ik2: AnimOut['ik'];
  /** mocapGeo: the body offset of the punch's lunge (world floor m) and its turn (rad, + = toward his right), from the sim. */
  lunge: { x: number; z: number };
  turn: number;
  /** Aim lift: a body-flagged clip thrown at the head: raise the punching hand toward world height y (spine pitch + shoulder), by weight w. */
  aim: { arm: 'Left' | 'Right'; w: number; y: number } | null;
  /** Procedural spine lean, as the head displacement wanted, m, in his own frame (lat + = to his left, back + = backward, fwd + = forward bend). */
  lean: { lat: number; back: number; fwd: number; twist?: number };
  /** Drop the hips this far, m, feet pinned (level, crouch, posture, slip dip, the sink of a hit). */
  drop: number;
  /** What is playing (debug / checks). */
  label: string;
}

/** Inventory labels used when a role is absent (docs/anim/MOCAP_INVENTORY.md). Not slugs. */
const LABEL_FALLBACK: Record<string, string> = {
  walk_fwd: 'step forward', walk_back: 'step back', walk_left: 'step left', walk_right: 'step right',
  stunned: 'stagger (dizzy idle)', knockdown: 'knockdown fall',
};

// The clip choice for a punch is ONE function in core (core/mocap.ts mocapRoleNames / mocapPunchPick), shared with the sim's glove.

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const smooth = (x: number): number => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

function nlerp(a: Float32Array, ao: number, b: Float32Array, bo: number, w: number, out: Float32Array, oo: number): void {
  const dot = a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!;
  const s = dot < 0 ? -w : w, k = 1 - w;
  const x = a[ao]! * k + b[bo]! * s, y = a[ao + 1]! * k + b[bo + 1]! * s, z = a[ao + 2]! * k + b[bo + 2]! * s, q = a[ao + 3]! * k + b[bo + 3]! * s;
  const l = Math.hypot(x, y, z, q) || 1;
  out[oo] = x / l; out[oo + 1] = y / l; out[oo + 2] = z / l; out[oo + 3] = q / l;
}

/** HOW TIRED HE LOOKS, 0..1 (drawn only): the sim's fatigue right now (low stamina) or the wear on his stamina ceiling over the fight, whichever is more. */
export function tiredOf(f: FighterState, cfg: Config): number {
  const worn = (1 - f.staminaCap) / Math.max(1e-3, 1 - cfg.staminaCapFloor);
  return clamp(Math.max(f.fatigue, worn * cfg.humanTiredFromWear), 0, 1);
}

export class HumanAnim {
  private readonly nb: number;
  private readonly pose: Pose;
  private readonly tmp: Pose;
  private readonly upperMask: Float32Array;
  private readonly leanMask: Float32Array;
  private readonly headMask: Float32Array;
  private tracks: Track[] = [];
  private seq = 0;
  private readonly southpaw: boolean;
  private idleT: number;
  private readonly idle: Pick | null;
  // punch identity (a new punch = new track)
  private punchKey = '';
  private punchN = 0;
  private lastProgress = 0;
  // hit reaction: own clock from the impact frame
  private hit: { pick: Pick; t: number; end: number; n: number; fromState: boolean; t0: number; rate: number; fit: boolean; mir?: boolean; head?: boolean; big?: boolean } | null = null;
  private hitN = 0;
  private jolt = 0;   // procedural flinch of a blocked shot, 1 -> 0
  private wasDown = false;
  private punchF0 = 0;   // the clip frame the current punch started on
  private punchSec0 = 0; // real seconds from its press to its hit
  private breath = 0;
  private lastHitPart: BodyPart = 'head';
  private clock = 0;
  private punchStart = 0;
  private ikTail: { arm: 'Left' | 'Right'; gi: number; w: number } | null = null;
  private tailOld: { arm: 'Left' | 'Right'; gi: number; w: number } | null = null;
  /** The clip on top this frame (read-only, for tests). */
  info: { slug: string; frame: number; punch: boolean } = { slug: '', frame: 0, punch: false };
  /** (audit) The clip's own punching-glove displacement this tick, m (-1 = no mocapGeo punch, or its first tick). */
  legitHand = -1;
  private legitPick: unknown = null;
  private readonly CG0 = { x: 0, y: 0, z: 0 };
  private pressW = 0;
  private lastPunch: ChainedFrom | null = null;
  private lastPunchEnd = -1e9;
  private chainedFrom: ChainedFrom | null = null;

  constructor(private readonly lib: ClipLib, private readonly roles: Roles, private readonly side: Side, stance: string, private readonly cfg: Config) {
    this.nb = lib.bones.length;
    this.pose = makePose(this.nb);
    this.tmp = makePose(this.nb);
    this.southpaw = stance === 'southpaw';
    this.upperMask = new Float32Array(this.nb);
    this.leanMask = new Float32Array(this.nb);
    this.headMask = new Float32Array(this.nb);
    lib.bones.forEach((n, i) => {
      const s = n.replace(/^mixamorig\d*[:_]?/, '');
      this.upperMask[i] = s === 'Spine' ? 0.35 : s === 'Spine1' ? 0.7 : /^(Spine2|Neck|Head|Left(Shoulder|Arm|ForeArm|Hand)|Right(Shoulder|Arm|ForeArm|Hand))/.test(s) ? 1 : 0;
      // the crouch's lean: the upper body without the head (eyes stay on the man, not on the floor)
      // (and without the arms: the duck take's arms are a long guard with the rear elbow up — the idle guard rides the lean)
      this.headMask[i] = s === 'Head' || s === 'Neck' ? 1 : s === 'Spine2' ? 0.6 : s === 'Spine1' ? 0.3 : 0;
      this.leanMask[i] = /^(Head|Left(Shoulder|Arm|ForeArm|Hand)|Right(Shoulder|Arm|ForeArm|Hand))/.test(s) ? 0 : s === 'Neck' ? 0.3 : this.upperMask[i]!;
    });
    // A second idle for the other corner if one exists; otherwise the same idle half a loop apart.
    // (idle_2 measures the same as idle — likely the same take — so the other corner prefers idle_3, the long guard)
    // (mocapGeo: both corners play `idle` — the sim's head and guard are measured from it, core/mocap.ts mocapRest; the
    //  other corner's idle_3 stood its head 19 cm under the sim's head sphere)
    this.idle = (side === 1 && !cfg.mocapGeo ? this.find('idle_3') ?? this.find('idle_2') : null) ?? this.find('idle');
    this.idleT = this.idle ? (side === 1 ? this.idle.clip.duration * 0.47 : 0) : 0;
  }

  /** Role by name (or its label fallback); null when neither exists. */
  find(name: string): Pick | null {
    const r = this.roles[name];
    if (r && this.lib.clips.has(r.slug)) return { name, role: r, clip: this.lib.clips.get(r.slug)!, mirror: false };
    const label = LABEL_FALLBACK[name];
    if (label) {
      const info = this.lib.index.clips.find(c => c.label === label);
      if (info) { const clip = this.lib.clips.get(info.slug)!; return { name: name + '~' + info.slug, role: { slug: info.slug, from: 0, to: clip.frames - 1 }, clip, mirror: false }; }
    }
    return null;
  }

  /** The first role of `names` that exists, else the first one's left/right twin mirrored. */
  private pick(...names: string[]): Pick | null {
    for (const n of names) { const p = this.find(n); if (p) return p; }
    for (const n of names) {
      const twin = n.replace(/left|right|lead|rear/, m => ({ left: 'right', right: 'left', lead: 'rear', rear: 'lead' } as Record<string, string>)[m]!);
      if (twin === n) continue;
      const p = this.find(twin);
      if (p) return { ...p, mirror: !p.mirror, name: twin + '(mirrored)' };
    }
    return null;
  }

  missing(): string[] {
    const want = ['idle', 'jab', 'cross', 'lead_hook', 'rear_hook', 'lead_uppercut', 'rear_uppercut', 'body_jab', 'body_hook', 'block', 'body_block', 'block_hit',
      'hit_head_light', 'hit_head_medium', 'hit_head_heavy', 'hit_body', 'hit_uppercut', 'knockdown', 'getup', 'stunned',
      'walk_fwd', 'walk_back', 'walk_left', 'walk_right', 'slip_left', 'slip_right', 'duck', 'lean_back'];
    return want.filter(n => !this.roles[n]).map(n => (this.find(n) ? n + ' (label fallback)' : n));
  }

  private want(key: string, pick: Pick, t: number, o: { loop?: boolean; fadeIn?: number; fadeOut?: number; upper?: boolean; lower?: boolean; lean?: boolean; head?: boolean; w?: number; target?: number; fixW?: number; halfMax?: number } = {}): void {
    let tr = this.tracks.find(x => x.key === key);
    // CONTINUITY (humanInertia): an action cuts in at full weight; the view carries the on-screen pose and speed over
    const half0 = this.cutHalfFor(key);
    const half = half0 > 0 && o.halfMax !== undefined ? Math.max(0.012, Math.min(half0, o.halfMax)) : half0;
    if (!tr) {
      tr = { key, pick, t, loop: !!o.loop, w: half > 0 ? (o.target ?? 1) : o.w ?? 0, target: 1, fadeIn: o.fadeIn ?? this.cfg.humanFadeIn, fadeOut: o.fadeOut ?? this.cfg.humanFadeOut, upper: !!o.upper || !!o.lean || !!o.head, lower: !!o.lower, lean: !!o.lean, head: !!o.head, seq: this.seq++ };
      this.tracks.push(tr);
      if (half > 0) this.cutHalf = this.cutHalf > 0 ? Math.min(this.cutHalf, half) : half;
    } else if (half > 0 && !tr.loop && (t < tr.t - 0.05 || t > tr.t + 0.2)) {
      // the same track jumping in its own clip (the fall reversed into the rise, a re-timed recovery): also a cut
      this.cutHalf = this.cutHalf > 0 ? Math.min(this.cutHalf, half) : half;
    }
    tr.t = t; tr.target = o.target ?? 1;
    if (o.fixW !== undefined) { tr.target = Math.min(tr.target, o.fixW); tr.w = Math.min(tr.w, tr.target); }
    if (o.fadeOut !== undefined) tr.fadeOut = o.fadeOut;
    this.wanted.add(key);
  }
  private wanted = new Set<string>();

  // ---- CONTINUITY (humanInertia): the pose drawn = the blend + a carried-over difference that decays ----
  /** > 0: an action cut in this frame; the half-life (s) its carried difference decays with. */
  private cutHalf = 0;
  /** The half-life an action's start is carried over with (0 = this track crossfades by weight as before). */
  private cutHalfFor(key: string): number {
    const c = this.cfg;
    return !c.humanInertia || c.humanRawPose ? 0
      : /^(hit#|blockhit#)/.test(key) ? c.humanInertiaHalfHit
      : key === 'down' ? c.humanInertiaHalfDown
      : /^(punch#|punchL#|getup|slip:)/.test(key) ? c.humanInertiaHalf : 0;
  }
  private leanS = [0, 0, 0, 0]; private leanV = [0, 0, 0, 0];
  // the drawn lunge (world floor m) and its speed: moved by a spring, never switched
  private lungeX = 0; private lungeZ = 0; private lungeVX = 0; private lungeVZ = 0;

  // CONTACT, closed loop: what the drawn arm could not close last frame (forward, m) is added to the body travel
  private lungeBias = 0; private biasFed = false;
  /** The view reports, after its hand IK, how far the punching glove still is from its contact point along his facing (m, + = short), and the IK weight. */
  feedReach(resF: number, w: number, urgent = false): void {
    // (urgent: the hit is on this tick or the next and the glove is still short — a guard dropped at the last moment, a
    //  head knocked back — the body goes with the punch at up to humanReachStepUrgent instead of a walk)
    const step = urgent ? Math.max(this.cfg.humanReachStep, this.cfg.humanReachStepUrgent) : this.cfg.humanReachStep;
    this.lungeBias = clamp(this.lungeBias + clamp(resF, -this.cfg.humanReachStep, step) * w, -this.cfg.humanShiftBack, this.cfg.humanShiftFwd);
    this.biasFed = true;
  }
  // CONTACT (humanContactDrawn): where the view rested (or will rest) the glove on the DRAWN man last frame; the body
  // travel is planned to THAT, not to where his head would be standing idle (a reeling head is 10-27 cm from it)
  private fedT = { x: 0, y: 0, z: 0, n: -1 };
  /** 0..1: how far he is down into a body punch (humanBodyDip). */
  private bodyDip = 0;
  feedTarget(x: number, y: number, z: number): void { this.fedT.x = x; this.fedT.y = y; this.fedT.z = z; this.fedT.n = this.punchN; }
  /** The view reads this once a frame: > 0 = an action switched this frame (the half-life to carry the on-screen pose over with). */
  takeCut(): number { const c = this.cutHalf; this.cutHalf = 0; return c; }
  /** The punch's wanted body offset -> the drawn one, on a critically damped spring (it is never switched on or off). */
  private lungeStep(gx: number, gz: number, dt: number, halfOver = 0): { x: number; z: number } {
    if (dt > 1e-5) {
      const back = Math.hypot(gx, gz) < Math.hypot(this.lungeX, this.lungeZ);
      const y = 2 * Math.LN2 / Math.max(1e-3, halfOver > 0 ? halfOver : back ? this.cfg.humanLungeHalfBack : this.cfg.humanLungeHalf), e = Math.exp(-y * dt);
      const ax = this.lungeX - gx, bx = this.lungeVX + ax * y; this.lungeX = e * (ax + bx * dt) + gx; this.lungeVX = e * (this.lungeVX - bx * y * dt);
      const az = this.lungeZ - gz, bz = this.lungeVZ + az * y; this.lungeZ = e * (az + bz * dt) + gz; this.lungeVZ = e * (this.lungeVZ - bz * y * dt);
    }
    return { x: this.lungeX, z: this.lungeZ };
  }

  private startHit(part: BodyPart, punch: PunchType | null, grade: HitGrade | null, sev: number, age: number, fromState: boolean, rocked = false, lat = 0): void {
    const g = grade ?? (sev < 0.4 ? 'glancing' : sev < 0.75 ? 'clean' : 'flush');
    const level = g === 'glancing' ? 'light' : g === 'clean' ? 'medium' : 'heavy';
    const head0 = level === 'heavy' ? ['hit_head_heavy', 'hit_head_medium', 'hit_head_light'] : level === 'medium' ? ['hit_head_medium', 'hit_head_light', 'hit_head_heavy'] : ['hit_head_light', 'hit_head_medium'];
    // outcome mode: light and medium play the calm takes (guard stays up; the impact layer carries the snap); heavy
    // the medium take (big but on his feet); the knockout-looking takes (hit_head_heavy, the uppercut stagger) only
    // when this land rocked him or put him down
    const calm = this.cfg.mocapOutcome && this.cfg.humanCalmHits;
    const head = !calm ? head0 : rocked ? ['hit_head_heavy', 'hit_head_medium'] : level === 'heavy' ? ['hit_head_heavy_calm', 'hit_head_medium'] : [`hit_head_${level}_calm`, ...head0];
    const names = part === 'body'
      // (a body shot FOLDS him: hit_body = the stomach take; a flush or rocking one the deep fold. The kidney take turned his back on the puncher)
      ? (punch === 'uppercut' ? ['hit_body_uppercut', 'hit_body'] : level === 'heavy' || rocked ? ['hit_body_heavy', 'hit_body'] : ['hit_body'])
      : punch === 'uppercut' && !(calm && !rocked) ? [`hit_uppercut_${level}`, 'hit_uppercut', ...head] : head;
    const pk = this.pick(...names);
    if (!pk) return;
    const fps = pk.clip.fps;
    const impact = (pk.role.impact ?? pk.clip.impact ?? pk.role.from) / fps;
    const end = pk.role.to / fps;
    // fitted (outcome mode): at most humanRecoverRateMax × the clip's speed, the rest eased into the idle guard
    const fit = this.cfg.mocapOutcome && !this.cfg.humanRawPose && this.cfg.humanRecoverRateMax > 0 && !fromState;
    const rate = fit ? clamp((end - impact) / Math.max(0.05, this.cfg.humanHitReactTime), 1, this.cfg.humanRecoverRateMax) : 1;
    // THE HEAD FOLLOWS THE PUNCH: a hook from the other side plays the take mirrored (upper body only: the mirrored legs stand in the other stance)
    const mir = this.cfg.humanInertia && this.cfg.humanHitTurn !== 0 && part === 'head' && punch === 'hook' && lat * this.cfg.humanHitTurn < 0;
    this.hit = { pick: mir ? { ...pk, mirror: !pk.mirror } : pk, t: impact + age, end, n: ++this.hitN, fromState, t0: impact, rate, fit, mir };
  }

  /** Outcome mode (read by tests / the audit): what the punching hand is steered to this frame. */
  conformInfo: { kind: OutcomeKind | 'none'; w: number; at: Vec3 | null; part: BodyPart; resolved: boolean; toHit: number } = { kind: 'none', w: 0, at: null, part: 'head', resolved: false, toHit: 0 };
  /** The part the punch in flight is predicted to land on, then the part it was scored on. */
  private ocPart: BodyPart = 'head';
  /** (audit) the punch's body travel this frame along his facing, m: the sim's own, what the contact frame lacks, and the envelope on that. */
  lungeDbg: [number, number, number] = [0, 0, 0];
  private ocKindW = 0;
  private readonly ocT = { x: 0, y: 0, z: 0 };
  private ocKey = -1;
  /** punchN of the last punch of his that the other man blocked (punchBlock event with side = him). */
  private blockedN = -1;
  /**
   * OUTCOME FIRST (cfg.mocapOutcome): steer the punching hand onto the sim's contact point. Before the hit tick the
   * target comes from the sim's own rule evaluated on this state (predictOutcome), after it from punch.contact (set on
   * a land or a block). Weight: 0 until the extension starts, 1 at the hit tick, held through the hit-stop, out over
   * the first mocapIKOut of the recovery. The arm takes at most about mocapIKArmMax of the correction; the rest is the
   * drawn lunge (forward) and a body turn (across). A whiff or a dodge leaves the clip free (the view keeps it out of
   * the other body).
   */
  private conform(me: FighterState, opp: FighterState, u: number, cockEnd: number, peak: number, hold: number, total: number, pick: MocapPick, frame: number, lunge0: { x: number; z: number }, dt: number):
    { ik: NonNullable<AnimOut['ik']>; turn: number; lunge: { x: number; z: number } } {
    const cfg = this.cfg, mc = mocapCfg(cfg), p = me.punch;
    if (this.ocKey !== this.punchN) { this.ocKey = this.punchN; this.ocKindW = 0; this.ocT.x = NaN; }
    let kind: OutcomeKind, T: Vec3 | null = null;
    if (!p.resolved) {
      const o = predictOutcome(me, opp, mc, OCS);
      kind = o ? o.kind : 'whiff';
      if (o) this.ocPart = o.part;   // (a miss too: the view keeps its gap off the part the punch was thrown at)
      if (o && (kind === 'land' || kind === 'block')) T = contactPoint(me, opp, kind, o.part, mc, TP);
    } else if (p.contact) { kind = this.blockedN === this.punchN ? 'block' : 'land'; T = p.contact; }   // (a blocked punch stays 'block': the view puts it on the drawn guard)
    else kind = 'whiff';
    const hits = kind === 'land' || kind === 'block';
    const kw = 1 - Math.exp(-dt / 0.05);
    this.ocKindW += ((hits ? 1 : 0) - this.ocKindW) * (p.resolved ? 1 : kw);
    if (T) {
      if (Number.isNaN(this.ocT.x) || p.resolved) { this.ocT.x = T.x; this.ocT.y = T.y; this.ocT.z = T.z; }
      else { const k = 1 - Math.exp(-dt / 0.03); this.ocT.x += (T.x - this.ocT.x) * k; this.ocT.y += (T.y - this.ocT.y) * k; this.ocT.z += (T.z - this.ocT.z) * k; }
    }
    // (out only after the punch's own hold: the glove stays on the contact through the hold and the hit-stop)
    // (in only over the last mocapIKTicks before the hit: the clip's wind-up and most of its extension are untouched)
    // (humanContactDrawn: and over at least humanContactHomeTicks, into the end of the wind-up if the extension is shorter —
    //  an uppercut's extension is 4 ticks, and a hand steered 40 cm in 4 ticks is a glove going 30+ cm a tick)
    const tk = SIM_DT / Math.max(1e-6, total);
    const out0 = peak + hold * (1 - peak), in0 = Math.max(cfg.humanContactDrawn ? Math.min(cockEnd, peak - cfg.humanContactHomeTicks * tk) : cockEnd, peak - cfg.mocapIKTicks * tk);
    // REAL seconds to the hit (the wind-up runs 1 / cockMult slower or faster than plain progress: a chained punch's
    // wind-up is over in a tick, and a window measured in progress switched the hand on in that one tick: 44 cm)
    const toHit = p.resolved ? 0 : (Math.max(0, cockEnd - u) * cockMult(me) + Math.max(0, peak - Math.max(u, cockEnd))) * total * Math.max(1, p.timeMult);
    let wIn = u <= peak ? smooth((u - in0) / Math.max(1e-6, peak - in0)) : 1 - smooth((u - out0) / Math.max(1e-6, (1 - peak) * cfg.mocapIKOut));
    if (cfg.humanContactDrawn && u <= peak) {
      // steered over the extension, at least humanContactHomeTicks, at most mocapIKTicks, and never longer than the punch itself
      const ext = (peak - cockEnd) * total * Math.max(1, p.timeMult);
      const win = Math.max(SIM_DT, Math.min(p.tell > 0 ? p.tell : 1, Math.max(ext, cfg.humanContactHomeTicks * SIM_DT), cfg.mocapIKTicks * SIM_DT));
      wIn = smooth(clamp(1 - toHit / win, 0, 1));
    }
    const w = Number.isNaN(this.ocT.x) ? 0 : wIn * this.ocKindW;
    const at = { x: this.ocT.x, y: this.ocT.y, z: this.ocT.z };
    let turn = 0, lunge = cfg.humanInertia ? { x: 0, z: 0 } : lunge0;
    if (w > 1e-3 || (cfg.humanInertia && !Number.isNaN(this.ocT.x))) {
      // where the clip glove is now (his frame, from the drawn origin), and where the target is
      mocapClipGlove(pick, frame, cfg, me.body.heightM, CG2);
      const c = Math.cos(me.yaw), s = Math.sin(me.yaw);
      const L = lunge0.x * c + lunge0.z * s;
      const ox = me.pos.x - c * cfg.humanBackShift + lunge0.x, oz = me.pos.z - s * cfg.humanBackShift + lunge0.z;
      const aim = cfg.humanContactDrawn && this.fedT.n === this.punchN && kind === 'land' ? this.fedT : at;
      const tF = (aim.x - ox) * c + (aim.z - oz) * s, tL = (aim.x - ox) * -s + (aim.z - oz) * c;
      const gF = CG2.z, gL = -CG2.x;   // native x = his left
      const m = cfg.mocapIKArmMax;
      const dF = tF - gF, dL = tL - gL;
      let exF = dF - clamp(dF, -m, m), wL = w;
      const exL = dL - clamp(dL, -m, m);
      if (cfg.humanInertia) {
        // CONTINUITY: the body travel is the weight shift of the whole punch, not a shove in the last ticks: what the
        // clip's CONTACT frame lacks to the target, eased in over the whole extension and out over the whole recovery
        // (the sim's own lunge is NOT drawn: with hits by rule it only shoved the body out and the correction pulled it back)
        mocapClipGlove(pick, pick.contactF, cfg, me.body.heightM, CG2);
        const dC = tF + L - CG2.z;
        // (the body carries the punch there first, as a step; the arm correction only closes what is left)
        // (only a forward step is predicted from the clip; the closed loop, feedReach, does the rest from the drawn glove)
        exF = clamp(dC, 0, cfg.humanShiftFwd) * cfg.humanShiftPredict - L;
        wL = (u <= peak ? smooth(u / Math.max(1e-6, peak)) :1 - smooth((u - out0) / Math.max(1e-6, 1 - out0))) * this.ocKindW;
      }
      const Ln = cfg.humanInertia ? (L + exF) * wL : L + exF * wL;
      this.lungeDbg = [L, exF, wL];
      lunge = { x: c * Ln, z: s * Ln };
      // (no body turn: Nate 2026-11-17, every layer earns its way back; the across error stays, reported by the audit)
      void exL; turn = 0;
    }
    // A MISS IS STILL A COMMITTED PUNCH: he steps with it (the view holds the glove humanMissGap short of the other man)
    if (cfg.humanInertia && cfg.humanWhiffStep > 0) {
      const env = u <= peak ? smooth(u / Math.max(1e-6, peak)) : 1 - smooth((u - out0) / Math.max(1e-6, 1 - out0));
      const Lw = cfg.humanWhiffStep * env * (1 - this.ocKindW);
      lunge = { x: lunge.x + Math.cos(me.yaw) * Lw, z: lunge.z + Math.sin(me.yaw) * Lw };
    }
    this.conformInfo = { kind, w, at: Number.isNaN(at.x) ? null : at, part: this.ocPart, resolved: p.resolved, toHit };
    return { ik: { arm: pick.arm, w, at, exact: true, outcome: true }, turn, lunge };
  }

  /** `opp`: the opponent's states this frame (mocapGeo needs them for the aim, exactly as the sim does), or null. */
  update(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[], opp: { prev: FighterState; next: FighterState } | null = null): AnimOut {
    const cfg = this.cfg;
    this.clock += dt;
    this.wanted.clear();
    this.legitHand = -1;
    if (next.punch.type === null) this.legitPick = null;
    let label = '';
    const lean = { lat: 0, back: 0, fwd: 0, twist: 0 };
    let ik: AnimOut['ik'] = null;
    let aim: AnimOut['aim'] = null;
    let slipClip = false;
    let slipLv = 0;   // outcome mode: the slip's dip drawn through the crouch blend (0..1 of a held level)
    let lunge = { x: 0, z: 0 }, turn = 0;
    const p = next.punch;
    let punching = p.type !== null;

    // ---- events: hits and blocked shots on this man ----
    let hitByEvent = false;
    const rocked = events.some(e => (e.type === 'rocked' || e.type === 'knockdown') && e.side === this.side);
    for (const e of events) {
      if (e.type === 'punchLand' && e.target === this.side) {
        this.lastHitPart = e.part;
        let g: HitGrade;
        if (cfg.mocapOutcome && cfg.humanCalmHits) {
          // outcome mode (the impact layer gives the instant snap; the clip is the body's after-life):
          // glancing, or a clean jab -> light; a clean cross / hook / uppercut -> medium; flush or a counter -> heavy
          g = e.grade === 'flush' || e.counter ? 'flush' : e.grade === 'glancing' || e.punch === 'jab' ? 'glancing' : 'clean';
        } else {
          // grade picks the size; a counter or a combination's finisher is one size up
          g = (e.counter || e.finisher) && e.grade !== 'flush' ? (e.grade === 'glancing' ? 'clean' : 'flush') : e.grade;
        }
        this.startHit(e.part, e.punch, g, 1, 0, false, rocked, e.impulse.x * -Math.sin(next.yaw) + e.impulse.z * Math.cos(next.yaw)); hitByEvent = true;
        // (THE COUNTER'S PAYOFF, and the shot that rocks a man: it takes his whole body. Measured 2026-11-20: a counter
        //  turned his head 44-50 deg, the same as a plain land, while he calmly finished his own punch's recovery.)
        if (this.hit && cfg.humanCounterBreaks && (e.counter || rocked)) this.hit.big = true;
      }
      else if (e.type === 'punchBlock' && e.target === this.side) {
        const bh = this.find('block_hit');
        if (bh) this.want('blockhit#' + this.seq, bh, (bh.role.impact ?? bh.role.contact ?? bh.role.from) / bh.clip.fps, { fadeIn: 0.04, upper: true });
        this.jolt = 1;
      }
      else if (e.type === 'punchBlock' && e.side === this.side) this.blockedN = this.punchN;
    }
    // (the part his own landed punch was scored on: the view rests the glove on that part of the DRAWN man)
    // (a punch that went THROUGH a guard is scored as a land: it is drawn on the body, not left on the glove)
    for (const e of events) if (e.type === 'punchLand' && e.side === this.side) { this.ocPart = e.part; if (this.cfg.humanContactDrawn) this.blockedN = -1; }
    // (a big hit breaks the drawing of his own punch once that punch has been resolved: he reels, he does not finish his recovery)
    if (punching && this.hit?.big && p.resolved) punching = false;
    // ---- hit from state (frozen replays carry no events): hitT is set to hitWindow on the landing tick ----
    if (!hitByEvent && next.hitT > 0) {
      const age = cfg.hitWindow - next.hitT;
      if (next.hitT > prev.hitT + 1e-6 || !this.hit || this.hit.fromState) {
        const part: BodyPart = next.hurtKind === 'body' || Math.hypot(next.reaction.torso.x, next.reaction.torso.z) > Math.hypot(next.reaction.head.x, next.reaction.head.z) * 1.2 ? 'body' : 'head';
        if (!this.hit || next.hitT > prev.hitT + 1e-6) this.startHit(part, null, null, next.hitSev, age, true);
        else if (this.hit.fromState) this.hit.t = (this.hit.pick.role.impact ?? this.hit.pick.clip.impact ?? this.hit.pick.role.from) / this.hit.pick.clip.fps + age;
      }
    }

    // ---- idle (always underneath) ----
    if (this.idle) {
      this.idleT += dt;
      sample(this.lib, this.idle.clip, this.idle.role.from / this.idle.clip.fps + this.idleT, { loop: true, root: 'inPlace', mirror: this.southpaw }, this.pose);
    }

    const ip = (a: number, b: number): number => lerp(a, b, alpha);

    if (next.down) {
      // ---- down: the fall, held on its last frame; the get-up when he rises ----
      // (a head shot blows him back flat; a body shot folds him forward to his knees and over)
      const kd = cfg.humanInertia && this.lastHitPart === 'head' ? this.pick('knockdown_4', 'knockdown') : this.pick('knockdown');
      // HE WILL GET UP (the sim knows at the fall): one take, knocked to his hands and knees and up again, laid over the
      // time the sim gives him: the fall, the wait on all fours, the rise ending on the tick he is up
      const upAt = getUpAt(next);
      const kg = cfg.humanInertia && !cfg.humanRawPose && upAt > 0 ? this.find('knockdown_getup') : null;
      const gu = this.pick('getup');
      if (kg) {
        const kr = kg.role as Role & { hold?: number; up?: number }, fps = kg.clip.fps;
        const F0 = kr.from, FH = kr.hold ?? kr.from, FU = kr.up ?? kr.to, F1 = kr.to;
        const R = Math.min((F1 - FU) / fps * 0.9, upAt * 0.45), tFall = Math.min((FH - F0) / fps * 0.85, Math.max(0.3, upAt - R));
        const t = prev.down ? ip(prev.downT, next.downT) : next.downT;
        const f = t < tFall ? F0 + (FH - F0) * (t / tFall)
          : t < upAt - R ? FH + (FU - FH) * ((t - tFall) / Math.max(1e-3, upAt - R - tFall))
          : FU + (F1 - FU) * clamp((t - (upAt - R)) / Math.max(1e-3, R), 0, 1);
        this.want('down', kg, f / fps, { fadeOut: 0.3 });
        label = 'down (hands and knees, gets up) f' + f.toFixed(0);
      } else if (next.getUp.phase === 'rise' && gu) {
        this.want('getup', gu, gu.role.from / gu.clip.fps + next.getUp.t, { fadeIn: 0.3 });
        label = 'getup';
      } else if (next.getUp.phase === 'rise' && kd) {
        // no get-up clip: the fall played backwards from where it settled reads as getting up (instead of a pop to standing)
        const settle = ((kd.role as Role & { settle?: number }).settle ?? kd.role.to) / kd.clip.fps;
        this.want('down', kd, Math.max(kd.role.from / kd.clip.fps, settle - next.getUp.t * cfg.humanRiseRate), { fadeIn: 0.12, fadeOut: 0.5 });
        label = 'rise (fall reversed)';
      } else if (kd) {
        this.want('down', kd, Math.min(kd.role.to / kd.clip.fps, kd.role.from / kd.clip.fps + next.downT), { fadeIn: 0.12, fadeOut: 0.4 });
        label = 'down ' + kd.name;
      } else {
        const hv = this.pick('hit_head_heavy', 'hit_head_medium');
        if (hv) this.want('down', hv, hv.role.to / hv.clip.fps, { fadeIn: 0.12, fadeOut: 0.4 });
        lean.fwd = 0.25;
        label = 'down (fallback)';
      }
      this.wasDown = true;
      this.hit = null;
    } else {
      if (this.wasDown) { this.wasDown = false; }
      // ---- punch ----
      if (punching) {
        const type = p.type!;
        const lead = p.hand === 'lead';
        const base = type === 'jab' ? 'jab' : type === 'cross' ? 'cross' : `${lead ? 'lead' : 'rear'}_${type}`;
        const low = p.variant.startsWith('body') || p.aim > cfg.humanBodyAim;
        const key = `${type}:${p.hand}:${p.variant}`;
        if (key !== this.punchKey || p.progress < this.lastProgress - 0.25) {
          // a new punch: chained if the last one was still in flight (the sim's test) or ended a moment ago
          const last = this.lastPunch;
          this.chainedFrom = last && (prev.punch.type !== null || this.clock - this.lastPunchEnd < cfg.humanComboWindow) ? last : null;
          this.punchKey = key; this.punchN++; this.punchStart = this.clock; this.legitPick = null;
        }
        this.lastPunch = { type, hand: p.hand };
        this.lastPunchEnd = this.clock;
        this.lastProgress = p.progress;
        const u = prev.punch.type === p.type && prev.punch.hand === p.hand ? ip(prev.punch.progress, p.progress) : p.progress;
        const ph = punchPhases(cfg, type);
        const peak = ph.peakAt;
        // mocapGeo: the SIM's numbers (core/mocap.ts through sim/mocap.ts): its clip, its frame, its lunge, its turn, its glove
        const geoB = cfg.mocapGeo && opp ? mocapPunchNow(next, opp.next, cfg) : null;
        const geoA = geoB && opp && prev.punch.type === p.type && prev.punch.hand === p.hand ? mocapPunchNow(prev, opp.prev, cfg) : null;
        let pk: Pick | null = null;
        if (geoB?.geo.pick) {
          const g = geoB.geo, gp = g.pick!;
          pk = { name: gp.name, role: gp.role, clip: gp.clip, mirror: gp.mirror !== this.southpaw };   // core's mirror is absolute
          const same = geoA?.geo.pick === gp;
          let f = same ? ip(geoA!.frame, geoB.frame) : geoB.frame;
          let fixW: number | undefined;
          if (cfg.humanInertia && !cfg.humanRawPose && cfg.mocapOutcome) {
            // NATURAL SPEED (Nate 2026-11-18: "some punches are in literal slow motion"): the frames into the contact play at
            // humanSwingRate x the clip's own speed, never stretched to fill the wind-up. With time to spare he HOLDS the take's
            // first frame (the loaded pose: that is the tell) and then throws at full speed; with less, the take starts part-way.
            const T = ph.total * Math.max(1, p.timeMult);
            if (this.clock === this.punchStart) this.punchF0 = geoB.frame;
            // (REAL seconds to the hit: the sim's clock runs 1 / cockMult slower through the wind-up. Counting it as plain
            //  progress played the wind-up frames at 1 / cockMult of their speed — measured 2026-11-19: jab 40%, cross 60%,
            //  hook 80% of the clip's speed: "jab and cross in slow motion, hooks faster")
            const secToHit = (Math.max(0, ph.cockEnd - u) * cockMult(next) + (peak - Math.max(u, ph.cockEnd))) * T;
            if (this.clock === this.punchStart) this.punchSec0 = secToHit;
            if (u <= peak) {
              // (the cross's take is its recovery played backwards: at its recorded speed the glove is PUSHED out at a steady
              //  2.4 m/s for 0.33 s, no drive. humanCrossSwingEase bends the same frames over the same time: slow turn, fast fist)
              const startF = Math.max(Math.min(this.punchF0, gp.contactF), gp.contactF - cfg.humanSwingRate * this.punchSec0 * gp.clip.fps);
              const span = gp.contactF - startF, swingSec = span / Math.max(1e-6, cfg.humanSwingRate * gp.clip.fps);
              const s = swingSec > 1e-6 ? clamp(1 - secToHit / swingSec, 0, 1) : 1;
              f = startF + span * Math.pow(s, type === 'cross' ? cfg.humanCrossSwingEase : 1);
            }
            else {
              // AFTER THE HIT: a punch that touched something comes straight home from its contact pose (no follow-through
              // through the man it hit, no lingering); a miss swings through at up to humanRecoverRateMax and is home by the end too.
              const simRec = Math.max(1e-3, (1 - peak) * T), sec = (u - peak) * T;
              const sec0 = ph.hold * simRec * (type === 'jab' ? cfg.humanJabHold : cfg.humanHeavyHold);
              f = p.contact ? gp.contactF : gp.contactF + sec * cfg.humanWhiffSwingRate * gp.clip.fps;
              fixW = 1 - smooth((sec - sec0) / Math.max(1e-3, simRec * cfg.humanHomeBy - sec0));
            }
          } else {
            // THE SWING IS NEVER FAST-FORWARDED: the frames into the contact play at most humanExtendRate x the clip's speed, so
            // the swing starts earlier inside the (long) wind-up and still meets the contact frame on the hit tick
            if (cfg.humanInertia && !cfg.humanRawPose && cfg.humanExtendRate > 0 && u < peak) {
              const secToHit = (peak - u) * ph.total * Math.max(1, p.timeMult);
              f = Math.max(f, gp.contactF - cfg.humanExtendRate * secToHit * gp.clip.fps);
            }
            // RECOVERY FITTED (outcome mode): the clip's recovery plays at most humanRecoverRateMax × its own speed; a
            // recovery longer than that is cut short by easing the clip out into the idle guard over the sim's recovery
            if (cfg.mocapOutcome && !cfg.humanRawPose && cfg.humanRecoverRateMax > 0 && u > peak) {
              const T = ph.total * Math.max(1, p.timeMult), simRec = Math.max(1e-3, (1 - peak) * T), sec = (u - peak) * T;
              const clipRec = (gp.endF - gp.contactF) / gp.clip.fps;
              // (a take trimmed to end at its contact has no recovery of its own: always eased home from the contact pose)
              if (clipRec / simRec > cfg.humanRecoverRateMax || gp.role.to - gp.contactF < 2) {
                // the LEGS keep the clip stretched over the sim's recovery (a stepped-in foot comes home at the clip's
                // own pace: cutting it slid the foot 26 cm in a tick); the arms and body take the fitted, eased-out frame
                if (!cfg.humanInertia) this.want('punchL#' + this.punchN, pk, f / gp.clip.fps, { lower: true, w: 1, fadeOut: cfg.humanFadeOut });
                // (a jab's short recovery plays the take at its own speed, never faster: the body jab bobbed 12 cm in six ticks; what is left goes home on the carry-over)
                f = gp.contactF + sec * (cfg.humanInertia && type === 'jab' ? Math.min(1, cfg.humanRecoverRateMax) : cfg.humanRecoverRateMax) * gp.clip.fps;
                const sec0 = ph.hold * simRec;   // the glove stays on the contact through the punch's hold
                // (continuity on: no ease-out squeezed into the sim's recovery; when the punch ends, what is left of the way home is carried over and decays)
                // (a take with no recovery of its own, the trimmed uppercuts, is still eased home: it would hang at its contact pose)
                if (!cfg.humanInertia || gp.role.to - gp.contactF < 2) fixW =1 - smooth((sec - sec0) / Math.max(1e-3, simRec - sec0));
              }
            }
          }
          const easeIn = cfg.mocapOutcome && !cfg.humanRawPose ? gp.role.easeIn : undefined;
          // (continuity on: a take mirrored from the other hand stands in the other stance; only its upper body is used, the legs stay his own)
          this.want('punch#' + this.punchN, pk, f / gp.clip.fps, { ...(fixW !== undefined ? { fixW } : {}), ...(easeIn ? { fadeIn: easeIn } : {}), ...(cfg.humanInertia ? { upper: true } : {}),
            // (what is carried over from the last action must be gone by the hit: its half-life is at most a fifth of the time to the hit)
            halfMax: Math.max(0, peak - u) * ph.total * Math.max(1, p.timeMult) * cfg.humanInertiaHitShare });
          // (continuity on: the ARMS AND TRUNK are the track above, eased home after the hit; the LEGS are their own track, which
          //  keeps the take to the end of the punch and then settles at the legs' pace: a stepped foot does not rush home with the hand)
          if (cfg.humanInertia && !cfg.humanRawPose && !pk.mirror) this.want('punchL#' + this.punchN, pk, f / gp.clip.fps, { lower: true, halfMax: Math.max(0, peak - u) * ph.total * Math.max(1, p.timeMult) * cfg.humanInertiaHitShare });
          label = `${gp.name} f${f.toFixed(0)} (contact ${gp.contactF})`;
          // (audit) how far the clip's own glove moves between the frames drawn last tick and this one
          mocapClipGlove(gp, f, cfg, next.body.heightM, CG1);
          const C0 = this.CG0;
          this.legitHand = this.legitPick === gp ? Math.hypot(CG1.x - C0.x, CG1.y - C0.y, CG1.z - C0.z) : -1;
          this.legitPick = gp; C0.x = CG1.x; C0.y = CG1.y; C0.z = CG1.z;
          lunge = same ? { x: ip(geoA!.lunge.x, geoB.lunge.x), z: ip(geoA!.lunge.z, geoB.lunge.z) } : { ...geoB.lunge };
          turn = same ? ip(geoA!.geo.turn, g.turn) : g.turn;
          // the drawn arm onto the sim glove: a small correction, in over the flight, held on the target through the hit-stop
          // full weight through the whole punch once the clip has faded in (so the drawn glove IS the scored glove), eased in over the fade
          // Weight 1 from the press: the view starts the target ON the drawn hand (its press offset, eased out over the
          // wind-up as the sim eases its glove from the press), so nothing switches on mid-punch.
          const w = cfg.humanIKWeight;
          const kc = clamp(u / Math.max(1e-6, ph.cockEnd), 0, 1);
          this.pressW = 1 - kc * kc * (3 - 2 * kc);
          // the SIM's glove (the clip glove, stopped where it met a head, a body or a guard), not the free clip glove
          const gi = p.hand === 'lead' ? 0 : 1, g0 = prev.gloves[gi].pos, g1 = next.gloves[gi].pos;
          const gl = { x: ip(g0.x, g1.x), y: ip(g0.y, g1.y), z: ip(g0.z, g1.z) };
          if (cfg.mocapOutcome && opp) {
            // OUTCOME FIRST: the hand is steered onto the sim's contact point (or left free on a whiff / dodge)
            const c = this.conform(next, opp.next, u, ph.cockEnd, peak, ph.hold * (cfg.humanInertia ? (type === 'jab' ? cfg.humanJabHold : cfg.humanHeavyHold) : 1), ph.total * Math.max(1, p.timeMult), gp, f, lunge, dt);
            ik = c.ik; turn = c.turn; lunge = c.lunge;
          } else if (w > 0.01) ik = { arm: g.arm, w, at: gl, exact: true, key: this.punchN, pressW: this.pressW };
          // a chained punch with the OTHER arm: the last arm keeps its own tail (it was lost here: a 30 cm pop of the jab hand when the cross started)
          // (outcome first: no tails onto the sim glove — the arm is the clip's once the conform IK has ramped out)
          if (!cfg.mocapOutcome) {
            if (this.ikTail && this.ikTail.arm !== g.arm) this.tailOld = { ...this.ikTail };
            if (this.tailOld && this.tailOld.arm === g.arm) this.tailOld = null;
            this.ikTail = { arm: g.arm, gi, w };
          }
        } else {
          const names = mocapRoleNames(this.roles, type, p.hand, low, this.chainedFrom);
          const twin = mocapTwinRole(type, p.hand);   // the other hand's role: mirrored onto this arm
          for (const n of names) { const f = this.find(n); if (f) { pk = { ...f, mirror: n === twin }; break; } }
        }
        if (pk && !geoB?.geo.pick) {
          const c = pk.clip, fps = c.fps, r = pk.role;
          const mark = c.punches.find(m => r.contact !== undefined ? m.from <= r.contact && r.contact <= m.to + 2 : true);
          const contactF = r.contact ?? mark?.peak ?? (r.from + r.to) / 2;
          const endF = Math.min(r.to, mark && mark.to > contactF ? mark.to : contactF + 1.5 * (contactF - r.from));
          let startF = r.from;
          const maxLead = cfg.humanMaxLeadIn * Math.max(0.05, p.tell) * fps;
          if (contactF - startF > maxLead) startF = contactF - maxLead;
          const f = u <= peak ? startF + (u / Math.max(1e-6, peak)) * (contactF - startF) : contactF + ((u - peak) / Math.max(1e-6, 1 - peak)) * (endF - contactF);
          this.want('punch#' + this.punchN, pk, f / fps);
          label = `${pk.name} f${f.toFixed(0)} (contact ${contactF})`;
        } else if (!pk) label = `punch ${base}: no clip`;
        const sec = (u - peak) * ph.total * Math.max(1, p.timeMult);
        // A body clip (roles.json body: true) thrown at the head: lift it, bell-shaped round the hit (the sim aims it itself under mocapGeo).
        if (pk && !geoB && !low && (pk.role as Role & { body?: boolean }).body && cfg.humanAimLift > 0) {
          const w = cfg.humanAimLift * Math.exp(-0.5 * (sec / Math.max(0.01, cfg.humanAimSigma)) ** 2);
          const gi = lead ? 0 : 1;
          const y = p.contact?.y ?? ip(prev.gloves[gi].pos.y, next.gloves[gi].pos.y);
          if (w > 0.01) aim = { arm: lead !== this.southpaw ? 'Left' : 'Right', w, y };
        }
        // Fist on target: a bell round the hit moment, in (approx.) real seconds.
        if (cfg.humanHandIK && !geoB) {
          const w = cfg.humanIKWeight * Math.exp(-0.5 * (sec / Math.max(0.01, cfg.humanIKSigma)) ** 2);
          if (w > 0.01) {
            const gi = lead ? 0 : 1;
            const g0 = prev.gloves[gi].pos, g1 = next.gloves[gi].pos;
            const at = p.contact ?? { x: ip(g0.x, g1.x), y: ip(g0.y, g1.y), z: ip(g0.z, g1.z) };
            const leftHand = lead !== this.southpaw;   // orthodox lead = left
            ik = { arm: leftHand ? 'Left' : 'Right', w, at };
          }
        }
        // (his own punch used to override the reaction whole. Measured 2026-11-20: hit mid-punch his head turned 11-28 deg
        //  against 41-56 standing, "he's not really responding... yet I'm doing damage". Now the head and neck take the hit.)
        if (!cfg.humanHitThroughPunch) this.hit = null;
      }
      // ---- block (upper body) ----
      if (next.block && !punching) {
        const bodyBlock = next.level > 0.5 ? this.find('body_block') : null;
        const bk = bodyBlock ?? this.find('block');
        if (bk) {
          const hold = (bk.role.contact ?? bk.role.to) / bk.clip.fps;
          const tr = this.tracks.find(x => x.key === 'block:' + bk.name);
          const t = Math.min(hold, (tr ? tr.t + dt : Math.max(bk.role.from / bk.clip.fps, hold - 0.25)));
          this.want('block:' + bk.name, bk, t, { upper: true, fadeIn: 0.07, fadeOut: 0.1 });
          label = label || 'block';
        }
      }
      // ---- hit reaction ----
      if (this.hit && (!punching || cfg.humanHitThroughPunch)) {
        this.hit.t += this.hit.fromState && next.hitT > 0 ? 0 : dt * this.hit.rate;
        const h = this.hit;
        if (punching) h.head = true;   // once his punch is in it, the reaction stays on the head and neck to its end
        // fitted: real seconds since the impact; past half the react time the clip eases out if it is still going
        const age = (h.t - h.t0) / h.rate, R = cfg.humanHitReactTime;
        const cut = h.fit && (h.end - h.t0) / h.rate > R + 1e-3;
        if (h.t < h.end && !(cut && age >= R)) {
          this.want((h.head ? 'hith#' : 'hit#') + h.n, h.pick, h.t, { fadeIn: cfg.humanHitFadeIn, fadeOut: 0.25, target: h.t > h.end - 0.25 * h.rate ? 0 : 1, ...(h.head ? { head: true } : h.mir ? { upper: true } : {}), ...(cut ? { fixW: 1 - smooth((age - 0.5 * R) / (0.5 * R)) } : {}) });
          label = label || 'hit ' + h.pick.name;
        } else this.hit = null;
      }
      // ---- slip / duck / pull ----
      const s = next.slip;
      if (s.active && !punching) {
        const off = ip(prev.slip.offset, s.offset), dip = ip(prev.slip.dip, s.dip);
        const leftward = s.dir === 2 ? 0 : -off * (this.southpaw ? -1 : 1);   // offset < 0 = toward the lead side
        const name = s.kind === 'roll' || (s.dir !== 2 && dip > 0.06 && Math.abs(off) < 0.05) ? 'duck' : s.dir === 2 ? 'lean_back' : leftward > 0 ? 'slip_left' : 'slip_right';
        // outcome mode, humanSlipProcedural: the slip and the pull are the IDLE (guard up) bent by the sim's own numbers
        // (the `dodging` take drops both hands and squats wide); the duck / roll is the crouch's partial duck blend
        const proc = cfg.mocapOutcome && cfg.humanSlipProcedural && !cfg.humanRawPose;
        const pk = proc || (name === 'lean_back' && !cfg.humanLeanBackClip) ? null : this.pick(name);   // a missing slip side = the other side mirrored
        if (proc) {
          slipLv = clamp(dip / Math.max(0.01, cfg.levelDrop), 0, 1) * (name === 'duck' ? 1 : cfg.humanSlipKnee);
          if (name !== 'duck') {
            lean.lat = leftward; lean.back = s.dir === 2 ? off : 0;
            lean.twist = s.dir === 2 ? 0 : leftward * cfg.humanSlipTwist;
          }
          label = label || name + ' (procedural)';
        } else if (pk) {
          slipClip = true;
          this.want('slip:' + name + ':' + s.chain, pk, pk.role.from / pk.clip.fps + s.t, { fadeIn: 0.05, fadeOut: 0.15 });
          label = label || name;
        } else {
          lean.lat = leftward; lean.back = s.dir === 2 ? off : 0; lean.fwd = dip;
          label = label || name + ' (procedural)';
        }
      }
      // ---- crouch (outcome mode): the held level drawn as the duck clip's lowest frame, legs and hips only, by the level ----
      if (cfg.mocapOutcome && !cfg.humanRawPose && cfg.humanCrouchClip > 0 && (!(s.active && !punching) || slipLv > 0)) {
        const lv = Math.max(ip(prev.level, next.level), slipLv);
        const dk = this.find('duck');
        if (dk && (lv > 0.02 || this.tracks.some(x => x.key === 'loco:crouch'))) {
          this.want('loco:crouch', dk, (dk.role.contact ?? dk.role.to) / dk.clip.fps, { lower: true, fadeIn: 0.12, fadeOut: 0.15, target: clamp(lv, 0, 1) * cfg.humanCrouchClip });
        }
        // the upper body leans with the legs (a boxer's level change is knees AND a forward lean from the hips), by its own share
        if (dk && cfg.humanCrouchUpper > 0 && (lv > 0.02 || this.tracks.some(x => x.key === 'loco:crouchU'))) {
          this.want('loco:crouchU', dk, (dk.role.contact ?? dk.role.to) / dk.clip.fps, { lean: true, fadeIn: 0.12, fadeOut: 0.15, target: clamp(lv, 0, 1) * cfg.humanCrouchUpper });
        }
      }
      // ---- hurt ----
      if (next.hurt > 0 && !punching) {
        const st = this.find('stunned');
        if (st) {
          const tr = this.tracks.find(x => x.key === 'stunned');
          this.want('stunned', st, (tr?.t ?? 0) + dt, { loop: true, fadeIn: 0.3, fadeOut: 0.4, target: cfg.humanStunWeight });
        }
      }
      // ---- moving: the step clips by direction in his own frame ----
      const vx = ip(prev.vel.x, next.vel.x), vz = ip(prev.vel.z, next.vel.z), yaw = next.yaw;
      const fwd = vx * Math.cos(yaw) + vz * Math.sin(yaw);
      const left = vx * Math.sin(yaw) - vz * Math.cos(yaw);
      const speed = Math.hypot(fwd, left);
      const wMove = smooth((speed - cfg.humanWalkSpeedMin) / Math.max(0.01, cfg.humanWalkSpeedMin));
      const comps: [string, number][] = [['walk_fwd', Math.max(0, fwd)], ['walk_back', Math.max(0, -fwd)], ['walk_left', Math.max(0, left)], ['walk_right', Math.max(0, -left)]];
      const sum = comps.reduce((a, c) => a + c[1], 0) || 1;
      for (const [dir, v] of comps) {
        // a southpaw's clips are mirrored, so his left step is the right-step clip seen in the mirror
        const name = this.southpaw && dir === 'walk_left' ? 'walk_right' : this.southpaw && dir === 'walk_right' ? 'walk_left' : dir;
        const pk = this.pick(name);
        if (!pk) continue;
        const tr = this.tracks.find(x => x.key === 'loco:' + dir);
        const target = wMove * (v / sum) * (punching ? 0.5 : 1);
        if (!tr && target < 0.02) continue;
        const natural = Math.max(0.3, pk.clip.travel.net / Math.max(0.1, pk.clip.duration));
        const rate = clamp(speed / natural, 0.6, cfg.humanWalkRateMax);
        this.want('loco:' + dir, pk, (tr?.t ?? 0) + dt * rate, { loop: true, fadeIn: cfg.humanWalkFade, fadeOut: cfg.humanWalkFade, target });
      }
      if (wMove > 0.3 && !label) label = 'walk';
    }
    if (!label) label = 'idle';

    // ---- weights, then the blend (loco first, then actions in start order) ----
    for (const tr of this.tracks) {
      if (!this.wanted.has(tr.key)) {
        tr.target = 0;
        // CONTINUITY: an action that ends is dropped whole; the way home from the pose on screen is carried over and decays
        if (tr.w > 1e-3 && this.cutHalfFor(tr.key) > 0) { tr.w = 0; this.cutHalf = this.cutHalf > 0 ? Math.min(this.cutHalf, cfg.humanInertiaHalfOut) : cfg.humanInertiaHalfOut; }
      }
      const up = tr.target > tr.w;
      const rate = dt / Math.max(1e-3, up ? tr.fadeIn : tr.fadeOut);
      tr.w = up ? Math.min(tr.target, tr.w + rate) : Math.max(tr.target, tr.w - rate);
    }
    this.tracks = this.tracks.filter(tr => tr.w > 1e-3 || tr.target > 0);
    const ordered = [...this.tracks].sort((a, b) => (a.key.startsWith('loco:') ? 0 : 1) - (b.key.startsWith('loco:') ? 0 : 1) || a.seq - b.seq);
    for (const tr of ordered) {
      const w = smooth(tr.w);
      if (w <= 1e-3) continue;
      const c = tr.pick.clip;
      const from = tr.pick.role.from / c.fps, to = tr.pick.role.to / c.fps;
      const span = Math.max(1e-3, to - from);
      const t = tr.loop ? from + ((((tr.t - from) % span) + span) % span) : clamp(tr.t, from, to);
      sample(this.lib, c, t, { root: 'inPlace', mirror: this.southpaw !== tr.pick.mirror }, this.tmp);
      for (let b = 0; b < this.nb; b++) {
        const wb = tr.head ? w * this.headMask[b]! : tr.lean ? w * this.leanMask[b]! : tr.upper ? w * this.upperMask[b]! : tr.lower ? w * (1 - this.upperMask[b]!) : w;
        if (wb > 1e-3) nlerp(this.pose.rot, b * 4, this.tmp.rot, b * 4, wb, this.pose.rot, b * 4);
      }
      if (!tr.upper) this.pose.hips[1] = lerp(this.pose.hips[1]!, this.tmp.hips[1]!, w);   // (the crouch's lower mask carries the hips height too)
    }
    // after a mocapGeo punch the arm leaves the sim's glove gradually (it is on its way back to the guard), never in one frame
    if (!ik && this.ikTail) {
      const t = this.ikTail;
      t.w -= dt / Math.max(0.01, cfg.humanFadeOut);
      if (t.w > 0.01 && !next.down) {
        const g0 = prev.gloves[t.gi === 0 ? 0 : 1].pos, g1 = next.gloves[t.gi === 0 ? 0 : 1].pos;
        ik = { arm: t.arm, w: t.w, at: { x: lerp(g0.x, g1.x, alpha), y: lerp(g0.y, g1.y, alpha), z: lerp(g0.z, g1.z, alpha) }, exact: true };
      } else this.ikTail = null;
    }
    let ik2: AnimOut['ik'] = null;
    if (this.tailOld) {
      const t = this.tailOld;
      t.w -= dt / Math.max(0.01, cfg.humanFadeOut);
      if (t.w > 0.01 && !next.down) {
        const g0 = prev.gloves[t.gi === 0 ? 0 : 1].pos, g1 = next.gloves[t.gi === 0 ? 0 : 1].pos;
        ik2 = { arm: t.arm, w: t.w, at: { x: lerp(g0.x, g1.x, alpha), y: lerp(g0.y, g1.y, alpha), z: lerp(g0.z, g1.z, alpha) }, exact: true };
      } else this.tailOld = null;
    }
    // what is on top (test hook __humanProbe): the heaviest track, or the idle
    let top: Track | null = null;
    for (const tr of this.tracks) if (tr.w > 0.5 && (!top || tr.seq > top.seq)) top = tr;
    this.info = top
      ? { slug: top.pick.clip.slug, frame: top.t * top.pick.clip.fps, punch: top.key.startsWith('punch#') }
      : { slug: this.idle?.clip.slug ?? '', frame: this.idleT * (this.idle?.clip.fps ?? 60), punch: false };
    // The sim owns the floor position: no horizontal hips travel from any clip.
    this.pose.hips[0] = 0; this.pose.hips[2] = 0;
    if (cfg.humanInertia && !cfg.humanRawPose) {
      // KNOCKED DOWN: he goes down AWAY from the other man (drawn only), clear of his legs; he comes back as he rises
      const clear = next.down && next.getUp.phase !== 'rise' ? cfg.humanDownClear : 0;
      if (next.down) lunge = { x: -Math.cos(next.yaw) * clear, z: -Math.sin(next.yaw) * clear };
      lunge = this.lungeStep(lunge.x, lunge.z, dt, next.down ? cfg.humanDownClearHalf : 0);
      if (!this.biasFed) this.lungeBias *= Math.exp(-dt * Math.LN2 / Math.max(1e-3, cfg.humanLungeHalfBack));
      this.biasFed = false;
      lunge = { x: lunge.x + Math.cos(next.yaw) * this.lungeBias, z: lunge.z + Math.sin(next.yaw) * this.lungeBias };
    }

    // A blocked shot: a short flinch back (no block_hit clip, or on top of it).
    if (this.jolt > 0) { lean.back += cfg.humanBlockJolt * this.jolt; this.jolt = Math.max(0, this.jolt - dt / 0.18); }
    // How far the sim's head is down from level / crouch / inside posture / slip dip, m (the view drops the hips by it,
    // feet pinned). A punch's own crouch is in its clip; a slip clip carries its own dip.
    const ipn = (a: number, b: number): number => lerp(a, b, alpha);
    const drop = next.down ? 0 : cfg.humanLevelGain * (ipn(prev.level, next.level) * cfg.levelDrop + ipn(prev.posture, next.posture) * cfg.insideCrouch
      + (punching ? 0 : Math.max(0, ipn(prev.crouch, next.crouch))) + (slipClip || !next.slip.active ? 0 : ipn(prev.slip.dip, next.slip.dip)))
      + cfg.humanSinkGain * Math.max(0, ipn(prev.reaction.sink.x, next.reaction.sink.x));
    if (!slipClip && next.slip.active && !next.down) lean.fwd = 0;   // the dip is now the hips going down, not a bow
    // TIRED (drawn only): he slumps a little and breathes bigger and faster
    if (cfg.humanInertia && cfg.humanTiredOn && !next.down) {
      const td = tiredOf(next, cfg);
      this.breath += dt * 2 * Math.PI * (cfg.humanBreathRate + cfg.humanBreathRateTired * td);
      // (on the BACK channel, negative = a small forward lean of the head by that many metres; the fwd channel is a deep bow: 7 cm there bent him 25 degrees and his jab fell 15 cm short)
      lean.back -= cfg.humanTiredSlump * td + Math.sin(this.breath) * (cfg.humanBreathAmp + cfg.humanBreathAmpTired * td);
    }
    // CONTINUITY: the procedural lean (slip, pull, block flinch) moves on a spring; the sim's slip offset ends in one tick, the picture does not
    if (cfg.humanInertia && !cfg.humanRawPose && dt > 1e-5) {
      const g = [lean.lat, lean.back, lean.fwd, lean.twist], y = 2 * Math.LN2 / Math.max(1e-3, cfg.humanLeanHalf), e = Math.exp(-y * dt);
      for (let i = 0; i < 4; i++) {
        const a = this.leanS[i]! - g[i]!, b = this.leanV[i]! + a * y;
        this.leanS[i] = e * (a + b * dt) + g[i]!; this.leanV[i] = e * (this.leanV[i]! - b * y * dt);
      }
      lean.lat = this.leanS[0]!; lean.back = this.leanS[1]!; lean.fwd = this.leanS[2]!; lean.twist = this.leanS[3]!;
    }
    // THE REFERENCE (humanRawPose): the clips alone, placed at the sim's pos / yaw
    if (cfg.humanRawPose) return { pose: this.pose, ik: null, ik2: null, aim: null, lean: { lat: 0, back: 0, fwd: 0 }, drop: 0, label, lunge: { x: 0, z: 0 }, turn: 0 };
    // outcome first: no hips drop with leg IK (the crouch is the duck clip, above); the lunge and the conform IK stay
    if (cfg.mocapOutcome) {
      // GOING TO THE BODY IS A LEVEL CHANGE (humanBodyDip; Nate 2026-11-20: "holding Shift and throwing to the body he
      // still looks upright; body combinations look the same as head combinations"). The body-punch clips stand almost
      // as tall as the head ones (measured in live fights: the drawn head 15 cm higher than the sim's through a body
      // punch). While a body punch is in flight the hips sink and he bends at the waist into it; eased, never switched.
      const np = next.punch;
      const want = cfg.humanBodyDip && np.type !== null && !next.down && VARIANTS[np.variant].body && np.progress < cfg.humanBodyDipUntil ? 1 : 0;
      if (dt > 1e-5) this.bodyDip += (want - this.bodyDip) * (1 - Math.exp(-dt / Math.max(1e-3, want ? cfg.humanBodyDipIn : cfg.humanBodyDipOut)));
      lean.fwd += cfg.humanBodyDipLean * this.bodyDip;
      return { pose: this.pose, ik, ik2: null, aim: null, lean, drop: cfg.humanBodyDipDrop * this.bodyDip, label, lunge, turn };
    }
    return { pose: this.pose, ik, ik2, aim, lean, drop, label, lunge, turn };
  }
}

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
import type { BodyPart, FighterState, HitGrade, PunchType, SimEvent, Side, Vec3 } from '../core/types';
import { punchPhases } from '../sim/punches';
import { mocapPunchNow } from '../sim/mocap';
import { mocapClipGlove, mocapRoleNames, type ChainedFrom } from '../core/mocap';
const CG1 = { x: 0, y: 0, z: 0 };   // scratch
import { makePose, sample, type Clip, type ClipLib, type Pose, type Role, type Roles } from './clip';

interface Pick { name: string; role: Role; clip: Clip; mirror: boolean }

interface Track {
  key: string; pick: Pick; t: number; loop: boolean;
  w: number; target: number; fadeIn: number; fadeOut: number;
  upper: boolean; seq: number;
}

export interface AnimOut {
  pose: Pose;
  /** Hand IK ask: pull this arm's hand so the glove centre sits at `at` (world), by weight w. */
  ik: { arm: 'Left' | 'Right'; w: number; at: Vec3; exact?: boolean; key?: number; pressW?: number } | null;
  /** The previous punch's arm easing off the sim glove while a chained punch with the other arm runs (null otherwise). */
  ik2: AnimOut['ik'];
  /** mocapGeo: the body offset of the punch's lunge (world floor m) and its turn (rad, + = toward his right), from the sim. */
  lunge: { x: number; z: number };
  turn: number;
  /** Aim lift: a body-flagged clip thrown at the head: raise the punching hand toward world height y (spine pitch + shoulder), by weight w. */
  aim: { arm: 'Left' | 'Right'; w: number; y: number } | null;
  /** Procedural spine lean, as the head displacement wanted, m, in his own frame (lat + = to his left, back + = backward, fwd + = forward bend). */
  lean: { lat: number; back: number; fwd: number };
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

export class HumanAnim {
  private readonly nb: number;
  private readonly pose: Pose;
  private readonly tmp: Pose;
  private readonly upperMask: Float32Array;
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
  private hit: { pick: Pick; t: number; end: number; n: number; fromState: boolean } | null = null;
  private hitN = 0;
  private jolt = 0;   // procedural flinch of a blocked shot, 1 -> 0
  private wasDown = false;
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
    lib.bones.forEach((n, i) => {
      const s = n.replace(/^mixamorig\d*[:_]?/, '');
      this.upperMask[i] = s === 'Spine' ? 0.35 : s === 'Spine1' ? 0.7 : /^(Spine2|Neck|Head|Left(Shoulder|Arm|ForeArm|Hand)|Right(Shoulder|Arm|ForeArm|Hand))/.test(s) ? 1 : 0;
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

  private want(key: string, pick: Pick, t: number, o: { loop?: boolean; fadeIn?: number; fadeOut?: number; upper?: boolean; w?: number; target?: number } = {}): void {
    let tr = this.tracks.find(x => x.key === key);
    if (!tr) {
      tr = { key, pick, t, loop: !!o.loop, w: o.w ?? 0, target: 1, fadeIn: o.fadeIn ?? this.cfg.humanFadeIn, fadeOut: o.fadeOut ?? this.cfg.humanFadeOut, upper: !!o.upper, seq: this.seq++ };
      this.tracks.push(tr);
    }
    tr.t = t; tr.target = o.target ?? 1;
    if (o.fadeOut !== undefined) tr.fadeOut = o.fadeOut;
    this.wanted.add(key);
  }
  private wanted = new Set<string>();

  private startHit(part: BodyPart, punch: PunchType | null, grade: HitGrade | null, sev: number, age: number, fromState: boolean): void {
    const g = grade ?? (sev < 0.4 ? 'glancing' : sev < 0.75 ? 'clean' : 'flush');
    const level = g === 'glancing' ? 'light' : g === 'clean' ? 'medium' : 'heavy';
    const head = level === 'heavy' ? ['hit_head_heavy', 'hit_head_medium', 'hit_head_light'] : level === 'medium' ? ['hit_head_medium', 'hit_head_light', 'hit_head_heavy'] : ['hit_head_light', 'hit_head_medium'];
    const names = part === 'body'
      ? (punch === 'uppercut' ? ['hit_body_uppercut', 'hit_body'] : ['hit_body'])
      : punch === 'uppercut' ? [`hit_uppercut_${level}`, 'hit_uppercut', ...head] : head;
    const pk = this.pick(...names);
    if (!pk) return;
    const fps = pk.clip.fps;
    const impact = (pk.role.impact ?? pk.clip.impact ?? pk.role.from) / fps;
    this.hit = { pick: pk, t: impact + age, end: pk.role.to / fps, n: ++this.hitN, fromState };
  }

  /** `opp`: the opponent's states this frame (mocapGeo needs them for the aim, exactly as the sim does), or null. */
  update(prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[], opp: { prev: FighterState; next: FighterState } | null = null): AnimOut {
    const cfg = this.cfg;
    this.clock += dt;
    this.wanted.clear();
    this.legitHand = -1;
    if (next.punch.type === null) this.legitPick = null;
    let label = '';
    const lean = { lat: 0, back: 0, fwd: 0 };
    let ik: AnimOut['ik'] = null;
    let aim: AnimOut['aim'] = null;
    let slipClip = false;
    let lunge = { x: 0, z: 0 }, turn = 0;
    const p = next.punch;
    const punching = p.type !== null;

    // ---- events: hits and blocked shots on this man ----
    let hitByEvent = false;
    for (const e of events) {
      if (e.type === 'punchLand' && e.target === this.side) {
        // grade picks the size; a counter or a combination's finisher is one size up
        const g: HitGrade = (e.counter || e.finisher) && e.grade !== 'flush' ? (e.grade === 'glancing' ? 'clean' : 'flush') : e.grade;
        this.startHit(e.part, e.punch, g, 1, 0, false); hitByEvent = true;
      }
      else if (e.type === 'punchBlock' && e.target === this.side) {
        const bh = this.find('block_hit');
        if (bh) this.want('blockhit#' + this.seq, bh, (bh.role.impact ?? bh.role.contact ?? bh.role.from) / bh.clip.fps, { fadeIn: 0.04, upper: true });
        this.jolt = 1;
      }
    }
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
      const kd = this.pick('knockdown');
      const gu = this.pick('getup');
      if (next.getUp.phase === 'rise' && gu) {
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
          const f = same ? ip(geoA!.frame, geoB.frame) : geoB.frame;
          this.want('punch#' + this.punchN, pk, f / gp.clip.fps);
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
          if (w > 0.01) ik = { arm: g.arm, w, at: gl, exact: true, key: this.punchN, pressW: this.pressW };
          // a chained punch with the OTHER arm: the last arm keeps its own tail (it was lost here: a 30 cm pop of the jab hand when the cross started)
          if (this.ikTail && this.ikTail.arm !== g.arm) this.tailOld = { ...this.ikTail };
          if (this.tailOld && this.tailOld.arm === g.arm) this.tailOld = null;
          this.ikTail = { arm: g.arm, gi, w };
        } else {
          const names = mocapRoleNames(this.roles, type, p.hand, low, this.chainedFrom);
          const twin = names[names.length - 1]!;   // the other hand's role: mirrored onto this arm
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
        this.hit = null;   // his own punch overrides the reaction
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
      if (this.hit && !punching) {
        this.hit.t += this.hit.fromState && next.hitT > 0 ? 0 : dt;
        const h = this.hit;
        if (h.t < h.end) {
          this.want('hit#' + h.n, h.pick, h.t, { fadeIn: cfg.humanHitFadeIn, fadeOut: 0.25, target: h.t > h.end - 0.25 ? 0 : 1 });
          label = label || 'hit ' + h.pick.name;
        } else this.hit = null;
      }
      // ---- slip / duck / pull ----
      const s = next.slip;
      if (s.active && !punching) {
        const off = ip(prev.slip.offset, s.offset), dip = ip(prev.slip.dip, s.dip);
        const leftward = s.dir === 2 ? 0 : -off * (this.southpaw ? -1 : 1);   // offset < 0 = toward the lead side
        const name = s.kind === 'roll' || (s.dir !== 2 && dip > 0.06 && Math.abs(off) < 0.05) ? 'duck' : s.dir === 2 ? 'lean_back' : leftward > 0 ? 'slip_left' : 'slip_right';
        const pk = name === 'lean_back' && !cfg.humanLeanBackClip ? null : this.pick(name);   // a missing slip side = the other side mirrored
        if (pk) {
          slipClip = true;
          this.want('slip:' + name + ':' + s.chain, pk, pk.role.from / pk.clip.fps + s.t, { fadeIn: 0.05, fadeOut: 0.15 });
          label = label || name;
        } else {
          lean.lat = leftward; lean.back = s.dir === 2 ? off : 0; lean.fwd = dip;
          label = label || name + ' (procedural)';
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
      if (!this.wanted.has(tr.key)) tr.target = 0;
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
        const wb = tr.upper ? w * this.upperMask[b]! : w;
        if (wb > 1e-3) nlerp(this.pose.rot, b * 4, this.tmp.rot, b * 4, wb, this.pose.rot, b * 4);
      }
      if (!tr.upper) this.pose.hips[1] = lerp(this.pose.hips[1]!, this.tmp.hips[1]!, w);
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

    // A blocked shot: a short flinch back (no block_hit clip, or on top of it).
    if (this.jolt > 0) { lean.back += cfg.humanBlockJolt * this.jolt; this.jolt = Math.max(0, this.jolt - dt / 0.18); }
    // How far the sim's head is down from level / crouch / inside posture / slip dip, m (the view drops the hips by it,
    // feet pinned). A punch's own crouch is in its clip; a slip clip carries its own dip.
    const ipn = (a: number, b: number): number => lerp(a, b, alpha);
    const drop = next.down ? 0 : cfg.humanLevelGain * (ipn(prev.level, next.level) * cfg.levelDrop + ipn(prev.posture, next.posture) * cfg.insideCrouch
      + (punching ? 0 : Math.max(0, ipn(prev.crouch, next.crouch))) + (slipClip || !next.slip.active ? 0 : ipn(prev.slip.dip, next.slip.dip)))
      + cfg.humanSinkGain * Math.max(0, ipn(prev.reaction.sink.x, next.reaction.sink.x));
    if (!slipClip && next.slip.active && !next.down) lean.fwd = 0;   // the dip is now the hips going down, not a bow
    return { pose: this.pose, ik, ik2, aim, lean, drop, label, lunge, turn };
  }
}

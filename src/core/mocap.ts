/**
 * core/mocap.ts — the mocap punch as GEOMETRY (config group mocapGeo). Pure: no three.js, no DOM, no clocks, no
 * Math.random. With cfg.mocapGeo on, the sim's punching glove (the hit sphere) is the glove the drawn mocap boxer
 * shows, and the drawn body takes its lunge and aim from the SAME functions here, so the two cannot disagree.
 *
 *   setMocapLib(buildMocapLib(index, bin, roles, glb))   // once, at startup (main.ts via mocapLoad.ts; Node tests via a loader)
 *   const pick = mocapPunchPick(lib, type, hand, stance, low)
 *   mocapPunchFrame(pick, u, peakAt, tell, maxLeadIn)    // sim punch progress -> clip frame (contact frame ON the hit test)
 *   mocapPunchGeo(lib, cfg, heightM, stance, type, hand, low, u, cockEnd, peakAt, tell, targetY, out)
 *                                                        // glove (aimed, with the lunge) in his own frame + the lunge
 *
 * Frames: everything is in the fighter's own frame at his floor point (sim `pos`): fwd along his facing, up from the
 * floor, lat + = his RIGHT (core/math localToWorld). The drawn body is the boxer.glb model scaled by heightM /
 * humanNativeHeight and stood cfg.humanBackShift behind pos (src/human/view.ts), so the same placement is used here.
 * The clip's horizontal root travel is NOT in the glove: it is the lunge, returned separately (keep × the clip's
 * forward root travel, back to 0 by the clip's punch end) and added to the glove and the body by the caller.
 *
 * The clip's per-frame hand / forearm positions are baked once per punch clip and mirror (applyFit + FK) at
 * buildMocapLib, so a tick costs two frame lerps and no allocation.
 */
import type { Config } from './config';
import type { Hand, PunchType, Stance } from './types';
import { decode, makePose, sample, type BakeIndex, type Clip, type ClipLib, type Role, type Roles } from './mocapClip';
import { applyFit, buildFit, worldPositions, type Fit, type Skeleton } from './mocapFit';

/** A punch clip as the sim plays it: which role / clip, mirrored or not, which arm throws, and its timing frames. */
export interface MocapPick {
  name: string; role: Role; clip: Clip; mirror: boolean;
  /** The throwing arm in the (possibly mirrored) clip: 'Left' = the model's left hand. */
  arm: 'Left' | 'Right';
  /** Clip frames: the role's first frame, the contact frame (the sim's hit test), the end of the punch. */
  fromF: number; contactF: number; endF: number;
  /** Baked rows for this clip + mirror: per frame [LHand xyz, LForeArm xyz, RHand xyz, RForeArm xyz, rootZ], native metres. */
  rows: Float64Array;
}

export interface MocapLib {
  clips: ClipLib;
  roles: Roles;
  fit: Fit;
  /** Baked rows per `${slug}|${mirror ? 1 : 0}`. */
  baked: Map<string, Float64Array>;
  /** Picks per `${type}|${hand}|${stance}|${low}` (built lazily, deterministic: pure functions of the data). */
  picks: Map<string, MocapPick | null>;
}

const ROW = 13;
const PUNCH_ROLES = ['jab', 'cross', 'lead_hook', 'rear_hook', 'lead_uppercut', 'rear_uppercut', 'body_jab', 'body_cross', 'body_hook', 'body_lead_hook', 'body_rear_hook', 'body_uppercut', 'body_lead_uppercut', 'body_rear_uppercut'];

let LIB: MocapLib | null = null;
/** Inject the decoded library (null clears it). The sim reads it only while cfg.mocapGeo is on. */
export function setMocapLib(lib: MocapLib | null): void { LIB = lib; }
export function mocapLib(): MocapLib | null { return LIB; }

/** Our skeleton straight from a .glb (the skin's joints; the Armature node is identity in boxer.glb). */
export function glbSkeleton(glb: ArrayBuffer | Uint8Array): Skeleton {
  const u8 = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(u8.subarray(20, 20 + len))) as { nodes: { name: string; children?: number[]; translation?: number[]; rotation?: number[] }[]; skins: { joints: number[] }[] };
  const joints = json.skins[0]!.joints;
  const parentOf = new Map<number, number>();
  json.nodes.forEach((n, i) => (n.children ?? []).forEach(c => parentOf.set(c, i)));
  return {
    names: joints.map(j => json.nodes[j]!.name),
    parents: joints.map(j => joints.indexOf(parentOf.get(j) ?? -1)),
    restPos: joints.map(j => json.nodes[j]!.translation ?? [0, 0, 0]),
    restRot: joints.map(j => (json.nodes[j]!.rotation ?? [0, 0, 0, 1]) as [number, number, number, number]),
  };
}

/** Decode the baked clips, fit them to boxer.glb's skeleton and bake the punch clips' arm positions. */
export function buildMocapLib(index: BakeIndex, bin: ArrayBuffer, roles: Roles, glb: ArrayBuffer | Uint8Array): MocapLib {
  const clips = decode(index, bin);
  const skel = glbSkeleton(glb);
  const fit = buildFit(index.source, index.bones, index.parents, skel);
  const lib: MocapLib = { clips, roles, fit, baked: new Map(), picks: new Map() };
  const strip = (n: string): string => n.replace(/^mixamorig\d*[:_]?/, '');
  const ours = skel.names.map(strip);
  const bi = ['LeftHand', 'LeftForeArm', 'RightHand', 'RightForeArm'].map(n => ours.indexOf(n));
  const pose = makePose(index.bones.length);
  const h = fit.srcHipHeight * fit.legScale;
  for (const name of [...PUNCH_ROLES, ...Object.keys(roles).filter(k => k.startsWith('combo_'))]) {
    const r = roles[name];
    if (!r || !clips.clips.has(r.slug)) continue;
    const clip = clips.clips.get(r.slug)!;
    for (const mirror of [false, true]) {
      const key = `${clip.slug}|${mirror ? 1 : 0}`;
      if (lib.baked.has(key)) continue;
      const rows = new Float64Array(clip.frames * ROW);
      for (let f = 0; f < clip.frames; f++) {
        sample(clips, clip, f / clip.fps, { mirror }, pose);
        const rootZ = pose.hips[2]! * h;
        pose.hips[0] = 0; pose.hips[2] = 0;   // the drawn body pins the hips over the sim's floor point (anim.ts)
        const wp = worldPositions(fit, applyFit(fit, pose));
        for (let k = 0; k < 4; k++) { const p = wp[bi[k]!]!; rows[f * ROW + k * 3] = p[0]; rows[f * ROW + k * 3 + 1] = p[1]; rows[f * ROW + k * 3 + 2] = p[2]; }
        rows[f * ROW + 12] = rootZ;
      }
      lib.baked.set(key, rows);
    }
  }
  return lib;
}

/** The punch a new punch was chained from (combat.ts: pressed while the last was in flight), or null. */
export interface ChainedFrom { type: PunchType; hand: Hand }

const baseRole = (type: PunchType, hand: Hand): string => (type === 'jab' ? 'jab' : type === 'cross' ? 'cross' : `${hand}_${type}`);

/**
 * THE clip choice for a punch: the ordered role names to try, one pure function of sim state. The sim's glove
 * (mocapPunchPick, below) and the drawn body (src/human/anim.ts) both go through it, so they cannot disagree:
 *   1. a two-punch combination clip when this punch was chained from the one before (combo_<first>_<this>, tools/mocap),
 *   2. the body version when the punch goes low (body_<role>, body_<type>),
 *   3. the punch's own role, 4. its other-hand twin (the caller mirrors it onto the right arm).
 */
export function mocapRoleNames(roles: Roles, type: PunchType, hand: Hand, low: boolean, chainedFrom: ChainedFrom | null): string[] {
  const base = baseRole(type, hand);
  const twin = type === 'jab' ? 'cross' : type === 'cross' ? 'jab' : `${hand === 'lead' ? 'rear' : 'lead'}_${type}`;
  const out: string[] = [];
  // (a combination authored to the BODY is not used for a head punch: its second hand comes in low and the height aim
  //  then lifts it straight up — "a really weird animation upwards"; the head-height single clip reads right)
  if (chainedFrom) { const c = `combo_${baseRole(chainedFrom.type, chainedFrom.hand)}_${base}`; const r = roles[c] as (Role & { body?: boolean }) | null | undefined; if (r && !!r.body === low) out.push(c); }
  // A head punch whose own role is a BODY-height clip (roles.json body: true; the rear uppercut's only clip ends 61 cm
  // short of the head) takes its other-hand twin, mirrored, first: mirroring is exact, stretching a clip is not.
  const ownBody = !!(roles[base] as (Role & { body?: boolean }) | null | undefined)?.body;
  const twinHead = !!roles[twin] && !(roles[twin] as Role & { body?: boolean }).body;
  out.push(...(low ? [`body_${base}`, `body_${type}`, base, twin] : ownBody && twinHead ? [twin, base] : [base, twin]));
  return out;
}

/** The other hand's role for a punch (a clip found under it is mirrored onto this arm). */
export const mocapTwinRole = (type: PunchType, hand: Hand): string => (type === 'jab' ? 'cross' : type === 'cross' ? 'jab' : `${hand === 'lead' ? 'rear' : 'lead'}_${type}`);

const PUNCH_CODES: PunchType[] = ['jab', 'cross', 'hook', 'uppercut'];
/** A punch as a number (moveHist; 0 = none) and back. */
export const punchCode = (type: PunchType, hand: Hand): number => PUNCH_CODES.indexOf(type) * 2 + (hand === 'lead' ? 0 : 1) + 1;
export const punchOfCode = (c: number): ChainedFrom | null => (c >= 1 && c <= 8 ? { type: PUNCH_CODES[Math.floor((c - 1) / 2)]!, hand: (c - 1) % 2 === 0 ? 'lead' : 'rear' } : null);

/**
 * The clip a punch plays (roles from mocapRoleNames); mirrored so the clip's punching arm is the sim's punching hand
 * (orthodox lead = the model's left), which also covers a southpaw and a lead-hand clip standing in for a rear-hand role.
 */
export function mocapPunchPick(lib: MocapLib, type: PunchType, hand: Hand, stance: Stance, low: boolean, chainedFrom: ChainedFrom | null = null): MocapPick | null {
  const key = `${type}|${hand}|${stance}|${low ? 1 : 0}|${chainedFrom ? punchCode(chainedFrom.type, chainedFrom.hand) : 0}`;
  const hit = lib.picks.get(key);
  if (hit !== undefined) return hit;
  const lead = hand === 'lead';
  const names = mocapRoleNames(lib.roles, type, hand, low, chainedFrom);
  let out: MocapPick | null = null;
  for (const name of names) {
    const r = lib.roles[name];
    if (!r || !lib.clips.clips.has(r.slug)) continue;
    const clip = lib.clips.clips.get(r.slug)!;
    const mark = clip.punches.find(m => (r.contact !== undefined ? m.from <= r.contact && r.contact <= m.to + 2 : true));
    const roleContact = r.contact ?? mark?.peak ?? (r.from + r.to) / 2;
    // which arm throws in the clip as authored: its punch mark, else by the role name (an orthodox clip: lead = left)
    const clipSide: 'Left' | 'Right' = mark ? mark.side : /^(body_)?(jab|lead_)/.test(name) ? 'Left' : 'Right';
    const want: 'Left' | 'Right' = lead === (stance === 'orthodox') ? 'Left' : 'Right';
    const mirror = clipSide !== want;
    const rows = lib.baked.get(`${clip.slug}|${mirror ? 1 : 0}`);
    if (!rows) continue;
    // The recovery runs to the punch mark's end, but never shorter than MIN_RECOVER frames (a cut segment that ends a
    // few frames after contact held the fist out through the whole sim recovery: "the hand just stays there").
    const last = clip.frames - 1;
    const endRole = Math.min(last, Math.max(mark && mark.to > roleContact ? mark.to : roleContact + 1.5 * (roleContact - r.from), roleContact + MIN_RECOVER));
    const p: MocapPick = { name, role: r, clip, mirror, arm: want, fromF: r.from, contactF: roleContact, endF: endRole, rows };
    // the contact search never starts in the first half of the lead-in (a combination entered late had its contact
    // found ON its entry frame: the whole wind-up was one frozen pose, lifted straight up by the aim)
    p.contactF = geometricContact(p, Math.max(r.from + 0.5 * (roleContact - r.from), roleContact - CONTACT_EARLY), Math.min(r.to, roleContact + CONTACT_LATE));
    p.endF = Math.max(endRole, p.contactF + MIN_RECOVER);
    out = p;
    break;
  }
  lib.picks.set(key, out);
  return out;
}

/**
 * Sim punch progress u (0..1) -> clip frame. Piecewise: [startF .. contactF] over [0 .. peakAt], [contactF .. endF]
 * over [peakAt .. 1], so the contact frame is ON the sim's hit-test tick (`punch.tell` after the press) and the clip's
 * punch ends with the sim's. A lead-in longer than maxLeadIn × tell (cfg.humanMaxLeadIn) starts later in the clip.
 * (Ported from src/human/anim.ts; the drawn side should call this one.)
 */
export function mocapPunchFrame(pick: MocapPick, u: number, peakAt: number, tell: number, maxLeadIn: number): number {
  return frameAt(pick, u, peakAt, startFrame(pick, tell, maxLeadIn));
}
function startFrame(pick: MocapPick, tell: number, maxLeadIn: number): number {
  const maxLead = maxLeadIn * Math.max(0.05, tell) * pick.clip.fps;
  return pick.contactF - pick.fromF > maxLead ? pick.contactF - maxLead : pick.fromF;
}
function frameAt(pick: MocapPick, u: number, peakAt: number, startF: number): number {
  const peak = Math.max(1e-6, peakAt);
  return u <= peak ? startF + (u / peak) * (pick.contactF - startF) : pick.contactF + ((u - peak) / Math.max(1e-6, 1 - peak)) * (pick.endF - pick.contactF);
}

/** Result of mocapPunchGeo, reused by the caller (no allocation per tick). Glove = centre of the glove's hit sphere. */
export interface MocapPunchGeo {
  ok: boolean;
  /** The clip played (null when !ok). */
  pick: MocapPick | null;
  frame: number;
  /** The glove, aimed, lunge included: his own frame (fwd, up, lat + = his right), m from his floor point. */
  fwd: number; up: number; lat: number;
  /** The glove's height before the aim (the clip's own), m. */
  rawUp: number;
  /** The body offset along his facing this tick, m (keep × the clip's forward root travel, 0 at both ends). */
  lunge: number;
  /** The aim's height correction at contact (clamped) and its weight this tick (0 at the press, 1 at contact). */
  aimDy: number; aimW: number;
  /** The body turn at contact that puts the glove on his centre line (rad, + = toward his right = facing yaw increasing, clamped), and this tick's share of it (turnAt × aimW). The drawn body turns by `turn` about its own origin. */
  turnAt: number; turn: number;
  arm: 'Left' | 'Right';
}
export function makeMocapGeo(): MocapPunchGeo { return { ok: false, pick: null, frame: 0, fwd: 0, up: 0, lat: 0, rawUp: 0, lunge: 0, aimDy: 0, aimW: 0, turnAt: 0, turn: 0, arm: 'Left' }; }

const smooth01 = (x: number): number => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

/** Interpolated row value c of frame f (fractional), clamped to the clip. */
function rowAt(rows: Float64Array, frames: number, f: number, c: number): number {
  const ff = f < 0 ? 0 : f > frames - 1 ? frames - 1 : f;
  const f0 = Math.floor(ff), f1 = Math.min(frames - 1, f0 + 1), w = ff - f0;
  return rows[f0 * ROW + c]! * (1 - w) + rows[f1 * ROW + c]! * w;
}

/** The glove centre in the model's native space at frame f: the wrist plus gloveOff (native m) along the forearm. */
function gloveNative(pick: MocapPick, f: number, gloveOff: number, o: { x: number; y: number; z: number }): void {
  const base = pick.arm === 'Left' ? 0 : 6, n = pick.clip.frames;
  const hx = rowAt(pick.rows, n, f, base), hy = rowAt(pick.rows, n, f, base + 1), hz = rowAt(pick.rows, n, f, base + 2);
  const ex = hx - rowAt(pick.rows, n, f, base + 3), ey = hy - rowAt(pick.rows, n, f, base + 4), ez = hz - rowAt(pick.rows, n, f, base + 5);
  const l = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
  o.x = hx + ex / l * gloveOff; o.y = hy + ey / l * gloveOff; o.z = hz + ez / l * gloveOff;
}
const G = { x: 0, y: 0, z: 0 };

/**
 * The frame the glove meets a target straight ahead: roles.json's contact is "full extension", which for the hooks
 * is the follow-through (the lead hook's glove is 32 cm past the centre line there; it crossed it 10 frames before).
 * Among whole frames from CONTACT_EARLY before the role's contact to CONTACT_LATE after it (the lead hook crosses the
 * line 10 frames before its role contact, the body hook 7 after), the furthest-forward glove (wrist +
 * 7 cm, root travel included) within CONTACT_LAT of his centre line; if none is near the line once the fist is out (a
 * wide rear hook), the frame nearest the line among those at least 60% of the way out. Native units; uniform scale
 * does not change the choice. (Data shape, not tunables: they pick a frame from the clip.)
 */
const CONTACT_LAT = 0.12, CONTACT_EARLY = 12, CONTACT_LATE = 8, MIN_RECOVER = 14;
function geometricContact(p: MocapPick, from: number, end: number): number {
  const z0 = p.rows[Math.round(from) * ROW + 12]!;
  const fwdAt = (f: number): number => { gloveNative(p, f, 0.07, G); return G.z + p.rows[f * ROW + 12]! - z0; };
  let maxF = -Infinity;
  for (let f = Math.ceil(from); f <= end; f++) maxF = Math.max(maxF, fwdAt(f));
  let best = -1, bestFwd = -Infinity, near = -1, nearLat = Infinity;
  for (let f = Math.ceil(from); f <= end; f++) {
    const fw = fwdAt(f), lat = Math.abs(G.x);
    if (fw < 0.6 * maxF) continue;
    if (lat <= CONTACT_LAT && fw > bestFwd) { best = f; bestFwd = fw; }
    if (lat < nearLat) { near = f; nearLat = lat; }
  }
  return best >= 0 ? best : near >= 0 ? near : (from + end) / 2;
}

/**
 * The mocap punch this tick, for a fighter `heightM` tall. `u` = punch progress, cockEnd / peakAt = the sim's
 * punch phases (punchPhases), tell = punch.tell. targetY = the height (m, from the floor) the glove is steered to
 * at contact (the opponent's head or body), or null for no aim. Writes `out` and returns it; out.ok = false when
 * no clip exists for this punch.
 */
export function mocapPunchGeo(lib: MocapLib, cfg: Config, heightM: number, stance: Stance, type: PunchType, hand: Hand, low: boolean,
  u: number, cockEnd: number, peakAt: number, tell: number, targetY: number | null, selfY: number | null, out: MocapPunchGeo, chainedFrom: ChainedFrom | null = null,
  reachTo: number | null = null): MocapPunchGeo {
  const pick = mocapPunchPick(lib, type, hand, stance, low, chainedFrom);
  out.pick = pick;
  if (!pick) { out.ok = false; out.lunge = 0; return out; }
  const s = heightM / cfg.humanNativeHeight;
  const startF = startFrame(pick, tell, cfg.humanMaxLeadIn);
  const f = frameAt(pick, u, peakAt, startF);
  const gloveOff = cfg.humanGloveOffset / s;
  // model axes: x = his left, y up, z forward
  out.ok = true; out.frame = f; out.arm = pick.arm;
  // the lunge: keep × the clip's forward root travel since the start frame, faded back to 0 by the end frame
  const n = pick.clip.frames, z0 = rowAt(pick.rows, n, startF, 12), zEnd = rowAt(pick.rows, n, pick.endF, 12);
  const lungeAt = (ff: number): number => {
    const back = pick.endF > pick.contactF ? smooth01((ff - pick.contactF) / (pick.endF - pick.contactF)) : (ff >= pick.endF ? 1 : 0);
    return cfg.mocapLungeKeep * ((rowAt(pick.rows, n, ff, 12) - z0) - (zEnd - z0) * back) * s;
  };
  // THE FIT to the distance (reachTo = the glove centre's forward distance at the target's surface, or null): two
  // constants for the whole punch, so the path stays one smooth curve that starts and ends where the clip's does —
  // k scales the lunge (first), r the arm's forward travel from its start frame (only if the lunge alone is not enough).
  gloveNative(pick, startF, gloveOff, G); const fwd0 = G.z * s - cfg.humanBackShift;
  let k = 1, r = 1;
  if (reachTo !== null) {
    gloveNative(pick, pick.contactF, gloveOff, G);
    const fwdC = G.z * s - cfg.humanBackShift, lC = lungeAt(pick.contactF);
    if (fwdC + Math.max(0, lC) > reachTo) {
      if (lC > 1e-4) k = Math.max(0, Math.min(1, (reachTo - fwdC) / lC));
      const over = fwdC + Math.max(0, lC) * k - reachTo;
      if (over > 0 && fwdC - fwd0 > 0.05) r = Math.max(cfg.mocapReachFitMin, (fwdC - fwd0 - over) / (fwdC - fwd0));
    }
  }
  gloveNative(pick, f, gloveOff, G);
  out.fwd = fwd0 + (G.z * s - cfg.humanBackShift - fwd0) * r; out.rawUp = G.y * s; out.lat = -G.x * s;
  out.lunge = lungeAt(f) * k;
  out.fwd += out.lunge;
  // Aim, in over the extension and out over the recovery. HEIGHT: the clip's glove height AT CONTACT goes to the
  // thrower's OWN lane (selfY: the same lane on a man his height; a body clip thrown at the head is lifted all the
  // way, as the drawn aim lift does), plus the opponent's difference (targetY − selfY) clamped to ±mocapAimMax.
  // ACROSS: the contact glove is pulled toward his centre line by at most mocapLatMax (a wide rear hook).
  // ACROSS: the whole body TURNS (about the drawn body's origin) so the contact glove lies on his centre line — the
  // clips' contacts sit 0-35 cm to one side (a body jab authored turned, a wide rear hook) — by at most mocapTurnMaxDeg.
  if (targetY !== null && selfY !== null) {
    gloveNative(pick, pick.contactF, gloveOff, G);
    const diff = targetY - selfY;
    const m = cfg.mocapAimMax;
    out.aimDy = selfY - G.y * s + (diff > m ? m : diff < -m ? -m : diff);
    const tm = cfg.mocapTurnMaxDeg * Math.PI / 180, a = Math.atan2(-G.x, G.z);   // + = the glove on his right: turn right
    out.turnAt = a > tm ? tm : a < -tm ? -tm : a;
    out.aimW = u <= peakAt ? smooth01((u - cockEnd) / Math.max(1e-6, peakAt - cockEnd)) : smooth01(1 - (u - peakAt) / Math.max(1e-6, 1 - peakAt));
  } else { out.aimDy = 0; out.turnAt = 0; out.aimW = 0; }
  out.up = out.rawUp + out.aimDy * out.aimW;
  out.turn = out.turnAt * out.aimW;
  if (out.turn !== 0) {
    // rotate the glove about the drawn origin (pos + (lunge − backShift) along the facing): turning right (+) moves a point on his right toward the line
    const o = out.lunge - cfg.humanBackShift, gz = out.fwd - o, gl = out.lat, c = Math.cos(out.turn), sn = Math.sin(out.turn);
    out.fwd = o + gz * c + gl * sn;
    out.lat = -gz * sn + gl * c;
  }
  return out;
}

/**
 * THE MOCAP BODY at rest, measured once from the baked clips (the drawn fighter's own shape): the mean over the idle
 * role's loop of the head centre, chest (Spine2), hips and the two glove centres, and the two glove centres at the block
 * role's hold frame. Native model space (x = his LEFT, y up, z forward; hips pinned over the floor point as drawn),
 * orthodox (the clips' own stance; mirror x and swap hands for a southpaw). headR = the drawn head's radius (half
 * Head -> HeadTop_End), or null when the skeleton has no head-top joint. Cached on the lib.
 */
export type V3 = [number, number, number];
export interface MocapRest { head: V3; headR: number | null; chest: V3; hips: V3; guard: [V3, V3]; block: [V3, V3] }
const REST = new WeakMap<MocapLib, MocapRest | null>();
export function mocapRest(lib: MocapLib, gloveOffNative: number): MocapRest | null {
  if (REST.has(lib)) return REST.get(lib)!;
  const names = lib.fit.skel.names.map(n => n.replace(/^mixamorig\d*[:_]?/, ''));
  const ix = (n: string): number => names.indexOf(n);
  const J = { head: ix('Head'), top: ix('HeadTop_End'), chest: ix('Spine2'), hips: ix('Hips'), lh: ix('LeftHand'), lf: ix('LeftForeArm'), rh: ix('RightHand'), rf: ix('RightForeArm') };
  const idle = lib.roles['idle'], block = lib.roles['block'];
  if (!idle || !lib.clips.clips.has(idle.slug) || J.head < 0 || J.lh < 0 || J.rh < 0) { REST.set(lib, null); return null; }
  const pose = makePose(lib.clips.bones.length);
  const at = (clip: Clip, f: number): Vec3s => {
    sample(lib.clips, clip, f / clip.fps, { mirror: false }, pose);
    pose.hips[0] = 0; pose.hips[2] = 0;
    return worldPositions(lib.fit, applyFit(lib.fit, pose));
  };
  const glove = (wp: Vec3s, h: number, e: number): V3 => {
    const a = wp[h]!, b = wp[e]!, d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]], l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    return [a[0] + d[0]! / l * gloveOffNative, a[1] + d[1]! / l * gloveOffNative, a[2] + d[2]! / l * gloveOffNative];
  };
  const acc = { head: [0, 0, 0], chest: [0, 0, 0], hips: [0, 0, 0], gl: [0, 0, 0], gr: [0, 0, 0], r: 0 };
  const add = (s: number[], v: readonly number[]): void => { s[0]! += v[0]!; s[1]! += v[1]!; s[2]! += v[2]!; };
  const ic = lib.clips.clips.get(idle.slug)!;
  let n = 0;
  for (let f = idle.from; f <= idle.to; f += 2, n++) {
    const wp = at(ic, f);
    const h = wp[J.head]!, top = J.top >= 0 ? wp[J.top]! : null;
    add(acc.head, top ? [(h[0] + top[0]) / 2, (h[1] + top[1]) / 2, (h[2] + top[2]) / 2] : [h[0], h[1] + 0.09, h[2]]);
    if (top) acc.r += Math.hypot(top[0] - h[0], top[1] - h[1], top[2] - h[2]) / 2;
    add(acc.chest, wp[J.chest]!); add(acc.hips, wp[J.hips]!);
    add(acc.gl, glove(wp, J.lh, J.lf)); add(acc.gr, glove(wp, J.rh, J.rf));
  }
  const mean = (s: number[]): V3 => [s[0]! / n, s[1]! / n, s[2]! / n];
  const guard: [V3, V3] = [mean(acc.gl), mean(acc.gr)];
  let blk: [V3, V3] = guard;
  if (block && lib.clips.clips.has(block.slug)) {
    const bc = lib.clips.clips.get(block.slug)!, wp = at(bc, block.contact ?? block.to);
    blk = [glove(wp, J.lh, J.lf), glove(wp, J.rh, J.rf)];
  }
  const out: MocapRest = { head: mean(acc.head), headR: J.top >= 0 ? acc.r / n : null, chest: mean(acc.chest), hips: mean(acc.hips), guard, block: blk };
  REST.set(lib, out);
  return out;
}
type Vec3s = ReturnType<typeof worldPositions>;

/**
 * OUTCOME FIRST (cfg.mocapOutcome): where the DRAWN body's head and torso are for a fighter in this sim state, world m.
 * The drawn idle's mean head / hips / chest (mocapRest, scaled to his height, stood humanBackShift behind `pos` as the
 * view stands him) plus how far the sim's own head sphere / body capsule has moved off its standing place (slip, level,
 * reaction, sink), so a slipped or rocked head is where the picture has it. Radii are config (the drawn mesh, measured).
 * Without the library: the sim's own boxes. Pure; writes `out`.
 */
export interface DrawnTargets { head: { x: number; y: number; z: number }; headR: number; torsoA: { x: number; y: number; z: number }; torsoB: { x: number; y: number; z: number }; torsoR: number }
export function makeDrawnTargets(): DrawnTargets { return { head: { x: 0, y: 0, z: 0 }, headR: 0.1, torsoA: { x: 0, y: 0, z: 0 }, torsoB: { x: 0, y: 0, z: 0 }, torsoR: 0.15 }; }
interface TargetState {
  pos: { x: number; z: number }; yaw: number; stance: Stance;
  body: { heightM: number; headY: number; hipY: number; shoulderY: number };
  headBox: { x: number; y: number; z: number }; bodyBox: { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number } };
}
export function mocapDrawnTargets(lib: MocapLib | null, cfg: Config, f: TargetState, guardCrouch: number, out: DrawnTargets): DrawnTargets {
  const k = f.body.heightM / cfg.mocapBandRefHeight;
  out.headR = cfg.mocapHeadR * k; out.torsoR = cfg.mocapTorsoR * k;
  const rest = lib ? mocapRest(lib, cfg.humanGloveOffset * cfg.humanNativeHeight / f.body.heightM) : null;
  const c = Math.cos(f.yaw), sn = Math.sin(f.yaw);   // fwd = (c, sn), right = (-sn, c) (core/math frameOf)
  const at = (o: { x: number; y: number; z: number }, fwd: number, up: number, lat: number): void => {
    o.x = f.pos.x + c * fwd - sn * lat; o.y = up; o.z = f.pos.z + sn * fwd + c * lat;
  };
  if (!rest) {
    out.head.x = f.headBox.x; out.head.y = f.headBox.y; out.head.z = f.headBox.z;
    out.torsoA.x = f.bodyBox.a.x; out.torsoA.y = f.bodyBox.a.y; out.torsoA.z = f.bodyBox.a.z;
    out.torsoB.x = f.bodyBox.b.x; out.torsoB.y = f.bodyBox.b.y; out.torsoB.z = f.bodyBox.b.z;
    return out;
  }
  const s = f.body.heightM / cfg.humanNativeHeight, mir = f.stance === 'southpaw' ? 1 : -1, back = cfg.humanBackShift;
  // the sim's boxes off their standing place (the guard's constant crouch is the sim's own; the drawn idle has its own)
  const nom = { x: 0, y: 0, z: 0 };
  at(nom, 0, f.body.headY - guardCrouch, 0);
  const dhx = f.headBox.x - nom.x, dhy = f.headBox.y - nom.y, dhz = f.headBox.z - nom.z;
  at(out.head, rest.head[2] * s - back + cfg.mocapHeadFwd * k, rest.head[1] * s, rest.head[0] * s * mir);
  out.head.x += dhx; out.head.y += dhy; out.head.z += dhz;
  at(nom, 0, f.body.shoulderY - guardCrouch, 0);
  const dbx = f.bodyBox.b.x - nom.x, dby = f.bodyBox.b.y - nom.y, dbz = f.bodyBox.b.z - nom.z;
  at(nom, 0, f.body.hipY - guardCrouch, 0);
  const dax = f.bodyBox.a.x - nom.x, day = f.bodyBox.a.y - nom.y, daz = f.bodyBox.a.z - nom.z;
  const fw = cfg.mocapTorsoFwd * k;
  at(out.torsoA, rest.hips[2] * s - back + fw, rest.hips[1] * s, rest.hips[0] * s * mir);
  out.torsoA.x += dax; out.torsoA.y += day; out.torsoA.z += daz;
  at(out.torsoB, rest.chest[2] * s - back + fw, rest.chest[1] * s, rest.chest[0] * s * mir);
  out.torsoB.x += dbx; out.torsoB.y += dby; out.torsoB.z += dbz;
  return out;
}

/**
 * The clip's OWN glove at frame f (fractional), his frame (fwd, up, lat + = his right), m, for a man heightM tall: no
 * aim, no lunge, no turn. Measurement helper (the audit's legitimate per-tick hand speed = this glove's displacement
 * between the frames two ticks draw).
 */
export function mocapClipGlove(pick: MocapPick, f: number, cfg: Config, heightM: number, o: { x: number; y: number; z: number }): void {
  const s = heightM / cfg.humanNativeHeight;
  gloveNative(pick, f, cfg.humanGloveOffset / s, o);
  o.x *= s; o.y *= s; o.z *= s;
}

/** The native-space height of a clip's glove at its contact frame × s, and its forward reach there (measurement helper). */
export function mocapContactGlove(lib: MocapLib, cfg: Config, heightM: number, stance: Stance, type: PunchType, hand: Hand, low: boolean): { fwd: number; up: number; lat: number; lunge: number } | null {
  const pick = mocapPunchPick(lib, type, hand, stance, low);
  if (!pick) return null;
  const o = makeMocapGeo();
  // u = peakAt with any phases: the frame is the contact frame by construction
  mocapPunchGeo(lib, cfg, heightM, stance, type, hand, low, 0.5, 0.25, 0.5, 10, null, null, o);
  return { fwd: o.fwd, up: o.up, lat: o.lat, lunge: o.lunge };
}

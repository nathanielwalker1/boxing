/**
 * ui/referee.ts — the third man in the ring (Stage 3). Presentation only: he
 * is never in the sim. Each frame he reads the sim state and walks a
 * FighterState of his own (REFEREE spec, same rig, dressed) that the rig draws:
 *
 *   fighting  — keeps refStandoff off the fighters' midpoint on the far side
 *               from the camera (at the ropes), and backs away from any
 *               fighter nearer than refClear, so he is never in an exchange
 *   count / KO / TKO — walks to refCountDist from the downed fighter, square to
 *               the fall line, and stands (no counting gesture: "weird", 2026-10-15)
 *   over, decision — stands between them and raises the arm on the winner's side
 *   between   — walks off to the far rope
 *
 * No hitbox: he keeps out of the fighters' way instead (refClear). Config
 * group `referee`. Time comes from the host (slowed with the knockdown).
 */
import type * as THREE from 'three';
import {
  REFEREE, RING_HALF, armFlareTarget, frameOf, handLateralSign, localToWorld, restFighterState, solveArm,
  type Config, type FighterState, type FighterView, type Hand, type SimEvent, type SimState, type Vec2, type Vec3,
} from '../core';
import { createFighterView } from '../rig';
import { createRefereeBody, preloadReferee, refereeReady, type RefCue, type RefereeBody } from '../human/referee';

type Gesture = 'hang' | 'point' | 'wave';
interface HandLocal { fwd: number; up: number; lat: number }

declare global {
  interface Window {
    /** What the referee's hands are doing (checks): 'hang', 'point' (the winner's arm up) or 'wave' (waving a KO off), and both hands' heights, m. */
    __refGesture?: () => { gesture: string; hands: [number, number]; lat: [number, number] } | null;
  }
}

export class Referee {
  private view: FighterView | null = null;
  /** The Meshy man (human mode, refMeshy); meshyOk goes false if his file fails to load, and the old rig draws. */
  private body: RefereeBody | null = null;
  private meshyOk = true;
  private cue: RefCue = { mode: 'watch', close: 0, look: null, nod: 0 };
  private nodCool = 0;
  /** Which way round from behind the fighters he stands in the round (+1 / -1; refSideDeg). */
  private side = 1;
  private state: FighterState;
  private vel: Vec2 = { x: 0, z: 0 };
  private hands: [HandLocal, HandLocal];
  private tWalk = 0;
  private winner: 0 | 1 | null = null;
  private method: 'ko' | 'tko' | 'decision' | null = null;
  private waveT = -1;            // seconds since a KO was waved off (ko.waved), else -1
  private gesture: Gesture = 'hang';

  constructor(private cfg: Config, private scene: THREE.Object3D) {
    this.state = restFighterState(REFEREE, cfg, { x: 0, z: -2.2 }, Math.PI / 2);
    this.hands = [this.hangPose('lead'), this.hangPose('rear')];
    window.__refGesture = () => this.view || this.body ? { gesture: this.gesture, hands: [this.hands[0].up, this.hands[1].up], lat: [this.hands[0].lat, this.hands[1].lat] } : null;
  }

  /** The hands by the hips, a little out from the thighs. */
  private hangPose(hand: Hand): HandLocal {
    const b = this.state.body;
    return { fwd: 0.06, up: b.hipY + 0.02, lat: handLateralSign(hand, REFEREE.stance) * (b.shoulderW / 2 + 0.05) };
  }

  /** `snap`: put him on his spot, facing what he watches, instead of walking there (a cut to a new scene). */
  update(s: SimState, events: readonly SimEvent[], dt: number, camAz: number, visible: boolean, snap = false): void {
    if (!visible) { this.dispose(); return; }
    const c = this.cfg, me = this.state, b = me.body;
    for (const e of events) {
      if (e.type === 'ko' || e.type === 'tko') {
        this.method = e.type; this.winner = e.winner;
        // He was out before he landed: no count — the referee waves it off (polish phase).
        if (e.type === 'ko' && e.waved === true && c.refWaveOffOn) this.waveT = 0;
      }
      else if (e.type === 'decision') { this.method = 'decision'; this.winner = e.winner; }
      else if (e.type === 'roundStart') { this.method = null; this.winner = null; this.waveT = -1; }
      // the Meshy man nods at a moment worth acknowledging: a clean counter, a man rocked, a guard broken
      else if ((e.type === 'counter' || e.type === 'rocked' || e.type === 'guardBreak') && this.nodCool <= 0) { this.cue.nod++; this.nodCool = c.refNodCooldown; }
    }
    if (s.tick === 0) { this.method = null; this.winner = null; this.waveT = -1; }
    if (this.waveT >= 0) this.waveT += dt;
    this.nodCool -= dt;

    // ── Where to stand, what to face, what to do with the hands ──
    const a = s.fighters[0].pos, f1 = s.fighters[1].pos;
    const mid = { x: (a.x + f1.x) / 2, z: (a.z + f1.z) / 2 };
    const cam = { x: Math.cos(camAz), z: Math.sin(camAz) };   // from the look point toward the lens, on the floor
    const bound = RING_HALF - c.ringInset - 0.1;
    const downSide: 0 | 1 | null = s.fighters[0].down ? 0 : s.fighters[1].down ? 1 : null;
    const ph = s.round.phase;
    let target: Vec2, face: Vec2, gesture: Gesture = 'hang';
    if (downSide !== null && (ph === 'count' || ph === 'over')) {
      const p = s.fighters[downSide].pos, q = s.fighters[downSide === 0 ? 1 : 0].pos;
      // Beside the fallen man: the body lies along the line away from the
      // puncher (the rig's fall line), so he stands square to that line, on
      // the far side from the lens so he never covers the man on the canvas.
      let lx = p.x - q.x, lz = p.z - q.z;
      const len = Math.hypot(lx, lz) || 1;
      lx /= len; lz /= len;
      let dx = -lz, dz = lx;
      if (dx * cam.x + dz * cam.z > 0) { dx = -dx; dz = -dz; }
      target = { x: p.x + dx * c.refCountDist, z: p.z + dz * c.refCountDist };
      face = p;
      if (this.waveT >= 0 && this.waveT < c.refWaveSeconds) gesture = 'wave';   // on his way over, arms crossing over his head: it is over
    } else if (ph === 'over') {
      target = mid;
      face = { x: mid.x + cam.x, z: mid.z + cam.z };   // to the camera, the card in hand
      gesture = this.winner !== null ? 'point' : 'hang';
    } else if (ph === 'between') {
      target = { x: -cam.x * (bound - 0.4), z: -cam.z * (bound - 0.4) };
      face = { x: 0, z: 0 };
    } else {
      // The round: off the midpoint on the far side, perpendicular to the fighters' line.
      let nx = -(f1.z - a.z), nz = f1.x - a.x;
      const nl = Math.hypot(nx, nz);
      if (nl < 1e-3) { nx = -cam.x; nz = -cam.z; } else { nx /= nl; nz /= nl; }
      if (nx * cam.x + nz * cam.z > 0) { nx = -nx; nz = -nz; }
      // ...turned refSideDeg round from straight behind them: the follow camera sits side-on to the fighters' line, so
      // "far side, perpendicular" was dead behind the pair from the lens and they hid him the whole fight (2026-11-25).
      // The side with more room inside the ropes, kept unless the other is clearly roomier (no flip-flopping).
      const sd = c.refSideDeg * Math.PI / 180;
      const at = (sg: number): Vec2 => {
        const cs = Math.cos(sg * sd), sn = Math.sin(sg * sd);
        return { x: mid.x + (nx * cs - nz * sn) * c.refStandoff, z: mid.z + (nx * sn + nz * cs) * c.refStandoff };
      };
      const room = (p: Vec2): number => Math.min(bound - Math.abs(p.x), bound - Math.abs(p.z));
      if (room(at(-this.side)) > room(at(this.side)) + 0.5) this.side = -this.side;
      target = at(this.side);
      face = mid;
    }
    target.x = Math.max(-bound, Math.min(bound, target.x));
    target.z = Math.max(-bound, Math.min(bound, target.z));

    if (snap) { me.pos = { x: target.x, z: target.z }; this.vel = { x: 0, z: 0 }; me.yaw = Math.atan2(face.z - target.z, face.x - target.x); }
    // ── Walk: velocity chases the target (dead zone so he stands still) ──
    const toX = target.x - me.pos.x, toZ = target.z - me.pos.z;
    const toLen = Math.hypot(toX, toZ);
    let wantX = 0, wantZ = 0;
    if (toLen > 0.08) { const sp = Math.min(c.refWalkSpeed, toLen * 2.5); wantX = toX / toLen * sp; wantZ = toZ / toLen * sp; }
    // Keep out of their way: a fighter inside refClear pushes him straight
    // back, harder the closer — he has no body, so he gives ground instead.
    for (const f of s.fighters) {
      const ax = me.pos.x - f.pos.x, az = me.pos.z - f.pos.z;
      const dd = Math.hypot(ax, az);
      if (dd < c.refClear && dd > 1e-3) {
        const push = c.refWalkSpeed * 1.5 * (1 - dd / c.refClear);
        wantX += ax / dd * push; wantZ += az / dd * push;
      }
    }
    const k = 1 - Math.exp(-c.refAccel * dt);
    this.vel.x += (wantX - this.vel.x) * k;
    this.vel.z += (wantZ - this.vel.z) * k;
    // The ropes stop him too: the push away from a fighter could shove him
    // through them when only the target was clamped (2026-10-15).
    const nx = Math.max(-bound, Math.min(bound, me.pos.x + this.vel.x * dt));
    const nz = Math.max(-bound, Math.min(bound, me.pos.z + this.vel.z * dt));
    if (nx !== me.pos.x + this.vel.x * dt) this.vel.x = 0;
    if (nz !== me.pos.z + this.vel.z * dt) this.vel.z = 0;
    me.pos = { x: nx, z: nz };
    me.vel = { x: this.vel.x, z: this.vel.z };
    this.tWalk += dt;
    // Face what he watches; a long walk faces the way he goes.
    const walking = Math.hypot(this.vel.x, this.vel.z) > 0.5 && toLen > 0.6;
    const fx = walking ? this.vel.x : face.x - me.pos.x, fz = walking ? this.vel.z : face.z - me.pos.z;
    if (fx * fx + fz * fz > 1e-6) {
      const want = Math.atan2(fz, fx);
      let d = Math.atan2(Math.sin(want - me.yaw), Math.cos(want - me.yaw));
      const maxTurn = c.refTurnRate * dt;
      d = Math.max(-maxTurn, Math.min(maxTurn, d));
      me.yaw += d;
    }

    // ── Hands: authored local poses, chased ──
    const fr = frameOf(me.yaw);
    const want: [HandLocal, HandLocal] = [this.hangPose('lead'), this.hangPose('rear')];
    if (gesture === 'point' && this.winner !== null) {
      // The arm on the winner's side goes straight up.
      const w = s.fighters[this.winner].pos;
      const latW = (w.x - me.pos.x) * fr.right.x + (w.z - me.pos.z) * fr.right.z;
      const i: 0 | 1 = Math.sign(latW || 1) === handLateralSign('lead', REFEREE.stance) ? 0 : 1;
      want[i] = { fwd: 0.08, up: b.headY + 0.46, lat: handLateralSign(i === 0 ? 'lead' : 'rear', REFEREE.stance) * 0.1 };
    } else if (gesture === 'wave') {
      // Both arms up and crossing over the head, again and again: apart (each hand outside its own shoulder), then
      // crossed (each past the centre line), the rear hand a little behind the lead so they pass rather than meet.
      const ph = Math.cos(this.waveT * c.refWaveHz * 2 * Math.PI);
      for (const i of [0, 1] as const) {
        const sgn = handLateralSign(i === 0 ? 'lead' : 'rear', REFEREE.stance);
        want[i] = { fwd: 0.2 - i * 0.07, up: b.headY + 0.24, lat: sgn * (0.08 + 0.27 * ph) };
      }
    } else if (walking) {
      // A little arm swing with the stride.
      const sw = Math.sin(this.tWalk * 6) * 0.1;
      want[0].fwd += sw; want[1].fwd -= sw;
    }
    this.gesture = gesture;
    const ka = 1 - Math.exp(-c.refArmLambda * (gesture === 'wave' ? 2 : 1) * dt);   // the wave has to keep up with its own crossings
    for (const i of [0, 1] as const) {
      const h = this.hands[i], t = want[i];
      h.fwd += (t.fwd - h.fwd) * ka; h.up += (t.up - h.up) * ka; h.lat += (t.lat - h.lat) * ka;
    }

    // ── The state the rig draws ──
    const head = localToWorld(me.pos, fr, 0, b.headY, 0);
    const chest = localToWorld(me.pos, fr, 0, b.shoulderY, 0), hips = localToWorld(me.pos, fr, 0, b.hipY, 0);
    me.headBox = { x: head.x, y: head.y, z: head.z, r: b.headR };
    me.bodyBox = { a: hips, b: chest, r: b.bodyR };
    for (const i of [0, 1] as const) {
      const hand: Hand = i === 0 ? 'lead' : 'rear';
      const h = this.hands[i];
      const g: Vec3 = localToWorld(me.pos, fr, h.fwd, h.up, h.lat);
      me.gloves[i] = { pos: g, vel: { x: 0, y: 0, z: 0 }, target: { x: g.x, y: g.y, z: g.z } };
      // `back: 1` sends the elbow pole BEHIND him: the fighters' pole is set
      // forward for a guard (rigElbowPoleBack < 0), which on a hanging arm
      // bowed the elbow the wrong way ("arms inverted", 2026-10-15).
      me.arms[i] = solveArm(b, c, REFEREE.stance, hand, chest, hips, fr, 0, 0, g, { level: 0, back: 1, flare: armFlareTarget(0, g.y, chest.y, b, c) });
    }

    // ── The Meshy man's cue (human/referee.ts): what he is doing, what he watches ──
    const counting = downSide !== null && (ph === 'count' || ph === 'over') && gesture === 'hang';
    const apart = Math.hypot(f1.x - a.x, f1.z - a.z);
    this.cue.mode = gesture !== 'hang' ? 'hide' : counting && toLen < 0.5 ? 'count' : 'watch';   // no clip yet for the winner's arm or the wave-off
    this.cue.close = ph === 'fighting' ? Math.max(0, Math.min(1, (c.refCloseFar - apart) / Math.max(0.05, c.refCloseFar - c.refCloseNear))) : 0;
    this.cue.look = counting ? { x: s.fighters[downSide].pos.x, y: 0.35, z: s.fighters[downSide].pos.z } : { x: mid.x, y: 1.45, z: mid.z };
    this.drawState(me, dt, this.cue);
  }

  /** Draw a state: the Meshy man in human mode (human/referee.ts; nothing until his file has loaded), else the old rig. */
  private drawState(st: FighterState, dt: number, cue: RefCue): void {
    if (this.cfg.humanBody && this.cfg.refMeshy && this.meshyOk) {
      if (this.view) { this.view.dispose(); this.view = null; }
      if (!this.body) {
        void preloadReferee().then(() => { if (!refereeReady()) this.meshyOk = false; });
        this.body = createRefereeBody(this.cfg, this.scene);
      }
      this.body?.apply(st, cue, dt);
      return;
    }
    if (this.body) { this.body.dispose(); this.body = null; }
    if (!this.view) this.view = createFighterView(1, REFEREE, this.cfg, this.scene, { key: 2, probe: false });
    this.view.apply(st, st, 1, dt, []);
  }

  /** A copy of the state he is drawn from right now (the knockdown replay keeps one per tick). */
  snapshot(): FighterState { return Object.assign(structuredClone(this.state), { refCue: structuredClone(this.cue) }); }

  /** Draw him from a kept snapshot instead of walking him (the replay; the snapshot carries his cue). */
  draw(snap: FighterState, dt: number): void {
    this.drawState(snap, dt, (snap as FighterState & { refCue?: RefCue }).refCue ?? this.cue);
  }

  /** Floor position and yaw (probes / checks). */
  get pose(): { pos: Vec2; yaw: number } { return { pos: { x: this.state.pos.x, z: this.state.pos.z }, yaw: this.state.yaw }; }

  dispose(): void {
    if (this.view) { this.view.dispose(); this.view = null; }
    if (this.body) { this.body.dispose(); this.body = null; }
  }
}


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

type Gesture = 'hang' | 'point';
interface HandLocal { fwd: number; up: number; lat: number }

export class Referee {
  private view: FighterView | null = null;
  private state: FighterState;
  private vel: Vec2 = { x: 0, z: 0 };
  private hands: [HandLocal, HandLocal];
  private tWalk = 0;
  private winner: 0 | 1 | null = null;
  private method: 'ko' | 'tko' | 'decision' | null = null;

  constructor(private cfg: Config, private scene: THREE.Object3D) {
    this.state = restFighterState(REFEREE, cfg, { x: 0, z: -2.2 }, Math.PI / 2);
    this.hands = [this.hangPose('lead'), this.hangPose('rear')];
  }

  /** The hands by the hips, a little out from the thighs. */
  private hangPose(hand: Hand): HandLocal {
    const b = this.state.body;
    return { fwd: 0.06, up: b.hipY + 0.02, lat: handLateralSign(hand, REFEREE.stance) * (b.shoulderW / 2 + 0.05) };
  }

  update(s: SimState, events: readonly SimEvent[], dt: number, camAz: number, visible: boolean): void {
    if (!visible) { if (this.view) { this.view.dispose(); this.view = null; } return; }
    if (!this.view) this.view = createFighterView(1, REFEREE, this.cfg, this.scene, { key: 2, probe: false });
    const c = this.cfg, me = this.state, b = me.body;
    for (const e of events) {
      if (e.type === 'ko' || e.type === 'tko') { this.method = e.type; this.winner = e.winner; }
      else if (e.type === 'decision') { this.method = 'decision'; this.winner = e.winner; }
      else if (e.type === 'roundStart') { this.method = null; this.winner = null; }
    }
    if (s.tick === 0) { this.method = null; this.winner = null; }

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
      target = { x: mid.x + nx * c.refStandoff, z: mid.z + nz * c.refStandoff };
      face = mid;
    }
    target.x = Math.max(-bound, Math.min(bound, target.x));
    target.z = Math.max(-bound, Math.min(bound, target.z));

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
    } else if (walking) {
      // A little arm swing with the stride.
      const sw = Math.sin(this.tWalk * 6) * 0.1;
      want[0].fwd += sw; want[1].fwd -= sw;
    }
    const ka = 1 - Math.exp(-c.refArmLambda * dt);
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
    this.view.apply(me, me, 1, dt, []);
  }

  /** Floor position and yaw (probes / checks). */
  get pose(): { pos: Vec2; yaw: number } { return { pos: { x: this.state.pos.x, z: this.state.pos.z }, yaw: this.state.yaw }; }

  dispose(): void { if (this.view) { this.view.dispose(); this.view = null; } }
}


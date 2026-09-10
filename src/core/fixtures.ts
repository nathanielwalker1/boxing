/**
 * core/fixtures.ts — canned fighter states so RIG and RENDER can be built and
 * tested before SIM exists, and so pose_grid.mjs has something deterministic to
 * capture. `restFighterState` is also what sim.createState starts from.
 *
 * Glove placement here is a plausible guard / extension, authored by hand. The
 * sim's kinetic chain replaces it at runtime; these are fixtures, not spec.
 */
import type { BodyDims, FighterSpec, FighterState, Hand, PunchType, Vec2 } from './types';
import type { Config } from './config';
import { bodyDims } from './body';
import { frameOf, handLateralSign, lerp, localToWorld, smoothstep, spring1, spring3, triangle, v3copy } from './math';

/** Guard position in the fighter's local frame: lead glove a little forward at
 *  chin height, rear glove tucked by the cheek. */
function guardLocal(body: BodyDims, hand: Hand, stance: FighterSpec['stance']) {
  return {
    fwd: hand === 'lead' ? body.upperArm * 0.6 : body.upperArm * 0.35,   // mirrors sim/punches.ts guardLocal
    up: body.headY - body.headR * (hand === 'lead' ? 0.6 : 0.2),
    lat: handLateralSign(hand, stance) * body.shoulderW * 0.32,
  };
}

function gloveAtRest(body: BodyDims, pos: Vec2, yaw: number, hand: Hand, stance: FighterSpec['stance']) {
  const g = guardLocal(body, hand, stance);
  const p = localToWorld(pos, frameOf(yaw), g.fwd, g.up, g.lat);
  return { pos: p, vel: { x: 0, y: 0, z: 0 }, target: v3copy(p) };
}

export function restFighterState(spec: FighterSpec, cfg: Config, pos: Vec2, yaw: number): FighterState {
  const body = bodyDims(spec, cfg);
  const f = frameOf(yaw);
  const head = localToWorld(pos, f, 0, body.headY, 0);
  return {
    specId: spec.id,
    body,
    stance: spec.stance,
    pos: { x: pos.x, z: pos.z },
    vel: { x: 0, z: 0 },
    yaw,
    lean: { fwd: 0, lat: 0 },
    torsoTwist: 0,
    crouch: 0,
    health: 1,
    stamina: 1,
    block: false,
    blockT: 0,
    guard: 'rest',
    punch: { type: null, hand: 'lead', phase: 'idle', t: 0, progress: 0, resolved: false, contact: null },
    slip: { active: false, dir: 0, t: 0, offset: 0 },
    moveHist: [],
    vuln: 0,
    counterWindow: 0,
    gloves: [gloveAtRest(body, pos, yaw, 'lead', spec.stance), gloveAtRest(body, pos, yaw, 'rear', spec.stance)],
    reaction: { head: spring3(), torso: spring3(), tilt: spring1() },
    stagger: { x: 0, z: 0 },
    down: false,
    downT: 0,
    knockdowns: 0,
    headBox: { ...head, r: body.headR },
    bodyBox: { a: localToWorld(pos, f, 0, body.hipY, 0), b: localToWorld(pos, f, 0, body.shoulderY, 0), r: body.bodyR },
  };
}

/**
 * A fighter frozen mid-punch at `progress` ∈ [0,1]. The glove travels on a
 * straight line (jab/cross), an arc (hook), or a rising line (uppercut) — a
 * fixture for the pose grid, not the real trajectory.
 */
export function punchFixture(spec: FighterSpec, cfg: Config, pos: Vec2, yaw: number, type: PunchType, hand: Hand, progress: number): FighterState {
  const s = restFighterState(spec, cfg, pos, yaw);
  const body = s.body;
  const f = frameOf(yaw);
  const ext = triangle(progress, 0.55);            // 0 → 1 (full extension) → 0
  const g0 = guardLocal(body, hand, spec.stance);  // ext = 0 is exactly the guard
  const side = Math.sign(g0.lat);
  const reach = body.upperArm + body.forearm;
  let fwd: number, up: number, lat: number;
  switch (type) {
    case 'jab':
    case 'cross':
      fwd = g0.fwd + (reach * 0.95 + body.upperArm * 0.3 - g0.fwd) * ext;
      up = g0.up + (body.headY - body.headR * 0.4 - g0.up) * ext;
      lat = g0.lat * (1 - 0.7 * ext);
      break;
    case 'hook': {
      // cock (0→.25): guard → wide on own side. swing (.25→.6): arc round to the
      // front. recover (.6→1): straight back to guard.
      const wide = { fwd: g0.fwd * 0.5, up: g0.up, lat: g0.lat + side * reach * 0.6 };
      const front = { fwd: reach * 0.85 + body.upperArm * 0.3, up: body.headY - body.headR * 0.3, lat: 0 };
      if (progress < 0.25) {
        const t = smoothstep(progress / 0.25);
        fwd = lerp(g0.fwd, wide.fwd, t); up = wide.up; lat = lerp(g0.lat, wide.lat, t);
      } else if (progress < 0.6) {
        const t = (progress - 0.25) / 0.35;
        const a = (1 - t) * Math.PI * 0.5;                // 90° (side) → 0° (front)
        fwd = wide.fwd + (front.fwd - wide.fwd) * Math.cos(a);
        lat = front.lat + (wide.lat - front.lat) * Math.sin(a);
        up = lerp(wide.up, front.up, t);
      } else {
        const t = smoothstep((progress - 0.6) / 0.4);
        fwd = lerp(front.fwd, g0.fwd, t); up = lerp(front.up, g0.up, t); lat = lerp(front.lat, g0.lat, t);
      }
      break;
    }
    case 'uppercut': {
      // cock (0→.25): drop to hip height. drive (.25→.6): rise through the chin
      // line. recover (.6→1): back to guard.
      const low = { fwd: g0.fwd * 0.6, up: body.hipY + (body.shoulderY - body.hipY) * 0.35, lat: g0.lat };
      const peak = { fwd: reach * 0.45 + g0.fwd * 0.5, up: body.headY + body.headR * 0.4, lat: g0.lat * 0.6 };
      if (progress < 0.25) {
        const t = smoothstep(progress / 0.25);
        fwd = lerp(g0.fwd, low.fwd, t); up = lerp(g0.up, low.up, t); lat = low.lat;
      } else if (progress < 0.6) {
        const t = (progress - 0.25) / 0.35;
        fwd = lerp(low.fwd, peak.fwd, t); up = lerp(low.up, peak.up, t * t); lat = lerp(low.lat, peak.lat, t);
      } else {
        const t = smoothstep((progress - 0.6) / 0.4);
        fwd = lerp(peak.fwd, g0.fwd, t); up = lerp(peak.up, g0.up, t); lat = lerp(peak.lat, g0.lat, t);
      }
      break;
    }
  }
  const g = s.gloves[hand === 'lead' ? 0 : 1];
  g.pos = localToWorld(pos, f, fwd, up, lat);
  g.target = v3copy(g.pos);
  s.punch = { type, hand, phase: progress < 0.25 ? 'cock' : progress < 0.6 ? 'extend' : 'recover', t: 0, progress, resolved: false, contact: null };
  s.lean.fwd = 0.5 * ext;
  s.torsoTwist = (hand === 'lead' ? 1 : -1) * handLateralSign('lead', spec.stance) * 0.5 * ext;
  return s;
}

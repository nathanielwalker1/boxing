/**
 * bots/_util.mjs — shared pieces for the cheat bots and honest reference bots (scripts/bots/*.mjs).
 * A bot is a factory `(side, seed, cfg) => (state, tick) => input`. `cfg` is the BOT config:
 *   { game: <the game Config>, jabReach: <centre-to-centre jab reach, m>, delay: <reaction ticks, default 12 = 200 ms> }
 * Everything here is deterministic: randomness is a seeded mulberry32 inside the bot, never Math.random.
 * Bots read only the SimState they are handed. Anything about the OPPONENT's punch / evade state goes through
 * observer() (delayed by the reaction ticks); positions and distance are read live.
 */
export const TICKS_PER_S = 60;
export const EVADE_LOCK = 36;   // ticks: evadeWindow 0.3 s + evadeCooldown 0.3 s (core/config.ts); a new evade inside it is refused by the sim

/** mulberry32: a small seeded generator. Returns () => [0, 1). */
export function rng(seed) {
  let a = (seed * 2654435761 + 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh input (the FrameInput shape from core/types.ts), plain object so bots need no import. */
export function inp(o = {}) {
  return { move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false, ...o };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Live geometry: me, opp, centre distance, unit vector toward the opponent, own right-hand vector. */
export function geom(s, side) {
  const me = s.fighters[side], opp = s.fighters[1 - side];
  const dx = opp.pos.x - me.pos.x, dz = opp.pos.z - me.pos.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  return { me, opp, d, ux: dx / d, uz: dz / d, rx: -Math.sin(me.yaw), rz: Math.cos(me.yaw) };
}

/** Speed at which the gap is opening, m/s (+ = pulling apart), from both velocities. */
export function opening(s, side) {
  const g = geom(s, side);
  return (g.opp.vel.x - g.me.vel.x) * g.ux + (g.opp.vel.z - g.me.vel.z) * g.uz;
}

/**
 * The reaction-delayed view of the opponent. Call see(state) ONCE per tick; it returns the opponent as it was
 * `delay` ticks ago: { type, phase, resolved, whiffed, landed, started, slipActive, level, blocking, down }.
 *   started  = a new punch began in that delayed tick (rising edge)
 *   whiffed  = his punch just resolved with no contact (he missed, or was blocked / dodged: contact null)
 *   landed   = his punch just resolved with contact
 */
export function observer(side, delay = 12) {
  const buf = [];
  let prev = null;
  const snap = o => ({
    type: o.punch.type, phase: o.punch.phase, resolved: o.punch.resolved, contact: o.punch.contact !== null,
    slipActive: o.slip.active, level: o.level, blocking: o.block, down: o.down, hurt: o.hurt,
  });
  return {
    see(s) {
      buf.push(snap(s.fighters[1 - side]));
      const cur = buf.length > delay ? buf[buf.length - 1 - delay] : snap({ punch: { type: null, phase: 'idle', resolved: false, contact: null }, slip: { active: false }, level: 0, block: false, down: false, hurt: 0 });
      if (buf.length > delay + 4) buf.shift();
      const started = cur.type !== null && (prev === null || prev.type === null || (prev.resolved && !cur.resolved));
      const resolvedNow = cur.type !== null && cur.resolved && (prev === null || prev.type === null || !prev.resolved);
      const out = { ...cur, started, whiffed: resolvedNow && !cur.contact, landed: resolvedNow && cur.contact };
      prev = cur;
      return out;
    },
  };
}

/**
 * Evade tapper: turns "do this evade now" into the held stick / level for the few ticks the sim needs, and enforces
 * the sim's shared evade lock (a second evade inside it is refused, so a bot would only waste the press).
 *   kind: 'slipL' | 'slipR' | 'lean' | 'duck'.   jab / cross -> slip, hook -> duck, uppercut -> lean back (sim/outcome.ts).
 */
export function evader() {
  let kind = null, left = 0, lastStart = -1e9;
  return {
    /** try to start an evade at tick t; returns true if it was accepted. */
    start(k, t) {
      if (kind !== null || t - lastStart < EVADE_LOCK) return false;
      kind = k; left = k === 'duck' ? 10 : 4; lastStart = t; return true;
    },
    get active() { return kind !== null; },
    get ready() { return kind === null; },
    ready_at(t) { return kind === null && t - lastStart >= EVADE_LOCK; },
    /** write this tick's evade into the input (and spend a tick of it). Returns true if it owns the stick. */
    apply(o) {
      if (kind === null) return false;
      if (kind === 'slipL') o.move = { x: -1, y: 0 };
      else if (kind === 'slipR') o.move = { x: 1, y: 0 };
      else if (kind === 'lean') o.move = { x: 0, y: -1 };
      else if (kind === 'duck') o.level = true;
      o.block = false;
      if (--left <= 0) kind = null;
      return true;
    },
  };
}

/** The correct evade for an incoming punch (sim/outcome.ts evadeV2 formula). */
export function evadeFor(type, flip) {
  if (type === 'hook') return 'duck';
  if (type === 'uppercut') return 'lean';
  return flip ? 'slipL' : 'slipR';
}

/** Stick y that holds a distance: positive = close in. */
export function holdDistance(d, target, gain = 4) {
  return clamp((d - target) * gain, -1, 1);
}

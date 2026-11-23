/**
 * The three reference "honest" bots, simple but principled (the rock-paper-scissors the design wants):
 *   boxer   holds the edge of its own jab reach, jabs when in reach, steps out after, blocks when it sees a punch coming
 *   swarmer closes behind a raised guard, evades on the way in (correct evade, after its reaction delay), then hooks and
 *           uppercuts to head and body inside
 *   counter waits just outside reach, evades with the correct evade per punch type after its reaction delay, answers with a cross
 * Evade formula (sim/outcome.ts, evadeV2): jab / cross -> slip, hook -> duck (level down), uppercut -> lean back (back tap).
 */
import { evader, evadeFor, geom, holdDistance, inp, observer, rng } from './_util.mjs';

export function boxer(side, seed, cfg = {}) {
  const obs = observer(side, cfg.delay ?? 12), r = rng(seed * 17 + 3 + side);
  const reach = cfg.jabReach ?? 1.15;
  let stepOut = 0, guard = 0, next = 0;
  return (s, tick) => {
    const g = geom(s, side), seen = obs.see(s), me = g.me;
    const o = inp({ move: { x: 0, y: holdDistance(g.d, reach - 0.1) } });
    if (seen.started && g.d < reach + 0.25) guard = 18;
    if (guard > 0) { guard--; o.block = true; o.move.y = Math.min(o.move.y, -0.4); return o; }
    if (stepOut > 0) { stepOut--; o.move.y = -1; return o; }
    if (tick >= next && me.punch.type === null && g.d < reach - 0.02) {
      o.jab = true; stepOut = 8; next = tick + 26 + Math.floor(r() * 14);
    }
    return o;
  };
}

export function swarmer(side, seed, cfg = {}) {
  const obs = observer(side, cfg.delay ?? 12), ev = evader(), r = rng(seed * 19 + 7 + side);
  const reach = cfg.jabReach ?? 1.15;
  const INSIDE = reach - 0.22;   // work from here in
  const SEQ = [['hook', false], ['uppercut', false], ['hook', true], ['uppercut', true]];   // [punch, to the body]
  let n = 0, next = 0, bodyHold = 0, flip = r() < 0.5, hand = 1, blk = 0;
  return (s, tick) => {
    const g = geom(s, side), seen = obs.see(s), me = g.me;
    const o = inp({ move: { x: 0, y: 1 } });
    if (seen.started && ev.ready_at(tick)) ev.start(evadeFor(seen.type, flip = !flip), tick);
    else if (seen.started) blk = 14;   // no evade available: cover up instead
    if (ev.apply(o)) return o;
    if (blk > 0) { blk--; o.block = true; o.move.y = g.d > INSIDE ? 0.6 : 0; return o; }
    if (bodyHold > 0) { bodyHold--; o.level = true; }
    if (g.d > INSIDE) { o.block = true; o.move.y = 1; return o; }   // closing behind a raised guard
    o.move.y = holdDistance(g.d, INSIDE - 0.1, 3);
    if (tick >= next && me.punch.type === null) {
      const [k, body] = SEQ[n++ % SEQ.length];
      o[k] = true; hand = -hand; o.move.x = hand;
      if (body) { o.level = true; bodyHold = 10; }
      next = tick + 16 + Math.floor(r() * 8);
    }
    return o;
  };
}

export function counter(side, seed, cfg = {}) {
  const obs = observer(side, cfg.delay ?? 12), ev = evader(), r = rng(seed * 23 + 11 + side);
  const reach = cfg.jabReach ?? 1.15;
  let flip = r() < 0.5, answerAt = -1;
  return (s, tick) => {
    const g = geom(s, side), seen = obs.see(s), me = g.me;
    const o = inp({ move: { x: 0, y: holdDistance(g.d, reach + 0.12) } });
    if (seen.started && ev.ready_at(tick)) { ev.start(evadeFor(seen.type, flip = !flip), tick); answerAt = tick + 14; }
    if (ev.apply(o)) return o;
    if (answerAt >= 0 && tick >= answerAt) {
      if (me.punch.type === null && g.d < reach + 0.15) { o.cross = true; o.move.y = 1; }
      if (me.punch.type !== null || tick > answerAt + 30) answerAt = -1;
    }
    return o;
  };
}

/**
 * bots/jab_and_move.mjs — the outboxer. Stays on the outside edge of range,
 * sticks the jab (a step jab from far, a double jab, a body jab now and then),
 * and is gone: back and round, AWAY from the opponent's power hand. Crowded,
 * it flicks a retreat jab and hops out, or shoves off. Never trades.
 * A legitimate plan: it must be able to win.
 */
import { makeBot, dist, ready } from './util.mjs';

export const name = 'jab-and-move';
export const legit = true;

export function create(k, seed, cfg) {
  const OUT = 1.0, CROWD = 0.74;
  return makeBot(k, seed, (b, s) => {
    const me = s.fighters[0], opp = s.fighters[1], d = dist(s);
    const away = 1;   // circling to my right takes me away from an orthodox man's right hand
    const m = b.mem;
    m.cool = Math.max(0, (m.cool ?? 0) - 1);
    // Crowded: get out. A hop back if the feet are free, a shove if he is on top of me, else a retreat jab going away.
    if (d < CROWD) {
      if (me.burstCd === 0 && me.punch.type === null && b.chance(0.5)) { b.doubleTap(0, -1, 8); return; }
      if (me.pushCd === 0 && me.punch.type === null && d < cfg.pushRange - 0.1 && b.chance(0.3)) { b.flick(0, 1, { block: true }); return; }
      if (ready(k, s, cfg) && m.cool === 0) { m.cool = 14; return { jab: true, move: { x: away * 0.4, y: -1 } }; }
      return { move: { x: away * 0.6, y: -1 } };
    }
    // He is throwing and I am in reach: do not be there.
    if (b.seenPunch.type && d < 1.0) return { move: { x: away * 0.5, y: -1 } };
    // In range and set: stick.
    if (d <= OUT && ready(k, s, cfg) && m.cool === 0 && !opp.down) {
      m.cool = 26;
      const r = b.chance(1);
      void r;
      if (b.chance(0.25)) { b.combo([['jab'], ['jab']], 4); for (let i = 0; i < 14; i++) b.push({ move: { x: away, y: -0.6 } }); return; }
      if (b.chance(0.15)) { b.lowThen('jab'); for (let i = 0; i < 12; i++) b.push({ move: { x: away, y: -0.6 } }); return; }
      b.push({ jab: true, move: { x: away * 0.3, y: 0 } });
      for (let i = 0; i < 12; i++) b.push({ move: { x: away, y: -0.5 } });
      return;
    }
    // Just out of range with the jab ready: step in behind it.
    if (d > OUT && d <= OUT + 0.14 && ready(k, s, cfg) && m.cool === 0) { m.cool = 24; b.push({ jab: true, move: { x: 0, y: 1 } }); for (let i = 0; i < 10; i++) b.push({ move: { x: away, y: -0.7 } }); return; }
    // Otherwise: hold the edge of range, circling. Off the ropes if they are near.
    if (me.ropes > 0.4) return { move: { x: away, y: 0.7 } };
    return { move: { x: away * 0.8, y: d > OUT + 0.1 ? 0.6 : d < OUT - 0.1 ? -0.6 : 0 } };
  });
}

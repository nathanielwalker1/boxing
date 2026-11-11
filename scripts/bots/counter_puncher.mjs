/**
 * bots/counter_puncher.mjs — waits at mid range, makes him miss, and pays him.
 * Reads a punch (through the reaction delay), slips away from the punching
 * hand — or pulls from a jab at the end of range — and throws the hand the slip
 * LOADED: the lead hook off a slip to the lead side, the cross off a slip to
 * the rear side or a pull. Jabs to draw a lead; takes a counter when the other
 * man is left hanging (a whiff, a punish window). Covers when hurt.
 * A legitimate plan: it must be able to win.
 */
import { makeBot, dist, ready, awayFrom } from './util.mjs';

export const name = 'counter-puncher';
export const legit = true;

export function create(k, seed, cfg) {
  const HOLD = 0.9;
  return makeBot(k, seed, (b, s) => {
    const me = s.fighters[0], opp = s.fighters[1], d = dist(s);
    const m = b.mem;
    m.cool = Math.max(0, (m.cool ?? 0) - 1);
    if (me.hurt > 0) return { block: d < 1.1, move: { x: 1, y: -1 } };
    // The read: a punch began (as seen a reaction ago) and it can reach.
    if (b.seenPunch.fresh && d < 1.05 && me.punch.type === null && me.slip.dir === 0) {
      const x = awayFrom(k, opp, b.seenPunch.hand);   // slip away from the hand; that loads the hand on that side
      b.flick(x, 0);
      // The counter, as the punch goes by: the loaded hand. x < 0 is my lead side → the lead hook (if close enough), else the cross.
      for (let i = 0; i < 5; i++) b.push({});
      if (x < 0 && d < 0.84) b.push({ hook: true, move: { x: -1, y: 0 } });
      else b.push({ cross: true, move: { x: 0, y: d > 0.9 ? 1 : 0 } });
      b.push({}, {}, {}, { jab: true });
      return;
    }
    // He is exposed (whiffed, or in a punish window) and in reach: take it.
    if (opp.vuln >= 0.6 && opp.punch.resolved !== false && d < 0.98 && ready(k, s, cfg)) { m.cool = 30; b.combo([['cross'], ['hook', -1]], 4); return; }
    // Draw a lead: a jab now and then.
    if (d < 1.0 && d > 0.7 && ready(k, s, cfg) && m.cool === 0 && opp.punch.type === null) { m.cool = 45 + (b.chance(0.5) ? 20 : 0); return { jab: true }; }
    // Hold the distance, feet moving (never flat-footed).
    if (me.ropes > 0.4) return { move: { x: 1, y: 0.6 } };
    return { move: { x: (Math.floor(b.t / 50) % 2 ? 1 : -1) * 0.5, y: d > HOLD + 0.08 ? 0.5 : d < HOLD - 0.1 ? -0.55 : 0 } };
  });
}

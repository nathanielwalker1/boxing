/**
 * bots/turtle.mjs — holds the block and waits. Throws one jab when nothing is
 * coming. NOT a legitimate plan: blocking is safe but it costs (stun, guard
 * wear, chip, the body is open, uppercuts split it) — the turtle should lose.
 */
import { makeBot, dist, ready } from './util.mjs';

export const name = 'turtle';
export const legit = false;

export function create(k, seed, cfg) {
  return makeBot(k, seed, (b, s) => {
    const m = b.mem;
    m.cool = Math.max(0, (m.cool ?? 0) - 1);
    const opp = s.fighters[1];
    if (opp.punch.type === null && dist(s) < 0.95 && m.cool === 0 && ready(k, s, cfg) && b.chance(0.08)) { m.cool = 50; return { jab: true }; }
    return { block: true };
  });
}

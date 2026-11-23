/** spam_evade: stays at jab range and presses an evade (slip L, slip R, lean back, duck in turn) as often as it likes, jabbing between them. */
import { evader, geom, holdDistance, inp, rng } from './_util.mjs';

const TAP_EVERY = 20;   // ticks between evade presses: inside the sim's 36-tick evade lock, so some presses are simply refused (that is the point of the cheat)
const KINDS = ['slipL', 'slipR', 'lean', 'duck'];

export function spam_evade(side, seed, cfg = {}) {
  const ev = evader(), r = rng(seed * 13 + 5 + side);
  const reach = cfg.jabReach ?? 1.15;
  let k = Math.floor(r() * 4), jabNext = 8;
  return (s, tick) => {
    const g = geom(s, side);
    const o = inp({ move: { x: 0, y: holdDistance(g.d, reach - 0.12) } });
    if (tick % TAP_EVERY === 0) ev.start(KINDS[k++ % 4], tick);   // refused (returns false) while the lock runs, the press is wasted
    if (ev.apply(o)) return o;
    if (tick >= jabNext && g.me.punch.type === null && g.d < reach) { o.jab = true; jabNext = tick + 22 + Math.floor(r() * 10); }
    return o;
  };
}

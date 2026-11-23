/** masher_jab / masher_mix: walk straight in, press as fast as the game accepts, never block, never evade. */
import { inp, rng } from './_util.mjs';

const PRESS_EVERY = 4;   // ticks between presses (15 / s): far quicker than any punch recovers, so the sim's press buffer is always full

function masher(kinds) {
  return (side, seed) => {
    const r = rng(seed * 7 + 1 + side);
    let n = 0, sign = r() < 0.5 ? -1 : 1;
    return (s, tick) => {
      const o = inp({ move: { x: 0, y: 1 } });
      if (tick % PRESS_EVERY === 0) {
        const k = kinds[n++ % kinds.length];
        o[k] = true;
        if (k === 'hook' || k === 'uppercut') { o.move = { x: sign, y: 1 }; sign = -sign; }   // the stick's x at the press picks the hand
      }
      return o;
    };
  };
}

export const masher_jab = masher(['jab']);
export const masher_mix = masher(['jab', 'cross', 'hook', 'uppercut']);

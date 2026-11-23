/** turtle / turtle_counter: hold block the whole fight and walk slowly forward; the counter version answers a punch that landed on its guard with one jab. */
import { inp, observer } from './_util.mjs';

function turtle(counter) {
  return (side, seed, cfg = {}) => {
    const obs = observer(side, cfg.delay ?? 12);
    let start = -1;   // tick the reply began (-1 = guard up, not replying)
    return (s, tick) => {
      const seen = obs.see(s), me = s.fighters[side];
      const o = inp({ block: true, move: { x: 0, y: 0.3 } });
      if (!counter) return o;
      // His punch has just resolved with contact while I hold the guard: drop it, jab once, raise it again when the jab is over.
      if (start < 0 && seen.landed && me.block && me.punch.type === null) start = tick;
      if (start >= 0) {
        o.block = false;
        if (tick === start) o.jab = true;
        else if (tick > start + 2 && me.punch.type === null) { start = -1; o.block = true; }
      }
      return o;
    };
  };
}

export const turtle_plain = turtle(false);
export const turtle_counter = turtle(true);

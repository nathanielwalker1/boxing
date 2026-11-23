/** runner / runner_pot: always move directly away; near the ropes circle toward open space; never punch (pot: one jab on his whiff / recovery). */
import { geom, inp, observer } from './_util.mjs';

function runner(pot) {
  return (side, seed, cfg = {}) => {
    const obs = observer(side, cfg.delay ?? 12);
    const reach = cfg.jabReach ?? 1.15;
    let circle = 0, jabHold = 0;
    return (s, tick) => {
      const g = geom(s, side), seen = obs.see(s);
      const o = inp({ move: { x: 0, y: -1 } });
      // Pinned: ropes close behind (me.ropes 0..1) -> circle to the side that points at the ring centre until clear.
      if (g.me.ropes > 0.35 || g.me.cornered) {
        if (circle === 0) circle = (g.rx * -g.me.pos.x + g.rz * -g.me.pos.z) >= 0 ? 1 : -1;
        o.move = { x: circle, y: g.me.cornered ? 0.3 : -0.2 };
      } else if (g.me.ropes < 0.15) circle = 0;
      else if (circle !== 0) o.move = { x: circle, y: -0.2 };
      if (pot) {
        // one jab when he has just whiffed or is recovering and the jab reaches
        if (jabHold > 0) { jabHold--; o.block = false; }
        else if ((seen.whiffed || (seen.type !== null && seen.phase === 'recover')) && g.d < reach && g.me.punch.type === null) { o.jab = true; jabHold = 20; }
      }
      return o;
    };
  };
}

export const runner_plain = runner(false);
export const runner_pot = runner(true);

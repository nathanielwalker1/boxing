/**
 * bots.mjs — the audit's exploit bots (scratch folder only). A bot is (side, seed, bcfg) => (state, tick) => FrameInput.
 * bcfg = { game, jabReach, reach: { jab|cross|hook|uppercut: { far, near, step } }, delay }.
 * All are "does the dumb thing forever" players: they are the Undisputed complaints turned into opponents.
 */
import { geom, inp, rng } from '../bots/_util.mjs';

const PRESS_EVERY = 4;   // ticks between presses: faster than any punch recovers, so the press buffer is always full

/**
 * Walk into range of the punches in `seq`, then throw them in order forever, never defending.
 * seq items: [punch, body?]. Hooks / uppercuts always from the rear hand (same type + hand + level every time).
 */
function spam(seq) {
  return (side, seed, bcfg) => {
    const reach = Math.min(...seq.map(([k]) => bcfg.reach[k].far)) - 0.12;
    let n = 0, hold = 0;
    return (s, tick) => {
      const g = geom(s, side);
      const o = inp({ move: { x: 0, y: g.d > reach ? 1 : g.d < reach - 0.35 ? -0.3 : 0 } });
      if (hold > 0) { hold--; o.level = true; }
      if (tick % PRESS_EVERY === 0 && g.d < reach + 0.15) {
        const [k, body] = seq[n % seq.length];
        if (g.me.punch.type === null) n++;          // advance the pattern only when a press can start a punch
        o[k] = true;
        if (k === 'hook' || k === 'uppercut') o.move = { x: 1, y: o.move.y };
        if (body) { o.level = true; hold = 8; }
      }
      return o;
    };
  };
}

/** The same spammer, but it holds its guard up whenever it is not in range to throw (a slightly less dumb spammer). */
function spamGuarded(seq) {
  const base = spam(seq);
  return (side, seed, bcfg) => {
    const f = base(side, seed, bcfg);
    const reach = Math.min(...seq.map(([k]) => bcfg.reach[k].far)) - 0.12;
    return (s, tick) => {
      const o = f(s, tick), g = geom(s, side);
      if (g.d > reach + 0.15) o.block = true;
      return o;
    };
  };
}

export const MY_BOTS = {
  spam_jab_head: spam([['jab', false]]),
  spam_jab_body: spam([['jab', true]]),
  spam_cross_head: spam([['cross', false]]),
  spam_cross_body: spam([['cross', true]]),
  spam_hook_head: spam([['hook', false]]),
  spam_hook_body: spam([['hook', true]]),
  spam_upper_head: spam([['uppercut', false]]),
  spam_upper_body: spam([['uppercut', true]]),
  power_only: spam([['cross', false], ['hook', false], ['uppercut', false]]),
  high_low: spam([['hook', false], ['hook', true]]),
  high_low_mix: spam([['cross', false], ['hook', true], ['uppercut', false], ['cross', true]]),
  jab_cross: spam([['jab', false], ['cross', false]]),
  guarded_power: spamGuarded([['cross', false], ['hook', false], ['uppercut', false]]),
};
export { rng };

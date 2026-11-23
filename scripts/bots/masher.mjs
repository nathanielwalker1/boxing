/**
 * bots/masher.mjs — walks forward pressing random punch buttons as fast as
 * they come out. No defence, no range, no reads. NOT a legitimate plan: missing
 * costs more than landing, a tired man's punches slow and his hands drop, and
 * every miss is an opening — the masher should lose.
 */
import { makeBot } from './util.mjs';

export const name = 'masher';
export const legit = false;

export function create(k, seed) {
  const BUTTONS = ['jab', 'cross', 'hook', 'uppercut'];
  return makeBot(k, seed, b => {
    const press = b.t % 3 === 0 ? { [b.pick(BUTTONS)]: true } : {};
    return { ...press, move: { x: b.chance(0.5) ? -1 : 1, y: 1 } };
  });
}

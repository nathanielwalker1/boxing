/** Registry: name -> { make, group }. group is 'cheat' or 'honest'. The game's own AI styles are added by bot_ladder.mjs. */
import { masher_jab, masher_mix } from './masher.mjs';
import { runner_plain, runner_pot } from './runner.mjs';
import { turtle_plain, turtle_counter } from './turtle.mjs';
import { spam_evade } from './spam_evade.mjs';
import { boxer, swarmer, counter } from './honest.mjs';

/** The stick is a disc of radius 1 (core/types.ts FrameInput): scale any bot's move back onto it. */
const unit = factory => (side, seed, cfg) => {
  const f = factory(side, seed, cfg);
  return (s, t) => {
    const o = f(s, t), m = Math.hypot(o.move.x, o.move.y);
    if (m > 1) o.move = { x: o.move.x / m, y: o.move.y / m };
    return o;
  };
};

export const BOTS = {
  masher_jab:     { make: unit(masher_jab), group: 'cheat', style: 'pressure' },
  masher_mix:     { make: unit(masher_mix), group: 'cheat', style: 'pressure' },
  runner:         { make: unit(runner_plain), group: 'cheat', style: 'outboxer' },
  runner_pot:     { make: unit(runner_pot), group: 'cheat', style: 'outboxer' },
  turtle:         { make: unit(turtle_plain), group: 'cheat', style: 'counter' },
  turtle_counter: { make: unit(turtle_counter), group: 'cheat', style: 'counter' },
  spam_evade:     { make: unit(spam_evade), group: 'cheat', style: 'counter' },
  boxer:          { make: unit(boxer), group: 'honest', style: 'outboxer' },
  swarmer:        { make: unit(swarmer), group: 'honest', style: 'swarmer' },
  counter:        { make: unit(counter), group: 'honest', style: 'counter' },
};

/**
 * bots/human_pace.mjs — a stand-in for a person playing sensibly, not a plan to be balanced: he keeps his guard up,
 * walks to punching range, and every couple of seconds throws a short combination (1-2, 1-2-3, 1-1-2, 1-2-body
 * hook) with his presses a human 8 ticks apart. No slips, no reads, no tools — about 30–40 punches a minute.
 * NOT in the bot matrix (`legit` false, and bot_table does not list it): the polish phase uses it to ask "can a
 * person throwing at a person's pace hurt the AI at all?" (scripts/hurt_table.mjs).
 */
import { makeBot, dist, ready } from './util.mjs';

export const name = 'human-pace';
export const legit = false;

export function create(k, seed, cfg) {
  const COMBOS = [
    [['jab'], ['cross']],
    [['jab'], ['cross'], ['hook', -1]],
    [['jab'], ['jab'], ['cross']],
    [['jab'], ['cross'], ['hook', -1]],
  ];
  return makeBot(k, seed, (b, s) => {
    const d = dist(s);
    b.mem.wait = (b.mem.wait ?? 60) - 1;
    if (b.mem.wait <= 0 && d <= 0.9 && ready(k, s, cfg)) {
      b.mem.wait = 90 + Math.floor(k.core.rngRange(b.rng, 0, 70));   // 1.5–2.7 s between combinations
      if (b.chance(0.2)) { b.combo([['jab'], ['cross']], 8); for (let i = 0; i < 3; i++) b.push({}); b.lowThen('hook', -1); }   // 1-2, body hook
      else b.combo(b.pick(COMBOS), 8);
      // Hands off the guard until the last punch is out: block pressed in a wind-up is a FEINT (it cancelled every
      // third punch of this bot's combinations before this line was here — worth knowing about a real thumb, too).
      for (let i = 0; i < 18; i++) b.push({});
      return {};
    }
    // Between combinations: guard up, hold the range.
    return { block: d < 1.5, move: { x: 0, y: d > 0.86 ? 1 : d < 0.7 ? -1 : 0 } };
  });
}

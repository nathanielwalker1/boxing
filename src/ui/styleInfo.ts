/**
 * ui/styleInfo.ts — the words for a fighter's STYLE on the select, ladder and
 * name cards. The facts come from `src/core/styles.ts` (`STYLES[style]`: the
 * guard he holds, the range he wants, his rhythm, `desc`, `beat`); the names
 * and the "how he fights" lines are here, because that table has none.
 *
 *   for YOUR pick       how he fights: what to do with him, what his guard
 *                       gives and costs, where and how he moves
 *   for an OPPONENT     how to beat him: the table's three `beat` lines
 */
import { GUARDS, STYLES, type AiStyle, type FighterSpec, type GuardShape, type RangeBand } from '../core';

export interface StyleInfo {
  name: string;
  /** One line: what he is. */
  blurb: string;
  /** His guard by name, and the range he wants in plain words. */
  guard: string;
  range: string;
  /** Three lines for the man who picks him. */
  fights: string[];
  /** Three lines for the man who faces him. */
  beat: string[];
}

const NAMES: Record<AiStyle, string> = {
  pressure: 'Pressure fighter', counter: 'Counter-puncher', outboxer: 'Out-boxer', swarmer: 'Swarmer', slugger: 'Slugger',
};
const GUARD_NAMES: Record<GuardShape, string> = { high: 'High guard', shell: 'Shell', peekaboo: 'Peek-a-boo', long: 'Long guard', low: 'Hands low' };
const RANGE_NAMES: Record<RangeBand, string> = { outside: 'At arm\'s length', mid: 'Middle range', inside: 'Chest to chest' };

/** What to do with him, in one line. */
const PLAN: Record<AiStyle, string> = {
  pressure: 'Walk him forward behind the jab, then work the body.',
  counter: 'Let the other man lead. Make him miss, then punch.',
  outboxer: 'Jab and move. Never stand still and trade.',
  swarmer: 'Get to his chest and throw short punches in bunches.',
  slugger: 'Pick your moment: one clean heavy shot is the plan.',
};
/** What his guard gives and costs — each line is a number in core/styles.ts GUARDS. */
const GUARD_LINES: Record<GuardShape, string> = {
  high: 'High guard: covers head and body about evenly. Nothing special, nothing missing.',
  shell: 'Shell: straight punches roll off it and the body is covered, but hooks come round it and his jab is slower.',
  peekaboo: 'Peek-a-boo: hooks meet his gloves all the way round and he slips well, but the uppercut splits it, the body is open and his jab is short.',
  long: 'Long guard: the lead hand is already out, so the jab is quicker and longer. It wears fast under fire and the body is open under the arm.',
  low: 'Hands low: quicker feet and the longest slip. His chin is open until the hands come up, and that takes a beat.',
};

export function styleInfo(spec: Pick<FighterSpec, 'style'>): StyleInfo {
  const id: AiStyle = spec.style in STYLES ? spec.style : 'pressure';
  const st = STYLES[id];
  const g = GUARDS[st.guard];
  const feet = st.bounceHz >= 1.2 ? 'light on his feet' : st.bounceHz <= 0.7 ? 'planted, heavy-footed' : 'steady on his feet';
  const stance = st.stanceWidth >= 1.1 ? 'a wide stance' : st.stanceWidth <= 0.95 ? 'a narrow stance' : 'a square stance';
  const sits = g.crouch > 0 ? ', sitting low' : '';
  return {
    name: NAMES[id],
    blurb: st.desc,
    guard: GUARD_NAMES[st.guard],
    range: RANGE_NAMES[st.range],
    fights: [PLAN[id], GUARD_LINES[st.guard], `Best ${RANGE_NAMES[st.range].toLowerCase()}: ${feet}, ${stance}${sits}.`],
    beat: [...st.beat],
  };
}

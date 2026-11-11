/**
 * ui/styleInfo.ts — the words for a fighter's STYLE on the select, ladder and
 * name cards. An adapter over `src/core/styles.ts` (SIM phase 2, written in
 * parallel): it expects `STYLES[spec.style]` shaped like
 * `{ name, blurb, guard, howToBeat: string[] }` and fills any missing table or
 * field from the built-in text below, so the screens work before and after
 * that merge. ADAPTER: when the table lands, check the field names in
 * `fromTable` against it — that is the only place they are read.
 */
import type { AiStyle, FighterSpec } from '../core';

export interface StyleInfo {
  name: string;
  /** One line: what he is. */
  blurb: string;
  /** Up to three plain lines: how he fights / how to beat him. */
  lines: string[];
}

const BUILT_IN: Record<AiStyle, StyleInfo> = {
  pressure: {
    name: 'Pressure fighter',
    blurb: 'Walks you down behind a high guard and makes you work every second.',
    lines: [
      'He comes forward all round and cuts off the ring.',
      'Jab and step off to the side. Never back straight up to the ropes.',
      'Hit the body early. A tired pressure fighter stops coming.',
    ],
  },
  counter: {
    name: 'Counter-puncher',
    blurb: 'Waits for you to miss, then makes you pay for it.',
    lines: [
      'He stands off, lets you lead, slips and answers.',
      'Feint first, and punch when he reacts to it.',
      'No single big shots from range. Short combinations, then get out.',
    ],
  },
  outboxer: {
    name: 'Out-boxer',
    blurb: 'Long jab, good feet. He wins the fight at arm\'s length.',
    lines: [
      'He keeps you on the end of the jab and circles away.',
      'Slip the jab and step inside. Hooks and uppercuts work there; his long arms do not.',
      'Cut off the ring: walk him to the ropes instead of following him round.',
    ],
  },
  swarmer: {
    name: 'Swarmer',
    blurb: 'Short, busy, and always in your chest.',
    lines: [
      'He gets inside and throws in bunches, mostly to the body.',
      'Keep him off with the jab and the push-off.',
      'Tie him up when he gets in, and make his misses cost him.',
    ],
  },
  slugger: {
    name: 'Slugger',
    blurb: 'Slow hands, heavy hands. One clean shot changes the fight.',
    lines: [
      'He loads up on big hooks and overhands. The wind-up is long.',
      'Watch the wind-up and slip it. The punch after a slip is your best one.',
      'Stay off the ropes and make him miss. Every miss tires him.',
    ],
  },
};

// `{}` when core/styles.ts does not exist yet.
const mods = import.meta.glob('../core/styles.ts', { eager: true });

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : typeof v === 'string' && v.trim() ? [v.trim()] : []);

/** The SIM table's entry for a style, mapped onto StyleInfo; null fields mean "use the built-in". */
function fromTable(style: AiStyle): { name: string | null; blurb: string | null; lines: string[] } | null {
  for (const m of Object.values(mods)) {
    const mod = m as Record<string, unknown>;
    const table = (mod['STYLES'] ?? mod['styles'] ?? mod['default']) as Record<string, unknown> | undefined;
    const e = table && typeof table === 'object' ? table[style] as Record<string, unknown> | undefined : undefined;
    if (!e || typeof e !== 'object') continue;
    const fights = list(e['howHeFights'] ?? e['fights']);
    const beat = list(e['howToBeat'] ?? e['beat'] ?? e['tips']);
    return {
      name: str(e['name']) ?? str(e['title']),
      blurb: str(e['blurb']) ?? str(e['description']) ?? str(e['desc']),
      lines: [...fights, ...beat].slice(0, 3),
    };
  }
  return null;
}

export function styleInfo(spec: Pick<FighterSpec, 'style'>): StyleInfo {
  const base = BUILT_IN[spec.style] ?? BUILT_IN.pressure;
  const t = fromTable(spec.style);
  if (!t) return base;
  return { name: t.name ?? base.name, blurb: t.blurb ?? base.blurb, lines: t.lines.length ? t.lines : base.lines };
}

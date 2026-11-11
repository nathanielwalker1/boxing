/**
 * ui/drills.ts — the gym's drill list. An adapter over `src/ai/drills.ts`
 * (SIM phase 2, written in parallel), expected to export an array (`DRILLS`,
 * `drills` or default) of
 *   { id, title, goal, placement: { dist?, player?, opponent? },
 *     opponent(state, tick, rng) => FrameInput, setup?(state),
 *     metric?(state, events, acc) => { progress, stat } }
 * ADAPTER: `mapDrill` is the only place those field names are read. If the
 * module or the export is missing `loadDrills()` returns [] and the gym shows
 * the one built-in drill below, so the shell works before that merge.
 */
import { NULL_INPUT, cloneInput, type Config, type FighterSpec, type FrameInput, type RngState, type SimEvent, type SimState, type Vec2 } from '../core';

export interface DrillMetric { progress: number; stat: string }
export interface Drill {
  id: string;
  title: string;
  /** One sentence: what to do. */
  goal: string;
  /** The controls it trains, in plain words. */
  controls: string;
  placement: { dist?: number; player?: Vec2; opponent?: Vec2 };
  /** Changes to the opponent's spec for this drill (a taller man, a style). */
  opponentSpec?: Partial<FighterSpec>;
  /** The opponent's input for this tick; null = let the normal AI drive him. */
  opponent: ((s: SimState, tick: number, rng: RngState) => FrameInput) | null;
  setup: ((s: SimState) => void) | null;
  metric: ((s: SimState, events: readonly SimEvent[], acc: Record<string, unknown>) => DrillMetric) | null;
}

/** Controls text for the seven drills the brief names, matched on id / title, used when the drill itself carries none. */
const CONTROLS: readonly (readonly [RegExp, string])[] = [
  [/slip.*counter|counter/i, 'Flick the stick to the side to slip, then punch with the hand on that side'],
  [/slip/i, 'Flick the stick to the side (tap and let go) as the punch comes'],
  [/jab/i, 'Jab, and the stick: step in, step out, circle'],
  [/cut|ring/i, 'The stick: step across his path instead of following him'],
  [/inside|close/i, 'Slip or block your way in; hook and uppercut once you are chest to chest'],
  [/body/i, 'Hold LOW and punch: body jab, body cross, body hook'],
  [/hurt|surviv/i, 'Hold block, move, clinch (block + LOW when chest to chest)'],
];

const str = (v: unknown, d = ''): string => (typeof v === 'string' && v.trim() ? v.trim() : d);
const vec = (v: unknown): Vec2 | undefined => {
  const o = v as { x?: unknown; z?: unknown } | null;
  return o && typeof o.x === 'number' && typeof o.z === 'number' ? { x: o.x, z: o.z } : undefined;
};

/** The seed SIM's drill policies hash their cadences from (fixed: a drill replays the same way every time). */
const DRILL_SEED = 7;

function mapDrill(raw: unknown, i: number, cfg: Config): Drill | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r['id'], `drill-${i}`);
  const title = str(r['title'] ?? r['name'], id);
  // SIM's shape (src/ai/drills.ts, merged 2026-11-11): placement(cfg), policy(state, tick, seed, cfg),
  // setup(state, cfg), metric(ALL events since the start, state, cfg), opponent = spec changes.
  if (typeof r['policy'] === 'function') {
    const policy = r['policy'] as (s: SimState, tick: number, seed: number, cfg: Config) => FrameInput;
    const place = typeof r['placement'] === 'function' ? (r['placement'] as (cfg: Config) => { player?: Vec2; opponent?: Vec2 })(cfg) : {};
    const setup = typeof r['setup'] === 'function' ? r['setup'] as (s: SimState, cfg: Config) => void : null;
    const metric = typeof r['metric'] === 'function' ? r['metric'] as (ev: readonly SimEvent[], s: SimState, cfg: Config) => DrillMetric : null;
    const found = CONTROLS.find(([re]) => re.test(id) || re.test(title));
    const placement: Drill['placement'] = {};
    const pl = vec(place.player), op = vec(place.opponent);
    if (pl) placement.player = pl;
    if (op) placement.opponent = op;
    const spec = r['opponent'];
    return {
      id, title,
      goal: str(r['goal']),
      controls: str(r['controls'], found ? found[1] : ''),
      placement,
      ...(spec && typeof spec === 'object' ? { opponentSpec: spec as Partial<FighterSpec> } : {}),
      opponent: (s, tick) => policy(s, tick, DRILL_SEED, cfg),
      setup: setup ? s => setup(s, cfg) : null,
      metric: metric ? (s, events, acc) => {
        const all = (acc['events'] ??= []) as SimEvent[];
        for (const e of events) all.push(e);
        return metric(all, s, cfg);
      } : null,
    };
  }
  const p = (r['placement'] ?? {}) as Record<string, unknown>;
  const placement: Drill['placement'] = {};
  if (typeof p['dist'] === 'number') placement.dist = p['dist'];
  const pl = vec(p['player']), op = vec(p['opponent']);
  if (pl) placement.player = pl;
  if (op) placement.opponent = op;
  const fn = <T>(v: unknown): T | null => (typeof v === 'function' ? v as T : null);
  const found = CONTROLS.find(([re]) => re.test(id) || re.test(title));
  return {
    id, title,
    goal: str(r['goal'] ?? r['description']),
    controls: str(r['controls'] ?? r['inputs'], found ? found[1] : ''),
    placement,
    opponent: fn<NonNullable<Drill['opponent']>>(r['opponent']),
    setup: fn<NonNullable<Drill['setup']>>(r['setup']),
    metric: fn<NonNullable<Drill['metric']>>(r['metric']),
  };
}

/** The built-in drill: a man who stands in his guard and does nothing. */
export const FREE_SPARRING: Drill = {
  id: 'free-sparring',
  title: 'Free sparring',
  goal: 'A passive partner who stands in front of you: try every punch and every move with nothing coming back.',
  controls: 'Everything: the four punches, LOW for the body, flicks to slip, block',
  placement: { dist: 1.3 },
  opponent: () => cloneInput(NULL_INPUT),
  setup: null,
  metric: (_s, events, acc) => {
    let n = typeof acc['landed'] === 'number' ? acc['landed'] : 0;
    for (const e of events) if (e.type === 'punchLand' && e.side === 0 && e.grade !== 'glancing') n++;
    acc['landed'] = n;
    return { progress: Math.min(1, n / 20), stat: `${n} / 20 clean punches landed` };
  },
};

// `{}` when ai/drills.ts does not exist yet.
const mods = import.meta.glob('../ai/drills.ts');

/** SIM's drills, or [] when the module / export is not there. */
export async function loadDrills(cfg: Config): Promise<Drill[]> {
  try {
    for (const load of Object.values(mods)) {
      const mod = await load() as Record<string, unknown>;
      let raw: unknown = mod['DRILLS'] ?? mod['drills'] ?? mod['default'];
      if (typeof raw === 'function') raw = (raw as () => unknown)();
      if (!Array.isArray(raw)) continue;
      return raw.map((d, i) => mapDrill(d, i, cfg)).filter((d): d is Drill => d !== null);
    }
  } catch { /* the gym falls back to the built-in drill */ }
  return [];
}

/**
 * rig/replay.ts — a debug hook for filmstrips (overhaul phase 2). Not used in play.
 *
 * main.ts's `__replay(dist, s0, ticks, s1)` poses both fighters at tick `ticks`
 * of a scripted exchange, but hands the views a frozen state and NO events — so
 * everything the rig draws from events and from its own springs (a graded
 * squash, the head whip, the fold at the waist, the sweat spray, a wince, how
 * a knockdown falls, the get-up) is missing from a strip made that way.
 *
 * `window.__rigReplay(dist, s0, ticks, s1, over)` runs the same deterministic
 * sim here, feeds every tick and its events through the two fighters' views at
 * the fixed step, calls `__replay` so the host's pose and camera agree, and
 * freezes the views (dt = 0) so the frame that is captured is tick `ticks`
 * exactly, springs mid-flight. `over` lays fields over a side's state for the
 * whole run (a spent fighter, a clinch) — see RigProbe.override.
 */
import { NULL_INPUT, ROSTER, SIM_DT, cloneInput, type Config, type FighterState, type FrameInput, type HitGrade, type Side, type SimEvent, type SimState } from '../core';
import { createState, step } from '../sim';

export interface ReplayFeed {
  /** One sim tick for this view: prev → next with the tick's events (already filtered to this side). */
  feed(prev: FighterState, next: FighterState, events: readonly SimEvent[]): void;
  /** One drawn frame between two ticks at `alpha`, the view's clock advanced `dt` (probes: live vs slowed replay). */
  drive?: (prev: FighterState, next: FighterState, alpha: number, dt: number, events: readonly SimEvent[]) => void;
  /** Hold the pose: later host `apply` calls advance nothing. */
  freeze(on: boolean): void;
  override?: (o: Partial<FighterState> | null) => void;
}

declare global {
  interface Window {
    __rigReplay?: (dist: number, script: readonly Partial<FrameInput>[], ticks: number, script1?: readonly Partial<FrameInput>[], opts?: readonly (Partial<FighterState> | null)[] | ReplayOpts) => void;
  }
}
/**
 * over = view-only state overlay per side. grade = re-label landed punches for the views. land (polish B) = any punchLand fields
 * re-labelled for the views (zone, vary, finisher, combo…): one punch filmed as a jaw shot, a nose shot, at vary −1 and +1.
 * init (polish B) = fields written into the SIM state of each side once the gloves have settled (a man who starts rocked, winded,
 * worn) — the sim then runs with them, so what its hurt states do to the hands and the body is in the film.
 */
export interface ReplayOpts { over?: readonly (Partial<FighterState> | null)[]; grade?: HitGrade | null; land?: Record<string, unknown> | null; init?: readonly (Partial<FighterState> | null)[] }
/** main.ts's own hooks, as this file needs them (declared there; optional here because a host need not have them). */
interface HostHooks {
  __replay?: (dist: number, script: readonly Partial<FrameInput>[], ticks: number, script1?: readonly Partial<FrameInput>[]) => void;
  __states?: () => readonly FighterState[];
}

export function installRigReplay(cfg: Config, feeds: () => Partial<Record<Side, ReplayFeed>>): void {
  if (typeof window === 'undefined' || window.__rigReplay) return;
  // The run is cached while the scenario is the same and time moves forward, so a strip costs one pass, not N.
  let key = '', at = -1, s: SimState | null = null;
  window.__rigReplay = (dist, script, ticks, script1 = [], opts = []) => {
    // `opts` is the per-side override list, or { over, grade }: `grade` re-labels every landed punch for the VIEWS
    // (the sim's own grade stands), so the same punch can be filmed as a glancing, a clean and a flush one.
    const over = Array.isArray(opts) ? opts : (opts as ReplayOpts).over ?? [];
    const grade = Array.isArray(opts) ? null : (opts as ReplayOpts).grade ?? null;
    const land = Array.isArray(opts) ? null : (opts as ReplayOpts).land ?? null;
    const init = Array.isArray(opts) ? [] : (opts as ReplayOpts).init ?? [];
    const f = feeds();
    const host = window as unknown as HostHooks;
    const shown = host.__states?.() ?? [];
    const specs = [0, 1].map(i => ROSTER.find(r => r.id === shown[i]?.specId) ?? ROSTER[i]!);
    const k = JSON.stringify([dist, script, script1, over, grade, land, init, specs.map(x => x.id)]);
    for (const side of [0, 1] as const) { f[side]?.freeze(false); f[side]?.override?.(over[side] ?? null); }
    const idle = cloneInput(NULL_INPUT);
    const tick = (inputs: [FrameInput, FrameInput]): void => {
      const r = step(s!, inputs, cfg);
      for (const side of [0, 1] as const) {
        const ev = r.events.filter(e => !('side' in e) || e.side === side || ('target' in e && e.target === side))
          .map(e => (e.type === 'punchLand' && (grade || land) ? { ...e, ...(grade ? { grade } : {}), ...(land ?? {}) } as SimEvent : e));
        f[side]?.feed(s!.fighters[side], r.state.fighters[side], ev);
      }
      s = r.state;
    };
    if (k !== key || ticks < at || !s) {
      // The same start as main.ts's __replay: a fresh seeded fight, placed, 30 idle ticks for the gloves to settle.
      s = createState([specs[0]!, specs[1]!], cfg, 1);
      s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
      for (let i = 0; i < 30; i++) tick([idle, idle]);
      for (const side of [0, 1] as const) if (init[side]) Object.assign(s.fighters[side], init[side]);
      key = k; at = 0;
    }
    for (; at < ticks; at++) {
      tick([{ ...cloneInput(NULL_INPUT), ...(script[at] ?? {}) }, { ...cloneInput(NULL_INPUT), ...(script1[at] ?? {}) }]);
    }
    host.__replay?.(dist, script, ticks, script1);
    for (const side of [0, 1] as const) f[side]?.freeze(true);
  };
  void SIM_DT;
}

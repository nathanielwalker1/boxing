/**
 * bots/kit.mjs — the shared Node harness for the overhaul's sim tests, the
 * scripted bots and the bot table: load the sim, build a fight, step it with
 * input functions, collect events. No browser.
 *
 *   const k = await kit();
 *   const s = k.fresh(k.cfg, 0.79);                    // fighters 0.79 m apart, settled
 *   const { s: after, evs } = k.run(s, 40, i => [k.inp({ jab: i === 0 }), k.NONE]);
 */
import { load } from '../load.mjs';

export async function kit() {
  const [core, sim, ai] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts');
  const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, RING_HALF } = core;
  const cfg = createConfig();
  const specs = [ROSTER[0], ROSTER[1]];
  const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
  const NONE = inp();
  const T = sec => Math.round(sec / SIM_DT);

  /** A fight with the fighters `dist` apart on the x axis round (cx, 0), stepped `settle` ticks with no input. */
  function fresh(c = cfg, dist = 0.79, settle = 30, cx = 0, seed = 1, sp = specs) {
    let s = sim.createState(sp, c, seed);
    s.fighters[0].pos = { x: cx - dist / 2, z: 0 }; s.fighters[1].pos = { x: cx + dist / 2, z: 0 };
    for (let i = 0; i < settle; i++) s = sim.step(s, [NONE, NONE], c).state;
    return s;
  }
  /** Step n ticks. `inputs(i, s)` → [side 0, side 1]. `onTick(s, i, events)` may return true to stop. Events carry `tick`. */
  function run(s, n, inputs = () => [NONE, NONE], c = cfg, onTick) {
    const evs = [];
    for (let i = 0; i < n; i++) {
      const r = sim.step(s, inputs(i, s), c); s = r.state;
      for (const e of r.events) evs.push({ ...e, tick: i });
      if (onTick?.(s, i, r.events) === true) break;
    }
    return { s, evs };
  }
  const of = (evs, type) => evs.filter(e => e.type === type);
  const first = (evs, type) => evs.find(e => e.type === type);
  const dist = s => Math.hypot(s.fighters[0].pos.x - s.fighters[1].pos.x, s.fighters[0].pos.z - s.fighters[1].pos.z);
  const mag = e => Math.hypot(e.impulse.x, e.impulse.z);
  /** The stick for a FLICK starting at tick `at`: pushed for 2 ticks, then let go. */
  const flick = (x, y, at = 0) => i => (i >= at && i < at + 2 ? { x, y } : { x: 0, y: 0 });
  /** The stick for a DOUBLE-TAP starting at `at`: 2 ticks, 1 off, then 2 more (`hold` to keep the second push down). */
  const doubleTap = (x, y, at = 0, hold = 2) => i => ((i >= at && i < at + 2) || (i >= at + 3 && i < at + 3 + hold) ? { x, y } : { x: 0, y: 0 });
  const bound = c => RING_HALF - c.ringInset;
  return { core, sim, ai, cfg, specs, inp, NONE, T, SIM_DT, fresh, run, of, first, dist, mag, flick, doubleTap, bound };
}

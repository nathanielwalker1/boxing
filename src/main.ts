/**
 * main.ts — app shell (UI workstream). Boots config, panel, stage, the two
 * rigs, and the fixed-step loop: input → sim.step → events → views.
 *
 * Test hooks on window (read by scripts/): __tick, __cfg, __fps, __sim,
 * __pose/__focus (pose grid), __states.
 */
import {
  SIM_DT, NULL_INPUT, EventBus, createConfig, cloneInput, punchFixture, restFighterState, ROSTER, v2dist,
  type Config, type FighterState, type FrameInput, type Hand, type PunchType, type Side, type SimEvent, type SimState,
} from './core';
import { createState, step } from './sim';
import { createFighterView } from './rig';
import { Stage } from './render/stage';
import { mountTuningPanel } from './ui/tune';
import { FpsOverlay } from './ui/fps';

declare global {
  interface Window {
    __tick: { frames: number; simTicks: number; gameTime: number; ready: boolean };
    __cfg: Config;
    __sim: {
      state: () => SimState;
      /** Override one side's input until cleared with null (tests). */
      input: (side: Side, input: FrameInput | null) => void;
      reset: (seed?: number) => void;
    };
    __pose: (side: Side, punch: PunchType | 'rest', hand: Hand, progress: number) => void;
    /** -1 = frame both fighters (default); 0/1 = centre the camera on that fighter (pose grid). */
    __focus: -1 | Side;
    __states: () => readonly FighterState[];
  }
}

const params = new URLSearchParams(location.search);
const cfg = createConfig();
window.__cfg = cfg;

const app = document.getElementById('app')!;
const stage = new Stage(app, cfg);
const fps = new FpsOverlay(document.getElementById('fps')!);
if (params.get('tune') === '1') mountTuningPanel(cfg);

// ── Sim + views ──────────────────────────────────────────────────────────────
const specs = [ROSTER[0]!, ROSTER[1]!] as const;
const bus = new EventBus();
let prev: SimState = createState([specs[0], specs[1]], cfg, Number(params.get('seed') ?? 1));
let next: SimState = prev;
const views = [
  createFighterView(0, specs[0], cfg, stage.scene),
  createFighterView(1, specs[1], cfg, stage.scene),
] as const;

// Inputs: side 0 is the player (InputManager lands here in Stage 1), side 1 is
// the frozen-guard dummy. Tests can override either side via window.__sim.input.
const liveInput: [FrameInput, FrameInput] = [cloneInput(NULL_INPUT), cloneInput(NULL_INPUT)];
const overrideInput: [FrameInput | null, FrameInput | null] = [null, null];

window.__sim = {
  state: () => next,
  input: (side, input) => { overrideInput[side] = input ? cloneInput(input) : null; },
  reset: (seed = 1) => { prev = next = createState([specs[0], specs[1]], cfg, seed); },
};

// Pose override (pose grid): while any side is posed the sim is paused and the
// views draw the fixture instead of sim state.
const posed: [FighterState | null, FighterState | null] = [null, null];
window.__pose = (side, punch, hand, progress) => {
  const spec = specs[side];
  const f = next.fighters[side];
  posed[side] = punch === 'rest'
    ? restFighterState(spec, cfg, f.pos, f.yaw)
    : punchFixture(spec, cfg, f.pos, f.yaw, punch, hand, progress);
};
window.__focus = -1;
window.__states = () => [posed[0] ?? next.fighters[0], posed[1] ?? next.fighters[1]];

// ── Loop: fixed-step accumulator (CONTRACT §3), render every rAF ──────────────
window.__tick = { frames: 0, simTicks: 0, gameTime: 0, ready: false };
let acc = 0;
let lastMs = 0;
const MAX_FRAME = 0.25;   // clamp so a background tab doesn't spiral
const frameEvents: SimEvent[] = [];

function loop(nowMs: number): void {
  const dt = Math.min(MAX_FRAME, (nowMs - lastMs) / 1000);
  lastMs = nowMs;
  const paused = posed[0] !== null || posed[1] !== null;
  frameEvents.length = 0;

  if (!paused) {
    acc += dt;
    while (acc >= SIM_DT) {
      const inputs: [FrameInput, FrameInput] = [overrideInput[0] ?? liveInput[0], overrideInput[1] ?? liveInput[1]];
      const r = step(next, inputs, cfg);
      prev = next;
      next = r.state;
      frameEvents.push(...r.events);
      window.__tick.simTicks++;
      window.__tick.gameTime = next.time;
      acc -= SIM_DT;
    }
  }
  if (frameEvents.length) { bus.emit(frameEvents); stage.handleEvents(frameEvents); }

  const alpha = paused ? 1 : acc / SIM_DT;
  const shown = window.__states();
  for (const v of views) {
    const s = v.side;
    const ev = frameEvents.filter(e => !('side' in e) || e.side === s || ('target' in e && e.target === s));
    v.apply(posed[s] ?? prev.fighters[s], shown[s]!, alpha, dt, ev);
  }

  const [a, b] = shown as [FighterState, FighterState];
  const d = v2dist(a.pos, b.pos);
  const closeness = 1 - Math.min(1, Math.max(0, (d - 0.6) / 3.0));
  stage.drawHitboxes(shown);
  const f = window.__focus;
  if (f === -1) stage.frame(a.pos, b.pos, closeness, nowMs / 1000, dt);
  else stage.frame(shown[f]!.pos, shown[f]!.pos, 1, nowMs / 1000, dt);

  fps.visible = cfg.debugFps;
  const info = stage.info;
  fps.tick(info.calls, info.triangles);
  window.__tick.frames++;
  if (window.__tick.frames >= 2) window.__tick.ready = true;
  requestAnimationFrame(loop);
}

addEventListener('resize', () => stage.resize());
requestAnimationFrame(t => { lastMs = t; loop(t); });

export { bus, liveInput };

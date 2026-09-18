/**
 * main.ts — app shell (UI workstream). Boots config, panel, stage, the two
 * rigs, and the fixed-step loop: input → sim.step → events → views.
 *
 * Test hooks on window (read by scripts/): __tick, __cfg, __fps, __sim,
 * __pose/__focus (pose grid), __states, __input (ui/input.ts).
 */
import {
  SIM_DT, NULL_INPUT, EventBus, createConfig, cloneInput, frameOf, punchFixture, restFighterState, ROSTER, v2dist,
  type Config, type FighterState, type FrameInput, type Hand, type PunchType, type Side, type SimEvent, type SimState,
} from './core';
import { createState, step } from './sim';
import { aiStep, createAi, type AiState } from './ai';
import { createFighterView } from './rig';
import { Stage } from './render/stage';
import { mountTuningPanel } from './ui/tune';
import { FpsOverlay } from './ui/fps';
import { Hud } from './ui/hud';
import { InputManager, wantsTouch } from './ui/input';
import { CombatAudio } from './ui/audio';

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
    /** The side-1 AI's state (tests). Stale while side 1 is overridden or aiEnabled is off. */
    __ai: { state: () => AiState };
    __pose: (side: Side, punch: PunchType | 'rest', hand: Hand, progress: number) => void;
    /**
     * Replay (filmstrips): run a fresh sim with the fighters `dist` apart, side 0
     * fed `script[i]` (merged over NULL_INPUT) each tick, side 1 idle, for
     * `ticks` ticks, and freeze both fighters there. Deterministic, so a landing
     * and the reaction that follows can be captured frame by frame.
     */
    __replay: (dist: number, script: readonly Partial<FrameInput>[], ticks: number) => void;
    /** -1 = frame both fighters (default); 0/1 = centre the camera on that fighter (pose grid). */
    __focus: -1 | Side;
    __states: () => readonly FighterState[];
  }
}

const params = new URLSearchParams(location.search);
const cfg = createConfig();
if (params.get('ai') === '0') cfg.aiEnabled = false;   // browser checks that want the frozen-guard dummy
window.__cfg = cfg;

const app = document.getElementById('app')!;
const stage = new Stage(app, cfg);
const fps = new FpsOverlay(document.getElementById('fps')!);
if (params.get('tune') === '1') mountTuningPanel(cfg);

// ── Sim + views ──────────────────────────────────────────────────────────────
const specs = [ROSTER[0]!, ROSTER[1]!] as const;
const bus = new EventBus();
new CombatAudio(cfg, bus);   // synthesized SFX on the outcome events; silent until the first click/key (autoplay policy)
const seed = Number(params.get('seed') ?? 1);
let prev: SimState = createState([specs[0], specs[1]], cfg, seed);
let next: SimState = prev;
let ai: AiState = createAi(1, seed, cfg);
const views = [
  createFighterView(0, specs[0], cfg, stage.scene),
  createFighterView(1, specs[1], cfg, stage.scene),
] as const;
const hud = new Hud(document.body, [specs[0].name, specs[1].name]);

// Inputs: side 0 is the player (InputManager → liveInput[0] each frame), side 1
// is the AI (aiStep each sim tick; the frozen-guard dummy when aiEnabled is off).
// Tests can override either side via window.__sim.input; an override on side 1
// also parks the AI so its rng stream does not advance behind the test's back.
const liveInput: [FrameInput, FrameInput] = [cloneInput(NULL_INPUT), cloneInput(NULL_INPUT)];
const overrideInput: [FrameInput | null, FrameInput | null] = [null, null];
const input = new InputManager(cfg, { yaw: () => next.fighters[0].yaw, azimuth: () => stage.inputAzimuth, touch: wantsTouch(params) });

window.__sim = {
  state: () => next,
  input: (side, input) => { overrideInput[side] = input ? cloneInput(input) : null; },
  reset: (s = 1) => { prev = next = createState([specs[0], specs[1]], cfg, s); ai = createAi(1, s, cfg); },
};
window.__ai = { state: () => ai };

// Pose override (pose grid): while any side is posed the sim is paused and the
// views draw a frozen state instead of the live one. Every punch is posed by
// running the real sim — a fresh state, this fighter at its current spot, the
// punch held until `progress` — so the sheet shows the kinetic chain that
// actually plays. `hand` is delivered the way the game does it: the joystick
// held to that side at the press (hook/uppercut listen; jab/cross ignore it).
const posed: [FighterState | null, FighterState | null] = [null, null];
function simPunchPose(side: Side, pos: { x: number; z: number }, yaw: number, punch: PunchType, hand: Hand, progress: number): FighterState | null {
  const fr = frameOf(yaw);
  let s = createState([specs[0], specs[1]], cfg, 1);
  const me = s.fighters[side], opp = s.fighters[side === 0 ? 1 : 0];
  me.pos = { x: pos.x, z: pos.z }; me.yaw = yaw;
  opp.pos = { x: pos.x + fr.fwd.x * 1.6, z: pos.z + fr.fwd.z * 1.6 }; opp.yaw = yaw + Math.PI;   // out of range: pure motion
  const idle = cloneInput(NULL_INPUT);
  for (let i = 0; i < 30; i++) s = step(s, [idle, idle], cfg).state;                          // gloves settle on the guard
  // One tick of press with the stick held to the hand's side, then idle: a
  // held stick would walk the fighter sideways through its own punch.
  const press = cloneInput(NULL_INPUT); press[punch] = true; press.move.x = hand === 'lead' ? -1 : 1;
  const held = cloneInput(NULL_INPUT); held[punch] = true;
  let last: FighterState | null = null;
  for (let i = 0; i < 120; i++) {
    const mine = i === 0 ? press : held;
    const inputs: [FrameInput, FrameInput] = side === 0 ? [mine, idle] : [idle, mine];
    s = step(s, inputs, cfg).state;
    const f = s.fighters[side];
    if (f.punch.type === null) return last;            // not in the table (null) or just finished (the last frame)
    last = f;
    if (f.punch.progress >= progress) return f;
  }
  return last;
}
window.__pose = (side, punch, hand, progress) => {
  const spec = specs[side];
  const f = next.fighters[side];
  if (punch === 'rest') { posed[side] = restFighterState(spec, cfg, f.pos, f.yaw); return; }
  posed[side] = simPunchPose(side, f.pos, f.yaw, punch, hand, progress) ?? punchFixture(spec, cfg, f.pos, f.yaw, punch, hand, progress);
};
window.__replay = (dist, script, ticks) => {
  let s = createState([specs[0], specs[1]], cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  const idle = cloneInput(NULL_INPUT);
  for (let i = 0; i < 30; i++) s = step(s, [idle, idle], cfg).state;
  for (let i = 0; i < ticks; i++) {
    const a: FrameInput = { ...cloneInput(NULL_INPUT), ...(script[i] ?? {}) };
    s = step(s, [a, idle], cfg).state;
  }
  posed[0] = s.fighters[0]; posed[1] = s.fighters[1];
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
  liveInput[0] = input.current();

  if (!paused) {
    acc += dt;
    while (acc >= SIM_DT) {
      let side1 = overrideInput[1];
      if (side1 === null) {
        if (cfg.aiEnabled) { const d = aiStep(ai, next, cfg); ai = d.ai; side1 = d.input; }
        else side1 = liveInput[1];
      }
      const inputs: [FrameInput, FrameInput] = [overrideInput[0] ?? liveInput[0], side1];
      const r = step(next, inputs, cfg);
      prev = next;
      next = r.state;
      frameEvents.push(...r.events);
      window.__tick.simTicks++;
      window.__tick.gameTime = next.time;
      acc -= SIM_DT;
    }
    // Sparring shell: once the FIGHT is over (decision, KO or TKO — rounds
    // and the rest between them run inside the sim) start a fresh one after
    // a beat. The Stage 3 menus and results screen replace this.
    if (next.round.phase === 'over' && cfg.sparRestartSeconds > 0 && next.round.phaseT >= cfg.sparRestartSeconds) {
      prev = next = createState([specs[0], specs[1]], cfg, next.seed);
      ai = createAi(1, next.seed, cfg);
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

  hud.visible = !paused;
  hud.update(next);
  fps.visible = cfg.debugFps;
  const info = stage.info;
  fps.tick(info.calls, info.triangles);
  window.__tick.frames++;
  if (window.__tick.frames >= 2) window.__tick.ready = true;
  requestAnimationFrame(loop);
}

addEventListener('resize', () => stage.resize());
requestAnimationFrame(t => { lastMs = t; loop(t); });

export { bus, liveInput, input };

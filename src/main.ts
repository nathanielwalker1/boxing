/**
 * main.ts — app shell (UI workstream). Boots config, panel, stage, the two
 * rigs, and the fixed-step loop: input → sim.step → events → views.
 *
 * Test hooks on window (read by scripts/): __tick, __cfg, __fps, __sim,
 * __pose/__focus (pose grid), __states, __input (ui/input.ts).
 */
import {
  SIM_DT, NULL_INPUT, EventBus, createConfig, cloneInput, frameOf, punchFixture, restFighterState, ROSTER, v2dist,
  type Config, type FighterSpec, type FighterState, type FighterView, type FrameInput, type Hand, type PunchType, type Side, type SimEvent, type SimState,
} from './core';
import { createState, hurtLevel, step } from './sim';
import { aiStep, createAi, type AiState } from './ai';
import { createFighterView } from './rig';
import { FightFlow } from './ui/flow';
import { Referee } from './ui/referee';
import { Stage } from './render/stage';
import { mountTuningPanel } from './ui/tune';
import { FpsOverlay } from './ui/fps';
import { Hud } from './ui/hud';
import { InputManager, wantsTouch } from './ui/input';
import { CombatAudio } from './ui/audio';
import { ReadOverlay } from './ui/read';

declare global {
  interface Window {
    __tick: { frames: number; simTicks: number; gameTime: number; ready: boolean };
    __cfg: Config;
    __sim: {
      state: () => SimState;
      /** Override one side's input until cleared with null (tests). */
      input: (side: Side, input: FrameInput | null) => void;
      reset: (seed?: number) => void;
      /** Fighters `dist` m apart, facing, settled (tests). */
      place: (dist: number) => void;
      /** Tick-exact input for one side: `inputs[i]` (merged over NULL_INPUT) is fed on the i-th sim tick from now, then the side goes back to its live/AI input (tests). */
      script: (side: Side, inputs: readonly Partial<FrameInput>[]) => void;
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
    __replay: (dist: number, script: readonly Partial<FrameInput>[], ticks: number, script1?: readonly Partial<FrameInput>[]) => void;
    /** -1 = frame both fighters (default); 0/1 = centre the camera on that fighter (pose grid). */
    __focus: -1 | Side;
    __states: () => readonly FighterState[];
    /** The azimuth the stick maps against (the follow camera's orbit less camBehindDeg), radians (tests). */
    __camAz: () => number;
    /** The camera's current dolly distance from the look point, m (tests). */
    __camDist: () => number;
    /** The camera's current elevation, radians (tests: the knockdown shot). */
    __camEl: () => number;
    /** The referee's floor position and yaw, or null when he is off (tests). */
    __ref: () => { pos: { x: number; z: number }; yaw: number } | null;
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
let specs: readonly [FighterSpec, FighterSpec] = [ROSTER[0]!, ROSTER[1]!];
const bus = new EventBus();
new CombatAudio(cfg, bus);   // synthesized SFX on the outcome events; silent until the first click/key (autoplay policy)
const seed = Number(params.get('seed') ?? 1);
let prev: SimState = createState([specs[0], specs[1]], cfg, seed);
let next: SimState = prev;
let ai: AiState = createAi(1, seed, cfg);
const views: [FighterView, FighterView] = [
  createFighterView(0, specs[0], cfg, stage.scene),
  createFighterView(1, specs[1], cfg, stage.scene),
];
const hud = new Hud(document.body, specs, cfg, wantsTouch(params) ? 'top' : 'bottom');
const read = new ReadOverlay(cfg, bus, views);   // the slip's counter window, drawn on the exposed fighter's rim

// The fight flow (menu → select → tale of the tape → fight → results). Tests
// and the pose/replay harness drive the sim directly, so under Playwright
// (navigator.webdriver) or ?menu=0 there is no flow: the fight runs from boot
// and restarts itself (sparRestartSeconds) as it always has. ?menu=1 forces it.
const wantsFlow = params.get('menu') === '1' || (!navigator.webdriver && params.get('menu') !== '0');
let fightNo = 0;
/** A fresh fight between `a` (the player, side 0) and `b`: new state, AI and rigs; the HUD renamed. The views array is mutated in place — the read overlay holds it. */
function startFight(a: FighterSpec, b: FighterSpec): void {
  specs = [a, b];
  const s = seed + fightNo++;
  prev = next = createState([a, b], cfg, s);
  ai = createAi(1, s, cfg);
  for (const side of [0, 1] as const) { views[side].dispose(); views[side] = createFighterView(side, specs[side], cfg, stage.scene); }
  hud.setFighters(specs);
}
const flow = wantsFlow ? new FightFlow(document.body, ROSTER, cfg, bus, { start: startFight, bell: () => bus.emit([{ type: 'bell' }]) }) : null;

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
  place: (dist) => {
    // Tests: put the fighters `dist` apart on the x axis, facing, gloves settled (a fresh, seeded state).
    let s = createState([specs[0], specs[1]], cfg, next.seed);
    s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
    const idle = cloneInput(NULL_INPUT);
    for (let i = 0; i < 30; i++) s = step(s, [idle, idle], cfg).state;
    prev = next = s;
    ai = createAi(1, s.seed, cfg);
  },
  script: (side, inputs) => { scriptInput[side] = inputs.map(i => ({ ...cloneInput(NULL_INPUT), ...i })); },
};
const scriptInput: [FrameInput[] | null, FrameInput[] | null] = [null, null];
/** The next scripted tick for `side`, or null once the script is spent. */
function takeScript(side: Side): FrameInput | null {
  const q = scriptInput[side];
  if (!q) return null;
  const i = q.shift() ?? null;
  if (q.length === 0) scriptInput[side] = null;
  return i;
}
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
window.__replay = (dist, script, ticks, script1 = []) => {
  let s = createState([specs[0], specs[1]], cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  const idle = cloneInput(NULL_INPUT);
  for (let i = 0; i < 30; i++) s = step(s, [idle, idle], cfg).state;
  for (let i = 0; i < ticks; i++) {
    const a: FrameInput = { ...cloneInput(NULL_INPUT), ...(script[i] ?? {}) };
    const b: FrameInput = { ...cloneInput(NULL_INPUT), ...(script1[i] ?? {}) };
    s = step(s, [a, b], cfg).state;
  }
  posed[0] = s.fighters[0]; posed[1] = s.fighters[1];
};
window.__focus = -1;
window.__states = () => [posed[0] ?? next.fighters[0], posed[1] ?? next.fighters[1]];
window.__camAz = () => stage.inputAzimuth;
window.__camDist = () => stage.dollyDistance;
window.__camEl = () => stage.elevation;

// ── Loop: fixed-step accumulator (CONTRACT §3), render every rAF ──────────────
window.__tick = { frames: 0, simTicks: 0, gameTime: 0, ready: false };
let acc = 0;
let lastMs = 0;
let slowMo = { t: 0, scale: 1 };   // wall seconds of slow motion left, and its rate (knockdown, counter, rocked)
let referee: Referee | null = null;
window.__ref = () => referee ? referee.pose : null;
const MAX_FRAME = 0.25;   // clamp so a background tab doesn't spiral
const frameEvents: SimEvent[] = [];

function loop(nowMs: number): void {
  const dt = Math.min(MAX_FRAME, (nowMs - lastMs) / 1000);
  lastMs = nowMs;
  const paused = posed[0] !== null || posed[1] !== null;
  const held = paused || (flow !== null && flow.holdsSim);   // a menu / card is up: the sim waits
  frameEvents.length = 0;
  liveInput[0] = input.current();

  // The fall in slow motion (Stage 3 presentation): for knockdownSlowMoSeconds
  // of wall time after a knockdown the sim is fed knockdownSlowMo of each
  // frame. The sim is unchanged; the referee and the camera take the same
  // slowed time so the whole scene slows together.
  // The reads add their own: a counter or a rock gets a beat of slow motion,
  // and the player's open counter window slows the scene (ui/read.ts). The
  // slowest wins; none of it touches the sim's own clock.
  const slow = Math.min(slowMo.t > 0 ? slowMo.scale : 1, read.timeScale);
  slowMo.t = Math.max(0, slowMo.t - dt);
  const sdt = dt * slow;

  if (!held) {
    acc += sdt;
    while (acc >= SIM_DT) {
      let side1 = takeScript(1) ?? overrideInput[1];
      if (side1 === null) {
        if (cfg.aiEnabled) { const d = aiStep(ai, next, cfg); ai = d.ai; side1 = d.input; }
        else side1 = liveInput[1];
      }
      const inputs: [FrameInput, FrameInput] = [takeScript(0) ?? overrideInput[0] ?? liveInput[0], side1];
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
    if (flow === null && next.round.phase === 'over' && cfg.sparRestartSeconds > 0 && next.round.phaseT >= cfg.sparRestartSeconds) {
      prev = next = createState([specs[0], specs[1]], cfg, next.seed);
      ai = createAi(1, next.seed, cfg);
    }
  }
  if (frameEvents.length) {
    bus.emit(frameEvents);
    stage.handleEvents(frameEvents);
    for (const e of frameEvents) {
      if (e.type === 'counter') slowMo = { t: cfg.readCounterSlowMoSeconds, scale: cfg.readCounterSlowMo };
      else if (e.type === 'rocked') slowMo = { t: cfg.readRockedSlowMoSeconds, scale: cfg.readRockedSlowMo };
    }
    if (frameEvents.some(e => e.type === 'knockdown')) slowMo = { t: cfg.knockdownSlowMoSeconds, scale: cfg.knockdownSlowMo };
  }

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
  // The referee walks on the slowed clock, off while a pose grid / filmstrip is up.
  if (cfg.refEnabled && !referee) referee = new Referee(cfg, stage.scene);
  else if (!cfg.refEnabled && referee) { referee.dispose(); referee = null; }
  if (referee) referee.update(next, frameEvents, sdt, stage.orbitAzimuth, !paused);
  // The knockdown shot: while a man is down (the count, or the KO / TKO he did not beat) the lens goes to him.
  const downSide = next.fighters[0].down ? 0 : next.fighters[1].down ? 1 : -1;
  const shot = !paused && downSide >= 0 && (next.round.phase === 'count' || next.round.phase === 'over') ? { focus: shown[downSide]!.pos } : null;
  const f = window.__focus;
  if (f === -1) stage.frame(a.pos, b.pos, closeness, nowMs / 1000, dt, shot);
  else stage.frame(shown[f]!.pos, shown[f]!.pos, 1, nowMs / 1000, dt);

  hud.visible = !paused && (flow === null || flow.showHud);
  hud.update(next, dt);
  if (flow) flow.update(next, dt, frameEvents);
  read.update(next);
  stage.wobble = hurtLevel(next.fighters[0]) * cfg.readHurtWobble;   // you are rocked: the lens drifts more
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

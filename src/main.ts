/**
 * main.ts — app shell (UI workstream). Boots config, panel, stage, the two
 * rigs, and the fixed-step loop: input → sim.step → events → views.
 *
 * Test hooks on window (read by scripts/): __tick, __cfg, __fps, __sim,
 * __pose/__focus (pose grid), __states, __input (ui/input.ts).
 */
import {
  SIM_DT, NULL_INPUT, EventBus, createConfig, applyHumanMode, cloneInput, frameOf, punchFixture, restFighterState, ROSTER, v2dist,
  type Config, type FighterSpec, type FighterState, type FighterView, type FrameInput, type Hand, type PunchType, type Side, type SimEvent, type SimState,
} from './core';
import { createState, hurtLevel, step } from './sim';
import { aiStep, createAi, type AiState, type StyleParams } from './ai';
import * as aiModule from './ai';
import { createFighterView as createRigView, type RigView } from './rig';
import { createHumanView, humanReady, preloadHuman, setHumanHandsDown } from './human/view';
import { addFighterLights } from './human/body';
import * as THREE from 'three';
import { loadMocapGeo } from './core/mocapLoad';
import { FightFlow, type StartOpts } from './ui/flow';
import { ReplayBuffer, ReplayPlayer } from './ui/replay';
import { Referee } from './ui/referee';
import { Stage, type CameraShot } from './render/stage';
import { mountTuningPanel } from './ui/tune';
import { FpsOverlay } from './ui/fps';
import { Hud } from './ui/hud';
import { InputManager, wantsTouch } from './ui/input';
import { CombatAudio } from './ui/audio';
import { ReadOverlay } from './ui/read';
import { readWindowScale, slowMoAfter } from './ui/slowmo';
import { TelemetryOverlay, type TelemetryProbe } from './ui/telemetry';

declare global {
  interface Window {
    __telemetry: TelemetryProbe;
    __tick: { frames: number; simTicks: number; gameTime: number; ready: boolean; scale: number };
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
      /** A policy for one side, called on EVERY sim tick with the state (tests: a scripted player that reacts tick-exactly whatever the frame rate). null from it = no opinion this tick; null instead of a function clears it. */
      drive: (side: Side, fn: ((s: SimState) => Partial<FrameInput> | null) | null) => void;
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
    /** Audit filmstrips: step a recorded fight (inputs per tick as [moveX, moveY, button bits]) to `tick` and hold both fighters there. */
    __filmFight: (ids: readonly [string, string], seed: number, in0: readonly (readonly number[])[], in1: readonly (readonly number[])[], tick: number) =>
      { tick: number; time: number; phase: string; x0: number; z0: number; x1: number; z1: number; h0: number; h1: number };
    /** Roster ids (lookbook). */
    __roster: () => string[];
    /** Lookbook: show roster fighter `id` alone at the ring centre in a settled rest guard, a held block, or mid-cross. */
    __look: (id: string, kind: 'rest' | 'block' | 'cross', yawDeg?: number) => void;
    /** -1 = frame both fighters (default); 0/1 = centre the camera on that fighter (pose grid). */
    __focus: -1 | Side;
    __states: () => readonly FighterState[];
    /** The azimuth the stick maps against (the follow camera's orbit less camBehindDeg), radians (tests). */
    __camAz: () => number;
    /** The camera's current dolly distance from the look point, m (tests). */
    __camDist: () => number;
    /** The camera's current elevation, radians (tests: the knockdown shot). */
    __camEl: () => number;
    /** The camera's world position and vertical FOV this frame (scripts/camera_occlusion_probe.mjs). */
    __camPos: () => [number, number, number, number];
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
// One quality tier for the whole frame: the fighters' mesh tier (rigQuality)
// follows the stage's tier whenever that changes (boot, or the qualityTier
// slider). Between changes rigQuality can still be set by hand (the lookbook
// forces the high mesh on a software-GL run).
let rigTier = stage.tier;
cfg.rigQuality = rigTier === 2 ? 1 : 0;
const fps = new FpsOverlay(document.getElementById('fps')!);
if (params.get('tune') === '1') mountTuningPanel(cfg);
// Human fighters (?human=1): the realistic skinned boxer on mocap clips instead of the procedural rig. The
// assets load before the first view is built; with the switch off nothing below changes.
if (params.get('human') === '1') cfg.humanBody = true;
// which body (0 v2, 1 m1, 2 m2): ?body=N, or the dev server's VITE_BODY (so a second server on the same code runs the
// whole browser suite on another body, for the m1-vs-m2 A/B)
const bodyParam = params.get('body') ?? (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_BODY;
// (no ?body: each fighter wears the body of his own build, human/view.ts bodyFileFor; ?body=N puts everyone in body N)
const bodyForced = bodyParam !== undefined && bodyParam !== null && /^[0-5]$/.test(bodyParam);
if (bodyForced) cfg.humanBodyFile = Number(bodyParam);
if (cfg.humanBody && !(await preloadHuman(cfg.humanBodyFile, bodyForced))) cfg.humanBody = false;
applyHumanMode(cfg);   // (core/humanMode.ts: does nothing unless cfg.humanBody)
if (cfg.humanBody) cfg.mocapGeo = await loadMocapGeo();   // the sim's punching glove = the drawn mocap glove (core/mocap.ts)
if (cfg.mocapGeo) cfg.mocapOutcome = true;   // outcome first: the sim decides by rule, the drawing conforms (sim/outcome.ts)
// The human fighters' own key + rims (human/body.ts), aimed each frame at the pair's midpoint.
const fighterLights = cfg.humanBody ? addFighterLights(stage.scene) : null;
const lightFocus = new THREE.Vector3();
function createFighterView(side: Side, spec: FighterSpec, c: Config, parent: Stage['scene']): RigView {
  return c.humanBody && humanReady() ? createHumanView(side, spec, c, parent) : createRigView(side, spec, c, parent);
}

// ── Sim + views ──────────────────────────────────────────────────────────────
// (?opp=<roster id>: the opponent outside the menu, for checks against a short or tall man)
let specs: readonly [FighterSpec, FighterSpec] = [ROSTER[0]!, ROSTER.find(r => r.id === params.get('opp')) ?? ROSTER[1]!];
const bus = new EventBus();
const audio = new CombatAudio(cfg, bus);   // synthesized SFX on the outcome events; silent until the first click/key (autoplay policy)
const seed = Number(params.get('seed') ?? 1);
let prev: SimState = createState([specs[0], specs[1]], cfg, seed);
let next: SimState = prev;
let ai: AiState = createAi(1, seed, cfg);
/**
 * The opponent's style for a fight the FLOW started (null = the default style, which is what every test drives).
 * This is the one place the style table and the difficulty reach the AI: `styleFor(spec, cfg, difficulty)` from
 * src/ai (difficulty 0 easy / 1 medium / 2 hard — the menu's choice, which the flow also writes to cfg.aiDifficulty,
 * the single difficulty key). Looked up by name so a build without it still runs on the default style.
 */
let aiStyle: StyleParams | null = null;
function styleForOpponent(spec: FighterSpec, difficulty: number): StyleParams | null {
  const f = (aiModule as unknown as Record<string, unknown>)['styleFor'];
  if (typeof f !== 'function') return null;
  try { return (f as (spec: FighterSpec, cfg: Config, difficulty: number) => StyleParams | null)(spec, cfg, difficulty) ?? null; } catch { return null; }
}
/** A drill's opponent (gym): drives side 1 instead of the AI; null from it hands the tick back to the AI. */
let driver: ((s: SimState) => FrameInput | null) | null = null;
const views: [RigView, RigView] = [
  createFighterView(0, specs[0], cfg, stage.scene),
  createFighterView(1, specs[1], cfg, stage.scene),
];
const hud = new Hud(document.body, specs, cfg, wantsTouch(params) ? 'top' : 'bottom');
const telemetry = new TelemetryOverlay(cfg);   // dev only (cfg.devTelemetry, off by default)
const read = new ReadOverlay(cfg, bus, views);   // the slip's counter window, drawn on the exposed fighter's rim

// The fight flow (menu → select → tale of the tape → fight → results). Tests
// and the pose/replay harness drive the sim directly, so under Playwright
// (navigator.webdriver) or ?menu=0 there is no flow: the fight runs from boot
// and restarts itself (sparRestartSeconds) as it always has. ?menu=1 forces it.
const wantsFlow = params.get('menu') === '1' || (!navigator.webdriver && params.get('menu') !== '0');
// The frame-time overlay is a developer's tool: with the flow on it is off unless the tuning panel is open (the
// checks that read it run without the flow, where it stays on).
if (wantsFlow && params.get('tune') !== '1') cfg.debugFps = false;
let fightNo = 0;
/** A fresh fight between `a` (the player, side 0) and `b`: new state, AI and rigs; the HUD renamed. The views array is mutated in place — the read overlay holds it. */
function startFight(a: FighterSpec, b: FighterSpec, opts: StartOpts | null = null): void {
  const rebuild: [boolean, boolean] = [specs[0].id !== a.id, specs[1].id !== b.id];
  specs = [a, b];
  const s = seed + fightNo++;
  let st = createState([a, b], cfg, s);
  if (opts?.prepare) st = opts.prepare(st);
  prev = next = st;
  aiStyle = opts ? styleForOpponent(b, opts.difficulty) : null;
  driver = opts?.driver ?? null;
  ai = createAi(1, s, cfg, aiStyle);
  for (const side of [0, 1] as const) {
    if (!rebuild[side]) continue;   // the same man: keep his body (a rematch, a drill restarting)
    views[side].dispose(); views[side] = createFighterView(side, specs[side], cfg, stage.scene);
  }
  hud.setFighters(specs);
  buffer.clear(); replay = null; replayDue = false; skipRest = false;
  acc = 0;
}
// The knockdown replay (flow only): the last few seconds of sim, one frame per tick, and the clip being played.
const buffer = new ReplayBuffer();
let replay: { player: ReplayPlayer; shot: CameraShot } | null = null;
let replayDue = false;    // a knockdown is waiting for its replay
let skipRest = false;     // the corner card has gone: run the sim's rest off
let acc = 0;
const flow = wantsFlow ? new FightFlow(document.body, ROSTER, cfg, bus, {
  start: startFight,
  preview: spec => {
    if (specs[0].id === spec.id) return;
    specs = [spec, specs[1]];
    views[0].dispose(); views[0] = createFighterView(0, spec, cfg, stage.scene);
  },
  bell: () => bus.emit([{ type: 'bell' }]),
  skipRest: () => { skipRest = true; },
  skipReplay: () => endReplay(),
  crowd: (level, cheer) => { stage.setExcitement(level); if (cheer) stage.react('decision', 0.7); },
  audioPaused: on => audio.setPaused(on),
}, wantsTouch(params)) : null;

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
  drive: (side, fn) => { drive[side] = fn; },
};
const scriptInput: [FrameInput[] | null, FrameInput[] | null] = [null, null];
const drive: [((s: SimState) => Partial<FrameInput> | null) | null, ((s: SimState) => Partial<FrameInput> | null) | null] = [null, null];
/** A test's tick-exact policy for `side`, if one is set and has an answer this tick. */
function driven(side: Side): FrameInput | null {
  const fn = drive[side];
  const i = fn ? fn(next) : null;
  return i ? { ...cloneInput(NULL_INPUT), ...i } : null;
}
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
    if (progress < 0 ? f.punch.resolved : f.punch.progress >= progress) return f;   // progress < 0: the tick of the hit test (full extension)
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
// A whole recorded fight, frame by frame (scripts/fight_film.mjs — the audit's filmstrips of real exchanges). The
// fight was run in Node (a scripted bot against the AI) and every tick's input for both sides recorded; here the
// same deterministic sim is stepped on those inputs to `tick`, every tick fed through the two rigs with its events
// (so springs, faces, falls and sprays are what they were), and both fighters are held there. Cached while the
// fight is the same and time moves forward. Returns a fingerprint of the state so the script can prove the browser
// reached the same state Node did.
{
  let key = '', at = 0, s: SimState | null = null;
  const unpack = (p: readonly number[]): FrameInput => {
    const b = p[2] ?? 0;
    return { ...cloneInput(NULL_INPUT), move: { x: p[0] ?? 0, y: p[1] ?? 0 }, jab: !!(b & 1), cross: !!(b & 2), hook: !!(b & 4), uppercut: !!(b & 8), block: !!(b & 16), level: !!(b & 32) };
  };
  window.__filmFight = (ids, fightSeed, in0, in1, tick) => {
    const a = ROSTER.find(f => f.id === ids[0]), b = ROSTER.find(f => f.id === ids[1]);
    if (!a || !b) throw new Error(`__filmFight: unknown fighter in ${ids.join(' v ')}`);
    const k = `${ids.join('|')}|${fightSeed}|${in0.length}`;
    const feeds = [0, 1].map(side => window.__rig?.[side as Side]);
    for (const f of feeds) f?.freeze?.(false);
    if (k !== key || tick < at || !s) {
      if (specs[0].id !== a.id || specs[1].id !== b.id) startFight(a, b);
      s = createState([a, b], cfg, fightSeed); key = k; at = 0;
    }
    for (; at < tick && at < in0.length; at++) {
      const r = step(s, [unpack(in0[at]!), unpack(in1[at]!)], cfg);
      for (const side of [0, 1] as const) {
        feeds[side]?.feed?.(s.fighters[side], r.state.fighters[side], r.events.filter(e => !('side' in e) || e.side === side || ('target' in e && e.target === side)));
      }
      s = r.state;
    }
    posed[0] = s.fighters[0]; posed[1] = s.fighters[1];
    for (const f of feeds) f?.freeze?.(true);
    const [p, q] = s.fighters;
    return { tick: at, time: s.time, phase: s.round.phase, x0: p.pos.x, z0: p.pos.z, x1: q.pos.x, z1: q.pos.z, h0: p.health, h1: q.health };
  };
}
// Lookbook (scripts/lookbook.mjs): roster fighter `id` alone at the ring centre
// facing +x, in a sim-settled pose; the other fighter is parked out of sight.
window.__roster = () => ROSTER.map(f => f.id);
window.__look = (id, kind, yawDeg = 0) => {
  const a = ROSTER.find(f => f.id === id);
  if (!a) throw new Error(`__look: no fighter '${id}'`);
  const b = ROSTER.find(f => f.id !== id)!;
  if (specs[0].id !== a.id || specs[1].id !== b.id) startFight(a, b);
  const origin = { x: 0, z: 0 };
  const yaw = yawDeg * Math.PI / 180;
  let st: FighterState | null;
  if (kind === 'cross') st = simPunchPose(0, origin, yaw, 'cross', 'rear', -1);
  else {
    let s = createState([specs[0], specs[1]], cfg, 1);
    s.fighters[0].pos = { x: 0, z: 0 }; s.fighters[0].yaw = yaw;
    s.fighters[1].pos = { x: Math.cos(yaw) * 1.6, z: Math.sin(yaw) * 1.6 }; s.fighters[1].yaw = yaw + Math.PI;
    const idle = cloneInput(NULL_INPUT);
    const mine = cloneInput(NULL_INPUT); mine.block = kind === 'block';
    for (let i = 0; i < 40; i++) s = step(s, [mine, idle], cfg).state;
    st = s.fighters[0];
  }
  posed[0] = st ?? restFighterState(a, cfg, origin, yaw);
  posed[1] = restFighterState(b, cfg, { x: 60, z: 60 }, 0);
  window.__focus = 0;
};
window.__focus = -1;
// (scripts/live_contact_probe.mjs: hold the camera and the HUD on a state the script stepped itself)
(window as unknown as { __setPosed: (a: FighterState | null, b: FighterState | null) => void }).__setPosed = (a, b) => { posed[0] = a; posed[1] = b; };
window.__states =() =>[posed[0] ?? next.fighters[0], posed[1] ?? next.fighters[1]];
window.__camAz = () => stage.inputAzimuth;
window.__camDist = () => stage.dollyDistance;
window.__camEl = () => stage.elevation;
window.__camPos = () => { const p = stage.camera.position; return [p.x, p.y, p.z, stage.camera.fov]; };

// ── Loop: fixed-step accumulator (CONTRACT §3), render every rAF ──────────────
window.__tick = { frames: 0, simTicks: 0, gameTime: 0, ready: false, scale: 1 };
let lastMs = 0;
let slowMo = { t: 0, scale: 1 };   // wall seconds of slow motion left, and its rate (knockdown, counter, rocked)
let referee: Referee | null = null;
window.__ref = () => referee ? referee.pose : null;
// (test hook) is the knockdown replay playing right now
(window as unknown as { __replayOn: () => boolean }).__replayOn = () => !!replay;
// (test hook) play the last knockdown's replay again now (probes: the same clip under different settings)
(window as unknown as { __replayStart: () => boolean }).__replayStart = () => { startReplay(); return !!replay; };
const MAX_FRAME = 0.25;   // clamp so a background tab doesn't spiral
const frameEvents: SimEvent[] = [];
let boardText = '';

/** One sim tick: inputs (script → test override → a drill's driver → the AI → live), step, events, the replay's memory. */
function tickOnce(): void {
  let side1 = takeScript(1) ?? overrideInput[1] ?? driven(1);
  if (side1 === null && driver) side1 = driver(next);
  if (side1 === null) {
    if (cfg.aiEnabled) { const d = aiStep(ai, next, cfg); ai = d.ai; side1 = d.input; }
    else side1 = liveInput[1];
  }
  const inputs: [FrameInput, FrameInput] = [takeScript(0) ?? overrideInput[0] ?? driven(0) ?? liveInput[0], side1];
  const r = step(next, inputs, cfg);
  prev = next;
  next = r.state;
  frameEvents.push(...r.events);
  telemetry.tick(prev, next, r.events);
  if (flow) buffer.push({ state: next, events: r.events, ref: referee ? referee.snapshot() : null });
  window.__tick.simTicks++;
  window.__tick.gameTime = next.time;
}

/** Cut the seconds round the last knockdown out of the buffer and start playing them from the reverse side, low and close. */
function startReplay(): void {
  replayDue = false;
  const clip = buffer.clipAround(Math.round(cfg.flowReplaySeconds * 60), Math.round(cfg.flowReplayAfterSeconds * 60));
  if (!clip || clip.frames.length < 12) return;
  preroll(clip.pre.concat(clip.frames.slice(0, 1)), true);   // the rig's springs (cloth, hair, feet) arrive at the clip's first frame settled
  const at = clip.frames[clip.at]!.state.fighters;
  const frames = clip.frames;   // the sim runs a fallen man's downT through the `over` phase itself (SIM phase 4), so the clip needs no patching
  replay = {
    player: new ReplayPlayer(frames, clip.at),
    shot: {
      key: 'replay', cut: true, lambda: 6,
      focus: { x: (at[0].pos.x + at[1].pos.x) / 2, z: (at[0].pos.z + at[1].pos.z) / 2 },
      azimuth: stage.orbitAzimuth + cfg.flowReplayAzimuthDeg * Math.PI / 180,
      dist: cfg.flowReplayDist, elevationDeg: cfg.flowReplayElevationDeg, lookY: 1.1, fov: cfg.camFovMin,
    },
  };
}

/** Walk the rigs through `frames` at the fixed step without drawing them, so secondary motion is settled on the last one (the replay's cuts). */
// (the human views have no window.__rig: until 2026-11-23 they were never settled, and a replay opened with the fallen
//  man's pose carried into the clip's first second — the knockdown punch itself — by every spring and filter in the draw)
// (withEvents: the frames' own events go in too, all but the last frame's, which the replay player delivers itself)
function preroll(frames: readonly { state: SimState; events?: readonly SimEvent[] }[], withEvents = false): void {
  const human = (window as unknown as { __humanFeeds?: Partial<Record<Side, { feed(p: FighterState, n: FighterState, e: readonly SimEvent[]): void }>> }).__humanFeeds;
  for (let i = 1; i < frames.length; i++) {
    for (const side of [0, 1] as const) {
      const f = cfg.humanBody ? human?.[side] : window.__rig?.[side];
      const ev = cfg.humanBody && withEvents && i < frames.length - 1 ? (frames[i]!.events ?? []).filter(e => !('side' in e) || e.side === side || ('target' in e && e.target === side)) : [];
      f?.feed?.(frames[i - 1]!.state.fighters[side], frames[i]!.state.fighters[side], ev);
    }
  }
}

/** The replay is over (played out or skipped): back to the live fight, the rigs settled on it. */
function endReplay(): void {
  if (replay) preroll(buffer.tail(24));
  replay = null; replayDue = false;
}


const FLAGS = ['jab', 'cross', 'hook', 'uppercut', 'block', 'level'] as const;
const swallowed = new Set<typeof FLAGS[number]>();   // buttons held when the fight resumed: ignored until let go
let wasHeld = true;

function loop(nowMs: number): void {
  const dt = Math.min(MAX_FRAME, (nowMs - lastMs) / 1000);
  lastMs = nowMs;
  // Human fighters: their own punch speed (panel-tunable) and no referee (he is still the old body and walks across the camera).
  applyHumanMode(cfg);   // (core/humanMode.ts: does nothing unless cfg.humanBody)
  const paused = posed[0] !== null || posed[1] !== null;
  const held = paused || replay !== null || (flow !== null && flow.holdsSim);   // a menu / card / replay is up: the sim waits
  frameEvents.length = 0;
  liveInput[0] = input.current();
  // A button that skipped a card, a replay or the walk (or was down when a pause ended) is not a punch: whatever is
  // held at the moment the fight resumes is ignored until it is let go.
  if (flow) {
    if (wasHeld && !held) for (const k of FLAGS) if (liveInput[0][k]) swallowed.add(k);
    for (const k of [...swallowed]) { if (liveInput[0][k]) liveInput[0][k] = false; else swallowed.delete(k); }
  }
  wasHeld = held;
  if (stage.tier !== rigTier) { rigTier = stage.tier; cfg.rigQuality = rigTier === 2 ? 1 : 0; }

  // The fall in slow motion (Stage 3 presentation): for knockdownSlowMoSeconds
  // of wall time after a knockdown the sim is fed knockdownSlowMo of each
  // frame. The sim is unchanged; the referee and the camera take the same
  // slowed time so the whole scene slows together.
  // The reads add their own: a counter or a rock gets a beat of slow motion,
  // and the player's open counter window slows the scene (ui/read.ts). The
  // slowest wins; none of it touches the sim's own clock.
  // (Polish phase: the slow motion waits for the sim's hit-stop to end. The freeze is counted in sim ticks, so slowing
  // the ticks stretched it — a 130 ms freeze under 0.3× was ~375 ms of a still picture.)
  const frozen = cfg.showSlowAfterStop && next.hitStop > 0;
  // hitStopV2 (anim 2.4): no read-window slow motion in live play (knockdowns and replays keep theirs).
  const slow = Math.min(slowMo.t > 0 && !frozen ? slowMo.scale : 1, readWindowScale(cfg, read.timeScale));
  window.__tick.scale = slow;   // the time scale the host applied this frame (tests read it instead of timing the wall clock)
  if (!frozen) slowMo.t = Math.max(0, slowMo.t - dt);
  const sdt = dt * slow;

  if (!held) {
    // The corner card has gone: the sim's own rest is run off in one go, so the bell comes now.
    if (skipRest) {
      skipRest = false;
      for (let i = 0; i < 60 * 60 && next.round.phase === 'between'; i++) tickOnce();
      acc = 0;
    }
    acc += sdt;
    while (acc >= SIM_DT) { tickOnce(); acc -= SIM_DT; }
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
    // A counter, a rock, a combination's finisher: a beat of slow motion each. They never stack — the slowest wins.
    // hitStopV2: a counter, a rock and a finisher get their weight from the sim's hit-stop, not from slow motion
    // (the 'counter' event is the hook the sound / crowd / reaction layers use); ui/slowmo.ts is the rule.
    slowMo = slowMoAfter(slowMo, frameEvents, cfg);
    if (frameEvents.some(e => e.type === 'knockdown')) {
      if (flow && flow.wantsReplay && cfg.flowReplayOn) replayDue = true;
    }
  }
  // The knockdown replay: after the live slow-motion fall, once the referee has reached flowReplayAtCount (or the
  // fight is over). The sim is held while it plays, so the count picks up where it stopped.
  if (replayDue && !replay) {
    const ph = next.round.phase;
    if (!flow || !cfg.flowReplayOn || (ph !== 'count' && ph !== 'over')) replayDue = false;   // he is up already, or the fight was left
    else if (flow.wantsReplay && slowMo.t <= 0 && (ph === 'over' || next.round.count >= cfg.flowReplayAtCount)) startReplay();
  }

  // What is drawn: the live fight, or a pose grid's frozen states, or the replay's clip, or a menu's scene.
  const scene = paused || replay || !flow ? null : flow.scene(dt, stage.orbitAzimuth);
  setHumanHandsDown(flow !== null && flow.showsFighter);
  const staged = scene?.fighters ?? null;   // a menu's own figures (null = the live fight, perhaps under a directed shot)
  let alpha = paused ? 1 : acc / SIM_DT;
  let drawPrev: readonly [FighterState, FighterState] = [posed[0] ?? prev.fighters[0], posed[1] ?? prev.fighters[1]];
  let shown: readonly FighterState[] = window.__states();
  let viewEvents: readonly SimEvent[] = frameEvents;
  let refSnap: FighterState | null = null;
  if (replay && !paused) {
    const fr = replay.player.advance(dt * 60 * cfg.flowReplaySpeed);
    drawPrev = fr.prev.state.fighters; shown = fr.next.state.fighters; alpha = fr.alpha; viewEvents = fr.events;
    refSnap = fr.next.ref;
  } else if (staged) {
    drawPrev = staged.prev; shown = staged.next; alpha = staged.alpha; viewEvents = scene!.events ?? [];
  }
  // Human mode: the views' own springs (continuity, body travel, hit whip) run on the time the fighters are SHOWN in, so
  // a slow-motion replay or the knockdown slow motion draws the same picture as live play (contact included), only slower.
  const viewDt = !cfg.humanBody ? dt : Math.min(cfg.humanViewDtMax, replay && !paused ? dt * cfg.flowReplaySpeed : staged ? dt : dt * slow);
  // A pause is a literal pause (Nate 2026-11-19): the human views run their clips, springs and idle life on their own clock,
  // so with the sim held they kept shifting and breathing under the pause menu. They are simply not advanced while it is up.
  const frozenViews = cfg.humanBody && flow !== null && flow.isPaused;
  for (const v of views) {
    if (frozenViews) break;
    const s = v.side;
    const ev = viewEvents.filter(e => !('side' in e) || e.side === s || ('target' in e && e.target === s));
    v.apply(drawPrev[s], shown[s]!, alpha, viewDt, ev);
  }

  const [a, b] = shown as [FighterState, FighterState];
  const d = v2dist(a.pos, b.pos);
  const closeness = 1 - Math.min(1, Math.max(0, (d - 0.6) / 3.0));
  stage.drawHitboxes(shown);
  // The referee walks on the slowed clock, off while a pose grid / filmstrip is up.
  if (cfg.refEnabled && !referee) referee = new Referee(cfg, stage.scene);
  else if (!cfg.refEnabled && referee) { referee.dispose(); referee = null; }
  if (referee) {
    if (replay && refSnap) referee.draw(refSnap, dt);                                              // the replay: where he stood then
    else if (scene && staged) referee.update(scene.refSim ?? next, [], dt, stage.orbitAzimuth, scene.refSim !== null, scene.refSnap ?? false);   // a menu: off, or with the menu's two men
    else if (!replay) referee.update(next, frameEvents, sdt, stage.orbitAzimuth, !paused && !(flow !== null && flow.hidesReferee));
  }
  // The knockdown shot: while a man is down (the count, or the KO / TKO he did not beat) the lens goes to him.
  const downSide = next.fighters[0].down ? 0 : next.fighters[1].down ? 1 : -1;
  const countShot: CameraShot | null = !paused && downSide >= 0 && (next.round.phase === 'count' || next.round.phase === 'over') ? { focus: next.fighters[downSide as Side].pos } : null;
  const shot = paused ? null : replay ? replay.shot : scene ? scene.shot : countShot;
  const f = window.__focus;
  if (f === -1) stage.frame(a.pos, b.pos, closeness, nowMs / 1000, dt, shot);
  else stage.frame(shown[f]!.pos, shown[f]!.pos, 1, nowMs / 1000, dt);
  if (fighterLights) { lightFocus.set((a.pos.x + b.pos.x) / 2, 1.2, (a.pos.z + b.pos.z) / 2); fighterLights.update(stage.camera, lightFocus); }
  if (replay && replay.player.done) endReplay();

  // The hanging scoreboard carries the round and the clock during a flow fight (the sponsor card otherwise).
  if (flow) {
    const r = next.round;
    const text = flow.inFight ? `ROUND ${r.index + 1}|${Math.floor(Math.max(0, r.clock) / 60)}:${String(Math.floor(Math.max(0, r.clock) % 60)).padStart(2, '0')}` : '';
    if (text !== boardText) { boardText = text; stage.setBoardText(text ? text.split('|') : null); }
  }

  hud.visible = !paused && !replay && (flow === null || flow.showHud);
  hud.update(next, dt);
  if (flow) { flow.replaying = replay !== null; flow.replayDue = replayDue; flow.update(next, dt, frameEvents); }
  // The audio's own clock and state (the crowd bed, the corner's voice): once a frame, quiet while the pause is up.
  // (Without the flow there is no pause menu: the audio keeps whatever a test set through window.__audio.setPaused.)
  // (a held sim keeps its last velocities: fed a running clock, the footfall scuffs kept firing under the pause menu)
  audio.update(next, held ? 0 : sdt, flow ? flow.isPaused : window.__audio?.paused() ?? false);
  const offLive = staged !== null || replay !== null;   // the live fight is not what is on screen
  read.update(next, offLive);
  stage.wobble = offLive ? 0 : hurtLevel(next.fighters[0]) * cfg.readHurtWobble;   // you are rocked: the lens drifts more
  fps.visible = cfg.debugFps && !(flow !== null && flow.holdsSim);   // never over a menu or a card
  const info = stage.info;
  fps.tick(info.calls, info.triangles);
  window.__tick.frames++;
  if (window.__tick.frames >= 2) window.__tick.ready = true;
  requestAnimationFrame(loop);
}

addEventListener('resize', () => stage.resize());
requestAnimationFrame(t => { lastMs = t; loop(t); });

export { bus, liveInput, input };

/**
 * main.ts — app shell (UI workstream). Boots config, panel, stage, and the
 * fixed-step loop. Stage 0: no sim yet — the loop drives a tick counter and
 * two fixture fighters stand in the ring so hitbox debug and the pose grid
 * have something to draw.
 *
 * Test hooks on window (read by scripts/): __tick, __cfg, __fps, __pose.
 */
import {
  SIM_DT, createConfig, restFighterState, punchFixture, ROSTER, v2dist,
  type Config, type FighterState, type Hand, type PunchType, type Side,
} from './core';
import { Stage } from './render/stage';
import { mountTuningPanel } from './ui/tune';
import { FpsOverlay } from './ui/fps';

declare global {
  interface Window {
    __tick: { frames: number; simTicks: number; gameTime: number; ready: boolean };
    __cfg: Config;
    __pose: (side: Side, punch: PunchType | 'rest', hand: Hand, progress: number) => void;
    __states: () => readonly FighterState[];
    /** -1 = frame both fighters (default); 0/1 = centre the camera on that fighter (pose grid). */
    __focus: -1 | Side;
  }
}

const params = new URLSearchParams(location.search);
const cfg = createConfig();
window.__cfg = cfg;

const app = document.getElementById('app')!;
const stage = new Stage(app, cfg);
const fps = new FpsOverlay(document.getElementById('fps')!);
if (params.get('tune') === '1') mountTuningPanel(cfg);

// ── Stage-0 stand-ins for the sim ─────────────────────────────────────────────
const red = ROSTER[0]!, blue = ROSTER[1]!;
const START = 1.2;   // metres from centre, each side
const states: [FighterState, FighterState] = [
  restFighterState(red, cfg, { x: -START, z: 0 }, 0),
  restFighterState(blue, cfg, { x: START, z: 0 }, Math.PI),
];
window.__states = () => states;
window.__focus = -1;
window.__pose = (side, punch, hand, progress) => {
  const spec = side === 0 ? red : blue;
  const pos = side === 0 ? { x: -START, z: 0 } : { x: START, z: 0 };
  const yaw = side === 0 ? 0 : Math.PI;
  states[side] = punch === 'rest' ? restFighterState(spec, cfg, pos, yaw) : punchFixture(spec, cfg, pos, yaw, punch, hand, progress);
};

// ── Loop: fixed-step accumulator (CONTRACT §3), render every rAF ──────────────
window.__tick = { frames: 0, simTicks: 0, gameTime: 0, ready: false };
let acc = 0;
let last = performance.now();
const MAX_FRAME = 0.25;   // clamp so a background tab doesn't spiral

function loop(nowMs: number): void {
  const now = nowMs / 1000;
  let dt = Math.min(MAX_FRAME, now - last / 1000);
  last = nowMs;
  acc += dt;
  while (acc >= SIM_DT) {
    // sim.step goes here in Stage 1
    window.__tick.simTicks++;
    window.__tick.gameTime += SIM_DT;
    acc -= SIM_DT;
  }

  const [a, b] = states;
  const d = v2dist(a.pos, b.pos);
  const closeness = 1 - Math.min(1, Math.max(0, (d - 0.6) / 3.0));
  stage.drawHitboxes(states);
  const f = window.__focus;
  if (f === -1) stage.frame(a.pos, b.pos, closeness, now, dt);
  else stage.frame(states[f].pos, states[f].pos, 1, now, dt);

  fps.visible = cfg.debugFps;
  const info = stage.info;
  fps.tick(info.calls, info.triangles);
  window.__tick.frames++;
  if (window.__tick.frames >= 2) window.__tick.ready = true;
  requestAnimationFrame(loop);
}

addEventListener('resize', () => stage.resize());
requestAnimationFrame(t => { last = t; loop(t); });

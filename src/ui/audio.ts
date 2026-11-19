/**
 * ui/audio.ts — the game's sound. Every sound is SYNTHESISED at runtime from
 * the recipes in ui/audio/recipes.ts — no files, no licensing, and every
 * characteristic of every hit is a number there (CONTRACT: no external
 * assets). Two buses under one master and a limiter:
 *   impact  punches by class, GRADE, variant and combination; blocks that get
 *           heavier as the guard wears; slips past the ear; footwork; the bell
 *   crowd   a continuous bed that rises with the fight (ui/audio/crowd.ts)
 *           and the house's reactions (oohs, gasps, olés, roars, groans,
 *           grumbles, applause)
 * Which sounds an event asks for is decided in ui/audio/map.ts (pure, shared
 * with the offline renderer, scripts/audio_render.mjs); how a recipe becomes
 * nodes is ui/audio/voice.ts. The crowd follows render/mood.ts — the same
 * excitement value and the same reactions the stands are drawn from.
 *
 * NOTHING here decides anything. It subscribes to the event bus and the mood
 * and makes a noise about outcomes the sim already resolved. Knobs live in
 * config (group `audio`). `window.__audioLog` records what was asked for
 * (name, pitch, gain) so a headless check can assert on it without a sound
 * device. Silent until the first user gesture (autoplay policy); a failed
 * sound is a silent one, never a throw.
 *
 * The host's ONE per-frame call: `update(state, dt, paused)` — footfalls and
 * rope creak need the fighters' state, and a pause ducks the crowd. Until the
 * host calls it, a fallback reads the same things off the window test hooks
 * ten times a second.
 */
import type { Config, EventBus, SimEvent, SimState } from '../core';
import { mood, type Reaction } from '../render/mood';
import { RECIPES, type Recipe } from './audio/recipes';
import { CrowdBed } from './audio/crowd';
import { buildMaster, duckBus, makeNoise, playVoice } from './audio/voice';
import { duckForEvent, newVoiceMemory, voicesForEvent, voicesForReaction, type VoiceReq } from './audio/map';

export interface AudioLogEntry { name: string; pitch: number; gain: number; t: number }
declare global {
  interface Window {
    __audioLog?: AudioLogEntry[];
    /** Probes for scripts/audio_check.mjs: the context's state (null before the first gesture), whether the crowd bed is playing, whether the crowd is ducked for a pause; `emit` feeds events through the same path the bus does. */
    __audio?: { state: () => string | null; bed: () => boolean; paused: () => boolean; emit: (events: readonly SimEvent[]) => void; setPaused: (on: boolean) => void };
  }
}
/** The bell's extra partials: a hum an octave under the strike tone and inharmonic overtones (ratios of a struck bell, not a chord), all decaying; the recipe's own layers supply the strike tone and its click. */
const BELL_PARTIALS: Recipe = {
  gain: 0.5,
  layers: [
    { type: 'tone', gain: 0.45, attack: 0.002, decay: 1.9, wave: 'sine', freq: 590, freqEnd: 585 },
    { type: 'tone', gain: 0.30, attack: 0.002, decay: 1.3, wave: 'sine', freq: 1180 * 1.51, freqEnd: 1180 * 1.5 },
    { type: 'tone', gain: 0.22, attack: 0.002, decay: 0.8, wave: 'sine', freq: 1180 * 2.76, freqEnd: 1180 * 2.74 },
    { type: 'tone', gain: 0.12, attack: 0.002, decay: 0.45, wave: 'sine', freq: 1180 * 5.4, freqEnd: 1180 * 5.35 },
  ],
};
const LOG_MAX = 80;
const BED_TICK_MS = 100;

export class CombatAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private unavailable = false;
  private impactBus: GainNode | null = null;
  private crowdBus: GainNode | null = null;
  private bed: CrowdBed | null = null;
  private paused = false;
  private hosted = false;                       // the host calls update(): the window-hook fallback stands down
  private walked: [number, number] = [0, 0];    // metres each fighter has travelled since his last footfall
  private ropeAgo: [number, number] = [9, 9];   // seconds since each fighter's ropes last creaked
  private lastFallback = 0;
  readonly log: AudioLogEntry[] = [];

  constructor(private readonly cfg: Config, bus: EventBus) {
    window.__audioLog = this.log;
    window.__audio = {
      state: () => this.ctx?.state ?? null, bed: () => this.bed?.running ?? false, paused: () => this.paused,
      // What main.ts does with a frame's events, in one call: the bus path (here) and the stage's (the mood, whose reactions come back as crowd voices).
      emit: events => { mood.handle(events, this.cfg); for (const e of events) this.onEvent(e); },
      setPaused: on => this.setPaused(on),
    };
    // The context is created inside the first user gesture (not at boot):
    // Chrome logs a warning for a context created before any gesture, and a
    // headless check with no gesture at all must stay silent, not warn.
    this.installUnlock();
    bus.onAny(e => this.onEvent(e));
    mood.on(r => this.onReaction(r));
    // Ring ambience and the pause duck work before the host adopts update(): see the header.
    window.setInterval(() => { if (!this.hosted) this.fallback(); }, BED_TICK_MS);
  }

  private onEvent(e: SimEvent): void {
    try {
      for (const v of voicesForEvent(e, this.cfg, 0, this.memory)) this.request(v);
      // A flush land or a finisher: the crowd is pulled down for a beat, so the hit has the room to itself and the answer arrives after it.
      const duck = duckForEvent(e, this.cfg);
      if (duck && this.ctx && this.crowdBus && this.cfg.audioCrowdEnabled && !this.paused) {
        const t = this.ctx.currentTime;
        duckBus(this.crowdBus.gain, this.cfg.audioCrowdVolume * this.cfg.audioMasterVolume * this.cfg.audioCrowdGain, t, duck.depth, duck.hold);
        this.duckUntil = t + duck.hold + 0.3;
      }
      // The bell also reaches the bus from the fight flow, which the stage never sees: tell the mood (it applauds once per bell).
      if (e.type === 'bell') mood.bell(this.cfg);
    } catch { /* feedback, never state */ }
  }

  private onReaction(r: Reaction): void {
    try { for (const v of voicesForReaction(r, this.cfg)) this.request(v); } catch { /* feedback, never state */ }
  }

  private request(v: VoiceReq): void { this.play(v.name, v.power ?? 1, v); }
  private memory = newVoiceMemory();
  private duckUntil = 0;   // context seconds until which the crowd bus belongs to a duck (levels() leaves it alone)

  /**
   * The host's per-frame call (main.ts, once per rendered frame, after the sim
   * steps): footfalls on the canvas by distance travelled, rope creak while a
   * fighter leans on the ropes, and the pause duck. `dt` = the (slowed) frame
   * seconds; `paused` = the pause menu is up.
   */
  update(state: SimState, dt: number, paused = false): void {
    this.hosted = true;
    this.ambience(state, dt);
    this.setPaused(paused);
  }

  /** Duck the crowd for a pause (the room goes distant, not dead); impacts cannot happen while paused. */
  setPaused(on: boolean): void {
    if (on === this.paused) return;
    this.paused = on;
    this.levels();
  }

  private fallback(): void {
    const w = window as unknown as { __sim?: { state: () => SimState }; __flow?: { state: () => { paused: boolean; screen: string } } };
    const now = performance.now();
    const dt = Math.min(0.25, (now - this.lastFallback) / 1000);
    this.lastFallback = now;
    try {
      const flow = w.__flow?.state();
      if (flow) this.setPaused(flow.paused);
      const live = !flow || (flow.screen === 'fight' && !flow.paused);
      const s = w.__sim?.state();
      if (s && live && s.round.phase === 'fighting') this.ambience(s, dt);
    } catch { /* hooks absent or mid-teardown */ }
  }

  private ambience(state: SimState, dt: number): void {
    const c = this.cfg;
    if (dt <= 0) return;
    for (const side of [0, 1] as const) {
      const f = state.fighters[side];
      const speed = Math.hypot(f.vel.x, f.vel.z);
      if (f.down) { this.walked[side] = 0; continue; }
      this.walked[side] += speed * dt;
      if (this.walked[side] >= c.audioFootStep) {
        this.walked[side] = 0;
        this.play('footfall', c.audioFootGain * Math.min(2, 0.5 + speed), { pitch: side === 0 ? 1 : 0.92 });
      }
      this.ropeAgo[side] += dt;
      if (f.ropes > c.audioRopeAt && speed > 0.25 && this.ropeAgo[side] > 1.1) {
        this.ropeAgo[side] = 0;
        this.play('ropeCreak', c.audioRopeGain * f.ropes);
      }
    }
  }

  /** Autoplay policy: create the context inside a real user gesture and resume it there; unhook once it runs. */
  private installUnlock(): void {
    const unlock = (): void => {
      if (this.unavailable) return;
      try {
        if (!this.ctx) {
          const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          this.ctx = Ctor ? new Ctor() : null;
          if (!this.ctx) { this.unavailable = true; return; }
          this.buildGraph(this.ctx);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        if (this.ctx.state === 'running') for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.removeEventListener(ev, unlock);
      } catch {
        this.unavailable = true;
        this.ctx = null;
      }
    };
    for (const ev of ['pointerdown', 'touchstart', 'keydown']) window.addEventListener(ev, unlock);
  }

  /** impact + crowd → limiter → out; then the crowd bed, and the slow tick that keeps levels on the config and the mood. */
  private buildGraph(ctx: AudioContext): void {
    const limiter = buildMaster(ctx, this.cfg.audioCeilingDb);
    this.impactBus = ctx.createGain(); this.impactBus.connect(limiter);
    this.crowdBus = ctx.createGain(); this.crowdBus.connect(limiter);
    this.noise = makeNoise(ctx);
    this.levels();
    try { this.bed = new CrowdBed(ctx, this.cfg, this.crowdBus, this.noise); } catch { this.bed = null; }
    window.setInterval(() => {
      try { this.levels(); this.bed?.update(mood.value, mood.hush); } catch { /* feedback, never state */ }
    }, BED_TICK_MS);
  }

  private levels(): void {
    const c = this.cfg;
    if (!this.ctx || !this.impactBus || !this.crowdBus) return;
    const t = this.ctx.currentTime;
    this.impactBus.gain.setTargetAtTime(c.audioImpactVolume, t, 0.05);
    const duck = this.paused ? c.audioPauseDuck : 1;
    if (!this.paused && t < this.duckUntil) return;   // a flush land's duck is on the bus: let it finish
    this.crowdBus.gain.setTargetAtTime(c.audioCrowdEnabled ? c.audioCrowdVolume * c.audioMasterVolume * c.audioCrowdGain * duck : 0, t, this.paused ? 0.12 : 0.3);
  }

  /** Play one logical sound; `power` scales the gain a little (a hard hit is louder). Jitter is random on purpose: audio is not sim. */
  play(name: string, power = 1, bend: { pitch?: number | undefined; length?: number | undefined; delay?: number | undefined; level?: number | undefined; seed?: number | undefined } = {}): void {
    const recipe = RECIPES[name];
    if (!recipe) return;
    const c = this.cfg;
    const crowd = recipe.bus === 'crowd';
    // A seeded voice (an impact carrying the land's own variation) is exact: its variety is the sim's, so a replayed fight sounds the same.
    const jit = bend.seed === undefined ? 1 : 0;
    const pitch = (bend.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * c.audioPitchJitter * jit);
    // Impacts carry the master in their own gain (the log shows what was asked for); the crowd bus carries it for its sounds.
    const level = (crowd ? c.audioReactionGain : c.audioMasterVolume) * (bend.level ?? 1);
    const gain = Math.max(0, level * recipe.gain * (0.75 + 0.25 * Math.min(2, power)) * (1 + (Math.random() * 2 - 1) * c.audioVolumeJitter * jit));
    this.log.push({ name, pitch: +pitch.toFixed(4), gain: +gain.toFixed(4), t: performance.now() });
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
    if (!c.audioEnabled || gain <= 0 || this.unavailable || !this.ctx || this.ctx.state !== 'running' || !this.noise) return;
    if (crowd && !c.audioCrowdEnabled) return;
    try {
      const out: AudioNode = (crowd ? this.crowdBus : this.impactBus) ?? this.ctx.destination;
      const when = this.ctx.currentTime + (bend.delay ?? 0);
      const bufs = { noise: this.noise, walla: this.bed?.walla, applause: this.bed?.applause };
      playVoice(this.ctx, out, recipe, bufs,
        { when, pitch, gain, sub: c.audioFlushSub, length: bend.length ?? 1, seed: bend.seed, vary: c.audioImpactVary, toneNoise: c.audioToneNoise, keepTones: name === 'bell', crowd });
      // A bell is metal: the recipe's two partials plus inharmonic ones and a low hum, ringing long (the one pitched sound that is allowed).
      if (name === 'bell') playVoice(this.ctx, out, BELL_PARTIALS, bufs, { when, pitch, gain, sub: 1, length: 1, keepTones: true });
    } catch { /* feedback, never state: a failed sound is a silent one */ }
  }
}
